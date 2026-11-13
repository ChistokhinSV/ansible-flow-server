// Runs, and the queue they wait in. A launch puts a run in the queue; a worker (the server's own
// executor, later a remote agent) takes one with a lease, keeps the lease alive while it works,
// and says how the run ended. Everything is in the database, so a run outlives the process that
// took it, and two servers on one database never take the same run.
//
//   queued ──claim──▶ running ──finish──▶ succeeded | failed | cancelled
//     ▲                 │ │
//     │   lease ends,   │ └──wait──▶ waiting ──resume──▶ queued
//     └── not started ──┘
//                       lease ends after it started ──▶ lost
//
// A run whose worker stops answering before the run started is given to another worker; after
// it started it is "lost", never started again: a real run may have changed machines halfway.
import { randomBytes, randomUUID } from 'node:crypto';
import { type Kysely, sql } from 'kysely';
import type { Schema } from '../db/schema';
import type { PreparedLaunch } from '../launch/prepare';
import { open, seal } from '../secrets/crypto';
import type { MasterKey } from '../secrets/masterKey';

export const STATES = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
  'lost',
] as const;
export type RunState = (typeof STATES)[number];
/** States a run is still going in. */
export const ACTIVE: readonly RunState[] = ['queued', 'running', 'waiting'];
/** How a worker may say a run ended. */
export type Outcome = 'succeeded' | 'failed' | 'cancelled';

/** How long a lease lasts without a heartbeat. */
export const LEASE_MS = 60_000;
/** A run given out this many times without starting is lost: something about it stops workers. */
export const MAX_ATTEMPTS = 3;

export interface Run {
  id: string;
  /** Counts the project's runs: 1, 2, 3… */
  number: number;
  project: string;
  /** The launch configuration it came from, as it was named then. */
  config?: { id: string; name: string };
  commit: string;
  /** The branch the commit was the newest of, when that is how it was found. */
  ref?: string;
  flow: { file: string; key: string; name: string; version: number };
  mode: 'check' | 'real';
  inventory?: string;
  eeImage?: string;
  limit?: string;
  /** The inputs, with secret-looking values shown as ***. */
  inputs: Record<string, unknown>;
  targets: string[];
  credentials: string[];
  state: RunState;
  requestedBy: { id: string; login: string };
  createdAt: string;
  /** When a worker took it last. */
  claimedAt?: string;
  /** When it began to change anything (or to check, for a check run). */
  startedAt?: string;
  endedAt?: string;
  /** How many times a worker took it. */
  attempts: number;
  /** Someone asked to stop it; the worker stops at its next heartbeat. */
  cancelRequested: boolean;
  /** Who stopped it, or asked to. */
  cancelledBy?: string;
  /** The worker that has it now. */
  worker?: string;
  /** Why it failed or was lost, in words for its page. */
  error?: string;
}

/** A run as a worker gets it: with its lease, and its inputs in full. */
export interface Job {
  run: Run;
  /** Proves the lease in every later call; a worker whose lease was given away has the old one. */
  token: string;
  leaseUntil: string;
  /** The inputs as the flow gets them, secrets included. Never log or show this. */
  inputs: Record<string, unknown>;
}

export interface QueueLimits {
  /** Runs at once on this server (all workers together). */
  maxRuns: number;
  /** Runs at once of one project: two runs on the same devices at once is rarely meant. */
  perProject: number;
}

export interface RunFilter {
  project?: string;
  /** The flow's file in the repository (with `project`). */
  flow?: string;
  state?: RunState;
  /** The newest first; at most this many (1 to 200). */
  limit?: number;
  /** Runs made before this time: the next page. */
  before?: string;
}

type Db = Kysely<Schema>;
type Row = Schema['run'];
const iso = (at: Date) => at.toISOString();
const later = (at: Date, ms: number) => new Date(at.getTime() + ms).toISOString();
const context = (id: string) => `run:${id}`;
/** One lock for the whole queue on PostgreSQL; SQLite has one writer anyway. */
const QUEUE_LOCK = 724_411_019;

export class RunQueue {
  constructor(
    private readonly db: Db,
    private readonly kind: 'sqlite' | 'postgres',
    private readonly key: MasterKey,
    readonly limits: QueueLimits = { maxRuns: 4, perProject: 1 },
  ) {}

  /** Runs `work` with the queue to itself: numbering and claiming must not interleave. */
  private locked<T>(work: (trx: Db) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      if (this.kind === 'postgres')
        await sql`select pg_advisory_xact_lock(${QUEUE_LOCK})`.execute(trx);
      return work(trx);
    });
  }

  private of(row: Row): Run {
    return {
      id: row.id,
      number: row.number,
      project: row.project_id,
      ...(row.config_id ? { config: { id: row.config_id, name: row.config_name ?? '' } } : {}),
      commit: row.commit_id,
      ...(row.git_ref ? { ref: row.git_ref } : {}),
      flow: {
        file: row.flow_file,
        key: row.flow_key,
        name: row.flow_name,
        version: row.flow_version,
      },
      mode: row.mode as Run['mode'],
      ...(row.inventory ? { inventory: row.inventory } : {}),
      ...(row.ee_image ? { eeImage: row.ee_image } : {}),
      ...(row.run_limit ? { limit: row.run_limit } : {}),
      inputs: JSON.parse(row.inputs_shown_json) as Record<string, unknown>,
      targets: JSON.parse(row.targets_json) as string[],
      credentials: JSON.parse(row.credentials_json) as string[],
      state: row.state as RunState,
      requestedBy: { id: row.requested_by, login: row.requested_login },
      createdAt: row.created_at,
      ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.ended_at ? { endedAt: row.ended_at } : {}),
      attempts: row.attempts,
      cancelRequested: row.cancel_requested === 1,
      ...(row.cancelled_by ? { cancelledBy: row.cancelled_by } : {}),
      ...(row.lease_owner ? { worker: row.lease_owner } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  /**
   * Puts a settled launch in the queue. `shown` is the inputs as anyone may see them (secrets
   * as ***); the inputs in full are kept sealed with the master key.
   */
  enqueue(
    launch: PreparedLaunch,
    shown: Record<string, unknown>,
    by: { id: string; login: string },
    configName?: string,
    now = new Date(),
  ): Promise<Run> {
    return this.locked(async (trx) => {
      const last = await trx
        .selectFrom('run')
        .select((eb) => eb.fn.max('number').as('n'))
        .where('project_id', '=', launch.project)
        .executeTakeFirst();
      const id = randomUUID();
      const at = iso(now);
      const row: Row = {
        id,
        number: Number(last?.n ?? 0) + 1,
        project_id: launch.project,
        config_id: launch.config,
        config_name: configName ?? null,
        commit_id: launch.commit,
        git_ref: launch.ref ?? null,
        flow_file: launch.flow.file,
        flow_key: launch.flow.key,
        flow_name: launch.flow.name,
        flow_version: launch.flow.version,
        mode: launch.mode,
        inventory: launch.inventory ?? null,
        ee_image: launch.eeImage ?? null,
        run_limit: launch.limit ?? null,
        inputs_enc: seal(this.key, JSON.stringify(launch.inputs), context(id)),
        inputs_shown_json: JSON.stringify(shown),
        targets_json: JSON.stringify(launch.targets),
        credentials_json: JSON.stringify(launch.credentials),
        state: 'queued',
        requested_by: by.id,
        requested_login: by.login,
        created_at: at,
        updated_at: at,
        claimed_at: null,
        started_at: null,
        ended_at: null,
        attempts: 0,
        lease_owner: null,
        lease_token: null,
        lease_until: null,
        cancel_requested: 0,
        cancelled_by: null,
        error: null,
        view_json: null,
        run_dir: null,
      };
      await trx.insertInto('run').values(row).execute();
      return this.of(row);
    });
  }

  /** How a run went, as the designer shows it; undefined until it ended (or when it never ran). */
  async view(id: string): Promise<unknown | undefined> {
    const row = await this.db
      .selectFrom('run')
      .select('view_json')
      .where('id', '=', id)
      .executeTakeFirst();
    return row?.view_json ? JSON.parse(row.view_json) : undefined;
  }

  async get(id: string): Promise<Run | undefined> {
    const row = await this.db.selectFrom('run').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? this.of(row) : undefined;
  }

  async list(filter: RunFilter = {}): Promise<Run[]> {
    let query = this.db
      .selectFrom('run')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('number', 'desc')
      .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200));
    if (filter.project) query = query.where('project_id', '=', filter.project);
    if (filter.flow) query = query.where('flow_file', '=', filter.flow);
    if (filter.state) query = query.where('state', '=', filter.state);
    if (filter.before) query = query.where('created_at', '<', filter.before);
    return (await query.execute()).map((row) => this.of(row));
  }

  /** How many runs a project has that are still going. */
  async activeCount(projectId: string): Promise<number> {
    const row = await this.db
      .selectFrom('run')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('project_id', '=', projectId)
      .where('state', 'in', [...ACTIVE])
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /**
   * Gives a worker the oldest queued run that fits the limits, with a lease; undefined when
   * there is none. A run of a project that has as many runs going as it may waits its turn,
   * and does not hold back runs of other projects behind it.
   */
  claim(worker: string, now = new Date()): Promise<Job | undefined> {
    return this.locked(async (trx) => {
      const running = await trx
        .selectFrom('run')
        .select(['project_id', (eb) => eb.fn.countAll().as('n')])
        .where('state', '=', 'running')
        .groupBy('project_id')
        .execute();
      const byProject = new Map(running.map((r) => [r.project_id, Number(r.n)]));
      const total = [...byProject.values()].reduce((a, b) => a + b, 0);
      if (total >= this.limits.maxRuns) return undefined;
      const queued = await trx
        .selectFrom('run')
        .selectAll()
        .where('state', '=', 'queued')
        .orderBy('created_at')
        .orderBy('number')
        .limit(500)
        .execute();
      const next = queued.find(
        (row) => (byProject.get(row.project_id) ?? 0) < this.limits.perProject,
      );
      if (!next) return undefined;
      const token = randomBytes(24).toString('base64url');
      const leaseUntil = later(now, LEASE_MS);
      await trx
        .updateTable('run')
        .set({
          state: 'running',
          claimed_at: iso(now),
          attempts: next.attempts + 1,
          lease_owner: worker.slice(0, 200),
          lease_token: token,
          lease_until: leaseUntil,
          updated_at: iso(now),
        })
        .where('id', '=', next.id)
        .where('state', '=', 'queued')
        .execute();
      const row = (await trx
        .selectFrom('run')
        .selectAll()
        .where('id', '=', next.id)
        .executeTakeFirst()) as Row;
      return {
        run: this.of(row),
        token,
        leaseUntil,
        inputs: JSON.parse(open(this.key, row.inputs_enc, context(row.id))) as Record<
          string,
          unknown
        >,
      };
    });
  }

  /** The run, when the token is its lease's and the lease has not run out. */
  private async leased(trx: Db, id: string, token: string, now: Date): Promise<Row | undefined> {
    const row = await trx.selectFrom('run').selectAll().where('id', '=', id).executeTakeFirst();
    if (row?.state !== 'running' || !row.lease_token || row.lease_token !== token) return undefined;
    if (!row.lease_until || row.lease_until <= iso(now)) return undefined;
    return row;
  }

  /**
   * Keeps a lease alive. Answers whether the worker still has the run, and whether someone
   * asked to stop it. A worker that is told it has lost the run stops at once.
   */
  heartbeat(
    id: string,
    token: string,
    now = new Date(),
  ): Promise<{ ok: false } | { ok: true; cancel: boolean; leaseUntil: string }> {
    return this.locked(async (trx) => {
      const row = await this.leased(trx, id, token, now);
      if (!row) return { ok: false as const };
      const leaseUntil = later(now, LEASE_MS);
      await trx
        .updateTable('run')
        .set({ lease_until: leaseUntil, updated_at: iso(now) })
        .where('id', '=', id)
        .execute();
      return { ok: true as const, cancel: row.cancel_requested === 1, leaseUntil };
    });
  }

  /**
   * The worker begins to run it: from now on, if the worker goes away, the run is lost rather
   * than given to another worker. A resumed run keeps the time it first started.
   */
  start(id: string, token: string, now = new Date(), runDir?: string): Promise<boolean> {
    return this.locked(async (trx) => {
      const row = await this.leased(trx, id, token, now);
      if (!row) return false;
      await trx
        .updateTable('run')
        .set({
          ...(row.started_at ? {} : { started_at: iso(now) }),
          ...(runDir ? { run_dir: runDir } : {}),
          updated_at: iso(now),
        })
        .where('id', '=', id)
        .execute();
      return true;
    });
  }

  /** The designer's folder of the run (its events), once it started. */
  async runDir(id: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('run')
      .select('run_dir')
      .where('id', '=', id)
      .executeTakeFirst();
    return row?.run_dir ?? undefined;
  }

  /** When the run's record last changed: watchers compare it to know there is news. */
  async changedAt(id: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('run')
      .select('updated_at')
      .where('id', '=', id)
      .executeTakeFirst();
    return row?.updated_at;
  }

  /**
   * The same run again: the same commit, flow, mode, inputs (secrets too) and credentials, as a
   * new run in the queue, asked for by `by`. Undefined when there is no such run.
   */
  relaunch(
    id: string,
    by: { id: string; login: string },
    now = new Date(),
  ): Promise<Run | undefined> {
    return this.locked(async (trx) => {
      const old = await trx.selectFrom('run').selectAll().where('id', '=', id).executeTakeFirst();
      if (!old) return undefined;
      const last = await trx
        .selectFrom('run')
        .select((eb) => eb.fn.max('number').as('n'))
        .where('project_id', '=', old.project_id)
        .executeTakeFirst();
      const fresh = randomUUID();
      const at = iso(now);
      const row: Row = {
        ...old,
        id: fresh,
        number: Number(last?.n ?? 0) + 1,
        // The inputs are sealed to their run: opened from the old one, sealed to the new one.
        inputs_enc: seal(this.key, open(this.key, old.inputs_enc, context(old.id)), context(fresh)),
        state: 'queued',
        requested_by: by.id,
        requested_login: by.login,
        created_at: at,
        updated_at: at,
        claimed_at: null,
        started_at: null,
        ended_at: null,
        attempts: 0,
        lease_owner: null,
        lease_token: null,
        lease_until: null,
        cancel_requested: 0,
        cancelled_by: null,
        error: null,
        view_json: null,
        run_dir: null,
      };
      await trx.insertInto('run').values(row).execute();
      return this.of(row);
    });
  }

  /** How the run ended. False when the worker no longer had it (its word is not taken). */
  finish(
    id: string,
    token: string,
    outcome: Outcome,
    error?: string,
    now = new Date(),
    /** How it went, as the designer shows it. */
    view?: unknown,
  ): Promise<boolean> {
    return this.locked(async (trx) => {
      const row = await this.leased(trx, id, token, now);
      if (!row) return false;
      await trx
        .updateTable('run')
        .set({
          state: outcome,
          ...(view !== undefined ? { view_json: JSON.stringify(view) } : {}),
          ended_at: iso(now),
          started_at: row.started_at ?? iso(now),
          error: outcome === 'succeeded' ? null : (error?.slice(0, 2000) ?? null),
          lease_owner: null,
          lease_token: null,
          lease_until: null,
          updated_at: iso(now),
        })
        .where('id', '=', id)
        .execute();
      return true;
    });
  }

  /**
   * The run waits for a decision (an approval): the worker lets it go, and no worker has it
   * until it is resumed. A waiting run takes no place in the limits.
   */
  wait(id: string, token: string, now = new Date()): Promise<boolean> {
    return this.locked(async (trx) => {
      const row = await this.leased(trx, id, token, now);
      if (!row) return false;
      await trx
        .updateTable('run')
        .set({
          state: 'waiting',
          started_at: row.started_at ?? iso(now),
          lease_owner: null,
          lease_token: null,
          lease_until: null,
          updated_at: iso(now),
        })
        .where('id', '=', id)
        .execute();
      return true;
    });
  }

  /** A waiting run goes on: back in the queue, for the next worker to continue it. */
  resume(id: string, now = new Date()): Promise<boolean> {
    return this.locked(async (trx) => {
      const done = await trx
        .updateTable('run')
        .set({ state: 'queued', updated_at: iso(now) })
        .where('id', '=', id)
        .where('state', '=', 'waiting')
        .executeTakeFirst();
      return Number(done.numUpdatedRows) > 0;
    });
  }

  /**
   * Stops a run. One that no worker has (queued, waiting) is cancelled at once; one a worker
   * has is asked to stop, and the worker says when it has. Undefined when there is no such run;
   * a run that has ended is left as it is.
   */
  cancel(id: string, by: string, now = new Date()): Promise<Run | undefined> {
    return this.locked(async (trx) => {
      const row = await trx.selectFrom('run').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row) return undefined;
      if (row.state === 'queued' || row.state === 'waiting')
        await trx
          .updateTable('run')
          .set({
            state: 'cancelled',
            cancel_requested: 1,
            cancelled_by: by,
            ended_at: iso(now),
            updated_at: iso(now),
          })
          .where('id', '=', id)
          .execute();
      else if (row.state === 'running' && row.cancel_requested === 0)
        await trx
          .updateTable('run')
          .set({ cancel_requested: 1, cancelled_by: by, updated_at: iso(now) })
          .where('id', '=', id)
          .execute();
      const after = await trx.selectFrom('run').selectAll().where('id', '=', id).executeTakeFirst();
      return after ? this.of(after) : undefined;
    });
  }

  /**
   * Runs whose lease ran out: the worker stopped answering. Not started yet: back in the queue
   * (or cancelled, if that was asked; or lost after MAX_ATTEMPTS). Started: lost.
   */
  expire(now = new Date()): Promise<{ requeued: number; lost: number; cancelled: number }> {
    return this.locked(async (trx) => {
      const rows = await trx
        .selectFrom('run')
        .selectAll()
        .where('state', '=', 'running')
        .where('lease_until', '<=', iso(now))
        .execute();
      const counts = { requeued: 0, lost: 0, cancelled: 0 };
      for (const row of rows) {
        const released = {
          lease_owner: null,
          lease_token: null,
          lease_until: null,
          updated_at: iso(now),
        };
        if (row.started_at)
          await trx
            .updateTable('run')
            .set({
              ...released,
              state: 'lost',
              ended_at: iso(now),
              error:
                `The worker ${row.lease_owner ?? ''} stopped answering while the run was going: what it did is not known`.replace(
                  '  ',
                  ' ',
                ),
            })
            .where('id', '=', row.id)
            .execute();
        else if (row.cancel_requested === 1)
          await trx
            .updateTable('run')
            .set({ ...released, state: 'cancelled', ended_at: iso(now) })
            .where('id', '=', row.id)
            .execute();
        else if (row.attempts >= MAX_ATTEMPTS)
          await trx
            .updateTable('run')
            .set({
              ...released,
              state: 'lost',
              ended_at: iso(now),
              error: `Given to a worker ${row.attempts} times, and no worker started it`,
            })
            .where('id', '=', row.id)
            .execute();
        else
          await trx
            .updateTable('run')
            .set({ ...released, state: 'queued' })
            .where('id', '=', row.id)
            .execute();
        if (row.started_at || (row.cancel_requested !== 1 && row.attempts >= MAX_ATTEMPTS))
          counts.lost++;
        else if (row.cancel_requested === 1) counts.cancelled++;
        else counts.requeued++;
      }
      return counts;
    });
  }
}
