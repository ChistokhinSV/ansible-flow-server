// The API as a whole: its OpenAPI document, service accounts and their tokens, and tokens made
// for one workspace. On both databases the server supports (PostgreSQL when
// AFS_TEST_POSTGRES_URL is set).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTES } from '../../src/server/api/catalog';
import { buildApp } from '../../src/server/app';
import { userCommand } from '../../src/server/auth/cli';
import { createUser } from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { Notifier } from '../../src/server/notify/notifier';
import { Git } from '../../src/server/projects/git';
import { ProjectSync } from '../../src/server/projects/sync';
import { RunQueue } from '../../src/server/runs/queue';
import { Schedules } from '../../src/server/schedules/schedules';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { CertificateStore } from '../../src/server/tls/store';
import { emptyPeople, emptyWorkspaces } from './helpers/clean';
import { grant } from './helpers/grant';

const PASSWORD = 'correct horse battery staple';
const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const root = mkdtempSync(join(tmpdir(), 'afs-api-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

for (const [name, config] of databases) {
  describe.skipIf(!config)(`the API on ${name}`, () => {
    let database: Database;
    let app: FastifyInstance;
    let admin: string;
    const db = () => database.db;
    const as = (auth: string) =>
      auth.startsWith('afs_session=') ? { cookie: auth } : { authorization: `Bearer ${auth}` };
    const call = (method: string, url: string, auth?: string, payload?: object) =>
      app.inject({
        method: method as 'GET',
        url,
        headers: auth ? as(auth) : {},
        ...(payload ? { payload } : {}),
      });

    beforeAll(async () => {
      if (!config) return;
      database = openDatabase(config);
      await migrate(database.db as never);
      await emptyWorkspaces(db());
      await emptyPeople(db());
      const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
      const git = new Git({ reposDir: join(root, `repos-${name}`), allowLocal: true });
      app = buildApp({
        log,
        database,
        instance: 'test',
        masterKey: key,
        runs: new RunQueue(db(), database.kind, key),
        notifier: new Notifier(db(), [], log, { keepDays: 30 }),
        projects: { git, sync: new ProjectSync(db(), git, log), allowLocal: true },
        schedules: new Schedules({
          db: db(),
          git,
          sync: new ProjectSync(db(), git, log),
          queue: new RunQueue(db(), database.kind, key),
          log,
        }),
        certificate: {
          store: new CertificateStore(join(root, `tls-${name}`)),
          tls: 'on',
          defaultNames: ['localhost'],
        },
      });
      await createUser(db(), { login: 'dana', name: 'Dana', password: PASSWORD, admin: true });
      const reply = await call('POST', '/api/v1/session', undefined, {
        login: 'dana',
        password: PASSWORD,
      });
      admin = /afs_session=[^;]*/.exec([reply.headers['set-cookie']].flat().join(';'))?.[0] ?? '';
    });
    afterAll(async () => {
      await app?.close();
      await database?.close();
    });

    it('describes itself as OpenAPI, to anyone, every route with what it does and who may', async () => {
      const reply = await call('GET', '/api/v1/openapi.json');
      expect(reply.statusCode).toBe(200);
      const doc = reply.json();
      expect(doc.openapi).toBe('3.1.0');
      const events = doc.paths['/api/v1/runs/{id}/events'].get;
      expect(events.summary).toMatch(/server-sent events/);
      expect(events.tags).toEqual(['Runs']);
      expect(events.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'id', in: 'path', required: true }),
        ]),
      );
      const token = doc.paths['/api/v1/tokens'].post;
      expect(token.description).toBe('Who: session.');
      expect(Object.keys(token.requestBody.content['application/json'].schema.properties)).toEqual([
        'name',
        'expiresInDays',
        'readOnly',
        'mcpApprovals',
        'workspace',
      ]);
      expect(doc.paths['/api/v1/meta'].get.security).toEqual([]);
      // Each described route is one the server has, and the other way round.
      let count = 0;
      for (const route of Object.keys(ROUTES)) {
        const [method, url] = route.split(' ') as [string, string];
        const path = url.replace(/:([A-Za-z_]+)/g, '{$1}');
        expect(doc.paths[path]?.[method.toLowerCase()], route).toBeTruthy();
        count++;
      }
      const documented = Object.values(doc.paths as Record<string, object>).reduce(
        (n: number, ops) => n + Object.keys(ops).length,
        0,
      );
      expect(documented).toBe(count);
    });

    it('service accounts: no password, tokens made for them by an administrator', async () => {
      const refused = await call('POST', '/api/v1/users', admin, {
        login: 'ci-bot',
        service: true,
        password: PASSWORD,
      });
      expect(refused.statusCode).toBe(400);
      const made = await call('POST', '/api/v1/users', admin, {
        login: 'ci-bot',
        name: 'CI pipeline',
        service: true,
      });
      expect(made.statusCode).toBe(201);
      const bot = made.json();
      expect(bot).toMatchObject({ login: 'ci-bot', service: true, admin: false });
      expect(
        (await call('PUT', `/api/v1/users/${bot.id}/password`, admin, { password: PASSWORD }))
          .statusCode,
      ).toBe(400);
      // It cannot sign in: there is no password to sign in with.
      expect(
        (await call('POST', '/api/v1/session', undefined, { login: 'ci-bot', password: PASSWORD }))
          .statusCode,
      ).toBe(401);

      const token = await call('POST', `/api/v1/users/${bot.id}/tokens`, admin, {
        name: 'pipeline',
        readOnly: true,
      });
      expect(token.statusCode).toBe(201);
      const secret = token.json().token as string;
      expect((await call('GET', '/api/v1/session', secret)).json()).toMatchObject({
        login: 'ci-bot',
      });
      // Not for a person (they make their own), and not by a token.
      const person = (await call('GET', '/api/v1/users', admin))
        .json()
        .find((u: { login: string }) => u.login === 'dana');
      expect(
        (await call('POST', `/api/v1/users/${person.id}/tokens`, admin, { name: 'x' })).statusCode,
      ).toBe(400);
      expect(
        (await call('POST', `/api/v1/users/${bot.id}/tokens`, secret, { name: 'x' })).statusCode,
      ).toBe(403);
    });

    it('a token for one workspace reaches that workspace and nothing else', async () => {
      const net = (
        await call('POST', '/api/v1/workspaces', admin, { key: 'net', name: 'Network' })
      ).json();
      const lab = (
        await call('POST', '/api/v1/workspaces', admin, { key: 'lab', name: 'Lab' })
      ).json();
      const core = (
        await call('POST', '/api/v1/workspaces/net/projects', admin, { key: 'core', name: 'Core' })
      ).json();
      const toys = (
        await call('POST', '/api/v1/workspaces/lab/projects', admin, { key: 'toys', name: 'Toys' })
      ).json();
      expect(
        (await call('POST', '/api/v1/tokens', admin, { name: 'x', workspace: 'nowhere' }))
          .statusCode,
      ).toBe(400);
      const made = await call('POST', '/api/v1/tokens', admin, {
        name: 'net only',
        workspace: 'net',
      });
      expect(made.json()).toMatchObject({ workspace: net.id });
      const token = made.json().token as string;

      const status = async (method: string, url: string) =>
        (await call(method, url, token)).statusCode;
      expect(await status('GET', '/api/v1/session')).toBe(200);
      expect(await status('GET', '/api/v1/workspaces/net')).toBe(200);
      expect(await status('GET', `/api/v1/projects/${core.id}`)).toBe(200);
      expect(await status('GET', `/api/v1/runs?project=${core.id}`)).toBe(200);
      expect(await status('GET', '/api/v1/workspaces/lab')).toBe(403);
      expect(await status('GET', `/api/v1/workspaces/${lab.id}/projects`)).toBe(403);
      expect(await status('GET', `/api/v1/projects/${toys.id}`)).toBe(403);
      expect(await status('GET', `/api/v1/runs?project=${toys.id}`)).toBe(403);
      // What spans workspaces is out of its reach.
      expect(await status('GET', '/api/v1/workspaces')).toBe(403);
      expect(await status('GET', '/api/v1/runs')).toBe(403);
      expect(await status('GET', '/api/v1/users')).toBe(403);
      expect(await status('GET', '/api/v1/audit')).toBe(403);
      const refused = await call('GET', '/api/v1/workspaces/lab', token);
      expect(refused.json()).toMatchObject({ error: 'out_of_scope' });
      // And git: the project of its workspace, not the other's.
      expect(await status('GET', '/git/net/core.git/info/refs?service=git-upload-pack')).toBe(200);
      expect(await status('GET', '/git/lab/toys.git/info/refs?service=git-upload-pack')).toBe(403);
      // A token for all workspaces still reaches them all.
      const all = (await call('POST', '/api/v1/tokens', admin, { name: 'all' })).json().token;
      expect((await call('GET', '/api/v1/workspaces/lab', all)).statusCode).toBe(200);
    });

    it('the user commands add a service account and make a token for one workspace', async () => {
      const out: string[] = [];
      const asked: string[] = [];
      const run = (...args: string[]) =>
        userCommand(
          db(),
          args,
          (line) => out.push(line),
          async (prompt) => {
            asked.push(prompt);
            return PASSWORD;
          },
        );
      expect(await run('add', 'deploy-bot', '--service')).toBe(0);
      expect(out.at(-1)).toBe('Added deploy-bot as a service account.');
      expect(asked).toEqual([]);
      expect(await run('token', 'deploy-bot', '--workspace', 'net', '--name', 'deploy')).toBe(0);
      const token = out.at(-1) as string;
      await grant(db(), 'net', 'deploy-bot');
      expect((await call('GET', '/api/v1/workspaces/net', token)).statusCode).toBe(200);
      expect((await call('GET', '/api/v1/workspaces/lab', token)).statusCode).toBe(403);
      expect(await run('token', 'deploy-bot', '--workspace', 'nowhere')).toBe(1);
    });
  });
}
