// Git, as the server uses it: a repository per project in the data folder (a mirror of an
// external source, or the source itself for a project the server hosts), brought up to date,
// read at a commit, and served to git clients. The git program does the work; this file is
// about calling it safely: no shell, no prompts, no settings of the machine or its user, a time
// limit on every call, and only addresses the server is willing to fetch from.
import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/** How long a fetch may take. */
export const FETCH_TIMEOUT_MS = 120_000;
/** How long reading from the mirror may take. */
const READ_TIMEOUT_MS = 20_000;
/** The most a single file read from a repository may be. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** The most one push may bring. */
export const MAX_PUSH_BYTES = 512 * 1024 * 1024;

export class GitError extends Error {
  constructor(
    message: string,
    /** What git said, for the log; may name paths of this machine. */
    readonly detail = '',
  ) {
    super(message);
    this.name = 'GitError';
  }
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

/** What the server signs in to a source with, over HTTPS. */
export interface GitAuth {
  username: string;
  password: string;
}

/**
 * How a sign-in reaches git for one call: as a setting in the call's own environment, for the
 * source's own address only. It is in no file, no argument list and no address, and git does
 * not send it to another host the source may point to.
 */
export function authEnv(url: string, auth: GitAuth | undefined): Record<string, string> {
  if (!auth || !/^https?:\/\//i.test(url)) return {};
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
      // On Windows git asks the system's own store unless told to use the file it is given.
      ...(this.caFile ? ['-c', 'http.schannelUseSSLCAInfo=true'] : []),
    ];
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
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=20',
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
          reject(
            new GitError(
              timedOut
                ? `Git did not finish in ${Math.round(options.timeoutMs / 1000)} seconds`
                : (said.split('\n').filter(Boolean).at(-1) ?? 'Git failed'),
              said,
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
    await this.run(
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
      { cwd: this.mirror(projectId), timeoutMs: FETCH_TIMEOUT_MS, env: authEnv(url, auth) },
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

  /** The branches the mirror has. */
  async branches(projectId: string): Promise<string[]> {
    return [...(await this.refs(projectId)).keys()].sort();
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
    return spawn(
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
          // The hook's own push to the source runs in this environment and so signs in too.
          ...(push && options.upstream ? authEnv(options.upstream, options.auth) : {}),
        }),
      },
    );
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
