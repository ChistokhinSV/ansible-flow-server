// Search as you type (AFS-69), on both databases the server supports: what a question names,
// narrowed to what the person may see. rita has rw on one workspace and sees its projects, flows,
// launch configurations, runs and environments, never the other workspace's; omar has a grant on
// one flow only and finds that flow and its runs, not the flow beside it; people and groups are
// for administrators; a run is found by its number; a token made for one workspace searches there.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGrant } from '../../src/server/access/grants';
import { buildApp } from '../../src/server/app';
import { createToken } from '../../src/server/auth/tokens';
import { createGroup, createUser } from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs } from '../../src/server/launch/configs';
import { prepareLaunch, withoutSecrets } from '../../src/server/launch/prepare';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { RunQueue } from '../../src/server/runs/queue';
import { score } from '../../src/server/search/search';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { emptyPeople, emptyWorkspaces } from './helpers/clean';
import { type TestRepo, testRepo } from './helpers/repo';

const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const HELLO = readFileSync(join(__dirname, '../fixtures/hello.flow.yaml'), 'utf8');
// A second flow beside it: another key and name.
const BACKUP = HELLO.replace('key: hello\n', 'key: backup-configs\n').replace(
  'name: Hello, Ansible',
  'name: Backup configs',
);
const root = mkdtempSync(join(tmpdir(), 'afs-search-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

describe('score', () => {
  it('needs every word somewhere; a whole match beats a prefix, a word start beats inside', () => {
    expect(score('hel ans', ['Hello, Ansible'])).toBeGreaterThan(0);
    expect(score('hello zzz', ['Hello, Ansible'])).toBe(0);
    expect(score('edge', ['edge'])).toBeGreaterThan(score('edge', ['edge-flows']));
    expect(score('edge', ['edge-flows'])).toBeGreaterThan(score('dge', ['edge-flows']));
  });
});

for (const [name, config] of databases) {
  describe.skipIf(!config)(`search on ${name}`, () => {
    let database: Database;
    let app: FastifyInstance;
    let source: TestRepo;
    let other: TestRepo;
    let runNumber = 0;
    const tokens: Record<string, string> = {};
    const db = () => database.db;
    const find = async (who: string, q: string) => {
      const reply = await app.inject({
        url: `/api/v1/search?q=${encodeURIComponent(q)}`,
        headers: { authorization: `Bearer ${tokens[who]}` },
      });
      expect(reply.statusCode).toBe(200);
      return reply.json() as { kind: string; title: string; detail: string; to: string }[];
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
      source = testRepo({ 'flows/hello.flow.yaml': HELLO, 'flows/backup.flow.yaml': BACKUP });
      other = testRepo({ 'flows/hello.flow.yaml': HELLO });
      const net = await createWorkspace(db(), { key: 'net', name: 'Network' });
      const ops = await createWorkspace(db(), { key: 'ops', name: 'Operations' });
      const edge = await createProject(
        db(),
        net.id,
        { key: 'edge', name: 'Edge routers', gitUrl: source.dir, pollSeconds: 0 },
        true,
      );
      const core = await createProject(
        db(),
        ops.id,
        { key: 'core', name: 'Core switches', gitUrl: other.dir, pollSeconds: 0 },
        true,
      );
      await sync.sync(edge.id);
      await sync.sync(core.id);
      const configs = new LaunchConfigs(db(), git);
      const helloConfig = await configs.create(edge.id, {
        name: 'Hello nightly',
        flowFile: 'flows/hello.flow.yaml',
        inputs: { devices: ['fw-edge-01'] },
      });
      await configs.create(edge.id, {
        name: 'Backup weekly',
        flowFile: 'flows/backup.flow.yaml',
        inputs: { devices: ['fw-edge-01'] },
      });
      await configs.create(core.id, {
        name: 'Hello in ops',
        flowFile: 'flows/hello.flow.yaml',
        inputs: { devices: ['sw-01'] },
      });
      const queue = new RunQueue(db(), database.kind, key);
      const prepared = await prepareLaunch({ db: db(), git, sync }, helloConfig, {}, false);
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.problems));
      runNumber = (
        await queue.enqueue(
          prepared.launch,
          withoutSecrets(prepared.launch, prepared.form.fields).inputs,
          { id: 'x', login: 'dana' },
          'Hello nightly',
        )
      ).number;
      await db()
        .insertInto('environment')
        .values({
          id: 'env-1',
          workspace_id: net.id,
          name: 'net-tools',
          description: null,
          kind: 'image',
          image: 'afd-ee:2.19',
          spec_json: null,
          keep: 3,
          created_by: 'dana',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .execute();

      await createUser(db(), {
        login: 'dana',
        name: 'Dana Whitfield',
        password: 'x'.repeat(12),
        admin: true,
      });
      for (const login of ['rita', 'omar'])
        await createUser(db(), {
          login,
          name: login === 'rita' ? 'Rita Okafor' : 'Omar Haddad',
          password: 'x'.repeat(12),
        });
      await createGroup(db(), { name: 'netops' });
      await createGrant(db(), net.id, { user: 'rita', level: 'rw' }, 'test');
      await createGrant(
        db(),
        net.id,
        { user: 'omar', level: 'operator', project: edge.id, flow: 'flows/hello.flow.yaml' },
        'test',
      );
      for (const u of await db().selectFrom('user_account').select(['id', 'login']).execute())
        tokens[u.login] = (await createToken(db(), u.id, { name: 't' })).token;
      tokens['dana-net'] = (
        await createToken(
          db(),
          (
            await db()
              .selectFrom('user_account')
              .select('id')
              .where('login', '=', 'dana')
              .executeTakeFirstOrThrow()
          ).id,
          { name: 'net only', workspace: net.id },
        )
      ).token;

      app = buildApp({
        log,
        database,
        instance: 'test',
        masterKey: key,
        runs: queue,
        projects: { git, sync, allowLocal: true },
      });
    });
    afterAll(async () => {
      await app?.close();
      await database?.close();
      source?.remove();
      other?.remove();
    });

    it("rw on a workspace finds its projects, flows, configurations, runs and environments, not another's", async () => {
      const hello = await find('rita', 'hello');
      expect(hello.map((h) => `${h.kind} ${h.title}`)).toEqual(
        expect.arrayContaining([
          'flow Hello, Ansible',
          'launch-config Hello nightly',
          `run Run ${runNumber} · Hello, Ansible`,
        ]),
      );
      expect(hello.some((h) => h.detail.startsWith('ops/'))).toBe(false);
      const flow = hello.find((h) => h.kind === 'flow');
      expect(flow?.to).toBe('/w/net/edge/flow/flows/hello.flow.yaml');
      expect((await find('rita', 'edge rout'))[0]).toMatchObject({
        kind: 'project',
        title: 'Edge routers',
        to: '/w/net/edge',
      });
      expect(await find('rita', 'net-tools')).toEqual([
        expect.objectContaining({ kind: 'environment', to: '/w/net/environments/env-1' }),
      ]);
      expect(await find('rita', 'core switches')).toEqual([]);
      // People are for administrators.
      expect(await find('rita', 'omar')).toEqual([]);
    });

    it('a grant on one flow finds that flow and its runs, not the flow beside it', async () => {
      const kinds = (await find('omar', 'hello')).map((h) => `${h.kind} ${h.title}`);
      expect(kinds).toContain('flow Hello, Ansible');
      expect(kinds).toContain(`run Run ${runNumber} · Hello, Ansible`);
      expect(await find('omar', 'backup')).toEqual([]);
    });

    it('a run by its number; people and groups for administrators; a workspace token searches there', async () => {
      expect((await find('rita', `#${runNumber}`))[0]).toMatchObject({
        kind: 'run',
        to: expect.stringMatching(/^\/runs\//),
      });
      expect((await find('rita', `run ${runNumber}`))[0]).toMatchObject({ kind: 'run' });
      const people = await find('dana', 'omar');
      expect(people[0]).toMatchObject({
        kind: 'user',
        title: 'Omar Haddad',
        to: expect.stringMatching(/^\/admin\/people\//),
      });
      expect((await find('dana', 'netops'))[0]).toMatchObject({ kind: 'group' });
      // An administrator sees both workspaces...
      expect((await find('dana', 'hello')).filter((h) => h.kind === 'flow')).toHaveLength(2);
      // ...a token made for net only finds net, and no people.
      const scoped = await find('dana-net', 'hello');
      expect(scoped.filter((h) => h.kind === 'flow')).toHaveLength(1);
      expect(await find('dana-net', 'omar')).toEqual([]);
      expect(await find('rita', 'h')).toEqual([]);
    });
  });
}
