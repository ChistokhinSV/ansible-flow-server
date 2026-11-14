// Backup and restore (AFS-37). A backup is one .tar.gz of what the server keeps:
//   .afs-backup/manifest.json        what it is: server version, database kind, schema, rows
//   .afs-backup/database/<t>.jsonl   every table, a row a line, read in one transaction
//   .afs-backup/master.key           only with --with-key
//   repos/ tls/ output/ runs/ environments/   from the data folder
// The rows are the server's own export (only text and integer columns), so a backup of SQLite
// restores into PostgreSQL and back. It is taken while the server runs: the database first, in
// one read transaction; then the files, which only grow (a repository has at least the commits
// the rows name). Folders the server makes again are left out: checkouts, the probe, temporary
// secrets, the database file itself.
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { type Kysely, sql, type Transaction } from 'kysely';
import * as tar from 'tar';
import type { Config } from '../config';
import { type Database, openDatabase } from '../db/database';
import { appliedMigrations, migrate, migrateTo, migrationNames } from '../db/migrations';
import { serverMeta } from '../meta';
import { KEY_FILE, keyId, loadMasterKey, MasterKeyError, parseKey } from '../secrets/masterKey';

/** Folders of the data folder a backup takes. */
export const FOLDERS = ['repos', 'tls', 'output', 'runs', 'environments'] as const;
const META = '.afs-backup';
const MIGRATION_TABLES = /^kysely_migration/;
const PAGE = 1000;

export interface Manifest {
  format: 1;
  server: string;
  createdAt: string;
  database: Database['kind'];
  /** The schema the rows are of: the database's changes, in order. */
  migrations: string[];
  /** Tables in an order that keeps their references: a table after those it points to. */
  tables: { name: string; rows: number }[];
  /** The master key's fingerprint the credentials are sealed with. */
  keyId?: string;
  withKey: boolean;
  folders: string[];
}

export class BackupError extends Error {}

type AnyDb = Kysely<Record<string, Record<string, unknown>>>;

/** The tables of the database, without the migrator's own, a table after those it points to. */
async function tablesInOrder(db: AnyDb, kind: Database['kind']): Promise<string[]> {
  const tables = (await db.introspection.getTables())
    .map((t) => t.name)
    .filter((n) => !MIGRATION_TABLES.test(n))
    .sort();
  const parents = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]));
  if (kind === 'sqlite') {
    for (const t of tables) {
      const { rows } = await sql<{
        table: string;
      }>`select "table" from pragma_foreign_key_list(${t})`.execute(db);
      for (const r of rows) if (r.table !== t) parents.get(t)?.add(r.table);
    }
  } else {
    const { rows } = await sql<{ child: string; parent: string }>`
      select tc.table_name as child, ccu.table_name as parent
      from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu
        on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = current_schema()`.execute(db);
    for (const r of rows) if (r.child !== r.parent) parents.get(r.child)?.add(r.parent);
  }
  const ordered: string[] = [];
  const placed = new Set<string>();
  const place = (t: string, seen: Set<string>) => {
    if (placed.has(t) || seen.has(t)) return;
    seen.add(t);
    for (const p of parents.get(t) ?? []) if (parents.has(p)) place(p, seen);
    placed.add(t);
    ordered.push(t);
  };
  for (const t of tables) place(t, new Set());
  return ordered;
}

/** Writes every table's rows, read in one transaction, a row a line. */
async function exportRows(
  database: Database,
  dir: string,
): Promise<{ tables: Manifest['tables']; migrations: string[] }> {
  const db = database.db as unknown as AnyDb;
  const migrations = await appliedMigrations(db as never);
  const order = await tablesInOrder(db, database.kind);
  // Asked before the transaction: SQLite has one connection, and the transaction holds it.
  const shape = await db.introspection.getTables();
  const read = async (trx: Transaction<Record<string, Record<string, unknown>>>) => {
    const tables: Manifest['tables'] = [];
    for (const name of order) {
      const columns = shape.find((t) => t.name === name)?.columns.map((c) => c.name) as string[];
      const out = createWriteStream(join(dir, `${name}.jsonl`));
      let rows = 0;
      for (let offset = 0; ; offset += PAGE) {
        // Every column, so pages do not overlap (not every table has a single key).
        let query = trx.selectFrom(name).selectAll();
        for (const c of columns) query = query.orderBy(sql.ref(c));
        const page = await query.limit(PAGE).offset(offset).execute();
        for (const row of page) out.write(`${JSON.stringify(row)}\n`);
        rows += page.length;
        if (page.length < PAGE) break;
      }
      await new Promise<void>((resolve, reject) =>
        out.end((e?: Error | null) => (e ? reject(e) : resolve())),
      );
      tables.push({ name, rows });
    }
    return tables;
  };
  // One snapshot: PostgreSQL's repeatable read; SQLite's read transaction (WAL) is one already.
  const trx =
    database.kind === 'postgres'
      ? db.transaction().setIsolationLevel('repeatable read')
      : db.transaction();
  const tables = await trx.execute(read);
  return { tables, migrations };
}

export interface BackupResult {
  file: string;
  manifest: Manifest;
}

/** Takes a backup of the server's data into `file` (.tar.gz). The server may be running. */
export async function backup(
  config: Config,
  file: string,
  options: { withKey?: boolean } = {},
): Promise<BackupResult> {
  if (existsSync(file)) throw new BackupError(`${file} is there already: name another file`);
  const staging = join(config.dataDir, META);
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, 'database'), { recursive: true, mode: 0o700 });
  const database = openDatabase(config.database);
  try {
    let key: { id: string; text?: string } | undefined;
    try {
      const k = loadMasterKey(config, false);
      key = { id: k.id, ...(options.withKey ? { text: `${k.key.toString('base64')}\n` } : {}) };
    } catch (e) {
      if (!(e instanceof MasterKeyError)) throw e;
      if (options.withKey) throw new BackupError(`There is no master key to take: ${e.message}`);
    }
    const { tables, migrations } = await exportRows(database, join(staging, 'database'));
    const folders = FOLDERS.filter((f) => existsSync(join(config.dataDir, f)));
    const manifest: Manifest = {
      format: 1,
      server: serverMeta().version,
      createdAt: new Date().toISOString(),
      database: database.kind,
      migrations,
      tables,
      ...(key ? { keyId: key.id } : {}),
      withKey: !!key?.text,
      folders,
    };
    if (key?.text) await writeFile(join(staging, KEY_FILE), key.text, { mode: 0o600 });
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await tar.create(
      { gzip: true, file, cwd: config.dataDir, portable: true, mode: 0o600 } as never,
      [META, ...folders],
    );
    return { file, manifest };
  } finally {
    await database.close().catch(() => undefined);
    await rm(staging, { recursive: true, force: true });
  }
}

/** Reads a backup's manifest without unpacking it. */
export async function readManifest(file: string): Promise<Manifest> {
  let text: string | undefined;
  await tar.list({
    file,
    filter: (path: string) => path === `${META}/manifest.json`,
    onReadEntry: (entry: { on(e: 'data', f: (b: Buffer) => void): void }) => {
      const parts: Buffer[] = [];
      entry.on('data', (b) => parts.push(b));
      (entry as unknown as { on(e: 'end', f: () => void): void }).on('end', () => {
        text = Buffer.concat(parts).toString('utf8');
      });
    },
  } as never);
  if (!text) throw new BackupError(`${file} is not a backup of Ansible Flow Server`);
  const manifest = JSON.parse(text) as Manifest;
  if (manifest.format !== 1)
    throw new BackupError(`${file} is a backup of a format this server does not read`);
  return manifest;
}

export interface RestoreResult {
  manifest: Manifest;
  rows: number;
  /** Changes the database got after the rows were in (a backup of an older server). */
  migrated: string[];
  keyFile?: string;
}

/**
 * Restores a backup into this server's data folder and database. The server must be stopped.
 * The database must have no data, or `force` drops its tables first; the data folder's
 * folders a backup holds must not be there, or `force` replaces them.
 */
export async function restore(
  config: Config,
  file: string,
  options: { force?: boolean } = {},
): Promise<RestoreResult> {
  const manifest = await readManifest(file);
  const known = new Set(migrationNames());
  const unknown = manifest.migrations.filter((m) => !known.has(m));
  if (unknown.length)
    throw new BackupError(
      `The backup was made by a newer server (${manifest.server}): its database has ${unknown[0]}, which this server does not know. Restore it with that version or later.`,
    );

  // The key the credentials are sealed with: from the backup, or the one this server has.
  let keyFile: string | undefined;
  if (manifest.keyId && !manifest.withKey) {
    let have: string | undefined;
    try {
      have = loadMasterKey(config, false).id;
    } catch (e) {
      if (!(e instanceof MasterKeyError)) throw e;
    }
    if (have !== manifest.keyId)
      throw new BackupError(
        `The backup's credentials are sealed with the master key ${manifest.keyId}${have ? `, and this server has ${have}` : ', and this server has none'}: put that key in place (${KEY_FILE} in the data folder, AFS_MASTER_KEY or AFS_MASTER_KEY_FILE) and restore again.`,
      );
  }

  const database = openDatabase(config.database);
  try {
    const db = database.db as unknown as AnyDb;
    const existing = (await db.introspection.getTables()).map((t) => t.name);
    if (existing.length) {
      const order = await tablesInOrder(db, database.kind);
      // A server that only started once has its settings (instance id, setup code) and nothing
      // else: that is an empty database too.
      let rows = 0;
      for (const t of order.filter((n) => n !== 'setting')) {
        const r = await db
          .selectFrom(t)
          .select(db.fn.countAll<number>().as('n'))
          .executeTakeFirst();
        rows += Number(r?.n ?? 0);
      }
      if (rows > 0 && !options.force)
        throw new BackupError(
          'The database has data: restore into an empty one, or with --force to drop its tables first',
        );
      // Children before parents, then the migrator's own tables.
      for (const t of [...order].reverse())
        await sql`drop table if exists ${sql.ref(t)}${database.kind === 'postgres' ? sql` cascade` : sql``}`.execute(
          db,
        );
      // By name: introspection does not list them, and left behind they would say every change
      // is made, and none would be made again (found by a test).
      for (const t of ['kysely_migration', 'kysely_migration_lock'])
        await sql`drop table if exists ${sql.ref(t)}`.execute(db);
    }

    // The folders: none there, or replaced with --force.
    for (const f of manifest.folders) {
      const there = join(config.dataDir, f);
      if (existsSync(there)) {
        if (!options.force)
          throw new BackupError(
            `The data folder has ${f}/ already: restore into a new one, or with --force to replace it`,
          );
        await rm(there, { recursive: true, force: true });
      }
    }
    await mkdir(config.dataDir, { recursive: true });
    const staging = join(config.dataDir, META);
    await rm(staging, { recursive: true, force: true });
    await tar.extract({ file, cwd: config.dataDir, strict: true, preservePaths: false } as never);

    // The schema of the rows, the rows, then this server's changes.
    const last = manifest.migrations.at(-1);
    if (last) await migrateTo(db as never, last);
    let rows = 0;
    await db.transaction().execute(async (trx) => {
      for (const { name } of manifest.tables) {
        const lines = createInterface({
          input: createReadStream(join(staging, 'database', `${name}.jsonl`)),
          crlfDelay: Number.POSITIVE_INFINITY,
        });
        let batch: Record<string, unknown>[] = [];
        const flush = async () => {
          if (batch.length)
            await trx
              .insertInto(name)
              .values(batch as never)
              .execute();
          rows += batch.length;
          batch = [];
        };
        for await (const line of lines) {
          if (!line.trim()) continue;
          batch.push(JSON.parse(line));
          if (batch.length >= 100) await flush();
        }
        await flush();
      }
    });
    const migrated = await migrate(db as never);

    if (manifest.withKey) {
      const text = await readFile(join(staging, KEY_FILE), 'utf8');
      const key = parseKey(text, 'The backup');
      if (config.masterKey && keyId(parseKey(config.masterKey, 'AFS_MASTER_KEY')) !== keyId(key))
        throw new BackupError(
          "AFS_MASTER_KEY is another key than the backup's: unset it to use the key the backup has, or set it to that key",
        );
      if (!config.masterKey) {
        keyFile = config.masterKeyFile ?? join(config.dataDir, KEY_FILE);
        if (existsSync(keyFile)) {
          const have = parseKey(await readFile(keyFile, 'utf8'), keyFile);
          if (keyId(have) !== keyId(key))
            throw new BackupError(
              `${keyFile} is another key than the backup's: move it away and restore again`,
            );
        } else await writeFile(keyFile, text, { mode: 0o600 });
      }
    }
    await rm(staging, { recursive: true, force: true });
    return { manifest, rows, migrated, ...(keyFile ? { keyFile } : {}) };
  } finally {
    await database.close().catch(() => undefined);
  }
}
