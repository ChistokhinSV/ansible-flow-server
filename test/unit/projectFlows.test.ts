// The flows of a project: found at its commit, summarised, and one of them as the designer
// shows it. The repository is a real one in a folder of this machine.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { FlowError, ProjectFlows } from '../../src/server/projects/flows';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace, type Project } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { grant } from './helpers/grant';
import { type TestRepo, testRepo } from './helpers/repo';

const PASSWORD = 'correct horse battery staple';
const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name), 'utf8');
const root = mkdtempSync(join(tmpdir(), 'afs-flows-'));

let database: Database;
let app: FastifyInstance;
let git: Git;
let sync: ProjectSync;
let source: TestRepo;
let project: Project;
let empty: Project;
let first: string;
let cookie: string;

beforeAll(async () => {
  source = testRepo({
    'flows/firewall-upgrade.flow.yaml': fixture('firewall-upgrade.flow.yaml'),
    'hello.flow.yaml': fixture('hello.flow.yaml'),
    'broken.flow.yaml': 'flow: [this is not\n',
    'newer.flow.yaml': fixture('hello.flow.yaml').replace(
      /^schema_version:.*$/m,
      'schema_version: 99',
    ),
    'inventory/hosts.yaml': 'all: {}\n',
    'README.md': 'Flows of the network team\n',
  });
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
  git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
  sync = new ProjectSync(database.db, git, log);
  app = buildApp({ log, database, instance: 'test', projects: { git, sync, allowLocal: true } });
  const workspace = await createWorkspace(database.db, { key: 'net', name: 'Network' });
  const made = await createProject(
    database.db,
    workspace.id,
    { key: 'core', name: 'Core', gitUrl: source.dir, pollSeconds: 0 },
    true,
  );
  project = (await sync.sync(made.id)) as Project;
  first = project.commit as string;
  empty = await createProject(database.db, workspace.id, { key: 'new', name: 'New' }, true);
  await sync.sync(empty.id);
  await createUser(database.db, { login: 'omar', name: 'Omar', password: PASSWORD });
  await grant(database.db, 'net', 'omar');
  const signIn = await app.inject({
    method: 'POST',
    url: '/api/v1/session',
    payload: { login: 'omar', password: PASSWORD },
  });
  cookie = /afs_session=[^;]*/.exec([signIn.headers['set-cookie']].flat().join(';'))?.[0] ?? '';
});
afterAll(async () => {
  await sync.stop();
  await app.close();
  await database.close();
  source.remove();
  rmSync(root, { recursive: true, force: true });
});

const get = (url: string, signed = true) =>
  app.inject({ method: 'GET', url, headers: signed ? { cookie } : {} });

describe('the flows of a project', () => {
  it('are the *.flow.yaml files at its commit, each with what it is', async () => {
    const flows = new ProjectFlows(git);
    const list = await flows.list(project.id, first);
    expect(list.commit).toBe(first);
    expect(list.flows.map((f) => f.file)).toEqual([
      'broken.flow.yaml',
      'flows/firewall-upgrade.flow.yaml',
      'hello.flow.yaml',
      'newer.flow.yaml',
    ]);
    const byFile = Object.fromEntries(list.flows.map((f) => [f.file, f]));
    expect(byFile['hello.flow.yaml']).toMatchObject({ ok: true, errors: 0 });
    expect(byFile['hello.flow.yaml']?.steps).toBeGreaterThan(0);
    expect(byFile['flows/firewall-upgrade.flow.yaml']).toMatchObject({ ok: true });
    expect(byFile['flows/firewall-upgrade.flow.yaml']?.name).toBeTruthy();
    expect(byFile['broken.flow.yaml']).toMatchObject({ ok: false });
    expect(byFile['broken.flow.yaml']?.problem).toBeTruthy();
    expect(byFile['newer.flow.yaml']?.problem).toMatch(/format 99.*Upgrade the server/);
    // The same commit asked about again is not read again.
    expect(await flows.list(project.id, first)).toBe(list);
    expect(await flows.list(project.id, undefined)).toEqual({ flows: [] });
  });

  it('one flow is what the designer shows: the flow, findings, positions and plays', async () => {
    const flows = new ProjectFlows(git);
    const view = await flows.view(project.id, first, 'flows/firewall-upgrade.flow.yaml');
    expect(view).toMatchObject({ commit: first, file: 'flows/firewall-upgrade.flow.yaml' });
    const { snapshot } = view;
    expect(snapshot.stale).toBe(false);
    expect(snapshot.file).toBe('firewall-upgrade.flow.yaml');
    const nodes = Object.keys(snapshot.doc?.nodes ?? {});
    expect(nodes.length).toBeGreaterThan(3);
    // Every node has a place: from the file, or worked out for the page.
    const placed = new Set([
      ...Object.keys(snapshot.autoPositions),
      ...Object.values(snapshot.doc?.layout ?? {}).flatMap((level) =>
        Object.keys((level as { nodes?: object }).nodes ?? level ?? {}),
      ),
    ]);
    expect(placed.size).toBeGreaterThan(0);
    if (!snapshot.findings.some((f) => f.severity === 'error'))
      expect(Object.keys(snapshot.plays ?? {}).length).toBeGreaterThan(0);
    // It is plain data: what the page gets is what was made.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('says why there is nothing to show', async () => {
    const flows = new ProjectFlows(git);
    const refused = (file: string) =>
      flows.view(project.id, first, file).then(
        () => 'shown',
        (e) => (e instanceof FlowError ? `${e.code}: ${e.message}` : `other: ${e}`),
      );
    expect(await refused('nothing.flow.yaml')).toMatch(/^not_found/);
    expect(await refused('README.md')).toMatch(/^not_found: Not a flow file/);
    expect(await refused('inventory/hosts.yaml')).toMatch(/^not_found/);
    expect(await refused('broken.flow.yaml')).toMatch(/^unreadable/);
    expect(await refused('newer.flow.yaml')).toMatch(/^unreadable: .*Upgrade the server/);
    expect(await refused('../outside.flow.yaml')).toMatch(/other|not_found/);
  });

  it('a new commit is a new list; the old one can still be read', async () => {
    const flows = new ProjectFlows(git);
    source.commit({ 'site/added.flow.yaml': fixture('hello.flow.yaml') }, 'Add a flow');
    const after = (await sync.sync(project.id)) as Project;
    expect(after.commit).not.toBe(first);
    const now = await flows.list(after.id, after.commit);
    expect(now.flows.map((f) => f.file)).toContain('site/added.flow.yaml');
    expect((await flows.list(project.id, first)).flows.map((f) => f.file)).not.toContain(
      'site/added.flow.yaml',
    );
    project = after;
  });
});

describe('flows over the API', () => {
  it('everyone signed in lists and reads them; nobody else', async () => {
    expect((await get(`/api/v1/projects/${project.id}/flows`, false)).statusCode).toBe(401);
    expect(
      (await get(`/api/v1/projects/${project.id}/flows/view?path=hello.flow.yaml`, false))
        .statusCode,
    ).toBe(401);
    const list = await get(`/api/v1/projects/${project.id}/flows`);
    expect(list.statusCode).toBe(200);
    expect(list.json().commit).toBe(project.commit);
    expect(list.json().flows.map((f: { file: string }) => f.file)).toContain('hello.flow.yaml');

    const view = await get(
      `/api/v1/projects/${project.id}/flows/view?path=${encodeURIComponent('flows/firewall-upgrade.flow.yaml')}`,
    );
    expect(view.statusCode).toBe(200);
    expect(view.json().snapshot.doc.flow.key).toBeTruthy();
    expect(view.json().commit).toBe(project.commit);
  });

  it('answers with the reason when there is nothing to show', async () => {
    const view = (path: string) =>
      get(`/api/v1/projects/${project.id}/flows/view?path=${encodeURIComponent(path)}`);
    expect((await view('nothing.flow.yaml')).statusCode).toBe(404);
    const broken = await view('broken.flow.yaml');
    expect(broken.statusCode).toBe(422);
    expect(broken.json().error).toBe('unreadable');
    const newer = await view('newer.flow.yaml');
    expect(newer.statusCode).toBe(422);
    expect(newer.json().message).toMatch(/Upgrade the server/);
    expect((await get(`/api/v1/projects/${project.id}/flows/view`)).statusCode).toBe(400);
    expect((await get('/api/v1/projects/nothing/flows')).statusCode).toBe(404);
    // A hosted project nobody pushed to: no flows, and nothing to view.
    expect((await get(`/api/v1/projects/${empty.id}/flows`)).json()).toEqual({ flows: [] });
    const none = await get(`/api/v1/projects/${empty.id}/flows/view?path=hello.flow.yaml`);
    expect(none.statusCode).toBe(404);
    expect(none.json().message).toMatch(/no commit yet/);
  });
});
