// The first administrator. A new server has no users, so nobody can sign in to make one. Whoever
// reaches the server first must not become its administrator just by asking: the server writes a
// setup code to its log at start, and the first administrator is made by someone who can read it.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { getSetting, setSetting } from '../db/settings';
import { passwordProblem } from './passwords';
import { countUsers, createUser, type NewUser, type User, UserError } from './users';

const SETTING = 'setup.code';
const hashOf = (code: string) => createHash('sha256').update(code).digest('hex');

/**
 * While the server has no user: makes a new setup code, keeps its hash, and resolves with the
 * code for the log. Undefined once a user exists. A new code at every start: an old log line is
 * of no use to anyone.
 */
export async function setupCode(db: Kysely<Schema>): Promise<string | undefined> {
  if ((await countUsers(db)) > 0) return undefined;
  const code = randomBytes(9).toString('base64url');
  await setSetting(db, SETTING, hashOf(code));
  return code;
}

export async function setupNeeded(db: Kysely<Schema>): Promise<boolean> {
  return (await countUsers(db)) === 0;
}

/**
 * Makes the first administrator. Refused when the server already has a user, when the code is
 * not the one in the log, or when the password is not acceptable.
 */
export async function createFirstAdmin(
  db: Kysely<Schema>,
  code: string,
  input: Omit<NewUser, 'admin'> & { password: string },
): Promise<User> {
  if (!(await setupNeeded(db)))
    throw new UserError('invalid', 'The server is set up already: sign in');
  const expected = await getSetting(db, SETTING);
  const given = Buffer.from(hashOf(code));
  if (!expected || !timingSafeEqual(given, Buffer.from(expected)))
    throw new UserError('invalid', 'The setup code is not the one in the server log');
  const problem = passwordProblem(input.password, input.login);
  if (problem) throw new UserError('invalid', problem);
  const user = await createUser(db, { ...input, admin: true });
  // Two people with the code at once: both accounts would exist. The later one is taken back.
  const first = await db
    .selectFrom('user_account')
    .select('id')
    .orderBy('created_at')
    .orderBy('id')
    .executeTakeFirstOrThrow();
  if (first.id !== user.id) {
    await db.deleteFrom('user_account').where('id', '=', user.id).execute();
    throw new UserError('invalid', 'The server is set up already: sign in');
  }
  // The code has done its work.
  await setSetting(db, SETTING, '');
  return user;
}
