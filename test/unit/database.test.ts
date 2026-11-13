// The database layer on both databases the server supports. SQLite always runs; PostgreSQL runs
// when AFS_TEST_POSTGRES_URL names a database the tests may fill and empty.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate, migrationNames } from '../../src/server/db/migrations';
import { getSetting, instanceId, setSetting } from '../../src/server/db/settings';

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const dir = mkdtempSync(join(tmpdir(), 'afs-db-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: join(dir, 'nested', 'afs.db') }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

for (const [name, config] of databases) {
  describe.skipIf(!config)(`the database layer on ${name}`, () => {
    let database: Database;

    beforeAll(async () => {
      if (!config) return;
      database = openDatabase(config);
      if (database.kind === 'postgres') {
        // A database the tests own: start from nothing. Children before their parents.
        for (const table of [
          'git_push',
          'api_token',
          'project',
          'credential',
          'workspace',
          'session',
          'group_member',
          'user_group',
          'user_account',
          'setting',
          'kysely_migration',
          'kysely_migration_lock',
        ])
          await sql`drop table if exists ${sql.table(table)}`.execute(database.db);
      }
    });
    afterAll(async () => {
      await database?.close();
    });

    it('answers a ping', async () => {
      await expect(database.ping()).resolves.toBeUndefined();
    });

    it('is brought up to date once; a second start changes nothing', async () => {
      expect(await migrate(database.db as never)).toEqual(migrationNames());
      expect(await migrate(database.db as never)).toEqual([]);
    });

    it('keeps a setting, and replaces it when it is set again', async () => {
      expect(await getSetting(database.db, 'greeting')).toBeUndefined();
      await setSetting(database.db, 'greeting', 'hello');
      expect(await getSetting(database.db, 'greeting')).toBe('hello');
      await setSetting(database.db, 'greeting', 'good day');
      expect(await getSetting(database.db, 'greeting')).toBe('good day');
      const rows = await database.db.selectFrom('setting').selectAll().execute();
      expect(rows.filter((r) => r.name === 'greeting')).toHaveLength(1);
      expect(rows[0]?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('the installation id is made once and stays', async () => {
      const first = await instanceId(database.db);
      expect(first).toMatch(/^[0-9a-f-]{36}$/);
      expect(await instanceId(database.db)).toBe(first);
      // Asked by several at once, as two servers starting together would.
      const many = await Promise.all([1, 2, 3, 4].map(() => instanceId(database.db)));
      expect(new Set(many)).toEqual(new Set([first]));
    });

    it('a transaction that fails leaves nothing behind', async () => {
      await expect(
        database.db.transaction().execute(async (trx) => {
          await setSetting(trx, 'half', 'done');
          throw new Error('stop');
        }),
      ).rejects.toThrow('stop');
      expect(await getSetting(database.db, 'half')).toBeUndefined();
      await database.db.transaction().execute((trx) => setSetting(trx, 'whole', 'done'));
      expect(await getSetting(database.db, 'whole')).toBe('done');
    });

    it('text survives as it was written: quotes, other alphabets, an empty value', async () => {
      for (const value of ['it\'s "quoted"', 'Привет, мир', '{"a":[1,2]}', '']) {
        await setSetting(database.db, 'text', value);
        expect(await getSetting(database.db, 'text')).toBe(value);
      }
    });
  });
}

describe('opening a database', () => {
  it('a PostgreSQL that is not there fails the ping, with no password in the reason', async () => {
    const database = openDatabase({
      kind: 'postgres',
      url: 'postgres://flows:s3cret@127.0.0.1:1/flows',
    });
    const reason = await database.ping().then(
      () => 'answered',
      (e: Error) => e.message,
    );
    expect(reason).not.toBe('answered');
    expect(reason).not.toContain('s3cret');
    await database.close();
  });
});
