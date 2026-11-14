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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunView } from '@ansible-flow/core/protocol';
import type { RunFlowHooks, RunFlowRequest } from '@ansible-flow/node/run/runFlow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs } from '../../src/server/launch/configs';
import { prepareLaunch, withoutSecrets } from '../../src/server/launch/prepare';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace, type Project } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { registrySignIn, runCredentials } from '../../src/server/runs/credentials';
import { Executor } from '../../src/server/runs/executor';
import { RunQueue } from '../../src/server/runs/queue';
import { registryOf } from '../../src/server/runs/registry';
import { rootFromGenerated, writeGenerated } from '../../src/server/runs/workdir';
import { createCredential } from '../../src/server/secrets/credentials';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
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
function executor(fake: Fake, options: { timeoutMs?: number } = {}) {
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
      runner: async (request, hooks) => {
        const s: Seen = { request, hooks };
        const keyMount = request.env.kind === 'container' ? request.env.mounts[0] : undefined;
        if (keyMount) s.keyFile = readFileSync(join(keyMount.src, 'ssh_key'), 'utf8');
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

describe('a run', () => {
  it("gets the commit's files, the flow's code fresh, its inputs and credentials, and ends", async () => {
    const { ex, seen } = executor(async (_request, hooks) => {
      hooks.log?.('TASK [hello] ok: [fw-edge-01] token=input-S3CR3T vault=vault-S3CR3T');
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
    expect(output).toContain('Credential: SSH key "key" as netops');
    expect(output).not.toContain('S3CR3T');
    expect(lines.join('\n')).not.toContain('S3CR3T');
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
    expect(await queue.get(failed.id)).toMatchObject({
      state: 'failed',
      error: 'ansible-playbook ended with 2; 1 host(s) failed',
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
    expect(await queue.get(cancelled.id)).toMatchObject({
      state: 'cancelled',
      error: 'Stopped on request',
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
