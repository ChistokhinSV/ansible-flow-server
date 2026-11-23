// AFS-123: a project's history over the API: the commits of a branch a page at a time and filtered
// (message, author, hash, file), one commit's files with flows by title, a flow's commits (flow and
// scenarios files), what a commit did to a flow, and who may read them (ro on the project, or on
// the flow for a flow's own).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { ProjectSync } from '../../src/server/projects/sync';
import { grant } from './helpers/grant';

const root = mkdtempSync(join(tmpdir(), 'afs-history-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const PASSWORD = 'correct horse battery staple';

let database: Database;
let app: FastifyInstance;
let git: Git;
let dana: string;
let omar: string;
let lina: string;
let nina: string;
let project: { id: string; commit: string };
let flow: string;
/** The commits made here, oldest first. */
const made: string[] = [];

function call(cookie: string, method: 'GET' | 'POST', url: string, body?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
}

let tip = '';
async function save(who: string, message: string, changes: unknown[]) {
  const reply = await call(who, 'POST', `/api/v1/projects/${project.id}/files`, {
    base: tip,
    message,
    changes,
  });
  expect(reply.statusCode).toBe(201);
  tip = reply.json().commit;
  made.push(tip);
  return tip;
}

beforeAll(async () => {
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
  git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
  const sync = new ProjectSync(database.db, git, log);
  app = buildApp({ log, database, instance: 'test', projects: { git, sync, allowLocal: true } });
  const signIn = async (login: string, name: string, admin: boolean) => {
    await createUser(database.db, { login, name, password: PASSWORD, admin });
    const reply = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { login, password: PASSWORD },
    });
    return /afs_session=[^;]*/.exec([reply.headers['set-cookie']].flat().join(';'))?.[0] ?? '';
  };
  dana = await signIn('dana', 'Dana Admin', true);
  omar = await signIn('omar', 'Omar Writer', false);
  lina = await signIn('lina', 'Lina Reader', false);
  nina = await signIn('nina', 'Nina Flowonly', false);
  await call(dana, 'POST', '/api/v1/workspaces', { key: 'net', name: 'Network' });
  await grant(database.db, 'net', 'omar', 'rw');
  await grant(database.db, 'net', 'lina', 'ro');
  project = (
    await call(dana, 'POST', '/api/v1/workspaces/net/projects', {
      key: 'flows',
      name: 'Flows',
      sample: 'hello',
    })
  ).json();
  tip = project.commit;
  made.push(tip);
  const listed = (await call(dana, 'GET', `/api/v1/projects/${project.id}/files`)).json();
  flow = listed.files.find((f: { path: string }) => f.path.endsWith('.flow.yaml')).path;
  // Nina may read this one flow only.
  await grant(database.db, 'net', 'nina', 'ro', { project: project.id, file: flow });
  const text = (
    await call(
      dana,
      'GET',
      `/api/v1/projects/${project.id}/files/content?commit=${tip}&path=${encodeURIComponent(flow)}`,
    )
  ).body;
  await save(omar, 'Add the readme', [{ op: 'write', path: 'README.md', text: '# Flows\n' }]);
  await save(omar, 'Rename the flow', [
    { op: 'write', path: flow, text: text.replace(/^(\s*name:\s*).*$/m, '$1Renamed hello') },
  ]);
  await save(omar, 'Add scenarios for the flow', [
    {
      op: 'write',
      path: flow.replace(/\.flow\.yaml$/, '.scenarios.yaml'),
      text: 'scenarios: []\n',
    },
  ]);
  for (let i = 1; i <= 6; i++)
    await save(omar, `Tune the inventory, round ${i}`, [
      { op: 'write', path: 'hosts/lab.ini', text: `[all]\nhost${i}\n` },
    ]);
  await save(omar, 'Drop the flow', [{ op: 'delete', path: flow }]);
});
afterAll(async () => {
  await app.close();
  await database.close();
});

const commits = (who: string, query = '') =>
  call(who, 'GET', `/api/v1/projects/${project.id}/commits${query ? `?${query}` : ''}`);

describe("a project's history", () => {
  it('lists the commits of the branch newest first, a page at a time', async () => {
    const first = (await commits(lina, 'limit=4')).json();
    expect(first.branch).toBe('main');
    expect(first.commit).toBe(tip);
    expect(first.commits.map((c: { commit: string }) => c.commit)).toEqual(
      made.slice(-4).reverse(),
    );
    expect(first.commits[0]).toMatchObject({ author: 'Omar Writer', subject: 'Drop the flow' });
    expect(first.commits[0].at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(first.next).toBe(4);
    // The next page continues the same walk, pinned to the commit the first one read.
    const rest = (await commits(lina, `limit=50&skip=${first.next}&commit=${first.commit}`)).json();
    expect(rest.commits.map((c: { commit: string }) => c.commit)).toEqual(
      made.slice(0, -4).reverse(),
    );
    expect(rest.next).toBeUndefined();
  });

  it('filters by words in the message, the author, a hash or a changed file', async () => {
    const subjects = async (q: string, extra = '') =>
      (await commits(lina, `q=${encodeURIComponent(q)}${extra}`))
        .json()
        .commits.map((c: { subject: string }) => c.subject);
    expect(await subjects('readme')).toEqual(['Add the readme']);
    // Every word, anywhere (as the designer's History filter).
    expect(await subjects('README omar')).toEqual(['Add the readme']);
    expect(await subjects('readme lina')).toEqual([]);
    expect((await subjects('omar')).length).toBe(made.length - 1);
    expect(await subjects((made[1] as string).slice(0, 10))).toEqual(['Add the readme']);
    expect((await subjects('hosts/lab.ini')).length).toBe(6);
    expect(await subjects('nothing like this')).toEqual([]);
    // Filtered pages go on from where the walk stopped.
    const page = (await commits(lina, 'q=round&limit=2')).json();
    expect(page.commits.map((c: { subject: string }) => c.subject)).toEqual([
      'Tune the inventory, round 6',
      'Tune the inventory, round 5',
    ]);
    const next = (
      await commits(lina, `q=round&limit=10&skip=${page.next}&commit=${page.commit}`)
    ).json();
    expect(next.commits.map((c: { subject: string }) => c.subject)).toEqual([
      'Tune the inventory, round 4',
      'Tune the inventory, round 3',
      'Tune the inventory, round 2',
      'Tune the inventory, round 1',
    ]);
  });

  it('reads a long history a budget at a time', async () => {
    const page = await git.log(project.id, tip, { filter: 'readme', limit: 5, budget: 3 });
    expect(page.commits).toEqual([]);
    expect(page.next).toBe(3);
    const later = await git.log(project.id, tip, { filter: 'readme', skip: 3, budget: 100 });
    expect(later.commits.map((c) => c.subject)).toEqual(['Add the readme']);
    expect(later.next).toBeUndefined();
  });

  it("shows a commit's files, flows by their title", async () => {
    const renamed = made[2] as string;
    const one = (
      await call(lina, 'GET', `/api/v1/projects/${project.id}/commits/${renamed}`)
    ).json();
    expect(one).toMatchObject({ commit: renamed, subject: 'Rename the flow', parents: [made[1]] });
    expect(one.files).toEqual([
      { file: flow, change: 'changed', flow: true, title: 'Renamed hello' },
    ]);
    // A removed flow is named as it was.
    const dropped = (
      await call(lina, 'GET', `/api/v1/projects/${project.id}/commits/${tip}`)
    ).json();
    expect(dropped.files).toEqual([
      { file: flow, change: 'removed', flow: true, title: 'Renamed hello' },
    ]);
    // The first commit added everything.
    const first = (
      await call(lina, 'GET', `/api/v1/projects/${project.id}/commits/${project.commit}`)
    ).json();
    expect(first.parents).toEqual([]);
    expect(first.files.every((f: { change: string }) => f.change === 'added')).toBe(true);
    expect(
      (await call(lina, 'GET', `/api/v1/projects/${project.id}/commits/${'0'.repeat(40)}`))
        .statusCode,
    ).toBe(404);
    // AFS-210: the 12 characters the pages show name it too; a wrong id says so.
    const short = (
      await call(lina, 'GET', `/api/v1/projects/${project.id}/commits/${renamed.slice(0, 12)}`)
    ).json();
    expect(short.commit).toBe(renamed);
    const wrong = await call(lina, 'GET', `/api/v1/projects/${project.id}/commits/zzz`);
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json().message).toBe('The project has no commit zzz.');
  });

  it("lists a flow's commits: its flow and scenarios files", async () => {
    const page = (await commits(nina, `path=${encodeURIComponent(flow)}`)).json();
    expect(page.commits.map((c: { subject: string }) => c.subject)).toEqual([
      'Drop the flow',
      'Add scenarios for the flow',
      'Rename the flow',
      expect.any(String),
    ]);
    expect(page.commits[1].files).toEqual([
      { file: flow.replace(/\.flow\.yaml$/, '.scenarios.yaml'), change: 'changed' },
    ]);
    expect((await commits(lina, `path=${encodeURIComponent('README.md')}`)).statusCode).toBe(404);
  });

  it('says what a commit did to a flow, and what to compare it with', async () => {
    const at = (commit: string) =>
      call(
        nina,
        'GET',
        `/api/v1/projects/${project.id}/flows/commit?path=${encodeURIComponent(flow)}&commit=${commit}`,
      );
    expect((await at(project.commit)).json()).toMatchObject({ change: 'added', path: flow });
    expect((await at(project.commit)).json().before).toBeUndefined();
    expect((await at(made[2] as string)).json()).toMatchObject({
      change: 'changed',
      before: made[1],
      author: 'Omar Writer',
      subject: 'Rename the flow',
    });
    expect((await at(made[1] as string)).json().change).toBe('unchanged');
    expect((await at(tip)).json()).toMatchObject({
      change: 'removed',
      before: made.at(-2),
      last: made[2],
    });
  });

  it('finds a commit by the start of its id, refuses one it has not, names the branch of another (AFS-190)', async () => {
    const at = (commit: string) =>
      call(
        nina,
        'GET',
        `/api/v1/projects/${project.id}/flows/commit?path=${encodeURIComponent(flow)}&commit=${commit}`,
      );
    const renamed = made[2] as string;
    // The 12 characters the pages show, and the 7 git shows, find the commit.
    for (const short of [renamed.slice(0, 12), renamed.slice(0, 7)])
      expect((await at(short)).json()).toMatchObject({
        commit: renamed,
        change: 'changed',
        onBranch: true,
      });
    const none = await at('0'.repeat(12));
    expect(none.statusCode).toBe(404);
    expect(none.json().message).toBe('The project has no commit 000000000000.');
    expect((await at('nonsense')).statusCode).toBe(404);
    // A commit only another branch has says which.
    expect(
      (
        await call(dana, 'POST', `/api/v1/projects/${project.id}/branches`, {
          name: 'try',
          from: renamed,
        })
      ).statusCode,
    ).toBeLessThan(300);
    const elsewhere = await call(omar, 'POST', `/api/v1/projects/${project.id}/files`, {
      branch: 'try',
      base: renamed,
      message: 'Try a readme',
      changes: [{ op: 'write', path: 'README.md', text: '# Try\n' }],
    });
    expect(elsewhere.statusCode).toBe(201);
    expect((await at(elsewhere.json().commit)).json()).toMatchObject({
      change: 'unchanged',
      onBranch: false,
      branches: ['try'],
    });
    // A commit without the flow says so, with the commit.
    const without = await call(
      dana,
      'GET',
      `/api/v1/projects/${project.id}/flows/commit?path=flows%2Fnone.flow.yaml&commit=${renamed}`,
    );
    expect(without.statusCode).toBe(404);
    expect(without.json().message).toBe(
      `The flow was not in the project at commit ${renamed.slice(0, 12)}.`,
    );
  });

  it('lists a file moved as renamed, with the path it had (AFS-190)', async () => {
    const moved = await call(omar, 'POST', `/api/v1/projects/${project.id}/files`, {
      base: tip,
      message: 'Move the inventory',
      changes: [{ op: 'move', from: 'hosts/lab.ini', to: 'inventory/lab.ini' }],
    });
    expect(moved.statusCode).toBe(201);
    tip = moved.json().commit;
    made.push(tip);
    const one = (await call(lina, 'GET', `/api/v1/projects/${project.id}/commits/${tip}`)).json();
    expect(one.files).toEqual([
      { file: 'inventory/lab.ini', change: 'renamed', from: 'hosts/lab.ini' },
    ]);
  });

  it('is read by who may read the project; a flow-only grant reads only that flow', async () => {
    expect((await commits(nina)).statusCode).toBe(403);
    expect(
      (await call(nina, 'GET', `/api/v1/projects/${project.id}/commits/${tip}`)).statusCode,
    ).toBe(403);
    expect((await commits(nina, `path=${encodeURIComponent(flow)}`)).statusCode).toBe(200);
    const signedOut = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/commits`,
    });
    expect(signedOut.statusCode).toBe(401);
    expect((await commits(lina, 'branch=nope')).statusCode).toBe(404);
  });
});
