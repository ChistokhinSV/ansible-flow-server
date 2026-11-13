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
  // AFS-18: launch configurations.
  '0007_launch_configs': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('launch_config')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('project_id', 'text', (c) =>
          c.notNull().references('project.id').onDelete('cascade'),
        )
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('flow_file', 'text', (c) => c.notNull())
        .addColumn('git_ref', 'text')
        .addColumn('commit_id', 'text')
        .addColumn('inventory', 'text')
        .addColumn('ee_image', 'text')
        .addColumn('mode', 'text', (c) => c.notNull())
        .addColumn('run_limit', 'text')
        .addColumn('inputs_json', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addUniqueConstraint('launch_config_project_name', ['project_id', 'name'])
        .execute();
      await db.schema
        .createTable('launch_config_credential')
        .addColumn('config_id', 'text', (c) =>
          c.notNull().references('launch_config.id').onDelete('cascade'),
        )
        .addColumn('credential_id', 'text', (c) => c.notNull().references('credential.id'))
        .addColumn('position', 'integer', (c) => c.notNull())
        .addPrimaryKeyConstraint('launch_config_credential_pk', ['config_id', 'credential_id'])
        .execute();
    },
  },
  // AFS-19: runs, and the queue they wait in.
  '0008_runs': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('run')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('number', 'integer', (c) => c.notNull())
        .addColumn('project_id', 'text', (c) => c.notNull().references('project.id'))
        .addColumn('config_id', 'text')
        .addColumn('config_name', 'text')
        .addColumn('commit_id', 'text', (c) => c.notNull())
        .addColumn('git_ref', 'text')
        .addColumn('flow_file', 'text', (c) => c.notNull())
        .addColumn('flow_key', 'text', (c) => c.notNull())
        .addColumn('flow_name', 'text', (c) => c.notNull())
        .addColumn('flow_version', 'integer', (c) => c.notNull())
        .addColumn('mode', 'text', (c) => c.notNull())
        .addColumn('inventory', 'text')
        .addColumn('ee_image', 'text')
        .addColumn('run_limit', 'text')
        .addColumn('inputs_enc', 'text', (c) => c.notNull())
        .addColumn('inputs_shown_json', 'text', (c) => c.notNull())
        .addColumn('targets_json', 'text', (c) => c.notNull())
        .addColumn('credentials_json', 'text', (c) => c.notNull())
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('requested_by', 'text', (c) => c.notNull())
        .addColumn('requested_login', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addColumn('claimed_at', 'text')
        .addColumn('started_at', 'text')
        .addColumn('ended_at', 'text')
        .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('lease_owner', 'text')
        .addColumn('lease_token', 'text')
        .addColumn('lease_until', 'text')
        .addColumn('cancel_requested', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('cancelled_by', 'text')
        .addColumn('error', 'text')
        .addUniqueConstraint('run_project_number', ['project_id', 'number'])
        .execute();
      await db.schema.createIndex('run_state').on('run').columns(['state', 'created_at']).execute();
      await db.schema
        .createIndex('run_project')
        .on('run')
        .columns(['project_id', 'created_at'])
        .execute();
    },
  },
  // AFS-20: how a run went, as the designer shows it.
  '0009_run_view': {
    async up(db: Kysely<unknown>) {
      await db.schema.alterTable('run').addColumn('view_json', 'text').execute();
    },
  },
  // AFS-21: where a run's events are.
  '0010_run_dir': {
    async up(db: Kysely<unknown>) {
      await db.schema.alterTable('run').addColumn('run_dir', 'text').execute();
    },
  },
  // AFS-26: dev runs: someone's unpushed work, taken in as a git bundle, run in check mode.
  '0017_dev_runs': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('dev_bundle')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('project_id', 'text', (c) => c.notNull())
        .addColumn('commit_id', 'text', (c) => c.notNull())
        .addColumn('size', 'integer', (c) => c.notNull())
        .addColumn('created_by', 'text', (c) => c.notNull())
        .addColumn('created_login', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('dev_bundle_expires')
        .on('dev_bundle')
        .columns(['expires_at'])
        .execute();
      await db.schema.alterTable('run').addColumn('dev_bundle', 'text').execute();
    },
  },
  // AFS-24: a token may let an agent decide approvals over MCP.
  '0016_token_mcp_approve': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .alterTable('api_token')
        .addColumn('mcp_approve', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();
    },
  },
  // AFS-29: notifications, and who a launch configuration's runs tell.
  '0015_notifications': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('notification')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('event_id', 'text', (c) => c.notNull())
        .addColumn('event', 'text', (c) => c.notNull())
        .addColumn('channel', 'text', (c) => c.notNull())
        .addColumn('recipient', 'text', (c) => c.notNull())
        .addColumn('target', 'text', (c) => c.notNull())
        .addColumn('message_json', 'text', (c) => c.notNull())
        .addColumn('run_id', 'text')
        .addColumn('dedupe', 'text', (c) => c.unique())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('next_at', 'text', (c) => c.notNull())
        .addColumn('last_error', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('sent_at', 'text')
        .execute();
      await db.schema
        .createIndex('notification_due')
        .on('notification')
        .columns(['status', 'next_at'])
        .execute();
      await db.schema
        .createIndex('notification_created')
        .on('notification')
        .columns(['created_at', 'id'])
        .execute();
      await db.schema.alterTable('launch_config').addColumn('notify_json', 'text').execute();
    },
  },
  // AFS-28: approval gates.
  '0014_approval_gates': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .alterTable('workspace')
        .addColumn('self_approve', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();
      await db.schema.alterTable('run').addColumn('segments_json', 'text').execute();
      await db.schema
        .createTable('run_gate')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('run_id', 'text', (c) => c.notNull())
        .addColumn('node_id', 'text', (c) => c.notNull())
        .addColumn('node_key', 'text', (c) => c.notNull())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('segment', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('carried_json', 'text', (c) => c.notNull())
        .addColumn('deadline', 'text')
        .addColumn('approval_json', 'text')
        .addColumn('decided_by', 'text')
        .addColumn('decided_at', 'text')
        .addColumn('comment', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('run_gate_run').on('run_gate').columns(['run_id']).execute();
      await db.schema
        .createIndex('run_gate_status')
        .on('run_gate')
        .columns(['status', 'deadline'])
        .execute();
    },
  },
  // AFS-27: access levels.
  '0013_access_grants': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('access_grant')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('principal_type', 'text', (c) => c.notNull())
        .addColumn('principal_id', 'text', (c) => c.notNull())
        .addColumn('level', 'text', (c) => c.notNull())
        .addColumn('workspace_id', 'text', (c) => c.notNull())
        .addColumn('project_id', 'text')
        .addColumn('flow_file', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('created_by', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('access_grant_principal')
        .on('access_grant')
        .columns(['principal_type', 'principal_id'])
        .execute();
      await db.schema
        .createIndex('access_grant_workspace')
        .on('access_grant')
        .columns(['workspace_id'])
        .execute();
    },
  },
  // AFS-23: service accounts, and tokens for one workspace.
  '0012_service_accounts': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .alterTable('user_account')
        .addColumn('service', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();
      await db.schema.alterTable('api_token').addColumn('workspace_id', 'text').execute();
    },
  },
  // AFS-22: the audit log.
  '0011_audit': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('audit_entry')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('at', 'text', (c) => c.notNull())
        .addColumn('actor_id', 'text')
        .addColumn('actor_login', 'text')
        .addColumn('token_id', 'text')
        .addColumn('source', 'text', (c) => c.notNull())
        .addColumn('action', 'text', (c) => c.notNull())
        .addColumn('object_type', 'text', (c) => c.notNull())
        .addColumn('object_id', 'text')
        .addColumn('object_name', 'text')
        .addColumn('result', 'text', (c) => c.notNull())
        .addColumn('status', 'integer')
        .addColumn('ip', 'text')
        .addColumn('request_id', 'text')
        .addColumn('detail_json', 'text')
        .execute();
      await db.schema.createIndex('audit_at').on('audit_entry').columns(['at', 'id']).execute();
      await db.schema
        .createIndex('audit_actor')
        .on('audit_entry')
        .columns(['actor_login', 'at'])
        .execute();
      await db.schema
        .createIndex('audit_object')
        .on('audit_entry')
        .columns(['object_type', 'object_id', 'at'])
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
