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
      const sync = new ProjectSync(db(), git, log);
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
      expect((await call('omar', 'GET', at())).json()).toHaveLength(1);
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
      expect(after.last).toMatchObject({ result: 'ok', run: run?.id });
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
      expect(handed.json().owner).toEqual({ id: ids.ci, login: 'ci' });
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

    it('goes with its launch configuration', async () => {
      expect((await call('rita', 'DELETE', `/launch-configs/${configId}`)).statusCode).toBe(204);
      expect(await db().selectFrom('schedule').selectAll().execute()).toEqual([]);
    });
  });
}
