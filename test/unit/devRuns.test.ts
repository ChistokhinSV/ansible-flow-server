// Dev runs (AFS-26), on both databases the server supports (PostgreSQL when AFS_TEST_POSTGRES_URL
// is set): someone with rw sends unpushed work as a git bundle; the server keeps its commit under
// a ref nobody else sees, runs it in check mode only, marks the run, and lets the bundle go when
// its time is up. The project's branch never moves; an operator cannot send work; a bundle that
// starts from a commit the server lacks, or is no bundle, or is too large, is refused.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGrant } from '../../src/server/access/grants';
import { buildApp } from '../../src/server/app';
import { listAudit } from '../../src/server/audit/store';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs } from '../../src/server/launch/configs';
import { pruneDevBundles } from '../../src/server/launch/dev';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace, getProject } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { RunQueue } from '../../src/server/runs/queue';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { emptyPeople, emptyWorkspaces } from './helpers/clean';
import { type TestRepo, testRepo } from './helpers/repo';

const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const HELLO = readFileSync(join(__dirname, '../fixtures/hello.flow.yaml'), 'utf8');
const root = mkdtempSync(join(tmpdir(), 'afs-dev-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Rita Okafor',
  GIT_AUTHOR_EMAIL: 'rita@example.net',
  GIT_COMMITTER_NAME: 'Rita Okafor',
  GIT_COMMITTER_EMAIL: 'rita@example.net',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();

for (const [name, config] of databases) {
  describe.skipIf(!config)(`dev runs on ${name}`, () => {
    let database: Database;
    let app: FastifyInstance;
    let small: FastifyInstance;
    let sync: ProjectSync;
    let repos: Git;
    let source: TestRepo;
    let project: string;
    let configId: string;
    let base: string;
    let work: string;
    const tokens: Record<string, string> = {};
    const db = () => database.db;

    /** A bundle of the work in `work`: from the server's commit, or the whole history. */
    const bundle = (from?: string) => {
      const file = join(root, `${name}-${Date.now()}-${Math.random()}.bundle`);
      git(work, 'update-ref', 'refs/afd-dev/run', 'HEAD');
      git(work, 'bundle', 'create', '-q', file, 'refs/afd-dev/run', ...(from ? [`^${from}`] : []));
      git(work, 'update-ref', '-d', 'refs/afd-dev/run');
      return readFileSync(file);
    };
    const send = (
      target: FastifyInstance,
      who: string,
      body: Buffer | string,
      type = 'application/x-git-bundle',
    ) =>
      target.inject({
        method: 'POST',
        url: `/api/v1/projects/${project}/dev-bundles`,
        headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': type },
        payload: body,
      });
    const launch = (who: string, body: object, path = 'launch') =>
      app.inject({
        method: 'POST',
        url: `/api/v1/launch-configs/${configId}/${path}`,
        headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
        payload: JSON.stringify(body),
      });

    beforeAll(async () => {
      if (!config) return;
      database = openDatabase(config);
      await migrate(database.db as never);
      await emptyWorkspaces(db());
      await emptyPeople(db());
      const log = createLogger({ level: 'silent', format: 'json', write: () => undefined });
      repos = new Git({ reposDir: join(root, `repos-${name}`), allowLocal: true });
      sync = new ProjectSync(db(), repos, log);
      source = testRepo({
        'flows/hello.flow.yaml': HELLO,
        'inventory/hosts.yaml': 'all:\n  hosts:\n    fw-edge-01: {}\n',
      });
      const ws = await createWorkspace(db(), { key: 'net', name: 'Network' });
      project = (
        await createProject(
          db(),
          ws.id,
          { key: 'edge', name: 'Edge', gitUrl: source.dir, pollSeconds: 0 },
          true,
        )
      ).id;
      await sync.sync(project);
      base = (await getProject(db(), project))?.commit as string;
      configId = (
        await new LaunchConfigs(db(), repos).create(project, {
          name: 'Hello',
          flowFile: 'flows/hello.flow.yaml',
          inventory: 'inventory/hosts.yaml',
          inputs: { devices: ['fw-edge-01'] },
        })
      ).id;
      // rita may push in net; omar operates the flow.
      for (const login of ['rita', 'omar'])
        await createUser(db(), { login, name: login, password: 'x'.repeat(12) });
      await createGrant(db(), ws.id, { user: 'rita', level: 'rw' }, 'test');
      await createGrant(db(), ws.id, { user: 'omar', level: 'operator' }, 'test');
      const users = await db().selectFrom('user_account').select(['id', 'login']).execute();
      for (const u of users) tokens[u.login] = (await createToken(db(), u.id, { name: 't' })).token;
      const deps = {
        log,
        database,
        instance: 'test',
        masterKey: key,
        runs: new RunQueue(db(), database.kind, key, { maxRuns: 4, perProject: 4 }),
        projects: { git: repos, sync, allowLocal: true },
      };
      app = buildApp(deps);
      small = buildApp({ ...deps, dev: { maxBytes: 200, keepHours: 24 } });
      // Rita's clone, with work the server has not seen: a commit, renaming the flow.
      work = join(root, `work-${name}`);
      git(root, 'clone', '-q', source.dir, work);
      git(work, 'config', 'core.autocrlf', 'false');
      const flow = join(work, 'flows', 'hello.flow.yaml');
      const text = readFileSync(flow, 'utf8').replace(
        /^ {2}name: .*$/m,
        '  name: Hello, work in progress',
      );
      execFileSync('node', [
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(flow)}, ${JSON.stringify(text)})`,
      ]);
      git(work, 'commit', '-q', '-am', 'Work in progress');
    });
    afterAll(async () => {
      await app?.close();
      await small?.close();
      await sync?.stop();
      await database?.close();
      source?.remove();
    });

    it('only who may push sends work; what is not a bundle, or starts where the server is not, is refused', async () => {
      expect((await send(app, 'omar', bundle(base))).statusCode).toBe(403);
      const junk = await send(app, 'rita', 'not a bundle at all');
      expect(junk.statusCode).toBe(400);
      expect(junk.json().message).toMatch(/Not a git bundle/);
      // A bundle from a commit the server lacks: one more commit, bundled from the one before it,
      // which only rita has.
      const lone = git(work, 'rev-parse', 'HEAD');
      git(work, 'commit', '-q', '--allow-empty', '-m', 'And a note');
      const orphan = bundle(lone);
      expect((await send(app, 'rita', orphan)).statusCode).toBe(400);
      expect((await send(small, 'rita', bundle())).statusCode).toBe(413);
    });

    it('a dev run runs the work in check mode; the branch never moves and nobody else sees the ref', async () => {
      const sent = await send(app, 'rita', bundle(base));
      expect(sent.statusCode).toBe(201);
      const dev = sent.json() as { id: string; commit: string; expiresAt: string };
      expect(dev.commit).toBe(git(work, 'rev-parse', 'HEAD'));
      expect(Date.parse(dev.expiresAt) - Date.now()).toBeGreaterThan(23 * 3_600_000);

      // What would run: the work's commit and its flow.
      const check = await launch('rita', { dev: dev.id }, 'check');
      expect(check.json().launch).toMatchObject({
        commit: dev.commit,
        mode: 'check',
        dev: dev.id,
        flow: { name: 'Hello, work in progress' },
      });
      // Real runs take the branch's commits only; an operator does not run others' work.
      const real = await launch('rita', { dev: dev.id, mode: 'real' });
      expect(real.statusCode).toBe(422);
      expect(real.json()).toMatchObject({ field: 'mode' });
      expect((await launch('omar', { dev: dev.id })).statusCode).toBe(403);

      const run = await launch('rita', { dev: dev.id });
      expect(run.statusCode).toBe(201);
      expect(run.json()).toMatchObject({ commit: dev.commit, mode: 'check', dev: true });
      expect(
        (
          await app.inject({
            url: `/api/v1/runs/${run.json().id}`,
            headers: { authorization: `Bearer ${tokens.rita}` },
          })
        ).json(),
      ).toMatchObject({ dev: true });

      expect((await getProject(db(), project))?.commit).toBe(base);
      expect(await repos.branches(project)).toEqual(['main']);
      const advertised = (await repos.advertise(project, 'upload-pack')).toString('utf8');
      expect(advertised).toContain('refs/heads/main');
      expect(advertised).not.toContain('refs/afs');
      // Nor offered to a push: a hidden ref cannot be pushed to.
      expect((await repos.advertise(project, 'receive-pack')).toString('utf8')).not.toContain(
        'refs/afs',
      );
      const entry = (await listAudit(db(), { action: 'dev-bundle' })).entries[0];
      expect(entry).toMatchObject({
        action: 'dev-bundle.upload',
        actor: { login: 'rita' },
        result: 'ok',
      });
    });

    it('a bundle goes when its time is up; a launch of it then says to send the work again', async () => {
      const dev = (await send(app, 'rita', bundle(base))).json() as { id: string };
      expect(
        await pruneDevBundles(db(), repos, new Date(Date.now() + 25 * 3_600_000)),
      ).toBeGreaterThan(0);
      const gone = await launch('rita', { dev: dev.id });
      expect(gone.statusCode).toBe(404);
      expect(gone.json().message).toMatch(/send the work again/);
    });
  });
}
