// Launch configurations and what a launch would run. The project is a real repository in a
// folder of this machine; the rules run on both databases the server supports (PostgreSQL when
// AFS_TEST_POSTGRES_URL is set).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs, LaunchError } from '../../src/server/launch/configs';
import { prepareLaunch } from '../../src/server/launch/prepare';
import type { InventoryReader } from '../../src/server/launch/routes';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import {
  createProject,
  createWorkspace,
  deleteProject,
  type Project,
} from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import {
  createCredential,
  deleteCredential,
  getCredential,
} from '../../src/server/secrets/credentials';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { emptyPeople, emptyWorkspaces } from './helpers/clean';
import { grant } from './helpers/grant';
import { type TestRepo, testRepo } from './helpers/repo';

const PASSWORD = 'correct horse battery staple';
const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name), 'utf8');
// The smallest flow, with two more inputs: a number, and one whose name looks like a secret.
const PING = fixture('hello.flow.yaml').replace(
  '    devices:',
  '    api_password:\n      type: string\n    retries:\n      type: integer\n    devices:',
);
const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const root = mkdtempSync(join(tmpdir(), 'afs-launch-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

for (const [name, config] of databases) {
  describe.skipIf(!config)(`launch configurations on ${name}`, () => {
    let database: Database;
    let app: FastifyInstance;
    let git: Git;
    let sync: ProjectSync;
    let source: TestRepo;
    let project: Project;
    let configs: LaunchConfigs;
    let first: string;
    let workspace: string;
    let ssh: string;
    let vault: string;
    let token: string;
    let admin: string;
    let member: string;
    let readOnly: string;
    const db = () => database.db;
    const deps = () => ({ db: db(), git, sync });
    const asked: Parameters<InventoryReader>[0][] = [];

    beforeAll(async () => {
      if (!config) return;
      database = openDatabase(config);
      await migrate(database.db as never);
      await emptyWorkspaces(db());
      await emptyPeople(db());
      source = testRepo({
        'ping.flow.yaml': PING,
        'flows/firewall-upgrade.flow.yaml': fixture('firewall-upgrade.flow.yaml'),
        'broken.flow.yaml': 'flow: [this is not\n',
        'inventory/prod/hosts.yaml': 'all:\n  hosts:\n    fw-edge-01: {}\n',
        'README.md': 'Flows\n',
      });
      const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
      git = new Git({ reposDir: join(root, `repos-${name}`), allowLocal: true });
      sync = new ProjectSync(db(), git, log);
      app = buildApp({
        log,
        database,
        instance: 'test',
        masterKey: key,
        projects: { git, sync, allowLocal: true },
        // AFS-67: the inventory as a probe in the image would read it, played by the test.
        inventory: async (q) => {
          asked.push(q);
          const targets = (q.inputs.devices as string[] | undefined) ?? [];
          const known: string[] = targets.filter((t) => t === 'fw-edge-01');
          return {
            ...(targets.length === 0
              ? { factsError: 'No target hosts: the targets input is empty' }
              : {
                  facts: {
                    sources: [q.inventory ?? 'ansible.cfg'],
                    count: known.length,
                    hosts: known,
                    unknown: targets.filter((t) => !known.includes(t)),
                    uses: [],
                    prod: [],
                    vault: false,
                    environment: `${q.image ?? 'default'} (docker)`,
                  },
                }),
            ...(q.groups
              ? { groups: ['edge'], groupHosts: { edge: { count: 1, hosts: known } } }
              : {}),
            environment: `${q.image ?? 'default'} (docker)`,
          };
        },
      });
      configs = new LaunchConfigs(db(), git);
      workspace = (await createWorkspace(db(), { key: 'net', name: 'Network' })).id;
      const made = await createProject(
        db(),
        workspace,
        { key: 'core', name: 'Core', gitUrl: source.dir, pollSeconds: 0 },
        true,
      );
      project = (await sync.sync(made.id)) as Project;
      first = project.commit as string;
      const credential = (
        kind: 'ssh_key' | 'vault' | 'git_token',
        secret: Record<string, string>,
      ) => createCredential(db(), key, workspace, { name: kind, kind, secret }).then((c) => c.id);
      ssh = await credential('ssh_key', {
        privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${'QUFB'.repeat(12)}\n-----END OPENSSH PRIVATE KEY-----`,
      });
      vault = await credential('vault', { password: 'p' });
      token = await credential('git_token', { token: 't' });

      const signIn = async (login: string, isAdmin: boolean) => {
        const user = await createUser(db(), {
          login,
          name: login,
          password: PASSWORD,
          admin: isAdmin,
        });
        const reply = await app.inject({
          method: 'POST',
          url: '/api/v1/session',
          payload: { login, password: PASSWORD },
        });
        return {
          id: user.id,
          cookie:
            /afs_session=[^;]*/.exec([reply.headers['set-cookie']].flat().join(';'))?.[0] ?? '',
        };
      };
      const dana = await signIn('dana', true);
      admin = dana.cookie;
      member = (await signIn('omar', false)).cookie;
      await grant(db(), 'net', 'omar');
      readOnly = (await createToken(db(), dana.id, { name: 'ro', readOnly: true })).token;
    });
    afterAll(async () => {
      await sync?.stop();
      await app?.close();
      await database?.close();
      source?.remove();
    });
    const refused = (run: () => Promise<unknown>) =>
      run().then(
        () => 'done',
        (e) =>
          e instanceof LaunchError ? `${e.code}/${e.field ?? '-'}: ${e.message}` : `other: ${e}`,
      );

    it('names a flow and what a run of it needs', async () => {
      const made = await configs.create(project.id, {
        name: ' Nightly check ',
        description: 'Every edge firewall',
        flowFile: 'ping.flow.yaml',
        inventory: 'inventory/prod',
        eeImage: 'registry.example.net/ee/network:2.19',
        mode: 'check',
        limit: 'edge',
        inputs: { devices: ['fw-edge-01', 'fw-edge-02'], retries: 3 },
        credentials: [ssh, vault],
      });
      expect(made).toMatchObject({
        project: project.id,
        name: 'Nightly check',
        flowFile: 'ping.flow.yaml',
        inventory: 'inventory/prod',
        mode: 'check',
        limit: 'edge',
        inputs: { devices: ['fw-edge-01', 'fw-edge-02'], retries: 3 },
        credentials: [ssh, vault],
      });
      expect(made.gitRef).toBeUndefined();
      expect(made.commit).toBeUndefined();
      expect(await configs.list(project.id)).toEqual([made]);
      expect(await configs.get(made.id)).toEqual(made);
      // The credentials it names are in use: counted, and not deleted from under it.
      expect((await getCredential(db(), ssh))?.usedBy).toBe(1);
      await expect(deleteCredential(db(), ssh)).rejects.toMatchObject({
        code: 'in_use',
        message: expect.stringMatching(/launch configuration "Nightly check"/),
      });
    });

    it('refuses what could not run, and says which setting it is about', async () => {
      const base = { name: 'x', flowFile: 'ping.flow.yaml' };
      const make = (input: object) =>
        refused(() => configs.create(project.id, { ...base, ...input } as never));
      expect(await make({ name: 'Nightly check' })).toMatch(/^taken\/name/);
      expect(await make({ name: ' ' })).toMatch(/^invalid\/name/);
      expect(await make({ flowFile: 'nothing.flow.yaml' })).toMatch(
        /^invalid\/flowFile: There is no flow/,
      );
      expect(await make({ flowFile: 'README.md' })).toMatch(/^invalid\/flowFile: A flow is a file/);
      expect(await make({ flowFile: 'broken.flow.yaml' })).toMatch(/^invalid\/flowFile/);
      expect(await make({ flowFile: '../ping.flow.yaml' })).toMatch(/^invalid\/flowFile/);
      expect(await make({ inventory: 'inventory/nowhere' })).toMatch(
        /^invalid\/inventory: The repository has no/,
      );
      expect(await make({ inventory: '/etc/ansible/hosts' })).toMatch(
        /^invalid\/inventory: Not a path/,
      );
      expect(await make({ gitRef: 'no-such-branch' })).toMatch(
        /^invalid\/gitRef: The repository has no branch/,
      );
      expect(await make({ commit: 'abc123' })).toMatch(/^invalid\/commit: A commit is its full/);
      expect(await make({ commit: 'f'.repeat(40) })).toMatch(
        /^invalid\/commit: The repository has no commit/,
      );
      expect(await make({ gitRef: 'main', commit: first })).toMatch(
        /^invalid\/commit: Name a branch or pin/,
      );
      expect(await make({ mode: 'dry' })).toMatch(/^invalid\/mode/);
      expect(await make({ limit: 'a\nb' })).toMatch(/^invalid\/limit/);
      expect(await make({ eeImage: 'not an image; rm -rf' })).toMatch(/^invalid\/eeImage/);
      // Inputs: only the flow's own, of their kind, and never one that looks like a secret.
      expect(await make({ inputs: { colour: 'red' } })).toMatch(
        /^invalid\/colour: The flow has no input/,
      );
      expect(await make({ inputs: { retries: 'many' } })).toMatch(/^invalid\/retries/);
      const secret = await make({ inputs: { api_password: 'hunter2-not-kept' } });
      expect(secret).toMatch(/^invalid\/api_password: api_password looks like a secret/);
      expect(secret).not.toContain('hunter2');
      // Credentials: of this workspace, of a kind a run takes, one way to sign in.
      expect(await make({ credentials: [token] })).toMatch(
        /^invalid\/credentials: .*not for a run/,
      );
      expect(await make({ credentials: ['nothing'] })).toMatch(
        /^invalid\/credentials: The workspace has no such/,
      );
      const second = await createCredential(db(), key, workspace, {
        name: 'second key',
        kind: 'ssh_key',
        secret: { privateKey: '-----BEGIN PRIVATE KEY-----\nQUFB\n-----END PRIVATE KEY-----' },
      });
      expect(await make({ credentials: [ssh, second.id] })).toMatch(/one ssh_key credential/);
      expect(await refused(() => configs.create('nothing', base))).toMatch(/^not_found/);
      expect(await configs.list(project.id)).toHaveLength(1);
    });

    it('changes one thing and checks the whole again', async () => {
      const [config] = await configs.list(project.id);
      const id = config?.id as string;
      const changed = await configs.update(id, { mode: 'real', limit: null, credentials: [vault] });
      expect(changed).toMatchObject({
        mode: 'real',
        credentials: [vault],
        inventory: 'inventory/prod',
      });
      expect(changed.limit).toBeUndefined();
      expect((await getCredential(db(), ssh))?.usedBy).toBe(0);
      // Another flow has other inputs: the start values that no longer fit are refused, not dropped.
      expect(
        await refused(() => configs.update(id, { flowFile: 'flows/firewall-upgrade.flow.yaml' })),
      ).toMatch(/^invalid\/retries: The flow has no input retries/);
      const moved = await configs.update(id, {
        flowFile: 'flows/firewall-upgrade.flow.yaml',
        inputs: { target_version: '7.4.1' },
      });
      expect(moved).toMatchObject({ flowFile: 'flows/firewall-upgrade.flow.yaml', mode: 'real' });
      await configs.update(id, {
        flowFile: 'ping.flow.yaml',
        limit: 'edge',
        mode: 'check',
        inputs: { devices: ['fw-edge-01', 'fw-edge-02'], retries: 3 },
        credentials: [ssh, vault],
      });
      expect(await refused(() => configs.update('nothing', { mode: 'real' }))).toMatch(
        /^not_found/,
      );
    });

    it('a launch is settled: the commit, the inputs as the flow reads them, the hosts', async () => {
      const [config] = await configs.list(project.id);
      const prepared = await prepareLaunch(deps(), config as never, {
        inputs: { retries: ' 5 ', api_password: 'typed-at-launch' },
      });
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.problems));
      expect(prepared.launch).toMatchObject({
        project: project.id,
        commit: first,
        ref: 'main',
        flow: { file: 'ping.flow.yaml', key: 'hello', version: 1 },
        mode: 'check',
        inventory: 'inventory/prod',
        limit: 'edge',
        inputs: {
          devices: ['fw-edge-01', 'fw-edge-02'],
          retries: 5,
          api_password: 'typed-at-launch',
        },
        targets: ['fw-edge-01', 'fw-edge-02'],
        credentials: [ssh, vault],
      });
      // The form starts with the configuration's values; a secret-looking field starts empty.
      const fields = Object.fromEntries(prepared.form.fields.map((f) => [f.name, f]));
      expect(fields.devices).toMatchObject({ required: true, text: 'fw-edge-01, fw-edge-02' });
      expect(fields.retries).toMatchObject({ type: 'integer', text: '3' });
      expect(fields.api_password).toMatchObject({ secret: true, text: '' });

      // What a launch says wins over what the configuration says.
      const real = await prepareLaunch(deps(), config as never, {
        mode: 'real',
        limit: 'fw-edge-01',
        inputs: { devices: 'fw-edge-09' },
      });
      expect(real.ok && real.launch).toMatchObject({
        mode: 'real',
        limit: 'fw-edge-01',
        targets: ['fw-edge-09'],
      });
    });

    it('lists everything that stands in the way of a launch', async () => {
      const [config] = await configs.list(project.id);
      const why = async (request: Parameters<typeof prepareLaunch>[2]) => {
        const prepared = await prepareLaunch(deps(), config as never, request);
        return prepared.ok ? [] : prepared.problems.map((p) => `${p.field ?? '-'}: ${p.message}`);
      };
      expect(await why({ inputs: { devices: '  ', retries: 'many', colour: 'red' } })).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^colour: The flow has no input/),
          'devices: devices is required',
        ]),
      );
      expect(await why({ inputs: { retries: 'many' } })).toEqual([
        expect.stringMatching(/^retries: /),
      ]);
      expect(await why({ ref: 'nowhere' })).toEqual([
        expect.stringMatching(/^ref: The repository has no branch nowhere/),
      ]);
      expect(await why({ commit: 'f'.repeat(40) })).toEqual([
        expect.stringMatching(/^commit: The repository has no commit/),
      ]);
      expect(await why({ ref: 'main', commit: first })).toEqual([
        expect.stringMatching(/not both/),
      ]);
    });

    it('runs the newest commit unless told otherwise: a branch, a commit, a pin', async () => {
      const [config] = await configs.list(project.id);
      // The source moves on: main gets a commit, and a branch has the flow changed.
      const second = source.commit({ 'notes.txt': 'a change\n' }, 'Second');
      source.branch('try/idea');
      const idea = source.commit(
        { 'ping.flow.yaml': PING.replace('version: 1', 'version: 2') },
        'Idea',
      );
      source.checkout('main');

      // A launch looks at the source first: it runs what main is at now.
      const newest = await prepareLaunch(deps(), config as never);
      expect(newest.ok && newest.launch).toMatchObject({ commit: second, ref: 'main' });
      const branch = await prepareLaunch(deps(), config as never, { ref: 'try/idea' });
      expect(branch.ok && branch.launch).toMatchObject({
        commit: idea,
        ref: 'try/idea',
        flow: { version: 2 },
      });
      const old = await prepareLaunch(deps(), config as never, { commit: first });
      expect(old.ok && old.launch).toMatchObject({ commit: first, flow: { version: 1 } });
      expect(old.ok && old.launch.ref).toBeUndefined();

      // A configuration can name a branch, or be pinned; a launch still may say otherwise.
      const onBranch = await configs.create(project.id, {
        name: 'Idea',
        flowFile: 'ping.flow.yaml',
        gitRef: 'try/idea',
        inputs: { devices: ['localhost'] },
      });
      expect((await prepareLaunch(deps(), onBranch)).ok).toBe(true);
      const pinned = await configs.create(project.id, {
        name: 'Pinned',
        flowFile: 'ping.flow.yaml',
        commit: first,
        inputs: { devices: ['localhost'] },
      });
      const third = source.commit({ 'notes.txt': 'more\n' }, 'Third');
      const stays = await prepareLaunch(deps(), pinned);
      expect(stays.ok && stays.launch).toMatchObject({ commit: first });
      const other = await prepareLaunch(deps(), pinned, { ref: 'main' });
      expect(other.ok && other.launch).toMatchObject({ commit: third, ref: 'main' });

      // A source that cannot be read is said: the run would not be of what the person thinks.
      source.deleteBranch('try/idea');
      const gone = await prepareLaunch(deps(), onBranch);
      expect(gone.ok).toBe(false);
      expect(!gone.ok && gone.problems[0]?.message).toMatch(/no branch try\/idea/);
    });

    it('over the API: administrators change, everyone signed in reads and asks', async () => {
      const call = (
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
        url: string,
        options: { cookie?: string; auth?: string; body?: unknown } = {},
      ) =>
        app.inject({
          method,
          url,
          headers: {
            ...(options.cookie ? { cookie: options.cookie } : {}),
            ...(options.auth ? { authorization: options.auth } : {}),
            ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
        });
      const list = `/api/v1/projects/${project.id}/launch-configs`;
      const body = { name: 'From the API', flowFile: 'ping.flow.yaml', inputs: { retries: 2 } };
      expect((await call('GET', list)).statusCode).toBe(401);
      expect((await call('POST', list, { cookie: member, body })).statusCode).toBe(403);
      const made = await call('POST', list, { cookie: admin, body });
      expect(made.statusCode).toBe(201);
      const id = made.json().id;
      expect(
        (await call('GET', list, { cookie: member })).json().map((c: { name: string }) => c.name),
      ).toContain('From the API');
      const bad = await call('POST', list, {
        cookie: admin,
        body: { ...body, name: 'b', inventory: 'nowhere' },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ error: 'invalid', field: 'inventory' });
      expect((await call('POST', list, { cookie: admin, body })).statusCode).toBe(409);
      expect(
        (await call('POST', list, { cookie: admin, body: { ...body, name: 'c', surprise: 1 } }))
          .statusCode,
      ).toBe(400);
      expect(
        (await call('GET', '/api/v1/projects/nothing/launch-configs', { cookie: admin }))
          .statusCode,
      ).toBe(404);

      // The form: the flow's inputs with the start values; nothing is refused for being empty.
      const form = await call('GET', `/api/v1/launch-configs/${id}/form?mode=real`, {
        cookie: member,
      });
      expect(form.statusCode).toBe(200);
      expect(form.json()).toMatchObject({ mode: 'real', flow: { key: 'hello' }, ref: 'main' });
      expect(form.json().fields.map((f: { name: string }) => f.name)).toEqual(
        expect.arrayContaining(['devices', 'retries', 'api_password']),
      );

      // Asking what would run: with a read-only token too, since nothing changes.
      const check = `/api/v1/launch-configs/${id}/check`;
      const notReady = await call('POST', check, { cookie: member, body: {} });
      expect(notReady.statusCode).toBe(422);
      expect(notReady.json()).toMatchObject({
        error: 'not_ready',
        problems: [{ field: 'devices', message: 'devices is required' }],
      });
      expect(notReady.json().form.fields.length).toBeGreaterThan(0);
      const ready = await call('POST', check, {
        auth: `Bearer ${readOnly}`,
        body: { inputs: { devices: 'fw-edge-01,fw-edge-02', api_password: 'S3CR3T-typed' } },
      });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().launch).toMatchObject({
        targets: ['fw-edge-01', 'fw-edge-02'],
        inputs: { retries: 2, api_password: '***' },
      });
      // What was typed as a secret is not sent back.
      expect(ready.body).not.toContain('S3CR3T-typed');
      expect((await call('POST', check, { body: {} })).statusCode).toBe(401);
      expect(
        (await call('POST', check, { cookie: member, body: { mode: 'dry' } })).statusCode,
      ).toBe(400);

      expect(
        (
          await call('PATCH', `/api/v1/launch-configs/${id}`, {
            cookie: member,
            body: { mode: 'real' },
          })
        ).statusCode,
      ).toBe(403);
      const changed = await call('PATCH', `/api/v1/launch-configs/${id}`, {
        cookie: admin,
        body: { mode: 'real' },
      });
      expect(changed.json()).toMatchObject({ mode: 'real', inputs: { retries: 2 } });
      expect(
        (await call('DELETE', `/api/v1/launch-configs/${id}`, { cookie: member })).statusCode,
      ).toBe(403);
      expect(
        (await call('DELETE', `/api/v1/launch-configs/${id}`, { cookie: admin })).statusCode,
      ).toBe(204);
      expect(
        (await call('GET', `/api/v1/launch-configs/${id}`, { cookie: admin })).statusCode,
      ).toBe(404);
      expect(
        (await call('GET', `/api/v1/launch-configs/${id}/form`, { cookie: admin })).statusCode,
      ).toBe(404);
    });

    it('the hosts as the inventory has them: for who may launch, inputs that read only', async () => {
      const made = await configs.create(project.id, {
        name: 'Facts',
        flowFile: 'ping.flow.yaml',
        inventory: 'inventory/prod/hosts.yaml',
        eeImage: 'registry.example.net/ee/net:1',
        credentials: [vault],
      });
      const facts = `/api/v1/launch-configs/${made.id}/facts`;
      const post = (body: unknown, headers: Record<string, string>) =>
        app.inject({
          method: 'POST',
          url: facts,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: JSON.stringify(body),
        });
      // It starts a container: ro on the flow (omar, a read-only token) may not.
      expect((await post({}, { cookie: member })).statusCode).toBe(403);
      expect((await post({}, { authorization: `Bearer ${readOnly}` })).statusCode).toBe(403);

      asked.length = 0;
      const opening = await post(
        { groups: true, inputs: { devices: 'fw-edge-01, fw-edge-99', retries: 'many' } },
        { cookie: admin },
      );
      expect(opening.statusCode).toBe(200);
      expect(opening.json()).toMatchObject({
        facts: { count: 1, hosts: ['fw-edge-01'], unknown: ['fw-edge-99'] },
        groups: ['edge'],
        inventory: 'inventory/prod/hosts.yaml',
        commit: expect.stringMatching(/^[0-9a-f]{40}$/),
        environment: 'registry.example.net/ee/net:1 (docker)',
      });
      // What the reader was asked: the commit, the image, the credentials; `retries` does not
      // read yet, so it is left out rather than holding the hosts back.
      expect(asked[0]).toMatchObject({
        project: project.id,
        commit: opening.json().commit,
        image: 'registry.example.net/ee/net:1',
        inventory: 'inventory/prod/hosts.yaml',
        credentials: [vault],
        groups: true,
        inputs: { devices: ['fw-edge-01', 'fw-edge-99'] },
      });
      expect(asked[0]?.doc.flow.key).toBe('hello');

      // No hosts typed: no facts, and which input says why (as the designer words it).
      const empty = await post({ inputs: { devices: '' } }, { cookie: admin });
      expect(empty.json()).toMatchObject({ factsError: 'devices is required', field: 'devices' });
      expect(empty.json().facts).toBeUndefined();
      await configs.delete(made.id);
    });

    it('goes with its project, and frees the credentials it named', async () => {
      expect((await getCredential(db(), ssh))?.usedBy).toBe(1);
      await deleteProject(db(), project.id);
      expect(await db().selectFrom('launch_config').selectAll().execute()).toEqual([]);
      expect(await db().selectFrom('launch_config_credential').selectAll().execute()).toEqual([]);
      expect((await getCredential(db(), ssh))?.usedBy).toBe(0);
      await deleteCredential(db(), ssh);
    });
  });
}
