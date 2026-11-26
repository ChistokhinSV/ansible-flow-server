// AFS-179, AFS-223: a real debug run through the server's executor: Ansible in a container with
// the designer's debugger (afd_step, AFD_DEBUG), asked as the Debugger panel asks it. A value read
// from a secret provider (answered by the test) reaches the run's environment and comes back
// masked as "external"; a failing step pauses the run, Retry runs it again (attempt 2).
// Needs a container engine and an image with ansible-core:
// AFS_TEST_STEP_IMAGE=afd-ee:2.19 npx vitest run test/unit/debugRunDocker.test.ts. Skipped otherwise.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StepPause } from '@ansible-flow/core/run/step';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs } from '../../src/server/launch/configs';
import { prepareLaunch, withoutSecrets } from '../../src/server/launch/prepare';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace, type Project } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { debugKept } from '../../src/server/runs/debugStore';
import { Executor } from '../../src/server/runs/executor';
import { RunQueue } from '../../src/server/runs/queue';
import { outputForReader, viewForReader } from '../../src/server/runs/stepping';
import { createCredential } from '../../src/server/secrets/credentials';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import type { Caller } from '../../src/server/secrets/providers/clients';
import { createSecretProvider } from '../../src/server/secrets/providers/store';
import { type TestRepo, testRepo } from './helpers/repo';

const image = process.env.AFS_TEST_STEP_IMAGE;
const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
// The Hello sample, with Say hello failing: a failure pause of a debug run.
const FAILING = readFileSync(join(__dirname, '../fixtures/hello.flow.yaml'), 'utf8').replace(
  'ref: ansible.builtin.debug',
  'ref: ansible.builtin.fail',
);
const SAY_HELLO = '01M6GPM9B1D563X8PKD5041JHV';
// Check the host answers: the step after Start.
const FIRST_STEP = '01M6GPM979RJPCDJ0XFF22GBSV';
// Fictional: what the test's secret provider answers.
const TOKEN = 'lab-device-token-7f3a9c';

describe.skipIf(!image)('a debug run in a container (AFS-179, AFS-223)', () => {
  const root = mkdtempSync(join(tmpdir(), 'afs-debug-docker-'));
  let database: Database;
  let sync: ProjectSync;
  let queue: RunQueue;
  let source: TestRepo;
  let ex: Executor;
  let config: string;
  let git: Git;
  const reads: string[] = [];

  beforeAll(async () => {
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    const db = database.db;
    const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
    git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
    sync = new ProjectSync(db, git, log);
    queue = new RunQueue(db, 'sqlite', key, { maxRuns: 2, perProject: 2 });
    source = testRepo({
      'flows/hello.flow.yaml': FAILING,
      'inventory/hosts.yaml': 'all:\n  hosts:\n    localhost:\n      ansible_connection: local\n',
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
    await createSecretProvider(db, key, {
      key: 'lab-vault',
      name: 'Lab Vault',
      kind: 'vault',
      settings: { address: 'https://vault.lab.example:8200', auth: 'token', timeoutS: 5 },
      secret: { token: 'hvs.fictional' },
      workspaces: [workspace],
    });
    const credential = await createCredential(db, key, workspace, {
      name: 'Device API',
      kind: 'env',
      secret: {},
      refs: { DEVICE_TOKEN: { provider: 'lab-vault', path: 'network/api', field: 'token' } },
    });
    config = (
      await new LaunchConfigs(db, git).create(project.id, {
        name: 'Hello',
        flowFile: 'flows/hello.flow.yaml',
        inventory: 'inventory/hosts.yaml',
        inputs: { devices: ['localhost'] },
        credentials: [credential.id],
      })
    ).id;
    const caller: Caller = async (url) => {
      reads.push(new URL(url).pathname);
      return url.includes('/v1/secret/data/network/api')
        ? { status: 200, text: JSON.stringify({ data: { data: { token: TOKEN } } }) }
        : { status: 404, text: '{}' };
    };
    ex = new Executor(
      { db, git, sync, queue, key, log },
      {
        dataDir: join(root, 'data'),
        engine: 'docker',
        image: image as string,
        worker: 'debug-test',
        slots: 1,
        timeoutMs: 10 * 60_000,
        heartbeatMs: 1000,
        pollMs: 200,
        collectionDir: join(root, 'no-collection'),
        secretCaller: caller,
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

  it('masks a provider value as external, pauses where a host fails, and Retry runs the step again', async () => {
    const c = await new LaunchConfigs(database.db, git).get(config);
    const prepared = await prepareLaunch({ db: database.db, git, sync }, c as never, {
      mode: 'check',
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.problems));
    const run = await queue.enqueue(
      {
        ...prepared.launch,
        step: {
          every: false,
          points: [SAY_HELLO],
          timeoutS: 600,
          debug: true,
          pauseOnFailure: true,
          failures: { failed: true },
        },
      },
      withoutSecrets(prepared.launch, prepared.form.fields).inputs,
      { id: 'u1', login: 'dana' },
      'Hello',
    );
    await ex.fill();
    // The pause point before Say hello, after the facts were read.
    await until('the pause point', async () => (await pauseOf(run.id))?.node === SAY_HELLO);
    const point = await pauseOf(run.id);
    expect(point).toMatchObject({ kind: 'point', debug: true, hosts: ['localhost'] });
    expect(reads).toContain('/v1/secret/data/network/api');
    // Scopes, then a provider value through the facts: masked as external, never shown.
    const scopes = await ex.inspect(run.id, { op: 'scopes', host: 'localhost' });
    expect(scopes?.scopes?.map((s) => s.id)).toEqual(
      expect.arrayContaining(['inputs', 'host', 'flow']),
    );
    const token = await ex.inspect(run.id, {
      op: 'eval',
      host: 'localhost',
      expr: 'ansible_env.DEVICE_TOKEN',
    });
    expect(token).toMatchObject({ masked: 'external' });
    expect(JSON.stringify(token)).not.toContain(TOKEN);
    const upper = await ex.inspect(run.id, {
      op: 'eval',
      host: 'localhost',
      expr: 'ansible_env.DEVICE_TOKEN | upper',
    });
    expect(JSON.stringify(upper)).not.toContain(TOKEN.toUpperCase());
    expect(
      await ex.inspect(run.id, { op: 'eval', host: 'localhost', expr: "lookup('pipe', 'id')" }),
    ).toMatchObject({ refused: true });
    const watch = await ex.inspect(run.id, { op: 'watch', exprs: ['inventory_hostname'] });
    expect(watch?.results).toEqual([
      expect.objectContaining({ host: 'localhost', value: 'localhost' }),
    ]);
    // Kept with the run: the scopes and the watch, masked.
    const kept = await debugKept(database.db, run.id);
    expect(kept[0]?.entries.map((e) => e.op)).toEqual(['scopes', 'watch']);
    expect(JSON.stringify(kept)).not.toContain(TOKEN);

    // Continue: Say hello fails on localhost, and the run pauses there.
    expect(await ex.drive(run.id, { command: 'continue' }, 'dana')).toEqual({ paused: true });
    await until(
      'the failure pause',
      async () => (await pauseOf(run.id))?.kind === 'failure',
      60_000,
    ).catch(async (e) => {
      const v = (await queue.view(run.id)) as { step?: unknown; state?: string };
      throw new Error(
        `${(e as Error).message}: ${(await queue.get(run.id))?.state} ${JSON.stringify(v?.step)} ${readFileSync(ex.outputFile(run.id), 'utf8').slice(-3000)}`,
      );
    });
    const failed = await pauseOf(run.id);
    expect(failed).toMatchObject({ attempt: 1, failed: [{ host: 'localhost' }] });
    // Retry: the step again, failing again (attempt 2).
    expect(await ex.drive(run.id, { command: 'retry' }, 'dana')).toEqual({ paused: true });
    await until('the second attempt', async () => (await pauseOf(run.id))?.attempt === 2);
    expect(await ex.drive(run.id, { command: 'continue' }, 'dana')).toEqual({ paused: true });
    await until('the end', async () => (await queue.get(run.id))?.state === 'failed');
    const output = readFileSync(ex.outputFile(run.id), 'utf8');
    expect(output).toContain('Retry by dana');
    expect(output).not.toContain(TOKEN);
  }, 600_000);

  // AFS-264: "Pause before the first step" ticked with pause points: the body the canvas's Debug
  // dialog and the Launch page now send (every: true with the points). The run pauses before step
  // 1, then Continue runs on to the pause point; it paused only at the point before the fix.
  it('AFS-264: ticked with pause points, a debug run pauses before the first step, then at the point', async () => {
    const c = await new LaunchConfigs(database.db, git).get(config);
    const prepared = await prepareLaunch({ db: database.db, git, sync }, c as never, {
      mode: 'check',
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.problems));
    const run = await queue.enqueue(
      {
        ...prepared.launch,
        step: {
          every: true,
          points: [SAY_HELLO],
          timeoutS: 600,
          debug: true,
          pauseOnFailure: false,
          failures: { failed: false },
        },
      },
      withoutSecrets(prepared.launch, prepared.form.fields).inputs,
      { id: 'u1', login: 'dana' },
      'Hello',
    );
    await ex.fill();
    await until('the first pause', async () => !!(await pauseOf(run.id)));
    expect(await pauseOf(run.id)).toMatchObject({
      kind: 'step',
      node: FIRST_STEP,
      debug: true,
      hosts: ['localhost'],
    });
    expect(await ex.drive(run.id, { command: 'continue' }, 'dana')).toEqual({ paused: true });
    await until('the pause point', async () => (await pauseOf(run.id))?.node === SAY_HELLO);
    expect(await pauseOf(run.id)).toMatchObject({ kind: 'point', node: SAY_HELLO });
    expect(await ex.drive(run.id, { command: 'stop' }, 'dana')).toBeTruthy();
    await until('the end', async () => {
      const state = (await queue.get(run.id))?.state;
      return !!state && !['queued', 'running'].includes(state);
    });
  }, 600_000);

  it('AFS-259: a log point writes its line; a reader of the output reads where, not what', async () => {
    const c = await new LaunchConfigs(database.db, git).get(config);
    const prepared = await prepareLaunch({ db: database.db, git, sync }, c as never, {
      mode: 'check',
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.problems));
    const run = await queue.enqueue(
      {
        ...prepared.launch,
        step: {
          every: false,
          points: [{ node: SAY_HELLO, log: 'LOGMARK {{ inventory_hostname }}' }],
          timeoutS: 600,
          debug: true,
          failures: { failed: false },
        },
      },
      withoutSecrets(prepared.launch, prepared.form.fields).inputs,
      { id: 'u1', login: 'dana' },
      'Hello',
    );
    await ex.fill();
    await until('the end', async () => {
      const state = (await queue.get(run.id))?.state;
      return state === 'failed' || state === 'succeeded';
    });
    const output = readFileSync(ex.outputFile(run.id), 'utf8');
    // The engine's own line, recorded as it is (round 2 fixture).
    const line = output.split('\n').find((l) => l.includes('Log point'));
    expect(line).toMatch(/Log point Say hello · localhost: LOGMARK localhost/);
    const read = outputForReader(output);
    expect(read).not.toContain('LOGMARK');
    expect(read).toContain(
      'Log point Say hello · localhost: (only who launched the run reads this)',
    );
    const view = (await queue.view(run.id)) as { step?: { logs?: unknown[] } };
    expect(JSON.stringify(view.step?.logs)).toContain('LOGMARK localhost');
    expect(
      JSON.stringify(
        viewForReader(
          view,
          { step: { debug: true }, requestedBy: { login: 'dana' } },
          { login: 'rita', admin: false },
        ),
      ),
    ).not.toContain('LOGMARK');
  }, 600_000);
});
