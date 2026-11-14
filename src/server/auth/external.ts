// People who sign in through something else (AFS-30 OIDC providers, AFS-31 LDAP directories):
// how an account is made for them, and how their groups and administrator right follow what
// that source says. Each membership and right carries its source; a source takes back only what
// it gave, never what an administrator set here by hand.
import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import type { Schema } from '../db/schema';
import { loginProblem, normalLogin } from './users';

type Trx = Transaction<Schema> | Kysely<Schema>;

export class ExternalError extends Error {}

/** A login made from what a source calls the person: lower case, characters a login may have. */
export function loginFrom(wanted: string): string {
  const cleaned = normalLogin(wanted)
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '')
    .slice(0, 48);
  return cleaned || 'user';
}

/** Makes an account without a password; a taken login gets -2, -3... Resolves with its id. */
export async function makeAccount(
  trx: Trx,
  person: { login: string; name?: string; email?: string },
): Promise<{ userId: string; login: string }> {
  const at = new Date().toISOString();
  const wanted = loginFrom(person.login);
  const userId = randomUUID();
  let login = wanted;
  for (let n = 2; ; n++) {
    if (loginProblem(login)) login = `user-${userId.slice(0, 8)}`;
    const done = await trx
      .insertInto('user_account')
      .values({
        id: userId,
        login,
        name: person.name || login,
        email: person.email ?? null,
        webhook_url: null,
        password_hash: null,
        is_admin: 0,
        disabled: 0,
        service: 0,
        created_at: at,
        updated_at: at,
        last_login_at: at,
        admin_source: null,
        disabled_source: null,
      })
      .onConflict((c) => c.column('login').doNothing())
      .executeTakeFirst();
    if (done.numInsertedOrUpdatedRows) return { userId, login };
    if (n > 99) throw new ExternalError('No free login for this person: ask an administrator');
    login = `${wanted.slice(0, 44)}-${n}`;
  }
}

/**
 * Sets the groups `source` gives and its administrator right: adds what it says now, takes back
 * what it gave before and no longer says. Memberships and rights from elsewhere stay.
 */
export async function applySource(
  trx: Trx,
  userId: string,
  source: string,
  groups: Set<string>,
  admin: boolean,
): Promise<void> {
  const mine = await trx
    .selectFrom('group_member')
    .select(['group_id', 'source'])
    .where('user_id', '=', userId)
    .execute();
  for (const m of mine)
    if (m.source === source && !groups.has(m.group_id))
      await trx
        .deleteFrom('group_member')
        .where('user_id', '=', userId)
        .where('group_id', '=', m.group_id)
        .execute();
  const have = new Set(mine.map((m) => m.group_id));
  for (const g of groups)
    if (!have.has(g))
      await trx
        .insertInto('group_member')
        .values({ group_id: g, user_id: userId, source })
        .execute();
  const account = await trx
    .selectFrom('user_account')
    .select(['is_admin', 'admin_source'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  if (admin && !account.is_admin)
    await trx
      .updateTable('user_account')
      .set({ is_admin: 1, admin_source: source })
      .where('id', '=', userId)
      .execute();
  else if (!admin && account.is_admin && account.admin_source === source)
    await trx
      .updateTable('user_account')
      .set({ is_admin: 0, admin_source: null })
      .where('id', '=', userId)
      .execute();
}

/** Takes back everything a source gave (it is removed): memberships and administrator rights. */
export async function forgetSource(trx: Trx, source: string): Promise<void> {
  await trx.deleteFrom('group_member').where('source', '=', source).execute();
  await trx
    .updateTable('user_account')
    .set({ is_admin: 0, admin_source: null })
    .where('admin_source', '=', source)
    .execute();
  await trx
    .updateTable('user_account')
    .set({ disabled: 0, disabled_source: null })
    .where('disabled_source', '=', source)
    .execute();
}
