// Schedules (AFS-34), on both databases the server supports (PostgreSQL when AFS_TEST_POSTGRES_URL
// is set): who may make one (rw on the flow) and what is refused (a cron that cannot be read or
// fires too often, an unknown time zone, a secret input); the next times; firing: a run queued as
// the owner with the newest commit, the next time moved on, a fire skipped while the last run goes,
// a missed fire skipped or run once, an owner who lost the flow refused, a one-time schedule that
// ends; handing a schedule to a service account (administrators only); gone with its configuration.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGrant } from '../../src/server/access/grants';
import { buildApp } from '../../src/server/app';
import { listAudit } from '../../src/server/audit/store';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs } from '../../src/server/launch/configs';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace, getProject } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { RunQueue } from '../../src/server/runs/queue';
import { Schedules } from '../../src/server/schedules/schedules';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { emptyPeople, emptyWorkspaces } from './helpers/clean';
import { type TestRepo, testRepo } from './helpers/repo';

const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
// The Hello sample with an optional secret-looking input.
const HELLO = readFileSync(join(__dirname, '../fixtures/hello.flow.yaml'), 'utf8').replace(
  '      targets: true\n',
  '      targets: true\n    api_password:\n      type: string\n',
);
const root = mkdtempSync(join(tmpdir(), 'afs-schedules-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

for (const [name, config] of databases) {
  describe.skipIf(!config)(`schedules on ${name}`, () => {
    let database: Database;
    let app: FastifyInstance;
    let schedules: Schedules;
    let sync: ProjectSync;
    let source: TestRepo;
    let project: string;
    let workspace: string;
    let configId: string;
    let commit: string;
    const tokens: Record<string, string> = {};
    const ids: Record<string, string> = {};
    const db = () => database.db;
    const call = (
      who: string,
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: string,
      body?: object,
    ) =>
      app.inject({
        method,
        url: `/api/v1${url}`,
        headers: {
          authorization: `Bearer ${tokens[who]}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { payload: JSON.stringify(body) } : {}),
      });
    const at = (url = '') => `/launch-configs/${configId}/schedules${url}`;
    /** Makes a schedule due as if `minutes` ago. */
    const due = (id: string, minutes = 0) =>
      db()
        .updateTable('schedule')
        .set({ next_at: new Date(Date.now() - minutes * 60_000 - 1000).toISOString() })
        .where('id', '=', id)
        .execute();
    const runsOf = (schedule: string) =>
      db().selectFrom('run').selectAll().where('schedule_id', '=', schedule).execute();

    beforeAll(async () => {
      if (!config) return;
      database = openDatabase(config);
      await migrate(database.db as never);
      await emptyWorkspaces(db());
      await emptyPeople(db());
      await db().deleteFrom('schedule').execute();
      const log = createLogger({ level: 'silent', format: 'json', write: () => undefined });
      const git = new Git({ reposDir: join(root, `repos-${name}`), allowLocal: true });
      sync = new ProjectSync(db(), git, log);
      source = testRepo({
        'flows/hello.flow.yaml': HELLO,
        'inventory/hosts.yaml': 'all:\n  hosts:\n    fw-edge-01: {}\n',
      });
      const ws = await createWorkspace(db(), { key: 'net', name: 'Network' });
      workspace = ws.id;
      project = (
        await createProject(
          db(),
          ws.id,
          { key: 'edge', name: 'Edge', gitUrl: source.dir, pollSeconds: 0 },
          true,
        )
      ).id;
      await sync.sync(project);
      commit = (await getProject(db(), project))?.commit as string;
      configId = (
        await new LaunchConfigs(db(), git).create(project, {
          name: 'Hello nightly',
          flowFile: 'flows/hello.flow.yaml',
          inventory: 'inventory/hosts.yaml',
          inputs: { devices: ['fw-edge-01'] },
        })
      ).id;
      // dana administers; rita may change the flow; omar operates it; ci is a service account.
      await createUser(db(), {
        login: 'dana',
        name: 'Dana',
        password: 'x'.repeat(12),
        admin: true,
      });
      for (const login of ['rita', 'omar'])
        await createUser(db(), { login, name: login, password: 'x'.repeat(12) });
      await createUser(db(), { login: 'ci', name: 'CI', service: true });
      await createGrant(db(), ws.id, { user: 'rita', level: 'rw' }, 'test');
      await createGrant(db(), ws.id, { user: 'omar', level: 'operator' }, 'test');
      await createGrant(db(), ws.id, { user: 'ci', level: 'operator' }, 'test');
      for (const u of await db().selectFrom('user_account').select(['id', 'login']).execute()) {
        ids[u.login] = u.id;
        tokens[u.login] = (await createToken(db(), u.id, { name: 't' })).token;
      }
      const queue = new RunQueue(db(), database.kind, key, { maxRuns: 4, perProject: 4 });
      schedules = new Schedules({ db: db(), git, sync, queue, log });
      app = buildApp({
        log,
        database,
        instance: 'test',
        masterKey: key,
        runs: queue,
        projects: { git, sync, allowLocal: true },
        schedules,
      });
    });
    afterAll(async () => {
      await app?.close();
      await database?.close();
      source?.remove();
    });

    it('rw on the flow makes one; what cannot run unattended is refused at its field', async () => {
      expect(
        (await call('omar', 'POST', at(), { name: 'x', kind: 'cron', cron: '0 3 * * *' }))
          .statusCode,
      ).toBe(403);
      const refused = async (body: object) =>
        (await call('rita', 'POST', at(), { name: 'x', kind: 'cron', ...body })).json();
      expect(await refused({ cron: 'every night' })).toMatchObject({ field: 'cron' });
      expect(await refused({ cron: '* * * * * *' })).toMatchObject({ field: 'cron' });
      expect(await refused({ cron: '0 3 * * *', timezone: 'Mars/Olympus' })).toMatchObject({
        field: 'timezone',
      });
      expect(
        await refused({ cron: '0 3 * * *', inputs: { api_password: 'hunter2hunter2' } }),
      ).toMatchObject({
        field: 'inputs.api_password',
      });
      expect(
        await refused({ kind: 'once', onceAt: new Date(Date.now() - 60_000).toISOString() }),
      ).toMatchObject({ field: 'onceAt' });

      const made = await call('rita', 'POST', at(), {
        name: 'Weekdays at three',
        kind: 'cron',
        cron: '0 3 * * 1-5',
        timezone: 'Europe/Berlin',
      });
      expect(made.statusCode).toBe(201);
      const s = made.json();
      expect(s).toMatchObject({
        owner: { login: 'rita' },
        missed: 'once',
        overlap: 'skip',
        enabled: true,
      });
      expect(s.upcoming).toHaveLength(3);
      // Three in Berlin is 01:00 or 02:00 UTC, on a weekday.
      for (const t of s.upcoming as string[]) {
        const d = new Date(t);
        expect([1, 2]).toContain(d.getUTCHours());
        expect([0, 6]).not.toContain(new Date(d.getTime() + 3 * 3_600_000).getUTCDay());
      }
      const listed = (await call('omar', 'GET', at())).json();
      expect(listed).toHaveLength(1);
      // AFS-153: the owner by name too, for the pages.
      expect(listed[0].owner).toMatchObject({ login: 'rita', name: 'rita' });
      const times = (
        await call(
          'omar',
          'GET',
          `/schedule-times?cron=${encodeURIComponent('30 6 * * *')}&timezone=UTC`,
        )
      ).json();
      expect(times.times[0]).toMatch(/T06:30:00\.000Z$/);
    });

    it('fires as its owner with the newest commit, then skips while that run goes', async () => {
      const s = (await call('rita', 'GET', at())).json()[0];
      await due(s.id);
      expect(await schedules.tick()).toBe(1);
      const [run] = await runsOf(s.id);
      expect(run).toMatchObject({
        requested_login: 'rita',
        commit_id: commit,
        state: 'queued',
        mode: 'check',
      });
      const after = (await call('rita', 'GET', at())).json()[0];
      // AFS-139: the run it launched as it stands now, not only the words of the fire.
      expect(after.last).toMatchObject({
        result: 'ok',
        run: run?.id,
        runNumber: run?.number,
        runState: 'queued',
      });
      await db()
        .updateTable('run')
        .set({ state: 'succeeded' })
        .where('id', '=', run?.id as string)
        .execute();
      expect((await call('rita', 'GET', at())).json()[0].last.runState).toBe('succeeded');
      await db()
        .updateTable('run')
        .set({ state: 'queued' })
        .where('id', '=', run?.id as string)
        .execute();
      expect(Date.parse(after.next)).toBeGreaterThan(Date.now());
      expect((await call('rita', 'GET', `/runs/${run?.id}`)).json()).toMatchObject({
        schedule: s.id,
      });

      await due(s.id);
      await schedules.tick();
      expect(await runsOf(s.id)).toHaveLength(1);
      expect((await call('rita', 'GET', at())).json()[0].last).toMatchObject({
        result: 'skipped',
        detail: `Run ${run?.number} has not ended`,
      });
      // The queue lets it go: queue another behind it.
      await call('rita', 'PATCH', at(`/${s.id}`), { overlap: 'queue' });
      await due(s.id);
      await schedules.tick();
      expect(await runsOf(s.id)).toHaveLength(2);
    });

    it('a missed fire is skipped or run once; an owner who lost the flow is refused', async () => {
      const s = (await call('rita', 'GET', at())).json()[0];
      await call('rita', 'PATCH', at(`/${s.id}`), { missed: 'skip' });
      await due(s.id, 30);
      await schedules.tick();
      expect(await runsOf(s.id)).toHaveLength(2);
      expect((await call('rita', 'GET', at())).json()[0].last.result).toBe('skipped');
      await call('rita', 'PATCH', at(`/${s.id}`), { missed: 'once' });
      await due(s.id, 30);
      await schedules.tick();
      expect(await runsOf(s.id)).toHaveLength(3);

      await db()
        .deleteFrom('access_grant')
        .where('principal_type', '=', 'user')
        .where('principal_id', '=', ids.rita as string)
        .execute();
      await due(s.id);
      await schedules.tick();
      expect(await runsOf(s.id)).toHaveLength(3);
      expect((await call('dana', 'GET', at())).json()[0].last).toMatchObject({
        result: 'refused',
        detail: expect.stringMatching(/rita may no longer launch/),
      });
      const audit = (await listAudit(db(), { action: 'schedule.fire' })).entries;
      expect(audit[0]).toMatchObject({ actor: { login: 'rita' }, result: 'refused' });
    });

    it('an administrator hands it to a service account; a one-time schedule fires once', async () => {
      const s = (await call('dana', 'GET', at())).json()[0];
      expect((await call('dana', 'PATCH', at(`/${s.id}`), { owner: ids.omar })).statusCode).toBe(
        400,
      );
      const handed = await call('dana', 'PATCH', at(`/${s.id}`), { owner: ids.ci });
      expect(handed.json().owner).toEqual({ id: ids.ci, login: 'ci', name: 'CI' });
      await createGrant(db(), workspace, { user: 'rita', level: 'rw' }, 'test');
      // rita may change the schedule, not hand it on.
      expect((await call('rita', 'PATCH', at(`/${s.id}`), { owner: ids.rita })).statusCode).toBe(
        403,
      );
      await due(s.id);
      await schedules.tick();
      expect((await runsOf(s.id)).at(-1)?.requested_login).toBe('ci');

      const once = (
        await call('rita', 'POST', at(), {
          name: 'Once, soon',
          kind: 'once',
          onceAt: new Date(Date.now() + 3_600_000).toISOString(),
          mode: 'check',
        })
      ).json();
      expect(once.upcoming).toEqual([once.onceAt]);
      await due(once.id);
      await schedules.tick();
      expect(await runsOf(once.id)).toHaveLength(1);
      const ended = (await call('rita', 'GET', at()))
        .json()
        .find((x: { id: string }) => x.id === once.id);
      expect(ended).toMatchObject({ enabled: false, upcoming: [] });
      expect(ended.next).toBeUndefined();
    });

    it('fires at its time, not at the next half-minute look (AFS-139)', async () => {
      const soon = (
        await call('rita', 'POST', at(), {
          name: 'Once, in a moment',
          kind: 'once',
          onceAt: new Date(Date.now() + 1500).toISOString(),
          mode: 'check',
          overlap: 'queue',
        })
      ).json();
      // A round of a minute: only the look at the schedule's own time fires it in this test.
      schedules.start(60_000);
      try {
        const until = Date.now() + 5000;
        while ((await runsOf(soon.id)).length === 0 && Date.now() < until)
          await new Promise((r) => setTimeout(r, 100));
        const [run] = await runsOf(soon.id);
        expect(run).toBeDefined();
        expect(Date.parse(run?.created_at as string) - Date.parse(soon.onceAt)).toBeLessThan(1500);
      } finally {
        await schedules.stop();
      }
    });

    it('AFS-150: the live check says a wrong zone and a wrong cron at once, without refusing', async () => {
      const r = await call(
        'omar',
        'GET',
        `/schedule-times?cron=${encodeURIComponent('61 * * * *')}&timezone=Mars/Base&check=1`,
      );
      expect(r.statusCode).toBe(200);
      const { times, problems } = r.json();
      expect(times).toEqual([]);
      expect(problems.map((p: { field: string }) => p.field)).toEqual(['timezone', 'cron']);
      // Without check=1 a wrong one is still refused.
      expect(
        (await call('omar', 'GET', `/schedule-times?cron=61+*+*+*+*&timezone=UTC`)).statusCode,
      ).toBe(400);
    });

    it('AFS-170: a fire whose flow has errors keeps them, each with its step', async () => {
      const s = (
        await call('rita', 'POST', at(), {
          name: 'Every half hour',
          kind: 'cron',
          cron: '30 * * * *',
          timezone: 'UTC',
          mode: 'check',
        })
      ).json();
      source.commit(
        { 'flows/hello.flow.yaml': HELLO.replace('key: facts', 'key: ping') },
        'Two steps with one key',
      );
      await due(s.id);
      await schedules.tick();
      const after = (await call('rita', 'GET', at()))
        .json()
        .find((x: { id: string }) => x.id === s.id);
      expect(after.last).toMatchObject({ result: 'failed' });
      expect(after.last.detail).toMatch(/^The flow has \d+ errors?/);
      expect(after.last.errors.length).toBeGreaterThan(0);
      expect(after.last.errors[0]).toMatchObject({
        node: expect.any(String),
        step: expect.any(String),
      });
      expect(await runsOf(s.id)).toEqual([]);
      source.commit({ 'flows/hello.flow.yaml': HELLO }, 'One key each again');
      // The next fire runs it, and the errors go.
      await due(s.id);
      await schedules.tick();
      const fixed = (await call('rita', 'GET', at()))
        .json()
        .find((x: { id: string }) => x.id === s.id);
      expect(fixed.last).toMatchObject({ result: 'ok' });
      expect(fixed.last.errors).toBeUndefined();
      expect((await call('rita', 'DELETE', at(`/${s.id}`))).statusCode).toBe(204);
    });

    it('AFS-150: a schedule whose flow is gone is turned off at its fire, saying why', async () => {
      const s = (
        await call('rita', 'POST', at(), {
          name: 'Every hour',
          kind: 'cron',
          cron: '0 * * * *',
          timezone: 'UTC',
          mode: 'check',
        })
      ).json();
      expect(s.enabled).toBe(true);
      source.commit({ 'flows/hello.flow.yaml': null }, 'Delete the flow');
      await due(s.id);
      await schedules.tick();
      const after = (await call('rita', 'GET', at()))
        .json()
        .find((x: { id: string }) => x.id === s.id);
      expect(after).toMatchObject({ enabled: false, upcoming: [] });
      expect(after.last).toMatchObject({ result: 'failed' });
      expect(after.last.detail).toMatch(/There is no flow flows\/hello\.flow\.yaml .*turned off/);
      expect(await runsOf(s.id)).toEqual([]);
    });

    it('AFS-187: a flow with errors, or gone, does not stop pausing or changing a schedule', async () => {
      source.commit({ 'flows/hello.flow.yaml': HELLO }, 'The flow back');
      await sync.sync(project);
      const s = (
        await call('rita', 'POST', at(), {
          name: 'Every quarter',
          kind: 'cron',
          cron: '15 * * * *',
          timezone: 'UTC',
          mode: 'check',
        })
      ).json();
      source.commit(
        { 'flows/hello.flow.yaml': HELLO.replace('key: facts', 'key: ping') },
        'Two steps with one key',
      );
      // The fire looks at the source: the server knows the commit with the errors.
      await due(s.id);
      await schedules.tick();
      const paused = await call('rita', 'PATCH', at(`/${s.id}`), { enabled: false });
      expect(paused.statusCode, paused.body).toBe(200);
      expect(paused.json()).toMatchObject({ enabled: false, upcoming: [] });
      const changed = await call('rita', 'PATCH', at(`/${s.id}`), { cron: '0 4 * * *' });
      expect(changed.statusCode, changed.body).toBe(200);
      // Turned on again it would fail at once: refused, saying why, as a new one is.
      const resumed = await call('rita', 'PATCH', at(`/${s.id}`), { enabled: true });
      expect(resumed.statusCode).toBe(400);
      expect(resumed.json().message).toMatch(/^The flow has \d+ errors?/);
      expect(resumed.json().field).toBeUndefined();
      // What the schedule itself says is still checked.
      const wrong = await call('rita', 'PATCH', at(`/${s.id}`), { commit: 'abcdef1' });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().field).toBe('commit');
      // A refused change names only the fields it asked to change.
      const refusals = (await listAudit(db(), { action: 'schedule.change' })).entries.filter(
        (e) => e.result === 'refused',
      );
      expect(refusals[0]?.detail?.changed).toEqual(['commit']);

      // The configuration's other settings save; its flow cannot change to one that cannot run.
      const lc = `/launch-configs/${configId}`;
      const described = await call('rita', 'PATCH', lc, { description: 'Nightly hello' });
      expect(described.statusCode, described.body).toBe(200);
      expect(described.json().description).toBe('Nightly hello');
      const moved = await call('rita', 'PATCH', lc, {
        name: 'Hello nightly',
        description: 'Moved',
        flowFile: 'flows/nope.flow.yaml',
      });
      expect(moved.statusCode).toBe(400);
      const lcRefused = (await listAudit(db(), { action: 'launch-config.change' })).entries.find(
        (e) => e.result === 'refused',
      );
      expect(lcRefused?.detail?.changed).toEqual(['description', 'flowFile']);

      // Its flow gone: still paused, changed and deleted.
      source.commit({ 'flows/hello.flow.yaml': null }, 'Delete the flow');
      await due(s.id);
      await schedules.tick();
      const renamed = await call('rita', 'PATCH', at(`/${s.id}`), { name: 'Every quarter, off' });
      expect(renamed.statusCode, renamed.body).toBe(200);
      const kept = await call('rita', 'PATCH', lc, { description: 'Its flow is gone' });
      expect(kept.statusCode, kept.body).toBe(200);
      expect((await call('rita', 'DELETE', at(`/${s.id}`))).statusCode).toBe(204);
    });

    it('goes with its launch configuration', async () => {
      expect((await call('rita', 'DELETE', `/launch-configs/${configId}`)).statusCode).toBe(204);
      expect(await db().selectFrom('schedule').selectAll().execute()).toEqual([]);
    });
  });
}
