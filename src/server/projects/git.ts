// Git, as the server uses it: a repository per project in the data folder (a mirror of an
// external source, or the source itself for a project the server hosts), brought up to date,
// read at a commit, and served to git clients. The git program does the work; this file is
// about calling it safely: no shell, no prompts, no settings of the machine or its user, a time
// limit on every call, and only addresses the server is willing to fetch from.
import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  type Commit,
  commitMatches,
  LOG_FORMAT,
  parseLog,
} from '@ansible-flow/node/history/gitLog';

/** How long a fetch may take. */
export const FETCH_TIMEOUT_MS = 120_000;
/** How long reading from the mirror may take. */
const READ_TIMEOUT_MS = 20_000;
/** The most a single file read from a repository may be. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** The most one push may bring. */
export const MAX_PUSH_BYTES = 512 * 1024 * 1024;

/** AFS-59: a branch with its newest commit. */
export interface BranchInfo {
  name: string;
  commit: string;
  author: string;
  /** When its newest commit was made (committer date, ISO). */
  at: string;
  subject: string;
  /** Commits on it that are not on the project's branch. */
  ahead: number;
}

/** AFS-78: a file of a commit. */
export interface TreeEntry {
  path: string;
  /** 100644, or 100755 for a program, 120000 for a link. */
  mode: string;
  object: string;
  size: number;
}

export class GitError extends Error {
  constructor(
    message: string,
    /** What git said, for the log; may name paths of this machine. */
    readonly detail = '',
    /** AFS-60: the source's SSH host key is not the one the server trusts. */
    readonly hostKeyChanged = false,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** AFS-60: what an SSH error from git means, in the server's words. */
function sshReason(said: string): { message: string; hostKeyChanged?: boolean } | undefined {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(said))
    return {
      message:
        "The source's SSH host key is not the one the server trusts: if the change is expected, an administrator accepts the new key on the project's page",
      hostKeyChanged: true,
    };
  if (/incorrect passphrase|invalid format|error in libcrypto|Load key .*: /i.test(said))
    return {
      message: "The credential's SSH key cannot be read: a wrong passphrase, or not a private key",
    };
  if (/Permission denied \(publickey/.test(said))
    return { message: 'The source refused the SSH key (Permission denied)' };
  return undefined;
}

export interface GitOptions {
  /** Where the mirrors are kept (`<data folder>/repos`). */
  reposDir: string;
  /** Allow a repository that is a folder on this machine (tests, a single-machine install). */
  allowLocal: boolean;
  /**
   * Every certificate authority the server trusts when it connects out, as PEM: the usual ones
   * and those of AFS_CA_FILE. Given, git trusts exactly these; not given, git trusts what the
   * machine does.
   */
  caBundle?: string;
  /** AFS-60: told when the server trusts an SSH host it had not seen (trust on first use). */
  onTrusted?: (host: string, fingerprints: string[]) => void;
}

/**
 * Why an address is not one the server fetches from; undefined when it is.
 * - `https://host/path` and `ssh://host/path`, and `git@host:path`
 * - never a password in the address: it would be kept, logged and shown
 * - a folder of this machine only when the settings allow it
 */
export function gitUrlProblem(url: string, allowLocal: boolean): string | undefined {
  if (!url || /[\s\0]/.test(url)) return 'The repository address is empty or has spaces';
  // An address must never read as an option of the git program.
  if (url.startsWith('-')) return 'The repository address cannot start with a dash';
  if (/^[\w.-]+@[\w.-]+:[^/\\].*$/.test(url) && !/^[a-zA-Z]:[\\/]/.test(url)) return undefined;
  if (/^(https|ssh):\/\//i.test(url)) {
    try {
      const u = new URL(url);
      if (u.password) return 'The address holds a password: give a credential instead';
      if (!u.hostname) return 'The repository address has no host';
      return undefined;
    } catch {
      return 'The repository address is not a URL';
    }
  }
  if (/^http:\/\//i.test(url)) {
    // Plain http only to this machine itself, and only where folders of it are allowed too.
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return 'The repository address is not a URL';
    }
    if (allowLocal && ['127.0.0.1', 'localhost', '[::1]'].includes(host)) return undefined;
    return 'A repository is fetched over https or ssh, not plain http';
  }
  if (/^file:\/\//i.test(url) || isAbsolute(url))
    return allowLocal
      ? undefined
      : 'A folder of this machine is not allowed as a repository (AFS_GIT_LOCAL=on allows it)';
  return 'Use an https:// or ssh:// address, or git@host:path';
}

/** A branch name as git allows one, and nothing that could read as an option or a range. */
export function refProblem(ref: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) && !/\.\.|\/\/|\.lock$|\/$/.test(ref)
    ? undefined
    : 'A branch name is letters, digits, dots, dashes, underscores and slashes';
}

const COMMIT = /^[0-9a-f]{40}$/;

/** Takes what could be a secret out of git's words before they are shown or logged. */
export const scrub = (text: string) => text.replace(/\/\/[^/\s@]+@/g, '//***@').trim();

/** What the server signs in to a source with: over HTTPS, or (AFS-60) an SSH key. */
export type GitAuth =
  | { username: string; password: string }
  | { privateKey: string; passphrase?: string; username?: string };

const isKey = (auth: GitAuth | undefined): auth is Extract<GitAuth, { privateKey: string }> =>
  !!auth && 'privateKey' in auth;

/** AFS-60: the host of an ssh address as known_hosts names it (`[host]:port` off port 22). */
export function sshHost(url: string): string | undefined {
  const scp = /^[\w.-]+@([\w.-]+):[^/\\]/.exec(url);
  if (scp && !/^ssh:/i.test(url)) return scp[1];
  if (!/^ssh:\/\//i.test(url)) return undefined;
  try {
    const u = new URL(url);
    return u.port && u.port !== '22' ? `[${u.hostname}]:${u.port}` : u.hostname;
  } catch {
    return undefined;
  }
}

/** A path for the shell line git runs ssh with (forward slashes, quoted). */
const shellPath = (path: string) => `"${path.replace(/\\/g, '/').replace(/"/g, '')}"`;

/**
 * How a sign-in reaches git for one call: as a setting in the call's own environment, for the
 * source's own address only. It is in no file, no argument list and no address, and git does
 * not send it to another host the source may point to.
 */
export function authEnv(url: string, auth: GitAuth | undefined): Record<string, string> {
  if (!auth || isKey(auth) || !/^https?:\/\//i.test(url)) return {};
  const basic = Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${new URL(url).origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/** What a git client asks the server to run. */
export type GitService = 'upload-pack' | 'receive-pack';

export interface ServeOptions {
  /** The client's `Git-Protocol` header, when it is one git knows. */
  protocol?: string;
  /** For a push: the branch whose history is kept (no delete, no rewrite). */
  protectedRef?: string;
  /** For a push to a project with an external source: where the push is passed on to. */
  upstream?: string;
  /** The sign-in for that source. */
  auth?: GitAuth;
}

/**
 * The one hook the server's repositories have, run by git before it accepts a push. It is the
 * server's own file, outside every repository: nothing a repository holds is ever run.
 * - only branches are pushed (the mirror holds nothing else)
 * - the branch that runs is not deleted and its history is not rewritten
 * - for a project with an external source the push is passed on first, with the old commits as
 *   the condition: what the source refuses, the mirror never holds
 */
const PRE_RECEIVE = `#!/bin/sh
# Written by Ansible Flow Server at every start. Do not edit: changes are lost.
zero=0000000000000000000000000000000000000000
specs=""
leases=""
while read old new ref; do
  case "$ref" in
    refs/heads/*) ;;
    *) echo "afs: only branches are pushed here, not $ref" >&2; exit 1 ;;
  esac
  if [ "$ref" = "refs/heads/$AFS_PROTECTED" ]; then
    if [ "$new" = "$zero" ]; then
      echo "afs: $AFS_PROTECTED is the branch that runs: it is not deleted" >&2; exit 1
    fi
    if [ "$old" != "$zero" ] && ! git merge-base --is-ancestor "$old" "$new"; then
      echo "afs: $AFS_PROTECTED is the branch that runs: its history is not rewritten" >&2; exit 1
    fi
  fi
  if [ "$new" = "$zero" ]; then specs="$specs :$ref"; else specs="$specs $new:$ref"; fi
  if [ "$old" = "$zero" ]; then leases="$leases --force-with-lease=$ref:"
  else leases="$leases --force-with-lease=$ref:$old"; fi
done
if [ -n "$AFS_UPSTREAM" ] && [ -n "$specs" ]; then
  # The new commits are readable here (git keeps them apart until the push is accepted), but
  # the mark that says so must not travel to a source on this machine: it would refuse.
  if ! (unset GIT_QUARANTINE_PATH; git push --quiet --atomic $leases -- "$AFS_UPSTREAM" $specs); then
    echo "afs: the project's repository did not accept the push" >&2; exit 1
  fi
fi
exit 0
`;

export class Git {
  private readonly emptyConfig: string;
  private readonly hooksDir: string;
  private readonly caFile: string | undefined;
  private readonly knownHosts: string;

  constructor(private readonly options: GitOptions) {
    mkdirSync(options.reposDir, { recursive: true });
    // Git reads the settings of the machine and of the account it runs as. The server's git
    // must not: this empty file stands in for both.
    this.emptyConfig = join(options.reposDir, 'gitconfig');
    if (!existsSync(this.emptyConfig)) writeFileSync(this.emptyConfig, '');
    if (options.caBundle) {
      // Git reads authorities from a file. It is written at every start, from what the server
      // itself trusts, so git and the server never disagree about a source's certificate.
      this.caFile = join(options.reposDir, 'ca-bundle.pem');
      writeFileSync(this.caFile, options.caBundle);
    }
    // AFS-60: the SSH hosts the server trusts, kept with the repositories (trust on first use).
    this.knownHosts = join(options.reposDir, 'known_hosts');
    this.hooksDir = join(options.reposDir, 'hooks');
    mkdirSync(this.hooksDir, { recursive: true });
    const hook = join(this.hooksDir, 'pre-receive');
    writeFileSync(hook, PRE_RECEIVE);
    chmodSync(hook, 0o755);
  }

  /** Where a project's mirror is. */
  mirror(projectId: string): string {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(projectId)) throw new GitError('Not a project id');
    return join(this.options.reposDir, `${projectId}.git`);
  }

  /** The settings every call starts with; hooks only where the caller names the folder. */
  private base(hooks = ''): string[] {
    return [
      // No helper that runs a program, no pager; hooks only the server's own, and only for a push.
      '-c',
      'protocol.ext.allow=never',
      '-c',
      `core.hooksPath=${hooks.replaceAll('\\', '/')}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'gc.auto=0',
      // AFS-26: dev runs' commits live under refs/afs: never shown to a client, never taken from one.
      '-c',
      'transfer.hideRefs=refs/afs',
      // On Windows git asks the system's own store unless told to use the file it is given.
      ...(this.caFile ? ['-c', 'http.schannelUseSSLCAInfo=true'] : []),
    ];
  }

  /**
   * AFS-60: how git runs ssh. Host keys: the server's own known_hosts (data folder) first, where a
   * host seen for the first time is added (trust on first use), then the account's, read too; a
   * key that differs from a trusted one stops the call. With a key from a credential: only that
   * key. A key with a passphrase is unlocked by a helper that reads it from a private file (ssh
   * asks no one: no password or keyboard sign-in either).
   */
  private sshCommand(key?: { file: string; user?: string; askpass?: boolean }): string {
    return [
      'ssh',
      // BatchMode would refuse even the helper; without a key there is nothing to ask for.
      ...(key?.askpass ? [] : ['-o', 'BatchMode=yes']),
      '-o',
      'ConnectTimeout=20',
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'KbdInteractiveAuthentication=no',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `"UserKnownHostsFile=${this.knownHosts.replace(/\\/g, '/')} ~/.ssh/known_hosts"`,
      ...(key
        ? [
            '-i',
            shellPath(key.file),
            '-o',
            'IdentitiesOnly=yes',
            '-o',
            'IdentityAgent=none',
            ...(key.user ? ['-o', `User=${key.user}`] : []),
          ]
        : []),
    ].join(' ');
  }

  /**
   * AFS-60: what one git call needs to sign in to `url`: the HTTPS header, or for an SSH key the
   * key in a private folder of its own for this call only (and the passphrase helper), removed by
   * `dispose` as soon as the call ends.
   */
  private signIn(
    url: string,
    auth: GitAuth | undefined,
  ): { env: Record<string, string>; dispose(): void } {
    if (!isKey(auth) || !sshHost(url)) return { env: authEnv(url, auth), dispose: () => undefined };
    const dir = mkdtempSync(join(tmpdir(), 'afs-ssh-'));
    try {
      chmodSync(dir, 0o700);
      const file = join(dir, 'key');
      const text = auth.privateKey.replace(/\r\n/g, '\n');
      writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
      const env: Record<string, string> = {};
      if (auth.passphrase) {
        const pass = join(dir, 'passphrase');
        writeFileSync(pass, auth.passphrase, { mode: 0o600 });
        const helper = join(dir, 'askpass');
        writeFileSync(helper, `#!/bin/sh\ncat ${shellPath(pass)}\n`, { mode: 0o700 });
        env.SSH_ASKPASS = helper.replace(/\\/g, '/');
        env.SSH_ASKPASS_REQUIRE = 'force';
        env.DISPLAY = env.DISPLAY ?? 'none';
      }
      // A user in the address wins; otherwise the credential's.
      const inUrl = /^[\w.-]+@/.test(url) || /^ssh:\/\/[^/@]+@/i.test(url);
      env.GIT_SSH_COMMAND = this.sshCommand({
        file,
        ...(auth.username && !inUrl ? { user: auth.username } : {}),
        askpass: !!auth.passphrase,
      });
      return { env, dispose: () => rmSync(dir, { recursive: true, force: true }) };
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  /** A call to a source with its sign-in, and a note when a host is trusted for the first time. */
  private async withSource<T>(
    url: string,
    auth: GitAuth | undefined,
    call: (env: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    const host = sshHost(url);
    const before = host ? this.knownHostsSize() : 0;
    const sign = this.signIn(url, auth);
    try {
      return await call(sign.env);
    } catch (e) {
      // ssh on Linux says a wrong passphrase as a refused key.
      if (
        e instanceof GitError &&
        isKey(auth) &&
        auth.passphrase &&
        e.message === 'The source refused the SSH key (Permission denied)'
      )
        throw new GitError(
          "The source refused the SSH key (Permission denied), or the key's passphrase is wrong",
          e.detail,
        );
      throw e;
    } finally {
      sign.dispose();
      if (host && this.knownHostsSize() !== before && this.options.onTrusted) {
        const keys = await this.hostKeys(url).catch(() => []);
        this.options.onTrusted(host, keys);
      }
    }
  }

  private knownHostsSize(): number {
    try {
      return statSync(this.knownHosts).size;
    } catch {
      return 0;
    }
  }

  /** AFS-60: the fingerprints of the host keys the server trusts for an ssh address. */
  async hostKeys(url: string): Promise<string[]> {
    const host = sshHost(url);
    if (!host || !existsSync(this.knownHosts)) return [];
    const out = await new Promise<string>((resolve) =>
      execFile(
        'ssh-keygen',
        ['-l', '-F', host, '-f', this.knownHosts],
        { timeout: READ_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => resolve(error ? '' : String(stdout)),
      ),
    );
    // "<host> <type> SHA256:…" per key; comment lines start with #.
    return out
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('#'))
      .map((l) => l.trim().split(/\s+/).slice(1).join(' '));
  }

  /** AFS-60: forgets the host keys trusted for an address; the next call trusts what it finds. */
  async forgetHostKeys(url: string): Promise<void> {
    const host = sshHost(url);
    if (!host || !existsSync(this.knownHosts)) return;
    await new Promise<void>((resolve, reject) =>
      execFile(
        'ssh-keygen',
        ['-R', host, '-f', this.knownHosts],
        { timeout: READ_TIMEOUT_MS, windowsHide: true },
        (error) =>
          error ? reject(new GitError('The host key could not be forgotten')) : resolve(),
      ),
    );
    rmSync(`${this.knownHosts}.old`, { force: true });
  }

  private env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      // The server's own outgoing trust (AFS_CA_FILE) and proxy, when it has them.
      ...(this.caFile
        ? { GIT_SSL_CAINFO: this.caFile }
        : process.env.GIT_SSL_CAINFO
          ? { GIT_SSL_CAINFO: process.env.GIT_SSL_CAINFO }
          : {}),
      ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: this.emptyConfig,
      // Never wait for someone to type: a fetch that needs a password fails at once.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GCM_INTERACTIVE: 'never',
      GIT_SSH_COMMAND: this.sshCommand(),
      GIT_ALLOW_PROTOCOL: this.options.allowLocal ? 'https:ssh:file:http' : 'https:ssh',
      LC_ALL: 'C',
      ...extra,
    } as NodeJS.ProcessEnv;
  }

  private run(
    args: string[],
    options: { cwd?: string; timeoutMs: number; maxBytes?: number; env?: Record<string, string> },
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        [...this.base(), ...args],
        {
          cwd: options.cwd,
          timeout: options.timeoutMs,
          maxBuffer: options.maxBytes ?? 16 * 1024 * 1024,
          encoding: 'buffer',
          windowsHide: true,
          env: this.env(options.env),
        },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);
          if ((error as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
            return reject(new GitError('Git gave more than was asked for', 'maxBuffer'));
          const said = scrub(stderr.toString('utf8'));
          const timedOut = (error as { killed?: boolean }).killed === true;
          const ssh = timedOut ? undefined : sshReason(said);
          reject(
            new GitError(
              timedOut
                ? `Git did not finish in ${Math.round(options.timeoutMs / 1000)} seconds`
                : (ssh?.message ?? said.split('\n').filter(Boolean).at(-1) ?? 'Git failed'),
              said,
              ssh?.hostKeyChanged,
            ),
          );
        },
      );
    });
  }

  /**
   * Makes sure the project's repository exists, and that a clone of it starts on `ref`.
   * A repository that has no commit yet is a repository all the same.
   */
  async ensure(projectId: string, ref: string): Promise<void> {
    const problem = refProblem(ref);
    if (problem) throw new GitError(problem);
    const dir = this.mirror(projectId);
    if (!existsSync(join(dir, 'HEAD')))
      await this.run(['init', '--bare', '--quiet', dir], { timeoutMs: READ_TIMEOUT_MS });
    await this.run(['symbolic-ref', 'HEAD', `refs/heads/${ref}`], {
      cwd: dir,
      timeoutMs: READ_TIMEOUT_MS,
    });
  }

  /** Brings the mirror up to date with every branch of `url`, signed in with `auth` if given. */
  async fetch(projectId: string, url: string, auth?: GitAuth): Promise<void> {
    const problem = gitUrlProblem(url, this.options.allowLocal);
    if (problem) throw new GitError(problem);
    // Branches only, exactly as the source has them: one deleted there is deleted here.
    await this.withSource(url, auth, (env) =>
      this.run(
        [
          'fetch',
          '--prune',
          '--no-tags',
          '--force',
          '--quiet',
          '--',
          url,
          '+refs/heads/*:refs/heads/*',
        ],
        { cwd: this.mirror(projectId), timeoutMs: FETCH_TIMEOUT_MS, env },
      ),
    );
  }

  /** The commit a branch is at. Rejects with a GitError that names the branches there are. */
  async resolve(projectId: string, ref: string): Promise<string> {
    const problem = refProblem(ref);
    if (problem) throw new GitError(problem);
    try {
      const out = await this.run(
        ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}^{commit}`],
        { cwd: this.mirror(projectId), timeoutMs: READ_TIMEOUT_MS },
      );
      const commit = out.toString('utf8').trim();
      if (!COMMIT.test(commit)) throw new Error('not a commit');
      return commit;
    } catch {
      const branches = await this.branches(projectId).catch(() => []);
      throw new GitError(
        `The repository has no branch ${ref}${branches.length ? ` (it has ${branches.slice(0, 8).join(', ')})` : ''}`,
      );
    }
  }

  /**
   * Brings a project's mirror up to date with every branch of `url`, and resolves with the
   * commit `ref` is at. Rejects with a GitError that says why, in words fit for the project's
   * page: the repository cannot be reached, the branch is not there.
   */
  async sync(projectId: string, url: string, ref: string): Promise<string> {
    const problem = gitUrlProblem(url, this.options.allowLocal) ?? refProblem(ref);
    if (problem) throw new GitError(problem);
    await this.ensure(projectId, ref);
    await this.fetch(projectId, url);
    return this.resolve(projectId, ref);
  }

  /**
   * AFS-171: the branches a source has, read without keeping anything (a project's address checked
   * before the project is made). Rejects with a GitError that says why it cannot be read.
   */
  async remoteBranches(url: string, auth?: GitAuth): Promise<string[]> {
    const problem = gitUrlProblem(url, this.options.allowLocal);
    if (problem) throw new GitError(problem);
    const out = await this.withSource(url, auth, (env) =>
      this.run(['ls-remote', '--heads', '--', url], { timeoutMs: READ_TIMEOUT_MS, env }),
    );
    return out
      .toString('utf8')
      .split(/\r?\n/)
      .map((line) => line.split(/\s+/)[1])
      .filter((ref): ref is string => !!ref?.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort();
  }

  /** The branches the mirror has. */
  async branches(projectId: string): Promise<string[]> {
    return [...(await this.refs(projectId)).keys()].sort();
  }

  /**
   * AFS-59: every branch with its newest commit (author, time, subject) and how many of its
   * commits are not on `base` (the project's branch), newest commit first.
   */
  async branchDetails(projectId: string, base: string): Promise<BranchInfo[]> {
    const cwd = this.mirror(projectId);
    const out = await this.run(
      [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname:short)%00%(objectname)%00%(authorname)%00%(committerdate:iso-strict)%00%(subject)',
        'refs/heads',
      ],
      { cwd, timeoutMs: READ_TIMEOUT_MS },
    );
    const baseCommit = (await this.refs(projectId)).get(base);
    const branches: BranchInfo[] = [];
    for (const line of out.toString('utf8').split('\n')) {
      const [name, commit, author, at, subject] = line.split('\0');
      if (!name || !commit || !COMMIT.test(commit)) continue;
      let ahead = 0;
      if (baseCommit && commit !== baseCommit)
        ahead = Number(
          (
            await this.run(['rev-list', '--count', commit, `^${baseCommit}`], {
              cwd,
              timeoutMs: READ_TIMEOUT_MS,
            })
          )
            .toString('utf8')
            .trim(),
        );
      else if (!baseCommit)
        ahead = Number(
          (await this.run(['rev-list', '--count', commit], { cwd, timeoutMs: READ_TIMEOUT_MS }))
            .toString('utf8')
            .trim(),
        );
      branches.push({
        name,
        commit,
        author: author ?? '',
        at: at ?? '',
        subject: subject ?? '',
        ahead,
      });
    }
    return branches;
  }

  /** A branch name or a commit (full or abbreviated) of the mirror, as a commit. */
  async commitOf(projectId: string, from: string): Promise<string> {
    if (/^[0-9a-f]{7,40}$/.test(from)) {
      try {
        const out = await this.run(['rev-parse', '--verify', '--quiet', `${from}^{commit}`], {
          cwd: this.mirror(projectId),
          timeoutMs: READ_TIMEOUT_MS,
        });
        const commit = out.toString('utf8').trim();
        if (COMMIT.test(commit)) return commit;
      } catch {
        // Not a commit: perhaps a branch named like one.
      }
    }
    return this.resolve(projectId, from);
  }

  /**
   * AFS-59: makes `branch` at `commit` (it must not exist), or deletes it (`commit` undefined)
   * from `old`: at the source first when the project has one, so the mirror changes only when the
   * source took it; then in the mirror, only if the branch there is still as expected.
   */
  async setBranch(
    projectId: string,
    branch: string,
    change: { old?: string; commit?: string },
    upstream?: { url: string; auth?: GitAuth },
  ): Promise<void> {
    const problem = refProblem(branch);
    if (problem) throw new GitError(problem);
    const { old, commit } = change;
    if ((old && !COMMIT.test(old)) || (commit && !COMMIT.test(commit)) || (!old && !commit))
      throw new GitError('Not a commit');
    const cwd = this.mirror(projectId);
    const ref = `refs/heads/${branch}`;
    if (upstream) {
      const urlProblem = gitUrlProblem(upstream.url, this.options.allowLocal);
      if (urlProblem) throw new GitError(urlProblem);
      await this.withSource(upstream.url, upstream.auth, (env) =>
        this.run(
          [
            'push',
            '--quiet',
            '--atomic',
            `--force-with-lease=${ref}:${old ?? ''}`,
            '--',
            upstream.url,
            commit ? `${commit}:${ref}` : `:${ref}`,
          ],
          { cwd, timeoutMs: FETCH_TIMEOUT_MS, env },
        ),
      );
    }
    if (commit)
      await this.run(['update-ref', ref, commit, old ?? '0'.repeat(40)], {
        cwd,
        timeoutMs: READ_TIMEOUT_MS,
      });
    else
      await this.run(['update-ref', '-d', ref, old as string], { cwd, timeoutMs: READ_TIMEOUT_MS });
  }

  /** Every branch of the mirror with the commit it is at. */
  async refs(projectId: string): Promise<Map<string, string>> {
    const out = await this.run(
      ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads'],
      { cwd: this.mirror(projectId), timeoutMs: READ_TIMEOUT_MS },
    );
    const refs = new Map<string, string>();
    for (const line of out.toString('utf8').split('\n')) {
      const at = line.indexOf(' ');
      if (at > 0) refs.set(line.slice(at + 1), line.slice(0, at));
    }
    return refs;
  }

  /** The paths of every file at a commit, with forward slashes. */
  async files(projectId: string, commit: string): Promise<string[]> {
    if (!COMMIT.test(commit)) throw new GitError('Not a commit');
    const out = await this.run(['ls-tree', '-r', '-z', '--name-only', commit], {
      cwd: this.mirror(projectId),
      timeoutMs: READ_TIMEOUT_MS,
      maxBytes: 64 * 1024 * 1024,
    });
    return out.toString('utf8').split('\0').filter(Boolean);
  }

  /** A file's bytes at a commit; undefined when the commit has no such file. */
  async read(projectId: string, commit: string, path: string): Promise<Buffer | undefined> {
    if (!COMMIT.test(commit)) throw new GitError('Not a commit');
    // A path names a file inside the repository: nothing that leaves it or reads as a revision.
    if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').includes('..'))
      throw new GitError('Not a path inside the repository');
    try {
      return await this.run(['cat-file', 'blob', `${commit}:${path}`], {
        cwd: this.mirror(projectId),
        timeoutMs: READ_TIMEOUT_MS,
        maxBytes: MAX_FILE_BYTES,
      });
    } catch (e) {
      if (e instanceof GitError && /maxBuffer/i.test(e.detail + e.message))
        throw new GitError(`The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      return undefined;
    }
  }

  /**
   * Puts `dir` exactly at `commit`: the repository's files and nothing else. A folder that
   * is a checkout already is reset and cleaned; otherwise one is made (a git worktree of the
   * mirror, so the objects are not copied).
   */
  async checkout(projectId: string, commit: string, dir: string): Promise<void> {
    if (!COMMIT.test(commit)) throw new GitError('Not a commit');
    const mirror = this.mirror(projectId);
    const opts = { timeoutMs: FETCH_TIMEOUT_MS };
    await this.run(['--git-dir', mirror, 'worktree', 'prune'], opts);
    if (existsSync(join(dir, '.git'))) {
      await this.run(['-C', dir, 'reset', '--hard', '--quiet', commit], opts);
      await this.run(['-C', dir, 'clean', '-ffdxq'], opts);
      return;
    }
    await this.run(
      ['--git-dir', mirror, 'worktree', 'add', '--force', '--detach', '--quiet', dir, commit],
      opts,
    );
  }

  /** Removes a working folder made by `checkout`. */
  async removeCheckout(projectId: string, dir: string): Promise<void> {
    const mirror = this.mirror(projectId);
    await this.run(['--git-dir', mirror, 'worktree', 'remove', '--force', dir], {
      timeoutMs: READ_TIMEOUT_MS,
    }).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
    await this.run(['--git-dir', mirror, 'worktree', 'prune'], {
      timeoutMs: READ_TIMEOUT_MS,
    }).catch(() => undefined);
  }

  /**
   * AFS-26: takes a git bundle of someone's work (one ref) into the repository under
   * refs/afs/dev/<id>, without touching any branch or reaching anything outside: the bundle is
   * checked against what the repository has, its objects are unpacked, the ref points at its one
   * head. Resolves with that commit.
   */
  async devBundle(projectId: string, file: string, id: string): Promise<string> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new GitError('Not a bundle id');
    const cwd = this.mirror(projectId);
    try {
      await this.run(['bundle', 'verify', '--quiet', file], { cwd, timeoutMs: FETCH_TIMEOUT_MS });
    } catch (e) {
      const said = (e as GitError).message;
      throw new GitError(
        /prerequisite|lacks/i.test(said)
          ? 'The bundle starts from a commit the server does not have: bundle from a commit the server has, or the whole history'
          : `Not a git bundle the server can read: ${said}`,
      );
    }
    const heads = (
      await this.run(['bundle', 'list-heads', file], { cwd, timeoutMs: READ_TIMEOUT_MS })
    )
      .toString('utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(' ')[0] as string);
    if (heads.length !== 1 || !COMMIT.test(heads[0] ?? ''))
      throw new GitError('A dev run takes a bundle of one ref (the work to run)');
    const commit = heads[0] as string;
    await this.run(['bundle', 'unbundle', file], { cwd, timeoutMs: FETCH_TIMEOUT_MS });
    if (!(await this.hasCommit(projectId, commit)))
      throw new GitError('The bundle does not hold the commit it names');
    await this.run(['update-ref', `refs/afs/dev/${id}`, commit], {
      cwd,
      timeoutMs: READ_TIMEOUT_MS,
    });
    return commit;
  }

  /** AFS-26: lets go of a dev run's commit (its objects stay until the repository is cleaned). */
  async dropDev(projectId: string, id: string): Promise<void> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return;
    await this.run(['update-ref', '-d', `refs/afs/dev/${id}`], {
      cwd: this.mirror(projectId),
      timeoutMs: READ_TIMEOUT_MS,
    }).catch(() => undefined);
  }

  /** True when the repository has this commit. */
  async hasCommit(projectId: string, commit: string): Promise<boolean> {
    if (!COMMIT.test(commit)) return false;
    return this.run(['cat-file', '-e', `${commit}^{commit}`], {
      cwd: this.mirror(projectId),
      timeoutMs: READ_TIMEOUT_MS,
    }).then(
      () => true,
      () => false,
    );
  }

  /**
   * AFS-190: the commit an id names: a full id, or the start of one (7 characters at least, as
   * the pages and git show them). `ambiguous`: the start of more than one commit.
   */
  async findCommit(
    projectId: string,
    id: string,
  ): Promise<{ commit: string } | { none: true } | { ambiguous: true }> {
    if (!/^[0-9a-f]{7,40}$/.test(id)) return { none: true };
    if (COMMIT.test(id))
      return (await this.hasCommit(projectId, id)) ? { commit: id } : { none: true };
    // Every object whose id starts so; only commits count (a tree or a file may share the start).
    const out = await this.run(['rev-parse', `--disambiguate=${id}`], {
      cwd: this.mirror(projectId),
      timeoutMs: READ_TIMEOUT_MS,
    }).catch(() => Buffer.alloc(0));
    const commits: string[] = [];
    for (const name of out.toString('utf8').split('\n')) {
      const hash = name.trim();
      if (!COMMIT.test(hash) || !(await this.hasCommit(projectId, hash))) continue;
      commits.push(hash);
      if (commits.length > 1) return { ambiguous: true };
    }
    return commits[0] ? { commit: commits[0] } : { none: true };
  }

  /** AFS-190: the branches that have a commit (at their tip or behind it), by name. */
  async branchesWith(projectId: string, commit: string): Promise<string[]> {
    if (!COMMIT.test(commit)) return [];
    const out = await this.run(
      ['for-each-ref', '--contains', commit, '--format=%(refname:short)', 'refs/heads'],
      { cwd: this.mirror(projectId), timeoutMs: READ_TIMEOUT_MS },
    );
    return out
      .toString('utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .sort();
  }

  /**
   * AFS-190: the files a commit changed, for its list in History: as changedFiles, but a file
   * moved (perhaps changed a little too) is one entry, `renamed`, with the path it had (`from`).
   */
  async commitFiles(
    projectId: string,
    from: string,
    to: string,
  ): Promise<
    { file: string; change: 'added' | 'changed' | 'removed' | 'renamed'; from?: string }[]
  > {
    if (!COMMIT.test(from) || !COMMIT.test(to)) throw new GitError('Not a commit');
    const out = await this.run(['diff', '--name-status', '--find-renames', '-z', from, to, '--'], {
      cwd: this.mirror(projectId),
      timeoutMs: READ_TIMEOUT_MS,
      maxBytes: 16 * 1024 * 1024,
    });
    const parts = out.toString('utf8').split('\0');
    const files: {
      file: string;
      change: 'added' | 'changed' | 'removed' | 'renamed';
      from?: string;
    }[] = [];
    for (let i = 0; i + 1 < parts.length; ) {
      const status = parts[i] ?? '';
      // A rename names two paths: the one it had, then the new one.
      if (status.startsWith('R')) {
        const old = parts[i + 1] ?? '';
        const file = parts[i + 2] ?? '';
        i += 3;
        if (file) files.push({ file, change: 'renamed', from: old });
        continue;
      }
      const file = parts[i + 1] ?? '';
      i += 2;
      if (!file) continue;
      files.push({
        file,
        change: status.startsWith('A') ? 'added' : status.startsWith('D') ? 'removed' : 'changed',
      });
    }
    return files;
  }

  /**
   * AFS-75: the files that differ between two commits, each added, changed or removed (a rename
   * is a removal and an addition: a flow is known by its path).
   */
  async changedFiles(
    projectId: string,
    from: string,
    to: string,
  ): Promise<{ file: string; change: 'added' | 'changed' | 'removed' }[]> {
    if (!COMMIT.test(from) || !COMMIT.test(to)) throw new GitError('Not a commit');
    const out = await this.run(['diff', '--name-status', '--no-renames', '-z', from, to, '--'], {
      cwd: this.mirror(projectId),
      timeoutMs: READ_TIMEOUT_MS,
      maxBytes: 16 * 1024 * 1024,
    });
    const parts = out.toString('utf8').split('\0');
    const files: { file: string; change: 'added' | 'changed' | 'removed' }[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i] ?? '';
      const file = parts[i + 1] ?? '';
      if (!file) continue;
      files.push({
        file,
        change: status.startsWith('A') ? 'added' : status.startsWith('D') ? 'removed' : 'changed',
      });
    }
    return files;
  }

  /**
   * AFS-75: the commits that changed a file, newest first: up to `commit`, and after `since`
   * when given (who changed it between two commits).
   */
  async fileHistory(
    projectId: string,
    commit: string,
    path: string,
    options: { since?: string; limit?: number } = {},
  ): Promise<{ commit: string; author: string; at: string; subject: string }[]> {
    if (!COMMIT.test(commit) || (options.since && !COMMIT.test(options.since)))
      throw new GitError('Not a commit');
    if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').includes('..'))
      throw new GitError('Not a path inside the repository');
    const range = options.since ? `${options.since}..${commit}` : commit;
    const out = await this.run(
      [
        'log',
        '-z',
        `--max-count=${options.limit ?? 30}`,
        '--format=%H%x1f%an%x1f%aI%x1f%s',
        range,
        '--',
        path,
      ],
      { cwd: this.mirror(projectId), timeoutMs: READ_TIMEOUT_MS },
    );
    return out
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const [hash = '', author = '', at = '', subject = ''] = line.trim().split('\x1f');
        return { commit: hash, author, at, subject };
      });
  }

  /**
   * AFS-123: a page of the history up to `tip`, newest first, read as the designer reads it (AFD-320:
   * its log format, parser and filter). `skip` commits of the walk are passed over first; `paths`
   * keeps the commits that changed one of them. With a `filter` (words in the message, author,
   * hash or a changed file's path) the walk goes on in batches until `limit` commits match, the
   * history ends, or `budget` commits were read; `next` is where the walk goes on from, when there
   * is more to read.
   */
  async log(
    projectId: string,
    tip: string,
    options: {
      skip?: number;
      limit?: number;
      paths?: string[];
      filter?: string;
      budget?: number;
    } = {},
  ): Promise<{ commits: Commit[]; next?: number }> {
    if (!COMMIT.test(tip)) throw new GitError('Not a commit');
    for (const path of options.paths ?? [])
      if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').includes('..'))
        throw new GitError('Not a path inside the repository');
    const limit = options.limit ?? 50;
    const filter = options.filter?.trim() ?? '';
    const read = async (skip: number, count: number) =>
      parseLog(
        (
          await this.run(
            [
              '-c',
              'core.quotePath=false',
              'log',
              '-z',
              '--name-status',
              `--format=${LOG_FORMAT}`,
              `--max-count=${count}`,
              ...(skip ? [`--skip=${skip}`] : []),
              tip,
              '--',
              ...(options.paths ?? []),
            ],
            { cwd: this.mirror(projectId), timeoutMs: READ_TIMEOUT_MS, maxBytes: 64 * 1024 * 1024 },
          )
        ).toString('utf8'),
      );
    let at = options.skip ?? 0;
    if (!filter) {
      const page = await read(at, limit + 1);
      return {
        commits: page.slice(0, limit),
        ...(page.length > limit ? { next: at + limit } : {}),
      };
    }
    // Filtered: read in batches and keep what matches; a long history is read a budget at a time.
    const budget = options.budget ?? 5000;
    const found: Commit[] = [];
    let readSoFar = 0;
    while (readSoFar < budget) {
      const want = Math.min(500, budget - readSoFar);
      const batch = await read(at, want);
      for (const [i, commit] of batch.entries()) {
        if (!commitMatches(commit, filter)) continue;
        if (found.length === limit) return { commits: found, next: at + i };
        found.push(commit);
      }
      at += batch.length;
      readSoFar += batch.length;
      if (batch.length < want) return { commits: found };
    }
    // The budget is spent: the walk goes on from here, if the history does.
    return (await read(at, 1)).length ? { commits: found, next: at } : { commits: found };
  }

  /**
   * AFS-76: a commit on top of `parent` that changes one file to `text`, made in the mirror with
   * git's plumbing (no working folder): the blob, a tree from the parent's with the file in it,
   * the commit by `author`. Nothing points at it until `publish` moves the branch.
   */
  async commitFile(
    projectId: string,
    change: {
      parent: string;
      path: string;
      text: string;
      author: { name: string; email: string };
      message: string;
    },
  ): Promise<string> {
    const { parent, path } = change;
    if (!COMMIT.test(parent)) throw new GitError('Not a commit');
    if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').includes('..'))
      throw new GitError('Not a path inside the repository');
    const cwd = this.mirror(projectId);
    const work = await mkdtemp(join(tmpdir(), 'afs-commit-'));
    try {
      const file = join(work, 'blob');
      const message = join(work, 'message');
      await writeFile(file, change.text);
      await writeFile(message, change.message);
      const blob = (
        await this.run(['hash-object', '-w', '--', file], { cwd, timeoutMs: READ_TIMEOUT_MS })
      )
        .toString('utf8')
        .trim();
      // The file keeps its mode (an executable stays one).
      const listed = (
        await this.run(['ls-tree', parent, '--', path], { cwd, timeoutMs: READ_TIMEOUT_MS })
      ).toString('utf8');
      const mode = /^(\d{6}) blob /.exec(listed)?.[1] ?? '100644';
      const index = { GIT_INDEX_FILE: join(work, 'index') };
      await this.run(['read-tree', parent], { cwd, timeoutMs: READ_TIMEOUT_MS, env: index });
      await this.run(['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`], {
        cwd,
        timeoutMs: READ_TIMEOUT_MS,
        env: index,
      });
      const tree = (await this.run(['write-tree'], { cwd, timeoutMs: READ_TIMEOUT_MS, env: index }))
        .toString('utf8')
        .trim();
      const who = {
        GIT_AUTHOR_NAME: change.author.name,
        GIT_AUTHOR_EMAIL: change.author.email,
        GIT_COMMITTER_NAME: 'Ansible Flow Server',
        GIT_COMMITTER_EMAIL: 'ansible-flow-server@localhost',
      };
      const commit = (
        await this.run(['commit-tree', tree, '-p', parent, '-F', message], {
          cwd,
          timeoutMs: READ_TIMEOUT_MS,
          env: who,
        })
      )
        .toString('utf8')
        .trim();
      if (!COMMIT.test(commit)) throw new GitError('Git made no commit');
      return commit;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /**
   * AFS-78: the files of a commit with their mode, object and size (in bytes), paths with forward
   * slashes.
   */
  async tree(projectId: string, commit: string): Promise<TreeEntry[]> {
    if (!COMMIT.test(commit)) throw new GitError('Not a commit');
    const out = await this.run(['ls-tree', '-r', '-l', '-z', commit], {
      cwd: this.mirror(projectId),
      timeoutMs: READ_TIMEOUT_MS,
      maxBytes: 64 * 1024 * 1024,
    });
    const entries: TreeEntry[] = [];
    for (const line of out.toString('utf8').split('\0')) {
      const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(-|\d+)\t(.+)$/s.exec(line);
      // Submodules (commit entries) are not files of this repository.
      if (m?.[2] !== 'blob') continue;
      if (!m) continue;
      entries.push({
        mode: m[1] as string,
        object: m[3] as string,
        size: Number(m[4]),
        path: m[5] as string,
      });
    }
    return entries;
  }

  /**
   * AFS-78: a commit on top of `parent` with files written (new bytes, or an object the
   * repository has, for a move) and files removed, made with git's plumbing as commitFile is.
   * Paths are checked by the caller.
   */
  async commitChanges(
    projectId: string,
    change: {
      parent: string;
      writes: { path: string; mode: string; bytes?: Buffer; object?: string }[];
      removes: string[];
      author: { name: string; email: string };
      message: string;
    },
  ): Promise<string> {
    if (!COMMIT.test(change.parent)) throw new GitError('Not a commit');
    const cwd = this.mirror(projectId);
    const work = await mkdtemp(join(tmpdir(), 'afs-files-'));
    try {
      // An empty work tree: some index changes ask for one, and none reads from it.
      const tree0 = join(work, 'tree');
      await mkdir(tree0);
      const env = { GIT_INDEX_FILE: join(work, 'index'), GIT_WORK_TREE: tree0 };
      const opts = { cwd, timeoutMs: FETCH_TIMEOUT_MS, env };
      await this.run(['read-tree', change.parent], opts);
      const fresh = change.writes.filter((w) => w.bytes);
      const objects = new Map<string, string>();
      for (let at = 0; at < fresh.length; at += 200) {
        const batch = fresh.slice(at, at + 200);
        const files = await Promise.all(
          batch.map(async (w, i) => {
            const file = join(work, `blob-${at + i}`);
            await writeFile(file, w.bytes as Buffer);
            return file;
          }),
        );
        const out = (await this.run(['hash-object', '-w', '--', ...files], opts))
          .toString('utf8')
          .trim()
          .split('\n');
        batch.forEach((w, i) => {
          const object = out[i]?.trim();
          if (!object) throw new GitError('Git stored no file');
          objects.set(w.path, object);
        });
      }
      // Removes first: a file may take the place of a folder that goes, and the other way round.
      for (let at = 0; at < change.removes.length; at += 200)
        await this.run(
          ['update-index', '--force-remove', '--', ...change.removes.slice(at, at + 200)],
          opts,
        );
      for (let at = 0; at < change.writes.length; at += 100) {
        const args = change.writes.slice(at, at + 100).flatMap((w) => {
          const object = w.object ?? objects.get(w.path);
          if (!object) throw new GitError('A file has no content');
          return ['--cacheinfo', `${w.mode},${object},${w.path}`];
        });
        await this.run(['update-index', '--add', ...args], opts);
      }
      const tree = (await this.run(['write-tree'], opts)).toString('utf8').trim();
      const message = join(work, 'message');
      await writeFile(message, change.message);
      const commit = (
        await this.run(['commit-tree', tree, '-p', change.parent, '-F', message], {
          ...opts,
          env: {
            ...env,
            GIT_AUTHOR_NAME: change.author.name,
            GIT_AUTHOR_EMAIL: change.author.email,
            GIT_COMMITTER_NAME: 'Ansible Flow Server',
            GIT_COMMITTER_EMAIL: 'ansible-flow-server@localhost',
          },
        })
      )
        .toString('utf8')
        .trim();
      if (!COMMIT.test(commit)) throw new GitError('Git made no commit');
      return commit;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /**
   * AFS-76: moves `branch` from `old` to `commit`: first in the project's source when it has one
   * (only if the branch there is still at `old`), then in the mirror, also only from `old`.
   */
  async publish(
    projectId: string,
    branch: string,
    old: string,
    commit: string,
    upstream?: { url: string; auth?: GitAuth },
  ): Promise<void> {
    const problem = refProblem(branch);
    if (problem) throw new GitError(problem);
    if (!COMMIT.test(old) || !COMMIT.test(commit)) throw new GitError('Not a commit');
    const cwd = this.mirror(projectId);
    const ref = `refs/heads/${branch}`;
    if (upstream) {
      const urlProblem = gitUrlProblem(upstream.url, this.options.allowLocal);
      if (urlProblem) throw new GitError(urlProblem);
      await this.withSource(upstream.url, upstream.auth, (env) =>
        this.run(
          [
            'push',
            '--quiet',
            '--atomic',
            `--force-with-lease=${ref}:${old}`,
            '--',
            upstream.url,
            `${commit}:${ref}`,
          ],
          { cwd, timeoutMs: FETCH_TIMEOUT_MS, env },
        ),
      );
    }
    await this.run(['update-ref', ref, commit, old], { cwd, timeoutMs: READ_TIMEOUT_MS });
  }

  /**
   * AFS-58: the first commit of an empty repository, with these files (paths checked by the
   * caller), on `branch`, which must not exist yet. The files are written to a scratch folder and
   * added with a scratch index, so the mirror never has a working folder.
   */
  async commitFirst(
    projectId: string,
    branch: string,
    files: Map<string, { bytes: Buffer; executable?: boolean }>,
    change: { author: { name: string; email: string }; message: string },
  ): Promise<string> {
    const problem = refProblem(branch);
    if (problem) throw new GitError(problem);
    const cwd = this.mirror(projectId);
    const work = await mkdtemp(join(tmpdir(), 'afs-start-'));
    try {
      const tree = join(work, 'tree');
      for (const [path, file] of files) {
        const at = join(tree, ...path.split('/'));
        await mkdir(dirname(at), { recursive: true });
        await writeFile(at, file.bytes);
      }
      const message = join(work, 'message');
      await writeFile(message, change.message);
      const env = { GIT_INDEX_FILE: join(work, 'index') };
      const opts = { cwd, timeoutMs: FETCH_TIMEOUT_MS, env };
      // -f: what was sent is committed, whatever a .gitignore in it says.
      await this.run(['--work-tree', tree, 'add', '-A', '-f', '--', '.'], opts);
      const programs = [...files].filter(([, f]) => f.executable).map(([p]) => p);
      for (let at = 0; at < programs.length; at += 200)
        await this.run(
          [
            '--work-tree',
            tree,
            'update-index',
            '--chmod=+x',
            '--',
            ...programs.slice(at, at + 200),
          ],
          opts,
        );
      const written = (await this.run(['write-tree'], opts)).toString('utf8').trim();
      const commit = (
        await this.run(['commit-tree', written, '-F', message], {
          ...opts,
          env: {
            ...env,
            GIT_AUTHOR_NAME: change.author.name,
            GIT_AUTHOR_EMAIL: change.author.email,
            GIT_COMMITTER_NAME: 'Ansible Flow Server',
            GIT_COMMITTER_EMAIL: 'ansible-flow-server@localhost',
          },
        })
      )
        .toString('utf8')
        .trim();
      if (!COMMIT.test(commit)) throw new GitError('Git made no commit');
      // The zero commit as the old value: only if the branch is still not there.
      await this.run(['update-ref', `refs/heads/${branch}`, commit, '0'.repeat(40)], {
        cwd,
        timeoutMs: READ_TIMEOUT_MS,
      });
      return commit;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** True when a commit has a file or a folder at this path. */
  async exists(projectId: string, commit: string, path: string): Promise<boolean> {
    if (!COMMIT.test(commit)) throw new GitError('Not a commit');
    if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').includes('..'))
      throw new GitError('Not a path inside the repository');
    const out = await this.run(
      ['ls-tree', '-z', '--name-only', commit, '--', path.replace(/\/+$/, '')],
      { cwd: this.mirror(projectId), timeoutMs: READ_TIMEOUT_MS },
    ).catch(() => Buffer.alloc(0));
    return out.length > 0;
  }

  /** A commit's author, time and first line. */
  async commitInfo(
    projectId: string,
    commit: string,
  ): Promise<{ author: string; at: string; subject: string }> {
    if (!COMMIT.test(commit)) throw new GitError('Not a commit');
    const out = await this.run(['show', '--no-patch', '--format=%an%x00%aI%x00%s', commit], {
      cwd: this.mirror(projectId),
      timeoutMs: READ_TIMEOUT_MS,
    });
    const [author = '', at = '', subject = ''] = out.toString('utf8').trim().split('\0');
    return { author, at, subject };
  }

  // --- serving git clients (projects/gitHttp.ts)

  /** What the repository tells a client first: its branches and what the server can do. */
  advertise(projectId: string, service: GitService, protocol?: string): Promise<Buffer> {
    return this.run([service, '--stateless-rpc', '--advertise-refs', this.mirror(projectId)], {
      timeoutMs: READ_TIMEOUT_MS,
      maxBytes: 64 * 1024 * 1024,
      ...(protocol ? { env: { GIT_PROTOCOL: protocol } } : {}),
    });
  }

  /**
   * Starts git's side of a fetch or a push: the client's request goes to its input, its output
   * is the answer. The caller ends it when the client goes away or it takes too long.
   */
  serve(
    projectId: string,
    service: GitService,
    options: ServeOptions = {},
  ): ChildProcessWithoutNullStreams {
    const push = service === 'receive-pack';
    if (options.protectedRef && refProblem(options.protectedRef))
      throw new GitError('Not a branch name');
    if (options.upstream && gitUrlProblem(options.upstream, this.options.allowLocal))
      throw new GitError('Not a repository address');
    // The hook's own push to the source runs in this environment and so signs in too; an SSH
    // key's file stays until git ends.
    const sign =
      push && options.upstream
        ? this.signIn(options.upstream, options.auth)
        : { env: {}, dispose: () => undefined };
    const child = spawn(
      'git',
      [
        ...this.base(push ? this.hooksDir : ''),
        ...(push
          ? ['-c', `receive.maxInputSize=${MAX_PUSH_BYTES}`, '-c', 'receive.autogc=false']
          : []),
        service,
        '--stateless-rpc',
        this.mirror(projectId),
      ],
      {
        windowsHide: true,
        env: this.env({
          ...(options.protocol ? { GIT_PROTOCOL: options.protocol } : {}),
          ...(push
            ? { AFS_PROTECTED: options.protectedRef ?? '', AFS_UPSTREAM: options.upstream ?? '' }
            : {}),
          ...sign.env,
        }),
      },
    );
    child.once('close', () => sign.dispose());
    child.once('error', () => sign.dispose());
    return child;
  }

  /**
   * Puts a deleted project's repository aside instead of removing it: for a project the server
   * hosts it is the only copy. Resolves with where it is now.
   */
  async retire(projectId: string): Promise<string | undefined> {
    const dir = this.mirror(projectId);
    if (!existsSync(dir)) return undefined;
    const aside = join(this.options.reposDir, 'deleted');
    mkdirSync(aside, { recursive: true });
    const to = join(aside, `${projectId}-${new Date().toISOString().replace(/[:.]/g, '-')}.git`);
    await rename(dir, to);
    return to;
  }
}
