// Sessions: who is signed in. The browser holds a random token in a cookie; the database holds
// only its hash, so reading the table gives nobody a session.
import { createHash, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';

/** The cookie's name. */
export const SESSION_COOKIE = 'afs_session';
/** A session ends this long after it was last used. */
export const IDLE_MS = 8 * 60 * 60 * 1000;
/** A session ends this long after sign-in, used or not. */
export const MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** How often "last used" is written, at most: not on every request. */
const TOUCH_MS = 60 * 1000;

type Db = Kysely<Schema>;

/** What the database knows a token by. */
export const sessionId = (token: string) => createHash('sha256').update(token).digest('hex');

export interface SessionUser {
  /** The session's id (the token's hash), to tell this session from the person's others. */
  session: string;
  id: string;
  login: string;
  name: string;
  admin: boolean;
  /** Set when the request is signed in with a personal access token, not a session. */
  token?: { id: string; readOnly: boolean; workspace?: string };
}

/** Starts a session; resolves with the token for the cookie. */
export async function startSession(
  db: Db,
  userId: string,
  from: { ip?: string; userAgent?: string },
  now = new Date(),
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const at = now.toISOString();
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('session')
      .values({
        id: sessionId(token),
        user_id: userId,
        created_at: at,
        last_seen_at: at,
        expires_at: new Date(now.getTime() + MAX_MS).toISOString(),
        ip: from.ip ?? null,
        user_agent: from.userAgent?.slice(0, 200) ?? null,
      })
      .execute();
    await trx
      .updateTable('user_account')
      .set({ last_login_at: at })
      .where('id', '=', userId)
      .execute();
  });
  return token;
}

/**
 * The person a token belongs to, when its session is still good: not past its end, used within
 * the idle time, and the account not disabled. Using it keeps it alive.
 */
export async function sessionUser(
  db: Db,
  token: string,
  now = new Date(),
): Promise<SessionUser | undefined> {
  const id = sessionId(token);
  const row = await db
    .selectFrom('session')
    .innerJoin('user_account', 'user_account.id', 'session.user_id')
    .select([
      'session.last_seen_at',
      'session.expires_at',
      'user_account.id',
      'user_account.login',
      'user_account.name',
      'user_account.is_admin',
      'user_account.disabled',
    ])
    .where('session.id', '=', id)
    .executeTakeFirst();
  if (!row) return undefined;
  const at = now.getTime();
  const ended =
    row.disabled === 1 ||
    Date.parse(row.expires_at) <= at ||
    at - Date.parse(row.last_seen_at) > IDLE_MS;
  if (ended) {
    await db.deleteFrom('session').where('id', '=', id).execute();
    return undefined;
  }
  if (at - Date.parse(row.last_seen_at) > TOUCH_MS)
    await db
      .updateTable('session')
      .set({ last_seen_at: now.toISOString() })
      .where('id', '=', id)
      .execute();
  return { session: id, id: row.id, login: row.login, name: row.name, admin: row.is_admin === 1 };
}

export async function endSession(db: Db, token: string): Promise<void> {
  await db.deleteFrom('session').where('id', '=', sessionId(token)).execute();
}

/** Removes the sessions that have ended; resolves with how many. */
export async function sweepSessions(db: Db, now = new Date()): Promise<number> {
  const done = await db
    .deleteFrom('session')
    .where((eb) =>
      eb.or([
        eb('expires_at', '<=', now.toISOString()),
        eb('last_seen_at', '<', new Date(now.getTime() - IDLE_MS).toISOString()),
      ]),
    )
    .executeTakeFirst();
  return Number(done.numDeletedRows);
}

/** The token of a request's session cookie, if it has one. */
export function tokenOf(cookieHeader: string | undefined): string | undefined {
  for (const part of (cookieHeader ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === SESSION_COOKIE) {
      const value = part.slice(at + 1).trim();
      return /^[A-Za-z0-9_-]{20,100}$/.test(value) ? value : undefined;
    }
  }
  return undefined;
}

/**
 * The Set-Cookie value for a session. Not readable by scripts, sent only to this server, and not
 * on requests other sites make for the user (SameSite=Lax). `secure`: only over HTTPS.
 */
export function sessionCookie(token: string | undefined, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${token ?? ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    token ? `Max-Age=${Math.floor(MAX_MS / 1000)}` : 'Max-Age=0',
  ].join('; ');
}
