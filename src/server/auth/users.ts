// People and groups, as rows. The rules about them that the database cannot keep are here: a
// login is lower case, the last administrator stays one, a password hash never leaves this file
// except to be checked.
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { hashPassword } from './passwords';

/** A person as the API gives them: no password hash. */
export interface User {
  id: string;
  login: string;
  name: string;
  email?: string;
  webhookUrl?: string;
  admin: boolean;
  disabled: boolean;
  createdAt: string;
  lastLoginAt?: string;
  /** The names of the groups they are in. */
  groups: string[];
}

export interface Group {
  id: string;
  name: string;
  email?: string;
  webhookUrl?: string;
  /** The logins of its members. */
  members: string[];
}

/** A change that the rules do not allow; `code` names it for the API. */
export class UserError extends Error {
  constructor(
    readonly code: 'taken' | 'not_found' | 'last_admin' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

const now = () => new Date().toISOString();

/** Logins are compared in lower case: `Dana` and `dana` are one person. */
export const normalLogin = (login: string) => login.trim().toLowerCase();

/** Letters, digits, dot, dash, underscore and @: a name, or an email address, as a login. */
export function loginProblem(login: string): string | undefined {
  return /^[a-z0-9][a-z0-9._@-]{1,63}$/.test(normalLogin(login))
    ? undefined
    : 'A login is 2 to 64 letters, digits, dots, dashes, underscores or @, and starts with a letter or digit';
}

export function contactProblem(c: { email?: string | null; webhookUrl?: string | null }) {
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) return 'The email address is not one';
  if (c.webhookUrl) {
    try {
      const u = new URL(c.webhookUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
    } catch {
      return 'The webhook address is not an http or https URL';
    }
  }
  return undefined;
}

type Db = Kysely<Schema>;

async function groupsOf(db: Db, userIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (userIds.length === 0) return out;
  const rows = await db
    .selectFrom('group_member')
    .innerJoin('user_group', 'user_group.id', 'group_member.group_id')
    .select(['group_member.user_id', 'user_group.name'])
    .where('group_member.user_id', 'in', userIds)
    .orderBy('user_group.name')
    .execute();
  for (const row of rows) out.set(row.user_id, [...(out.get(row.user_id) ?? []), row.name]);
  return out;
}

type UserRow = Schema['user_account'];
const userOf = (row: UserRow, groups: string[]): User => ({
  id: row.id,
  login: row.login,
  name: row.name,
  ...(row.email ? { email: row.email } : {}),
  ...(row.webhook_url ? { webhookUrl: row.webhook_url } : {}),
  admin: row.is_admin === 1,
  disabled: row.disabled === 1,
  createdAt: row.created_at,
  ...(row.last_login_at ? { lastLoginAt: row.last_login_at } : {}),
  groups,
});

export async function listUsers(db: Db): Promise<User[]> {
  const rows = await db.selectFrom('user_account').selectAll().orderBy('login').execute();
  const groups = await groupsOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => userOf(row, groups.get(row.id) ?? []));
}

export async function getUser(db: Db, id: string): Promise<User | undefined> {
  const row = await db
    .selectFrom('user_account')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? userOf(row, (await groupsOf(db, [row.id])).get(row.id) ?? []) : undefined;
}

/** For sign-in only: the account with its password hash. */
export async function accountByLogin(db: Db, login: string): Promise<UserRow | undefined> {
  return db
    .selectFrom('user_account')
    .selectAll()
    .where('login', '=', normalLogin(login))
    .executeTakeFirst();
}

export async function countUsers(db: Db): Promise<number> {
  const row = await db
    .selectFrom('user_account')
    .select((eb) => eb.fn.countAll().as('n'))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export interface NewUser {
  login: string;
  name: string;
  password?: string;
  email?: string;
  webhookUrl?: string;
  admin?: boolean;
}

export async function createUser(db: Db, input: NewUser): Promise<User> {
  const login = normalLogin(input.login);
  const problem = loginProblem(login) ?? contactProblem(input);
  if (problem) throw new UserError('invalid', problem);
  const at = now();
  const row: UserRow = {
    id: randomUUID(),
    login,
    name: input.name.trim() || login,
    email: input.email?.trim() || null,
    webhook_url: input.webhookUrl?.trim() || null,
    password_hash: input.password ? await hashPassword(input.password) : null,
    is_admin: input.admin ? 1 : 0,
    disabled: 0,
    created_at: at,
    updated_at: at,
    last_login_at: null,
  };
  // The unique login decides: of two people adding the same login at once, one is told.
  const done = await db
    .insertInto('user_account')
    .values(row)
    .onConflict((c) => c.column('login').doNothing())
    .executeTakeFirst();
  if (!done.numInsertedOrUpdatedRows) throw new UserError('taken', `The login ${login} is taken`);
  return userOf(row, []);
}

async function otherAdmins(db: Db, id: string): Promise<number> {
  const row = await db
    .selectFrom('user_account')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('is_admin', '=', 1)
    .where('disabled', '=', 0)
    .where('id', '!=', id)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export interface UserChange {
  name?: string;
  email?: string | null;
  webhookUrl?: string | null;
  admin?: boolean;
  disabled?: boolean;
}

/** Changes a person. The last administrator who can sign in stays one. */
export async function updateUser(db: Db, id: string, change: UserChange): Promise<User> {
  const problem = contactProblem(change);
  if (problem) throw new UserError('invalid', problem);
  return db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('user_account')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!before) throw new UserError('not_found', 'No such user');
    const losesAdmin =
      before.is_admin === 1 &&
      before.disabled === 0 &&
      (change.admin === false || change.disabled === true);
    if (losesAdmin && (await otherAdmins(trx, id)) === 0)
      throw new UserError('last_admin', 'This is the only administrator: make another one first');
    await trx
      .updateTable('user_account')
      .set({
        ...(change.name !== undefined ? { name: change.name.trim() || before.login } : {}),
        ...(change.email !== undefined ? { email: change.email?.trim() || null } : {}),
        ...(change.webhookUrl !== undefined
          ? { webhook_url: change.webhookUrl?.trim() || null }
          : {}),
        ...(change.admin !== undefined ? { is_admin: change.admin ? 1 : 0 } : {}),
        ...(change.disabled !== undefined ? { disabled: change.disabled ? 1 : 0 } : {}),
        updated_at: now(),
      })
      .where('id', '=', id)
      .execute();
    // Someone who may no longer sign in is signed out everywhere.
    if (change.disabled) await trx.deleteFrom('session').where('user_id', '=', id).execute();
    const after = await getUser(trx, id);
    if (!after) throw new UserError('not_found', 'No such user');
    return after;
  });
}

export async function deleteUser(db: Db, id: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('user_account')
      .select(['is_admin', 'disabled'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!before) throw new UserError('not_found', 'No such user');
    if (before.is_admin === 1 && before.disabled === 0 && (await otherAdmins(trx, id)) === 0)
      throw new UserError('last_admin', 'This is the only administrator: make another one first');
    // Named here as well as in the schema: SQLite keeps its word only with foreign keys on.
    await trx.deleteFrom('session').where('user_id', '=', id).execute();
    await trx.deleteFrom('group_member').where('user_id', '=', id).execute();
    await trx.deleteFrom('user_account').where('id', '=', id).execute();
  });
}

/** Sets a password and ends the person's sessions, except `keepSession` (the one asking). */
export async function setPassword(
  db: Db,
  id: string,
  password: string,
  keepSession?: string,
): Promise<void> {
  const hash = await hashPassword(password);
  await db.transaction().execute(async (trx) => {
    const done = await trx
      .updateTable('user_account')
      .set({ password_hash: hash, updated_at: now() })
      .where('id', '=', id)
      .executeTakeFirst();
    if (!done.numUpdatedRows) throw new UserError('not_found', 'No such user');
    let sessions = trx.deleteFrom('session').where('user_id', '=', id);
    if (keepSession) sessions = sessions.where('id', '!=', keepSession);
    await sessions.execute();
  });
}

// --- groups

type GroupRow = Schema['user_group'];

async function membersOf(db: Db, groupIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (groupIds.length === 0) return out;
  const rows = await db
    .selectFrom('group_member')
    .innerJoin('user_account', 'user_account.id', 'group_member.user_id')
    .select(['group_member.group_id', 'user_account.login'])
    .where('group_member.group_id', 'in', groupIds)
    .orderBy('user_account.login')
    .execute();
  for (const row of rows) out.set(row.group_id, [...(out.get(row.group_id) ?? []), row.login]);
  return out;
}

const groupOf = (row: GroupRow, members: string[]): Group => ({
  id: row.id,
  name: row.name,
  ...(row.email ? { email: row.email } : {}),
  ...(row.webhook_url ? { webhookUrl: row.webhook_url } : {}),
  members,
});

export async function listGroups(db: Db): Promise<Group[]> {
  const rows = await db.selectFrom('user_group').selectAll().orderBy('name').execute();
  const members = await membersOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => groupOf(row, members.get(row.id) ?? []));
}

export async function getGroup(db: Db, id: string): Promise<Group | undefined> {
  const row = await db.selectFrom('user_group').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? groupOf(row, (await membersOf(db, [row.id])).get(row.id) ?? []) : undefined;
}

export function groupNameProblem(name: string): string | undefined {
  return /^[^\s].{0,62}[^\s]$|^\S$/.test(name) ? undefined : 'A group name is 1 to 64 characters';
}

export async function createGroup(
  db: Db,
  input: { name: string; email?: string; webhookUrl?: string },
): Promise<Group> {
  const name = input.name.trim();
  const problem = groupNameProblem(name) ?? contactProblem(input);
  if (problem) throw new UserError('invalid', problem);
  const at = now();
  const row: GroupRow = {
    id: randomUUID(),
    name,
    email: input.email?.trim() || null,
    webhook_url: input.webhookUrl?.trim() || null,
    created_at: at,
    updated_at: at,
  };
  const done = await db
    .insertInto('user_group')
    .values(row)
    .onConflict((c) => c.column('name').doNothing())
    .executeTakeFirst();
  if (!done.numInsertedOrUpdatedRows)
    throw new UserError('taken', `There is a group ${name} already`);
  return groupOf(row, []);
}

export async function updateGroup(
  db: Db,
  id: string,
  change: { name?: string; email?: string | null; webhookUrl?: string | null },
): Promise<Group> {
  const problem =
    (change.name !== undefined ? groupNameProblem(change.name.trim()) : undefined) ??
    contactProblem(change);
  if (problem) throw new UserError('invalid', problem);
  return db.transaction().execute(async (trx) => {
    if (change.name !== undefined) {
      const clash = await trx
        .selectFrom('user_group')
        .select('id')
        .where('name', '=', change.name.trim())
        .where('id', '!=', id)
        .executeTakeFirst();
      if (clash) throw new UserError('taken', `There is a group ${change.name.trim()} already`);
    }
    const done = await trx
      .updateTable('user_group')
      .set({
        ...(change.name !== undefined ? { name: change.name.trim() } : {}),
        ...(change.email !== undefined ? { email: change.email?.trim() || null } : {}),
        ...(change.webhookUrl !== undefined
          ? { webhook_url: change.webhookUrl?.trim() || null }
          : {}),
        updated_at: now(),
      })
      .where('id', '=', id)
      .executeTakeFirst();
    if (!done.numUpdatedRows) throw new UserError('not_found', 'No such group');
    const after = await getGroup(trx, id);
    if (!after) throw new UserError('not_found', 'No such group');
    return after;
  });
}

export async function deleteGroup(db: Db, id: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('group_member').where('group_id', '=', id).execute();
    const done = await trx.deleteFrom('user_group').where('id', '=', id).executeTakeFirst();
    if (!done.numDeletedRows) throw new UserError('not_found', 'No such group');
  });
}

/** Makes the group's members exactly these people (by id). */
export async function setMembers(db: Db, groupId: string, userIds: string[]): Promise<Group> {
  return db.transaction().execute(async (trx) => {
    if (!(await getGroup(trx, groupId))) throw new UserError('not_found', 'No such group');
    const ids = [...new Set(userIds)];
    if (ids.length) {
      const known = await trx
        .selectFrom('user_account')
        .select('id')
        .where('id', 'in', ids)
        .execute();
      if (known.length !== ids.length)
        throw new UserError('invalid', 'One of the users does not exist');
    }
    await trx.deleteFrom('group_member').where('group_id', '=', groupId).execute();
    if (ids.length)
      await trx
        .insertInto('group_member')
        .values(ids.map((user_id) => ({ group_id: groupId, user_id })))
        .execute();
    const after = await getGroup(trx, groupId);
    if (!after) throw new UserError('not_found', 'No such group');
    return after;
  });
}
