// AFS-261: the launch form's inventory read in a real container (the designer's probe), for a
// configuration whose machine credential takes its password from a secret provider that cannot be
// read. The groups come all the same: only env credentials are opened for the inventory; a run of
// it fails and names the provider. Needs a container engine and an image with ansible-core:
// AFS_TEST_STEP_IMAGE=afd-ee:2.19 npx vitest run test/unit/probesSecretsDocker.test.ts.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { listAudit } from '../../src/server/audit/store';
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
import { createCredential } from '../../src/server/secrets/credentials';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { createSecretProvider } from '../../src/server/secrets/providers/store';
import { type TestRepo, testRepo } from './helpers/repo';

const image = process.env.AFS_TEST_STEP_IMAGE;
const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const HELLO = readFileSync(join(__dirname, '../fixtures/hello.flow.yaml'), 'utf8');

describe.skipIf(!image)('the launch form reads groups past an unreadable credential', () => {
  const root = mkdtempSync(join(tmpdir(), 'afs-probe-secrets-'));
  let database: Database;
  let sync: ProjectSync;
  let queue: RunQueue;
  let source: TestRepo;
  let ex: Executor;
  let git: Git;
  let config: string;
  let credential: string;
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
      'inventory/hosts.yaml':
        'all:\n  children:\n    local:\n      hosts:\n        localhost:\n          ansible_connection: local\n',
    });
    const workspace = (await createWorkspace(db, { key: 'net', name: 'Network' })).id;
    // Nothing listens on port 1: every read from it fails.
    await createSecretProvider(db, key, {
      key: 'gone-vault',
      name: 'Gone Vault',
      kind: 'vault',
      settings: { address: 'http://127.0.0.1:1', auth: 'token', timeoutS: 2 },
      secret: { token: 'hvs.fictional-token' },
      workspaces: [workspace],
    });
    credential = (
      await createCredential(db, key, workspace, {
        name: 'Lab switches',
        kind: 'login',
        fields: { username: 'netops' },
        secret: {},
        refs: { password: { provider: 'gone-vault', path: 'lab/other', field: 'password' } },
      })
    ).id;
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
        credentials: [credential],
      })
    ).id;
    ex = new Executor(
      { db, git, sync, queue, key, log },
      {
        dataDir: join(root, 'data'),
        engine: 'docker',
        image: image as string,
        worker: 'probe-secrets-test',
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

  it('offers the groups, and a run of it fails naming the credential and the provider', async () => {
    const c = await new LaunchConfigs(database.db, git).get(config);
    const prepared = await prepareLaunch({ db: database.db, git, sync }, c as never, {
      mode: 'real',
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.problems));
    const answer = await ex.inventory({
      project: prepared.launch.project,
      commit: prepared.form.commit,
      doc: parseYaml(HELLO) as FlowDocument,
      inputs: { devices: ['localhost'] },
      inventory: 'inventory/hosts.yaml',
      credentials: [credential],
      groups: true,
    });
    expect(answer.groupsError).toBeUndefined();
    expect(answer.groups).toContain('local');
    expect(answer.facts?.hosts).toEqual(['localhost']);

    const run = await queue.enqueue(
      prepared.launch,
      withoutSecrets(prepared.launch, prepared.form.fields).inputs,
      { id: 'u1', login: 'dana' },
      'Hello',
    );
    await ex.fill();
    const end = Date.now() + 120_000;
    while (
      Date.now() < end &&
      !['failed', 'succeeded'].includes((await queue.get(run.id))?.state ?? '')
    )
      await new Promise((r) => setTimeout(r, 200));
    const done = await queue.get(run.id);
    expect(done?.state).toBe('failed');
    expect(done?.error).toMatch(
      /Cannot read the credential "Lab switches" \(password\): .*HashiCorp Vault "Gone Vault"/,
    );
    const reads = await listAudit(database.db, { action: 'secret-provider.read' } as never);
    expect(reads.entries.some((e) => e.detail?.run === run.id && e.result === 'failed')).toBe(true);
  }, 300_000);
});
