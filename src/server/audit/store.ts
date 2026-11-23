// The audit log: who did what, to what, when, from where, and how it ended. Entries are only
// added; the one thing that removes them is the keeping period (AFS_AUDIT_KEEP_DAYS). An entry
// never holds a secret value: what a request sent is named by its fields, not their values.
import { randomUUID } from 'node:crypto';
import { type Kysely, sql } from 'kysely';
import type { AuditEntryTable, Schema } from '../db/schema';
import { enqueueDeliveries } from '../stream/store';

export const SOURCES = ['ui', 'api', 'mcp', 'git', 'cli', 'server'] as const;
export type AuditSource = (typeof SOURCES)[number];
export const RESULTS = ['ok', 'refused', 'failed'] as const;
export type AuditResult = (typeof RESULTS)[number];

export interface AuditEntry {
  id: string;
  at: string;
  /** Who; null when nobody was signed in (a refused sign-in names the login tried in `detail`). */
  actor: { id: string | null; login: string } | null;
  /** The personal access token the request came with. */
  token?: string;
  source: AuditSource;
  /** What, as `<object>.<verb>`: `run.launch`, `user.change`, `session.sign-in`. */
  action: string;
  object: { type: string; id?: string; name?: string };
  result: AuditResult;
  /** The HTTP status of the answer. */
  status?: number;
  ip?: string;
  /** The request's id, as on the server's log lines. */
  request?: string;
  detail?: Record<string, unknown>;
}

export type NewEntry = Omit<AuditEntry, 'id' | 'at'> & { at?: string };

export async function recordAudit(db: Kysely<Schema>, entry: NewEntry): Promise<AuditEntry> {
  const row: AuditEntryTable = {
    id: randomUUID(),
    at: entry.at ?? new Date().toISOString(),
    actor_id: entry.actor?.id ?? null,
    actor_login: entry.actor?.login ?? null,
    token_id: entry.token ?? null,
    source: entry.source,
    action: entry.action,
    object_type: entry.object.type,
    object_id: entry.object.id ?? null,
    object_name: entry.object.name ?? null,
    result: entry.result,
    status: entry.status ?? null,
    ip: entry.ip ?? null,
    request_id: entry.request ?? null,
    detail_json:
      entry.detail && Object.keys(entry.detail).length ? JSON.stringify(entry.detail) : null,
  };
  await db.insertInto('audit_entry').values(row).execute();
  // AFS-53: and to the event streams, from here, the one place entries are written. A stream
  // that cannot take it never fails what was done: the entry is in the log.
  await enqueueDeliveries(db, 'audit', row.id).then(
    () => auditStream.recorded?.(),
    (e: unknown) => auditStream.failed?.(e),
  );
  return entryOf(row);
}

/** AFS-53: the streamer is woken when an entry is written, and told when its row was not. */
export const auditStream: { recorded?: () => void; failed?: (e: unknown) => void } = {};

/** The entries with these ids (AFS-53: what a stream sends), in no order. */
export async function auditEntries(db: Kysely<Schema>, ids: string[]): Promise<AuditEntry[]> {
  const found: AuditEntry[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db
      .selectFrom('audit_entry')
      .selectAll()
      .where('id', 'in', ids.slice(i, i + 500))
      .execute();
    found.push(...rows.map(entryOf));
  }
  return found;
}

const entryOf = (row: AuditEntryTable): AuditEntry => ({
  id: row.id,
  at: row.at,
  actor: row.actor_login ? { id: row.actor_id, login: row.actor_login } : null,
  ...(row.token_id ? { token: row.token_id } : {}),
  source: row.source as AuditSource,
  action: row.action,
  object: {
    type: row.object_type,
    ...(row.object_id ? { id: row.object_id } : {}),
    ...(row.object_name ? { name: row.object_name } : {}),
  },
  result: row.result as AuditResult,
  ...(row.status !== null ? { status: Number(row.status) } : {}),
  ...(row.ip ? { ip: row.ip } : {}),
  ...(row.request_id ? { request: row.request_id } : {}),
  ...(row.detail_json ? { detail: JSON.parse(row.detail_json) } : {}),
});

export interface AuditFilter {
  /**
   * Who did it: part of their login or name, any case (AFS-153); a refused sign-in by the login
   * tried.
   */
  actor?: string;
  /** An action, or its object part: `run` finds `run.launch`, `run.stop`, ... */
  action?: string;
  objectType?: string;
  objectId?: string;
  result?: AuditResult;
  source?: AuditSource;
  /** From this time on (ISO). */
  from?: string;
  /** Before this time (ISO). */
  to?: string;
  /** The entries older than this one: the `next` of a page before. */
  before?: string;
  limit?: number;
}

/** A page of entries, the newest first, and the cursor of the page after it. */
export async function listAudit(
  db: Kysely<Schema>,
  filter: AuditFilter = {},
): Promise<{ entries: AuditEntry[]; next?: string }> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 50_000);
  let query = db.selectFrom('audit_entry').selectAll();
  if (filter.actor?.trim()) {
    // The typed text as itself: LIKE's own characters escaped with "!".
    const typed = filter.actor
      .trim()
      .toLowerCase()
      .replace(/[!%_]/g, (c) => `!${c}`);
    const like = (column: string, pattern: string) =>
      sql<boolean>`lower(${sql.ref(column)}) like ${pattern} escape '!'`;
    query = query.where((eb) =>
      eb.or([
        like('actor_login', `%${typed}%`),
        eb(
          'actor_id',
          'in',
          eb
            .selectFrom('user_account')
            .select('id')
            .where(like('name', `%${typed}%`)),
        ),
        // A refused sign-in has nobody; the login tried is in its detail.
        eb.and([eb('actor_login', 'is', null), like('detail_json', `%"login":"%${typed}%`)]),
      ]),
    );
  }
  if (filter.action)
    query = filter.action.includes('.')
      ? query.where('action', '=', filter.action)
      : query.where('action', 'like', `${filter.action}.%`);
  if (filter.objectType) query = query.where('object_type', '=', filter.objectType);
  if (filter.objectId) query = query.where('object_id', '=', filter.objectId);
  if (filter.result) query = query.where('result', '=', filter.result);
  if (filter.source) query = query.where('source', '=', filter.source);
  if (filter.from) query = query.where('at', '>=', filter.from);
  if (filter.to) query = query.where('at', '<', filter.to);
  // Entries of one millisecond are told apart by their id: the cursor is both.
  const cursor = filter.before ? cursorOf(filter.before) : undefined;
  if (cursor)
    query = query.where((eb) =>
      eb.or([
        eb('at', '<', cursor.at),
        eb.and([eb('at', '=', cursor.at), eb('id', '<', cursor.id)]),
      ]),
    );
  const rows = await query
    .orderBy('at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .execute();
  const entries = rows.slice(0, limit).map(entryOf);
  const last = entries.at(-1);
  return rows.length > limit && last ? { entries, next: `${last.at}_${last.id}` } : { entries };
}

const cursorOf = (text: string): { at: string; id: string } | undefined => {
  const at = text.indexOf('_');
  return at > 0 ? { at: text.slice(0, at), id: text.slice(at + 1) } : undefined;
};

/** Removes entries older than `days` (0: keeps them all). Resolves with how many went. */
export async function pruneAudit(db: Kysely<Schema>, days: number, now = new Date()) {
  if (days <= 0) return 0;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const gone = await db.deleteFrom('audit_entry').where('at', '<', cutoff).executeTakeFirst();
  return Number(gone.numDeletedRows);
}

const COLUMNS = [
  'at',
  'actor',
  'token',
  'source',
  'action',
  'object_type',
  'object_id',
  'object_name',
  'result',
  'status',
  'ip',
  'request',
  'detail',
] as const;

/**
 * Entries as CSV. A value that a spreadsheet would take for a formula (= + - @ at its start)
 * is given a leading quote mark, so that opening the file runs nothing.
 */
export function auditCsv(entries: AuditEntry[]): string {
  const cell = (value: unknown): string => {
    let text = value === undefined || value === null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = entries.map((e) =>
    [
      e.at,
      e.actor?.login,
      e.token,
      e.source,
      e.action,
      e.object.type,
      e.object.id,
      e.object.name,
      e.result,
      e.status,
      e.ip,
      e.request,
      e.detail ? JSON.stringify(e.detail) : '',
    ]
      .map(cell)
      .join(','),
  );
  return `${[COLUMNS.join(','), ...lines].join('\r\n')}\r\n`;
}
