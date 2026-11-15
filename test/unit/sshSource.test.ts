// AFS-60: a project's ssh source with a key from the credentials store, and how host keys are
// trusted (on first use, in one known_hosts in the data folder; a changed key stops the project
// until an administrator accepts it).
//
// The parts against a real SSH server run when AFS_TEST_SSH_URL is set (the lab: a throwaway
// container with sshd and a bare repository): AFS_TEST_SSH_KEY and AFS_TEST_SSH_LOCKED_KEY are
// private key files, the second with the passphrase AFS_TEST_SSH_PASSPHRASE; both keys may push.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/server/app';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { Git, type GitError, sshHost } from '../../src/server/projects/git';
import {
  createProject,
  createWorkspace,
  getProject,
  type Project,
  ProjectError,
  updateProject,
} from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { createCredential, gitAuthOf, reveal } from '../../src/server/secrets/credentials';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';

const run = promisify(execFile);
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });
const root = mkdtempSync(join(tmpdir(), 'afs-ssh-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
/** Shaped like a key for the store's check; never used to sign in. */
const FAKE_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nZmljdGlvbmFs\n-----END OPENSSH PRIVATE KEY-----\n';

describe('ssh addresses', () => {
  it('names the host as known_hosts does', () => {
    expect(sshHost('git@git.example.net:network/flows.git')).toBe('git.example.net');
    expect(sshHost('ssh://git@git.example.net/network/flows.git')).toBe('git.example.net');
    expect(sshHost('ssh://git@git.example.net:22/flows.git')).toBe('git.example.net');
    expect(sshHost('ssh://git.example.net:2222/flows.git')).toBe('[git.example.net]:2222');
    expect(sshHost('https://git.example.net/flows.git')).toBeUndefined();
    expect(sshHost('C:\\repos\\flows')).toBeUndefined();
    expect(sshHost('/srv/repos/flows.git')).toBeUndefined();
  });
});

describe('which credential signs in to which source', () => {
  let database: Database;
  let workspace: string;
  let sshKey: string;
  let token: string;
  beforeAll(async () => {
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    workspace = (await createWorkspace(database.db, { key: 'net', name: 'Network' })).id;
    sshKey = (
      await createCredential(database.db, key, workspace, {
        name: 'Deploy key',
        kind: 'ssh_key',
        fields: { username: 'deploy' },
        secret: { privateKey: FAKE_KEY, passphrase: 'fictional' },
      })
    ).id;
    token = (
      await createCredential(database.db, key, workspace, {
        name: 'Token',
        kind: 'git_token',
        secret: { token: 'fictional-token' },
      })
    ).id;
  });
  afterAll(() => database.close());

  const refused = (p: Promise<unknown>) =>
    p.then(
      () => 'taken',
      (e) => (e instanceof ProjectError ? e.message : `other: ${(e as Error).message}`),
    );

  it('an ssh source takes an SSH key; an https source a token or a login', async () => {
    const db = database.db;
    const made = await createProject(
      db,
      workspace,
      {
        key: 'ssh',
        name: 'Over ssh',
        gitUrl: 'git@git.example.net:net/flows.git',
        gitCredential: sshKey,
      },
      false,
    );
    expect(made.gitCredential).toBe(sshKey);
    expect(
      await refused(
        createProject(
          db,
          workspace,
          {
            key: 'bad',
            name: 'Bad',
            gitUrl: 'ssh://git.example.net/flows.git',
            gitCredential: token,
          },
          false,
        ),
      ),
    ).toBe('An ssh source is signed in to with an SSH key credential');
    expect(
      await refused(
        createProject(
          db,
          workspace,
          {
            key: 'bad2',
            name: 'Bad',
            gitUrl: 'https://git.example.net/flows.git',
            gitCredential: sshKey,
          },
          false,
        ),
      ),
    ).toMatch(/An https source is signed in to with a git token or a login/);
    // Moving the source from ssh to https drops the key it had.
    const moved = await updateProject(
      db,
      made.id,
      { gitUrl: 'https://git.example.net/net/flows.git' },
      false,
    );
    expect(moved.gitCredential).toBeUndefined();
    // The key reaches git as a key, with its passphrase and user.
    const revealed = await reveal(db, key, sshKey);
    expect(revealed && gitAuthOf(revealed)).toEqual({
      privateKey: FAKE_KEY,
      passphrase: 'fictional',
      username: 'deploy',
    });
  });
});

const url = process.env.AFS_TEST_SSH_URL;
const keyFile = process.env.AFS_TEST_SSH_KEY;
const lockedFile = process.env.AFS_TEST_SSH_LOCKED_KEY;
const passphrase = process.env.AFS_TEST_SSH_PASSPHRASE;

describe.skipIf(!url || !keyFile)('an ssh source on a real SSH server', () => {
  const trusted: { host: string; keys: string[] }[] = [];
  let git: Git;
  const reposDir = join(root, 'repos');
  const plain = () => ({ privateKey: readFileSync(keyFile as string, 'utf8') });
  const tempsLeft = () =>
    readdirSync(tmpdir()).filter(
      (n) => n.startsWith('afs-ssh-') && n !== root.split(/[\\/]/).at(-1),
    );

  beforeAll(() => {
    git = new Git({
      reposDir,
      allowLocal: false,
      onTrusted: (host, keys) => trusted.push({ host, keys }),
    });
  });

  it('fetches with a key, trusting the host on first use; the key file is gone afterwards', async () => {
    const before = tempsLeft().length;
    await git.ensure('p1', 'main');
    await git.fetch('p1', url as string, plain());
    expect(await git.branches('p1')).toContain('main');
    expect(trusted).toHaveLength(1);
    expect(trusted[0]?.host).toBe(sshHost(url as string));
    expect(trusted[0]?.keys.join(' ')).toMatch(/SHA256:/);
    expect(await git.hostKeys(url as string)).toEqual(trusted[0]?.keys);
    expect(tempsLeft().length).toBe(before);
    // Known now: a second fetch trusts nothing new.
    await git.fetch('p1', url as string, plain());
    expect(trusted).toHaveLength(1);
  });

  it('pushes to the source with the key (a branch made and deleted there)', async () => {
    const tip = await git.resolve('p1', 'main');
    await git.setBranch('p1', 'afs60-try', { commit: tip }, { url: url as string, auth: plain() });
    await git.fetch('p1', url as string, plain());
    expect(await git.branches('p1')).toContain('afs60-try');
    await git.setBranch('p1', 'afs60-try', { old: tip }, { url: url as string, auth: plain() });
    await git.fetch('p1', url as string, plain());
    expect(await git.branches('p1')).not.toContain('afs60-try');
  });

  it.skipIf(!lockedFile || !passphrase)(
    'unlocks a key with a passphrase; a wrong one is said',
    async () => {
      const locked = readFileSync(lockedFile as string, 'utf8');
      await git.ensure('p2', 'main');
      await git.fetch('p2', url as string, {
        privateKey: locked,
        passphrase: passphrase as string,
      });
      expect(await git.branches('p2')).toContain('main');
      const wrong = await git
        .fetch('p2', url as string, { privateKey: locked, passphrase: 'not it' })
        .then(
          () => 'fetched',
          (e: GitError) => e.message,
        );
      expect(wrong).toMatch(/SSH key cannot be read|refused the SSH key/);
    },
  );

  it('a key the source does not know is refused, and says so', async () => {
    const other = join(root, 'other-key');
    // A key the server never saw: made with the same tool the tests' keys came from.
    const { execFileSync } = await import('node:child_process');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', other]);
    const refused = await git
      .fetch('p1', url as string, { privateKey: readFileSync(other, 'utf8') })
      .then(
        () => 'fetched',
        (e: GitError) => e.message,
      );
    expect(refused).toBe('The source refused the SSH key (Permission denied)');
  });

  it('a changed host key stops the fetch until it is forgotten; then the new key is trusted', async () => {
    const file = join(reposDir, 'known_hosts');
    const host = sshHost(url as string) as string;
    // Another key for the same host, as after a reinstall or with someone in between.
    const { execFileSync } = await import('node:child_process');
    const fake = join(root, 'fake-host');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', fake]);
    const type = readFileSync(`${fake}.pub`, 'utf8').split(' ').slice(0, 2).join(' ');
    writeFileSync(file, `${host} ${type}\n`);
    const stopped = await git.fetch('p1', url as string, plain()).then(
      () => undefined,
      (e: unknown) => e as GitError,
    );
    expect(stopped?.hostKeyChanged).toBe(true);
    expect(stopped?.message).toMatch(/SSH host key is not the one the server trusts/);
    await git.forgetHostKeys(url as string);
    expect(existsSync(`${file}.old`)).toBe(false);
    await git.fetch('p1', url as string, plain());
    expect(trusted).toHaveLength(2);
  });
});

describe.skipIf(!url || !lockedFile || !passphrase)(
  'a push through the server to an ssh source, signed in with a key that has a passphrase',
  () => {
    let database: Database;
    let app: FastifyInstance;
    let sync: ProjectSync;
    let base: string;
    let token: string;
    let project: Project;
    const lines: string[] = [];
    // Not a blocking call: the server answering it runs in this same process.
    const client = async (cwd: string, ...args: string[]) =>
      (
        await run('git', ['-c', 'credential.helper=', '-c', 'core.autocrlf=false', ...args], {
          cwd,
          encoding: 'utf8',
          timeout: 60_000,
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: join(root, 'client-config'),
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'never',
            GIT_AUTHOR_NAME: 'Lena Brandt',
            GIT_AUTHOR_EMAIL: 'lena@example.net',
            GIT_COMMITTER_NAME: 'Lena Brandt',
            GIT_COMMITTER_EMAIL: 'lena@example.net',
          },
        })
      ).stdout.trim();

    beforeAll(async () => {
      database = openDatabase({ kind: 'sqlite', file: ':memory:' });
      await migrate(database.db as never);
      const db = database.db;
      const log = createLogger({ level: 'debug', format: 'json', write: (l) => lines.push(l) });
      const git = new Git({ reposDir: join(root, 'repos-app'), allowLocal: true });
      sync = new ProjectSync(db, git, log, async (p) => {
        const revealed = p.gitCredential ? await reveal(db, key, p.gitCredential) : undefined;
        return revealed ? gitAuthOf(revealed) : undefined;
      });
      app = buildApp({
        log,
        database,
        instance: 'test',
        masterKey: key,
        projects: { git, sync, allowLocal: true, freshMs: 0 },
      });
      await app.listen({ port: 0, host: '127.0.0.1' });
      base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const dana = await createUser(db, {
        login: 'dana',
        name: 'Dana',
        password: 'correct horse battery staple',
        admin: true,
      });
      token = (await createToken(db, dana.id, { name: 'git' })).token;
      const workspace = (await createWorkspace(db, { key: 'net', name: 'Network' })).id;
      const credential = (
        await createCredential(db, key, workspace, {
          name: 'Deploy key',
          kind: 'ssh_key',
          secret: {
            privateKey: readFileSync(lockedFile as string, 'utf8'),
            passphrase: passphrase as string,
          },
        })
      ).id;
      project = await createProject(
        db,
        workspace,
        { key: 'flows', name: 'Flows', gitUrl: url as string, gitCredential: credential },
        false,
      );
      expect((await sync.sync(project.id))?.sync).toMatchObject({ state: 'ok' });
    });
    afterAll(async () => {
      await sync?.stop();
      await app?.close();
      await database?.close();
    });

    it('the source gets the push; the key and its passphrase are in no log line', async () => {
      const dir = join(root, 'through');
      await client(root, 'clone', '--quiet', `http://git:${token}@${base}${project.gitPath}`, dir);
      writeFileSync(join(dir, `afs60-${Date.now()}.txt`), 'through the server\n');
      await client(dir, 'add', '--all');
      await client(dir, 'commit', '--quiet', '-m', 'Through the server over ssh');
      const pushed = await client(dir, 'rev-parse', 'HEAD');
      await client(dir, 'push', '--quiet', 'origin', 'main');
      expect((await getProject(database.db, project.id))?.commit).toBe(pushed);
      // The source itself has it.
      const atSource = execFileSync('git', ['ls-remote', url as string, 'refs/heads/main'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_SSH_COMMAND: `ssh -i "${(keyFile as string).replace(/\\/g, '/')}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes`,
        },
      });
      expect(atSource.split(/\s/)[0]).toBe(pushed);
      const log = lines.join('\n');
      expect(log).not.toContain(passphrase as string);
      expect(log).not.toContain('PRIVATE KEY');
    });
  },
);
