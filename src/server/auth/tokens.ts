// Personal access tokens: a person makes one for a program that acts as them (git, the VS Code
// extension, a script). It is shown once and kept as a hash; it stops working when it is
// revoked, when it reaches its end, and when its owner can no longer sign in.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import type { SessionUser } from './sessions';
import { UserError } from './users';

/** What every token starts with, so one is recognised in a header, a log or a leak scan. */
export const TOKEN_PREFIX = 'afs_';
/** A token lasts this long unless its maker says otherwise. */
export const TOKEN_DAYS = 90;
export const TOKEN_MAX_DAYS = 365;
/** How many tokens one person may have. */
export const TOKEN_LIMIT = 50;
/** How often "last used" is written, at most. */
const TOUCH_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type Db = Kysely<Schema>;
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

/** A token as its owner sees it afterwards: never the token itself. */
export interface TokenInfo {
  id: string;
  name: string;
  /** Its last four characters, to tell one from another. */
  hint: string;
  readOnly: boolean;
  /** The one workspace it may reach (its id); absent: all its owner may. */
  workspace?: string;
  /** AFS-24: an agent with it may decide approvals over MCP. */
  mcpApprovals: boolean;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
}

type Row = Schema['api_token'];
const infoOf = (row: Row): TokenInfo => ({
  id: row.id,
  name: row.name,
  hint: row.hint,
  readOnly: row.read_only === 1,
  ...(row.workspace_id ? { workspace: row.workspace_id } : {}),
  mcpApprovals: row.mcp_approve === 1,
  createdAt: row.created_at,
  ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
});

export interface NewToken {
  name: string;
  /** Days until it stops working; default `TOKEN_DAYS`. */
  days?: number;
  /** It may only read. */
  readOnly?: boolean;
  /** The one workspace it may reach (an id the caller has checked). */
  workspace?: string;
  /** AFS-24: an agent with it may decide approvals over MCP. Not with a read-only token. */
  mcpApprovals?: boolean;
}

/** Makes a token for a person. Resolves with the token (this once) and what is kept about it. */
export async function createToken(
  db: Db,
  userId: string,
  input: NewToken,
  now = new Date(),
): Promise<{ token: string; info: TokenInfo }> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 100)
    throw new UserError('invalid', 'A token has a name of 1 to 100 characters');
  const days = input.days ?? TOKEN_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > TOKEN_MAX_DAYS)
    throw new UserError('invalid', `A token lasts 1 to ${TOKEN_MAX_DAYS} days`);
  if (input.mcpApprovals && input.readOnly)
    throw new UserError('invalid', 'A read-only token cannot decide approvals');
  const count = await db
    .selectFrom('api_token')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  if (Number(count.n) >= TOKEN_LIMIT)
    throw new UserError('invalid', `A person has at most ${TOKEN_LIMIT} tokens: revoke one first`);
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const row: Row = {
    id: randomUUID(),
    user_id: userId,
    name,
    token_hash: hashOf(token),
    hint: token.slice(-4),
    read_only: input.readOnly ? 1 : 0,
    workspace_id: input.workspace ?? null,
    mcp_approve: input.mcpApprovals ? 1 : 0,
    created_at: now.toISOString(),
    last_used_at: null,
    expires_at: new Date(now.getTime() + days * DAY_MS).toISOString(),
  };
  await db.insertInto('api_token').values(row).execute();
  return { token, info: infoOf(row) };
}

export async function listTokens(db: Db, userId: string): Promise<TokenInfo[]> {
  const rows = await db
    .selectFrom('api_token')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();
  return rows.map(infoOf);
}

/** Revokes a person's token; false when they have no such token. */
export async function revokeToken(db: Db, userId: string, tokenId: string): Promise<boolean> {
  const done = await db
    .deleteFrom('api_token')
    .where('id', '=', tokenId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return Number(done.numDeletedRows) > 0;
}

/** True when the text has the shape of a token (whether or not it is one). */
export const looksLikeToken = (text: string) => /^afs_[A-Za-z0-9_-]{43}$/.test(text);

/**
 * The person a token acts as, when it is good: known, not past its end, and its owner able to
 * sign in. Using it is noted (at most once a minute).
 */
export async function tokenUser(
  db: Db,
  token: string,
  now = new Date(),
): Promise<SessionUser | undefined> {
  if (!looksLikeToken(token)) return undefined;
  const row = await db
    .selectFrom('api_token')
    .innerJoin('user_account', 'user_account.id', 'api_token.user_id')
    .select([
      'api_token.id as token_id',
      'api_token.read_only',
      'api_token.workspace_id',
      'api_token.mcp_approve',
      'api_token.expires_at',
      'api_token.last_used_at',
      'user_account.id',
      'user_account.login',
      'user_account.name',
      'user_account.is_admin',
      'user_account.disabled',
    ])
    .where('api_token.token_hash', '=', hashOf(token))
    .executeTakeFirst();
  if (!row || row.disabled === 1) return undefined;
  if (row.expires_at && Date.parse(row.expires_at) <= now.getTime()) return undefined;
  if (!row.last_used_at || now.getTime() - Date.parse(row.last_used_at) > TOUCH_MS)
    await db
      .updateTable('api_token')
      .set({ last_used_at: now.toISOString() })
      .where('id', '=', row.token_id)
      .execute();
  return {
    session: `token:${row.token_id}`,
    id: row.id,
    login: row.login,
    name: row.name,
    admin: row.is_admin === 1,
    token: {
      id: row.token_id,
      readOnly: row.read_only === 1,
      ...(row.workspace_id ? { workspace: row.workspace_id } : {}),
      ...(row.mcp_approve === 1 ? { mcpApprovals: true } : {}),
    },
  };
}

/**
 * The token a request's Authorization header carries: `Bearer <token>`, or HTTP Basic with the
 * token as the password (what git sends; the user name is not looked at).
 */
export function tokenOfHeader(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
  if (bearer) return bearer;
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(authorization)?.[1];
  if (!basic) return undefined;
  const text = Buffer.from(basic, 'base64').toString('utf8');
  const at = text.indexOf(':');
  return at < 0 ? undefined : text.slice(at + 1);
}

/** Removes the tokens that are past their end; resolves with how many. */
export async function sweepTokens(db: Db, now = new Date()): Promise<number> {
  const done = await db
    .deleteFrom('api_token')
    .where('expires_at', '<=', now.toISOString())
    .executeTakeFirst();
  return Number(done.numDeletedRows);
}
