// Giving a user a level in tests: since AFS-27 a person who is not an administrator sees only
// what they have a grant on.
import type { Kysely } from 'kysely';
import { createGrant, type GrantLevel } from '../../../src/server/access/grants';
import type { Schema } from '../../../src/server/db/schema';
import { getWorkspace } from '../../../src/server/projects/store';

export async function grant(
  db: Kysely<Schema>,
  workspace: string,
  login: string,
  level: GrantLevel = 'ro',
  flow?: { project: string; file: string },
) {
  const found = await getWorkspace(db, workspace);
  if (!found) throw new Error(`No workspace ${workspace}`);
  return createGrant(
    db,
    found.id,
    { user: login, level, ...(flow ? { project: flow.project, flow: flow.file } : {}) },
    'test',
  );
}
