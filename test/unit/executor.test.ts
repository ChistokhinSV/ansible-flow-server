// The server's worker, with Ansible played by the test: what a run gets (the commit's files,
// fresh code, credentials) and how it ends (done, failed, cancelled, too long, server stopped).
// Ansible itself in a container is checked on a machine with a container engine.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { optionA } from '@ansible-flow/core/engine/optionA';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import type { RunView } from '@ansible-flow/core/protocol';
import { CONTAINER, runProcess } from '@ansible-flow/core/run/command';
import { summarizeRun } from '@ansible-flow/core/run/events';
import type { RunFlowHooks, RunFlowRequest } from '@ansible-flow/node/run/runFlow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs } from '../../src/server/launch/configs';
import { prepareLaunch, withoutSecrets } from '../../src/server/launch/prepare';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import {
  createProject,
  createWorkspace,
  getProject,
  type Project,
} from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { registrySignIn, runCredentials } from '../../src/server/runs/credentials';
import { Executor, type ExecutorOptions, usernsOptions } from '../../src/server/runs/executor';
import { RunQueue } from '../../src/server/runs/queue';
import { registryOf } from '../../src/server/runs/registry';
import { rootFromGenerated, writeGenerated } from '../../src/server/runs/workdir';
import { createCredential } from '../../src/server/secrets/credentials';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { createSecretProvider } from '../../src/server/secrets/providers/store';
import { type TestRepo, testRepo } from './helpers/repo';

const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'QUFB'.repeat(12)}\n-----END OPENSSH PRIVATE KEY-----`;
const HELLO = readFileSync(join(__dirname, '../fixtures/hello.flow.yaml'), 'utf8').replace(
  '    devices:',
  '    api_token:\n      type: string\n    devices:',
);
const root = mkdtempSync(join(tmpdir(), 'afs-exec-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Seen = {
  request: RunFlowRequest;
  hooks: RunFlowHooks;
  keyFile?: string;
  generated?: string[];
};
/** What Ansible does in a test: the request is kept, and the answer is `answer`. */
type Fake = (request: RunFlowRequest, hooks: RunFlowHooks) => Promise<Partial<RunView>>;

let database: Database;
let git: Git;
let sync: ProjectSync;
let queue: RunQueue;
let source: TestRepo;
let project: Project;
let first: string;
let config: string;
let creds: string[];
let lines: string[];
let dataDir: string;
let n = 0;

beforeAll(async () => {
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  const db = database.db;
  lines = [];
  const log = createLogger({ level: 'debug', format: 'json', write: (l) => lines.push(l) });
  git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
  sync = new ProjectSync(db, git, log);
  queue = new RunQueue(db, 'sqlite', key, { maxRuns: 4, perProject: 4 });
  source = testRepo({ 'flows/hello.flow.yaml': HELLO, 'README.md': 'x\n' });
  const workspace = (await createWorkspace(db, { key: 'net', name: 'Network' })).id;
  const made = await createProject(
    db,
    workspace,
    { key: 'edge', name: 'Edge', gitUrl: source.dir, pollSeconds: 0 },
    true,
  );
  project = (await sync.sync(made.id)) as Project;
  first = project.commit as string;
  const credential = (
    name: string,
    kind: never,
    fields: Record<string, string>,
    secret: Record<string, string>,
  ) => createCredential(db, key, workspace, { name, kind, fields, secret }).then((c) => c.id);
  creds = [
    await credential(
      'key',
      'ssh_key' as never,
      { username: 'netops' },
      { privateKey: PRIVATE_KEY },
    ),
    await credential(
      'become',
      'become' as never,
      { method: 'sudo' },
      { password: 'become-S3CR3T' },
    ),
    await credential('vault', 'vault' as never, {}, { password: 'vault-S3CR3T' }),
    await credential('api', 'env' as never, {}, { NETBOX_TOKEN: 'env-S3CR3T-value' }),
  ];
  config = (
    await new LaunchConfigs(db, git).create(project.id, {
      name: 'Hello',
      flowFile: 'flows/hello.flow.yaml',
      inputs: { devices: ['fw-edge-01'] },
      credentials: creds,
    })
  ).id;
});
afterAll(async () => {
  await sync.stop();
  await database.close();
  source.remove();
});
beforeEach(() => {
  dataDir = join(root, `data-${++n}`);
});

/** Launches the configuration as a person would. */
async function launch(request: Parameters<typeof prepareLaunch>[2] = {}) {
  const c = (await new LaunchConfigs(database.db, git).get(config)) as NonNullable<
    Awaited<ReturnType<LaunchConfigs['get']>>
  >;
  const prepared = await prepareLaunch({ db: database.db, git, sync }, c, {
    inputs: { api_token: 'input-S3CR3T' },
    ...request,
  });
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.problems));
  return queue.enqueue(
    prepared.launch,
    withoutSecrets(prepared.launch, prepared.form.fields).inputs,
    { id: 'u1', login: 'dana' },
    'Hello',
  );
}

/** An executor whose Ansible is `fake`, and what it saw. */
function executor(
  fake: Fake,
  options: {
    timeoutMs?: number;
    repoConfig?: ExecutorOptions['repoConfig'];
    defaultImage?: ExecutorOptions['defaultImage'];
    recordInputs?: boolean;
    missingTargets?: ExecutorOptions['missingTargets'];
  } = {},
) {
  const seen: Seen[] = [];
  const log = createLogger({ level: 'debug', format: 'json', write: (l) => lines.push(l) });
  const ex = new Executor(
    { db: database.db, git, sync, queue, key, log },
    {
      dataDir,
      engine: 'docker',
      image: 'afd-ee:2.19',
      worker: 'test-worker',
      slots: 2,
      timeoutMs: options.timeoutMs ?? 60_000,
      heartbeatMs: 30,
      pollMs: 20,
      ...(options.repoConfig ? { repoConfig: options.repoConfig } : {}),
      ...(options.defaultImage ? { defaultImage: options.defaultImage } : {}),
      ...(options.recordInputs !== undefined ? { recordInputs: options.recordInputs } : {}),
      ...(options.missingTargets ? { missingTargets: options.missingTargets } : {}),
      runner: async (request, hooks) => {
        const s: Seen = { request, hooks };
        const keyMount = request.env.kind === 'container' ? request.env.mounts[0] : undefined;
        if (keyMount && existsSync(join(keyMount.src, 'ssh_key')))
          s.keyFile = readFileSync(join(keyMount.src, 'ssh_key'), 'utf8');
        const gen = join(request.root, 'flows', 'generated');
        if (existsSync(gen)) s.generated = readdirSync(gen);
        seen.push(s);
        const answer = await fake(request, hooks);
        return {
          id: request.id,
          mode: request.mode,
          startedAt: request.startedAt,
          state: 'done',
          rc: 0,
          ...answer,
        } as RunView;
      },
    },
  );
  return { ex, seen };
}
const until = async (check: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Waited too long');
};
const ended = (id: string) =>
  until(async () => !['queued', 'running'].includes((await queue.get(id))?.state ?? ''));

describe("the repository's Ansible config (AFS-80)", () => {
  it('is read in the run image over the run checkout and goes into the run', async () => {
    const asked: { image: string; root: string; name: string }[] = [];
    const config = {
      enabled: ['profile_tasks'],
      paths: ['/usr/share/ansible/plugins/callback'],
      plugins: { library: ['/usr/share/ansible/plugins/modules'] },
      varsEnabled: ['host_group_vars'],
    };
    const { ex, seen } = executor(async () => ({ rc: 0 }), {
      repoConfig: async (o) => {
        asked.push({ image: o.image, root: o.root, name: o.name });
        return config;
      },
    });
    const run = await launch();
    await ex.start();
    await ended(run.id);
    await ex.stop();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.image).toBe('afd-ee:2.19');
    expect(asked[0]?.root).toBe(seen[0]?.request.root);
    expect(seen[0]?.request.callbacks).toEqual(config);
  });

  it("AFS-210: the run's command searches the project's top roles/ after the config's roles_path", async () => {
    // As the probe reads the config in the run image: roles_path's defaults (no ansible.cfg).
    const config = {
      enabled: [],
      paths: [],
      plugins: { roles: ['/home/runner/.ansible/roles', '/usr/share/ansible/roles'] },
      varsEnabled: [],
    };
    const { ex, seen } = executor(async () => ({ rc: 0 }), { repoConfig: async () => config });
    const run = await launch();
    await ex.start();
    await ended(run.id);
    await ex.stop();
    const request = seen[0]?.request as RunFlowRequest;
    expect(request.callbacks).toEqual(config);
    // The command the runner makes of it: an imported playbook's role in roles/ is found.
    const spec = runProcess(
      request.env,
      { root: request.root, probe: request.probeDir },
      {
        playbook: request.playbook,
        check: true,
        runDir: join(dataDir, 'r'),
        vault: false,
        hasConfig: false,
        ...(request.callbacks ? { callbacks: request.callbacks } : {}),
      },
      'n',
    );
    expect(spec.args).toContain(
      `ANSIBLE_ROLES_PATH=/home/runner/.ansible/roles:/usr/share/ansible/roles:${CONTAINER.root}/roles`,
    );
  });

  it('a config that cannot be read leaves the run as before', async () => {
    const { ex, seen } = executor(async () => ({ rc: 0 }), { repoConfig: async () => undefined });
    const run = await launch();
    await ex.start();
    await ended(run.id);
    await ex.stop();
    expect((await queue.get(run.id))?.state).toBe('succeeded');
    expect(seen[0]?.request.callbacks).toBeUndefined();
  });
});

describe('input values (AFS-182)', () => {
  it('a run records them unless AFS_RUN_RECORD_INPUTS turns them off', async () => {
    for (const recordInputs of [undefined, true, false]) {
      dataDir = join(root, `data-${++n}`);
      const { ex, seen } = executor(async () => ({ rc: 0 }), {
        ...(recordInputs === undefined ? {} : { recordInputs }),
      });
      const run = await launch();
      await ex.start();
      await ended(run.id);
      await ex.stop();
      // The designer's runFlow records them unless told false (AFD_RECORD_INPUTS=0).
      expect(seen[0]?.request.recordInputs, String(recordInputs)).toBe(
        recordInputs === false ? false : undefined,
      );
    }
  });
});

describe('a debug run (AFS-214)', () => {
  it("passes debug and pause on failure on in the step request, for the designer's engine", async () => {
    const { ex, seen } = executor(async () => ({ rc: 0 }));
    const run = await launch();
    const step = { every: false, points: ['01M6GPM979RJPCDJ0XFF22GBSV'], timeoutS: 600 };
    await database.db
      .updateTable('run')
      .set({ step_json: JSON.stringify({ ...step, debug: true, pauseOnFailure: true }) })
      .where('id', '=', run.id)
      .execute();
    await ex.start();
    await ended(run.id);
    await ex.stop();
    expect(seen[0]?.request.step).toMatchObject({ ...step, debug: true, pauseOnFailure: true });
  });
});

describe('a run', () => {
  it("gets the commit's files, the flow's code fresh, its inputs and credentials, and ends", async () => {
    const { ex, seen } = executor(async (_request, hooks) => {
      hooks.log?.('TASK [hello] ok: [fw-edge-01] token=input-S3CR3T vault=vault-S3CR3T');
      // Colours are kept for the run page; a line with a secret is kept plain, the secret hidden
      // even when a colour code splits it.
      const esc = String.fromCharCode(27);
      hooks.log?.(`${esc}[0;32mok: [fw-edge-02]${esc}[0m`);
      hooks.log?.(`${esc}[0;31mbad: input-S3${esc}[1mCR3T${esc}[0m`);
      return {
        rc: 0,
        summary: {
          nodes: {},
          outcome: {},
          failures: [],
          unreachable: [],
          hosts: ['fw-edge-01'],
          stoppedEarly: false,
        },
      };
    });
    const run = await launch();
    await ex.start();
    await ended(run.id);
    await ex.stop();

    const after = await queue.get(run.id);
    expect(after).toMatchObject({ state: 'succeeded', attempts: 1 });
    expect(after?.startedAt).toBeTruthy();
    expect(await queue.view(run.id)).toMatchObject({
      state: 'done',
      rc: 0,
      summary: { hosts: ['fw-edge-01'] },
    });

    const { request, keyFile, generated } = seen[0] as Seen;
    expect(request.mode).toBe('check');
    expect(request.doc.flow.key).toBe('hello');
    // The project's branch at its newest commit: the lasting folder, with fresh code beside the flow.
    expect(request.root).toBe(join(dataDir, 'work', project.id, 'branch'));
    expect(request.playbook).toMatch(/^flows\/generated\/[^/]+\.ya?ml$/);
    expect(generated?.length).toBeGreaterThan(0);
    expect(rootFromGenerated('flows/hello.flow.yaml')).toBe('../..');
    expect(request.probeDir).toBe(join(dataDir, 'probe'));
    expect(existsSync(join(dataDir, 'probe', 'callback_plugins', 'afd_events.py'))).toBe(true);
    expect(request.storage).toBe(join(dataDir, 'runs', project.id));
    // Inputs and credentials: Ansible's own variables, the vault password, a key file, variables.
    expect(request.inputs).toMatchObject({
      devices: ['fw-edge-01'],
      api_token: 'input-S3CR3T',
      ansible_user: 'netops',
      ansible_become_password: 'become-S3CR3T',
      ansible_become_method: 'sudo',
    });
    expect(request.vaultPassword).toBe('vault-S3CR3T');
    expect(keyFile).toBe(`${PRIVATE_KEY}\n`);
    expect(request.env).toMatchObject({
      kind: 'container',
      engine: 'docker',
      image: 'afd-ee:2.19',
    });
    const env = request.env as Extract<RunFlowRequest['env'], { kind: 'container' }>;
    expect(env.options).toEqual(
      expect.arrayContaining([
        '--label',
        'afs.worker=test-worker',
        '-e',
        'ANSIBLE_PRIVATE_KEY_FILE=/afd-cred/ssh_key',
        'NETBOX_TOKEN',
      ]),
    );
    expect(env.options.join(' ')).not.toContain('S3CR3T');
    expect(env.mounts).toEqual([
      { src: join(dataDir, 'secrets-tmp', run.id), dest: '/afd-cred', options: 'ro' },
    ]);
    // Afterwards: the key is gone, the lasting folder stays.
    expect(existsSync(join(dataDir, 'secrets-tmp', run.id))).toBe(false);
    expect(
      existsSync(join(dataDir, 'work', project.id, 'branch', 'flows', 'hello.flow.yaml')),
    ).toBe(true);
    // The output is kept, with every secret hidden.
    const output = readFileSync(ex.outputFile(run.id), 'utf8');
    expect(output).toContain('TASK [hello] ok: [fw-edge-01]');
    expect(output).toContain(`${String.fromCharCode(27)}[0;32mok: [fw-edge-02]`);
    expect(output).toMatch(/^bad: \*+/m);
    expect(output).toContain('Credential: SSH key "key" as netops');
    expect(output).not.toContain('S3CR3T');
    expect(lines.join('\n')).not.toContain('S3CR3T');
  });

  it("AFS-163: a run without its own image gets the server's default now, kept on the run", async () => {
    let picked = 'registry.example.net/ee/team:1';
    const { ex, seen } = executor(async () => ({ rc: 0 }), { defaultImage: async () => picked });
    const run = await launch();
    expect(run.eeImage).toBeUndefined();
    await ex.start();
    await ended(run.id);
    await ex.stop();
    expect(seen[0]?.request.env).toMatchObject({ image: 'registry.example.net/ee/team:1' });
    expect((await queue.get(run.id))?.eeImage).toBe('registry.example.net/ee/team:1');
    // AFS-170: that it was the server's default is kept as the run started, whatever the
    // configuration says later.
    expect((await queue.get(run.id))?.serverDefault).toBe(true);
    expect(readFileSync(ex.outputFile(run.id), 'utf8')).toContain(
      "The server's default image: registry.example.net/ee/team:1",
    );
    // Picked again: the catalogs and the next run follow it.
    picked = 'registry.example.net/ee/team:2';
    expect(await ex.defaultImage()).toBe('registry.example.net/ee/team:2');
  });

  it('of another commit gets a folder of its own, removed afterwards', async () => {
    source.commit({ 'notes.txt': 'more\n' }, 'Second');
    const { ex, seen } = executor(async () => ({ rc: 0 }));
    const run = await launch({ commit: first });
    await ex.start();
    await ended(run.id);
    await ex.stop();
    const { request } = seen[0] as Seen;
    expect(request.root).toBe(join(dataDir, 'work', project.id, `run-${run.id}`));
    expect(existsSync(request.root)).toBe(false);
    expect((await queue.get(run.id))?.state).toBe('succeeded');
  });

  it('a run that reached no host fails; no events gets the reason the output gave (AFS-132)', async () => {
    const empty = {
      nodes: {},
      outcome: {},
      failures: [],
      unreachable: [],
      hosts: [],
      stoppedEarly: false,
    };
    const { ex } = executor(async () => ({ rc: 0, summary: empty }));
    const none = await launch();
    await ex.start();
    await ended(none.id);
    await ex.stop();
    expect(await queue.get(none.id)).toMatchObject({ state: 'failed' });
    expect((await queue.get(none.id))?.error).toMatch(/^No host ran/);

    const pull = executor(async (_request, hooks) => {
      hooks.log?.('Unable to find image locally');
      hooks.log?.('docker: Error response from daemon: dial tcp: lookup x.invalid: no such host.');
      return { rc: 125, error: 'The run produced no events' };
    });
    const failed = await launch();
    await pull.ex.start();
    await ended(failed.id);
    await pull.ex.stop();
    expect((await queue.get(failed.id))?.error).toBe(
      'The run produced no events: docker: Error response from daemon: dial tcp: lookup x.invalid: no such host.',
    );

    // Ansible's own words, as a limit that leaves no host gets them (seen on the lab server).
    const LIMIT =
      '[ERROR]: Specified inventory, host pattern and/or --limit leaves us with no hosts to target.';
    const limited = executor(async (_request, hooks) => {
      hooks.log?.(LIMIT);
      return { rc: 1, error: 'The run produced no events' };
    });
    const none2 = await launch();
    await limited.ex.start();
    await ended(none2.id);
    await limited.ex.stop();
    // AFS-147: said plainly: which targets, which limit, which inventory.
    expect((await queue.get(none2.id))?.error).toBe(
      'No host ran: none of the targets (fw-edge-01) is in the inventory',
    );
    const limited2 = executor(async (_request, hooks) => {
      hooks.log?.(LIMIT);
      return { rc: 1, error: 'The run produced no events' };
    });
    const none3 = await launch({ limit: 'nosuchhost' });
    await limited2.ex.start();
    await ended(none3.id);
    await limited2.ex.stop();
    expect((await queue.get(none3.id))?.error).toBe(
      'No host ran: the limit nosuchhost matched none of the targets (fw-edge-01) in the inventory',
    );
  });

  it('AFS-196: names the targets the inventory does not have when Ansible says nothing', async () => {
    const questions: { commit: string; inputs: Record<string, unknown> }[] = [];
    const { ex } = executor(
      async () => ({
        summary: {
          nodes: {},
          outcome: {},
          failures: [],
          unreachable: [],
          hosts: ['fw-edge-01'],
          stoppedEarly: false,
        },
      }),
      {
        missingTargets: async (q) => {
          questions.push({ commit: q.commit, inputs: q.inputs });
          return ['ghost-01'];
        },
      },
    );
    const run = await launch();
    await ex.start();
    await ended(run.id);
    await ex.stop();
    expect((await queue.get(run.id))?.state).toBe('succeeded');
    expect(await queue.view(run.id)).toMatchObject({ skippedTargets: ['ghost-01'] });
    expect(questions).toHaveLength(1);
    expect(questions[0]?.commit).toBe(run.commit);
  });

  it('names the targets Ansible skipped, on a run that went well too (AFS-147)', async () => {
    const { ex } = executor(async (_request, hooks) => {
      hooks.log?.('[WARNING]: Could not match supplied host pattern, ignoring: nosuchhost');
      return {
        rc: 0,
        summary: {
          nodes: {},
          outcome: {},
          failures: [],
          unreachable: [],
          hosts: ['fw-edge-01'],
          stoppedEarly: false,
        },
      };
    });
    const run = await launch();
    await ex.start();
    await ended(run.id);
    await ex.stop();
    expect((await queue.get(run.id))?.state).toBe('succeeded');
    expect(await queue.view(run.id)).toMatchObject({ skippedTargets: ['nosuchhost'] });
  });

  it('fails with the reason when Ansible fails, and when the run cannot start', async () => {
    const { ex } = executor(async () => ({
      rc: 2,
      summary: {
        nodes: {},
        outcome: { 'fw-edge-01': 'open port' },
        failures: [],
        unreachable: [],
        hosts: ['fw-edge-01'],
        stoppedEarly: false,
      },
    }));
    const failed = await launch();
    await ex.start();
    await ended(failed.id);
    // AFS-147: how many hosts failed, then the exit code in words (AFS-170).
    expect(await queue.get(failed.id)).toMatchObject({
      state: 'failed',
      error: '1 of 1 host failed (Ansible ended with code 2: one or more hosts failed)',
    });
    await ex.stop();

    // Ansible ended well but wrote no events: nothing says what the flow did.
    const quiet = executor(async () => ({ rc: 0, error: 'The run produced no events' }));
    const noEvents = await launch();
    await quiet.ex.start();
    await ended(noEvents.id);
    await quiet.ex.stop();
    expect(await queue.get(noEvents.id)).toMatchObject({
      state: 'failed',
      error: 'The run produced no events',
    });

    const second = executor(async () => ({
      state: 'error',
      error: 'The run could not be started',
      rc: undefined,
    }));
    const notStarted = await launch();
    await second.ex.start();
    await ended(notStarted.id);
    await second.ex.stop();
    expect(await queue.get(notStarted.id)).toMatchObject({
      state: 'failed',
      error: 'The run could not be started',
    });
  });

  it('fails when its only host failed at a step although Ansible ended with 0 (AFS-208)', async () => {
    // A role a step includes is not found: the step's rescue routes the host to its open
    // failed_hosts port, but Ansible keeps the host failed, runs no later play on it (so the
    // outcome play never fails it) and ends with 0. The designer's summary of those events.
    const doc = parseYaml(HELLO) as FlowDocument;
    const { routes } = optionA.generate(doc, { source: 'hello.flow.yaml' });
    const facts = doc.nodes.find((n) => n.key === 'facts');
    const group = Object.entries(routes).find(
      ([, r]) => r.node === facts?.id && r.port === 'failed_hosts',
    )?.[0];
    expect(group && routes[group]?.fails).toBeTruthy();
    const event = (e: Record<string, unknown>) => JSON.stringify({ ts: 1, ...e });
    const events = [
      event({ event: 'play', name: '[facts] Read a few facts', node: facts?.id }),
      event({
        event: 'result',
        status: 'failed',
        host: 'fw-edge-01',
        task: '[facts] Apply role',
        node: facts?.id,
        msg: "The role 'motd' was not found",
      }),
      event({ event: 'result', status: 'ok', host: 'fw-edge-01', node: facts?.id, group }),
      event({ event: 'stats' }),
    ].join('\n');
    const { ex } = executor(async () => ({ rc: 0, summary: summarizeRun(events, routes) }));
    const run = await launch();
    await ex.start();
    await ended(run.id);
    await ex.stop();
    expect(await queue.get(run.id)).toMatchObject({
      state: 'failed',
      error: '1 of 1 host failed at Read a few facts',
      hosts: { total: 1, failed: 1 },
    });
  });

  it('stops when someone cancels it, when it takes too long, and when the server stops', async () => {
    /** Ansible that runs until it is stopped. */
    const forever: Fake = (request) =>
      new Promise((resolve) => {
        request.signal?.addEventListener('abort', () =>
          resolve({ state: 'error', error: 'Stopped by the user', rc: undefined }),
        );
      });
    const a = executor(forever);
    const cancelled = await launch();
    await a.ex.start();
    await until(async () => !!(await queue.get(cancelled.id))?.startedAt);
    await queue.cancel(cancelled.id, 'omar');
    await ended(cancelled.id);
    // AFS-147: who stopped it (a login the server does not know is said as it is).
    expect(await queue.get(cancelled.id)).toMatchObject({
      state: 'cancelled',
      error: 'Stopped by omar',
      cancelledBy: 'omar',
    });
    await a.ex.stop();

    const b = executor(forever, { timeoutMs: 200 });
    const slow = await launch();
    await b.ex.start();
    await ended(slow.id);
    expect((await queue.get(slow.id))?.error).toMatch(/took longer than/);
    await b.ex.stop();

    const c = executor(forever);
    const cut = await launch();
    await c.ex.start();
    await until(async () => !!(await queue.get(cut.id))?.startedAt);
    await c.ex.stop();
    expect(await queue.get(cut.id)).toMatchObject({
      state: 'failed',
      error: 'The server stopped during the run',
    });
  });

  it('a stopped run names the step it was in; one whose steps had ended is not stopped (AFS-185)', async () => {
    const step = '01M6GPM99KC9TX091MCH61REQV';
    const summary = {
      nodes: {},
      outcome: {},
      failures: [],
      unreachable: [],
      hosts: ['fw-edge-01'],
      stoppedEarly: false,
    };
    // In a step when stopped: the view Ansible ends with names no running step.
    const midStep = executor(
      (request, hooks) =>
        new Promise((resolve) => {
          hooks.report({
            id: request.id,
            mode: 'real',
            state: 'running',
            startedAt: request.startedAt,
            summary: { ...summary, running: step },
          } as RunView);
          request.signal?.addEventListener('abort', () =>
            resolve({ state: 'error', error: 'Stopped by the user', rc: undefined, summary }),
          );
        }),
    );
    const cut = await launch();
    await midStep.ex.start();
    await until(async () => !!(await queue.get(cut.id))?.startedAt);
    await queue.cancel(cut.id, 'omar');
    await ended(cut.id);
    await midStep.ex.stop();
    // The output names who by name (a login the server does not know is said as it is).
    expect(readFileSync(midStep.ex.outputFile(cut.id), 'utf8')).toContain(
      'Stopped by omar during Read a few facts',
    );
    expect(await queue.get(cut.id)).toMatchObject({
      state: 'cancelled',
      error: 'Stopped by omar during Read a few facts',
    });
    expect(await queue.view(cut.id)).toMatchObject({ stoppedAt: step });

    // Ansible ended by itself, every host done, as the stop came: recorded as it ended.
    const late = executor(
      (request) =>
        new Promise((resolve) => {
          request.signal?.addEventListener('abort', () =>
            resolve({ state: 'done', rc: 0, summary }),
          );
        }),
    );
    const ran = await launch();
    await late.ex.start();
    await until(async () => !!(await queue.get(ran.id))?.startedAt);
    await queue.cancel(ran.id, 'omar');
    await ended(ran.id);
    await late.ex.stop();
    expect((await queue.get(ran.id))?.state).toBe('succeeded');
    expect(readFileSync(late.ex.outputFile(ran.id), 'utf8')).toContain(
      'Asked to stop after its steps had ended',
    );
  });

  it("a flow that has errors at the run's commit is not run", async () => {
    const broken = source.commit(
      { 'flows/hello.flow.yaml': HELLO.replace('type: host_list', 'type: hostlist') },
      'Broken',
    );
    await sync.sync(project.id);
    const { ex, seen } = executor(async () => ({ rc: 0 }));
    // Queued from a launch settled earlier: the flow changed after it.
    const run = await queue.enqueue(
      {
        config,
        project: project.id,
        commit: broken,
        ref: 'main',
        flow: { file: 'flows/hello.flow.yaml', key: 'hello', name: 'Hello', version: 1 },
        mode: 'check',
        inputs: {},
        targets: [],
        credentials: [],
      },
      {},
      { id: 'u1', login: 'dana' },
    );
    await ex.start();
    await ended(run.id);
    await ex.stop();
    expect(seen).toHaveLength(0);
    expect((await queue.get(run.id))?.error).toMatch(/^The flow has errors/);
    source.commit({ 'flows/hello.flow.yaml': HELLO }, 'Fixed');
    await sync.sync(project.id);
  });

  it('AFS-241: reads secrets from a provider as it starts, hides them, and fails before Ansible when it cannot', async () => {
    const VALUE = 'provider-S3CR3T-value';
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/authn/')) res.writeHead(200).end('dG9rZW4=');
      else if (req.url === '/secrets/corp/variable/net%2Fswitches') res.writeHead(200).end(VALUE);
      else res.writeHead(404).end('Variable corp:variable:net/elsewhere not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const workspace = project.workspace;
    await createSecretProvider(database.db, key, {
      key: 'conjur-run',
      name: 'Conjur',
      kind: 'conjur',
      settings: { address, account: 'corp', login: 'host/afs', timeoutS: 3 },
      secret: { apiKey: 'api-key-fictional' },
      workspaces: [workspace],
    });
    const login = (name: string, variable: string) =>
      createCredential(database.db, key, workspace, {
        name,
        kind: 'login',
        fields: { username: 'netops' },
        secret: {},
        refs: { password: { provider: 'conjur-run', variable } },
      }).then((c) => c.id);
    const good = await login('from conjur', 'net/switches');
    const broken = await login('from conjur, gone', 'net/elsewhere');
    const commit = (await getProject(database.db, project.id))?.commit as string;
    const enqueue = (credential: string) =>
      queue.enqueue(
        {
          config,
          project: project.id,
          commit,
          ref: 'main',
          flow: { file: 'flows/hello.flow.yaml', key: 'hello', name: 'Hello', version: 1 },
          mode: 'check',
          inputs: {},
          targets: [],
          credentials: [credential],
        },
        {},
        { id: 'u1', login: 'dana' },
      );
    try {
      let externalFile: unknown;
      const { ex, seen } = executor(async (request, hooks) => {
        // The engine finds the values read from providers in a file of their own.
        const env = request.env.kind === 'container' ? request.env : undefined;
        const mount = env?.mounts.find((m) => m.dest === '/afd-cred');
        if (mount)
          externalFile = JSON.parse(readFileSync(join(mount.src, 'external-secrets.json'), 'utf8'));
        expect(env?.options).toContain('AFD_EXTERNAL_SECRETS_FILE=/afd-cred/external-secrets.json');
        hooks.log?.(`a task said ${VALUE}`);
        return { rc: 0 };
      });
      const run = await enqueue(good);
      await ex.start();
      await ended(run.id);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.request.inputs).toMatchObject({ ansible_password: VALUE });
      expect(seen[0]?.request.inputs).not.toHaveProperty('afs_external_secrets');
      expect(externalFile).toEqual([VALUE]);
      const output = readFileSync(ex.outputFile(run.id), 'utf8');
      expect(output).toContain(
        'login "from conjur" as netops, password from CyberArk Conjur "Conjur"',
      );
      expect(output).not.toContain(VALUE);

      const failing = await enqueue(broken);
      await ended(failing.id);
      await ex.stop();
      // The run never reached Ansible; its words say no path.
      expect(seen).toHaveLength(1);
      expect(await queue.get(failing.id)).toMatchObject({
        state: 'failed',
        error:
          'Cannot read the credential "from conjur, gone" (password): CyberArk Conjur has no such variable, or "Conjur" may not read it (404)',
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('a key with a passphrase goes into an ssh-agent, the passphrase in no argument or file (AFS-66)', async () => {
    const db = database.db;
    const locked = await createCredential(db, key, project.workspace, {
      name: 'locked key',
      kind: 'ssh_key',
      fields: { username: 'netops' },
      secret: { privateKey: PRIVATE_KEY, passphrase: 'open sesame' },
    });
    const dir = join(root, 'x');
    const unlocked = await runCredentials(db, key, [locked.id], dir);
    // The container starts with the agent script, and gets the passphrase from the engine's
    // environment; Ansible is not pointed at the key file (the agent holds it).
    expect(unlocked.options).toEqual([
      '--entrypoint',
      '/afd-cred/agent',
      '-e',
      'AFS_SSH_PASSPHRASE',
    ]);
    expect(unlocked.processEnv).toEqual({ AFS_SSH_PASSPHRASE: 'open sesame' });
    expect(unlocked.secrets).toContain('open sesame');
    expect(unlocked.notes[0]).toMatch(/with its passphrase, through an ssh-agent/);
    const agent = readFileSync(join(dir, 'agent'), 'utf8');
    expect(agent).toContain('ssh-add /afd-cred/ssh_key');
    expect(agent).toContain('unset AFS_SSH_PASSPHRASE');
    expect(agent.trimEnd().endsWith('exec "$@"')).toBe(true);
    // Answers once: after a wrong passphrase ssh-add would ask forever.
    const askpass = readFileSync(join(dir, 'askpass'), 'utf8');
    expect(askpass).toContain('[ -e "$AFS_ASKPASS_ANSWERED" ] && exit 1');
    expect(askpass.trimEnd().endsWith('printf \'%s\\n\' "$AFS_SSH_PASSPHRASE"')).toBe(true);
    for (const name of ['agent', 'askpass', 'ssh_key'])
      expect(readFileSync(join(dir, name), 'utf8')).not.toContain('open sesame');
    await unlocked.cleanup();

    // A registry credential is found for the pull before the run.
    const registry = await createCredential(db, key, project.workspace, {
      name: 'private registry',
      kind: 'registry',
      fields: { host: 'registry.example.net', username: 'puller' },
      secret: { password: 'pull-S3CR3T' },
    });
    expect(await registrySignIn(db, key, [locked.id, registry.id])).toEqual({
      name: 'private registry',
      host: 'registry.example.net',
      username: 'puller',
      password: 'pull-S3CR3T',
    });
    expect(await registrySignIn(db, key, [locked.id])).toBeUndefined();
    const env = await runCredentials(db, key, [creds[3] as string], join(root, 'y'));
    expect(env).toMatchObject({
      options: ['-e', 'NETBOX_TOKEN'],
      processEnv: { NETBOX_TOKEN: 'env-S3CR3T-value' },
    });
    expect(env.secrets).toEqual(['env-S3CR3T-value']);
  });

  it("with rootless podman, the image's user is the server's (AFS-36)", () => {
    const ansible = { uid: 1000, gid: 1000 };
    expect(usernsOptions('podman', 999, ansible)).toEqual([
      '--userns',
      'keep-id:uid=1000,gid=1000',
    ]);
    // docker, a server that is root, an image that runs as root, an image not asked: nothing.
    expect(usernsOptions('docker', 999, ansible)).toEqual([]);
    expect(usernsOptions('podman', 0, ansible)).toEqual([]);
    expect(usernsOptions('podman', 999, { uid: 0, gid: 0 })).toEqual([]);
    expect(usernsOptions('podman', 999, undefined)).toEqual([]);
  });

  it('knows which registry an image comes from', () => {
    expect(registryOf('registry.example.net/ee/network:2.19')).toBe('registry.example.net');
    expect(registryOf('localhost:5000/ee:1')).toBe('localhost:5000');
    expect(registryOf('quay.io/ansible/awx-ee:24.6.1')).toBe('quay.io');
    expect(registryOf('ansible/ee:1')).toBe('docker.io');
    expect(registryOf('afd-ee:2.19')).toBe('docker.io');
  });

  it('takes nothing without a container engine, and clears what a stopped server left', async () => {
    const log = createLogger({ level: 'debug', format: 'json', write: (l) => lines.push(l) });
    const off = new Executor(
      { db: database.db, git, sync, queue, key, log },
      { dataDir, engine: 'off', image: 'x', worker: 'w', slots: 1, timeoutMs: 1000 },
    );
    expect(await off.start()).toBeUndefined();
    expect(lines.join('\n')).toContain('No container engine answers');
    await off.stop();

    const left = join(dataDir, 'work', project.id, 'run-left-over');
    mkdirSync(left, { recursive: true });
    writeFileSync(join(left, 'x'), 'x');
    const { ex } = executor(async () => ({ rc: 0 }));
    await ex.start();
    await ex.stop();
    expect(existsSync(left)).toBe(false);
  });
});

describe('the generated folder', () => {
  it('is made fresh beside the flow, replacing what the commit had there', async () => {
    const dir = join(root, 'gen');
    mkdirSync(join(dir, 'flows', 'generated'), { recursive: true });
    writeFileSync(join(dir, 'flows', 'generated', 'old.yml'), 'hand edited');
    const code = {
      ok: true,
      files: [{ name: 'hello.yml', text: '- hosts: all\n', level: 'root' }],
      findings: [],
      routes: {},
      plays: {},
    };
    expect(await writeGenerated(dir, 'flows/hello.flow.yaml', code)).toBe(
      'flows/generated/hello.yml',
    );
    expect(readdirSync(join(dir, 'flows', 'generated'))).toEqual(['hello.yml']);
    await expect(
      writeGenerated(dir, 'flows/hello.flow.yaml', {
        ...code,
        files: [{ name: '../x.yml', text: '', level: 'root' }],
      }),
    ).rejects.toThrow(/Not a generated file name/);
    expect(statSync(join(dir, 'flows')).isDirectory()).toBe(true);
  });
});
