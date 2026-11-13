// Projects the server hosts, and the record of pushes: the rules, on both databases the server
// supports (PostgreSQL when AFS_TEST_POSTGRES_URL is set), and the API.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  dueProjects,
  getProject,
  listProjects,
  listPushes,
  ProjectError,
  recordPushes,
  updateProject,
} from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { emptyWorkspaces } from './helpers/clean';

const PASSWORD = 'correct horse battery staple';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'afs-hosted-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

for (const [name, config] of databases) {
  describe.skipIf(!config)(`hosted projects and pushes on ${name}`, () => {
    let database: Database;
    let workspace: string;
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
      workspace = (await createWorkspace(db(), { key: 'net', name: 'Network' })).id;
    });

    it('a project without a source is hosted: no address to fetch, nothing on a timer', async () => {
      const hosted = await createProject(
        db(),
        workspace,
        { key: 'flows', name: 'Flows', pollSeconds: 60 },
        false,
      );
      expect(hosted).toMatchObject({
        hosted: true,
        gitPath: '/git/net/flows.git',
        gitRef: 'main',
        pollSeconds: 0,
      });
      expect(hosted.gitUrl).toBeUndefined();
      const external = await createProject(
        db(),
        workspace,
        { key: 'core', name: 'Core', gitUrl: 'https://git.example.net/network/core.git' },
        false,
      );
      expect(external).toMatchObject({ hosted: false, gitPath: '/git/net/core.git' });
      expect((await listProjects(db(), workspace)).map((p) => [p.key, p.hosted])).toEqual([
        ['core', false],
        ['flows', true],
      ]);
      // Only the one with a source is ever due.
      expect((await dueProjects(db())).map((p) => p.key)).toEqual(['core']);
    });

    it('a hosted project keeps its repository: no source, no timer; its branch can change', async () => {
      const hosted = await createProject(db(), workspace, { key: 'flows', name: 'Flows' }, false);
      const refused = (change: Parameters<typeof updateProject>[2]) =>
        updateProject(db(), hosted.id, change, false).then(
          () => 'changed',
          (e) => (e instanceof ProjectError ? `${e.code}: ${e.message}` : 'other'),
        );
      expect(await refused({ gitUrl: 'https://git.example.net/x.git' })).toMatch(
        /invalid: The server hosts this project/,
      );
      expect(await refused({ pollSeconds: 60 })).toMatch(/invalid: The server hosts/);
      expect(
        await updateProject(db(), hosted.id, { gitRef: 'release', name: 'Flows 2' }, false),
      ).toMatchObject({ gitRef: 'release', name: 'Flows 2', hosted: true });
    });

    it('keeps who pushed what, newest first, and forgets it with the project', async () => {
      const project = await createProject(db(), workspace, { key: 'flows', name: 'Flows' }, false);
      const dana = { id: 'u1', login: 'dana' };
      await recordPushes(db(), project.id, dana, []);
      expect(await listPushes(db(), project.id)).toEqual([]);
      await recordPushes(db(), project.id, dana, [{ ref: 'main', to: A }]);
      await new Promise((r) => setTimeout(r, 5));
      await recordPushes(db(), project.id, { id: 'u2', login: 'omar' }, [
        { ref: 'main', from: A, to: B },
        { ref: 'try/idea', from: B },
      ]);
      const pushes = await listPushes(db(), project.id);
      expect(pushes.map((p) => [p.login, p.ref, p.from, p.to])).toEqual([
        ['omar', 'main', A, B],
        ['omar', 'try/idea', B, undefined],
        ['dana', 'main', undefined, A],
      ]);
      expect(await listPushes(db(), project.id, 1)).toHaveLength(1);
      await deleteProject(db(), project.id);
      expect(await db().selectFrom('git_push').selectAll().execute()).toEqual([]);
    });
  });
}

describe('hosted projects over the API', () => {
  let database: Database;
  let app: FastifyInstance;
  let git: Git;
  let cookie: string;
  let member: string;

  beforeAll(async () => {
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
    git = new Git({ reposDir: join(root, 'repos'), allowLocal: false });
    const sync = new ProjectSync(database.db, git, log);
    app = buildApp({ log, database, instance: 'test', projects: { git, sync, allowLocal: false } });
    const signIn = async (login: string, admin: boolean) => {
      await createUser(database.db, { login, name: login, password: PASSWORD, admin });
      const reply = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { login, password: PASSWORD },
      });
      return /afs_session=[^;]*/.exec([reply.headers['set-cookie']].flat().join(';'))?.[0] ?? '';
    };
    cookie = await signIn('dana', true);
    member = await signIn('omar', false);
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('is made without a source, has a git address and an empty record of pushes', async () => {
    const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) =>
      app.inject({
        method,
        url,
        headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { payload: JSON.stringify(body) } : {}),
      });
    await call('POST', '/api/v1/workspaces', { key: 'net', name: 'Network' });
    const made = await call('POST', '/api/v1/workspaces/net/projects', {
      key: 'flows',
      name: 'Flows',
    });
    expect(made.statusCode).toBe(201);
    const project = made.json();
    expect(project).toMatchObject({
      hosted: true,
      gitPath: '/git/net/flows.git',
      sync: { state: 'never' },
    });
    // The repository is there to be cloned, empty, starting on the project's branch.
    expect(await git.branches(project.id)).toEqual([]);

    const pushes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/pushes`,
      headers: { cookie: member },
    });
    expect(pushes.statusCode).toBe(200);
    expect(pushes.json()).toEqual([]);
    expect((await call('GET', '/api/v1/projects/nothing/pushes')).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/projects/${project.id}/pushes?limit=0`)).statusCode).toBe(
      400,
    );

    const moved = await call('PATCH', `/api/v1/projects/${project.id}`, {
      gitUrl: 'https://git.example.net/network/flows.git',
    });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().message).toMatch(/The server hosts this project/);
    // Asking it to look is harmless: there is nothing yet.
    const looked = await call('POST', `/api/v1/projects/${project.id}/sync`);
    expect(looked.json()).toMatchObject({ sync: { state: 'never' } });
    expect((await getProject(database.db, project.id))?.commit).toBeUndefined();
  });
});
