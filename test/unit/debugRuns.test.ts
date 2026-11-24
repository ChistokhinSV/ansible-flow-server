// AFS-179 (ADR-0038 §1): debug runs on the server. A debug launch needs rw on the flow (or operator
// where the workspace lets operators debug); its pause points carry settings and its failure
// filters travel to the engine; POST /runs/:id/inspect asks the paused run and waits for the
// answer, only for who launched it and administrators, audited with the expression and never the
// answer; Retry reaches the driver; what scopes and watches showed is kept with the run (at most
// 1 MB) and goes with it; MCP's run_inspect only with a token that allows run control.
// Ansible is played by the test (a fake StepDriver with inspect); stepRunDocker.test.ts runs the
// real engine in a container.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunView } from '@ansible-flow/core/protocol';
import type {
  FailureFilters,
  InspectAnswer,
  PointSpec,
  StepCommand,
  StepPause,
} from '@ansible-flow/core/run/step';
import type { RunFlowHooks, RunFlowRequest, StepDriver } from '@ansible-flow/node/run/runFlow';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGrant } from '../../src/server/access/grants';
import { buildApp } from '../../src/server/app';
import { listAudit } from '../../src/server/audit/store';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs } from '../../src/server/launch/configs';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import {
  createProject,
  createWorkspace,
  type Project,
  updateWorkspace,
} from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { debugKept, keepDebug, MAX_DEBUG_BYTES } from '../../src/server/runs/debugStore';
import { Executor } from '../../src/server/runs/executor';
import { RunQueue } from '../../src/server/runs/queue';
import { pruneRuns } from '../../src/server/runs/retention';
import {
  bareExpr,
  failuresOf,
  type InspectAsk,
  outputForReader,
  refusalFor,
  type Stepper,
  stepAsked,
} from '../../src/server/runs/stepping';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { type TestRepo, testRepo } from './helpers/repo';

const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const HELLO = readFileSync(join(__dirname, '../fixtures/hello.flow.yaml'), 'utf8');
const PING = '01M6GPM979RJPCDJ0XFF22GBSV';
const FACTS = '01M6GPM99KC9TX091MCH61REQV';
const FILE = 'flows/hello.flow.yaml';
const root = mkdtempSync(join(tmpdir(), 'afs-debug-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let database: Database;
let git: Git;
let sync: ProjectSync;
let queue: RunQueue;
let source: TestRepo;
let project: Project;
let workspace: string;
let config: string;
let app: FastifyInstance;
let url: string;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
/** What the test's executor answers for runs "going here". */
const driving = new Map<
  string,
  { paused: boolean; sent: string[]; answer?: InspectAnswer; asked: InspectAsk[] }
>();
const stepper: Stepper = {
  async drive(run, ask) {
    const going = driving.get(run);
    if (!going) return undefined;
    const refused = ask.command ? refusalFor(ask.command, going.paused) : undefined;
    if (refused) return { error: refused };
    if (ask.command) going.sent.push(ask.command);
    if (ask.points) going.sent.push(`points:${JSON.stringify(ask.points)}`);
    if (ask.failures) going.sent.push(`failures:${JSON.stringify(ask.failures)}`);
    return { paused: going.paused };
  },
  async inspect(run, ask) {
    const going = driving.get(run);
    if (!going) return undefined;
    going.asked.push(ask);
    return going.answer ?? { gone: true };
  },
};
const db = () => database.db;

beforeAll(async () => {
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  const log = createLogger({ level: 'silent', format: 'json', write: () => undefined });
  git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
  sync = new ProjectSync(db(), git, log);
  queue = new RunQueue(db(), 'sqlite', key, { maxRuns: 4, perProject: 4 });
  source = testRepo({
    [FILE]: HELLO,
    'inventory/hosts.yaml': 'all:\n  hosts:\n    localhost: {}\n',
  });
  const net = await createWorkspace(db(), { key: 'net', name: 'Network' });
  workspace = net.id;
  project = (await sync.sync(
    (
      await createProject(
        db(),
        net.id,
        { key: 'edge', name: 'Edge', gitUrl: source.dir, pollSeconds: 0 },
        true,
      )
    ).id,
  )) as Project;
  config = (
    await new LaunchConfigs(db(), git).create(project.id, {
      name: 'Hello',
      flowFile: FILE,
      inventory: 'inventory/hosts.yaml',
      inputs: { devices: ['localhost'] },
    })
  ).id;
  // dana administers; wes writes the flow; omar operates it; rita reads it.
  for (const [login, admin] of [
    ['dana', true],
    ['wes', false],
    ['omar', false],
    ['rita', false],
  ] as const)
    ids[login] = (
      await createUser(db(), { login, name: login, password: 'x'.repeat(12), admin })
    ).id;
  const flow = { project: project.id, flow: FILE };
  await createGrant(db(), net.id, { user: 'wes', level: 'rw', ...flow }, 'dana');
  await createGrant(db(), net.id, { user: 'omar', level: 'operator', ...flow }, 'dana');
  await createGrant(db(), net.id, { user: 'rita', level: 'ro' }, 'dana');
  const make = async (who: string, extra: object = {}) =>
    (await createToken(db(), ids[who] as string, { name: 't', ...extra })).token;
  for (const who of ['dana', 'wes', 'omar', 'rita']) tokens[who] = await make(who);
  tokens.wesDrives = await make('wes', { mcpRunControl: true });
  app = buildApp({
    log,
    database,
    instance: 'test',
    masterKey: key,
    runs: queue,
    projects: { git, sync, allowLocal: true },
    stepper,
    stepTimeoutMinutes: 30,
  });
  url = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app?.close();
  await sync?.stop();
  await database?.close();
  source?.remove();
});

const as = (who: string) => ({ authorization: `Bearer ${tokens[who]}` });
const launch = (who: string, body: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/launch-configs/${config}/launch`,
    headers: as(who),
    payload: { mode: 'check', ...body },
  });
const clear = async () => {
  for (const r of await queue.list({ state: 'queued' })) await queue.cancel(r.id, 'dana');
};
const post = (who: string, path: string, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: path, headers: as(who), payload: body });
/** A debug run launched by `who`, claimed and started (going "here" once driving has it). */
const going = async (who: string) => {
  await clear();
  const made = await launch(who, { step: { debug: true, points: [FACTS] } });
  expect(made.statusCode).toBe(201);
  const run = made.json() as { id: string };
  const job = await queue.claim('w');
  expect(job?.run.id).toBe(run.id);
  await queue.start(run.id, job?.token as string);
  return { id: run.id, token: job?.token as string };
};

describe('what a debug launch asks for', () => {
  it('keeps settings of points and the failure filters only for a debug run', () => {
    const point: PointSpec = { node: FACTS, condition: ' vlan_id == 210 ', hits: 2 };
    expect(stepAsked({ debug: true, points: [PING, point, PING] }, 60)).toEqual({
      every: false,
      points: [PING, { node: FACTS, condition: 'vlan_id == 210', hits: 2 }],
      timeoutS: 3600,
      debug: true,
      pauseOnFailure: true,
      failures: { failed: true },
    });
    // A plain step-by-step run pauses at the point: its settings are not kept.
    expect(stepAsked({ points: [point] }, 60)).toEqual({
      every: false,
      points: [FACTS],
      timeoutS: 3600,
    });
    expect(
      stepAsked({ debug: true, every: true, failures: { failed: false, unreachable: true } }, 60),
    ).toMatchObject({ failures: { failed: false, unreachable: true } });
    expect(stepAsked({ debug: true, every: true, pauseOnFailure: false }, 60)).toMatchObject({
      failures: { failed: false },
    });
    expect(failuresOf({ debug: true, pauseOnFailure: true })).toEqual({ failed: true });
    expect(failuresOf({})).toBeUndefined();
  });

  it('Retry answers a pause only', () => {
    expect(refusalFor('retry', false)).toMatch(/not paused/);
    expect(refusalFor('retry', true)).toBeUndefined();
  });
});

describe('the API', () => {
  it('a debug launch needs rw, or operator where the workspace lets operators debug', async () => {
    await clear();
    const refused = await launch('omar', { step: { debug: true, every: true } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toContain('A debug run needs rw on flows/hello.flow.yaml');
    expect((await launch('wes', { step: { debug: true, every: true } })).statusCode).toBe(201);
    // An administrator turns the workspace setting on; the access answer says so to the pages.
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${workspace}`,
      headers: as('dana'),
      payload: { operatorsDebug: true },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().operatorsDebug).toBe(true);
    const access = await app.inject({
      url: `/api/v1/projects/${project.id}/access`,
      headers: as('omar'),
    });
    expect(access.json().operatorsDebug).toBe(true);
    const allowed = await launch('omar', { step: { debug: true, every: true } });
    expect(allowed.statusCode).toBe(201);
    expect(allowed.json().step).toMatchObject({ debug: true, failures: { failed: true } });
    // Read-only still may not launch at all.
    expect((await launch('rita', { step: { debug: true, every: true } })).statusCode).toBe(403);
    await updateWorkspace(db(), workspace, { operatorsDebug: false });
    await clear();
  });

  it('inspect: the launcher and administrators, the answer waited for, audited without it', async () => {
    const run = await going('wes');
    const at = `/api/v1/runs/${run.id}/inspect`;
    // Not going here yet (another server, or not started on this one).
    const elsewhere = await post('wes', at, { op: 'scopes', host: 'localhost' });
    expect(elsewhere.statusCode).toBe(409);
    expect(elsewhere.json().message).toMatch(/another server/);
    const answer: InspectAnswer = {
      host: 'localhost',
      value: 210,
      type: 'int',
      ms: 40,
    };
    driving.set(run.id, { paused: true, sent: [], answer, asked: [] });
    // omar may operate the flow, but this debug run is wes's: no values for him.
    const other = await post('omar', at, { op: 'eval', host: 'localhost', expr: 'vlan_id' });
    expect(other.statusCode).toBe(403);
    expect(other.json().message).toContain('wes');
    const asked = await post('wes', at, { op: 'eval', host: 'localhost', expr: 'vlan_id' });
    expect(asked.statusCode).toBe(200);
    expect(asked.json()).toEqual(answer);
    expect((await post('dana', at, { op: 'scopes', host: 'localhost' })).statusCode).toBe(200);
    expect(driving.get(run.id)?.asked).toEqual([
      { op: 'eval', host: 'localhost', expr: 'vlan_id' },
      { op: 'scopes', host: 'localhost' },
    ]);
    // A body the engine would not take is refused before it.
    expect((await post('wes', at, { op: 'set', host: 'x' })).statusCode).toBe(400);
    const entries = (await listAudit(db(), { action: 'run.debug.inspect' })).entries;
    const ok = entries.filter((e) => e.result === 'ok');
    expect(ok.map((e) => [e.actor?.login, e.detail?.op, e.detail?.expr])).toEqual([
      ['dana', 'scopes', undefined],
      ['wes', 'eval', 'vlan_id'],
    ]);
    // Never the answer: not in what an entry says (ids are random and may hold its digits).
    expect(JSON.stringify(entries.map((e) => e.detail))).not.toContain('210');
    // The pause has ended: 410.
    driving.set(run.id, { paused: false, sent: [], answer: { gone: true }, asked: [] });
    const gone = await post('wes', at, { op: 'scopes', host: 'localhost' });
    expect(gone.statusCode).toBe(410);
    driving.delete(run.id);
    await queue.finish(run.id, run.token, 'succeeded');
    // The run has ended: 410 too.
    expect((await post('wes', at, { op: 'scopes', host: 'localhost' })).statusCode).toBe(410);
  });

  it('inspect refuses a run that is not a debug run', async () => {
    await clear();
    const plain = (await launch('wes', { step: { every: true } })).json();
    const r = await post('wes', `/api/v1/runs/${plain.id}/inspect`, { op: 'scopes', host: 'a' });
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toContain('not a debug run');
    const retry = await post('wes', `/api/v1/runs/${plain.id}/step`, { command: 'retry' });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().message).toContain('debug run');
    await clear();
  });

  it('a debug run is driven by its launcher and administrators; Stop stays an operator’s', async () => {
    const run = await going('wes');
    driving.set(run.id, { paused: true, sent: [], asked: [] });
    const step = (who: string, body: Record<string, unknown>) =>
      post(who, `/api/v1/runs/${run.id}/step`, body);
    expect((await step('omar', { command: 'continue' })).statusCode).toBe(403);
    expect((await step('omar', { points: [PING] })).statusCode).toBe(403);
    const retried = await step('wes', { command: 'retry' });
    expect(retried.statusCode).toBe(202);
    expect(retried.json().sent).toBe('retry');
    const filters: FailureFilters = { failed: true, unreachable: true };
    expect((await step('dana', { failures: filters })).statusCode).toBe(202);
    const point = { node: FACTS, condition: 'inventory_hostname == "a"' };
    expect((await step('wes', { points: [point] })).statusCode).toBe(202);
    expect((await step('omar', { command: 'stop' })).statusCode).toBe(202);
    expect(driving.get(run.id)?.sent).toEqual([
      'retry',
      `failures:${JSON.stringify(filters)}`,
      `points:${JSON.stringify([point])}`,
      'stop',
    ]);
    const audit = (await listAudit(db(), { action: 'run.step' })).entries;
    expect(audit.some((e) => e.detail?.command === 'retry' && e.result === 'ok')).toBe(true);
    driving.delete(run.id);
    await queue.finish(run.id, run.token, 'cancelled');
  });

  it('keeps pause points with settings and failure filters per person and flow', async () => {
    const at = `/api/v1/projects/${project.id}/pause-points?path=${FILE}`;
    const points: PointSpec[] = [PING, { node: FACTS, log: 'vlan {{ vlan_id }}', hits: 3 }];
    const put = await app.inject({
      method: 'PUT',
      url: at,
      headers: as('wes'),
      payload: { points, failures: { failed: false, unreachable: true } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ points, failures: { failed: false, unreachable: true } });
    // Points alone keep the filters as they were.
    await app.inject({ method: 'PUT', url: at, headers: as('wes'), payload: { points: [PING] } });
    expect((await app.inject({ url: at, headers: as('wes') })).json()).toEqual({
      points: [PING],
      failures: { failed: false, unreachable: true },
    });
    // A point with an empty setting is a plain point.
    const plain = await app.inject({
      method: 'PUT',
      url: at,
      headers: as('wes'),
      payload: { points: [{ node: FACTS, condition: '  ' }] },
    });
    expect(plain.json().points).toEqual([FACTS]);
  });
});

describe('what the pauses showed', () => {
  it('is kept per pause, at most 1 MB per run, read by the launcher, and goes with the run', async () => {
    await clear();
    const run = (await launch('wes', { step: { debug: true, every: true } })).json() as {
      id: string;
    };
    const at = { pause: 'p-1', node: FACTS, play: '[facts] Read a few facts' };
    const scopes: InspectAnswer = { host: 'localhost', scopes: [{ id: 'host', name: 'Host' }] };
    expect(
      await keepDebug(db(), run.id, at, { op: 'scopes', host: 'localhost', answer: scopes }),
    ).toBe(true);
    // The same question again replaces the answer.
    expect(
      await keepDebug(db(), run.id, at, { op: 'scopes', host: 'localhost', answer: scopes }),
    ).toBe(true);
    const big: InspectAnswer = { value: 'x'.repeat(MAX_DEBUG_BYTES) };
    expect(await keepDebug(db(), run.id, at, { op: 'watch', exprs: ['a'], answer: big })).toBe(
      false,
    );
    const kept = await debugKept(db(), run.id);
    expect(kept).toEqual([
      {
        ...at,
        entries: [{ op: 'scopes', host: 'localhost', answer: scopes, at: expect.any(String) }],
      },
    ]);
    const read = await app.inject({ url: `/api/v1/runs/${run.id}/debug`, headers: as('wes') });
    expect(read.statusCode).toBe(200);
    expect(read.json().pauses).toHaveLength(1);
    expect(
      (await app.inject({ url: `/api/v1/runs/${run.id}/debug`, headers: as('omar') })).statusCode,
    ).toBe(403);
    await queue.cancel(run.id, 'wes');
    await pruneRuns(db(), { days: 0, perFlow: 0 }, (id) => join(root, `${id}.out`));
    expect(await debugKept(db(), run.id)).toEqual([]);
  });
});

describe('MCP', () => {
  it('run_inspect only with a token that allows run control', async () => {
    const agent = async (token: string) => {
      const client = new Client({ name: 'test-agent', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      return client;
    };
    const plain = await agent(tokens.wes as string);
    const drives = await agent(tokens.wesDrives as string);
    const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
    expect(await names(plain)).not.toContain('run_inspect');
    expect(await names(drives)).toContain('run_inspect');
    const run = await going('wes');
    driving.set(run.id, {
      paused: true,
      sent: [],
      answer: { host: 'localhost', masked: 'external', type: 'masked' },
      asked: [],
    });
    const r = (await drives.callTool({
      name: 'run_inspect',
      arguments: { run: run.id, op: 'eval', host: 'localhost', expr: 'api_token' },
    })) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0]?.text ?? '{}')).toMatchObject({ masked: 'external' });
    const no = (await plain.callTool({
      name: 'run_inspect',
      arguments: { run: run.id, op: 'scopes', host: 'localhost' },
    })) as { isError?: boolean };
    expect(no.isError).toBe(true);
    driving.delete(run.id);
    await queue.finish(run.id, run.token, 'succeeded');
    await plain.close();
    await drives.close();
  });
});

describe('the executor', () => {
  it('passes debug and the failure filters to the engine, asks the driver, keeps what it showed', async () => {
    await clear();
    const pause: StepPause = {
      id: 'p-9',
      node: FACTS,
      play: '[facts] Read a few facts',
      hosts: ['localhost'],
      since: Date.now() / 1000,
      timeout: 1800,
      kind: 'failure',
      failed: [{ host: 'localhost', task: 'Read', msg: 'boom' }],
      attempt: 1,
      debug: true,
    };
    const sent: StepCommand[] = [];
    const asked: string[] = [];
    let failures: FailureFilters | undefined;
    let release: () => void = () => undefined;
    const answered = new Promise<void>((r) => {
      release = r;
    });
    let paused: StepPause | undefined = pause;
    const requests: RunFlowRequest[] = [];
    const runner = async (request: RunFlowRequest, hooks: RunFlowHooks): Promise<RunView> => {
      requests.push(request);
      const driver: StepDriver = {
        send: async (command) => {
          sent.push(command);
          if (command !== 'retry') {
            paused = undefined;
            release();
          }
          return undefined;
        },
        setPoints: async () => undefined,
        setFailures: async (next) => {
          failures = next;
          return undefined;
        },
        paused: () => paused,
        control: () => ({ v: 1, command: 'step', points: [], reply: null }),
        inspect: async (op, args = {}) => {
          asked.push(op);
          if (op === 'watch')
            return { results: [{ host: 'localhost', expr: args.exprs?.[0] ?? '', value: 1 }] };
          return { host: args.host ?? '', scopes: [{ id: 'host', name: 'Host variables' }] };
        },
      };
      const done = hooks.started?.(async () => undefined, driver);
      const base = { id: request.id, mode: request.mode, startedAt: request.startedAt };
      hooks.report({
        ...base,
        state: 'running',
        step: { every: false, points: [], pauses: 1, debug: true, paused },
      } as RunView);
      await Promise.race([
        answered,
        new Promise((r) => request.signal?.addEventListener('abort', r)),
      ]);
      done?.();
      return { ...base, state: 'done', rc: 0 } as RunView;
    };
    const ex = new Executor(
      {
        db: db(),
        git,
        sync,
        queue,
        key,
        log: createLogger({ level: 'silent', format: 'json', write: () => undefined }),
      },
      {
        dataDir: join(root, `data-${Math.random().toString(36).slice(2)}`),
        engine: 'docker',
        image: 'afd-ee:2.19',
        worker: 'test-worker',
        slots: 2,
        timeoutMs: 60_000,
        heartbeatMs: 30,
        pollMs: 20,
        runner,
      },
    );
    const run = (
      await launch('wes', { step: { debug: true, points: [FACTS], pauseOnFailure: true } })
    ).json() as { id: string };
    await ex.start();
    const end = Date.now() + 5000;
    while (!(await queue.get(run.id))?.pausedBefore && Date.now() < end)
      await new Promise((r) => setTimeout(r, 20));
    expect(requests[0]?.step).toMatchObject({
      every: false,
      points: [FACTS],
      debug: true,
      failures: { failed: true },
    });
    expect(await ex.inspect(run.id, { op: 'scopes', host: 'localhost' })).toMatchObject({
      scopes: [{ id: 'host' }],
    });
    expect(await ex.inspect(run.id, { op: 'watch', exprs: ['vlan_id'] })).toMatchObject({
      results: [{ value: 1 }],
    });
    await ex.inspect(run.id, { op: 'eval', host: 'localhost', expr: 'vlan_id' });
    expect(asked).toEqual(['scopes', 'watch', 'eval']);
    // Scopes and watches are kept with the run, not evaluates.
    const kept = await debugKept(db(), run.id);
    expect(kept[0]?.entries.map((e) => e.op)).toEqual(['scopes', 'watch']);
    expect(
      await ex.drive(run.id, { failures: { failed: true, unreachable: true } }, 'wes'),
    ).toEqual({ paused: true });
    expect(failures).toEqual({ failed: true, unreachable: true });
    expect(await ex.drive(run.id, { command: 'retry' }, 'wes')).toEqual({ paused: true });
    expect(await ex.drive(run.id, { command: 'continue' }, 'wes')).toEqual({ paused: true });
    expect(sent).toEqual(['retry', 'continue']);
    const finished = Date.now() + 5000;
    while ((await queue.get(run.id))?.state === 'running' && Date.now() < finished)
      await new Promise((r) => setTimeout(r, 20));
    expect(readFileSync(ex.outputFile(run.id), 'utf8')).toContain('Retry by wes');
    expect(await ex.inspect(run.id, { op: 'scopes', host: 'localhost' })).toBeUndefined();
    await ex.stop();
  });
});

// Round 1 of the 1.2 exploration (AFS-249, AFS-250, AFS-253).
describe('round 1 fixes', () => {
  it('AFS-250: watches are kept per person and flow by the server', async () => {
    const at = `/api/v1/projects/${project.id}/watches?path=${FILE}`;
    const put = (who: string, exprs: string[]) =>
      app.inject({ method: 'PUT', url: at, headers: as(who), payload: { exprs } });
    const read = async (who: string) =>
      (await app.inject({ url: at, headers: as(who) })).json().exprs;
    expect((await put('wes', ['vlan_id', ' site ', 'vlan_id'])).json()).toEqual({
      exprs: ['vlan_id', 'site'],
    });
    // Another person on the same flow has their own (none yet), and keeps their own.
    expect(await read('omar')).toEqual([]);
    expect((await put('omar', ['inventory_hostname'])).statusCode).toBe(200);
    expect(await read('wes')).toEqual(['vlan_id', 'site']);
    expect(await read('omar')).toEqual(['inventory_hostname']);
    // A reader may read their (empty) list, not keep one; too many are refused.
    expect(await read('rita')).toEqual([]);
    expect((await put('rita', ['x'])).statusCode).toBe(403);
    expect(
      (
        await put(
          'wes',
          Array.from({ length: 21 }, (_, i) => `v${i}`),
        )
      ).statusCode,
    ).toBe(400);
    // None: the row goes.
    expect((await put('wes', [])).json()).toEqual({ exprs: [] });
    expect(await read('wes')).toEqual([]);
    const audit = (await listAudit(db(), { action: 'project.watches' })).entries;
    expect(audit.filter((e) => e.result === 'ok').length).toBeGreaterThanOrEqual(3);
  });

  it('AFS-253: a reader is refused inspect in the words of who may; conditions stay the driver’s', async () => {
    await clear();
    const point = { node: FACTS, condition: 'site == "c6-secret-cond"', log: 'at {{ site }}' };
    const run = (await launch('wes', { step: { debug: true, points: [point] } })).json() as {
      id: string;
    };
    const refused = await post('rita', `/api/v1/runs/${run.id}/inspect`, { op: 'scopes' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toBe(
      'Only who launched this debug run, or an administrator, looks into its variables',
    );
    const seen = async (who: string) =>
      (await app.inject({ url: `/api/v1/runs/${run.id}`, headers: as(who) })).json().step.points;
    expect(await seen('wes')).toEqual([point]);
    expect(await seen('dana')).toEqual([point]);
    expect(await seen('rita')).toEqual([FACTS]);
    expect(await seen('omar')).toEqual([FACTS]);
    const listed = (
      await app.inject({ url: `/api/v1/runs?project=${project.id}`, headers: as('rita') })
    ).json() as { id: string; step?: { points?: unknown[] } }[];
    expect(listed.find((r) => r.id === run.id)?.step?.points).toEqual([FACTS]);
    await queue.cancel(run.id, 'wes');
  });

  it('AFS-249: a scope opened at a pause is kept with its values, beside the scopes', async () => {
    await clear();
    const run = (await launch('wes', { step: { debug: true, every: true } })).json() as {
      id: string;
    };
    const at = { pause: 'p-9', node: FACTS };
    const scopes: InspectAnswer = { scopes: [{ id: 'inputs', name: 'Step inputs' }] };
    const opened: InspectAnswer = { children: [{ name: 'site', type: 'str', value: 'local' }] };
    await keepDebug(db(), run.id, at, { op: 'scopes', host: 'localhost', answer: scopes });
    await keepDebug(db(), run.id, at, {
      op: 'vars',
      host: 'localhost',
      scope: 'inputs',
      answer: opened,
    });
    await keepDebug(db(), run.id, at, {
      op: 'vars',
      host: 'localhost',
      scope: 'host',
      answer: opened,
    });
    const [kept] = await debugKept(db(), run.id);
    expect(kept?.entries.map((e) => [e.op, e.scope])).toEqual([
      ['scopes', undefined],
      ['vars', 'inputs'],
      ['vars', 'host'],
    ]);
    expect(kept?.entries[1]?.answer).toEqual(opened);
    await queue.cancel(run.id, 'wes');
  });
});

describe('round 2 fixes', () => {
  it('AFS-259: readers get no point conditions, log messages or log lines in /view and /events', async () => {
    const run = await going('wes');
    const point = { node: FACTS, condition: 'site != "c6-secret-cond"', log: 'MARK {{ site }}' };
    const view = {
      id: run.id,
      mode: 'check',
      state: 'running',
      step: {
        every: false,
        points: [FACTS],
        settings: [point],
        pauses: 1,
        debug: true,
        hits: { [FACTS]: 1 },
        logs: [{ node: FACTS, host: 'localhost', message: 'MARK c6-site', ts: 1 }],
      },
    };
    await db()
      .updateTable('run')
      .set({ view_json: JSON.stringify(view) })
      .where('id', '=', run.id)
      .execute();
    const viewOf = async (who: string) =>
      (await app.inject({ url: `/api/v1/runs/${run.id}/view`, headers: as(who) })).json();
    expect((await viewOf('wes')).step.settings).toEqual([point]);
    expect((await viewOf('dana')).step.logs).toHaveLength(1);
    for (const who of ['rita', 'omar']) {
      const seen = await viewOf(who);
      expect(seen.step.settings).toEqual([{ node: FACTS }]);
      expect(seen.step.logs).toBeUndefined();
      expect(seen.step.hits).toEqual({ [FACTS]: 1 });
      expect(JSON.stringify(seen)).not.toMatch(/c6-secret-cond|MARK/);
    }
    // The stream of a run that ended: its record and view, read whole.
    await queue.finish(run.id, run.token, 'succeeded');
    await db()
      .updateTable('run')
      .set({ view_json: JSON.stringify(view) })
      .where('id', '=', run.id)
      .execute();
    const events = async (who: string) =>
      (await app.inject({ url: `/api/v1/runs/${run.id}/events`, headers: as(who) })).body;
    expect(await events('wes')).toContain('MARK c6-site');
    const read = await events('rita');
    expect(read).toContain('event: view');
    expect(read).not.toMatch(/c6-secret-cond|MARK/);
  });

  it('AFS-259: a log point line in the output is where, not what, for a reader', () => {
    const esc = String.fromCharCode(27);
    const output = [
      'TASK [ping] ***',
      'Log point Pre-checks · sw-edge-01: MARK sw-edge-01 site=c6ok',
      `${esc}[0;32mLog point Push: baseline · sw-edge-02: MARK x: y${esc}[0m`,
      'Log point Backup · sw-edge-03: the condition failed: site is undefined',
      'ok: [sw-edge-01]',
    ].join('\n');
    const read = outputForReader(output);
    expect(read).not.toMatch(/MARK|site/);
    expect(read.split('\n')).toEqual([
      'TASK [ping] ***',
      'Log point Pre-checks · sw-edge-01: (only who launched the run reads this)',
      `${esc}[0;32mLog point Push: baseline · sw-edge-02: (only who launched the run reads this)`,
      'Log point Backup · sw-edge-03: (only who launched the run reads this)',
      'ok: [sw-edge-01]',
    ]);
  });

  it('AFS-259: Evaluate takes {{ }}; AFS-258: a refused expression is audited as refused', async () => {
    const run = await going('wes');
    const at = `/api/v1/runs/${run.id}/inspect`;
    driving.set(run.id, { paused: true, sent: [], answer: { value: 'localhost' }, asked: [] });
    const braces = await post('wes', at, {
      op: 'eval',
      host: 'localhost',
      expr: '{{ inventory_hostname }}',
    });
    expect(braces.statusCode).toBe(200);
    await post('wes', at, { op: 'watch', exprs: ['{{ a }}', 'b'] });
    expect(driving.get(run.id)?.asked).toEqual([
      { op: 'eval', host: 'localhost', expr: 'inventory_hostname' },
      { op: 'watch', exprs: ['a', 'b'] },
    ]);
    expect(bareExpr('{{ foo(')).toBe('foo(');
    expect(bareExpr('{% if x %}')).toBe('{% if x %}');
    driving.set(run.id, {
      paused: true,
      sent: [],
      answer: { refused: true, error: 'lookup is not allowed' },
      asked: [],
    });
    const refused = await post('wes', at, {
      op: 'eval',
      host: 'localhost',
      expr: "lookup('pipe', 'id')",
    });
    expect(refused.statusCode).toBe(200);
    const entries = (await listAudit(db(), { action: 'run.debug.inspect' })).entries;
    const last = entries.find((e) => e.detail?.expr === "lookup('pipe', 'id')");
    expect(last?.result).toBe('refused');
    // As sent: with its braces.
    expect(entries.some((e) => e.detail?.expr === '{{ inventory_hostname }}')).toBe(true);
    driving.delete(run.id);
    await queue.finish(run.id, run.token, 'succeeded');
  });

  it('AFS-258: a reader refused Step of a debug run is told who drives it', async () => {
    const run = await going('wes');
    const step = (who: string, command: string) =>
      post(who, `/api/v1/runs/${run.id}/step`, { command });
    const rita = await step('rita', 'continue');
    expect(rita.statusCode).toBe(403);
    expect(rita.json().message).toBe(
      'Only wes (who launched it) or an administrator drives this debug run',
    );
    // Stop is an operator's: a reader is told that.
    expect((await step('rita', 'stop')).json().message).toBe('This needs operator here');
    await queue.finish(run.id, run.token, 'cancelled');
  });

  it('AFS-258: a pause keeps the time it was first looked at', async () => {
    await clear();
    const run = (await launch('wes', { step: { debug: true, every: true } })).json() as {
      id: string;
    };
    const at = { pause: 'p-10', node: FACTS };
    const scopes: InspectAnswer = { scopes: [{ id: 'inputs', name: 'Step inputs' }] };
    const first = new Date('2030-01-02T10:15:10.000Z');
    await keepDebug(db(), run.id, at, { op: 'scopes', host: 'a', answer: scopes }, first);
    await keepDebug(
      db(),
      run.id,
      at,
      { op: 'scopes', host: 'a', answer: { scopes: [{ id: 'host', name: 'Host variables' }] } },
      new Date('2030-01-02T10:19:18.000Z'),
    );
    const [kept] = await debugKept(db(), run.id);
    expect(kept?.entries).toHaveLength(1);
    expect((kept?.entries[0]?.at ?? '') <= '2030-01-02T10:15:10.999Z').toBe(true);
    expect(kept?.entries[0]?.answer.scopes?.[0]?.id).toBe('host');
    await queue.cancel(run.id, 'wes');
  });
});
