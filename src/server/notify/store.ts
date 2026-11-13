// The notifications waiting to go out, and those that went (or were given up on): an outbox in the
// database (AFS-29). A message is written here first and sent after, so a server that stops does
// not lose it, and two servers on one database do not both send it: a server takes a message by
// moving its next try into the future, and only the one whose move took sends it.
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import type { Message } from './channels';
import type { ChannelKind, Delivery, DeliveryStatus, EventKind } from './types';

type Db = Kysely<Schema>;
type Row = Schema['notification'];

/** How long after each failed try the next one is: then it is given up on. */
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
/** A message being sent is that server's for this long. */
const TAKEN_MS = 2 * 60_000;

/** A webhook's address as the log shows it: scheme and host; its path can be its secret. */
export function shownTarget(channel: string, target: string): string {
  if (channel !== 'webhook') return target;
  try {
    const u = new URL(target);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return 'a webhook';
  }
}

const deliveryOf = (row: Row): Delivery => {
  const message = JSON.parse(row.message_json) as Message;
  return {
    id: row.id,
    event: row.event as EventKind,
    channel: row.channel as ChannelKind,
    recipient: row.recipient,
    target: shownTarget(row.channel, row.target),
    subject: message.subject,
    ...(row.run_id ? { run: row.run_id } : {}),
    status: row.status as DeliveryStatus,
    attempts: row.attempts,
    ...(row.status === 'pending' ? { nextAt: row.next_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    ...(row.sent_at ? { sentAt: row.sent_at } : {}),
  };
};

export interface Outgoing {
  channel: ChannelKind;
  recipient: string;
  target: string;
}

/**
 * Writes one event's messages, one per place. With `dedupe`, an event already written under that
 * key is not written again (a certificate's warning after a restart): resolves with the ids of
 * those that were.
 */
export async function enqueue(
  db: Db,
  event: { kind: EventKind; message: Message; run?: string; dedupe?: string },
  to: Outgoing[],
  now = new Date(),
): Promise<string[]> {
  const eventId = randomUUID();
  const written: string[] = [];
  for (const place of to) {
    const id = randomUUID();
    const done = await db
      .insertInto('notification')
      .values({
        id,
        event_id: eventId,
        event: event.kind,
        channel: place.channel,
        recipient: place.recipient,
        target: place.target,
        message_json: JSON.stringify(event.message),
        run_id: event.run ?? null,
        dedupe: event.dedupe ? `${event.dedupe}|${place.channel}|${place.target}` : null,
        status: 'pending',
        attempts: 0,
        next_at: now.toISOString(),
        last_error: null,
        created_at: now.toISOString(),
        sent_at: null,
      })
      .onConflict((c) => c.column('dedupe').doNothing())
      .executeTakeFirst();
    if (Number(done.numInsertedOrUpdatedRows ?? 0) > 0) written.push(id);
  }
  return written;
}

export async function getDelivery(db: Db, id: string): Promise<Delivery | undefined> {
  const row = await db
    .selectFrom('notification')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? deliveryOf(row) : undefined;
}

export interface Taken {
  id: string;
  event: string;
  channel: ChannelKind;
  target: string;
  message: Message;
  attempts: number;
}

/** Messages due now, taken by this server: no other sends them while it does. */
export async function takeDue(db: Db, limit = 20, now = new Date()): Promise<Taken[]> {
  const rows = await db
    .selectFrom('notification')
    .selectAll()
    .where('status', '=', 'pending')
    .where('next_at', '<=', now.toISOString())
    .orderBy('next_at')
    .limit(limit)
    .execute();
  const taken: Taken[] = [];
  for (const row of rows) {
    const done = await db
      .updateTable('notification')
      .set({
        next_at: new Date(now.getTime() + TAKEN_MS).toISOString(),
        attempts: row.attempts + 1,
      })
      .where('id', '=', row.id)
      .where('status', '=', 'pending')
      .where('next_at', '=', row.next_at)
      .executeTakeFirst();
    if (Number(done.numUpdatedRows) > 0)
      taken.push({
        id: row.id,
        event: row.event,
        channel: row.channel as ChannelKind,
        target: row.target,
        message: JSON.parse(row.message_json) as Message,
        attempts: row.attempts + 1,
      });
  }
  return taken;
}

export async function markSent(db: Db, id: string, now = new Date()): Promise<void> {
  await db
    .updateTable('notification')
    .set({ status: 'sent', sent_at: now.toISOString(), last_error: null })
    .where('id', '=', id)
    .execute();
}

/** A try failed: again later while that can help and tries are left, else given up on. */
export async function markFailed(
  db: Db,
  taken: { id: string; attempts: number },
  error: string,
  retry: boolean,
  now = new Date(),
): Promise<'retry' | 'failed'> {
  const again = retry && taken.attempts < MAX_ATTEMPTS;
  const wait = BACKOFF_MS[Math.min(taken.attempts - 1, BACKOFF_MS.length - 1)] ?? 0;
  await db
    .updateTable('notification')
    .set({
      status: again ? 'pending' : 'failed',
      next_at: new Date(now.getTime() + (again ? wait : 0)).toISOString(),
      last_error: error.slice(0, 500),
    })
    .where('id', '=', taken.id)
    .execute();
  return again ? 'retry' : 'failed';
}

/** A message given up on is tried again now (with a fresh count of tries). */
export async function retryNow(db: Db, id: string, now = new Date()): Promise<boolean> {
  const done = await db
    .updateTable('notification')
    .set({ status: 'pending', attempts: 0, next_at: now.toISOString() })
    .where('id', '=', id)
    .where('status', '=', 'failed')
    .executeTakeFirst();
  return Number(done.numUpdatedRows) > 0;
}

export interface DeliveryFilter {
  status?: DeliveryStatus;
  event?: EventKind;
  run?: string;
  /** Newer first; made before this time: the next page. */
  before?: string;
  limit?: number;
}

export async function listDeliveries(db: Db, filter: DeliveryFilter = {}): Promise<Delivery[]> {
  let query = db.selectFrom('notification').selectAll();
  if (filter.status) query = query.where('status', '=', filter.status);
  if (filter.event) query = query.where('event', '=', filter.event);
  if (filter.run) query = query.where('run_id', '=', filter.run);
  if (filter.before) query = query.where('created_at', '<', filter.before);
  const rows = await query
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200))
    .execute();
  return rows.map(deliveryOf);
}

/** Messages sent or given up on more than `days` ago go. Resolves with how many. */
export async function pruneDeliveries(db: Db, days: number, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString();
  const done = await db
    .deleteFrom('notification')
    .where('status', '!=', 'pending')
    .where('created_at', '<', before)
    .executeTakeFirst();
  return Number(done.numDeletedRows);
}
