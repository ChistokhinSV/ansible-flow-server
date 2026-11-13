// Emptying tables between tests. With PostgreSQL every test file shares one database, so a file
// must be able to start from what another left behind: each list here names a table's children
// before the table, and is the one place to add a new table to.
import type { Kysely } from 'kysely';
import type { Schema } from '../../../src/server/db/schema';

/** Workspaces and everything that hangs off them, children first. */
const WORKSPACES = [
  'access_grant',
  'run',
  'launch_config_credential',
  'launch_config',
  'git_push',
  'project',
  'credential',
  'workspace',
] as const;

/** People and everything that hangs off them, children first. */
const PEOPLE = ['api_token', 'session', 'group_member', 'user_group', 'user_account'] as const;

export async function emptyWorkspaces(db: Kysely<Schema>): Promise<void> {
  for (const table of WORKSPACES) await db.deleteFrom(table).execute();
}

export async function emptyPeople(db: Kysely<Schema>): Promise<void> {
  // The audit log names people and things but holds no keys to them; it goes with the people.
  await db.deleteFrom('audit_entry').execute();
  for (const table of PEOPLE) await db.deleteFrom(table).execute();
}
