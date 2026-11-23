// AFS-175: actions (ADR-0036). A launch configuration marked as an action, a person whose only
// access is that action, an operator, a group's grant, approvals that still apply, inputs that are
// not asked, and the audit log. On both databases (PostgreSQL when AFS_TEST_POSTGRES_URL is set).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGrant } from '../../src/server/access/grants';
import { progressOf } from '../../src/server/actions/progress';
import { fillAction, hostProblem, hostsOf } from '../../src/server/actions/store';
import { buildApp } from '../../src/server/app';
import { openGate } from '../../src/server/approvals/gates';
import { createToken } from '../../src/server/auth/tokens';
import { createGroup, createUser, setMembers } from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs } from '../../src/server/launch/configs';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace, type Project } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { RunQueue } from '../../src/server/runs/queue';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { emptyPeople, emptyWorkspaces } from './helpers/clean';
import { type TestRepo, testRepo } from './helpers/repo';

const PASSWORD = 'correct horse battery staple';
const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name), 'utf8');
// Hello with two more inputs: a number the action keeps fixed, and a secret-looking one.
const EDGE = fixture('hello.flow.yaml').replace(
  '    devices:',
  '    api_password:\n      type: string\n    retries:\n      type: integer\n      default: 2\n    devices:',
);
const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const root = mkdtempSync(join(tmpdir(), 'afs-actions-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

/** dana administrator, wanda rw, otto operator, rita ro, mia only the action, gail through a group, nobody nothing. */
const PEOPLE = ['dana', 'wanda', 'otto', 'rita', 'mia', 'gail', 'nobody', 'approver'] as const;
type Person = (typeof PEOPLE)[number];

describe('filling an action (the seam AFS-176 links use)', () => {
  const fields = [
    {
      name: 'devices',
      label: 'Switch',
      type: 'host_list',
      required: true,
      text: '',
      choices: ['sw-1', 'sw-2'],
    },
    { name: 'note', label: 'Why', type: 'string', required: false, text: 'routine' },
  ];
  it('takes the asked values, says what is missing, refuses the rest', () => {
    expect(fillAction(fields, { devices: 'sw-1, sw-2' })).toEqual({
      texts: { devices: 'sw-1, sw-2', note: 'routine' },
      missing: [],
    });
    expect(fillAction(fields, {})).toMatchObject({ missing: ['devices'] });
    expect(fillAction(fields, { retries: '5' })).toMatchObject({ field: 'retries' });
    expect(fillAction(fields, { devices: 'sw-9' })).toMatchObject({
      field: 'devices',
      error: expect.stringContaining('not one of the choices'),
    });
  });
});

describe('host lists of an action (AFS-207)', () => {
  const inventory = {
    hosts: ['sw-core-01', 'sw-edge-01', 'sw-edge-02', 'sw-edge-03', 'sw-edge-04'],
    groups: {
      edge: { parents: [], hosts: ['sw-edge-01', 'sw-edge-02'] },
      edge_south: { parents: ['edge'], hosts: ['sw-edge-03', 'sw-edge-04'] },
      core: { parents: [], hosts: ['sw-core-01'] },
    },
  };
  const one = { name: 'devices', label: 'Switch', max: 1 };
  it('a group counts by its hosts, its children too; a name the inventory lacks is said', () => {
    expect(hostsOf('edge', inventory).hosts).toHaveLength(4);
    expect(hostsOf('core, sw-core-01, localhost', inventory).hosts).toEqual([
      'localhost',
      'sw-core-01',
    ]);
    expect(hostProblem(one, 'sw-edge-02', inventory)).toBeUndefined();
    expect(hostProblem(one, 'edge', inventory)?.message).toMatch(
      /^Switch: edge is 4 hosts \(sw-edge-01, .*\): this action takes one host/,
    );
    expect(hostProblem({ ...one, max: 2 }, 'sw-edge-01, core', inventory)).toBeUndefined();
    expect(hostProblem(one, 'sw-edge-*', inventory)?.message).toMatch(/not a pattern/);
    expect(hostProblem({ name: 'devices', label: 'Switch' }, 'nosuchhost', inventory)).toEqual({
      field: 'devices',
      message: 'Switch: nosuchhost is not a host or group of the inventory',
    });
    // A dynamic inventory finds its hosts when it runs: an unknown name may be one.
    expect(
      hostProblem({ name: 'devices', label: 'Switch' }, 'nosuchhost', {
        ...inventory,
        dynamic: true,
      }),
    ).toBeUndefined();
  });
});

describe('the progress of an action run in words (AFS-207)', () => {
  const node = (id: string, type: string, title: string) => ({ id, key: id, type, title });
  const doc = {
    nodes: [
      node('s', 'start', 'Start'),
      node('a', 'task', 'Back up'),
      node('b', 'task', 'Apply'),
      node('rb', 'task', 'Rollback'),
      node('e', 'end', 'End'),
    ],
    edges: [
      { from: { node: 's', port: 'ok_hosts' }, to: { node: 'a', port: 'in' } },
      { from: { node: 'a', port: 'ok' }, to: { node: 'b', port: 'in' } },
      { from: { node: 'b', port: 'ok' }, to: { node: 'e', port: 'in' } },
      { from: { node: 'b', port: 'failed' }, to: { node: 'rb', port: 'in' } },
    ],
  };
  const of = (state: string, nodes: Record<string, Record<string, string[]>>) =>
    progressOf({
      run: {
        id: 'r1',
        number: 1,
        state,
        mode: 'real',
        inputs: {},
        createdAt: new Date().toISOString(),
        flow: { name: 'Edge', file: 'edge.flow.yaml' },
        config: { id: 'c1', name: 'Edge' },
      } as never,
      doc: doc as never,
      view: {
        rc: state === 'failed' ? 2 : 0,
        summary: {
          nodes,
          outcome: {},
          failures: [],
          unreachable: [],
          hosts: [],
          stoppedEarly: false,
          // Every play starts, with or without hosts.
          timings: { a: { start: 1, end: 2 }, b: { start: 2, end: 3 }, rb: { start: 3, end: 4 } },
        },
      } as never,
      gates: [],
      deciders: [],
      startedBy: 'Mia',
      ask: [],
    });
  it('a run where no host ran has done nothing: no step done, the bar not full', () => {
    const p = of('failed', { a: {}, b: {}, rb: {} });
    expect(p.steps.map((s) => [s.title, s.state])).toEqual([
      ['Back up', 'not run'],
      ['Apply', 'not run'],
    ]);
    expect([p.done, p.total]).toEqual([0, 2]);
  });
  it('a rollback no host was sent to is not shown, nor counted', () => {
    const p = of('succeeded', { a: { ok: ['sw1'] }, b: { ok: ['sw1'] }, rb: { ok: [] } });
    expect(p.steps.map((s) => [s.title, s.state])).toEqual([
      ['Back up', 'done'],
      ['Apply', 'done'],
    ]);
    expect([p.done, p.total]).toEqual([2, 2]);
    const failed = of('failed', {
      a: { ok: ['sw1'] },
      b: { failed: ['sw1'] },
      rb: { ok: ['sw1'] },
    });
    expect(failed.steps.map((s) => s.title)).toContain('Rollback');
  });
});

for (const [name, config] of databases) {
  describe.skipIf(!config)(`actions on ${name}`, () => {
    let database: Database;
    let app: FastifyInstance;
    let source: TestRepo;
    let core: Project;
    let edge: string;
    let gated: string;
    let other: string;
    const token: Partial<Record<Person, string>> = {};
    const db = () => database.db;

    beforeAll(async () => {
      if (!config) return;
      database = openDatabase(config);
      await migrate(database.db as never);
      await emptyWorkspaces(db());
      await emptyPeople(db());
      source = testRepo({
        'edge.flow.yaml': EDGE,
        'gate.flow.yaml': fixture('approval.flow.yaml'),
        'inventory/hosts.ini': '[edge]\nsw-edge-01\nsw-edge-02\n\n[core]\nsw-core-01\n',
      });
      const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
      const git = new Git({ reposDir: join(root, `repos-${name}`), allowLocal: true });
      const sync = new ProjectSync(db(), git, log);
      const queue = new RunQueue(db(), database.kind, key);
      app = buildApp({
        log,
        database,
        instance: 'test',
        masterKey: key,
        runs: queue,
        projects: { git, sync, allowLocal: true },
      });
      const net = await createWorkspace(db(), { key: 'net', name: 'Network' });
      const made = await createProject(
        db(),
        net.id,
        { key: 'core', name: 'Core', gitUrl: source.dir, pollSeconds: 0 },
        true,
      );
      core = (await sync.sync(made.id)) as Project;
      const configs = new LaunchConfigs(db(), git);
      const base = { inventory: 'inventory/hosts.ini', mode: 'real' as const };
      edge = (
        await configs.create(core.id, {
          name: 'Restart edge',
          flowFile: 'edge.flow.yaml',
          ...base,
          inputs: { devices: ['sw-edge-01'], retries: 3 },
        })
      ).id;
      gated = (
        await configs.create(core.id, {
          name: 'Gated change',
          flowFile: 'gate.flow.yaml',
          ...base,
          inputs: { devices: ['sw-edge-01'] },
        })
      ).id;
      other = (
        await configs.create(core.id, {
          name: 'Not an action',
          flowFile: 'edge.flow.yaml',
          ...base,
          inputs: { devices: ['sw-edge-01'] },
        })
      ).id;
      for (const login of PEOPLE)
        await createUser(db(), { login, name: login, password: PASSWORD, admin: login === 'dana' });
      const ids = Object.fromEntries(
        (await db().selectFrom('user_account').select(['id', 'login']).execute()).map((u) => [
          u.login,
          u.id,
        ]),
      );
      for (const login of PEOPLE)
        token[login] = (await createToken(db(), ids[login] as string, { name: 't' })).token;
      const managers = await createGroup(db(), { name: 'managers' });
      await setMembers(db(), managers.id, [ids.gail as string]);
      const give = (login: string, level: 'ro' | 'operator' | 'rw' | 'approve') =>
        createGrant(db(), net.id, { user: login, level }, 'dana');
      await give('wanda', 'rw');
      await give('otto', 'operator');
      await give('rita', 'ro');
      await give('approver', 'approve');
    });
    afterAll(async () => {
      await app?.close();
      await database?.close();
      source?.remove();
    });

    const call = async (who: Person, method: string, url: string, payload?: object) => {
      const reply = await app.inject({
        method: method as 'GET',
        url,
        headers: { authorization: `Bearer ${token[who]}` },
        ...(payload ? { payload } : {}),
      });
      return {
        status: reply.statusCode,
        body: reply.body ? (JSON.parse(reply.body) as Record<string, unknown>) : {},
      };
    };
    const SETTINGS = {
      title: 'Restart the edge switch',
      summary: 'Restarts one edge switch and checks it answers again.',
      asked: [
        {
          name: 'devices',
          label: 'Switch',
          help: 'The switch to restart.',
          choices: ['sw-edge-01', 'sw-edge-02'],
        },
      ],
      mode: 'check',
      confirm: true,
    };

    it('rw on the workspace makes an action; an operator may not; inputs are the flow’s, never a secret', async () => {
      expect(
        (await call('otto', 'PUT', `/api/v1/launch-configs/${edge}/action`, SETTINGS)).status,
      ).toBe(403);
      const secret = await call('wanda', 'PUT', `/api/v1/launch-configs/${edge}/action`, {
        ...SETTINGS,
        asked: [{ name: 'api_password', label: 'Password' }],
      });
      expect(secret.status).toBe(400);
      expect(secret.body.message).toMatch(/secret/);
      const unknown = await call('wanda', 'PUT', `/api/v1/launch-configs/${edge}/action`, {
        ...SETTINGS,
        asked: [{ name: 'nope', label: 'Nope' }],
      });
      expect(unknown.status).toBe(400);
      const set = await call('wanda', 'PUT', `/api/v1/launch-configs/${edge}/action`, SETTINGS);
      expect(set.status).toBe(200);
      expect(set.body).toMatchObject({
        id: edge,
        title: SETTINGS.title,
        enabled: true,
        owner: { login: 'wanda' },
      });
      expect(
        (
          await call('wanda', 'PUT', `/api/v1/launch-configs/${gated}/action`, {
            title: 'Gated change',
            summary: 'A change that waits for approval.',
            asked: [],
            mode: 'check',
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call('otto', 'POST', `/api/v1/launch-configs/${edge}/action/grants`, {
            user: 'mia',
          })
        ).status,
      ).toBe(403);
      // AFS-206: rw names only people and groups who already reach the workspace; anyone else,
      // and a login or group that does not exist, get one answer: no oracle of the server's people.
      const refusals = [];
      for (const body of [
        { user: 'mia' },
        { user: 'nosuchperson' },
        { group: 'managers' },
        { group: 'nosuchgroup' },
      ]) {
        const refused = await call(
          'wanda',
          'POST',
          `/api/v1/launch-configs/${edge}/action/grants`,
          body,
        );
        expect(refused.status, JSON.stringify(body)).toBe(404);
        refusals.push(
          String(refused.body.message).replace(/ (mia|nosuchperson|managers|nosuchgroup) /, ' X '),
        );
      }
      expect(refusals[0]).toBe(refusals[1]);
      expect(refusals[2]).toBe(refusals[3]);
      expect(refusals[0]).not.toMatch(/mia|Mia/);
      // An administrator gives them their first action here; then rw may name them.
      for (const [cfg, body] of [
        [edge, { user: 'mia' }],
        [edge, { group: 'managers' }],
      ] as const)
        expect(
          (await call('dana', 'POST', `/api/v1/launch-configs/${cfg}/action/grants`, body)).status,
        ).toBe(201);
      expect(
        (
          await call('wanda', 'POST', `/api/v1/launch-configs/${gated}/action/grants`, {
            user: 'mia',
          })
        ).status,
      ).toBe(201);
      // Whom rw may give it to: the workspace's people and groups, offered on the form.
      const offered = (await call('wanda', 'GET', `/api/v1/launch-configs/${edge}/action`)).body
        .people as { users: { login: string }[]; groups: { name: string }[] };
      expect(offered.users.map((u) => u.login)).toContain('mia');
      expect(offered.users.map((u) => u.login)).not.toContain('nobody');
      expect(offered.groups.map((g) => g.name)).toEqual(['managers']);
      expect(
        (
          await call('wanda', 'POST', `/api/v1/launch-configs/${edge}/action/grants`, {
            user: 'mia',
          })
        ).status,
      ).toBe(409);
      const grants = await call('wanda', 'GET', '/api/v1/workspaces/net/action-grants');
      expect(
        (grants.body as unknown as { principal: { name: string } }[])
          .map((g) => g.principal.name)
          .sort(),
      ).toEqual(['managers', 'mia', 'mia']);
    });

    it('an action-only person sees their actions and the asked inputs only', async () => {
      const list = await call('mia', 'GET', '/api/v1/actions');
      expect((list.body as unknown as { title: string }[]).map((a) => a.title)).toEqual([
        'Gated change',
        'Restart the edge switch',
      ]);
      const form = await call('mia', 'GET', `/api/v1/actions/${edge}`);
      expect(form.status).toBe(200);
      expect(form.body.fields).toEqual([
        expect.objectContaining({
          name: 'devices',
          label: 'Switch',
          choices: ['sw-edge-01', 'sw-edge-02'],
        }),
      ]);
      expect(form.body.blocked).toBeUndefined();
      expect((form.body.happens as string[]).join(' ')).toMatch(
        /as a check.*Check the host answers/,
      );
      expect(form.body.configPage).toBeUndefined();
      // AFS-207: a refusal says whom to ask.
      const refused = await call('rita', 'GET', `/api/v1/actions/${edge}`);
      expect(refused.status).toBe(403);
      expect(refused.body.message).toMatch(/^You may not run "Restart the edge switch": ask wanda/);
      expect((await call('nobody', 'GET', `/api/v1/actions/${edge}`)).status).toBe(404);
      expect((await call('nobody', 'GET', '/api/v1/actions')).body).toEqual([]);
      // The group's grant, and operator on the flow.
      expect((await call('gail', 'GET', `/api/v1/actions/${edge}`)).status).toBe(200);
      expect((await call('otto', 'GET', `/api/v1/actions/${edge}`)).status).toBe(200);
      expect((await call('mia', 'GET', `/api/v1/actions/${other}`)).status).toBe(404);
      // AFS-207: search finds the actions one may run, and only those.
      const found = (q: string, who: Person) =>
        call(who, 'GET', `/api/v1/search?q=${q}`).then((r) =>
          (r.body as unknown as { kind: string; title: string; to: string }[]).filter(
            (h) => h.kind === 'action',
          ),
        );
      expect(await found('restart edge', 'mia')).toEqual([
        expect.objectContaining({ title: 'Restart the edge switch', to: `/actions/${edge}` }),
      ]);
      expect(await found('restart edge', 'rita')).toEqual([]);
      expect(await found('restart edge', 'nobody')).toEqual([]);
      const hosts = await call('mia', 'GET', `/api/v1/actions/${edge}/hosts`);
      expect(hosts.body).toMatchObject({
        hosts: ['sw-core-01', 'sw-edge-01', 'sw-edge-02'],
        groups: ['core', 'edge'],
      });
    });

    it('an action-only person reaches nothing else of the workspace', async () => {
      for (const [method, url] of [
        ['GET', `/api/v1/launch-configs/${edge}`],
        ['GET', `/api/v1/launch-configs/${edge}/form`],
        ['POST', `/api/v1/launch-configs/${edge}/launch`],
        ['GET', `/api/v1/launch-configs/${edge}/action`],
        ['GET', `/api/v1/projects/${core.id}`],
        ['GET', `/api/v1/projects/${core.id}/launch-configs`],
        ['GET', `/api/v1/projects/${core.id}/files`],
        ['GET', '/api/v1/workspaces/net'],
      ] as const)
        expect(
          (await call('mia', method, url, method === 'POST' ? {} : undefined)).status,
          url,
        ).toBe(404);
      expect((await call('mia', 'GET', '/api/v1/workspaces')).body).toEqual([]);
    });

    let run: string;
    it('runs with the asked values only; fixed values stay; the run is the action’s', async () => {
      const notAsked = await call('mia', 'POST', `/api/v1/actions/${edge}/run`, {
        inputs: { devices: 'sw-edge-01', retries: '9' },
      });
      expect(notAsked.status).toBe(400);
      expect(notAsked.body.field).toBe('retries');
      const outside = await call('mia', 'POST', `/api/v1/actions/${edge}/run`, {
        inputs: { devices: 'sw-core-01' },
      });
      expect(outside.status).toBe(400);
      const ran = await call('mia', 'POST', `/api/v1/actions/${edge}/run`, {
        inputs: { devices: 'sw-edge-02' },
      });
      expect(ran.status).toBe(201);
      run = ran.body.id as string;
      expect(ran.body.progress).toBe(`/actions/runs/${run}`);
      const record = await db()
        .selectFrom('run')
        .selectAll()
        .where('id', '=', run)
        .executeTakeFirstOrThrow();
      expect(record.action_title).toBe(SETTINGS.title);
      // The action's mode, not the configuration's; its fixed value kept.
      expect(record.mode).toBe('check');
      expect(JSON.parse(record.inputs_shown_json)).toMatchObject({
        devices: ['sw-edge-02'],
        retries: 3,
      });
      // Still nothing else: not the run, not the list of runs.
      expect((await call('mia', 'GET', `/api/v1/runs/${run}`)).status).toBe(404);
      expect((await call('mia', 'GET', `/api/v1/runs/${run}/events`)).status).toBe(404);
      expect((await call('mia', 'GET', '/api/v1/runs')).body).toEqual([]);
      const list = await call('mia', 'GET', '/api/v1/actions');
      expect(
        (list.body as unknown as { id: string; lastRun?: { id: string } }[]).find(
          (a) => a.id === edge,
        )?.lastRun?.id,
      ).toBe(run);
    });

    it('the progress view: for who may run the action or see the run', async () => {
      const mine = await call('mia', 'GET', `/api/v1/actions/runs/${run}`);
      expect(mine.status).toBe(200);
      expect(mine.body).toMatchObject({
        action: { id: edge, title: SETTINGS.title },
        headline: expect.stringMatching(/^Waiting to start/),
        inputs: [{ label: 'Switch', value: 'sw-edge-02' }],
        // AFS-207: again with the same values.
        again: `/actions/${edge}?devices=sw-edge-02`,
      });
      expect(mine.body.runPage).toBeUndefined();
      expect((mine.body.steps as { title: string }[]).map((s) => s.title)).toEqual([
        'Check the host answers',
        'Read a few facts',
        'Say hello',
      ]);
      expect((mine.body.ask as string[])[0]).toMatch(/wanda \(who set up this action\)/);
      // AFS-176: not shared with another who may only run it; the full run page for who may
      // see the run.
      expect((await call('gail', 'GET', `/api/v1/actions/runs/${run}`)).status).toBe(404);
      expect((await call('otto', 'GET', `/api/v1/actions/runs/${run}`)).status).toBe(200);
      expect((await call('rita', 'GET', `/api/v1/actions/runs/${run}`)).body.runPage).toBe(
        `/runs/${run}`,
      );
      expect((await call('nobody', 'GET', `/api/v1/actions/runs/${run}`)).status).toBe(404);
    });

    it('approvals still apply: the progress says who decides; the runner does not', async () => {
      const ran = await call('mia', 'POST', `/api/v1/actions/${gated}/run`, { inputs: {} });
      expect(ran.status).toBe(201);
      const id = ran.body.id as string;
      await openGate(db(), {
        run: id,
        node: { id: '01JCRBN0000000000000000003', key: 'gate', title: 'Approve the change' },
        segment: 'gate',
        carried: {},
        approval: { approvers: ['change-board'] },
      });
      await db().updateTable('run').set({ state: 'waiting' }).where('id', '=', id).execute();
      const waiting = await call('mia', 'GET', `/api/v1/actions/runs/${id}`);
      expect(waiting.body.headline).toMatch(
        /Waiting for approval at Approve the change by change-board/,
      );
      expect(waiting.body.steps).toContainEqual(
        expect.objectContaining({ title: 'Approve the change', state: 'waiting' }),
      );
      const decide = await call(
        'mia',
        'POST',
        `/api/v1/runs/${id}/approvals/01JCRBN0000000000000000003`,
        {
          decision: 'approved',
        },
      );
      expect(decide.status).toBe(404);
    });

    it('AFS-207: a host list starts empty, takes one host of its group; the same press twice runs once', async () => {
      const ONE = {
        title: 'Baseline one edge switch',
        summary: 'Puts the standard settings on one edge switch.',
        asked: [{ name: 'devices', label: 'Switch', group: 'edgex', max: 1 }],
        mode: 'real',
        confirm: true,
      };
      const typo = await call('wanda', 'PUT', `/api/v1/launch-configs/${other}/action`, ONE);
      expect(typo.status).toBe(400);
      expect(typo.body.message).toMatch(/^The inventory has no group edgex: its groups are/);
      expect(
        (
          await call('wanda', 'PUT', `/api/v1/launch-configs/${other}/action`, {
            ...ONE,
            asked: [{ name: 'devices', label: 'Switch', group: 'edge', max: 1 }],
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call('dana', 'POST', `/api/v1/launch-configs/${other}/action/grants`, {
            user: 'mia',
          })
        ).status,
      ).toBe(201);
      // The configuration's value (sw-edge-01) is not where the form starts.
      const form = await call('mia', 'GET', `/api/v1/actions/${other}`);
      expect(form.body.fields).toEqual([
        expect.objectContaining({
          name: 'devices',
          text: '',
          max: 1,
          group: 'edge',
          required: true,
        }),
      ]);
      const hosts = await call('mia', 'GET', `/api/v1/actions/${other}/hosts`);
      expect(hosts.body).toMatchObject({
        hosts: [],
        groups: [],
        inGroup: { edge: ['sw-edge-01', 'sw-edge-02'] },
        sizes: { edge: 2 },
      });
      const group = await call('mia', 'GET', `/api/v1/actions/${other}/link?devices=edge`);
      expect(group.body.ready).toBe(false);
      expect((group.body.problems as { message: string }[])[0]?.message).toMatch(
        /Switch: edge is 2 hosts .*one host/,
      );
      const right = await call('mia', 'GET', `/api/v1/actions/${other}/link?devices=sw-edge-01`);
      expect(right.body).toMatchObject({ ready: true, counts: { devices: 1 } });
      const all = await call('mia', 'POST', `/api/v1/actions/${other}/run`, {
        inputs: { devices: 'edge' },
      });
      expect(all.status).toBe(400);
      expect(all.body.field).toBe('devices');
      // Once; the same values again a moment later (Back to a link that runs as it opens) start
      // nothing and name that run; said to run again, it does.
      const first = await call('mia', 'POST', `/api/v1/actions/${other}/run`, {
        inputs: { devices: 'sw-edge-01' },
        link: true,
      });
      expect(first.status).toBe(201);
      const twice = await call('mia', 'POST', `/api/v1/actions/${other}/run`, {
        inputs: { devices: 'sw-edge-01' },
        link: true,
      });
      expect(twice.status).toBe(409);
      expect(twice.body).toMatchObject({ error: 'duplicate', run: { id: first.body.id } });
      expect(
        (
          await call('mia', 'POST', `/api/v1/actions/${other}/run`, {
            inputs: { devices: 'sw-edge-02' },
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await call('mia', 'POST', `/api/v1/actions/${other}/run`, {
            inputs: { devices: 'sw-edge-01' },
            again: true,
          })
        ).status,
      ).toBe(201);
      // What really changed, for the audit log.
      expect(
        (
          await call('wanda', 'PUT', `/api/v1/launch-configs/${other}/action`, {
            ...ONE,
            asked: [{ name: 'devices', label: 'Switch', group: 'edge', max: 1 }],
            runOnOpen: true,
          })
        ).status,
      ).toBe(200);
      const set = await db()
        .selectFrom('audit_entry')
        .select('detail_json')
        .where('action', '=', 'action.set')
        .where('object_id', '=', other)
        .orderBy('at', 'desc')
        .executeTakeFirst();
      expect(JSON.parse(set?.detail_json ?? '{}').changed).toEqual(['runOnOpen']);
      await call('wanda', 'DELETE', `/api/v1/launch-configs/${other}/action`);
    });

    it('turned off, the action is gone for its runners; its grants stay', async () => {
      expect(
        (
          await call('wanda', 'PUT', `/api/v1/launch-configs/${edge}/action`, {
            ...SETTINGS,
            enabled: false,
          })
        ).status,
      ).toBe(200);
      // AFS-207: who may run it is told it is off, and whom to ask; nobody else learns of it.
      const off = await call('mia', 'GET', `/api/v1/actions/${edge}`);
      expect(off.status).toBe(404);
      expect(off.body.message).toMatch(/is switched off for now.*ask wanda/);
      expect((await call('nobody', 'GET', `/api/v1/actions/${edge}`)).body.message).toBe(
        'No such action',
      );
      expect(
        (
          await call('mia', 'POST', `/api/v1/actions/${edge}/run`, {
            inputs: { devices: 'sw-edge-01' },
          })
        ).status,
      ).toBe(404);
      const read = await call('wanda', 'GET', `/api/v1/launch-configs/${edge}/action`);
      expect((read.body.grants as unknown[]).length).toBe(2);
      expect(
        (await call('wanda', 'PUT', `/api/v1/launch-configs/${edge}/action`, SETTINGS)).status,
      ).toBe(200);
      const grant = (read.body.grants as { id: string; principal: { name: string } }[]).find(
        (g) => g.principal.name === 'mia',
      );
      expect(
        (await call('wanda', 'DELETE', `/api/v1/launch-configs/${edge}/action/grants/${grant?.id}`))
          .status,
      ).toBe(204);
      expect((await call('mia', 'GET', `/api/v1/actions/${edge}`)).status).toBe(404);
      // AFS-207: the runs she started stay hers to read; no Run it again.
      const own = await call('mia', 'GET', `/api/v1/actions/runs/${run}`);
      expect(own.status).toBe(200);
      expect(own.body.again).toBeUndefined();
    });

    it('the audit log says who set, gave, took back and ran actions', async () => {
      const rows = await db()
        .selectFrom('audit_entry')
        .select(['action', 'result', 'object_name', 'detail_json'])
        .orderBy('at')
        .where('object_type', '=', 'action')
        .execute();
      const ok = rows.filter((r) => r.result === 'ok').map((r) => r.action);
      for (const a of ['action.set', 'action.grant', 'action.grant-remove', 'action.run'])
        expect(ok, a).toContain(a);
      const ran = rows.find(
        (r) => r.action === 'action.run' && r.result === 'ok' && r.object_name === SETTINGS.title,
      );
      expect(ran?.object_name).toBe(SETTINGS.title);
      expect(JSON.parse(ran?.detail_json ?? '{}').run).toBeTruthy();
      // A refused run (not asked) is recorded too, with its reason.
      expect(rows.some((r) => r.action === 'action.run' && r.result === 'refused')).toBe(true);
    });

    it('one access table: actions in what a person reaches and every action of a workspace (AFS-206)', async () => {
      const ids = Object.fromEntries(
        (await db().selectFrom('user_account').select(['id', 'login']).execute()).map((u) => [
          u.login,
          u.id,
        ]),
      );
      const mia = (await call('dana', 'GET', `/api/v1/users/${ids.mia}/access`)).body as {
        workspaces: { workspace: { key: string }; level: unknown; actions: { title: string }[] }[];
      };
      expect(mia.workspaces).toEqual([
        expect.objectContaining({
          workspace: expect.objectContaining({ key: 'net' }),
          level: null,
          actions: [expect.objectContaining({ title: 'Gated change' })],
        }),
      ]);
      const who = (await call('dana', 'GET', '/api/v1/workspaces/net/access')).body as unknown as {
        user: { login: string };
        actions: { title: string }[];
      }[];
      expect(who.find((w) => w.user.login === 'mia')?.actions.map((a) => a.title)).toEqual([
        'Gated change',
      ]);
      const all = (await call('wanda', 'GET', '/api/v1/workspaces/net/actions'))
        .body as unknown as {
        title: string;
        grants: unknown[];
      }[];
      expect(all.map((a) => a.title)).toEqual(expect.arrayContaining(['Gated change']));
      expect((await call('rita', 'GET', '/api/v1/workspaces/net/actions')).status).toBe(403);
    });

    it('a deleted configuration takes its action and grants with it', async () => {
      expect((await call('wanda', 'DELETE', `/api/v1/launch-configs/${gated}`)).status).toBe(204);
      expect(
        await db()
          .selectFrom('launch_action')
          .select('config_id')
          .where('config_id', '=', gated)
          .execute(),
      ).toEqual([]);
      expect(
        await db().selectFrom('action_grant').select('id').where('config_id', '=', gated).execute(),
      ).toEqual([]);
      // AFS-206: the log says the action ended and who lost it, and why.
      const entries = await db()
        .selectFrom('audit_entry')
        .select(['action', 'object_type', 'object_name', 'detail_json'])
        .where('object_id', '=', gated)
        .orderBy('at')
        .execute();
      const detail = (action: string) =>
        JSON.parse(entries.find((e) => e.action === action)?.detail_json ?? 'null');
      expect(detail('launch-config.delete')).toMatchObject({
        action: 'Gated change',
        actionGrants: ['mia may run Gated change'],
      });
      expect(entries.find((e) => e.action === 'action.remove')).toMatchObject({
        object_type: 'action',
        object_name: 'Gated change',
      });
      expect(detail('action.remove')).toMatchObject({
        why: 'the launch configuration was deleted',
      });
      expect(detail('action.grant-remove')).toEqual({
        who: 'mia',
        why: 'the launch configuration was deleted',
      });
    });

    it('a deleted person takes their action grants with them, said in the log (AFS-206)', async () => {
      const temp = await createUser(db(), {
        login: 'temp',
        name: 'Tem Porary',
        password: PASSWORD,
      });
      expect(
        (
          await call('dana', 'POST', `/api/v1/launch-configs/${edge}/action/grants`, {
            user: 'temp',
          })
        ).status,
      ).toBe(201);
      expect((await call('dana', 'DELETE', `/api/v1/users/${temp.id}`)).status).toBe(204);
      const ended = await db()
        .selectFrom('audit_entry')
        .select(['object_name', 'detail_json'])
        .where('action', '=', 'action.grant-remove')
        .where('object_id', '=', edge)
        .execute();
      expect(ended.map((e) => JSON.parse(e.detail_json ?? '{}'))).toContainEqual({
        who: 'Tem Porary',
        why: 'the person was deleted',
      });
      const deleted = await db()
        .selectFrom('audit_entry')
        .select('detail_json')
        .where('action', '=', 'user.delete')
        .where('object_id', '=', temp.id)
        .executeTakeFirst();
      expect(JSON.parse(deleted?.detail_json ?? '{}').actionGrants).toEqual([
        `Tem Porary may run ${SETTINGS.title}`,
      ]);
      // The grant's id is not in an entry: the person and the action are named.
      const given = await db()
        .selectFrom('audit_entry')
        .select('detail_json')
        .where('action', '=', 'action.grant')
        .execute();
      for (const g of given) expect(JSON.parse(g.detail_json ?? '{}').grant).toBeUndefined();
    });
  });
}
