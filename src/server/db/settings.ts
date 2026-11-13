// What the server remembers about itself between starts.
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Schema } from './schema';

export async function getSetting(db: Kysely<Schema>, name: string): Promise<string | undefined> {
  const row = await db
    .selectFrom('setting')
    .select('value')
    .where('name', '=', name)
    .executeTakeFirst();
  return row?.value;
}

export async function setSetting(db: Kysely<Schema>, name: string, value: string): Promise<void> {
  const updated_at = new Date().toISOString();
  await db
    .insertInto('setting')
    .values({ name, value, updated_at })
    .onConflict((conflict) => conflict.column('name').doUpdateSet({ value, updated_at }))
    .execute();
}

/**
 * This installation's id: made at the first start and the same from then on. It tells one
 * server's data from another's (a restored backup, two servers pointed at one database).
 */
export async function instanceId(db: Kysely<Schema>): Promise<string> {
  // Two servers starting at once on a new database: the first insert stays, both read it.
  await db
    .insertInto('setting')
    .values({ name: 'instance.id', value: randomUUID(), updated_at: new Date().toISOString() })
    .onConflict((conflict) => conflict.column('name').doNothing())
    .execute();
  const id = await getSetting(db, 'instance.id');
  if (!id) throw new Error('The database did not keep the installation id');
  return id;
}
