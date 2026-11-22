// AFS-177: a real step-by-step run of the Hello sample through the server's executor: Ansible in a
// container (the designer's afd_step strategy), driven as the pages drive it. Needs a container
// engine and an image with ansible-core: AFS_TEST_STEP_IMAGE=afd-ee:2.19 npx vitest run
// test/unit/stepRunDocker.test.ts. Skipped otherwise.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs } from '../../src/server/launch/configs';
import { prepareLaunch, withoutSecrets } from '../../src/server/launch/prepare';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace, type Project } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { Executor } from '../../src/server/runs/executor';
import { RunQueue } from '../../src/server/runs/queue';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { type TestRepo, testRepo } from './helpers/repo';

const image = process.env.AFS_TEST_STEP_IMAGE;
const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const HELLO = readFileSync(join(__dirname, '../fixtures/hello.flow.yaml'), 'utf8');
const SAY_HELLO = '01M6GPM9B1D563X8PKD5041JHV';

describe.skipIf(!image)('a step-by-step run in a container (AFS-177)', () => {
  const root = mkdtempSync(join(tmpdir(), 'afs-step-docker-'));
  let database: Database;
  let sync: ProjectSync;
  let queue: RunQueue;
  let source: TestRepo;
  let ex: Executor;
  let config: string;
  let git: Git;
  const lines: string[] = [];

  beforeAll(async () => {
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    const db = database.db;
    const log = createLogger({ level: 'info', format: 'json', write: (l) => lines.push(l) });
    git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
    sync = new ProjectSync(db, git, log);
    queue = new RunQueue(db, 'sqlite', key, { maxRuns: 2, perProject: 2 });
    source = testRepo({
      'flows/hello.flow.yaml': HELLO,
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
    config = (
      await new LaunchConfigs(db, git).create(project.id, {
        name: 'Hello',
        flowFile: 'flows/hello.flow.yaml',
        inventory: 'inventory/hosts.yaml',
        inputs: { devices: ['localhost'] },
      })
    ).id;
    ex = new Executor(
      { db, git, sync, queue, key, log },
      {
        dataDir: join(root, 'data'),
        engine: 'docker',
        image: image as string,
        worker: 'step-test',
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
  const pausedBefore = (id: string, title: string) =>
    until(`a pause before ${title}`, async () => (await queue.get(id))?.pausedBefore === title);

  it('pauses before each step; Step, a pause point and Continue, then Stop end it as stopped', async () => {
    const c = await new LaunchConfigs(database.db, git).get(config);
    const prepared = await prepareLaunch({ db: database.db, git, sync }, c as never, {
      mode: 'real',
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.problems));
    const run = await queue.enqueue(
      { ...prepared.launch, step: { every: true, points: [SAY_HELLO], timeoutS: 600 } },
      withoutSecrets(prepared.launch, prepared.form.fields).inputs,
      { id: 'u1', login: 'dana' },
      'Hello',
    );
    await ex.fill();
    // Before the first step, all hosts together.
    await pausedBefore(run.id, 'Check the host answers');
    expect((await queue.get(run.id))?.state).toBe('running');
    expect(await ex.drive(run.id, { command: 'continue' }, 'dana')).toEqual({ paused: true });
    // Continue runs on past Ping and the facts, to the pause point before Say hello.
    await pausedBefore(run.id, 'Say hello');
    expect(await ex.drive(run.id, { command: 'pause' }, 'dana')).toMatchObject({
      error: 'The run is paused already',
    });
    expect(await ex.drive(run.id, { command: 'stop' }, 'dana')).toEqual({ paused: true });
    await until('the end', async () => (await queue.get(run.id))?.state === 'cancelled');
    const after = await queue.get(run.id);
    expect(after?.error).toBe('Stopped by dana before Say hello');
    expect(after?.pausedBefore).toBeUndefined();
    const view = (await queue.view(run.id)) as {
      stoppedAt?: string;
      step?: { stopped?: { node: string; reason: string } };
      summary?: { nodes: Record<string, unknown> };
    };
    expect(view.stoppedAt).toBe(SAY_HELLO);
    expect(view.step?.stopped).toMatchObject({ node: SAY_HELLO, reason: 'driver' });
    // Ping and facts ran; Say hello did not.
    expect(Object.keys(view.summary?.nodes ?? {})).toEqual(
      expect.arrayContaining(['01M6GPM979RJPCDJ0XFF22GBSV', '01M6GPM99KC9TX091MCH61REQV']),
    );
    expect(view.summary?.nodes[SAY_HELLO]).toBeUndefined();
    const output = readFileSync(ex.outputFile(run.id), 'utf8');
    expect(output).toContain('Paused before Check the host answers (1 host)');
    expect(output).toContain('Paused before Say hello (1 host)');
    expect(output).toContain('Stopped by dana before Say hello');
  });

  it('Step runs one step and pauses before the next', async () => {
    const c = await new LaunchConfigs(database.db, git).get(config);
    const prepared = await prepareLaunch({ db: database.db, git, sync }, c as never, {
      mode: 'check',
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.problems));
    const run = await queue.enqueue(
      { ...prepared.launch, step: { every: true, points: [], timeoutS: 600 } },
      withoutSecrets(prepared.launch, prepared.form.fields).inputs,
      { id: 'u1', login: 'dana' },
      'Hello',
    );
    await ex.fill();
    await pausedBefore(run.id, 'Check the host answers');
    expect(await ex.drive(run.id, { command: 'step' }, 'dana')).toEqual({ paused: true });
    await pausedBefore(run.id, 'Read a few facts');
    expect(await ex.drive(run.id, { command: 'step' }, 'dana')).toEqual({ paused: true });
    await pausedBefore(run.id, 'Say hello');
    // Continue with no pause point left: the run goes to its end.
    expect(await ex.drive(run.id, { command: 'continue' }, 'dana')).toEqual({ paused: true });
    await until('the end', async () => (await queue.get(run.id))?.state === 'succeeded');
    const output = readFileSync(ex.outputFile(run.id), 'utf8');
    expect(output).toContain('Hello from localhost');
  });
});
