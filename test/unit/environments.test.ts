// Execution environments (AFS-32), on both databases the server supports (PostgreSQL when
// AFS_TEST_POSTGRES_URL is set), with the container engine and the collection server played by
// the test: who may set one up; what a spec may hold (nothing that becomes a command); a build
// settles `latest` and ranges into a lock, writes a Dockerfile shaped like afd-ee, tags the image
// by its inputs and reads what it holds; a launch configuration in the environment gets the newest
// good build's image; old images go; a registered image is pulled and read; a collection server
// out of reach fails a build that needs it; the ansible-builder file; delete refused while in use.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createGrant } from '../../src/server/access/grants';
import { buildApp } from '../../src/server/app';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { Environments, type Runner } from '../../src/server/environments/environments';
import type { Galaxy } from '../../src/server/environments/galaxy';
import { LaunchConfigs } from '../../src/server/launch/configs';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { RunQueue } from '../../src/server/runs/queue';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { emptyPeople, emptyWorkspaces } from './helpers/clean';
import { type TestRepo, testRepo } from './helpers/repo';

const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const HELLO = readFileSync(join(__dirname, '../fixtures/hello.flow.yaml'), 'utf8');
const root = mkdtempSync(join(tmpdir(), 'afs-env-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

/** Galaxy as the test has it: newest first; `offline` makes it unreachable. */
const VERSIONS: Record<string, string[]> = {
  'cisco.ios': ['12.0.0-beta1', '11.7.0', '11.6.0', '10.2.0'],
  'ansible.netcommon': ['8.8.0', '8.7.1'],
};
let offline = false;
const galaxy: Galaxy = {
  async versions(name) {
    if (offline) throw new Error('fetch failed');
    return VERSIONS[name] ?? [];
  },
};

/** The engine as the test has it: what it was asked, and the Dockerfile each build got. */
const asked: string[][] = [];
const dockerfiles: string[] = [];
let failBuild = false;
const runner: Runner = async (_command, args, { log }) => {
  asked.push(args);
  if (args[0] === 'build') {
    dockerfiles.push(readFileSync(join(args.at(-1) as string, 'Dockerfile'), 'utf8'));
    log?.('Step 1/4 : FROM python\n');
    return { code: failBuild ? 1 : 0, stdout: '' };
  }
  if (args[0] === 'run')
    return {
      code: 0,
      stdout:
        '2.19.4\n{"/usr/share/ansible/collections/ansible_collections": {"cisco.ios": {"version": "11.7.0"}, "ansible.netcommon": {"version": "8.7.1"}}}\n',
    };
  return { code: 0, stdout: '' };
};

for (const [name, config] of databases) {
  describe.skipIf(!config)(`execution environments on ${name}`, () => {
    let database: Database;
    let app: FastifyInstance;
    let environments: Environments;
    let source: TestRepo;
    let configs: LaunchConfigs;
    let configId: string;
    const tokens: Record<string, string> = {};
    const db = () => database.db;
    const call = (
      who: string,
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: string,
      body?: object,
    ) =>
      app.inject({
        method,
        url: `/api/v1${url}`,
        headers: {
          authorization: `Bearer ${tokens[who]}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { payload: JSON.stringify(body) } : {}),
      });
    const build = async (id: string) => {
      const queued = await call('rita', 'POST', `/environments/${id}/builds`);
      expect(queued.statusCode).toBe(201);
      await environments.idle();
      return (await call('omar', 'GET', `/environments/${id}/builds`)).json()[0];
    };

    beforeAll(async () => {
      if (!config) return;
      database = openDatabase(config);
      await migrate(database.db as never);
      await emptyWorkspaces(db());
      await emptyPeople(db());
      const log = createLogger({ level: 'silent', format: 'json', write: () => undefined });
      const git = new Git({ reposDir: join(root, `repos-${name}`), allowLocal: true });
      const sync = new ProjectSync(db(), git, log);
      source = testRepo({ 'flows/hello.flow.yaml': HELLO });
      const ws = await createWorkspace(db(), { key: 'net', name: 'Network' });
      const project = (
        await createProject(
          db(),
          ws.id,
          { key: 'edge', name: 'Edge', gitUrl: source.dir, pollSeconds: 0 },
          true,
        )
      ).id;
      await sync.sync(project);
      configs = new LaunchConfigs(db(), git);
      configId = (
        await configs.create(project, {
          name: 'Hello',
          flowFile: 'flows/hello.flow.yaml',
          inputs: { devices: ['fw-edge-01'] },
        })
      ).id;
      for (const login of ['rita', 'omar'])
        await createUser(db(), { login, name: login, password: 'x'.repeat(12) });
      await createGrant(db(), ws.id, { user: 'rita', level: 'rw' }, 'test');
      await createGrant(db(), ws.id, { user: 'omar', level: 'operator' }, 'test');
      for (const u of await db().selectFrom('user_account').select(['id', 'login']).execute())
        tokens[u.login] = (await createToken(db(), u.id, { name: 't' })).token;
      environments = new Environments({
        db: db(),
        log,
        galaxy,
        dir: join(root, `env-${name}`),
        engine: 'docker',
        timeoutMs: 60_000,
        runner,
      });
      await environments.start();
      app = buildApp({
        log,
        database,
        instance: 'test',
        masterKey: key,
        runs: new RunQueue(db(), database.kind, key),
        projects: { git, sync, allowLocal: true },
        environments,
      });
    });
    afterAll(async () => {
      await environments?.stop();
      await app?.close();
      await database?.close();
      source?.remove();
    });

    it('rw on the workspace sets one up; nothing in a spec becomes a command', async () => {
      const spec = { collections: [{ name: 'cisco.ios', version: 'latest' }] };
      expect(
        (
          await call('omar', 'POST', '/workspaces/net/environments', {
            name: 'net',
            kind: 'spec',
            spec,
          })
        ).statusCode,
      ).toBe(403);
      const refused = async (body: object) =>
        (
          await call('rita', 'POST', '/workspaces/net/environments', {
            name: 'net',
            kind: 'spec',
            ...body,
          })
        ).json();
      expect(
        await refused({ spec: { collections: [{ name: 'cisco.ios; rm -rf /', version: '1' }] } }),
      ).toMatchObject({ field: 'collections' });
      expect(await refused({ spec: { python: ['netaddr; curl evil.example'] } })).toMatchObject({
        field: 'python',
      });
      expect(await refused({ spec: { system: ['vim && id'] } })).toMatchObject({ field: 'system' });
      expect(await refused({ spec: { ansibleCore: 'latest' } })).toMatchObject({
        field: 'ansibleCore',
      });
      expect(await refused({ name: 'Net Tools', spec })).toMatchObject({ field: 'name' });

      const made = await call('rita', 'POST', '/workspaces/net/environments', {
        name: 'net-tools',
        kind: 'spec',
        keep: 1,
        spec: {
          ansibleCore: '2.19',
          collections: [
            { name: 'cisco.ios', version: 'latest' },
            { name: 'ansible.netcommon', version: '>=8.0.0,<8.8.0' },
          ],
          python: ['netaddr>=1.3'],
          system: ['iputils-ping'],
        },
      });
      expect(made.statusCode).toBe(201);
      expect(made.json()).toMatchObject({ name: 'net-tools', kind: 'spec', usedBy: 0 });
      expect(made.json().current).toBeUndefined();
      expect((await call('omar', 'GET', '/workspaces/net/environments')).json()).toHaveLength(1);
    });

    it('a launch configuration in it waits for a build, then gets the newest good image', async () => {
      const env = (await call('omar', 'GET', '/workspaces/net/environments')).json()[0];
      await configs.update(configId, { environment: env.id });
      const before = await call('rita', 'POST', `/launch-configs/${configId}/check`, {});
      expect(before.statusCode).toBe(422);
      expect(before.json().problems[0]).toMatchObject({
        field: 'environment',
        message: expect.stringMatching(/no successful build/),
      });

      const b = await build(env.id);
      expect(b.state).toBe('done');
      // Settled: latest is the newest stable, the range its newest match.
      expect(b.lock.collections).toEqual({ 'cisco.ios': '11.7.0', 'ansible.netcommon': '8.7.1' });
      expect(b.lock.ansibleCore).toBe('2.19.4');
      expect(b.image).toMatch(/^afs-ee\/net-net-tools:[0-9a-f]{16}$/);
      expect(b.catalog.collections['cisco.ios']).toBe('11.7.0');
      const file = dockerfiles.at(-1) as string;
      expect(file).toContain('pip install --no-cache-dir "ansible-core==2.19.*" "netaddr>=1.3"');
      expect(file).toContain('cisco.ios:==11.7.0 ansible.netcommon:==8.7.1');
      expect(file).toContain('iputils-ping');
      expect(file).toContain('useradd --create-home --uid 1000 ansible');
      const log = (await call('omar', 'GET', `/environments/${env.id}/builds/${b.id}/log`)).body;
      expect(log).toMatch(/cisco\.ios latest -> 11\.7\.0/);

      const check = await call('rita', 'POST', `/launch-configs/${configId}/check`, {});
      expect(check.json().launch.eeImage).toBe(b.image);
      expect((await call('omar', 'GET', `/environments/${env.id}`)).json()).toMatchObject({
        current: b.image,
        usedBy: 1,
      });
    });

    it('a changed spec builds a new image; beyond keep the old one goes', async () => {
      const env = (await call('omar', 'GET', '/workspaces/net/environments')).json()[0];
      const first = env.current;
      await call('rita', 'PATCH', `/environments/${env.id}`, {
        spec: { ...env.spec, python: ['netaddr>=1.3', 'jmespath'] },
      });
      const b = await build(env.id);
      expect(b.image).not.toBe(first);
      expect(asked.some((a) => a[0] === 'rmi' && a[1] === first)).toBe(true);
      const all = (await call('omar', 'GET', `/environments/${env.id}/builds`)).json();
      expect(all[1]).toMatchObject({ pruned: true });
      expect(
        (await call('rita', 'POST', `/launch-configs/${configId}/check`, {})).json().launch.eeImage,
      ).toBe(b.image);
    });

    it('fails what it cannot do, with why', async () => {
      const env = (await call('omar', 'GET', '/workspaces/net/environments')).json()[0];
      offline = true;
      const b = await build(env.id);
      offline = false;
      expect(b).toMatchObject({
        state: 'failed',
        error: expect.stringMatching(/Pin an exact version, or set AFS_GALAXY_URL/),
      });
      failBuild = true;
      const c = await build(env.id);
      failBuild = false;
      expect(c).toMatchObject({ state: 'failed', error: expect.stringMatching(/see its log/) });
      // A failed build leaves the last good image in use.
      expect((await call('omar', 'GET', `/environments/${env.id}`)).json().current).toMatch(
        /^afs-ee\//,
      );
    });

    it('a registered image is pulled and read; the ansible-builder file; delete refused while in use', async () => {
      const made = (
        await call('rita', 'POST', '/workspaces/net/environments', {
          name: 'awx-default',
          kind: 'image',
          image: 'quay.io/ansible/awx-ee:24.6.1',
        })
      ).json();
      expect(made.current).toBe('quay.io/ansible/awx-ee:24.6.1');
      const b = await build(made.id);
      expect(asked.some((a) => a[0] === 'pull' && a[1] === 'quay.io/ansible/awx-ee:24.6.1')).toBe(
        true,
      );
      expect(b).toMatchObject({ state: 'done', catalog: { ansibleCore: '2.19.4' } });

      const env = (await call('omar', 'GET', '/workspaces/net/environments'))
        .json()
        .find((e: { name: string }) => e.name === 'net-tools');
      const yml = await call('omar', 'GET', `/environments/${env.id}/execution-environment.yml`);
      const doc = parse(yml.body);
      expect(doc).toMatchObject({
        version: 3,
        images: { base_image: { name: 'quay.io/centos/centos:stream9' } },
        dependencies: {
          ansible_core: { package_pip: 'ansible-core==2.19.4' },
          ansible_runner: { package_pip: 'ansible-runner' },
          python: ['netaddr>=1.3', 'jmespath'],
        },
      });
      expect(doc.dependencies.galaxy.collections).toContainEqual({
        name: 'cisco.ios',
        version: '11.7.0',
      });
      expect(yml.body).toMatch(/Debian packages in the environment: iputils-ping/);

      const refused = await call('rita', 'DELETE', `/environments/${env.id}`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().message).toMatch(/launch configuration runs in it/);
      await configs.update(configId, { environment: null });
      const image = env.current;
      expect((await call('rita', 'DELETE', `/environments/${env.id}`)).statusCode).toBe(204);
      expect(asked.filter((a) => a[0] === 'rmi').map((a) => a[1])).toContain(image);
    });
  });
}
