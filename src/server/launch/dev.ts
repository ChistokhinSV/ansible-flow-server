// Dev runs (AFS-26): someone with rw sends their unpushed work (committed or not) as a git bundle;
// the server keeps its commit under refs/afs/dev/<id> of the project's repository for a while and
// runs it in check mode only. Real runs still take a commit of the project's branch. The bundle's
// commit never reaches a branch, the source of an external project, or anyone who clones.
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import type { Git } from '../projects/git';

type Db = Kysely<Schema>;

export interface DevBundle {
  id: string;
  project: string;
  commit: string;
  size: number;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

const bundleOf = (row: Schema['dev_bundle']): DevBundle => ({
  id: row.id,
  project: row.project_id,
  commit: row.commit_id,
  size: row.size,
  createdBy: row.created_login,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

/** Takes a bundle into the project's repository; throws GitError with why when it cannot. */
export async function addDevBundle(
  db: Db,
  git: Git,
  input: { project: string; bytes: Buffer; by: { id: string; login: string }; keepHours: number },
  now = new Date(),
): Promise<DevBundle> {
  const id = randomUUID();
  const file = join(tmpdir(), `afs-dev-${id}.bundle`);
  await writeFile(file, input.bytes, { mode: 0o600 });
  try {
    const commit = await git.devBundle(input.project, file, id);
    const row: Schema['dev_bundle'] = {
      id,
      project_id: input.project,
      commit_id: commit,
      size: input.bytes.length,
      created_by: input.by.id,
      created_login: input.by.login,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + input.keepHours * 3_600_000).toISOString(),
    };
    await db.insertInto('dev_bundle').values(row).execute();
    return bundleOf(row);
  } finally {
    await rm(file, { force: true });
  }
}

/** A bundle that has not expired. */
export async function getDevBundle(
  db: Db,
  id: string,
  now = new Date(),
): Promise<DevBundle | undefined> {
  const row = await db
    .selectFrom('dev_bundle')
    .selectAll()
    .where('id', '=', id)
    .where('expires_at', '>', now.toISOString())
    .executeTakeFirst();
  return row ? bundleOf(row) : undefined;
}

/** Bundles past their time go, with their refs. Resolves with how many. */
export async function pruneDevBundles(db: Db, git: Git, now = new Date()): Promise<number> {
  const rows = await db
    .selectFrom('dev_bundle')
    .select(['id', 'project_id'])
    .where('expires_at', '<=', now.toISOString())
    .execute();
  for (const row of rows) {
    await git.dropDev(row.project_id, row.id);
    await db.deleteFrom('dev_bundle').where('id', '=', row.id).execute();
  }
  return rows.length;
}
