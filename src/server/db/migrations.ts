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
  // AFS-12: people, groups and sign-ins.
  '0002_users': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('user_account')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('login', 'text', (c) => c.notNull().unique())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('email', 'text')
        .addColumn('webhook_url', 'text')
        .addColumn('password_hash', 'text')
        .addColumn('is_admin', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('disabled', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addColumn('last_login_at', 'text')
        .execute();
      await db.schema
        .createTable('user_group')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('name', 'text', (c) => c.notNull().unique())
        .addColumn('email', 'text')
        .addColumn('webhook_url', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createTable('group_member')
        .addColumn('group_id', 'text', (c) =>
          c.notNull().references('user_group.id').onDelete('cascade'),
        )
        .addColumn('user_id', 'text', (c) =>
          c.notNull().references('user_account.id').onDelete('cascade'),
        )
        .addPrimaryKeyConstraint('group_member_pk', ['group_id', 'user_id'])
        .execute();
      await db.schema
        .createIndex('group_member_user')
        .on('group_member')
        .column('user_id')
        .execute();
      await db.schema
        .createTable('session')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('user_id', 'text', (c) =>
          c.notNull().references('user_account.id').onDelete('cascade'),
        )
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('last_seen_at', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'text', (c) => c.notNull())
        .addColumn('ip', 'text')
        .addColumn('user_agent', 'text')
        .execute();
      await db.schema.createIndex('session_user').on('session').column('user_id').execute();
    },
  },
  // AFS-13: workspaces and their projects (git repositories).
  '0003_projects': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('workspace')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('key', 'text', (c) => c.notNull().unique())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createTable('project')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspace.id'))
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('git_url', 'text', (c) => c.notNull())
        .addColumn('git_ref', 'text', (c) => c.notNull())
        .addColumn('commit_id', 'text')
        .addColumn('sync_state', 'text', (c) => c.notNull())
        .addColumn('sync_error', 'text')
        .addColumn('synced_at', 'text')
        .addColumn('poll_seconds', 'integer', (c) => c.notNull())
        .addColumn('hook_token_hash', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addUniqueConstraint('project_workspace_key', ['workspace_id', 'key'])
        .execute();
    },
  },
  // AFS-57: personal access tokens.
  '0004_tokens': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('api_token')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('user_id', 'text', (c) =>
          c.notNull().references('user_account.id').onDelete('cascade'),
        )
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('token_hash', 'text', (c) => c.notNull().unique())
        .addColumn('hint', 'text', (c) => c.notNull())
        .addColumn('read_only', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('last_used_at', 'text')
        .addColumn('expires_at', 'text')
        .execute();
      await db.schema.createIndex('api_token_user').on('api_token').column('user_id').execute();
    },
  },
  // AFS-14: who pushed what through the server.
  '0005_git_push': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('git_push')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('project_id', 'text', (c) =>
          c.notNull().references('project.id').onDelete('cascade'),
        )
        .addColumn('user_id', 'text', (c) => c.notNull())
        .addColumn('login', 'text', (c) => c.notNull())
        .addColumn('ref', 'text', (c) => c.notNull())
        .addColumn('old_commit', 'text')
        .addColumn('new_commit', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('git_push_project')
        .on('git_push')
        .columns(['project_id', 'created_at'])
        .execute();
    },
  },
  // AFS-17: credentials, and the one a project signs in to its source with.
  '0006_credentials': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('credential')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspace.id'))
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('fields_json', 'text', (c) => c.notNull())
        .addColumn('has_json', 'text', (c) => c.notNull())
        .addColumn('secret_enc', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addUniqueConstraint('credential_workspace_name', ['workspace_id', 'name'])
        .execute();
      await db.schema
        .alterTable('project')
        .addColumn('git_credential_id', 'text', (c) => c.references('credential.id'))
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
