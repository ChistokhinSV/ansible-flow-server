// The server as a git address, driven by the real git client over HTTP: clone, fetch and push
// of a project the server hosts and of one with an external source, who may do which, and what
// the server keeps of it.

import { execFile, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/server/app';
import { listAudit } from '../../src/server/audit/store';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import {
  createProject,
  createWorkspace,
  getProject,
  listPushes,
  type Project,
} from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { type TestRepo, testRepo } from './helpers/repo';

const PASSWORD = 'correct horse battery staple';
// Every step is a real git program started and finished.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });
const root = mkdtempSync(join(tmpdir(), 'afs-githttp-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let database: Database;
let app: FastifyInstance;
let git: Git;
let sync: ProjectSync;
let base: string;
let lines: string[];
let work: string;
let n = 0;
/** Tokens: an administrator's, a read-only one of theirs, and one of a person who is not one. */
let admin: string;
let readOnly: string;
let member: string;
let workspaceId: string;
const sources: TestRepo[] = [];

beforeEach(async () => {
  lines = [];
  work = join(root, `t${++n}`);
  mkdirSync(work, { recursive: true });
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  const log = createLogger({ level: 'info', format: 'json', write: (l) => lines.push(l) });
  git = new Git({ reposDir: join(work, 'repos'), allowLocal: true });
  sync = new ProjectSync(database.db, git, log);
  app = buildApp({
    log,
    database,
    instance: 'test',
    projects: { git, sync, allowLocal: true, freshMs: 0 },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const root_ = await createUser(database.db, {
    login: 'dana',
    name: 'Dana Whitfield',
    password: PASSWORD,
    admin: true,
  });
  const omar = await createUser(database.db, { login: 'omar', name: 'Omar', password: PASSWORD });
  admin = (await createToken(database.db, root_.id, { name: 'git' })).token;
  readOnly = (await createToken(database.db, root_.id, { name: 'ro', readOnly: true })).token;
  member = (await createToken(database.db, omar.id, { name: 'git' })).token;
  workspaceId = (await createWorkspace(database.db, { key: 'net', name: 'Network' })).id;
});
afterEach(async () => {
  await sync.stop();
  await app.close();
  await database.close();
  for (const source of sources.splice(0)) source.remove();
});

/** The address a git client uses, with a token as the password when one is given. */
const address = (project: Project, token?: string) =>
  `http://${token ? `git:${token}@` : ''}${base}${project.gitPath}`;

/** Runs the git client as a person at their own machine would: no settings of this one. */
function client(
  cwd: string,
  ...args: string[]
): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
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
          GIT_ASKPASS: '',
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
  if (!done.ok) throw new Error(`git ${args.join(' ')}: ${done.err}`);
  return done.out;
};
/** Clones a project into a new folder and gives the folder. */
async function clone(project: Project, token: string, name: string): Promise<string> {
  const dir = join(work, name);
  await must(work, 'clone', '--quiet', address(project, token), dir);
  return dir;
}
async function commit(dir: string, files: Record<string, string>, message = 'Change') {
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  await must(dir, 'add', '--all');
  await must(dir, 'commit', '--quiet', '-m', message);
  return must(dir, 'rev-parse', 'HEAD');
}
const hosted = async (key = 'flows') => {
  const project = await createProject(database.db, workspaceId, { key, name: key }, true);
  await sync.sync(project.id);
  return project;
};
/** A bare repository with one commit on main, as a git host would have it. */
function bareSource(): { dir: string; tip: () => string } {
  const seed = testRepo({ 'site.flow.yaml': 'flow: {}\n' });
  sources.push(seed);
  const dir = join(work, `source-${++n}.git`);
  execFileSync('git', ['clone', '--quiet', '--bare', seed.dir, dir]);
  return {
    dir,
    tip: () =>
      execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: dir, encoding: 'utf8' }).trim(),
  };
}

describe('a project the server hosts', () => {
  it('starts empty, takes a first push, and is then the project', async () => {
    const project = await hosted();
    expect(project).toMatchObject({ hosted: true, gitPath: '/git/net/flows.git', pollSeconds: 0 });
    expect(project.gitUrl).toBeUndefined();
    expect((await getProject(database.db, project.id))?.sync.state).toBe('never');

    const dir = await clone(project, admin, 'first');
    await must(dir, 'checkout', '--quiet', '-B', 'main');
    const first = await commit(dir, { 'site.flow.yaml': 'flow: {}\n' }, 'First flow');
    await must(dir, 'push', '--quiet', 'origin', 'main');

    // The answer to the push came after the server's own bookkeeping.
    const after = await getProject(database.db, project.id);
    expect(after).toMatchObject({ commit: first, sync: { state: 'ok' } });
    expect((await git.read(project.id, first, 'site.flow.yaml'))?.toString()).toBe('flow: {}\n');
    expect(await listPushes(database.db, project.id)).toMatchObject([
      { login: 'dana', ref: 'main', to: first },
    ]);
    expect((await listPushes(database.db, project.id))[0]?.from).toBeUndefined();
    // And the push is in the audit log, with the branch.
    expect((await listAudit(database.db, { action: 'git.push' })).entries[0]).toMatchObject({
      actor: { login: 'dana' },
      source: 'git',
      result: 'ok',
      object: { type: 'project', id: project.id, name: 'net/flows' },
      detail: { refs: [{ ref: 'main', to: first }] },
    });
    // The commit keeps its own author; the push is the administrator's.
    expect((await git.commitInfo(project.id, first)).author).toBe('Lena Brandt');
    expect(lines.join('\n')).not.toContain(admin);

    // Someone else's clone starts on the project's branch, with the file.
    const other = await clone(project, member, 'second');
    expect(await must(other, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(readFileSync(join(other, 'site.flow.yaml'), 'utf8')).toBe('flow: {}\n');

    // A second push is recorded with where the branch was; a fetch brings it to the other.
    const second = await commit(dir, { 'site.flow.yaml': 'flow: { version: 2 }\n' });
    await must(dir, 'push', '--quiet', 'origin', 'main');
    expect((await listPushes(database.db, project.id))[0]).toMatchObject({
      ref: 'main',
      from: first,
      to: second,
    });
    await must(other, 'pull', '--quiet');
    expect(await must(other, 'rev-parse', 'HEAD')).toBe(second);
  });

  it('keeps the history of the branch that runs; other branches are free', async () => {
    const project = await hosted();
    const dir = await clone(project, admin, 'work');
    await must(dir, 'checkout', '--quiet', '-B', 'main');
    const first = await commit(dir, { a: '1\n' });
    const second = await commit(dir, { a: '2\n' });
    await must(dir, 'push', '--quiet', 'origin', 'main');

    // Rewriting main, deleting it, and pushing something that is not a branch are refused.
    await must(dir, 'reset', '--quiet', '--hard', first);
    const rewritten = await commit(dir, { a: 'other\n' });
    const forced = await client(dir, 'push', '--force', 'origin', 'main');
    expect(forced.ok).toBe(false);
    expect(forced.err).toMatch(/afs: main is the branch that runs: its history is not rewritten/);
    const deleted = await client(dir, 'push', 'origin', ':main');
    expect(deleted.ok).toBe(false);
    expect(deleted.err).toMatch(/it is not deleted/);
    await must(dir, 'tag', 'v1');
    const tagged = await client(dir, 'push', 'origin', 'v1');
    expect(tagged.ok).toBe(false);
    expect(tagged.err).toMatch(/only branches are pushed here/);
    expect((await getProject(database.db, project.id))?.commit).toBe(second);
    expect(await listPushes(database.db, project.id)).toHaveLength(1);

    // A work branch is made, rewritten and deleted; each is recorded.
    await must(dir, 'push', '--quiet', 'origin', 'HEAD:refs/heads/try/idea');
    await must(dir, 'push', '--quiet', '--force', 'origin', `${first}:refs/heads/try/idea`);
    await must(dir, 'push', '--quiet', 'origin', ':try/idea');
    const pushes = (await listPushes(database.db, project.id)).filter((p) => p.ref === 'try/idea');
    expect(pushes.map((p) => [p.from, p.to])).toEqual(
      expect.arrayContaining([
        [undefined, rewritten],
        [rewritten, first],
        [first, undefined],
      ]),
    );
    expect(await git.branches(project.id)).toEqual(['main']);
    expect((await getProject(database.db, project.id))?.commit).toBe(second);
  });

  it('is put aside, not removed, when the project is deleted', async () => {
    const project = await hosted();
    const dir = await clone(project, admin, 'work');
    await must(dir, 'checkout', '--quiet', '-B', 'main');
    await commit(dir, { a: '1\n' });
    await must(dir, 'push', '--quiet', 'origin', 'main');
    await sync.forget(project.id, true);
    expect(existsSync(git.mirror(project.id))).toBe(false);
    expect(readdirSync(join(work, 'repos', 'deleted'))).toHaveLength(1);
  });
});

describe('who may use the git address', () => {
  it('needs a token as the password: not nothing, not a password, not a session', async () => {
    const project = await hosted();
    const none = await client(work, 'clone', address(project), join(work, 'none'));
    expect(none.ok).toBe(false);
    expect(none.err).toMatch(
      /Authentication failed|could not read Username|terminal prompts disabled/i,
    );

    const withPassword = `http://dana:${encodeURIComponent(PASSWORD)}@${base}${project.gitPath}`;
    expect((await client(work, 'clone', withPassword, join(work, 'pw'))).ok).toBe(false);
    const wrong = `http://git:afs_${'x'.repeat(43)}@${base}${project.gitPath}`;
    expect((await client(work, 'clone', wrong, join(work, 'wrong'))).ok).toBe(false);

    // The server asks a git client for a password; a browser's session is not one.
    const asked = await app.inject({
      method: 'GET',
      url: `${project.gitPath}/info/refs?service=git-upload-pack`,
    });
    expect(asked.statusCode).toBe(401);
    expect(asked.headers['www-authenticate']).toMatch(/^Basic realm=/);
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { login: 'dana', password: PASSWORD },
    });
    const cookie = /afs_session=[^;]*/.exec([signIn.headers['set-cookie']].flat().join(';'))?.[0];
    const bySession = await app.inject({
      method: 'GET',
      url: `${project.gitPath}/info/refs?service=git-upload-pack`,
      headers: { cookie: cookie ?? '' },
    });
    expect(bySession.statusCode).toBe(401);
  });

  it('everyone signed in reads; a read-only token and a person without edit rights do not push', async () => {
    const project = await hosted();
    const dir = await clone(project, admin, 'seed');
    await must(dir, 'checkout', '--quiet', '-B', 'main');
    const first = await commit(dir, { a: '1\n' });
    await must(dir, 'push', '--quiet', 'origin', 'main');

    for (const [name, token] of [
      ['read-only', readOnly],
      ['member', member],
    ] as const) {
      const mine = await clone(project, token, name);
      expect(await must(mine, 'rev-parse', 'HEAD')).toBe(first);
      await commit(mine, { a: `${name}\n` });
      const pushed = await client(mine, 'push', 'origin', 'main');
      expect(pushed.ok, name).toBe(false);
      expect(pushed.err, name).toMatch(/403/);
    }
    expect((await getProject(database.db, project.id))?.commit).toBe(first);
    expect(await listPushes(database.db, project.id)).toHaveLength(1);
    // The refused pushes are in the audit log, refused at git's first question.
    const refused = (await listAudit(database.db, { action: 'git.push', result: 'refused' }))
      .entries;
    expect(refused.slice(0, 2).map((e) => [e.actor?.login, e.status])).toEqual([
      ['omar', 403],
      ['dana', 403],
    ]);
  });

  it('answers 404 for a project that is not there, and only speaks smart HTTP', async () => {
    const project = await hosted();
    const auth = `Basic ${Buffer.from(`git:${admin}`).toString('base64')}`;
    const get = (url: string) =>
      app.inject({ method: 'GET', url, headers: { authorization: auth } });
    expect((await get('/git/net/nothing.git/info/refs?service=git-upload-pack')).statusCode).toBe(
      404,
    );
    expect((await get('/git/nowhere/flows.git/info/refs?service=git-upload-pack')).statusCode).toBe(
      404,
    );
    expect((await get(`${project.gitPath}/info/refs`)).statusCode).toBe(403);
    expect((await get(`${project.gitPath}/info/refs?service=git-upload-archive`)).statusCode).toBe(
      403,
    );
    const post = await app.inject({
      method: 'POST',
      url: `${project.gitPath}/git-receive-pack`,
      headers: { authorization: auth, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(post.statusCode).toBe(415);
  });
});

describe('a project with an external source', () => {
  const external = async (dir: string) => {
    const project = await createProject(
      database.db,
      workspaceId,
      { key: 'core', name: 'Core', gitUrl: dir, pollSeconds: 0 },
      true,
    );
    return (await sync.sync(project.id)) as Project;
  };

  it('is cloned from the server with what the source has now', async () => {
    const source = bareSource();
    const project = await external(source.dir);
    expect(project).toMatchObject({ hosted: false, gitUrl: source.dir, commit: source.tip() });
    const dir = await clone(project, member, 'mine');
    expect(await must(dir, 'rev-parse', 'HEAD')).toBe(source.tip());

    // Someone pushes to the source directly; a fetch from the server has it at once.
    const direct = join(work, 'direct');
    execFileSync('git', ['clone', '--quiet', source.dir, direct]);
    const next = await commit(direct, { 'site.flow.yaml': 'flow: { version: 2 }\n' });
    await must(direct, 'push', '--quiet', 'origin', 'main');
    await must(dir, 'pull', '--quiet');
    expect(await must(dir, 'rev-parse', 'HEAD')).toBe(next);
    expect((await getProject(database.db, project.id))?.commit).toBe(next);
  });

  it('passes a push on to the source, and records who pushed', async () => {
    const source = bareSource();
    const project = await external(source.dir);
    const before = source.tip();
    const dir = await clone(project, admin, 'mine');
    const pushed = await commit(dir, { 'site.flow.yaml': 'flow: { version: 3 }\n' });
    await must(dir, 'push', '--quiet', 'origin', 'main');

    expect(source.tip()).toBe(pushed);
    expect(await getProject(database.db, project.id)).toMatchObject({
      commit: pushed,
      sync: { state: 'ok' },
    });
    expect(await listPushes(database.db, project.id)).toMatchObject([
      { login: 'dana', ref: 'main', from: before, to: pushed },
    ]);
  });

  it('refuses what the source refuses: the mirror never holds it', async () => {
    // A source that is someone's working copy refuses a push to the branch it has checked out.
    const seed = testRepo({ 'site.flow.yaml': 'flow: {}\n' });
    sources.push(seed);
    const project = await external(seed.dir);
    const tip = project.commit;
    const dir = await clone(project, admin, 'mine');
    const mine = await commit(dir, { 'site.flow.yaml': 'flow: { version: 9 }\n' });
    const pushed = await client(dir, 'push', 'origin', 'main');
    expect(pushed.ok).toBe(false);
    expect(pushed.err).toMatch(/afs: the project's repository did not accept the push/);
    expect((await getProject(database.db, project.id))?.commit).toBe(tip);
    expect((await git.refs(project.id)).get('main')).toBe(tip);
    expect(await git.read(project.id, mine, 'site.flow.yaml')).toBeUndefined();
    expect(await listPushes(database.db, project.id)).toEqual([]);
  });

  it('refuses a push made on top of what the source no longer has', async () => {
    const source = bareSource();
    const project = await external(source.dir);
    const dir = await clone(project, admin, 'mine');
    // The source moves on behind the server's back, and the server is not asked to look.
    const direct = join(work, 'direct');
    execFileSync('git', ['clone', '--quiet', source.dir, direct]);
    const theirs = await commit(direct, { other: 'x\n' });
    await must(direct, 'push', '--quiet', 'origin', 'main');
    await commit(dir, { 'site.flow.yaml': 'flow: { version: 4 }\n' });
    // info/refs of a push does not ask the source: the client sends on top of the old commit.
    const pushed = await client(dir, 'push', 'origin', 'main');
    expect(pushed.ok).toBe(false);
    expect(source.tip()).toBe(theirs);
  });
});
