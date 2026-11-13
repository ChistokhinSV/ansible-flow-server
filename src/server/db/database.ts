// Opens the server's database: SQLite (a file in the data folder, the default) or PostgreSQL. The
// rest of the server gets one query builder and does not ask which it is.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Kysely, PostgresDialect, type SqliteDatabase, SqliteDialect, sql } from 'kysely';
import pg from 'pg';
import type { Config } from '../config';
import type { Schema } from './schema';

export interface Database {
  kind: 'sqlite' | 'postgres';
  db: Kysely<Schema>;
  /** Answers when the database does; rejects when it does not. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Node's own SQLite as the database Kysely's SQLite dialect drives (it is written for
 * better-sqlite3, whose statements say whether they return rows; Node's say which columns).
 */
function sqliteFor(file: string): SqliteDatabase {
  const database = new DatabaseSync(file);
  // Readers do not wait for the writer; a writer waits for another instead of failing at once.
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA foreign_keys = ON');
  return {
    close: () => database.close(),
    prepare(text) {
      const statement = database.prepare(text);
      type Params = Parameters<typeof statement.all>;
      return {
        reader: statement.columns().length > 0,
        all: (parameters) => statement.all(...(parameters as Params)),
        run: (parameters) => statement.run(...(parameters as Params)),
        iterate: (parameters) =>
          statement.iterate(...(parameters as Params)) as IterableIterator<unknown>,
      };
    },
  };
}

export function openDatabase(config: Config['database']): Database {
  if (config.kind === 'sqlite') {
    if (config.file !== ':memory:') mkdirSync(dirname(config.file), { recursive: true });
    const db = new Kysely<Schema>({
      dialect: new SqliteDialect({ database: sqliteFor(config.file) }),
    });
    return {
      kind: 'sqlite',
      db,
      ping: async () => void (await sql`select 1`.execute(db)),
      close: () => db.destroy(),
    };
  }
  const pool = new pg.Pool({
    connectionString: config.url,
    max: 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  // A connection that breaks while idle must not end the process; the next query gets another.
  pool.on('error', () => undefined);
  const db = new Kysely<Schema>({ dialect: new PostgresDialect({ pool }) });
  return {
    kind: 'postgres',
    db,
    ping: async () => void (await sql`select 1`.execute(db)),
    close: () => db.destroy(),
  };
}
