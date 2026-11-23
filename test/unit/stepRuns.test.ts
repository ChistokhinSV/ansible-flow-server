// AFS-177: step-by-step runs on the server. A launch asks for one (API, MCP); Step, Continue, Pause
// and Stop reach the run's driver through POST /runs/:id/step for whoever may stop the run, are
// audited, and are refused plainly when they do not fit; a paused run keeps its lease; a paused
// run whose server went away ends as stopped; MCP's run_step only with a token that allows it.
// Ansible is played by the test here; test/e2e/stepRun.test.ts runs the real thing in a container.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunView } from '@ansible-flow/core/protocol';
import type { StepCommand, StepPause } from '@ansible-flow/core/run/step';
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
import { createProject, createWorkspace, type Project } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { Executor } from '../../src/server/runs/executor';
import { RunQueue } from '../../src/server/runs/queue';
import { refusalFor, type Stepper, stepAsked } from '../../src/server/runs/stepping';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { type TestRepo, testRepo } from './helpers/repo';

const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const HELLO = readFileSync(join(__dirname, '../fixtures/hello.flow.yaml'), 'utf8');
const PING = '01M6GPM979RJPCDJ0XFF22GBSV';
const FACTS = '01M6GPM99KC9TX091MCH61REQV';
const root = mkdtempSync(join(tmpdir(), 'afs-step-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let database: Database;
let git: Git;
let sync: ProjectSync;
let queue: RunQueue;
let source: TestRepo;
let project: Project;
let config: string;
let app: FastifyInstance;
let url: string;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
/** What the test's executor answers for runs "going here". */
const driving = new Map<string, { paused: boolean; sent: string[] }>();
const stepper: Stepper = {
  async drive(run, ask) {
    const going = driving.get(run);
    if (!going) return undefined;
    const refused = ask.command ? refusalFor(ask.command, going.paused) : undefined;
    if (refused) return { error: refused };
    if (ask.command) going.sent.push(ask.command);
    if (ask.points) going.sent.push(`points:${ask.points.join(',')}`);
    return { paused: going.paused };
  },
};
const db = () => database.db;
const until = async (check: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Waited too long');
};

beforeAll(async () => {
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  const log = createLogger({ level: 'silent', format: 'json', write: () => undefined });
  git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
  sync = new ProjectSync(db(), git, log);
  queue = new RunQueue(db(), 'sqlite', key, { maxRuns: 4, perProject: 4 });
  source = testRepo({
    'flows/hello.flow.yaml': HELLO,
    'inventory/hosts.yaml': 'all:\n  hosts:\n    localhost: {}\n',
  });
  const net = await createWorkspace(db(), { key: 'net', name: 'Network' });
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
      flowFile: 'flows/hello.flow.yaml',
      inventory: 'inventory/hosts.yaml',
      inputs: { devices: ['localhost'] },
    })
  ).id;
  // dana administers; omar operates the flow; rita reads it.
  for (const [login, admin] of [
    ['dana', true],
    ['omar', false],
    ['rita', false],
  ] as const)
    ids[login] = (
      await createUser(db(), { login, name: login, password: 'x'.repeat(12), admin })
    ).id;
  const flow = { project: project.id, flow: 'flows/hello.flow.yaml' };
  await createGrant(db(), net.id, { user: 'omar', level: 'operator', ...flow }, 'dana');
  await createGrant(db(), net.id, { user: 'rita', level: 'ro' }, 'dana');
  const make = async (who: string, extra: object = {}) =>
    (await createToken(db(), ids[who] as string, { name: 't', ...extra })).token;
  tokens.dana = await make('dana');
  tokens.omar = await make('omar');
  tokens.omarDrives = await make('omar', { mcpRunControl: true });
  tokens.rita = await make('rita');
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
/** Nothing waits in the queue: each test claims its own runs. */
const clear = async () => {
  for (const r of await queue.list({ state: 'queued' })) await queue.cancel(r.id, 'dana');
};
const step = (who: string, run: string, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/v1/runs/${run}/step`, headers: as(who), payload: body });

describe('what a launch asks for', () => {
  it('every step by default, pause points, and no longer a pause than the server allows', () => {
    expect(stepAsked(undefined, 60)).toBeUndefined();
    expect(stepAsked({ every: true }, 60)).toEqual({ every: true, points: [], timeoutS: 3600 });
    expect(stepAsked({ points: [PING, PING] }, 60)).toEqual({
      every: false,
      points: [PING],
      timeoutS: 3600,
    });
    expect(stepAsked({ every: true, timeoutMinutes: 5 }, 60)).toMatchObject({ timeoutS: 300 });
    expect(stepAsked({ every: false }, 60)).toEqual({ error: expect.stringContaining('pause') });
    expect(stepAsked({ every: true, timeoutMinutes: 90 }, 60)).toEqual({
      error: expect.stringContaining('at most 60 minutes'),
    });
  });

  it('Step and Continue answer a pause; Pause pauses a run that goes; Stop fits both', () => {
    expect(refusalFor('step', false)).toMatch(/not paused/);
    expect(refusalFor('continue', false)).toMatch(/not paused/);
    expect(refusalFor('pause', true)).toMatch(/paused already/);
    for (const c of ['step', 'continue', 'stop'] as StepCommand[])
      expect(refusalFor(c, true)).toBeUndefined();
    expect(refusalFor('pause', false)).toBeUndefined();
    expect(refusalFor('stop', false)).toBeUndefined();
  });
});

describe('the API', () => {
  it('launches step by step for an operator, with the server setting as the longest pause', async () => {
    const made = await launch('omar', { step: { every: true, points: [FACTS] } });
    expect(made.statusCode).toBe(201);
    expect(made.json().step).toEqual({ every: true, points: [FACTS], timeoutS: 1800 });
    const long = await launch('omar', { step: { every: true, timeoutMinutes: 31 } });
    expect(long.statusCode).toBe(400);
    expect(long.json()).toMatchObject({ field: 'step', message: expect.stringContaining('30') });
    // A read-only person may not launch, step by step or not.
    expect((await launch('rita', { step: { every: true } })).statusCode).toBe(403);
    const entry = (await listAudit(db(), { action: 'run.launch' })).entries.find(
      (e) => e.result === 'ok',
    );
    expect(entry?.detail).toMatchObject({ step: 'every step' });
    // The API catalog lists the route with who may call it.
    const doc = (await app.inject({ url: '/api/v1/openapi.json' })).json();
    expect(doc.paths['/api/v1/runs/{id}/step'].post.description).toContain('operator');
  });

  it('drives a run going here for an operator or an administrator, audited with the command', async () => {
    await clear();
    const run = (await launch('dana', { step: { every: true } })).json();
    const job = await queue.claim('w');
    expect(job?.run.id).toBe(run.id);
    await queue.start(run.id, job?.token as string);
    driving.set(run.id, { paused: true, sent: [] });
    // rita reads the flow: she may not drive its runs.
    expect((await step('rita', run.id, { command: 'step' })).statusCode).toBe(403);
    // omar is operator on the flow: he may, though dana launched it.
    const stepped = await step('omar', run.id, { command: 'step' });
    expect(stepped.statusCode).toBe(202);
    expect(stepped.json()).toMatchObject({ id: run.id, sent: 'step' });
    // AFS-205: the reply to Step does not say the run is paused (its record says so a moment
    // later): the page's bar does not stay "Paused before".
    await db().updateTable('run').set({ step_paused: 'Push' }).where('id', '=', run.id).execute();
    driving.set(run.id, { paused: true, sent: ['step'] });
    const again = await step('omar', run.id, { command: 'continue' });
    expect(again.json().pausedBefore).toBeUndefined();
    expect((await queue.get(run.id))?.pausedBefore).toBe('Push');
    // ... and a paused run is listed as paused, and among the runs that wait.
    expect((await queue.list({ state: 'paused' })).map((r) => r.id)).toEqual([run.id]);
    expect((await queue.list({ state: 'waiting' })).map((r) => r.id)).toContain(run.id);
    await db().updateTable('run').set({ step_paused: null }).where('id', '=', run.id).execute();
    driving.set(run.id, { paused: true, sent: ['step'] });
    expect((await step('dana', run.id, { points: [PING] })).statusCode).toBe(202);
    // Pause does not fit a paused run.
    const pause = await step('dana', run.id, { command: 'pause' });
    expect(pause.statusCode).toBe(409);
    expect(pause.json().message).toBe('The run is paused already');
    expect(driving.get(run.id)?.sent).toEqual(['step', `points:${PING}`]);
    const entries = (await listAudit(db(), { action: 'run.step' })).entries;
    expect(entries.map((e) => [e.actor?.login, e.result, e.detail?.command])).toEqual([
      ['dana', 'refused', 'pause'],
      ['dana', 'ok', 'points'],
      ['omar', 'ok', 'continue'],
      ['omar', 'ok', 'step'],
      // Refused before the route reads the body: the entry has no command.
      ['rita', 'refused', undefined],
    ]);
    driving.delete(run.id);
    // Not going here (another server of the group has it): said so.
    const elsewhere = await step('dana', run.id, { command: 'continue' });
    expect(elsewhere.statusCode).toBe(409);
    expect(elsewhere.json().message).toMatch(/another server/);
    await queue.finish(run.id, job?.token as string, 'succeeded');
  });

  it('refuses plainly: not step by step, ended, not started; Stop of a queued one stops it', async () => {
    const plain = (await launch('dana')).json();
    const notStep = await step('dana', plain.id, { command: 'step' });
    expect(notStep.statusCode).toBe(409);
    expect(notStep.json().message).toBe('This run is not step by step');
    const queued = (await launch('dana', { step: { every: true } })).json();
    const early = await step('dana', queued.id, { command: 'continue' });
    expect(early.json().message).toBe('The run has not started yet');
    const stopped = await step('dana', queued.id, { command: 'stop' });
    expect(stopped.statusCode).toBe(202);
    expect(stopped.json().state).toBe('cancelled');
    const ended = await step('dana', queued.id, { command: 'step' });
    expect(ended.statusCode).toBe(409);
    expect(ended.json().message).toBe('The run has ended');
    expect((await step('dana', queued.id, {})).statusCode).toBe(400);
    await queue.cancel(plain.id, 'dana');
  });

  it('keeps each person their pause points per flow', async () => {
    const at = `/api/v1/projects/${project.id}/pause-points?path=flows/hello.flow.yaml`;
    expect((await app.inject({ url: at, headers: as('omar') })).json()).toEqual({ points: [] });
    const put = await app.inject({
      method: 'PUT',
      url: at,
      headers: as('omar'),
      payload: { points: [PING, FACTS, PING] },
    });
    expect(put.json()).toEqual({ points: [PING, FACTS] });
    expect((await app.inject({ url: at, headers: as('omar') })).json().points).toEqual([
      PING,
      FACTS,
    ]);
    // Each person's own: dana has none; rita reads the flow and may not keep any.
    expect((await app.inject({ url: at, headers: as('dana') })).json().points).toEqual([]);
    expect(
      (await app.inject({ method: 'PUT', url: at, headers: as('rita'), payload: { points: [] } }))
        .statusCode,
    ).toBe(403);
  });
});

describe('MCP', () => {
  const agent = async (token: string) => {
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
  const call = async (client: Client, tool: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name: tool, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };

  it('run_step only with a token that allows run control; run_launch steps when asked', async () => {
    const plain = await agent(tokens.omar as string);
    const drives = await agent(tokens.omarDrives as string);
    const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
    expect(await names(plain)).not.toContain('run_step');
    expect(await names(drives)).toContain('run_step');
    await clear();
    const launched = await call(plain, 'run_launch', { config, mode: 'check', step: true });
    const run = JSON.parse(launched.text).run as string;
    expect((await queue.get(run))?.step).toMatchObject({ every: true });
    const job = await queue.claim('w');
    await queue.start(run, job?.token as string);
    driving.set(run, { paused: true, sent: [] });
    const no = await call(plain, 'run_step', { run, command: 'continue' });
    expect(no.isError).toBe(true);
    expect(no.text).toContain('may not drive step-by-step runs');
    const yes = await call(drives, 'run_step', { run, command: 'continue' });
    expect(yes).toEqual({ isError: false, text: expect.stringContaining('continue sent') });
    expect(driving.get(run)?.sent).toEqual(['continue']);
    expect((await listAudit(db(), { action: 'run.step' })).entries[0]).toMatchObject({
      source: 'mcp',
      actor: { login: 'omar' },
    });
    driving.delete(run);
    await queue.finish(run, job?.token as string, 'succeeded');
    await plain.close();
    await drives.close();
  });
});

describe('the queue', () => {
  it('a paused run whose server went away ends as stopped, saying why; others are lost', async () => {
    await clear();
    const paused = (await launch('dana', { step: { every: true } })).json();
    const going = (await launch('dana', { step: { every: true } })).json();
    const at = new Date();
    for (const id of [paused.id, going.id]) {
      let job = await queue.claim('gone', at);
      while (job && job.run.id !== id) job = await queue.claim('gone', at);
      await queue.start(id, job?.token as string, at);
      if (id === paused.id) {
        await queue.setPaused(id, job?.token as string, 'Read a few facts');
        await queue.saveView(id, {
          state: 'running',
          step: { paused: { node: FACTS, hosts: ['localhost'] }, every: true, points: [] },
        });
      }
    }
    expect((await queue.get(paused.id))?.pausedBefore).toBe('Read a few facts');
    const counts = await queue.expire(new Date(at.getTime() + 120_000));
    expect(counts.cancelled).toBe(1);
    const after = await queue.get(paused.id);
    expect(after?.state).toBe('cancelled');
    expect(after?.error).toBe(
      'Stopped: the server restarted while the run was paused before Read a few facts; a paused run cannot go on after a restart',
    );
    expect(after?.pausedBefore).toBeUndefined();
    expect(await queue.view(paused.id)).toMatchObject({
      state: 'error',
      errorCode: 'cancelled',
      stoppedAt: FACTS,
    });
    expect((await queue.get(going.id))?.state).toBe('lost');
  });
});

describe('the executor', () => {
  /**
   * Ansible played by the test, as the designer's runFlow drives a step-by-step run: it hands a
   * driver, reports a pause, and ends as the driver's commands say.
   */
  /** reportOnAbort: like the real runner, one more view (no pause) as the stopped process ends. */
  const stepping = (opts: { reportOnAbort?: boolean } = {}) => {
    const sent: string[] = [];
    let points: string[] = [];
    let release: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused: StepPause | undefined = {
      id: 't-1',
      node: FACTS,
      play: '[facts] Read a few facts',
      hosts: ['localhost'],
      since: Date.now() / 1000,
      timeout: 1800,
    };
    const requests: RunFlowRequest[] = [];
    const runner = async (request: RunFlowRequest, hooks: RunFlowHooks): Promise<RunView> => {
      requests.push(request);
      const driver: StepDriver = {
        send: async (command) => {
          sent.push(command);
          paused = undefined;
          release();
          return undefined;
        },
        setPoints: async (next) => {
          points = next;
          return undefined;
        },
        paused: () => paused,
        control: () => ({ v: 1, command: 'step', points, reply: null }),
      };
      const done = hooks.started?.(async () => undefined, driver);
      const base = { id: request.id, mode: request.mode, startedAt: request.startedAt };
      const step = { every: true, points: [], pauses: 1 };
      hooks.report({ ...base, state: 'running', step: { ...step, paused } } as RunView);
      await Promise.race([
        answered,
        new Promise((r) => request.signal?.addEventListener('abort', r)),
      ]);
      if (opts.reportOnAbort && request.signal?.aborted)
        hooks.report({
          ...base,
          state: 'running',
          step: { ...step, paused: undefined },
        } as RunView);
      done?.();
      const stopped = sent.includes('stop');
      return {
        ...base,
        state: stopped || request.signal?.aborted ? 'error' : 'done',
        rc: stopped ? 2 : 0,
        ...(stopped
          ? {
              errorCode: 'cancelled',
              stoppedAt: FACTS,
              error: 'Stopped before Read a few facts',
              step: { ...step, stopped: { node: FACTS, hosts: ['localhost'], reason: 'driver' } },
            }
          : {}),
      } as RunView;
    };
    return { runner, sent, requests };
  };
  const executor = (runner: ReturnType<typeof stepping>['runner']) =>
    new Executor(
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
  const lease = async (id: string) =>
    (await db().selectFrom('run').select('lease_until').where('id', '=', id).executeTakeFirst())
      ?.lease_until;

  it('keeps the lease while paused, drives the run, and ends a Stop as stopped by whom', async () => {
    await clear();
    const fake = stepping();
    const ex = executor(fake.runner);
    const run = (await launch('omar', { step: { every: true, points: [PING] } })).json();
    await ex.start();
    await until(async () => (await queue.get(run.id))?.pausedBefore === 'Read a few facts');
    expect(fake.requests[0]?.step).toEqual({ every: true, points: [PING], timeoutS: 1800 });
    const first = await lease(run.id);
    await new Promise((r) => setTimeout(r, 200));
    // Paused: still running, still this worker's, its lease kept alive by the heartbeat.
    expect((await queue.get(run.id))?.state).toBe('running');
    expect(String(await lease(run.id)) > String(first)).toBe(true);
    expect(await ex.drive(run.id, { command: 'pause' }, 'omar')).toEqual({
      error: 'The run is paused already',
      paused: true,
    });
    expect(await ex.drive(run.id, { command: 'stop' }, 'omar')).toEqual({ paused: true });
    await until(async () => (await queue.get(run.id))?.state === 'cancelled');
    const after = await queue.get(run.id);
    expect(after?.error).toBe('Stopped by omar before Read a few facts');
    expect(after?.pausedBefore).toBeUndefined();
    expect(await ex.drive(run.id, { command: 'step' }, 'omar')).toBeUndefined();
    await ex.stop();
  });

  it('AFS-205: who went on is in the output; pause points set while it goes are kept with whose', async () => {
    await clear();
    const fake = stepping();
    const ex = executor(fake.runner);
    const run = (await launch('omar', { step: { every: true } })).json();
    await ex.start();
    await until(async () => (await queue.get(run.id))?.pausedBefore === 'Read a few facts');
    expect(await ex.drive(run.id, { points: [PING] }, 'dana')).toEqual({ paused: true });
    expect((await queue.get(run.id))?.step).toMatchObject({ points: [PING], pointsBy: 'dana' });
    expect(await ex.drive(run.id, { command: 'continue' }, 'omar')).toEqual({ paused: true });
    await until(async () => (await queue.get(run.id))?.state === 'succeeded');
    const output = readFileSync(ex.outputFile(run.id), 'utf8');
    expect(output).toContain('Continue by omar');
    await ex.stop();
  });

  it('AFS-231: still stopped, not failed, when the run reports once more as it ends', async () => {
    await clear();
    const fake = stepping({ reportOnAbort: true });
    const ex = executor(fake.runner);
    const run = (await launch('omar', { step: { every: true } })).json();
    await ex.start();
    await until(async () => (await queue.get(run.id))?.pausedBefore === 'Read a few facts');
    await ex.stop();
    const after = await queue.get(run.id);
    expect(after?.state).toBe('cancelled');
    expect(after?.error).toContain('while the run was paused before Read a few facts');
  });

  it('a server that stops while a run is paused ends it as stopped, not failed', async () => {
    await clear();
    const fake = stepping();
    const ex = executor(fake.runner);
    const run = (await launch('omar', { step: { every: true } })).json();
    await ex.start();
    await until(async () => (await queue.get(run.id))?.pausedBefore === 'Read a few facts');
    await ex.stop();
    const after = await queue.get(run.id);
    expect(after?.state).toBe('cancelled');
    expect(after?.error).toBe(
      'Stopped: the server stopped while the run was paused before Read a few facts; a paused run cannot go on after a restart',
    );
    const output = readFileSync(ex.outputFile(run.id), 'utf8');
    // AFS-205: the pause is said once, by the run itself (its line), not again by the server.
    expect(output).not.toContain('Paused before Read a few facts (1 host)');
    expect(output).toContain('Stopped: the server stopped while the run was paused');
    expect(output).not.toContain('Stopped on request');
  });
});
