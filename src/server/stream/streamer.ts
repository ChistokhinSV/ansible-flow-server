// Event streaming's sender (AFS-243, AFS-244): every couple of seconds, or as soon as something
// is written, each enabled destination takes its due rows from the outbox (store.ts), makes the
// messages from the audit entries and runs they name, and sends them.
//   syslog: no acknowledgement, so rows written on a socket stay `inflight` until the connection
//           stayed up for the window (3 s) with its buffer drained; when it is lost first, they
//           are written again on the next one. Receivers remove the repeats by audit id.
//   OTLP:   one POST per batch; 2xx sent, 408/429/5xx and network errors later, others dropped.
// Retries never give up while the backlog is within its bounds; past them the oldest rows go,
// counted. A destination failing for 15 minutes is told to the administrators (stream.failing).
import { hostname } from 'node:os';
import type { Kysely } from 'kysely';
import { auditEntries, recordAudit } from '../audit/store';
import type { Schema } from '../db/schema';
import type { Logger } from '../log';
import type { MasterKey } from '../secrets/masterKey';
import {
  auditRecord,
  logsPayload,
  post,
  type RunTrace,
  resourceOf,
  runSpans,
  type StepName,
  testRecord,
  tracesPayload,
} from './otlp';
import {
  claimDroppedNotice,
  claimFailingNotice,
  type DeliveryKind,
  enforceBounds,
  enqueueDeliveries,
  markDropped,
  markInflight,
  markRetry,
  markSent,
  pruneStreamDeliveries,
  retryDelayMs,
  reviveInflight,
  type SinkForSending,
  sinkFailed,
  sinkForSending,
  sinkSucceeded,
  sinksForSending,
  type Taken,
  takeDue,
} from './store';
import {
  dial,
  formatAudit,
  formatOf,
  formatRun,
  formatTest,
  frame,
  type RunFacts,
  type SyslogFormat,
  SyslogLink,
  sendUdp,
  type Wire,
} from './syslog';
import type { SinkTest, SyslogSettings } from './types';

type Db = Kysely<Schema>;
type Key = { kind: DeliveryKind; ref: string };

const AUDIT_BATCH = 500;
const RUN_BATCH = 20;
/** Batches a destination may send in one round before the others get their turn. */
const BATCHES_PER_ROUND = 10;
/** A failing destination is told after this long without a success. */
export const FAILING_AFTER_MS = 15 * 60_000;
/** Rows a server wrote and never settled (it stopped) are sent again after this long. */
const STALE_INFLIGHT_MS = 5 * 60_000;
const BOUNDS_EVERY_MS = 60_000;

export interface StreamerOptions {
  db: Db;
  key: MasterKey;
  log: Logger;
  version: string;
  /** The steps of a run's flow by node id (key, kind, title), for span names. */
  steps?: (run: {
    project: string;
    commit: string;
    file: string;
  }) => Promise<Record<string, StepName>>;
  /** Told when a destination has failed for 15 minutes (the notifier's stream.failing). */
  failing?: (sink: { id: string; name: string; since: string; error?: string }) => void;
  everyMs?: number;
  /** Opens a syslog connection (a test gives its own). */
  dial?: (s: SyslogSettings) => Promise<Wire>;
  hostname?: string;
}

interface Batch {
  keys: Key[];
  generation: number;
  at: number;
}

/** What the streamer keeps of a syslog destination between rounds. */
interface SyslogState {
  link: SyslogLink;
  /** The settings the link was opened with: changed settings open a new one. */
  settings: string;
  inflight: Batch[];
}

export class Streamer {
  private timer: NodeJS.Timeout | undefined;
  private soon: NodeJS.Timeout | undefined;
  private going: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly links = new Map<string, SyslogState>();
  private readonly boundsAt = new Map<string, number>();
  private readonly host: string;

  constructor(private readonly o: StreamerOptions) {
    this.host = o.hostname ?? hostname();
  }

  start(): void {
    this.timer = setInterval(() => void this.round(), this.o.everyMs ?? 2_000);
    this.timer.unref();
    void this.round();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.soon);
    await this.going;
    for (const s of this.links.values()) s.link.close();
    this.links.clear();
  }

  /** Something was written: a round soon (once, however many entries come in that time). */
  wake(): void {
    if (this.stopped || this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = undefined;
      void this.round();
    }, 100);
    this.soon.unref();
  }

  /** A run started: its line goes to the syslog destinations. */
  runStarted(id: string): void {
    void enqueueDeliveries(this.o.db, 'run-start', id).then(
      () => this.wake(),
      (e) => this.o.log.error({ err: e, run: id }, 'A run was not given to the event streams'),
    );
  }

  /** A run ended: its line, and its trace. */
  runEnded(id: string): void {
    void enqueueDeliveries(this.o.db, 'run-end', id).then(
      () => this.wake(),
      (e) => this.o.log.error({ err: e, run: id }, 'A run was not given to the event streams'),
    );
  }

  /** One round over the destinations, after the one going on now (for tests: resolves when done). */
  round(): Promise<void> {
    this.going = this.going
      .then(() => this.sendAll())
      .catch((e) => this.o.log.error({ err: e }, 'Event streaming failed'));
    return this.going;
  }

  /** Removes rows sent or dropped more than a day ago. */
  prune(): Promise<number> {
    return pruneStreamDeliveries(this.o.db, 1);
  }

  private async sendAll(): Promise<void> {
    if (this.stopped) return;
    const sinks = await sinksForSending(this.o.db, this.o.key);
    // Destinations removed or turned off: their connections close.
    for (const [id, state] of this.links)
      if (!sinks.some((s) => s.id === id && s.type === 'syslog')) {
        state.link.close();
        this.links.delete(id);
      }
    for (const sink of sinks) {
      if (this.stopped) return;
      try {
        await this.bounds(sink);
        if (sink.syslog) await this.sendSyslog(sink, sink.syslog);
        else if (sink.otlp) await this.sendOtlp(sink);
        const since = await claimFailingNotice(this.o.db, sink.id, FAILING_AFTER_MS);
        if (since) {
          const row = await this.o.db
            .selectFrom('stream_sink')
            .select('last_error')
            .where('id', '=', sink.id)
            .executeTakeFirst();
          this.o.log.warn({ sink: sink.id, since }, 'An event stream has failed for 15 minutes');
          this.o.failing?.({
            id: sink.id,
            name: sink.name,
            since,
            ...(row?.last_error ? { error: row.last_error } : {}),
          });
        }
      } catch (e) {
        this.o.log.error({ err: e, sink: sink.id }, 'An event stream could not send');
      }
    }
  }

  /** Over the backlog's bounds: the oldest rows go, counted, and the audit log says so hourly. */
  private async bounds(sink: SinkForSending): Promise<void> {
    const now = Date.now();
    if (now - (this.boundsAt.get(sink.id) ?? 0) < BOUNDS_EVERY_MS) return;
    this.boundsAt.set(sink.id, now);
    const dropped = await enforceBounds(this.o.db, sink);
    if (!dropped) return;
    this.o.log.warn({ sink: sink.id, dropped }, 'An event stream dropped rows over its bounds');
    if (await claimDroppedNotice(this.o.db, sink.id))
      await recordAudit(this.o.db, {
        actor: null,
        source: 'server',
        action: 'stream.dropped',
        object: { type: 'stream', id: sink.id, name: sink.name },
        result: 'failed',
        detail: { dropped, maxBacklog: sink.maxBacklog, maxAgeDays: sink.maxAgeDays },
      });
  }

  // --- syslog

  private format(s: SyslogSettings): SyslogFormat {
    return formatOf(s, { hostname: this.host, version: this.o.version });
  }

  private stateOf(sink: SinkForSending, s: SyslogSettings): SyslogState {
    const settings = JSON.stringify(s);
    const had = this.links.get(sink.id);
    if (had && had.settings === settings) return had;
    had?.link.close();
    const link = new SyslogLink(() => (this.o.dial ?? dial)(s));
    const state: SyslogState = { link, settings, inflight: [] };
    link.onLost = (generation, error) => {
      // What was written on the lost socket and not yet counted sent goes again, first.
      const lost = state.inflight.filter((b) => b.generation === generation);
      state.inflight = state.inflight.filter((b) => b.generation !== generation);
      const keys = lost.flatMap((b) => b.keys);
      if (keys.length)
        void markRetry(
          this.o.db,
          sink.id,
          keys,
          `The connection was lost${error ? ` (${error})` : ''}`,
          0,
        )
          .then(() =>
            sinkFailed(this.o.db, sink.id, `The connection was lost${error ? ` (${error})` : ''}`),
          )
          .then(() => this.wake())
          .catch((e) => this.o.log.error({ err: e, sink: sink.id }, 'Rows were not given back'));
    };
    this.links.set(sink.id, state);
    return state;
  }

  /** Batches written long enough ago on a socket that is still up and drained: sent. */
  private async settle(sink: string, state: SyslogState, windowMs: number): Promise<void> {
    const now = Date.now();
    const keep: Batch[] = [];
    const sent: Key[] = [];
    for (const b of state.inflight) {
      if (now - b.at >= windowMs && state.link.settled(b.generation)) sent.push(...b.keys);
      else keep.push(b);
    }
    state.inflight = keep;
    if (!sent.length) return;
    await markSent(this.o.db, sink, sent);
    await sinkSucceeded(this.o.db, sink);
  }

  private async sendSyslog(sink: SinkForSending, s: SyslogSettings): Promise<void> {
    const db = this.o.db;
    await reviveInflight(db, sink.id, STALE_INFLIGHT_MS);
    const kinds: DeliveryKind[] = ['audit', 'run-start', 'run-end'];
    const f = this.format(s);
    if (s.transport === 'udp') {
      for (let i = 0; i < BATCHES_PER_ROUND; i++) {
        const taken = await takeDue(db, sink.id, kinds, AUDIT_BATCH);
        if (!taken.length) return;
        const { messages, keys } = await this.syslogMessages(sink.id, taken, f);
        try {
          await sendUdp(s, messages);
          await markSent(db, sink.id, keys);
          await sinkSucceeded(db, sink.id);
        } catch (e) {
          await this.failed(sink.id, keys, taken, (e as Error).message);
          return;
        }
        if (taken.length < AUDIT_BATCH) return;
      }
      return;
    }
    const state = this.stateOf(sink, s);
    await this.settle(sink.id, state, s.windowSeconds * 1000);
    for (let i = 0; i < BATCHES_PER_ROUND; i++) {
      const taken = await takeDue(db, sink.id, kinds, AUDIT_BATCH);
      if (!taken.length) break;
      const { messages, keys } = await this.syslogMessages(sink.id, taken, f);
      let generation: number;
      try {
        generation = await state.link.write(messages.map((m) => frame(m, s.framing)));
      } catch (e) {
        const why = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
        await this.failed(sink.id, keys, taken, `Not reachable: ${why}`);
        return;
      }
      await markInflight(db, sink.id, keys);
      state.inflight.push({ keys, generation, at: Date.now() });
      if (taken.length < AUDIT_BATCH) break;
    }
    // A window of 0: what drained is sent now.
    if (!s.windowSeconds) await this.settle(sink.id, state, 0);
  }

  /** The messages of taken rows; rows whose entry or run is gone are dropped. */
  private async syslogMessages(
    sink: string,
    taken: Taken[],
    f: SyslogFormat,
  ): Promise<{ messages: string[]; keys: Key[] }> {
    const audit = new Map(
      (
        await auditEntries(
          this.o.db,
          taken.filter((t) => t.kind === 'audit').map((t) => t.ref),
        )
      ).map((e) => [e.id, e]),
    );
    const runIds = [...new Set(taken.filter((t) => t.kind !== 'audit').map((t) => t.ref))];
    const runs = new Map((await this.runFacts(runIds)).map((r) => [r.id, r]));
    const messages: string[] = [];
    const keys: Key[] = [];
    const gone: Key[] = [];
    for (const t of taken) {
      const key = { kind: t.kind, ref: t.ref };
      const entry = t.kind === 'audit' ? audit.get(t.ref) : undefined;
      const run = t.kind !== 'audit' ? runs.get(t.ref) : undefined;
      if (entry) messages.push(formatAudit(entry, f));
      else if (run) messages.push(formatRun(run, t.kind === 'run-start' ? 'start' : 'end', f));
      else {
        gone.push(key);
        continue;
      }
      keys.push(key);
    }
    if (gone.length) await markDropped(this.o.db, sink, gone, 'What it was about is gone');
    return { messages, keys };
  }

  private async failed(sink: string, keys: Key[], taken: Taken[], error: string): Promise<void> {
    const attempts = Math.max(...taken.map((t) => t.attempts), 1);
    await markRetry(this.o.db, sink, keys, error, retryDelayMs(attempts));
    await sinkFailed(this.o.db, sink, error);
  }

  // --- runs

  private async runRows(ids: string[]) {
    if (!ids.length) return [];
    return this.o.db
      .selectFrom('run')
      .innerJoin('project', 'project.id', 'run.project_id')
      .select([
        'run.id',
        'run.number',
        'run.project_id',
        'project.name as project_name',
        'run.commit_id',
        'run.flow_file',
        'run.flow_key',
        'run.flow_name',
        'run.flow_version',
        'run.mode',
        'run.state',
        'run.requested_login',
        'run.created_at',
        'run.started_at',
        'run.claimed_at',
        'run.ended_at',
        'run.host_count',
        'run.failed_count',
        'run.error',
        'run.ee_image',
        'run.view_json',
      ])
      .where('run.id', 'in', ids)
      .execute();
  }

  /** What a run line says. Never its inputs. */
  private async runFacts(ids: string[]): Promise<RunTrace[]> {
    return (await this.runRows(ids)).map((r) => {
      let summary: RunTrace['summary'];
      try {
        summary = r.view_json ? JSON.parse(r.view_json).summary : undefined;
      } catch {}
      const facts: RunFacts = {
        id: r.id,
        number: Number(r.number),
        project: { id: r.project_id, name: r.project_name },
        flow: {
          key: r.flow_key,
          name: r.flow_name,
          version: Number(r.flow_version),
          file: r.flow_file,
        },
        mode: r.mode,
        state: r.state,
        requestedLogin: r.requested_login,
        createdAt: r.created_at,
        startedAt: r.started_at ?? r.claimed_at,
        endedAt: r.ended_at,
        hosts: r.host_count,
        failed: r.failed_count,
        error: r.error,
      };
      return {
        ...facts,
        commit: r.commit_id,
        eeImage: r.ee_image,
        ...(summary ? { summary } : {}),
      };
    });
  }

  // --- OpenTelemetry

  private async sendOtlp(sink: SinkForSending): Promise<void> {
    const o = sink.otlp;
    if (!o) return;
    const db = this.o.db;
    const options = {
      ...(o.ca ? { ca: o.ca } : {}),
      gzip: o.gzip,
      timeoutMs: o.timeoutSeconds * 1000,
      headers: sink.headerValues,
      agent: `ansible-flow-server/${this.o.version}`,
    };
    const resource = resourceOf({
      version: this.o.version,
      hostname: this.host,
      ...(o.environment ? { environment: o.environment } : {}),
    });
    for (let i = 0; i < BATCHES_PER_ROUND; i++) {
      const logs = await takeDue(db, sink.id, ['audit'], AUDIT_BATCH);
      const traces = await takeDue(db, sink.id, ['run-end'], RUN_BATCH);
      if (!logs.length && !traces.length) return;
      if (logs.length) {
        const entries = await auditEntries(
          db,
          logs.map((t) => t.ref),
        );
        const found = new Set(entries.map((e) => e.id));
        const gone = logs.filter((t) => !found.has(t.ref));
        if (gone.length) await markDropped(db, sink.id, gone, 'What it was about is gone');
        const keys = logs.filter((t) => found.has(t.ref));
        if (entries.length) {
          const sent = await post(
            o.endpoint,
            '/v1/logs',
            logsPayload(
              entries.map((e) => auditRecord(e)),
              resource,
            ),
            options,
          );
          if (!(await this.posted(sink, keys, sent))) return;
        }
      }
      if (traces.length) {
        const runs = await this.runFacts(traces.map((t) => t.ref));
        const found = new Set(runs.map((r) => r.id));
        const gone = traces.filter((t) => !found.has(t.ref));
        if (gone.length) await markDropped(db, sink.id, gone, 'What it was about is gone');
        const spans = [];
        for (const run of runs)
          spans.push(
            ...runSpans(run, await this.steps(run), {
              hostNames: o.hostNames,
              maxHostEvents: o.maxHostEvents,
            }),
          );
        if (spans.length) {
          const sent = await post(
            o.endpoint,
            '/v1/traces',
            tracesPayload(spans, resource),
            options,
          );
          if (
            !(await this.posted(
              sink,
              traces.filter((t) => found.has(t.ref)),
              sent,
            ))
          )
            return;
        }
      }
      if (logs.length < AUDIT_BATCH && traces.length < RUN_BATCH) return;
    }
  }

  private async steps(run: RunTrace): Promise<Record<string, StepName>> {
    if (!this.o.steps || !run.commit || !run.summary?.timings) return {};
    return this.o
      .steps({ project: run.project.id, commit: run.commit, file: run.flow.file })
      .catch(() => ({}));
  }

  /** Marks the rows by how the POST went; false when the destination failed. */
  private async posted(
    sink: SinkForSending,
    taken: Taken[],
    sent: Awaited<ReturnType<typeof post>>,
  ): Promise<boolean> {
    const db = this.o.db;
    const keys = taken.map((t) => ({ kind: t.kind, ref: t.ref }));
    if (sent.ok) {
      await markSent(db, sink.id, keys);
      await sinkSucceeded(db, sink.id);
      if (sent.rejected)
        this.o.log.warn(
          { sink: sink.id, rejected: sent.rejected },
          'A collector refused part of a batch',
        );
      return true;
    }
    const error = sent.error ?? 'Not sent';
    if (sent.retry) await this.failed(sink.id, keys, taken, error);
    else {
      // A payload the collector refuses is refused again: a bug of ours, kept in the log.
      this.o.log.error(
        { sink: sink.id, status: sent.status, why: error },
        'A collector refused a batch',
      );
      await markDropped(db, sink.id, keys, error);
      await sinkFailed(db, sink.id, error);
    }
    return false;
  }

  // --- a test from the page

  /** Sends one test message to a destination now, on its own connection; says how it went. */
  async test(id: string, by: string): Promise<SinkTest | undefined> {
    const sink = await sinkForSending(this.o.db, this.o.key, id);
    if (!sink) return undefined;
    try {
      if (sink.syslog) {
        const s = sink.syslog;
        const text = formatTest(by, this.format(s));
        if (s.transport === 'udp') {
          await sendUdp(s, [text]);
          return {
            ok: true,
            message: `Sent by UDP to ${s.host}:${s.port}: nothing says whether it arrived`,
          };
        }
        const wire = await (this.o.dial ?? dial)(s);
        try {
          await new Promise<void>((resolve, reject) => {
            wire.once('close', () => reject(new Error('the receiver closed the connection')));
            wire.write(frame(text, s.framing));
            // No acknowledgement: a receiver that stays connected a moment took it.
            setTimeout(resolve, 500);
          });
        } finally {
          wire.end();
          wire.destroy();
        }
        return {
          ok: true,
          message: `Sent to ${s.host}:${s.port} over ${s.transport.toUpperCase()}`,
        };
      }
      if (sink.otlp) {
        const o = sink.otlp;
        const sent = await post(
          o.endpoint,
          '/v1/logs',
          logsPayload(
            [testRecord(by)],
            resourceOf({
              version: this.o.version,
              hostname: this.host,
              ...(o.environment ? { environment: o.environment } : {}),
            }),
          ),
          {
            ...(o.ca ? { ca: o.ca } : {}),
            gzip: o.gzip,
            timeoutMs: o.timeoutSeconds * 1000,
            headers: sink.headerValues,
            agent: `ansible-flow-server/${this.o.version}`,
          },
        );
        return sent.ok
          ? { ok: true, message: `The collector took it (HTTP ${sent.status})` }
          : { ok: false, message: `Not sent: ${sent.error ?? 'no answer'}` };
      }
      return { ok: false, message: 'This destination has no settings' };
    } catch (e) {
      const why = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
      return { ok: false, message: `Not sent: ${why}` };
    }
  }
}
