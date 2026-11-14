// The image a launch in an environment gets (AFS-32): a registered image as it is, or the newest
// good build whose image is still on the engine. Only database reads, so the launch code can ask
// without the builder.
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';

export async function environmentImage(
  db: Kysely<Schema>,
  id: string,
): Promise<{ image?: string; why?: string; name?: string; workspace?: string }> {
  const env = await db
    .selectFrom('environment')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!env) return { why: 'The environment is gone' };
  const known = { name: env.name, workspace: env.workspace_id };
  if (env.kind === 'image') return { ...known, ...(env.image ? { image: env.image } : {}) };
  const good = await db
    .selectFrom('environment_build')
    .select('image')
    .where('environment_id', '=', id)
    .where('state', '=', 'done')
    .where('pruned', '=', 0)
    .orderBy('number', 'desc')
    .executeTakeFirst();
  return good?.image
    ? { ...known, image: good.image }
    : { ...known, why: `The environment ${env.name} has no successful build yet: build it first` };
}
