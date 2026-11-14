// Operations (AFS-37): a backup taken while the server could run, restored into a new data folder
// on SQLite and on PostgreSQL (when AFS_TEST_POSTGRES_URL is set); /metrics behind its token;
// /readyz check by check.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { createUser } from '../../src/server/auth/users';
import { type Config, loadConfig } from '../../src/server/config';
import { openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { backup, readManifest, restore } from '../../src/server/ops/backup';
import { Metrics } from '../../src/server/ops/metrics';
import { createWorkspace } from '../../src/server/projects/store';
import { createCredential, reveal } from '../../src/server/secrets/credentials';
import { loadMasterKey } from '../../src/server/secrets/masterKey';

const root = mkdtempSync(join(tmpdir(), 'afs-ops-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
const configOf = (dir: string, database?: string): Config =>
  loadConfig({ AFS_DATA_DIR: dir, ...(database ? { AFS_DATABASE_URL: database } : {}) });

/** A data folder with a person, a workspace, a sealed credential, a repository and a certificate. */
async function server(dir: string) {
  const config = configOf(dir);
  mkdirSync(dir, { recursive: true });
  const key = loadMasterKey(config);
  const database = openDatabase(config.database);
  await migrate(database.db as never);
  await createUser(database.db, {
    login: 'dana',
    name: 'Dana Whitfield',
    password: 'correct horse battery staple',
    admin: true,
  });
  const ws = await createWorkspace(database.db, { key: 'net', name: 'Network' });
  const cred = await createCredential(database.db, key, ws.id, {
    name: 'edge login',
    kind: 'login',
    fields: { username: 'netops' },
    secret: { password: 'S3cr3t-edge' },
  });
  await database.close();
  mkdirSync(join(dir, 'repos', 'p1.git', 'refs'), { recursive: true });
  writeFileSync(join(dir, 'repos', 'p1.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(dir, 'tls'), { recursive: true });
  writeFileSync(join(dir, 'tls', 'server.crt'), 'certificate\n');
  // Made again by the server: not in a backup.
  mkdirSync(join(dir, 'work', 'p1', 'branch'), { recursive: true });
  writeFileSync(join(dir, 'work', 'p1', 'branch', 'x'), 'checkout\n');
  return { config, key, credential: cred.id };
}

const postgres = process.env.AFS_TEST_POSTGRES_URL;

describe('backup and restore', () => {
  it('a backup restores into a new data folder; the key is its own matter', async () => {
    const from = join(root, 'from');
    const { config, key, credential } = await server(from);
    const file = join(root, 'b1.tar.gz');
    const { manifest } = await backup(config, file);
    expect(manifest).toMatchObject({
      format: 1,
      database: 'sqlite',
      keyId: key.id,
      withKey: false,
    });
    expect(manifest.folders.sort()).toEqual(['repos', 'tls']);
    // References first: a credential after its workspace, a member after its group.
    const order = manifest.tables.map((t) => t.name);
    expect(order.indexOf('workspace')).toBeLessThan(order.indexOf('credential'));
    expect(manifest.tables.find((t) => t.name === 'user_account')?.rows).toBe(1);
    expect((await readManifest(file)).createdAt).toBe(manifest.createdAt);
    // The staging folder is gone, and the backup holds no key.
    expect(existsSync(join(from, '.afs-backup'))).toBe(false);
    await expect(backup(config, file)).rejects.toThrow(/is there already/);

    // A new data folder without the key: refused, saying which key.
    const to = join(root, 'to');
    mkdirSync(to, { recursive: true });
    await expect(restore(configOf(to), file)).rejects.toThrow(
      new RegExp(`sealed with the master key ${key.id}`),
    );

    // With the key in place: everything back, the credential opens.
    cpSync(join(from, 'master.key'), join(to, 'master.key'));
    const done = await restore(configOf(to), file);
    expect(done.rows).toBe(manifest.tables.reduce((n, t) => n + t.rows, 0));
    expect(readFileSync(join(to, 'repos', 'p1.git', 'HEAD'), 'utf8')).toContain('main');
    expect(existsSync(join(to, 'tls', 'server.crt'))).toBe(true);
    expect(existsSync(join(to, 'work'))).toBe(false);
    expect(existsSync(join(to, '.afs-backup'))).toBe(false);
    const database = openDatabase(configOf(to).database);
    const opened = await reveal(database.db, loadMasterKey(configOf(to), false), credential);
    expect(opened?.secret.password).toBe('S3cr3t-edge');
    await database.close();

    // Again: the data is there now.
    await expect(restore(configOf(to), file)).rejects.toThrow(/database has data/);
    await expect(restore(configOf(to), file, { force: false })).rejects.toThrow();
    const again = await restore(configOf(to), file, { force: true });
    expect(again.rows).toBe(done.rows);
  });

  it('--with-key: the key comes with it, and a different one in place is refused', async () => {
    const from = join(root, 'from2');
    const { config, key } = await server(from);
    const file = join(root, 'b2.tar.gz');
    const { manifest } = await backup(config, file, { withKey: true });
    expect(manifest.withKey).toBe(true);
    const to = join(root, 'to2');
    const done = await restore(configOf(to), file);
    expect(done.keyFile).toBe(join(to, 'master.key'));
    expect(loadMasterKey(configOf(to), false).id).toBe(key.id);

    const other = join(root, 'to3');
    mkdirSync(other, { recursive: true });
    loadMasterKey(configOf(other)); // a key of its own
    await expect(restore(configOf(other), file)).rejects.toThrow(/another key than the backup/);
  });

  it.skipIf(!postgres)('a SQLite backup restores into PostgreSQL', async () => {
    const from = join(root, 'from-pg');
    const { config, credential } = await server(from);
    const file = join(root, 'b-pg.tar.gz');
    await backup(config, file);
    const to = join(root, 'to-pg');
    mkdirSync(to, { recursive: true });
    cpSync(join(from, 'master.key'), join(to, 'master.key'));
    const target = configOf(to, postgres);
    // The shared test database has other files' rows: dropped with --force.
    const done = await restore(target, file, { force: true });
    expect(done.rows).toBeGreaterThan(0);
    const database = openDatabase(target.database);
    const opened = await reveal(database.db, loadMasterKey(target, false), credential);
    expect(opened?.secret.password).toBe('S3cr3t-edge');
    await database.close();
  });
});

describe('metrics and readiness', () => {
  it('/metrics answers its token only, with runs, queue and requests; /readyz says each check', async () => {
    const dir = join(root, 'metrics');
    mkdirSync(dir, { recursive: true });
    const database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    const metrics = new Metrics({ db: database.db, version: '0.1.0', designer: '0.85.0' });
    const token = 'metrics-token-for-tests-only';
    const app = buildApp({
      log,
      database,
      instance: 'test',
      metrics,
      metricsToken: token,
      readiness: { dataDir: dir, engine: () => undefined, minFreeBytes: 1 },
    });
    metrics.runEnded('check', 'succeeded', 42);
    metrics.buildEnded('done', 300);
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/metrics' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/metrics',
          headers: { authorization: 'Bearer wrong-token-of-same-size' },
        })
      ).statusCode,
    ).toBe(401);
    const got = await app.inject({
      url: '/metrics',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(got.statusCode).toBe(200);
    expect(got.body).toContain('afs_runs{state="queued"} 0');
    expect(got.body).toContain('afs_queue_depth 0');
    expect(got.body).toContain('afs_approvals_waiting 0');
    expect(got.body).toContain('afs_info{version="0.1.0",designer="0.85.0"} 1');
    expect(got.body).toMatch(
      /afs_run_duration_seconds_count\{mode="check",outcome="succeeded"\} 1/,
    );
    expect(got.body).toMatch(
      /afs_http_request_duration_seconds_count\{method="GET",route="\/healthz",status="2xx"\} 1/,
    );
    // Its own scrapes are not counted.
    expect(got.body).not.toContain('route="/metrics"');

    const ready = await app.inject({ url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: 'degraded',
      database: 'sqlite',
      checks: {
        database: { state: 'ok' },
        data: { state: 'ok' },
        engine: { state: 'warn', engine: 'none' },
      },
    });
    // A data folder that cannot be written: unavailable.
    const broken = buildApp({
      log,
      database,
      instance: 'test',
      readiness: { dataDir: join(dir, 'no', 'such', 'folder') },
    });
    const down = await broken.inject({ url: '/readyz' });
    expect(down.statusCode).toBe(503);
    expect(down.json().checks.data.state).toBe('fail');
    // Without a token set there are no metrics.
    expect((await broken.inject({ url: '/metrics' })).statusCode).toBe(404);
    await app.close();
    await broken.close();
    await database.close();
  });
});
