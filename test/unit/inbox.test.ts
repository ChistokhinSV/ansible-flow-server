// Home's inbox (AFS-212, ADR-0039 §9 and §10), on both databases the server supports
// (PostgreSQL when AFS_TEST_POSTGRES_URL is set): what needs a person comes from every workspace
// they may see, each item names its workspace and offers only what their level there allows; a
// workspace they may not see adds nothing; the filter and a token made for one workspace narrow
// it; their own runs that wait for others are said but not counted.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Access, createGrant } from '../../src/server/access/grants';
import { buildApp } from '../../src/server/app';
import { openGate } from '../../src/server/approvals/gates';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import type { Inbox, InboxItem } from '../../src/server/inbox/inbox';
import { inboxFor } from '../../src/server/inbox/inbox';
import { LaunchConfigs } from '../../src/server/launch/configs';
import { prepareLaunch, withoutSecrets } from '../../src/server/launch/prepare';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace, type Project } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { RunQueue } from '../../src/server/runs/queue';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { emptyPeople, emptyWorkspaces } from './helpers/clean';
import { type TestRepo, testRepo } from './helpers/repo';

const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const FLOW_FILE = 'flows/change.flow.yaml';
const FLOW = readFileSync(join(__dirname, '../fixtures/approval.flow.yaml'), 'utf8');
const root = mkdtempSync(join(tmpdir(), 'afs-inbox-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

const where = (items: InboxItem[]) =>
  items.map((i) => `${i.kind} ${i.workspace?.key ?? 'server'} ${i.verbs.join(',')}`).sort();

for (const [name, config] of databases) {
  describe.skipIf(!config)(`the inbox on ${name}`, () => {
    let database: Database;
    let app: FastifyInstance;
    let source: TestRepo;
    let sync: ProjectSync;
    let git: Git;
    let queue: RunQueue;
    const projects: Record<string, Project> = {};
    const configs: Record<string, string> = {};
    const ids: Record<string, string> = {};
    const tokens: Record<string, string> = {};
    const db = () => database.db;

    const launch = async (where: string, by: string) => {
      const c = (await new LaunchConfigs(db(), git).get(configs[where] as string)) as NonNullable<
        Awaited<ReturnType<LaunchConfigs['get']>>
      >;
      const prepared = await prepareLaunch({ db: db(), git: git, sync }, c, {});
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.problems));
      return queue.enqueue(
        prepared.launch,
        withoutSecrets(prepared.launch, prepared.form.fields).inputs,
        { id: ids[by] as string, login: by },
        'Change',
      );
    };
    const failed = async (where: string, by: string) => {
      const run = await launch(where, by);
      await db()
        .updateTable('run')
        .set({
          state: 'failed',
          ended_at: new Date().toISOString(),
          error: 'fw-01 did not answer',
        })
        .where('id', '=', run.id)
        .execute();
      return run;
    };
    const waiting = async (where: string, by: string) => {
      const run = await launch(where, by);
      await db().updateTable('run').set({ state: 'waiting' }).where('id', '=', run.id).execute();
      await openGate(db(), {
        run: run.id,
        node: { id: '01JCRBN0000000000000000003', key: 'gate', title: 'Approve the change' },
        segment: 'start',
        carried: {},
      });
      return run;
    };
    const inbox = async (who: string, query = '') => {
      const reply = await app.inject({
        method: 'GET',
        url: `/api/v1/inbox${query}`,
        headers: { authorization: `Bearer ${tokens[who]}` },
      });
      return { status: reply.statusCode, body: reply.json() as Inbox & { error?: string } };
    };

    beforeAll(async () => {
      if (!config) return;
      database = openDatabase(config);
      await migrate(database.db as never);
      await emptyWorkspaces(db());
      await emptyPeople(db());
      const log = createLogger({ level: 'silent', format: 'json', write: () => undefined });
      git = new Git({ reposDir: join(root, `repos-${name}`), allowLocal: true });
      sync = new ProjectSync(db(), git, log);
      queue = new RunQueue(db(), database.kind, key, { maxRuns: 4, perProject: 4 });
      source = testRepo({
        [FLOW_FILE]: FLOW,
        'inventory/hosts.yaml': 'all:\n  hosts:\n    fw-01: {}\n    sw-edge-01: {}\n',
      });
      // Three workspaces of one repository: rita reads net, operates lab and has nothing in ops.
      for (const [ws, project] of [
        ['net', 'edge'],
        ['lab', 'core'],
        ['ops', 'vault'],
      ] as const) {
        const workspace = await createWorkspace(db(), { key: ws, name: `The ${ws} team` });
        ids[ws] = workspace.id;
        const made = await createProject(
          db(),
          workspace.id,
          { key: project, name: project, gitUrl: source.dir, pollSeconds: 0 },
          true,
        );
        projects[ws] = (await sync.sync(made.id)) as Project;
        configs[ws] = (
          await new LaunchConfigs(db(), git).create(made.id, {
            name: 'Change',
            flowFile: FLOW_FILE,
            inventory: 'inventory/hosts.yaml',
            inputs: { devices: ['fw-01'] },
          })
        ).id;
      }
      for (const [login, admin] of [
        ['dana', true],
        ['omar', false],
        ['rita', false],
        ['aria', false],
        ['mia', false],
        ['nina', false],
      ] as const)
        ids[login] = (
          await createUser(db(), { login, name: login, password: 'x'.repeat(12), admin })
        ).id;
      const flowIn = (ws: string) => ({ project: projects[ws]?.id as string, flow: FLOW_FILE });
      await createGrant(db(), ids.net as string, { user: 'rita', level: 'ro' }, 'dana');
      await createGrant(db(), ids.lab as string, { user: 'rita', level: 'operator' }, 'dana');
      await createGrant(
        db(),
        ids.net as string,
        { user: 'omar', level: 'approve', ...flowIn('net') },
        'dana',
      );
      await createGrant(db(), ids.lab as string, { user: 'mia', level: 'rw' }, 'dana');
      await createGrant(db(), ids.lab as string, { user: 'nina', level: 'operator' }, 'dana');
      // aria runs the lab's change as an action, and has no other access.
      await db()
        .insertInto('action_grant')
        .values({
          id: 'g-aria',
          config_id: configs.lab as string,
          principal_type: 'user',
          principal_id: ids.aria as string,
          created_at: new Date().toISOString(),
          created_by: ids.dana as string,
        })
        .execute();
      for (const who of ['dana', 'omar', 'rita', 'aria', 'mia', 'nina'])
        tokens[who] = (await createToken(db(), ids[who] as string, { name: 't' })).token;
      tokens.ritaLab = (
        await createToken(db(), ids.rita as string, { name: 'lab', workspace: ids.lab })
      ).token;
      app = buildApp({
        log,
        database,
        instance: 'test',
        masterKey: key,
        runs: queue,
        projects: { git, sync, allowLocal: true },
      });
      await app.ready();

      // What waits: a paused run of rita's in lab, one of hers at an approval in lab, dana's run at
      // an approval in net, which omar may decide; and rita's failed runs in each workspace.
      const paused = await launch('lab', 'rita');
      await db()
        .updateTable('run')
        .set({
          state: 'running',
          step_json: JSON.stringify({ every: true, points: [], timeoutS: 3600 }),
          step_paused: 'Apply the change',
          view_json: JSON.stringify({
            step: { paused: { since: Math.round(Date.now() / 1000), timeout: 3600 } },
          }),
        })
        .where('id', '=', paused.id)
        .execute();
      await waiting('lab', 'rita');
      await waiting('net', 'dana');
      // Last, as a failed run is done with once its configuration runs again.
      await failed('net', 'rita');
      await failed('lab', 'rita');
      await failed('ops', 'rita');
    });
    afterAll(async () => {
      await app?.close();
      source?.remove();
    });

    it('lists what needs you in every workspace you may see, with what your level there allows', async () => {
      const { status, body } = await inbox('rita');
      expect(status).toBe(200);
      expect(where(body.items)).toEqual([
        // ro in net: open only; operator in lab: run again, step and continue too.
        'failed lab open,runAgain',
        'failed net open',
        'paused lab open,step,continue',
        // Her own run at an approval: said, it is someone else's to decide.
        'request lab open',
      ]);
      // Nothing from ops, where she has no access, though her run failed there too.
      expect(body.items.some((i) => i.workspace?.key === 'ops')).toBe(false);
      // The count covers every workspace, and leaves out what waits for someone else.
      expect(body.count).toBe(3);
      const failedNet = body.items.find((i) => i.kind === 'failed' && i.workspace?.key === 'net');
      expect(failedNet).toMatchObject({
        workspace: { key: 'net', name: 'The net team' },
        project: { key: 'edge' },
        run: { flow: { file: FLOW_FILE }, mode: 'check', config: 'Change' },
        failure: { error: 'fw-01 did not answer' },
      });
      const paused = body.items.find((i) => i.kind === 'paused');
      expect(paused?.pause?.before).toBe('Apply the change');
      expect(Date.parse(paused?.pause?.stopsAt ?? '') - Date.now()).toBeGreaterThan(3500_000);
    });

    it('offers an approval to who may decide it, named by its workspace', async () => {
      const { body } = await inbox('omar');
      expect(where(body.items)).toEqual(['approval net review']);
      expect(body.count).toBe(1);
      expect(body.items[0]).toMatchObject({
        title: expect.stringContaining('Approve the change'),
        approval: { step: 'Approve the change', requestedBy: 'dana' },
      });
    });

    it('narrows to one workspace when asked, and to a token’s workspace always', async () => {
      const lab = await inbox('rita', '?workspace=lab');
      expect(where(lab.body.items)).toEqual([
        'failed lab open,runAgain',
        'paused lab open,step,continue',
        'request lab open',
      ]);
      expect(lab.body.count).toBe(2);
      // The day's numbers are of that workspace too: rita's three runs in lab, not dana's in net.
      expect(lab.body.today).toMatchObject({ runs: 3, failed: 1, waiting: 1, paused: 1 });
      expect((await inbox('rita')).body.today).toMatchObject({ runs: 5, failed: 2, waiting: 2 });
      // A workspace she may not see is not said to be there, as one that does not exist.
      expect(await inbox('rita', '?workspace=ops')).toMatchObject({
        status: 404,
        body: { error: 'not_found' },
      });
      expect((await inbox('rita', '?workspace=nowhere')).status).toBe(404);
      const scoped = await inbox('ritaLab');
      expect(where(scoped.body.items)).toEqual(where(lab.body.items));
      expect(await inbox('ritaLab', '?workspace=net')).toMatchObject({
        status: 403,
        body: { error: 'out_of_scope' },
      });
    });

    it('a failed run is done with once its configuration runs again', async () => {
      const before = await inbox('rita', '?workspace=net');
      expect(before.body.items.map((i) => i.kind)).toEqual(['failed']);
      await launch('net', 'dana');
      const after = await inbox('rita', '?workspace=net');
      expect(after.body.items).toEqual([]);
    });

    it('tells an action-only person of their own runs, opened as the action’s progress', async () => {
      const run = await failed('lab', 'aria');
      const { body } = await inbox('aria');
      expect(body.items).toEqual([
        expect.objectContaining({
          kind: 'failed',
          workspace: expect.objectContaining({ key: 'lab' }),
          verbs: ['open'],
          run: expect.objectContaining({ id: run.id, asRunner: true }),
        }),
      ]);
      // It was the newest run of lab's configuration: rita's failed one there is done with.
      expect(where((await inbox('rita', '?workspace=lab')).body.items)).toEqual([
        'paused lab open,step,continue',
        'request lab open',
      ]);
    });

    it('lists a draft you changed and nobody saved, with who else is in it and whether the flow moved on', async () => {
      const project = projects.lab as Project;
      const at = new Date().toISOString();
      await db()
        .insertInto('flow_draft')
        .values({
          id: 'd1',
          project_id: project.id,
          file: FLOW_FILE,
          base_commit: project.commit as string,
          text: FLOW,
          revision: 2,
          created_by: ids.mia as string,
          created_at: at,
          updated_at: at,
        })
        .execute();
      for (const [n, who] of [
        [1, 'mia'],
        [2, 'dana'],
      ] as const)
        await db()
          .insertInto('flow_draft_edit')
          .values({
            id: `e${n}`,
            draft_id: 'd1',
            revision: n,
            user_id: ids[who] as string,
            kind: 'command',
            before_text: FLOW,
            after_text: FLOW,
            files_json: null,
            undone: 0,
            at,
          })
          .execute();
      const draftOf = async (who: string) =>
        (await inbox(who, '?workspace=lab')).body.items.find((i) => i.kind === 'draft');
      expect(await draftOf('mia')).toMatchObject({
        verbs: ['openDraft'],
        draft: {
          id: 'd1',
          file: FLOW_FILE,
          flow: 'Engine test · approval segments',
          others: ['dana'],
          behind: false,
        },
      });
      // rita did not change it (and could not: it needs rw).
      expect(await draftOf('rita')).toBeUndefined();
      // The flow changes on the branch: the draft began before.
      source.commit({ [FLOW_FILE]: `${FLOW}\n` }, 'Tidy the change flow');
      await sync.sync(project.id);
      // Home asks again and again: what the branch changed between two commits is asked of git once.
      const asked = vi.spyOn(git, 'changedFiles');
      expect((await draftOf('mia'))?.draft?.behind).toBe(true);
      expect((await draftOf('mia'))?.draft?.behind).toBe(true);
      expect(asked.mock.calls.length).toBeLessThanOrEqual(1);
      asked.mockRestore();

      // Drafts on flows she may no longer change, newer than hers in lab, do not hide it.
      for (let n = 0; n < 25; n++) {
        const id = `gone-${n}`;
        const later = new Date(Date.now() + (n + 1) * 1000).toISOString();
        await db()
          .insertInto('flow_draft')
          .values({
            id,
            project_id: (projects.net as Project).id,
            file: `flows/other-${n}.flow.yaml`,
            base_commit: (projects.net as Project).commit as string,
            text: FLOW,
            revision: 1,
            created_by: ids.mia as string,
            created_at: later,
            updated_at: later,
          })
          .execute();
        await db()
          .insertInto('flow_draft_edit')
          .values({
            id: `edit-${id}`,
            draft_id: id,
            revision: 1,
            user_id: ids.mia as string,
            kind: 'command',
            before_text: FLOW,
            after_text: FLOW,
            files_json: null,
            undone: 0,
            at: later,
          })
          .execute();
      }
      const all = await inbox('mia');
      expect(all.body.items.filter((i) => i.kind === 'draft').map((i) => i.draft?.id)).toEqual([
        'd1',
      ]);
    });

    it('tells administrators, and only them, that the certificate ends soon', async () => {
      const request = {} as FastifyRequest;
      const certificate = () => ({
        subject: 'flows.example.com',
        issuer: 'Example CA',
        names: ['flows.example.com'],
        notBefore: '2026-01-01T00:00:00.000Z',
        notAfter: new Date(Date.now() + 12 * 86_400_000).toISOString(),
        daysLeft: 12,
        selfSigned: false,
        fingerprint: 'AA:BB',
        chain: 1,
      });
      const deps = { db: db(), queue, approvals: { waiting: async () => [] }, certificate };
      const asker = async (login: string, admin: boolean) => ({
        id: ids[login] as string,
        login,
        admin,
        access: await Access.of(db(), { id: ids[login] as string, admin }),
        granted: new Set<string>(),
        since: new Date(Date.now() - 3_600_000),
      });
      const dana = await inboxFor(deps, request, await asker('dana', true));
      expect(dana.items.find((i) => i.kind === 'certificate')).toMatchObject({
        title: 'The server certificate ends in 12 days',
        verbs: ['replace'],
        certificate: { daysLeft: 12, names: ['flows.example.com'] },
      });
      expect(dana.items.find((i) => i.kind === 'certificate')?.workspace).toBeUndefined();
      const rita = await inboxFor(deps, request, await asker('rita', false));
      expect(rita.items.some((i) => i.kind === 'certificate')).toBe(false);
      // Nor in an inbox of one workspace: it is not any workspace's.
      const one = await inboxFor(deps, request, { ...(await asker('dana', true)), only: ids.lab });
      expect(one.items.some((i) => i.kind === 'certificate')).toBe(false);
    });

    it('asks for a day, never more than a week back', async () => {
      const back = (days: number) =>
        `?since=${encodeURIComponent(new Date(Date.now() - days * 86_400_000).toISOString())}`;
      expect((await inbox('rita', back(6))).status).toBe(200);
      expect(await inbox('rita', back(8))).toMatchObject({
        status: 400,
        body: { error: 'invalid', field: 'since' },
      });
      expect((await inbox('rita', '?since=1970-01-01T00:00:00Z')).status).toBe(400);
    });

    it('many newer failed runs never push out a paused one, and every one of them is counted', async () => {
      // nina's paused run first, then 65 failed runs of flows run without a configuration.
      const run = await launch('lab', 'nina');
      await db()
        .updateTable('run')
        .set({ state: 'running', step_json: '{"every":true,"points":[]}', step_paused: 'Apply' })
        .where('id', '=', run.id)
        .execute();
      const row = await db()
        .selectFrom('run')
        .selectAll()
        .where('id', '=', run.id)
        .executeTakeFirstOrThrow();
      for (let n = 1; n <= 65; n++) {
        const at = new Date(Date.now() + n * 1000).toISOString();
        await db()
          .insertInto('run')
          .values({
            ...row,
            id: `nina-failed-${n}`,
            number: 9000 + n,
            config_id: null,
            config_name: null,
            flow_file: `flows/f${n}.flow.yaml`,
            state: 'failed',
            step_json: null,
            step_paused: null,
            created_at: at,
            updated_at: at,
            ended_at: at,
          })
          .execute();
      }
      const { body } = await inbox('nina');
      expect(body.items.filter((i) => i.kind === 'paused').map((i) => i.run?.id)).toEqual([run.id]);
      // The list shows a few; the count says them all.
      expect(body.items.filter((i) => i.kind === 'failed')).toHaveLength(20);
      expect(body.count).toBe(66);
    });

    it('counts the runners of the whole server, the runs she may not see too', async () => {
      const count = async (state: string) =>
        (await db().selectFrom('run').select('id').where('state', '=', state).execute()).length;
      const { body } = await inbox('rita');
      // nina's paused run is not rita's to see; it holds a runner all the same.
      expect(body.runners).toEqual({
        busy: await count('running'),
        slots: 4,
        queued: await count('queued'),
      });
      expect(body.runners.busy).toBe(2);
    });
  });
}
