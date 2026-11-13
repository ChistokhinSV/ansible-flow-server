// Runs and their queue: the rules on both databases the server supports (PostgreSQL when
// AFS_TEST_POSTGRES_URL is set), and launching over HTTP.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs } from '../../src/server/launch/configs';
import type { PreparedLaunch } from '../../src/server/launch/prepare';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import {
  createProject,
  createWorkspace,
  deleteProject,
  type Project,
} from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { LEASE_MS, MAX_ATTEMPTS, RunQueue } from '../../src/server/runs/queue';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { emptyPeople, emptyWorkspaces } from './helpers/clean';
import { type TestRepo, testRepo } from './helpers/repo';

const PASSWORD = 'correct horse battery staple';
const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const T0 = new Date('2026-11-13T09:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const DANA = { id: 'u-dana', login: 'dana' };

/** A settled launch as AFS-18 makes one, for a project. */
const launchOf = (project: string, inputs: Record<string, unknown> = {}): PreparedLaunch => ({
  config: 'c-1',
  project,
  commit: 'a'.repeat(40),
  ref: 'main',
  flow: { file: 'ping.flow.yaml', key: 'ping', name: 'Ping', version: 1 },
  mode: 'check',
  inputs,
  targets: ['fw-edge-01'],
  credentials: [],
});

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

for (const [name, config] of databases) {
  describe.skipIf(!config)(`the run queue on ${name}`, () => {
    let database: Database;
    let a: string;
    let b: string;
    const db = () => database.db;
    const queue = (limits = { maxRuns: 4, perProject: 1 }) =>
      new RunQueue(db(), database.kind, key, limits);
    /** Queues runs one after another, a millisecond apart, so their order is known. */
    const fill = async (q: RunQueue, projects: string[]) => {
      const runs = [];
      for (const [i, project] of projects.entries())
        runs.push(await q.enqueue(launchOf(project), {}, DANA, 'Nightly', at(i)));
      return runs;
    };

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
      const workspace = (await createWorkspace(db(), { key: 'net', name: 'Network' })).id;
      a = (await createProject(db(), workspace, { key: 'edge', name: 'Edge' }, false)).id;
      b = (await createProject(db(), workspace, { key: 'core', name: 'Core' }, false)).id;
    });

    it('a launch is queued with its number; its inputs are sealed, and shown without secrets', async () => {
      const q = queue();
      const run = await q.enqueue(
        launchOf(a, { devices: ['fw-edge-01'], api_password: 'hunter2-sealed' }),
        { devices: ['fw-edge-01'], api_password: '***' },
        DANA,
        'Nightly',
        T0,
      );
      expect(run).toMatchObject({
        number: 1,
        project: a,
        config: { id: 'c-1', name: 'Nightly' },
        state: 'queued',
        attempts: 0,
        cancelRequested: false,
        requestedBy: DANA,
        inputs: { devices: ['fw-edge-01'], api_password: '***' },
        createdAt: T0.toISOString(),
      });
      expect((await q.enqueue(launchOf(a), {}, DANA, undefined, at(1))).number).toBe(2);
      expect((await q.enqueue(launchOf(b), {}, DANA, undefined, at(2))).number).toBe(1);
      const row = await db()
        .selectFrom('run')
        .selectAll()
        .where('id', '=', run.id)
        .executeTakeFirstOrThrow();
      expect(JSON.stringify(row)).not.toContain('hunter2');
      expect(await q.get(run.id)).toEqual(run);
      expect(await q.get('nothing')).toBeUndefined();
      // The worker gets the inputs in full.
      const job = await q.claim('w1', at(10));
      expect(job?.inputs).toEqual({ devices: ['fw-edge-01'], api_password: 'hunter2-sealed' });
    });

    it('gives out the oldest run that fits the limits, and nothing over them', async () => {
      const q = queue({ maxRuns: 2, perProject: 1 });
      const [a1, a2, b1] = await fill(q, [a, a, b]);
      const first = await q.claim('w1', at(10));
      expect(first?.run).toMatchObject({ id: a1?.id, state: 'running', worker: 'w1', attempts: 1 });
      // The project's next run waits for its turn; the other project's run does not wait for it.
      expect((await q.claim('w2', at(11)))?.run.id).toBe(b1?.id);
      // Two at once on the server: the third waits.
      expect(await q.claim('w3', at(12))).toBeUndefined();
      expect(
        await q.finish(a1?.id as string, first?.token as string, 'succeeded', undefined, at(13)),
      ).toBe(true);
      expect((await q.claim('w3', at(14)))?.run.id).toBe(a2?.id);
      expect(await q.get(a1?.id as string)).toMatchObject({
        state: 'succeeded',
        startedAt: at(13).toISOString(),
        endedAt: at(13).toISOString(),
      });
      expect((await q.get(a1?.id as string))?.worker).toBeUndefined();
    });

    it('a lease is kept by heartbeats with its token, and only while it lasts', async () => {
      const q = queue();
      const [run] = await fill(q, [a]);
      const job = (await q.claim('w1', T0)) as NonNullable<Awaited<ReturnType<RunQueue['claim']>>>;
      const id = run?.id as string;
      expect(job.leaseUntil).toBe(at(LEASE_MS).toISOString());
      expect(await q.heartbeat(id, 'not-the-token', at(1000))).toEqual({ ok: false });
      expect(await q.heartbeat(id, job.token, at(30_000))).toEqual({
        ok: true,
        cancel: false,
        leaseUntil: at(30_000 + LEASE_MS).toISOString(),
      });
      // Past the lease, the worker's word is not taken any more.
      const late = at(30_000 + LEASE_MS + 1);
      expect(await q.heartbeat(id, job.token, late)).toEqual({ ok: false });
      expect(await q.start(id, job.token, late)).toBe(false);
      expect(await q.finish(id, job.token, 'succeeded', undefined, late)).toBe(false);
      expect(await q.finish('nothing', job.token, 'failed')).toBe(false);
    });

    it('a worker that goes away: its run is given out again before it started, lost after', async () => {
      const q = queue({ maxRuns: 4, perProject: 4 });
      const [fresh, started] = await fill(q, [a, a]);
      const j1 = await q.claim('w1', T0);
      const j2 = await q.claim('w1', T0);
      expect(await q.start(started?.id as string, j2?.token as string, at(5))).toBe(true);
      expect(await q.expire(at(LEASE_MS - 1))).toEqual({ requeued: 0, lost: 0, cancelled: 0 });
      expect(await q.expire(at(LEASE_MS))).toEqual({ requeued: 1, lost: 1, cancelled: 0 });
      expect(await q.get(fresh?.id as string)).toMatchObject({ state: 'queued', attempts: 1 });
      expect((await q.get(fresh?.id as string))?.worker).toBeUndefined();
      const lost = await q.get(started?.id as string);
      expect(lost).toMatchObject({ state: 'lost', endedAt: at(LEASE_MS).toISOString() });
      expect(lost?.error).toMatch(/stopped answering while the run was going/);
      // The first worker comes back: it has nothing any more.
      expect(await q.heartbeat(fresh?.id as string, j1?.token as string, at(LEASE_MS + 1))).toEqual(
        { ok: false },
      );

      // Given out MAX_ATTEMPTS times and never started: lost, with the reason.
      let now = LEASE_MS + 10;
      for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
        expect((await q.claim('w2', at(now)))?.run.attempts).toBe(attempt);
        now += LEASE_MS;
        await q.expire(at(now));
      }
      expect(await q.get(fresh?.id as string)).toMatchObject({
        state: 'lost',
        attempts: MAX_ATTEMPTS,
      });
      expect((await q.get(fresh?.id as string))?.error).toMatch(/no worker started it/);
    });

    it('cancels at once what no worker has, and asks the worker for what it has', async () => {
      const q = queue({ maxRuns: 4, perProject: 4 });
      const [queued, going, notStarted] = await fill(q, [a, a, a]);
      expect(await q.cancel(queued?.id as string, 'dana', at(5))).toMatchObject({
        state: 'cancelled',
        cancelRequested: true,
        cancelledBy: 'dana',
        endedAt: at(5).toISOString(),
      });
      const job = await q.claim('w1', at(10));
      expect(job?.run.id).toBe(going?.id);
      await q.start(going?.id as string, job?.token as string, at(11));
      expect(await q.cancel(going?.id as string, 'omar', at(12))).toMatchObject({
        state: 'running',
        cancelRequested: true,
        cancelledBy: 'omar',
      });
      expect(await q.heartbeat(going?.id as string, job?.token as string, at(13))).toMatchObject({
        ok: true,
        cancel: true,
      });
      await q.finish(
        going?.id as string,
        job?.token as string,
        'cancelled',
        'Stopped by omar',
        at(14),
      );
      expect(await q.get(going?.id as string)).toMatchObject({
        state: 'cancelled',
        error: 'Stopped by omar',
      });
      // Asking again, or for a run that ended, changes nothing.
      expect((await q.cancel(going?.id as string, 'dana', at(15)))?.cancelledBy).toBe('omar');
      expect(await q.cancel('nothing', 'dana')).toBeUndefined();

      // Asked to stop before it started, and the worker went away: cancelled, not given out again.
      const other = await q.claim('w2', at(20));
      expect(other?.run.id).toBe(notStarted?.id);
      await q.cancel(notStarted?.id as string, 'dana', at(21));
      expect(await q.expire(at(20 + LEASE_MS))).toEqual({ requeued: 0, lost: 0, cancelled: 1 });
      expect((await q.get(notStarted?.id as string))?.state).toBe('cancelled');
    });

    it('a run waiting for a decision holds no place, and goes on when resumed', async () => {
      const q = queue({ maxRuns: 4, perProject: 1 });
      const [gate, next] = await fill(q, [a, a]);
      const job = await q.claim('w1', at(10));
      await q.start(gate?.id as string, job?.token as string, at(11));
      expect(await q.wait(gate?.id as string, job?.token as string, at(12))).toBe(true);
      expect(await q.get(gate?.id as string)).toMatchObject({
        state: 'waiting',
        startedAt: at(11).toISOString(),
      });
      // The project's place is free while it waits, and its lease is gone.
      const other = await q.claim('w2', at(13));
      expect(other?.run.id).toBe(next?.id);
      expect(await q.heartbeat(gate?.id as string, job?.token as string, at(14))).toEqual({
        ok: false,
      });
      expect(await q.expire(at(10 * LEASE_MS))).toEqual({ requeued: 1, lost: 0, cancelled: 0 });
      expect((await q.get(gate?.id as string))?.state).toBe('waiting');

      expect(await q.resume(gate?.id as string, at(20))).toBe(true);
      expect(await q.resume(gate?.id as string, at(21))).toBe(false);
      const again = await q.claim('w3', at(22));
      expect(again?.run).toMatchObject({
        id: gate?.id,
        attempts: 2,
        startedAt: at(11).toISOString(),
      });
      // Waiting runs can be cancelled at once.
      await q.wait(gate?.id as string, again?.token as string, at(23));
      expect((await q.cancel(gate?.id as string, 'dana', at(24)))?.state).toBe('cancelled');
    });

    it('many workers asking at once get no more than the limits allow', async () => {
      const q = queue({ maxRuns: 3, perProject: 2 });
      await fill(q, [a, a, a, a, b, b, b, b]);
      const jobs = (
        await Promise.all(Array.from({ length: 10 }, (_, i) => q.claim(`w${i}`, at(100))))
      ).filter((j) => j !== undefined);
      expect(jobs).toHaveLength(3);
      expect(new Set(jobs.map((j) => j.run.id)).size).toBe(3);
      const byProject = new Map<string, number>();
      for (const j of jobs) byProject.set(j.run.project, (byProject.get(j.run.project) ?? 0) + 1);
      for (const n of byProject.values()) expect(n).toBeLessThanOrEqual(2);
      // Numbers are given out once each, also when launches come at once.
      const launched = await Promise.all(
        Array.from({ length: 6 }, () => q.enqueue(launchOf(b), {}, DANA)),
      );
      expect(new Set(launched.map((r) => r.number)).size).toBe(6);
    });

    it('lists the newest first, by project and state, a page at a time', async () => {
      const q = queue();
      const runs = await fill(q, [a, b, a, b, a]);
      await q.cancel(runs[0]?.id as string, 'dana', at(50));
      expect((await q.list()).map((r) => r.id)).toEqual(runs.map((r) => r.id).reverse());
      expect((await q.list({ project: a })).map((r) => r.number)).toEqual([3, 2, 1]);
      expect((await q.list({ state: 'cancelled' })).map((r) => r.id)).toEqual([runs[0]?.id]);
      const page = await q.list({ limit: 2 });
      expect(page).toHaveLength(2);
      const next = await q.list({ limit: 2, before: page.at(-1)?.createdAt });
      expect(next.map((r) => r.id)).toEqual([runs[2]?.id, runs[1]?.id]);
      expect(await q.activeCount(a)).toBe(2);
    });

    it('a project with a run going is not deleted; its ended runs go with it', async () => {
      const q = queue();
      const [run] = await fill(q, [a]);
      await expect(deleteProject(db(), a)).rejects.toMatchObject({
        code: 'not_empty',
        message: expect.stringMatching(/Run 1 of the project is still going/),
      });
      await q.cancel(run?.id as string, 'dana');
      await deleteProject(db(), a);
      expect(await q.list({ project: a })).toEqual([]);
    });
  });
}

describe('launching over HTTP', () => {
  const root = mkdtempSync(join(tmpdir(), 'afs-queue-'));
  let database: Database;
  let app: FastifyInstance;
  let source: TestRepo;
  let configId: string;
  let admin: string;
  let member: string;
  let readOnly: string;
  let lines: string[];

  beforeAll(async () => {
    lines = [];
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    const db = database.db;
    await emptyPeople(db);
    source = testRepo({
      'ping.flow.yaml': readFileSync(
        join(__dirname, '../fixtures/hello.flow.yaml'),
        'utf8',
      ).replace('    devices:', '    api_password:\n      type: string\n    devices:'),
    });
    const log = createLogger({ level: 'info', format: 'json', write: (l) => lines.push(l) });
    const git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
    const sync = new ProjectSync(db, git, log);
    app = buildApp({
      log,
      database,
      instance: 'test',
      masterKey: key,
      runs: new RunQueue(db, 'sqlite', key),
      projects: { git, sync, allowLocal: true },
    });
    const workspace = (await createWorkspace(db, { key: 'net', name: 'Network' })).id;
    const made = await createProject(
      db,
      workspace,
      { key: 'edge', name: 'Edge', gitUrl: source.dir, pollSeconds: 0 },
      true,
    );
    const project = (await sync.sync(made.id)) as Project;
    configId = (
      await new LaunchConfigs(db, git).create(project.id, {
        name: 'Ping the edge',
        flowFile: 'ping.flow.yaml',
        inputs: { devices: ['fw-edge-01'] },
      })
    ).id;
    const signIn = async (login: string, isAdmin: boolean) => {
      const user = await createUser(db, { login, name: login, password: PASSWORD, admin: isAdmin });
      const reply = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { login, password: PASSWORD },
      });
      return {
        id: user.id,
        cookie: /afs_session=[^;]*/.exec([reply.headers['set-cookie']].flat().join(';'))?.[0] ?? '',
      };
    };
    const dana = await signIn('dana', true);
    admin = dana.cookie;
    member = (await signIn('omar', false)).cookie;
    readOnly = (await createToken(db, dana.id, { name: 'ro', readOnly: true })).token;
  });
  afterAll(async () => {
    await app.close();
    await database.close();
    source.remove();
    rmSync(root, { recursive: true, force: true });
  });
  const call = (
    method: 'GET' | 'POST',
    url: string,
    options: { cookie?: string; auth?: string; body?: unknown } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.auth ? { authorization: options.auth } : {}),
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
    });

  it('administrators launch; the run is queued, its secret inputs are kept and not shown', async () => {
    const url = `/api/v1/launch-configs/${configId}/launch`;
    const body = { inputs: { api_password: 'S3CR3T-at-launch' } };
    expect((await call('POST', url, { body })).statusCode).toBe(401);
    expect((await call('POST', url, { cookie: member, body })).statusCode).toBe(403);
    expect((await call('POST', url, { auth: `Bearer ${readOnly}`, body })).statusCode).toBe(403);
    const notReady = await call('POST', url, { cookie: admin, body: { inputs: { devices: ' ' } } });
    expect(notReady.statusCode).toBe(422);
    expect(notReady.json().problems[0]).toMatchObject({ field: 'devices' });

    const made = await call('POST', url, { cookie: admin, body });
    expect(made.statusCode).toBe(201);
    const run = made.json();
    expect(run).toMatchObject({
      number: 1,
      state: 'queued',
      config: { id: configId, name: 'Ping the edge' },
      flow: { file: 'ping.flow.yaml', key: 'hello' },
      mode: 'check',
      targets: ['fw-edge-01'],
      requestedBy: { login: 'dana' },
      inputs: { devices: ['fw-edge-01'], api_password: '***' },
    });
    expect(made.body).not.toContain('S3CR3T');
    expect(lines.join('\n')).not.toContain('S3CR3T');
    expect(lines.join('\n')).toContain('Run queued');
    const row = await database.db.selectFrom('run').selectAll().executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain('S3CR3T');

    // Everyone signed in sees runs.
    const list = await call('GET', '/api/v1/runs?state=queued', { cookie: member });
    expect(list.json().map((r: { id: string }) => r.id)).toEqual([run.id]);
    expect(
      (await call('GET', `/api/v1/runs/${run.id}`, { auth: `Bearer ${readOnly}` })).json(),
    ).toMatchObject({ id: run.id });
    expect((await call('GET', '/api/v1/runs/nothing', { cookie: member })).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/runs?state=sleeping', { cookie: member })).statusCode).toBe(
      400,
    );
    expect((await call('GET', '/api/v1/runs')).statusCode).toBe(401);

    // Administrators cancel.
    expect(
      (await call('POST', `/api/v1/runs/${run.id}/cancel`, { cookie: member })).statusCode,
    ).toBe(403);
    const cancelled = await call('POST', `/api/v1/runs/${run.id}/cancel`, { cookie: admin });
    expect(cancelled.statusCode).toBe(202);
    expect(cancelled.json()).toMatchObject({ state: 'cancelled', cancelledBy: 'dana' });
    expect((await call('POST', '/api/v1/runs/nothing/cancel', { cookie: admin })).statusCode).toBe(
      404,
    );
    expect((await call('POST', url, { cookie: admin, body })).json().number).toBe(2);
  });
});
