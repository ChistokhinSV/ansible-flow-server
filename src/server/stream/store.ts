// Event streaming's destinations and their outbox (AFS-243, AFS-244). A destination ("sink") is
// kept in `stream_sink`, its OTLP headers sealed with the master key. What goes to it waits in
// `stream_delivery`, one row per (sink, kind, ref): an audit entry, a run's start, a run's end.
// The payload is made when the row is sent, from the audit entry or the run.
//
// Not a "last id sent" cursor: audit ids are random and rows become visible out of order, so a
// cursor would step over a row that commits late (ADR-0038). Rows are taken like notifications
// are: a server moves a row's next try into the future, and only the one whose move took sends it.
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { type Kysely, sql } from 'kysely';
import type { Schema, StreamSinkTable } from '../db/schema';
import { open, seal } from '../secrets/crypto';
import type { MasterKey } from '../secrets/masterKey';
import {
  DEFAULT_ENTERPRISE,
  DEFAULT_FACILITY,
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_MAX_BACKLOG,
  type OtlpSettings,
  SINK_TYPES,
  type Sink,
  type SinkInput,
  type SinkStatus,
  SYSLOG_TRANSPORTS,
  type SyslogSettings,
} from './types';

type Db = Kysely<Schema>;

export type DeliveryKind = 'audit' | 'run-start' | 'run-end';
/** pending: to send; inflight: written to a syslog socket, not yet counted sent; sent; dropped. */
export type DeliveryStatus = 'pending' | 'inflight' | 'sent' | 'dropped';

export class StreamError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'StreamError';
  }
}

const headersContext = (id: string) => `stream-sink:${id}`;

/** What a sink keeps besides its headers (JSON in `config_json`). */
type Stored = { syslog: SyslogSettings } | { otlp: OtlpSettings & { headerNames: string[] } };

const iso = (d: Date) => d.toISOString();

function sinkOf(row: StreamSinkTable, status: SinkStatus): Sink {
  const stored = JSON.parse(row.config_json) as Stored;
  return {
    id: row.id,
    name: row.name,
    type: row.type as Sink['type'],
    enabled: row.enabled === 1,
    audit: row.audit === 1,
    runs: row.runs === 1,
    ...('syslog' in stored ? { syslog: stored.syslog } : {}),
    ...('otlp' in stored
      ? {
          otlp: (({ headerNames, ...rest }) => ({ ...rest, headers: headerNames }))(stored.otlp),
        }
      : {}),
    maxBacklog: Number(row.max_backlog),
    maxAgeDays: Number(row.max_age_days),
    status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Each sink's backlog and its oldest row, in one query. */
async function backlogs(db: Db): Promise<Map<string, { n: number; oldest?: string }>> {
  const rows = await db
    .selectFrom('stream_delivery')
    .select([
      'sink_id',
      (eb) => eb.fn.countAll<number>().as('n'),
      (eb) => eb.fn.min('created_at').as('oldest'),
    ])
    .where('status', 'in', ['pending', 'inflight'])
    .groupBy('sink_id')
    .execute();
  return new Map(
    rows.map((r) => [
      r.sink_id,
      { n: Number(r.n), ...(r.oldest ? { oldest: String(r.oldest) } : {}) },
    ]),
  );
}

const statusOf = (row: StreamSinkTable, b?: { n: number; oldest?: string }): SinkStatus => ({
  backlog: b?.n ?? 0,
  ...(b?.oldest ? { oldestAt: b.oldest } : {}),
  dropped: Number(row.dropped),
  ...(row.last_success_at ? { lastSuccessAt: row.last_success_at } : {}),
  ...(row.last_error ? { lastError: row.last_error } : {}),
  ...(row.last_error_at ? { lastErrorAt: row.last_error_at } : {}),
  ...(row.failing_since ? { failingSince: row.failing_since } : {}),
  ...(row.retry_at ? { nextTryAt: row.retry_at } : {}),
});

export async function listSinks(db: Db): Promise<Sink[]> {
  const [rows, b] = await Promise.all([
    db.selectFrom('stream_sink').selectAll().orderBy('name').execute(),
    backlogs(db),
  ]);
  return rows.map((r) => sinkOf(r, statusOf(r, b.get(r.id))));
}

export async function getSink(db: Db, id: string): Promise<Sink | undefined> {
  const row = await db
    .selectFrom('stream_sink')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) return undefined;
  return sinkOf(row, statusOf(row, (await backlogs(db)).get(id)));
}

/** A sink with what sending needs: its headers opened. Never log or show this. */
export interface SinkForSending extends Sink {
  headerValues: Record<string, string>;
}

export async function sinksForSending(db: Db, key: MasterKey): Promise<SinkForSending[]> {
  const rows = await db.selectFrom('stream_sink').selectAll().where('enabled', '=', 1).execute();
  return rows.map((r) => ({
    ...sinkOf(r, statusOf(r)),
    headerValues: r.headers_enc
      ? (JSON.parse(open(key, r.headers_enc, headersContext(r.id))) as Record<string, string>)
      : {},
  }));
}

export async function sinkForSending(
  db: Db,
  key: MasterKey,
  id: string,
): Promise<SinkForSending | undefined> {
  const row = await db
    .selectFrom('stream_sink')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    ...sinkOf(row, statusOf(row)),
    headerValues: row.headers_enc
      ? (JSON.parse(open(key, row.headers_enc, headersContext(row.id))) as Record<string, string>)
      : {},
  };
}

// --- checking what an administrator sends

const HOST = /^[A-Za-z0-9.-]{1,253}$|^\[?[0-9a-fA-F:.]+\]?$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
/** Headers the sender sets itself. */
const OWN_HEADERS = new Set([
  'content-type',
  'content-encoding',
  'content-length',
  'host',
  'transfer-encoding',
  'connection',
]);

function integer(v: unknown, min: number, max: number, field: string, words: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw new StreamError(words, field);
  return v;
}

function checkCa(ca: string | undefined, field: string): string | undefined {
  const text = ca?.trim();
  if (!text) return undefined;
  if (text.length > 64 * 1024 || !text.includes('-----BEGIN CERTIFICATE-----'))
    throw new StreamError('The authority is one or more certificates in PEM', field);
  try {
    new X509Certificate(text);
  } catch {
    throw new StreamError('The authority is not a certificate that can be read', field);
  }
  return `${text}\n`;
}

function syslogOf(
  input: NonNullable<SinkInput['syslog']>,
  before?: SyslogSettings,
): SyslogSettings {
  const host = String(input.host ?? '').trim();
  if (!HOST.test(host))
    throw new StreamError('Not the name or address of a receiver', 'syslog.host');
  const transport = input.transport ?? before?.transport ?? 'tls';
  if (!SYSLOG_TRANSPORTS.includes(transport))
    throw new StreamError('The transport is tls, tcp or udp', 'syslog.transport');
  const port = integer(
    input.port ??
      (input.transport && input.transport !== before?.transport ? undefined : before?.port) ??
      (transport === 'tls' ? 6514 : 514),
    1,
    65535,
    'syslog.port',
    'A port is a number from 1 to 65535',
  );
  const facility = integer(
    input.facility ?? before?.facility ?? DEFAULT_FACILITY,
    0,
    23,
    'syslog.facility',
    'The facility is a number from 0 to 23',
  );
  const enterprise = integer(
    input.enterprise ?? before?.enterprise ?? DEFAULT_ENTERPRISE,
    1,
    2_147_483_647,
    'syslog.enterprise',
    'The enterprise number is a whole number above 0',
  );
  const windowSeconds = integer(
    input.windowSeconds ?? before?.windowSeconds ?? 3,
    0,
    60,
    'syslog.windowSeconds',
    'The resend window is 0 to 60 seconds',
  );
  const framing = input.framing ?? before?.framing ?? 'octet';
  if (framing !== 'octet' && framing !== 'lf')
    throw new StreamError('Framing is octet or lf', 'syslog.framing');
  const hostname = (input.hostname ?? before?.hostname ?? '').trim();
  if (hostname && !/^[\x21-\x7e]{1,255}$/.test(hostname))
    throw new StreamError('The host name is printable ASCII without spaces', 'syslog.hostname');
  const ca = 'ca' in input ? checkCa(input.ca, 'syslog.ca') : before?.ca;
  return {
    host,
    port,
    transport,
    ...(ca ? { ca } : {}),
    facility,
    enterprise,
    bom: input.bom ?? before?.bom ?? true,
    ...(hostname ? { hostname } : {}),
    framing,
    windowSeconds,
  };
}

function otlpOf(
  input: NonNullable<SinkInput['otlp']>,
  before: (OtlpSettings & { headerNames: string[] }) | undefined,
  storedHeaders: Record<string, string>,
): { settings: OtlpSettings & { headerNames: string[] }; headers: Record<string, string> } {
  let url: URL;
  try {
    url = new URL(String(input.endpoint ?? '').trim());
  } catch {
    throw new StreamError(
      'The endpoint is an address such as https://collector:4318',
      'otlp.endpoint',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new StreamError('The endpoint is an http or https address', 'otlp.endpoint');
  if (url.username || url.password || url.search || url.hash)
    throw new StreamError(
      'The endpoint has no user, query or fragment: put a token in a header',
      'otlp.endpoint',
    );
  const timeoutSeconds = integer(
    input.timeoutSeconds ?? before?.timeoutSeconds ?? 10,
    1,
    120,
    'otlp.timeoutSeconds',
    'The timeout is 1 to 120 seconds',
  );
  const maxHostEvents = integer(
    input.maxHostEvents ?? before?.maxHostEvents ?? 100,
    0,
    10_000,
    'otlp.maxHostEvents',
    'Host events per step are 0 to 10,000',
  );
  const environment = (input.environment ?? before?.environment ?? '').trim();
  if (environment.length > 100)
    throw new StreamError('The environment is at most 100 characters', 'otlp.environment');
  let headers = storedHeaders;
  if (input.headers) {
    headers = {};
    for (const h of input.headers) {
      const name = String(h.name ?? '').trim();
      if (!HEADER_NAME.test(name) || OWN_HEADERS.has(name.toLowerCase()))
        throw new StreamError(`Not a header that can be set: ${name.slice(0, 40)}`, 'otlp.headers');
      const value = h.value ?? storedHeaders[name];
      if (value === undefined)
        throw new StreamError(`The header ${name} needs a value`, 'otlp.headers');
      if (value.length > 8192 || /[\r\n\0]/.test(value))
        throw new StreamError(
          `The value of ${name} is one line, at most 8192 characters`,
          'otlp.headers',
        );
      headers[name] = value;
    }
  }
  const ca = 'ca' in input ? checkCa(input.ca, 'otlp.ca') : before?.ca;
  return {
    settings: {
      endpoint: url.toString().replace(/\/+$/, ''),
      ...(ca ? { ca } : {}),
      gzip: input.gzip ?? before?.gzip ?? true,
      timeoutSeconds,
      ...(environment ? { environment } : {}),
      hostNames: input.hostNames ?? before?.hostNames ?? true,
      maxHostEvents,
      headerNames: Object.keys(headers),
    },
    headers,
  };
}

function commonOf(input: Partial<SinkInput>, before?: StreamSinkTable) {
  const name = (input.name ?? before?.name ?? '').trim();
  if (!name || name.length > 100) throw new StreamError('A name of 1 to 100 characters', 'name');
  const maxBacklog = integer(
    input.maxBacklog ?? (before ? Number(before.max_backlog) : DEFAULT_MAX_BACKLOG),
    100,
    10_000_000,
    'maxBacklog',
    'The backlog limit is 100 to 10,000,000 rows',
  );
  const maxAgeDays = integer(
    input.maxAgeDays ?? (before ? Number(before.max_age_days) : DEFAULT_MAX_AGE_DAYS),
    1,
    365,
    'maxAgeDays',
    'The age limit is 1 to 365 days',
  );
  return { name, maxBacklog, maxAgeDays };
}

export async function createSink(db: Db, key: MasterKey, input: SinkInput): Promise<Sink> {
  if (!SINK_TYPES.includes(input.type)) throw new StreamError('The type is syslog or otlp', 'type');
  const common = commonOf(input);
  const id = randomUUID();
  let stored: Stored;
  let headers: Record<string, string> = {};
  if (input.type === 'syslog') {
    if (!input.syslog) throw new StreamError('A syslog destination needs its receiver', 'syslog');
    stored = { syslog: syslogOf(input.syslog) };
  } else {
    if (!input.otlp)
      throw new StreamError('An OpenTelemetry destination needs its endpoint', 'otlp');
    const made = otlpOf(input.otlp, undefined, {});
    stored = { otlp: made.settings };
    headers = made.headers;
  }
  const now = iso(new Date());
  await db
    .insertInto('stream_sink')
    .values({
      id,
      name: common.name,
      type: input.type,
      enabled: input.enabled === false ? 0 : 1,
      audit: input.audit === false ? 0 : 1,
      runs: input.runs === false ? 0 : 1,
      config_json: JSON.stringify(stored),
      headers_enc: Object.keys(headers).length
        ? seal(key, JSON.stringify(headers), headersContext(id))
        : null,
      max_backlog: common.maxBacklog,
      max_age_days: common.maxAgeDays,
      last_success_at: null,
      last_error: null,
      last_error_at: null,
      failing_since: null,
      failing_told: 0,
      dropped: 0,
      dropped_told_at: null,
      retry_at: null,
      retries: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return (await getSink(db, id)) as Sink;
}

export async function updateSink(
  db: Db,
  key: MasterKey,
  id: string,
  input: Partial<SinkInput>,
): Promise<Sink | undefined> {
  const row = await db
    .selectFrom('stream_sink')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) return undefined;
  if (input.type && input.type !== row.type)
    throw new StreamError('The type of a destination does not change: add another one', 'type');
  const common = commonOf(input, row);
  const before = JSON.parse(row.config_json) as Stored;
  let stored = before;
  let headersEnc = row.headers_enc;
  if ('syslog' in before && input.syslog)
    stored = { syslog: syslogOf({ ...before.syslog, ...input.syslog }, before.syslog) };
  if ('otlp' in before && input.otlp) {
    const kept = row.headers_enc
      ? (JSON.parse(open(key, row.headers_enc, headersContext(id))) as Record<string, string>)
      : {};
    const made = otlpOf({ ...before.otlp, ...input.otlp }, before.otlp, kept);
    stored = { otlp: made.settings };
    headersEnc = Object.keys(made.headers).length
      ? seal(key, JSON.stringify(made.headers), headersContext(id))
      : null;
  }
  await db
    .updateTable('stream_sink')
    .set({
      name: common.name,
      ...(input.enabled !== undefined ? { enabled: input.enabled ? 1 : 0 } : {}),
      ...(input.audit !== undefined ? { audit: input.audit ? 1 : 0 } : {}),
      ...(input.runs !== undefined ? { runs: input.runs ? 1 : 0 } : {}),
      config_json: JSON.stringify(stored),
      headers_enc: headersEnc,
      max_backlog: common.maxBacklog,
      max_age_days: common.maxAgeDays,
      updated_at: iso(new Date()),
      // AFS-248: changed, so tried again now, with what waits.
      retry_at: null,
      retries: 0,
      // AFS-262: the last error was the old settings': the next try says whether the new fail.
      last_error: null,
      last_error_at: null,
    })
    .where('id', '=', id)
    .execute();
  await dueNow(db, id);
  return getSink(db, id);
}

/** Removes the sink and what waits for it. */
export async function deleteSink(db: Db, id: string): Promise<boolean> {
  await db.deleteFrom('stream_delivery').where('sink_id', '=', id).execute();
  const done = await db.deleteFrom('stream_sink').where('id', '=', id).executeTakeFirst();
  return Number(done.numDeletedRows) > 0;
}

/** `secrets rotate`: seals the headers again with the new key. */
export async function resealSinks(
  db: Db,
  again: (sealed: string, context: string) => string,
): Promise<number> {
  const rows = await db
    .selectFrom('stream_sink')
    .select(['id', 'headers_enc'])
    .where('headers_enc', 'is not', null)
    .execute();
  for (const r of rows)
    await db
      .updateTable('stream_sink')
      .set({ headers_enc: again(r.headers_enc as string, headersContext(r.id)) })
      .where('id', '=', r.id)
      .execute();
  return rows.length;
}

// --- the outbox

/**
 * Adds one row for every enabled sink that takes this kind, in one statement: an audit entry for
 * sinks with `audit`, a run's start for syslog sinks with `runs`, a run's end for sinks with
 * `runs`. A row already there (a run claimed again) is left as it is.
 */
export async function enqueueDeliveries(
  db: Db,
  kind: DeliveryKind,
  ref: string,
  now?: Date,
): Promise<void> {
  const at = now ?? new Date();
  const made = now ?? stamp();
  let sinks = db
    .selectFrom('stream_sink')
    .select((eb) => [
      'id',
      sql<string>`${kind}`.as('kind'),
      sql<string>`${ref}`.as('ref_id'),
      sql<string>`${'pending'}`.as('status'),
      sql<number>`0`.as('attempts'),
      sql<string>`${iso(at)}`.as('next_at'),
      sql<string>`${iso(made)}`.as('created_at'),
      eb.val(null as string | null).as('taken_by'),
    ])
    .where('enabled', '=', 1);
  sinks =
    kind === 'audit'
      ? sinks.where('audit', '=', 1)
      : kind === 'run-start'
        ? sinks.where('runs', '=', 1).where('type', '=', 'syslog')
        : sinks.where('runs', '=', 1);
  await db
    .insertInto('stream_delivery')
    .columns([
      'sink_id',
      'kind',
      'ref_id',
      'status',
      'attempts',
      'next_at',
      'created_at',
      'taken_by',
    ])
    .expression(sinks)
    .onConflict((c) => c.columns(['sink_id', 'kind', 'ref_id']).doNothing())
    .execute();
}

let lastStamp = 0;
/**
 * AFS-248: when a row was made, a millisecond after the one before it on this server: rows are
 * sent in this order, and entries written in the same millisecond keep the order they were in.
 */
function stamp(): Date {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp);
}

export interface Taken {
  kind: DeliveryKind;
  ref: string;
  attempts: number;
  /** When the row was written: when what it says happened (the same on every destination). */
  createdAt: string;
}

/** A row being sent is that server's for this long. */
const TAKEN_MS = 2 * 60_000;

/**
 * Rows of a sink due now, taken by this server: one UPDATE moves their next try into the future
 * and marks them with a fresh token, and the rows with that token are this server's. The
 * condition on `next_at` is checked again on each row as it is updated, so two servers never take
 * the same row (PostgreSQL rechecks it after the other's update; SQLite has one writer).
 */
export async function takeDue(
  db: Db,
  sink: string,
  kinds: DeliveryKind[],
  limit: number,
  now = new Date(),
): Promise<Taken[]> {
  const token = randomBytes(12).toString('base64url');
  const due = db
    .selectFrom('stream_delivery')
    .select(['kind', 'ref_id'])
    .where('sink_id', '=', sink)
    .where('status', '=', 'pending')
    .where('kind', 'in', kinds)
    .where('next_at', '<=', iso(now))
    .orderBy('created_at')
    .orderBy('kind')
    .orderBy('ref_id')
    .limit(limit);
  await db
    .updateTable('stream_delivery')
    .set((eb) => ({
      taken_by: token,
      next_at: iso(new Date(now.getTime() + TAKEN_MS)),
      attempts: eb('attempts', '+', 1),
    }))
    .where('sink_id', '=', sink)
    .where('status', '=', 'pending')
    .where('next_at', '<=', iso(now))
    .where(({ eb, refTuple }) =>
      eb(refTuple('kind', 'ref_id'), 'in', due.$asTuple('kind', 'ref_id')),
    )
    .execute();
  const rows = await db
    .selectFrom('stream_delivery')
    .select(['kind', 'ref_id', 'attempts', 'created_at'])
    .where('sink_id', '=', sink)
    .where('taken_by', '=', token)
    .orderBy('created_at')
    .orderBy('kind')
    .orderBy('ref_id')
    .execute();
  return rows.map((r) => ({
    kind: r.kind as DeliveryKind,
    ref: r.ref_id,
    attempts: r.attempts,
    createdAt: r.created_at,
  }));
}

type Key = { kind: DeliveryKind; ref: string };

/** Runs `work` on the rows in slices, for databases that limit a statement's parameters. */
async function inSlices(
  keys: Key[],
  work: (kind: DeliveryKind, refs: string[]) => Promise<unknown>,
) {
  const byKind = new Map<DeliveryKind, string[]>();
  for (const k of keys) byKind.set(k.kind, [...(byKind.get(k.kind) ?? []), k.ref]);
  for (const [kind, refs] of byKind)
    for (let i = 0; i < refs.length; i += 500) await work(kind, refs.slice(i, i + 500));
}

export async function markSent(db: Db, sink: string, keys: Key[], now = new Date()) {
  await inSlices(keys, (kind, refs) =>
    db
      .updateTable('stream_delivery')
      .set({ status: 'sent', sent_at: iso(now), last_error: null, taken_by: null })
      .where('sink_id', '=', sink)
      .where('kind', '=', kind)
      .where('ref_id', 'in', refs)
      .execute(),
  );
}

/** Written to a syslog socket at `now`: sent once the connection stayed up for the window. */
export async function markInflight(db: Db, sink: string, keys: Key[], now = new Date()) {
  await inSlices(keys, (kind, refs) =>
    db
      .updateTable('stream_delivery')
      .set({ status: 'inflight', next_at: iso(now) })
      .where('sink_id', '=', sink)
      .where('kind', '=', kind)
      .where('ref_id', 'in', refs)
      .execute(),
  );
}

/**
 * A failing destination is tried again after 5 s, doubling to a minute; it never gives up while
 * the backlog has room. AFS-248: the wait is the destination's, not each row's: rows that each
 * waited their own backoff (up to 5 minutes) went out a few at a time, in no order, long after
 * the receiver was back.
 */
export const retryDelayMs = (failures: number) =>
  Math.min(5_000 * 2 ** Math.max(0, Math.min(failures - 1, 10)), 60_000);

/**
 * Back to pending, due after `delayMs` (0 for the streamer: the destination's wait holds them;
 * rows written on a connection that was lost go again first, being the oldest).
 */
export async function markRetry(
  db: Db,
  sink: string,
  keys: Key[],
  error: string | undefined,
  delayMs: number,
  now = new Date(),
) {
  await inSlices(keys, (kind, refs) =>
    db
      .updateTable('stream_delivery')
      .set({
        status: 'pending',
        next_at: iso(new Date(now.getTime() + delayMs)),
        taken_by: null,
        ...(error ? { last_error: error.slice(0, 500) } : {}),
      })
      .where('sink_id', '=', sink)
      .where('kind', '=', kind)
      .where('ref_id', 'in', refs)
      .where('status', 'in', ['pending', 'inflight'])
      .execute(),
  );
}

/** AFS-248: the rows waiting for a sink, not taken by a server now, are due now. */
async function dueNow(db: Db, sink: string, now = new Date()) {
  await db
    .updateTable('stream_delivery')
    .set({ next_at: iso(now) })
    .where('sink_id', '=', sink)
    .where('status', '=', 'pending')
    .where('taken_by', 'is', null)
    .where('next_at', '>', iso(now))
    .execute();
}

/** Not sent and never will be (the collector refused it, or what it was about is gone). */
export async function markDropped(db: Db, sink: string, keys: Key[], error: string) {
  await inSlices(keys, (kind, refs) =>
    db
      .updateTable('stream_delivery')
      .set({ status: 'dropped', last_error: error.slice(0, 500), taken_by: null })
      .where('sink_id', '=', sink)
      .where('kind', '=', kind)
      .where('ref_id', 'in', refs)
      .execute(),
  );
  await db
    .updateTable('stream_sink')
    .set((eb) => ({ dropped: eb('dropped', '+', keys.length) }))
    .where('id', '=', sink)
    .execute();
}

/**
 * Rows a server wrote to a socket and never settled (it stopped): pending again after a while.
 * Receivers remove the repeats by audit id.
 */
export async function reviveInflight(db: Db, sink: string, olderThanMs: number, now = new Date()) {
  const done = await db
    .updateTable('stream_delivery')
    .set({ status: 'pending', taken_by: null })
    .where('sink_id', '=', sink)
    .where('status', '=', 'inflight')
    .where('next_at', '<', iso(new Date(now.getTime() - olderThanMs)))
    .executeTakeFirst();
  return Number(done.numUpdatedRows);
}

/**
 * Keeps the backlog within its bounds: rows older than the age limit, then the oldest over the
 * count limit, are dropped and counted. Resolves with how many went.
 */
export async function enforceBounds(
  db: Db,
  sink: { id: string; maxBacklog: number; maxAgeDays: number },
  now = new Date(),
): Promise<number> {
  const cutoff = iso(new Date(now.getTime() - sink.maxAgeDays * 24 * 60 * 60_000));
  const old = await db
    .updateTable('stream_delivery')
    .set({ status: 'dropped', last_error: `Older than ${sink.maxAgeDays} days`, taken_by: null })
    .where('sink_id', '=', sink.id)
    .where('status', '=', 'pending')
    .where('created_at', '<', cutoff)
    .executeTakeFirst();
  let dropped = Number(old.numUpdatedRows);
  const row = await db
    .selectFrom('stream_delivery')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('sink_id', '=', sink.id)
    .where('status', 'in', ['pending', 'inflight'])
    .executeTakeFirst();
  let over = Number(row?.n ?? 0) - sink.maxBacklog;
  while (over > 0) {
    const oldest = await db
      .selectFrom('stream_delivery')
      .select(['kind', 'ref_id'])
      .where('sink_id', '=', sink.id)
      .where('status', '=', 'pending')
      .orderBy('created_at')
      .limit(Math.min(over, 1000))
      .execute();
    if (!oldest.length) break;
    await inSlices(
      oldest.map((o) => ({ kind: o.kind as DeliveryKind, ref: o.ref_id })),
      (kind, refs) =>
        db
          .updateTable('stream_delivery')
          .set({
            status: 'dropped',
            last_error: `Over ${sink.maxBacklog} rows waiting`,
            taken_by: null,
          })
          .where('sink_id', '=', sink.id)
          .where('kind', '=', kind)
          .where('ref_id', 'in', refs)
          .where('status', '=', 'pending')
          .execute(),
    );
    dropped += oldest.length;
    over -= oldest.length;
  }
  if (dropped)
    await db
      .updateTable('stream_sink')
      .set((eb) => ({ dropped: eb('dropped', '+', dropped) }))
      .where('id', '=', sink.id)
      .execute();
  return dropped;
}

/** Sent and dropped rows older than `days` go. Resolves with how many. */
export async function pruneStreamDeliveries(db: Db, days = 1, now = new Date()): Promise<number> {
  const done = await db
    .deleteFrom('stream_delivery')
    .where('status', 'in', ['sent', 'dropped'])
    .where('created_at', '<', iso(new Date(now.getTime() - days * 24 * 60 * 60_000)))
    .executeTakeFirst();
  return Number(done.numDeletedRows);
}

/** A sink worked: its failing ends. */
export async function sinkSucceeded(db: Db, sink: string, now = new Date()) {
  await db
    .updateTable('stream_sink')
    .set({
      last_success_at: iso(now),
      failing_since: null,
      failing_told: 0,
      retry_at: null,
      retries: 0,
    })
    .where('id', '=', sink)
    .execute();
}

/**
 * A sink failed: when it is the first failure since a success, it is failing from now. With
 * `wait` (it could not take anything), nothing more goes to it until its retry time.
 */
export async function sinkFailed(
  db: Db,
  sink: string,
  error: string,
  now = new Date(),
  wait = true,
) {
  const row = wait
    ? await db.selectFrom('stream_sink').select('retries').where('id', '=', sink).executeTakeFirst()
    : undefined;
  const failures = Number(row?.retries ?? 0) + 1;
  await db
    .updateTable('stream_sink')
    .set((eb) => ({
      last_error: error.slice(0, 500),
      last_error_at: iso(now),
      failing_since: eb.fn.coalesce('failing_since', eb.val(iso(now))),
      ...(wait
        ? { retries: failures, retry_at: iso(new Date(now.getTime() + retryDelayMs(failures))) }
        : {}),
    }))
    .where('id', '=', sink)
    .execute();
}

/** AFS-248: a sink is tried now (a test reached it): what waits for it is due now. */
export async function retrySinkNow(db: Db, sink: string, now = new Date()) {
  await db
    .updateTable('stream_sink')
    .set({ retry_at: null, retries: 0 })
    .where('id', '=', sink)
    .execute();
  await dueNow(db, sink, now);
}

/**
 * Whether this server should tell that the sink has been failing for `afterMs`: true once per
 * failing spell, whichever server asks first.
 */
export async function claimFailingNotice(
  db: Db,
  sink: string,
  afterMs: number,
  now = new Date(),
): Promise<string | undefined> {
  const row = await db
    .selectFrom('stream_sink')
    .select(['failing_since', 'failing_told'])
    .where('id', '=', sink)
    .executeTakeFirst();
  if (!row?.failing_since || row.failing_told) return undefined;
  if (now.getTime() - Date.parse(row.failing_since) < afterMs) return undefined;
  const done = await db
    .updateTable('stream_sink')
    .set({ failing_told: 1 })
    .where('id', '=', sink)
    .where('failing_told', '=', 0)
    .where('failing_since', '=', row.failing_since)
    .executeTakeFirst();
  return Number(done.numUpdatedRows) > 0 ? row.failing_since : undefined;
}

/** Whether to put the drops in the audit log now: once an hour per sink at most. */
export async function claimDroppedNotice(db: Db, sink: string, now = new Date()): Promise<boolean> {
  const hourAgo = iso(new Date(now.getTime() - 60 * 60_000));
  const done = await db
    .updateTable('stream_sink')
    .set({ dropped_told_at: iso(now) })
    .where('id', '=', sink)
    .where((eb) => eb.or([eb('dropped_told_at', 'is', null), eb('dropped_told_at', '<', hourAgo)]))
    .executeTakeFirst();
  return Number(done.numUpdatedRows) > 0;
}

/** Per sink, for the metrics: backlog, oldest row, drops, last success. */
export async function streamStats(db: Db): Promise<
  {
    id: string;
    type: string;
    backlog: number;
    oldestAt?: string;
    dropped: number;
    lastSuccessAt?: string;
  }[]
> {
  const [rows, b] = await Promise.all([
    db.selectFrom('stream_sink').select(['id', 'type', 'dropped', 'last_success_at']).execute(),
    backlogs(db),
  ]);
  return rows.map((r) => {
    const x = b.get(r.id);
    return {
      id: r.id,
      type: r.type,
      backlog: x?.n ?? 0,
      ...(x?.oldest ? { oldestAt: x.oldest } : {}),
      dropped: Number(r.dropped),
      ...(r.last_success_at ? { lastSuccessAt: r.last_success_at } : {}),
    };
  });
}
