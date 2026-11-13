// A project that signs in to its source with a credential from the store. The private source
// is this same server: a hosted project, which only answers to an access token. The project
// under test mirrors it over HTTP on this machine, signed in with a git_token credential.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/server/app';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { authEnv, Git, gitUrlProblem } from '../../src/server/projects/git';
import {
  createProject,
  createWorkspace,
  getProject,
  listPushes,
  type Project,
  updateProject,
} from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import {
  createCredential,
  gitAuthOf,
  reveal,
  updateCredential,
} from '../../src/server/secrets/credentials';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });
const PASSWORD = 'correct horse battery staple';
const root = mkdtempSync(join(tmpdir(), 'afs-gitcred-'));
const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };

let database: Database;
let app: FastifyInstance;
let git: Git;
let sync: ProjectSync;
let base: string;
let lines: string[];
let workspace: string;
let source: Project;
let adminToken: string;
let memberToken: string;
let credential: string;

function client(cwd: string, ...args: string[]) {
  return new Promise<{ ok: boolean; out: string; err: string }>((resolve) => {
    execFile(
      'git',
      ['-c', 'credential.helper=', '-c', 'core.autocrlf=false', ...args],
      {
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
      },
      (error, stdout, stderr) => resolve({ ok: !error, out: stdout.trim(), err: stderr.trim() }),
    );
  });
}
const must = async (cwd: string, ...args: string[]) => {
  const done = await client(cwd, ...args);
  if (!done.ok) throw new Error(`git ${args[0]}: ${done.err}`);
  return done.out;
};
const address = (project: Project, token: string) =>
  `http://git:${token}@${base}${project.gitPath}`;

beforeAll(async () => {
  lines = [];
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  const db = database.db;
  const log = createLogger({ level: 'debug', format: 'json', write: (l) => lines.push(l) });
  git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
  sync = new ProjectSync(db, git, log, async (project) => {
    const revealed = project.gitCredential
      ? await reveal(db, key, project.gitCredential)
      : undefined;
    if (project.gitCredential && !revealed) throw new Error('The credential is gone');
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
    password: PASSWORD,
    admin: true,
  });
  const omar = await createUser(db, { login: 'omar', name: 'Omar', password: PASSWORD });
  adminToken = (await createToken(db, dana.id, { name: 'git' })).token;
  memberToken = (await createToken(db, omar.id, { name: 'git' })).token;
  workspace = (await createWorkspace(db, { key: 'net', name: 'Network' })).id;

  // The private source, with a first commit.
  source = await createProject(db, workspace, { key: 'source', name: 'Source' }, true);
  await sync.sync(source.id);
  const seed = join(root, 'seed');
  await must(root, 'clone', '--quiet', address(source, adminToken), seed);
  await must(seed, 'checkout', '--quiet', '-B', 'main');
  writeFileSync(join(seed, 'site.flow.yaml'), 'flow: {}\n');
  await must(seed, 'add', '--all');
  await must(seed, 'commit', '--quiet', '-m', 'First');
  await must(seed, 'push', '--quiet', 'origin', 'main');

  credential = (
    await createCredential(db, key, workspace, {
      name: 'Source token',
      kind: 'git_token',
      secret: { token: adminToken },
    })
  ).id;
});
afterAll(async () => {
  await sync.stop();
  await app.close();
  await database.close();
  rmSync(root, { recursive: true, force: true });
});

const sourceUrl = () => `http://${base}${source.gitPath}`;
const tip = async () => (await getProject(database.db, source.id))?.commit;

describe('how a sign-in reaches git', () => {
  it("is a setting of that one call, for the source's own address", () => {
    const env = authEnv('https://git.example.net/network/edge.git', {
      username: 'deploy',
      password: 'p@ss:word',
    });
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://git.example.net/.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from('deploy:p@ss:word').toString('base64')}`,
    });
    expect(authEnv('https://git.example.net/x.git', undefined)).toEqual({});
    // Over ssh a password means nothing: it is not sent anywhere.
    expect(authEnv('git@git.example.net:x.git', { username: 'u', password: 'p' })).toEqual({});
  });

  it('plain http is only for this machine itself, where folders of it are allowed', () => {
    expect(gitUrlProblem('http://127.0.0.1:8080/git/a/b.git', true)).toBeUndefined();
    expect(gitUrlProblem('http://localhost/git/a/b.git', true)).toBeUndefined();
    expect(gitUrlProblem('http://127.0.0.1:8080/git/a/b.git', false)).toMatch(/not plain http/);
    expect(gitUrlProblem('http://git.example.net/a.git', true)).toMatch(/not plain http/);
  });
});

describe('a project with a private source', () => {
  let mirror: Project;

  it('cannot read it without a credential, and says so as its state', async () => {
    const made = await createProject(
      database.db,
      workspace,
      { key: 'mirror', name: 'Mirror', gitUrl: sourceUrl(), pollSeconds: 0 },
      true,
    );
    mirror = (await sync.sync(made.id)) as Project;
    expect(mirror.sync.state).toBe('error');
    expect(mirror.commit).toBeUndefined();
  });

  it('reads it once it has one, and the token is in no log line', async () => {
    await updateProject(database.db, mirror.id, { gitCredential: credential }, true);
    mirror = (await sync.sync(mirror.id)) as Project;
    expect(mirror).toMatchObject({
      sync: { state: 'ok' },
      commit: await tip(),
      gitCredential: credential,
    });
    expect((await git.read(mirror.id, mirror.commit as string, 'site.flow.yaml'))?.toString()).toBe(
      'flow: {}\n',
    );
    const log = lines.join('\n');
    expect(log).not.toContain(adminToken);
    expect(log).not.toContain(Buffer.from(`git:${adminToken}`).toString('base64'));
  });

  it('passes a push on to the source, signed in with the credential', async () => {
    const dir = join(root, 'work');
    await must(root, 'clone', '--quiet', address(mirror, adminToken), dir);
    mkdirSync(join(dir, 'flows'));
    writeFileSync(join(dir, 'flows', 'new.flow.yaml'), 'flow: {}\n');
    await must(dir, 'add', '--all');
    await must(dir, 'commit', '--quiet', '-m', 'Through the mirror');
    const pushed = await must(dir, 'rev-parse', 'HEAD');
    await must(dir, 'push', '--quiet', 'origin', 'main');

    // The source has it (recorded there as pushed by the credential's owner), and so has the mirror.
    expect(await tip()).toBe(pushed);
    expect((await getProject(database.db, mirror.id))?.commit).toBe(pushed);
    expect((await listPushes(database.db, source.id))[0]).toMatchObject({
      login: 'dana',
      to: pushed,
    });
    expect((await listPushes(database.db, mirror.id))[0]).toMatchObject({
      login: 'dana',
      to: pushed,
    });
    expect(lines.join('\n')).not.toContain(adminToken);
  });

  it("a credential the source refuses is the project's state, and a push is refused", async () => {
    // The credential now holds the token of someone who may read the source and not push to it.
    await updateCredential(database.db, key, credential, { secret: { token: memberToken } });
    const before = await tip();
    const dir = join(root, 'work');
    writeFileSync(join(dir, 'more.txt'), 'x\n');
    await must(dir, 'add', '--all');
    await must(dir, 'commit', '--quiet', '-m', 'Not accepted');
    const pushed = await client(dir, 'push', 'origin', 'main');
    expect(pushed.ok).toBe(false);
    expect(pushed.err).toMatch(/afs: the project's repository did not accept the push/);
    expect(pushed.err).not.toContain(memberToken);
    expect(await tip()).toBe(before);
    expect((await getProject(database.db, mirror.id))?.commit).toBe(before);

    // A token that is no token at all: the look fails, the commit it had stays.
    await updateCredential(database.db, key, credential, {
      secret: { token: `afs_${'x'.repeat(43)}` },
    });
    const after = (await sync.sync(mirror.id)) as Project;
    expect(after.sync.state).toBe('error');
    expect(after.commit).toBe(before);
    expect(JSON.stringify(after)).not.toContain('afs_xxx');
  });
});
