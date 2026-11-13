// Access levels: who may do what, as a matrix of people and routes. One workspace (net) with a
// project of two flows, and a second workspace (lab) nobody but the administrator has. On both
// databases the server supports (PostgreSQL when AFS_TEST_POSTGRES_URL is set).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Access, createGrant } from '../../src/server/access/grants';
import { ROUTES } from '../../src/server/api/catalog';
import { buildApp } from '../../src/server/app';
import { createToken } from '../../src/server/auth/tokens';
import { createGroup, createUser, setMembers } from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs } from '../../src/server/launch/configs';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace, type Project } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { RunQueue } from '../../src/server/runs/queue';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { emptyPeople, emptyWorkspaces } from './helpers/clean';
import { type TestRepo, testRepo } from './helpers/repo';

const PASSWORD = 'correct horse battery staple';
const HELLO = readFileSync(join(__dirname, '../fixtures', 'hello.flow.yaml'), 'utf8');
const A = 'flows/a.flow.yaml';
const B = 'flows/b.flow.yaml';
const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const root = mkdtempSync(join(tmpdir(), 'afs-access-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

/** The people: their grants are in the setup. */
const PEOPLE = ['dana', 'rita', 'otto', 'wanda', 'gary', 'fiona', 'april', 'nina'] as const;
type Person = (typeof PEOPLE)[number];

for (const [name, config] of databases) {
  describe.skipIf(!config)(`access levels on ${name}`, () => {
    let database: Database;
    let app: FastifyInstance;
    let source: TestRepo;
    let core: Project;
    let toys: Project;
    let c1: string;
    let c2: string;
    let run: string;
    const token: Partial<Record<Person, string>> = {};
    const db = () => database.db;

    beforeAll(async () => {
      if (!config) return;
      database = openDatabase(config);
      await migrate(database.db as never);
      await emptyWorkspaces(db());
      await emptyPeople(db());
      source = testRepo({
        [A]: HELLO,
        [B]: HELLO.replace('key: hello', 'key: hello-b'),
        'inventory/hosts.yaml': 'all:\n  hosts:\n    fw-edge-01: {}\n',
      });
      source.branch('try');
      source.commit({ 'README.md': 'trying\n' });
      source.branch('main-again');
      const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
      const git = new Git({ reposDir: join(root, `repos-${name}`), allowLocal: true });
      const sync = new ProjectSync(db(), git, log);
      app = buildApp({
        log,
        database,
        instance: 'test',
        masterKey: key,
        runs: new RunQueue(db(), database.kind, key),
        projects: { git, sync, allowLocal: true },
      });
      const net = await createWorkspace(db(), { key: 'net', name: 'Network' });
      const lab = await createWorkspace(db(), { key: 'lab', name: 'Lab' });
      const made = await createProject(
        db(),
        net.id,
        { key: 'core', name: 'Core', gitUrl: source.dir, gitRef: 'try', pollSeconds: 0 },
        true,
      );
      core = (await sync.sync(made.id)) as Project;
      toys = await createProject(db(), lab.id, { key: 'toys', name: 'Toys' }, true);
      const configs = new LaunchConfigs(db(), git);
      const base = {
        inventory: 'inventory/hosts.yaml',
        mode: 'check' as const,
        inputs: { devices: ['fw-edge-01'] },
      };
      c1 = (await configs.create(core.id, { name: 'A', flowFile: A, ...base })).id;
      c2 = (await configs.create(core.id, { name: 'B', flowFile: B, ...base })).id;

      for (const login of PEOPLE)
        await createUser(db(), { login, name: login, password: PASSWORD, admin: login === 'dana' });
      const ids = Object.fromEntries(
        (await db().selectFrom('user_account').select(['id', 'login']).execute()).map((u) => [
          u.login,
          u.id,
        ]),
      );
      for (const login of PEOPLE)
        token[login] = (await createToken(db(), ids[login] as string, { name: 'm' })).token;
      const ops = await createGroup(db(), { name: 'net-ops' });
      await setMembers(db(), ops.id, [ids.gary as string]);
      const give = (who: { user?: string; group?: string }, level: string, flow?: string) =>
        createGrant(
          db(),
          net.id,
          { ...who, level: level as 'ro', ...(flow ? { project: core.id, flow } : {}) },
          'dana',
        );
      await give({ user: 'rita' }, 'ro');
      await give({ user: 'otto' }, 'operator');
      await give({ user: 'wanda' }, 'rw');
      await give({ group: 'net-ops' }, 'rw');
      // gary: rw through his group, and only ro on flow B: the flow grant wins there.
      await give({ user: 'gary' }, 'ro', B);
      // fiona: operator on flow A only.
      await give({ user: 'fiona' }, 'operator', A);
      await give({ user: 'april' }, 'approve');

      const launched = await app.inject({
        method: 'POST',
        url: `/api/v1/launch-configs/${c1}/launch`,
        headers: { authorization: `Bearer ${token.dana}` },
        payload: {},
      });
      run = launched.json().id;
    });
    afterAll(async () => {
      await app?.close();
      await database?.close();
      source?.remove();
    });

    const status = async (who: Person, method: string, url: string, payload?: object) =>
      (
        await app.inject({
          method: method as 'GET',
          url,
          headers: { authorization: `Bearer ${token[who]}` },
          ...(payload ? { payload } : {}),
        })
      ).statusCode;

    it('works out levels: highest of own and groups, a flow grant over the workspace one', async () => {
      const of = async (login: Person) => {
        const user = await db()
          .selectFrom('user_account')
          .select(['id', 'is_admin'])
          .where('login', '=', login)
          .executeTakeFirstOrThrow();
        return Access.of(db(), { id: user.id, admin: user.is_admin === 1 });
      };
      const gary = await of('gary');
      expect(gary.onWorkspace(core.workspace)).toBe('rw');
      expect(gary.onFlow(core.workspace, core.id, A)).toBe('rw');
      expect(gary.onFlow(core.workspace, core.id, B)).toBe('ro');
      const fiona = await of('fiona');
      expect(fiona.onWorkspace(core.workspace)).toBeUndefined();
      expect(fiona.onFlow(core.workspace, core.id, A)).toBe('operator');
      expect(fiona.onFlow(core.workspace, core.id, B)).toBeUndefined();
      expect(fiona.sees(core.workspace, core.id)).toBe(true);
      expect(fiona.sees(toys.workspace)).toBe(false);
      const april = await of('april');
      expect(april.approves(core.workspace)).toBe(true);
      expect(april.onWorkspace(core.workspace)).toBeUndefined();
      expect((await of('rita')).approves(core.workspace)).toBe(false);
    });

    // Each row: a route, and the status each person gets. 2xx means allowed (a 422 or a 409 is
    // allowed too: the person got past the check; the launch was not ready, the name was taken).
    const OK = 'ok';
    const rows = (): [
      string,
      string,
      () => string,
      object | undefined,
      Record<Person, string | number>,
    ][] => [
      [
        'GET',
        'workspace',
        () => '/api/v1/workspaces/net',
        undefined,
        { dana: OK, rita: OK, otto: OK, wanda: OK, gary: OK, fiona: OK, april: OK, nina: 404 },
      ],
      [
        'GET',
        'other workspace',
        () => '/api/v1/workspaces/lab',
        undefined,
        {
          dana: OK,
          rita: 404,
          otto: 404,
          wanda: 404,
          gary: 404,
          fiona: 404,
          april: 404,
          nina: 404,
        },
      ],
      [
        'GET',
        'project',
        () => `/api/v1/projects/${core.id}`,
        undefined,
        { dana: OK, rita: OK, otto: OK, wanda: OK, gary: OK, fiona: OK, april: OK, nina: 404 },
      ],
      [
        'GET',
        'flow A',
        () => `/api/v1/projects/${core.id}/flows/view?path=${A}`,
        undefined,
        { dana: OK, rita: OK, otto: OK, wanda: OK, gary: OK, fiona: OK, april: 403, nina: 404 },
      ],
      [
        'GET',
        'flow B',
        () => `/api/v1/projects/${core.id}/flows/view?path=${B}`,
        undefined,
        { dana: OK, rita: OK, otto: OK, wanda: OK, gary: OK, fiona: 403, april: 403, nina: 404 },
      ],
      [
        'POST',
        'sync',
        () => `/api/v1/projects/${core.id}/sync`,
        undefined,
        { dana: OK, rita: 403, otto: 403, wanda: OK, gary: OK, fiona: 403, april: 403, nina: 404 },
      ],
      [
        'GET',
        'credentials',
        () => '/api/v1/workspaces/net/credentials',
        undefined,
        { dana: OK, rita: OK, otto: OK, wanda: OK, gary: OK, fiona: 403, april: 403, nina: 404 },
      ],
      [
        'GET',
        'config A',
        () => `/api/v1/launch-configs/${c1}`,
        undefined,
        { dana: OK, rita: OK, otto: OK, wanda: OK, gary: OK, fiona: OK, april: 403, nina: 404 },
      ],
      [
        'POST',
        'check A',
        () => `/api/v1/launch-configs/${c1}/check`,
        {},
        { dana: OK, rita: OK, otto: OK, wanda: OK, gary: OK, fiona: OK, april: 403, nina: 404 },
      ],
      [
        'POST',
        'launch A',
        () => `/api/v1/launch-configs/${c1}/launch`,
        {},
        { dana: OK, rita: 403, otto: OK, wanda: OK, gary: OK, fiona: OK, april: 403, nina: 404 },
      ],
      [
        'POST',
        'launch A on another branch',
        () => `/api/v1/launch-configs/${c1}/launch`,
        { ref: 'main-again' },
        { dana: OK, rita: 403, otto: 403, wanda: OK, gary: OK, fiona: 403, april: 403, nina: 404 },
      ],
      [
        'POST',
        'launch B',
        () => `/api/v1/launch-configs/${c2}/launch`,
        {},
        { dana: OK, rita: 403, otto: OK, wanda: OK, gary: 403, fiona: 403, april: 403, nina: 404 },
      ],
      [
        'PATCH',
        'change config A',
        () => `/api/v1/launch-configs/${c1}`,
        { description: 'x' },
        { dana: OK, rita: 403, otto: 403, wanda: OK, gary: OK, fiona: 403, april: 403, nina: 404 },
      ],
      [
        'POST',
        'add a config for B',
        () => `/api/v1/projects/${core.id}/launch-configs`,
        {
          name: 'B2',
          flowFile: B,
          inventory: 'inventory/hosts.yaml',
          inputs: { devices: ['fw-edge-01'] },
        },
        { dana: OK, rita: 403, otto: 403, wanda: OK, gary: 403, fiona: 403, april: 403, nina: 404 },
      ],
      [
        'GET',
        'run of A',
        () => `/api/v1/runs/${run}`,
        undefined,
        { dana: OK, rita: OK, otto: OK, wanda: OK, gary: OK, fiona: OK, april: 403, nina: 404 },
      ],
      [
        'POST',
        'stop the run of A',
        () => `/api/v1/runs/${run}/cancel`,
        undefined,
        { dana: OK, rita: 403, otto: OK, wanda: OK, gary: OK, fiona: OK, april: 403, nina: 404 },
      ],
      [
        'GET',
        'grants',
        () => '/api/v1/workspaces/net/grants',
        undefined,
        {
          dana: OK,
          rita: 403,
          otto: 403,
          wanda: 403,
          gary: 403,
          fiona: 403,
          april: 403,
          nina: 403,
        },
      ],
      [
        'GET',
        'git clone',
        () => '/git/net/core.git/info/refs?service=git-upload-pack',
        undefined,
        { dana: OK, rita: OK, otto: OK, wanda: OK, gary: OK, fiona: 403, april: 403, nina: 404 },
      ],
      [
        'GET',
        'git push',
        () => '/git/net/core.git/info/refs?service=git-receive-pack',
        undefined,
        { dana: OK, rita: 403, otto: 403, wanda: OK, gary: OK, fiona: 403, april: 403, nina: 404 },
      ],
    ];

    it('the matrix: each person, each route', async () => {
      const wrong: string[] = [];
      for (const [method, what, url, payload, want] of rows())
        for (const person of PEOPLE) {
          const got = await status(person, method, url(), payload);
          const fine =
            want[person] === OK ? got < 300 || got === 422 || got === 409 : got === want[person];
          if (!fine) wrong.push(`${person} ${what}: ${got}, wanted ${want[person]}`);
        }
      expect(wrong).toEqual([]);
    }, 60_000);

    it('lists show only what each person may see', async () => {
      const list = async (who: Person, url: string) =>
        (
          await app.inject({
            method: 'GET',
            url,
            headers: { authorization: `Bearer ${token[who]}` },
          })
        ).json();
      expect((await list('nina', '/api/v1/workspaces')).map((w: { key: string }) => w.key)).toEqual(
        [],
      );
      expect(
        (await list('fiona', '/api/v1/workspaces')).map((w: { key: string }) => w.key),
      ).toEqual(['net']);
      expect((await list('dana', '/api/v1/workspaces')).map((w: { key: string }) => w.key)).toEqual(
        ['lab', 'net'],
      );
      const files = (r: { flows: { file: string }[] }) => r.flows.map((f) => f.file).sort();
      expect(files(await list('fiona', `/api/v1/projects/${core.id}/flows`))).toEqual([A]);
      expect(files(await list('rita', `/api/v1/projects/${core.id}/flows`))).toEqual([A, B]);
      const names = (r: { name: string }[]) => r.map((c) => c.name).sort();
      expect(names(await list('fiona', `/api/v1/projects/${core.id}/launch-configs`))).toEqual([
        'A',
      ]);
      expect((await list('nina', '/api/v1/runs')).length).toBe(0);
      expect((await list('fiona', '/api/v1/runs')).length).toBeGreaterThan(0);
      expect(await list('fiona', `/api/v1/projects/${core.id}/access`)).toMatchObject({
        admin: false,
        workspace: null,
        flows: { [A]: 'operator', [B]: null },
      });
    });

    it('administrators give, list and take back grants, and see who can do what', async () => {
      const as = { authorization: `Bearer ${token.dana}` };
      const given = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces/net/grants',
        headers: as,
        payload: { user: 'nina', level: 'ro' },
      });
      expect(given.statusCode).toBe(201);
      expect(await status('nina', 'GET', '/api/v1/workspaces/net')).toBe(200);
      const again = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces/net/grants',
        headers: as,
        payload: { user: 'nina', level: 'rw' },
      });
      expect(again.statusCode).toBe(409);
      const who = (
        await app.inject({ method: 'GET', url: '/api/v1/workspaces/net/access', headers: as })
      ).json() as {
        user: { login: string };
        workspace: string | null;
        flows: unknown[];
        approve: boolean;
      }[];
      const by = Object.fromEntries(who.map((w) => [w.user.login, w]));
      expect(by.gary).toMatchObject({ workspace: 'rw', flows: [{ file: B, level: 'ro' }] });
      expect(by.april).toMatchObject({ workspace: null, approve: true });
      expect(by.nina).toMatchObject({ workspace: 'ro' });
      const gone = await app.inject({
        method: 'DELETE',
        url: `/api/v1/grants/${given.json().id}`,
        headers: as,
      });
      expect(gone.statusCode).toBe(204);
      expect(await status('nina', 'GET', '/api/v1/workspaces/net')).toBe(404);
    });

    it('no route that reaches a workspace is open to anyone merely signed in', () => {
      const open = Object.entries(ROUTES)
        .filter(([, doc]) => typeof doc.reach === 'object' && doc.who === 'signed in')
        .map(([route]) => route);
      // The list of runs narrows itself to what the person may see.
      expect(open).toEqual(['GET /api/v1/runs']);
    });
  });
}
