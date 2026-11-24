// AFS-256: how the hosts of a stopped debug run went, from what the real engine records: Ansible in
// a container (the designer's afd_step strategy), driven as the Debugger panel drives it: Stop at a
// failure pause, Retry then Stop, Retry then Step then Stop, Stop before the first step; and a host
// Ansible cannot reach. AFS_TEST_STEP_IMAGE=afd-ee:2.19 npx vitest run
// test/unit/hostSetsDocker.test.ts. Skipped otherwise. AFS_CAPTURE_VIEWS=1 writes each run's view
// to test/fixtures/runs/ (the fixtures hostSets.test.ts reads).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StepPause } from '@ansible-flow/core/run/step';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { closeGates, decideGate, gatesOf } from '../../src/server/approvals/gates';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs } from '../../src/server/launch/configs';
import { prepareLaunch, withoutSecrets } from '../../src/server/launch/prepare';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace, type Project } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { Executor } from '../../src/server/runs/executor';
import {
  type FlowEdge,
  type FlowStep,
  hostSets,
  outcomeLine,
} from '../../src/server/runs/hostSets';
import { RunQueue } from '../../src/server/runs/queue';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { type TestRepo, testRepo } from './helpers/repo';

const image = process.env.AFS_TEST_STEP_IMAGE;
const capture = !!process.env.AFS_CAPTURE_VIEWS;
const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const EDGE = readFileSync(join(__dirname, '../fixtures/edge-baseline.flow.yaml'), 'utf8');
const HELLO = readFileSync(join(__dirname, '../fixtures/hello.flow.yaml'), 'utf8');
const GATE = readFileSync(join(__dirname, '../fixtures/gate-baseline.flow.yaml'), 'utf8');
type Doc = { nodes: FlowStep[]; edges: FlowEdge[] };
const edge = parse(EDGE) as Doc;
const gateDoc = parse(GATE) as Doc;
const helloDoc = parse(HELLO) as Doc;
const hosts = (broken: string[]) =>
  `all:\n  hosts:\n${['sw-edge-01', 'sw-edge-02', 'sw-edge-03', 'sw-edge-04']
    .map(
      (h) =>
        `    ${h}:\n      ansible_connection: local\n${broken.includes(h) ? '      broken: true\n' : ''}`,
    )
    .join('')}`;
const DEVICES = ['sw-edge-01', 'sw-edge-02', 'sw-edge-03', 'sw-edge-04'];

describe.skipIf(!image)('host sets of real stopped runs (AFS-256)', () => {
  const root = mkdtempSync(join(tmpdir(), 'afs-sets-docker-'));
  let database: Database;
  let sync: ProjectSync;
  let queue: RunQueue;
  let source: TestRepo;
  let ex: Executor;
  let git: Git;
  const configs: Record<string, string> = {};

  beforeAll(async () => {
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    const db = database.db;
    const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
    git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
    sync = new ProjectSync(db, git, log);
    queue = new RunQueue(db, 'sqlite', key, { maxRuns: 2, perProject: 2 });
    source = testRepo({
      'flows/edge.flow.yaml': EDGE,
      'flows/hello.flow.yaml': HELLO,
      'flows/gate.flow.yaml': GATE,
      'inventory/local.yaml': [
        'all:',
        '  hosts:',
        '    localhost:',
        '      ansible_connection: local',
        '',
      ].join(String.fromCharCode(10)),
      'inventory/one.yaml': hosts(['sw-edge-02']),
      'inventory/all.yaml': hosts(DEVICES),
      // Fictional: a documentation address nothing answers.
      'inventory/ghost.yaml':
        'all:\n  hosts:\n    localhost:\n      ansible_connection: local\n    c6-ghost:\n      ansible_host: 192.0.2.10\n      ansible_ssh_common_args: -o ConnectTimeout=2\n',
    });
    const workspace = (await createWorkspace(db, { key: 'net', name: 'Network' })).id;
    const project = (await sync.sync(
      (
        await createProject(
          db,
          workspace,
          { key: 'edge', name: 'Edge', gitUrl: source.dir, pollSeconds: 0 },
          true,
        )
      ).id,
    )) as Project;
    const lc = new LaunchConfigs(db, git);
    for (const [name, flowFile, inventory, devices] of [
      ['one', 'flows/edge.flow.yaml', 'inventory/one.yaml', DEVICES],
      ['all', 'flows/edge.flow.yaml', 'inventory/all.yaml', DEVICES],
      ['ghost', 'flows/hello.flow.yaml', 'inventory/ghost.yaml', ['localhost', 'c6-ghost']],
      ['gate', 'flows/gate.flow.yaml', 'inventory/local.yaml', ['localhost']],
    ] as const)
      configs[name] = (
        await lc.create(project.id, {
          name,
          flowFile,
          inventory,
          inputs: { devices: [...devices] },
          ...(name === 'gate' ? { mode: 'real' as const } : {}),
        })
      ).id;
    ex = new Executor(
      { db, git, sync, queue, key, log },
      {
        dataDir: join(root, 'data'),
        engine: 'docker',
        image: image as string,
        worker: 'sets-test',
        slots: 1,
        timeoutMs: 10 * 60_000,
        heartbeatMs: 1000,
        pollMs: 200,
        collectionDir: join(root, 'no-collection'),
      },
    );
    await ex.start();
  });
  afterAll(async () => {
    await ex?.stop();
    await sync?.stop();
    await database?.close();
    source?.remove();
    rmSync(root, { recursive: true, force: true });
  });

  const until = async (what: string, check: () => Promise<boolean>, ms = 180_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Waited too long for ${what}`);
  };
  const pauseOf = async (id: string) =>
    ((await queue.view(id)) as { step?: { paused?: StepPause } } | undefined)?.step?.paused;
  /** Waits for a pause other than the one before, and gives it. */
  const nextPause = async (id: string, before?: string) => {
    await until('a pause', async () => {
      const p = await pauseOf(id);
      return !!p && p.id !== before;
    });
    return (await pauseOf(id)) as StepPause;
  };
  const start = async (config: string, debug: boolean, mode: 'check' | 'real' = 'check') => {
    const c = await new LaunchConfigs(database.db, git).get(config);
    const prepared = await prepareLaunch({ db: database.db, git, sync }, c as never, { mode });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.problems));
    const run = await queue.enqueue(
      {
        ...prepared.launch,
        ...(debug
          ? {
              step: {
                every: true,
                points: [],
                timeoutS: 600,
                debug: true,
                pauseOnFailure: true,
                failures: { failed: true },
              },
            }
          : {}),
      },
      withoutSecrets(prepared.launch, prepared.form.fields).inputs,
      { id: 'u1', login: 'mia' },
      'Edge',
    );
    await ex.fill();
    return run.id;
  };
  const send = async (id: string, command: 'step' | 'continue' | 'retry' | 'stop') =>
    expect(await ex.drive(id, { command }, 'mia')).toEqual({ paused: true });
  /** The run's view once it ended, kept as a fixture when asked; its sets and line. */
  const ended = async (id: string, name: string, state = 'cancelled', doc = edge) => {
    await until('the end', async () => (await queue.get(id))?.state === state);
    const view = await queue.view(id);
    const run = await queue.get(id);
    if (capture) {
      const dir = join(__dirname, '../fixtures/runs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${name}.json`),
        `${JSON.stringify({ state: run?.state, error: run?.error, view }, null, 2)}\n`,
      );
    }
    const sets = hostSets(view as never, doc.nodes, state === 'cancelled', doc.edges);
    return { sets, line: outcomeLine(sets), error: run?.error };
  };

  it('Stop at a failure pause: the failed host failed there, the others stopped after it', async () => {
    const id = await start(configs.one as string, true);
    const first = await nextPause(id);
    expect(first.kind).not.toBe('failure');
    await send(id, 'step');
    const failure = await nextPause(id, first.id);
    expect(failure).toMatchObject({ kind: 'failure', failed: [{ host: 'sw-edge-02' }] });
    await send(id, 'stop');
    const { sets, line, error } = await ended(id, 'stop-at-failure');
    expect(sets.notOk).toEqual(DEVICES);
    expect(sets.failed.map((h) => h.host)).toEqual(['sw-edge-02']);
    expect(sets.stopped.every((h) => h.after)).toBe(true);
    expect(line).toBe(
      'All 4 hosts did not go well: 1 failed at Push baseline, 3 stopped before the end (after Push baseline)',
    );
    expect(error).toMatch(/after Push baseline/);
  }, 600_000);

  it('Retry, then Stop: every host failed at the step', async () => {
    const id = await start(configs.all as string, true);
    const first = await nextPause(id);
    await send(id, 'step');
    const failure = await nextPause(id, first.id);
    expect(failure.kind).toBe('failure');
    await send(id, 'retry');
    const again = await nextPause(id, failure.id);
    expect(again).toMatchObject({ kind: 'failure', attempt: 2 });
    await send(id, 'stop');
    const { sets, line } = await ended(id, 'retry-stop-all');
    expect(sets.total).toBe(4);
    expect(sets.notOk).toEqual(DEVICES);
    expect(line).toBe('All 4 hosts did not go well: 4 failed at Push baseline');
  }, 600_000);

  it('Retry, Step past the failure, then Stop: the failed host went by its fail port', async () => {
    const id = await start(configs.one as string, true);
    const first = await nextPause(id);
    await send(id, 'step');
    const failure = await nextPause(id, first.id);
    await send(id, 'retry');
    const again = await nextPause(id, failure.id);
    await send(id, 'step');
    const next = await nextPause(id, again.id);
    expect(next.kind).not.toBe('failure');
    await send(id, 'stop');
    const { sets } = await ended(id, 'retry-step-stop');
    expect(sets.total).toBe(4);
    expect(sets.notOk).toEqual(DEVICES);
    expect(sets.notOk).not.toContain(null);
  }, 600_000);

  it('Stop before the first step: every host stopped before it', async () => {
    const id = await start(configs.one as string, true);
    await nextPause(id);
    await send(id, 'stop');
    const { sets, line } = await ended(id, 'stop-before-first');
    expect(sets.total).toBe(4);
    expect(line).toBe(
      'All 4 hosts did not go well: 4 stopped before the end (before Push baseline)',
    );
  }, 600_000);

  it('a host Ansible cannot reach is unreachable', async () => {
    const id = await start(configs.ghost as string, false);
    await until('the end', async () =>
      ['failed', 'succeeded'].includes((await queue.get(id))?.state ?? ''),
    );
    const { sets, error } = await ended(id, 'unreachable', (await queue.get(id))?.state, helloDoc);
    expect(sets.unreachable.map((h) => h.host)).toEqual(['c6-ghost']);
    expect(sets.failed).toEqual([]);
    // The banner says what the outcome line says: not reached, not failed.
    expect(error).toBe(
      '1 of 2 hosts could not be reached: c6-ghost (Ansible ended with code 2: one or more hosts could not be reached)',
    );
  }, 600_000);

  const waiting = (id: string) =>
    until('the approval', async () => (await queue.get(id))?.state === 'waiting');

  it('a run stopped while it waits for an approval: its host stopped there', async () => {
    const id = await start(configs.gate as string, false, 'real');
    await waiting(id);
    await queue.cancel(id, 'dana');
    await closeGates(database.db, id, 'dana');
    const { sets, line } = await ended(id, 'stop-at-approval', 'cancelled', gateDoc);
    expect(sets.notOk).toEqual(['localhost']);
    expect(line).toBe('The host did not go well: 1 stopped before the end (at Change approval)');
  }, 600_000);

  it('a rejected run: its host was not approved', async () => {
    const id = await start(configs.gate as string, false, 'real');
    await waiting(id);
    const [gate] = await gatesOf(database.db, id);
    expect(
      await decideGate(database.db, gate?.id as string, {
        status: 'rejected',
        by: 'sam',
        comment: 'Not in the window',
      }),
    ).toBe(true);
    await queue.resume(id);
    await ex.fill();
    const { sets, line } = await ended(id, 'rejected', 'failed', gateDoc);
    expect(sets.notOk).toEqual(['localhost']);
    expect(line).toBe('The host did not go well: 1 not approved at Change approval');
  }, 600_000);
});
