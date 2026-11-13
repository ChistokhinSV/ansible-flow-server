// The database's changes, in order. They only go forward: a change that was released is never
// edited, a mistake in one is corrected by the next. They run at every start; the ones a database
// already has are skipped.
//
// Written with the schema builder and types both databases have (ADR-0005). A name sorts by its
// number, which is the order they run in.
import type { Kysely } from 'kysely';
import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration';

const MIGRATIONS: Record<string, Migration> = {
  '0001_setting': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('setting')
        .addColumn('name', 'text', (c) => c.primaryKey())
        .addColumn('value', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
    },
  },
};

const provider: MigrationProvider = { getMigrations: async () => MIGRATIONS };

/** The names of the changes this server knows, in order. */
export const migrationNames = (): string[] => Object.keys(MIGRATIONS).sort();

/**
 * Brings the database up to this server's schema. Resolves with the changes it made now; throws
 * when one fails (the database then has the ones before it) or when the database has a change
 * this server does not know: it was last used by a newer server.
 */
export async function migrate(db: Kysely<unknown>): Promise<string[]> {
  const migrator = new Migrator({ db, provider });
  const { error, results } = await migrator.migrateToLatest();
  const failed = results?.find((r) => r.status === 'Error');
  if (error || failed) {
    const why = error instanceof Error ? error.message : String(error ?? 'unknown error');
    throw new Error(
      failed
        ? `The database change ${failed.migrationName} failed: ${why}`
        : `The database could not be brought up to date: ${why}`,
    );
  }
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
