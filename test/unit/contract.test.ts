// The designer's contract with this server (AFS-25): the exchanges the VS Code extension relies on,
// shipped in @ansible-flow/assets (contract/server-api.json), replayed in order against the real
// routes, on both databases the server supports (PostgreSQL when AFS_TEST_POSTGRES_URL is set). A
// change here that would break the extension fails here, and a new designer whose contract this
// server no longer keeps fails here before it is taken.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { contractDir } from '@ansible-flow/assets';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGrant, type GrantLevel } from '../../src/server/access/grants';
import { buildApp } from '../../src/server/app';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs } from '../../src/server/launch/configs';
import { createLogger } from '../../src/server/log';
import { FEATURES, serverMeta } from '../../src/server/meta';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { RunQueue } from '../../src/server/runs/queue';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { emptyPeople, emptyWorkspaces } from './helpers/clean';
import { type Captures, fill, mismatches, pick } from './helpers/contract';
import { type TestRepo, testRepo } from './helpers/repo';

interface Contract {
  version: number;
  world: {
    users: { login: string; name: string; admin?: boolean }[];
    tokens: Record<string, { user: string; readOnly?: boolean }>;
    workspace: { key: string; name: string };
    grants: { user: string; level: GrantLevel }[];
    project: { key: string; name: string; branch: string; files: string };
    launchConfigs: { name: string; flowFile: string; inventory?: string; inputs?: object }[];
  };
  exchanges: {
    name: string;
    request: { method: string; path: string; token?: string; body?: unknown };
    response: { status: number; body?: unknown };
    capture?: Record<string, string>;
  }[];
}

const contract = JSON.parse(readFileSync(join(contractDir, 'server-api.json'), 'utf8')) as Contract;

/** The files of a folder, by their path in it. */
function filesOf(dir: string, root = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) Object.assign(out, filesOf(path, root));
    else out[relative(root, path).replaceAll('\\', '/')] = readFileSync(path, 'utf8');
  }
  return out;
}

const root = mkdtempSync(join(tmpdir(), 'afs-contract-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

describe('the contract', () => {
  it('is one this test reads, and meta says what it promises', () => {
    expect(contract.version).toBe(1);
    const meta = serverMeta();
    expect(meta.designer.formats).toContain(meta.designer.format);
    expect(meta.features).toEqual([...FEATURES]);
    // The canvas the pages carry is the designer the server is built on.
    expect(meta.designer.bundle).toBe(meta.designer.version);
  });
});

for (const [name, config] of databases) {
  describe.skipIf(!config)(`the designer's contract on ${name}`, () => {
    let database: Database;
    let app: FastifyInstance;
    let sync: ProjectSync;
    let source: TestRepo;
    const tokens: Record<string, string> = {};
    const captured: Captures = {};
    const db = () => database.db;

    beforeAll(async () => {
      if (!config) return;
      database = openDatabase(config);
      await migrate(database.db as never);
      await emptyWorkspaces(db());
      await emptyPeople(db());
      const log = createLogger({ level: 'silent', format: 'json', write: () => undefined });
      const reposGit = new Git({ reposDir: join(root, `repos-${name}`), allowLocal: true });
      sync = new ProjectSync(db(), reposGit, log);
      const { world } = contract;
      const ids: Record<string, string> = {};
      for (const user of world.users)
        ids[user.login] = (await createUser(db(), { ...user, password: 'contract-password-1' })).id;
      for (const [tokenName, t] of Object.entries(world.tokens))
        tokens[tokenName] = (
          await createToken(db(), ids[t.user] as string, { name: tokenName, readOnly: t.readOnly })
        ).token;
      const workspace = await createWorkspace(db(), world.workspace);
      for (const g of world.grants)
        await createGrant(db(), workspace.id, { user: g.user, level: g.level }, 'contract');
      source = testRepo(filesOf(join(contractDir, world.project.files)));
      const project = await createProject(
        db(),
        workspace.id,
        {
          key: world.project.key,
          name: world.project.name,
          gitUrl: source.dir,
          gitRef: world.project.branch,
          pollSeconds: 0,
        },
        true,
      );
      await sync.sync(project.id);
      const configs = new LaunchConfigs(db(), reposGit);
      for (const c of world.launchConfigs)
        await configs.create(project.id, c as Parameters<LaunchConfigs['create']>[1]);
      app = buildApp({
        log,
        database,
        instance: randomUUID(),
        masterKey: key,
        runs: new RunQueue(db(), database.kind, key),
        projects: { git: reposGit, sync, allowLocal: true },
      });
    });
    afterAll(async () => {
      await app?.close();
      await sync?.stop();
      await database?.close();
      source?.remove();
    });

    // One test per exchange, in order: a capture of one is what the next asks with.
    for (const exchange of contract.exchanges)
      it(exchange.name, async () => {
        const { request, response } = exchange;
        const token = request.token ? tokens[request.token] : undefined;
        if (request.token && !token) throw new Error(`The world has no token ${request.token}`);
        const reply = await app.inject({
          method: request.method as 'GET',
          url: fill(request.path, captured),
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(request.body !== undefined ? { payload: JSON.stringify(request.body) } : {}),
        });
        const body = reply.body ? reply.json() : undefined;
        expect(reply.statusCode, JSON.stringify(body)).toBe(response.status);
        if (response.body !== undefined)
          expect(mismatches(response.body, body, captured)).toEqual([]);
        for (const [as, path] of Object.entries(exchange.capture ?? {})) {
          captured[as] = pick(body, path);
          expect(captured[as], `capture ${as} at ${path}`).toBeDefined();
        }
      });
  });
}
