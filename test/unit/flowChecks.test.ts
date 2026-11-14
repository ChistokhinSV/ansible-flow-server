// What a flow needs from its environment (AFS-33), on both databases, with the engine and the
// collection server played by the test: the needs are read from the flow's steps (a catalog-bound
// cisco.ios step) and the project's collections/requirements.yml (which adds ansible.utils), at the
// commit the configuration runs; checked against the environment's image (cisco.ios there and new
// enough, ansible.utils missing); against another environment of the workspace; before any build;
// an environment made for the flow (rw on the workspace) carries exactly the needs and is built;
// the collection search, and what it says when the server is out of reach.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
// The Hello sample with one step on a collection, chosen from the module catalog at 11.6.0.
const FLOW = readFileSync(join(__dirname, '../fixtures/hello.flow.yaml'), 'utf8').replace(
  '    ref: ansible.builtin.setup\n',
  '    ref: cisco.ios.ios_facts\n    collection_version: 11.6.0\n',
);
const REQUIREMENTS = 'collections:\n  - name: ansible.utils\n    version: ">=6.0.0"\n';
const root = mkdtempSync(join(tmpdir(), 'afs-check-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

let offline = false;
const galaxy: Galaxy = {
  async versions(name) {
    return name === 'cisco.ios' ? ['11.7.0', '11.6.0'] : ['6.1.1', '5.1.0'];
  },
  async search(words) {
    if (offline) throw new Error('https://galaxy.example.net cannot be reached (fetch failed)');
    return [{ name: 'cisco.ios', version: '11.7.0', description: `Cisco IOS, for "${words}"` }];
  },
};
/** The image holds cisco.ios 11.7.0 and ansible.netcommon, not ansible.utils. */
const runner: Runner = async (_c, args) =>
  args[0] === 'run'
    ? {
        code: 0,
        stdout:
          '2.19.4\n{"/c": {"cisco.ios": {"version": "11.7.0"}, "ansible.netcommon": {"version": "8.7.1"}}}\n',
      }
    : { code: 0, stdout: '' };

for (const [name, config] of databases) {
  describe.skipIf(!config)(`flow and environment checks on ${name}`, () => {
    let database: Database;
    let app: FastifyInstance;
    let environments: Environments;
    let source: TestRepo;
    let configId: string;
    let envId: string;
    const tokens: Record<string, string> = {};
    const db = () => database.db;
    const call = (who: string, method: 'GET' | 'POST', url: string, body?: object) =>
      app.inject({
        method,
        url: `/api/v1${url}`,
        headers: {
          authorization: `Bearer ${tokens[who]}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { payload: JSON.stringify(body) } : {}),
      });

    beforeAll(async () => {
      if (!config) return;
      database = openDatabase(config);
      await migrate(database.db as never);
      await emptyWorkspaces(db());
      await emptyPeople(db());
      const log = createLogger({ level: 'silent', format: 'json', write: () => undefined });
      const git = new Git({ reposDir: join(root, `repos-${name}`), allowLocal: true });
      const sync = new ProjectSync(db(), git, log);
      source = testRepo({
        'flows/hello.flow.yaml': FLOW,
        'collections/requirements.yml': REQUIREMENTS,
      });
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
      configId = (
        await new LaunchConfigs(db(), git).create(project, {
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
      envId = (
        await environments.create(
          ws.id,
          {
            name: 'ios',
            kind: 'spec',
            spec: { collections: [{ name: 'cisco.ios', version: 'latest' }] },
          } as never,
          'rita',
        )
      ).id;
    });
    afterAll(async () => {
      await environments?.stop();
      await app?.close();
      await database?.close();
      source?.remove();
    });

    it("reads the flow's needs at its commit; before a build nothing is known to be there", async () => {
      const check = (
        await call(
          'omar',
          'GET',
          `/launch-configs/${configId}/environment-check?environment=${envId}`,
        )
      ).json();
      expect(check).toMatchObject({
        flow: { file: 'flows/hello.flow.yaml' },
        requirementsFile: true,
        ok: false,
      });
      expect(
        check.lines.map((l: { name: string; wants: string; from: string }) => [
          l.name,
          l.wants,
          l.from,
        ]),
      ).toEqual([
        ['ansible.utils', '>=6.0.0', 'requirements'],
        ['cisco.ios', '>=11.6.0', 'flow'],
      ]);
      expect(check.lines[1]).toMatchObject({
        nodes: ['facts'],
        ok: false,
        why: expect.stringMatching(/build it/),
      });
    });

    it('checks against what the built image holds: there, or missing', async () => {
      await environments.queue(envId, { id: 'x', login: 'rita' });
      await environments.idle();
      const check = (
        await call(
          'omar',
          'GET',
          `/launch-configs/${configId}/environment-check?environment=${envId}`,
        )
      ).json();
      expect(check.environment).toMatchObject({ name: 'ios', ansibleCore: '2.19.4' });
      expect(check.lines).toEqual([
        expect.objectContaining({ name: 'ansible.utils', ok: false, why: 'Not in the image' }),
        expect.objectContaining({ name: 'cisco.ios', ok: true, has: '11.7.0' }),
      ]);
      // Without an environment of its own and none asked for, only the needs.
      const bare = (
        await call('omar', 'GET', `/launch-configs/${configId}/environment-check`)
      ).json();
      expect(bare.environment).toBeUndefined();
    });

    it('makes an environment for the flow from its needs, and builds it (rw on the workspace)', async () => {
      expect(
        (
          await call('omar', 'POST', `/launch-configs/${configId}/environment`, {
            name: 'hello-ee',
          })
        ).statusCode,
      ).toBe(403);
      const made = await call('rita', 'POST', `/launch-configs/${configId}/environment`, {
        name: 'hello-ee',
      });
      expect(made.statusCode).toBe(201);
      expect(made.json().spec.collections).toEqual([
        { name: 'ansible.utils', version: '>=6.0.0' },
        { name: 'cisco.ios', version: '>=11.6.0' },
      ]);
      await environments.idle();
      const built = (await call('rita', 'GET', `/environments/${made.json().id}/builds`)).json()[0];
      expect(built).toMatchObject({
        state: 'done',
        lock: { collections: { 'ansible.utils': '6.1.1', 'cisco.ios': '11.7.0' } },
      });
    });

    it('searches the collection server, and says what to do when it is out of reach', async () => {
      const found = await call('omar', 'GET', '/galaxy/search?q=ios');
      expect(found.json()).toEqual([
        { name: 'cisco.ios', version: '11.7.0', description: 'Cisco IOS, for "ios"' },
      ]);
      offline = true;
      const away = await call('omar', 'GET', '/galaxy/search?q=ios');
      offline = false;
      expect(away.statusCode).toBe(503);
      expect(away.json().message).toMatch(/Type the collection's name and version instead/);
    });
  });
}
