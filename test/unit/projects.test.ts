// Workspaces and projects: the rules, bringing a mirror up to date, and the API. The rules run on
// both databases (PostgreSQL when AFS_TEST_POSTGRES_URL is set); the sources are real git
// repositories in folders of this machine.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { createUser } from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import {
  createProject,
  createWorkspace,
  deleteProject,
  deleteWorkspace,
  dueProjects,
  getProject,
  hookTokenMatches,
  listProjects,
  listWorkspaces,
  newHookToken,
  recordSync,
  removeHookToken,
  updateProject,
  updateWorkspace,
} from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { emptyWorkspaces } from './helpers/clean';
import { type TestRepo, testRepo } from './helpers/repo';

const PASSWORD = 'correct horse battery staple';
const URL_OK = 'https://git.example.net/network/flows.git';
const root = mkdtempSync(join(tmpdir(), 'afs-projects-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

for (const [name, config] of databases) {
  describe.skipIf(!config)(`workspaces and projects on ${name}`, () => {
    let database: Database;
    const db = () => database.db;
    beforeAll(async () => {
      if (!config) return;
      database = openDatabase(config);
      await migrate(database.db as never);
    });
    afterAll(async () => {
      await database?.close();
    });
    beforeEach(async () => {
      await emptyWorkspaces(db());
    });

    it('a workspace has a key for addresses; an empty one can be deleted', async () => {
      const net = await createWorkspace(db(), { key: 'Network', name: 'Network team' });
      expect(net).toMatchObject({ key: 'network', name: 'Network team', projects: 0 });
      await expect(createWorkspace(db(), { key: 'network', name: 'x' })).rejects.toMatchObject({
        code: 'taken',
      });
      for (const key of ['', '-x', 'x-', 'has space', 'Ünïcode', 'a'.repeat(64)])
        await expect(createWorkspace(db(), { key, name: 'x' })).rejects.toMatchObject({
          code: 'invalid',
        });
      expect(
        await updateWorkspace(db(), net.id, { name: 'Network', description: 'Switches' }),
      ).toMatchObject({ name: 'Network', description: 'Switches' });

      await createProject(db(), net.id, { key: 'flows', name: 'Flows', gitUrl: URL_OK }, false);
      expect((await listWorkspaces(db()))[0]?.projects).toBe(1);
      await expect(deleteWorkspace(db(), net.id)).rejects.toMatchObject({ code: 'not_empty' });
      await deleteProject(db(), (await listProjects(db(), net.id))[0]?.id ?? '');
      await deleteWorkspace(db(), net.id);
      expect(await listWorkspaces(db())).toEqual([]);
      await expect(deleteWorkspace(db(), net.id)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('a project names a repository and the branch that may run', async () => {
      const net = await createWorkspace(db(), { key: 'network', name: 'Network' });
      const ops = await createWorkspace(db(), { key: 'ops', name: 'Operations' });
      const project = await createProject(
        db(),
        net.id,
        { key: 'Flows', name: 'Edge flows', gitUrl: URL_OK },
        false,
      );
      expect(project).toMatchObject({
        workspace: net.id,
        key: 'flows',
        gitUrl: URL_OK,
        gitRef: 'main',
        pollSeconds: 300,
        hook: false,
        sync: { state: 'never' },
      });
      expect(project.commit).toBeUndefined();
      // The key is unique in its workspace, not across them.
      await expect(
        createProject(db(), net.id, { key: 'flows', name: 'x', gitUrl: URL_OK }, false),
      ).rejects.toMatchObject({ code: 'taken' });
      await createProject(db(), ops.id, { key: 'flows', name: 'x', gitUrl: URL_OK }, false);
      await expect(
        createProject(db(), 'no-workspace', { key: 'f', name: 'x', gitUrl: URL_OK }, false),
      ).rejects.toMatchObject({ code: 'not_found' });

      for (const bad of [
        { gitUrl: 'https://dana:s3cret@git.example.net/x.git' },
        { gitUrl: 'http://git.example.net/x.git' },
        { gitUrl: '/srv/repos/x' },
        { gitRef: 'a..b' },
        { pollSeconds: 5 },
      ])
        await expect(
          createProject(db(), net.id, { key: 'other', name: 'x', gitUrl: URL_OK, ...bad }, false),
        ).rejects.toMatchObject({ code: 'invalid' });
    });

    it('remembers how the last look at the source ended; a new source forgets the commit', async () => {
      const net = await createWorkspace(db(), { key: 'network', name: 'Network' });
      const made = await createProject(
        db(),
        net.id,
        { key: 'flows', name: 'Flows', gitUrl: URL_OK },
        false,
      );
      const commit = 'a'.repeat(40);
      await recordSync(db(), made.id, { commit });
      expect(await getProject(db(), made.id)).toMatchObject({ commit, sync: { state: 'ok' } });
      // A failure keeps the commit: what ran before can still be read.
      await recordSync(db(), made.id, { error: 'Could not resolve host: git.example.net' });
      const failed = await getProject(db(), made.id);
      expect(failed).toMatchObject({
        commit,
        sync: { state: 'error', error: 'Could not resolve host: git.example.net' },
      });
      expect(failed?.sync.at).toMatch(/^\d{4}-/);

      expect((await updateProject(db(), made.id, { name: 'Edge flows' }, false)).commit).toBe(
        commit,
      );
      const moved = await updateProject(db(), made.id, { gitRef: 'release' }, false);
      expect(moved).toMatchObject({ gitRef: 'release', sync: { state: 'never' } });
      expect(moved.commit).toBeUndefined();
    });

    it('a project is due when its time has passed, and never with polling off', async () => {
      const net = await createWorkspace(db(), { key: 'network', name: 'Network' });
      const often = await createProject(
        db(),
        net.id,
        { key: 'often', name: 'x', gitUrl: URL_OK, pollSeconds: 60 },
        false,
      );
      const never = await createProject(
        db(),
        net.id,
        { key: 'never', name: 'x', gitUrl: URL_OK, pollSeconds: 0 },
        false,
      );
      // Never looked at: due at once. Polling off: never due.
      expect((await dueProjects(db())).map((p) => p.key)).toEqual(['often']);
      await recordSync(db(), often.id, { commit: 'b'.repeat(40) });
      await recordSync(db(), never.id, { commit: 'b'.repeat(40) });
      expect(await dueProjects(db())).toEqual([]);
      expect((await dueProjects(db(), new Date(Date.now() + 61_000))).map((p) => p.key)).toEqual([
        'often',
      ]);
    });

    it('a push hook has a token that is shown once and kept as a hash', async () => {
      const net = await createWorkspace(db(), { key: 'network', name: 'Network' });
      const project = await createProject(
        db(),
        net.id,
        { key: 'flows', name: 'x', gitUrl: URL_OK },
        false,
      );
      expect(await hookTokenMatches(db(), project.id, 'anything')).toBe(false);
      const token = await newHookToken(db(), project.id);
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      const row = await db().selectFrom('project').selectAll().executeTakeFirstOrThrow();
      expect(JSON.stringify(row)).not.toContain(token);
      expect((await getProject(db(), project.id))?.hook).toBe(true);
      expect(await hookTokenMatches(db(), project.id, token)).toBe(true);
      expect(await hookTokenMatches(db(), project.id, `${token}x`)).toBe(false);
      expect(await hookTokenMatches(db(), 'no-project', token)).toBe(false);
      // A new token replaces the old one; removing it turns the hook off.
      const next = await newHookToken(db(), project.id);
      expect(await hookTokenMatches(db(), project.id, token)).toBe(false);
      expect(await hookTokenMatches(db(), project.id, next)).toBe(true);
      await removeHookToken(db(), project.id);
      expect(await hookTokenMatches(db(), project.id, next)).toBe(false);
    });
  });
}

describe('bringing a project up to date', () => {
  let database: Database;
  let repo: TestRepo;
  let sync: ProjectSync;
  let git: Git;
  let lines: string[];
  let n = 0;

  beforeEach(async () => {
    lines = [];
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    repo = testRepo({ 'flows/hello/hello.flow.yaml': 'schema_version: 2\n' });
    git = new Git({ reposDir: join(root, `mirrors-${++n}`), allowLocal: true });
    sync = new ProjectSync(
      database.db,
      git,
      createLogger({ level: 'info', format: 'text', write: (line) => lines.push(line) }),
    );
  });
  afterEach(async () => {
    await sync.stop();
    await database.close();
    repo.remove();
  });
  const project = async (
    extra: { gitRef?: string; gitUrl?: string; pollSeconds?: number } = {},
  ) => {
    const ws = await createWorkspace(database.db, { key: `ws${n}`, name: 'Network' });
    return createProject(
      database.db,
      ws.id,
      { key: 'flows', name: 'Flows', gitUrl: repo.dir, ...extra },
      true,
    );
  };

  it('the first look makes the mirror; later ones follow the branch', async () => {
    const made = await project();
    const first = await sync.sync(made.id);
    expect(first?.sync.state).toBe('ok');
    expect(first?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.files(made.id, first?.commit ?? '')).toEqual(['flows/hello/hello.flow.yaml']);

    const next = repo.commit({ 'flows/hello/hello.flow.yaml': 'schema_version: 2\n# edited\n' });
    expect((await sync.sync(made.id))?.commit).toBe(next);
    expect(lines.filter((l) => l.includes('Project is at a new commit'))).toHaveLength(2);
    // Nothing new: nothing to say.
    await sync.sync(made.id);
    expect(lines.filter((l) => l.includes('Project is at a new commit'))).toHaveLength(2);
  });

  it("a source that cannot be read is the project's state, said once, and the commit stays", async () => {
    const made = await project();
    const good = await sync.sync(made.id);
    repo.remove();
    const failed = await sync.sync(made.id);
    expect(failed?.sync.state).toBe('error');
    expect(failed?.sync.error).toBeTruthy();
    expect(failed?.commit).toBe(good?.commit);
    await sync.sync(made.id);
    expect(lines.filter((l) => l.includes('Project source could not be read'))).toHaveLength(1);
    repo = testRepo();
  });

  it('a branch that is not there says which ones are', async () => {
    const made = await project({ gitRef: 'release' });
    const result = await sync.sync(made.id);
    expect(result?.sync).toMatchObject({ state: 'error' });
    expect(result?.sync.error).toMatch(/no branch release \(it has main\)/);
  });

  it('two askers at once share one look; a project that is gone gives nothing', async () => {
    const made = await project();
    const [a, b] = await Promise.all([sync.sync(made.id), sync.sync(made.id)]);
    expect(a?.commit).toBe(b?.commit);
    expect(lines.filter((l) => l.includes('Project is at a new commit'))).toHaveLength(1);
    expect(await sync.sync('no-such-project')).toBeUndefined();
  });

  it('the timer looks at the projects that are due, and only those', async () => {
    const due = await project({ pollSeconds: 60 });
    expect(await sync.tick()).toBe(1);
    expect((await getProject(database.db, due.id))?.sync.state).toBe('ok');
    expect(await sync.tick()).toBe(0);
    const commit = repo.commit({ 'README.md': 'new\n' });
    expect(await sync.tick(new Date(Date.now() + 61_000))).toBe(1);
    expect((await getProject(database.db, due.id))?.commit).toBe(commit);
  });

  it("a deleted project's mirror is removed", async () => {
    const made = await project();
    await sync.sync(made.id);
    expect(existsSync(git.mirror(made.id))).toBe(true);
    await deleteProject(database.db, made.id);
    await sync.forget(made.id);
    expect(existsSync(git.mirror(made.id))).toBe(false);
  });
});

describe('workspaces and projects over HTTP', () => {
  let database: Database;
  let app: FastifyInstance;
  let repo: TestRepo;
  let sync: ProjectSync;
  let lines: string[];
  let admin: string;
  let member: string;
  let n = 0;

  type Reply = Awaited<ReturnType<FastifyInstance['inject']>>;
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
    });
  const signIn = async (login: string, isAdmin: boolean) => {
    await createUser(database.db, { login, name: login, password: PASSWORD, admin: isAdmin });
    const reply: Reply = await call('POST', '/api/v1/session', {
      body: { login, password: PASSWORD },
    });
    return /afs_session=[^;]*/.exec(String(reply.headers['set-cookie']))?.[0] ?? '';
  };

  beforeEach(async () => {
    lines = [];
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    repo = testRepo({ 'flows/hello/hello.flow.yaml': 'schema_version: 2\n' });
    const log = createLogger({ level: 'info', format: 'json', write: (line) => lines.push(line) });
    const git = new Git({ reposDir: join(root, `http-${++n}`), allowLocal: true });
    sync = new ProjectSync(database.db, git, log);
    app = buildApp({
      log,
      database,
      instance: 'test',
      projects: { git, sync, allowLocal: true },
    });
    admin = await signIn('dana', true);
    member = await signIn('omar', false);
  });
  afterEach(async () => {
    await sync.stop();
    await app.close();
    await database.close();
    repo.remove();
  });

  /** The member (omar) gets ro on the workspace: access levels came with AFS-27. */
  const grantMember = async (level = 'ro') =>
    call('POST', '/api/v1/workspaces/network/grants', {
      cookie: admin,
      body: { user: 'omar', level },
    });

  it('everyone signed in reads; only administrators change', async () => {
    expect((await call('GET', '/api/v1/workspaces')).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/workspaces', { cookie: member })).json()).toEqual([]);
    const body = { key: 'network', name: 'Network team' };
    expect((await call('POST', '/api/v1/workspaces', { cookie: member, body })).statusCode).toBe(
      403,
    );
    const made = await call('POST', '/api/v1/workspaces', { cookie: admin, body });
    expect(made.statusCode).toBe(201);
    // A member sees no workspace until given a level on it, and is not told it is there.
    expect((await call('GET', '/api/v1/workspaces/network', { cookie: member })).statusCode).toBe(
      404,
    );
    expect((await grantMember()).statusCode).toBe(201);
    expect(
      (await call('GET', '/api/v1/workspaces', { cookie: member }))
        .json()
        .map((w: { key: string }) => w.key),
    ).toEqual(['network']);
    // By id or by key.
    const id = (made.json() as { id: string }).id;
    expect(
      (await call('GET', `/api/v1/workspaces/${id}`, { cookie: member })).json(),
    ).toMatchObject({ key: 'network' });
    expect((await call('GET', '/api/v1/workspaces/network', { cookie: member })).statusCode).toBe(
      200,
    );
    expect((await call('GET', '/api/v1/workspaces/nope', { cookie: member })).statusCode).toBe(404);
    expect((await call('POST', '/api/v1/workspaces', { cookie: admin, body })).statusCode).toBe(
      409,
    );
    expect(
      (
        await call('PATCH', '/api/v1/workspaces/network', {
          cookie: admin,
          body: { description: 'Switches and routers' },
        })
      ).json(),
    ).toMatchObject({ description: 'Switches and routers' });
    expect(
      (await call('DELETE', '/api/v1/workspaces/network', { cookie: member })).statusCode,
    ).toBe(403);
  });

  it('adding a project looks at its source at once and says how it went', async () => {
    await call('POST', '/api/v1/workspaces', {
      cookie: admin,
      body: { key: 'network', name: 'N' },
    });
    await grantMember();
    const made = await call('POST', '/api/v1/workspaces/network/projects', {
      cookie: admin,
      body: { key: 'flows', name: 'Edge flows', gitUrl: repo.dir },
    });
    expect(made.statusCode).toBe(201);
    const project = made.json() as { id: string; commit: string };
    expect(project).toMatchObject({ key: 'flows', gitRef: 'main', sync: { state: 'ok' } });
    expect(project.commit).toMatch(/^[0-9a-f]{40}$/);

    // A source that is not there: the project is made, and says so.
    const broken = await call('POST', '/api/v1/workspaces/network/projects', {
      cookie: admin,
      body: { key: 'broken', name: 'Broken', gitUrl: join(root, 'no-such-repo') },
    });
    expect(broken.statusCode).toBe(201);
    expect(broken.json()).toMatchObject({ sync: { state: 'error' } });

    const refused = await call('POST', '/api/v1/workspaces/network/projects', {
      cookie: admin,
      body: { key: 'bad', name: 'Bad', gitUrl: 'https://dana:s3cret@git.example.net/x.git' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toMatch(/password/);
    expect(lines.join('\n')).not.toContain('s3cret');

    const list = (
      await call('GET', '/api/v1/workspaces/network/projects', { cookie: member })
    ).json();
    expect((list as { key: string }[]).map((p) => p.key)).toEqual(['broken', 'flows']);
    expect(
      (await call('GET', `/api/v1/projects/${project.id}/branches`, { cookie: member })).json(),
    ).toEqual({ branches: ['main'] });
  });

  it('sync on request, a change of branch, and delete', async () => {
    await call('POST', '/api/v1/workspaces', {
      cookie: admin,
      body: { key: 'network', name: 'N' },
    });
    await grantMember();
    const project = (
      await call('POST', '/api/v1/workspaces/network/projects', {
        cookie: admin,
        body: { key: 'flows', name: 'Flows', gitUrl: repo.dir, pollSeconds: 0 },
      })
    ).json() as { id: string; commit: string };

    const next = repo.commit({ 'README.md': 'more\n' });
    expect(
      (await call('POST', `/api/v1/projects/${project.id}/sync`, { cookie: member })).statusCode,
    ).toBe(403);
    expect(
      (await call('POST', `/api/v1/projects/${project.id}/sync`, { cookie: admin })).json(),
    ).toMatchObject({ commit: next });

    repo.branch('release');
    const released = repo.commit({ RELEASE: '1\n' });
    const moved = await call('PATCH', `/api/v1/projects/${project.id}`, {
      cookie: admin,
      body: { gitRef: 'release' },
    });
    expect(moved.json()).toMatchObject({ gitRef: 'release', commit: released });

    expect(
      (await call('DELETE', `/api/v1/projects/${project.id}`, { cookie: admin })).statusCode,
    ).toBe(204);
    expect(
      (await call('GET', `/api/v1/projects/${project.id}`, { cookie: admin })).statusCode,
    ).toBe(404);
    expect((await call('DELETE', '/api/v1/workspaces/network', { cookie: admin })).statusCode).toBe(
      204,
    );
  });

  it('the push hook brings the project up to date for whoever shows its token', async () => {
    await call('POST', '/api/v1/workspaces', {
      cookie: admin,
      body: { key: 'network', name: 'N' },
    });
    await grantMember();
    const project = (
      await call('POST', '/api/v1/workspaces/network/projects', {
        cookie: admin,
        body: { key: 'flows', name: 'Flows', gitUrl: repo.dir, pollSeconds: 0 },
      })
    ).json() as { id: string };
    const push = `/api/v1/hooks/projects/${project.id}/push`;

    // No hook yet: no token is right.
    expect((await call('POST', push, { headers: { 'x-gitlab-token': 'guess' } })).statusCode).toBe(
      401,
    );
    expect(
      (await call('POST', `/api/v1/projects/${project.id}/hook`, { cookie: member })).statusCode,
    ).toBe(403);
    const hook = await call('POST', `/api/v1/projects/${project.id}/hook`, { cookie: admin });
    expect(hook.statusCode).toBe(201);
    const { token, url } = hook.json() as { token: string; url: string };
    expect(url).toBe(push);
    // The token is in no log line.
    expect(lines.join('\n')).not.toContain(token);

    const commit = repo.commit({ 'README.md': 'pushed\n' });
    const ways: Record<string, string>[] = [
      { 'x-gitlab-token': token },
      { 'x-afs-token': token },
      { authorization: `Bearer ${token}` },
    ];
    for (const headers of ways) {
      const reply = await call('POST', push, { headers, body: { ref: 'refs/heads/main' } });
      expect(reply.statusCode).toBe(202);
    }
    // The answer does not wait for the fetch; the project follows shortly.
    let now: { commit?: string } = {};
    for (let i = 0; i < 50 && now.commit !== commit; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      now = (await call('GET', `/api/v1/projects/${project.id}`, { cookie: member })).json();
    }
    expect(now.commit).toBe(commit);

    expect(
      (await call('POST', push, { headers: { 'x-gitlab-token': `${token}x` } })).statusCode,
    ).toBe(401);
    expect((await call('POST', push)).statusCode).toBe(401);
    expect(
      (
        await call('POST', '/api/v1/hooks/projects/nope/push', {
          headers: { 'x-afs-token': token },
        })
      ).statusCode,
    ).toBe(401);
    await call('DELETE', `/api/v1/projects/${project.id}/hook`, { cookie: admin });
    expect((await call('POST', push, { headers: { 'x-gitlab-token': token } })).statusCode).toBe(
      401,
    );
  });

  it('guessing a hook token is stopped', async () => {
    let last = await call('POST', '/api/v1/hooks/projects/x/push', {
      headers: { 'x-afs-token': 'guess-0' },
    });
    for (let i = 1; i <= 20; i++)
      last = await call('POST', '/api/v1/hooks/projects/x/push', {
        headers: { 'x-afs-token': `guess-${i}` },
      });
    expect(last.statusCode).toBe(429);
  });
});
