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
import type { PreparedLaunch, StepAsked } from '../launch/prepare';
import { open, seal } from '../secrets/crypto';
import type { MasterKey } from '../secrets/masterKey';
import { type LastRun, readBefore } from './cursor';
import { hostCounts } from './hostCounts';
import { stoppedBy } from './words';

export type { LastRun };

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
  /** AFS-143: `name`, the person's display name, where the API adds it (runs/routes.ts). */
  requestedBy: { id: string; login: string; name?: string };
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
  /** AFS-105: the hosts it ran on and those that failed, once it went. */
  hosts?: { total: number; failed: number };
  /** AFS-26: a dev run: a check run of someone's unpushed work. */
  dev?: true;
  /** AFS-34: the schedule that launched it. */
  schedule?: string;
  /** AFS-175: started through an action: the action's title then. */
  action?: string;
  /**
   * AFS-146: a failed run that failed because its approval was rejected (or nobody decided in
   * time): the pages say so, not "failed". Added by the API (runs/routes.ts).
   */
  decidedAgainst?: 'rejected' | 'timed out';
  /**
   * AFS-147: on one run's page (GET /runs/:id and its events): its credentials by name (one that
   * is gone by its id), the environment its image came from, and the targets Ansible skipped
   * because the inventory does not have them.
   */
  credentialNames?: string[];
  environment?: { id: string; name: string; workspace: string };
  skippedTargets?: string[];
  /**
   * AFS-163, AFS-170: the run's image was the server's default as it started (recorded then). Runs
   * from before that was recorded are judged by their launch configuration as it is now
   * (runs/routes.ts).
   */
  serverDefault?: true;
  /** AFS-177: a step-by-step run: what it was asked for. */
  step?: StepAsked;
  /** AFS-177: the step a step-by-step run is paused before now (its title). */
  pausedBefore?: string;
  /**
   * AFS-214: a run of another run again: that run, the hosts it took (`all`, a set, or `chosen`
   * names) and how many (absent for `all`).
   */
  relaunchOf?: RelaunchOf;
}

/** AFS-214: the run a run is again, and which of its hosts. */
export interface RelaunchOf {
  id: string;
  number: number;
  hosts: 'all' | 'not-ok' | 'failed' | 'unreachable' | 'stopped' | 'chosen';
  count?: number;
}

/**
 * AFS-240: what a run again is made of, settled by the relaunch route through the launch's checks:
 * the commit and flow, the mode, the image, the credentials its configuration gives now, how it
 * steps, the hosts it is limited to. `inputs` (with `shown`, as anyone may see them) when they are
 * not the old run's own (at the newest commit, read again as that flow's types).
 */
export interface RelaunchPlan {
  commit: string;
  ref?: string;
  flow: Run['flow'];
  mode: Run['mode'];
  inventory?: string;
  eeImage?: string;
  limit?: string;
  inputs?: Record<string, unknown>;
  shown?: Record<string, unknown>;
  targets?: string[];
  credentials: string[];
  /** null: not step by step. */
  step: StepAsked | null;
  /** The hosts it runs on, written to its limit file; absent: as the old run's limit says. */
  limitHosts?: string[];
  relaunchOf: RelaunchOf;
}

/**
 * AFS-177: what a step-by-step run keeps: what it was asked for, and what its driver said last
 * (`control`: carried into the segment after an approval).
 */
export interface StepRecord extends StepAsked {
  control?: { v: 1; command: 'step' | 'continue' | 'pause' | 'stop'; points: string[] };
}

/**
 * AFS-205: a run shown as paused (a step-by-step run waiting before a step for Step or Continue):
 * still `running` to the API, "paused" in the pages' words and filters.
 */
export const isPaused = (run: Pick<Run, 'state' | 'pausedBefore'>): boolean =>
  run.state === 'running' && !!run.pausedBefore;

/** AFS-177: why a run that was paused when its server went away ended (it cannot go on). */
export const pausedGone = (title: string, how: 'restarted' | 'stopped' = 'restarted') =>
  `Stopped: the server ${how} while the run was paused before ${title}; a paused run cannot go on after a restart`;

/** A run as a worker gets it: with its lease, and its inputs in full. */
export interface Job {
  run: Run;
  /** Proves the lease in every later call; a worker whose lease was given away has the old one. */
  token: string;
  leaseUntil: string;
  /** The inputs as the flow gets them, secrets included. Never log or show this. */
  inputs: Record<string, unknown>;
  /** AFS-240: the hosts the run is limited to (its limit file), when it is a run again of some. */
  limitHosts?: string[];
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
  /**
   * AFS-193: `rejected` is a failed run whose approval was rejected or not decided in time;
   * `failed` leaves those out. AFS-205: `paused` is a step-by-step run paused before a step (its
   * state is `running`); `waiting` has those too: both wait for a person. AFS-232: `going` is a
   * run queued or running and not paused (Home's "still go").
   */
  state?: RunState | 'rejected' | 'paused' | 'going';
  /** Runs of this launch configuration (its id). */
  config?: string;
  /** Runs this person asked for (their login). */
  by?: string;
  /** AFS-147: text in the flow's name or file, the configuration's name or the launcher's login. */
  q?: string;
  /** The newest first; at most this many (1 to 200). */
  limit?: number;
  /**
   * The next page: the runs after the one a cursor names (`runCursor`), or the runs made before
   * a time. A time alone skips runs made in the same millisecond as a page's last one.
   */
  before?: string;
  /**
   * Only runs someone may see (AFS-27): of these workspaces, or of these flows (project, file).
   * Absent: every run.
   */
  visible?: { workspaces: string[]; flows: [string, string][] };
}

type Db = Kysely<Schema>;
type Row = Schema['run'];
const iso = (at: Date) => at.toISOString();
const later = (at: Date, ms: number) => new Date(at.getTime() + ms).toISOString();
const context = (id: string) => `run:${id}`;
/** One lock for the whole queue on PostgreSQL; SQLite has one writer anyway. */
const QUEUE_LOCK = 724_411_019;

export class RunQueue {
  /**
   * AFS-29: told of each run that ended (succeeded, failed, cancelled, lost), however it ended,
   * once what ended it is in the database.
   */
  onEnded?: (id: string) => void;
  /**
   * AFS-131: told at once when someone asks a running run to stop, so the worker that has it
   * stops it now rather than at its next heartbeat (a short run had ended by then).
   */
  onStopAsked?: (id: string) => void;
  /** AFS-53: told of each run a worker took (again, when its first worker went away). */
  onStarted?: (id: string) => void;

  constructor(
    private readonly db: Db,
    private readonly kind: 'sqlite' | 'postgres',
    private readonly key: MasterKey,
    readonly limits: QueueLimits = { maxRuns: 4, perProject: 1 },
  ) {}

  private ended(ids: string[]): void {
    for (const id of ids) this.onEnded?.(id);
  }

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
      ...(row.host_count !== null
        ? { hosts: { total: row.host_count, failed: row.failed_count ?? 0 } }
        : {}),
      ...(row.dev_bundle ? { dev: true } : {}),
      ...(row.schedule_id ? { schedule: row.schedule_id } : {}),
      ...(row.action_title ? { action: row.action_title } : {}),
      ...(row.ee_default === 1 ? { serverDefault: true as const } : {}),
      ...(row.step_json ? { step: stepAsked(row.step_json) } : {}),
      ...(row.step_paused ? { pausedBefore: row.step_paused } : {}),
      ...(row.relaunch_of_json
        ? { relaunchOf: JSON.parse(row.relaunch_of_json) as RelaunchOf }
        : {}),
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
        ee_default: launch.eeImage ? 0 : null,
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
        host_count: null,
        failed_count: null,
        run_dir: null,
        segments_json: null,
        dev_bundle: launch.dev ?? null,
        schedule_id: launch.schedule ?? null,
        action_title: launch.action ?? null,
        step_json: launch.step ? JSON.stringify(launch.step) : null,
        step_paused: null,
        relaunch_of_json: null,
        limit_hosts_json: null,
      };
      await trx.insertInto('run').values(row).execute();
      return this.of(row);
    });
  }

  /** How a run went, as the designer shows it; undefined until it ended (or when it never ran). */
  async view(id: string): Promise<unknown | undefined> {
    const row = await this.db
      .selectFrom('run')
      .select(['view_json', 'state', 'error'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row?.view_json ? failedView(JSON.parse(row.view_json), row.state, row.error) : undefined;
  }

  /**
   * AFS-240: a run's inputs in full, secrets too, for a run again of it (checked as a launch's).
   * Never log or show this.
   */
  async inputsOf(id: string): Promise<Record<string, unknown> | undefined> {
    const row = await this.db
      .selectFrom('run')
      .select('inputs_enc')
      .where('id', '=', id)
      .executeTakeFirst();
    return row
      ? (JSON.parse(open(this.key, row.inputs_enc, context(id))) as Record<string, unknown>)
      : undefined;
  }

  /** AFS-185: a person's name by their login, as the pages show people (the login if none). */
  personName(login: string): Promise<string> {
    return nameOf(this.db, login);
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
      // Numbers count within a project: the id settles runs of two projects made at once, so
      // that the order is the same each time and a page can go on where the last one ended.
      .orderBy('id', 'desc')
      .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200));
    if (filter.project) query = query.where('project_id', '=', filter.project);
    if (filter.flow) query = query.where('flow_file', '=', filter.flow);
    if (filter.state === 'rejected' || filter.state === 'failed') {
      const against = this.db
        .selectFrom('run_gate')
        .select('run_gate.run_id')
        .where('run_gate.status', 'in', ['rejected', 'timed out']);
      query = query
        .where('state', '=', 'failed')
        .where('id', filter.state === 'rejected' ? 'in' : 'not in', against);
    } else if (filter.state === 'paused')
      query = query.where('state', '=', 'running').where('step_paused', 'is not', null);
    else if (filter.state === 'going')
      query = query.where((eb) =>
        eb.or([
          eb('state', '=', 'queued'),
          eb.and([eb('state', '=', 'running'), eb('step_paused', 'is', null)]),
        ]),
      );
    else if (filter.state === 'waiting')
      query = query.where((eb) =>
        eb.or([
          eb('state', '=', 'waiting'),
          eb.and([eb('state', '=', 'running'), eb('step_paused', 'is not', null)]),
        ]),
      );
    else if (filter.state) query = query.where('state', '=', filter.state);
    if (filter.config) query = query.where('config_id', '=', filter.config);
    if (filter.by) query = query.where('requested_login', '=', filter.by);
    const words = filter.q?.trim().toLowerCase();
    if (words) {
      // Typed text is matched as it is: % and _ are not wildcards here.
      const like = `%${words.replace(/[!%_]/g, (c) => `!${c}`)}%`;
      const number = /^#?(\d+)$/.exec(words)?.[1];
      query = query.where((eb) =>
        eb.or([
          sql<boolean>`lower(flow_name) like ${like} escape '!'`,
          sql<boolean>`lower(flow_file) like ${like} escape '!'`,
          sql<boolean>`lower(coalesce(config_name, '')) like ${like} escape '!'`,
          sql<boolean>`lower(requested_login) like ${like} escape '!'`,
          ...(number ? [eb('number', '=', Number(number))] : []),
        ]),
      );
    }
    const before = filter.before ? readBefore(filter.before) : undefined;
    const last = before?.run;
    if (before && last)
      query = query.where((eb) =>
        eb.or([
          eb('created_at', '<', before.createdAt),
          eb.and([
            eb('created_at', '=', before.createdAt),
            eb.or([
              eb('number', '<', last.number),
              eb.and([eb('number', '=', last.number), eb('id', '<', last.id)]),
            ]),
          ]),
        ]),
      );
    else if (before) query = query.where('created_at', '<', before.createdAt);
    const visible = filter.visible;
    if (visible) {
      if (!visible.workspaces.length && !visible.flows.length) return [];
      query = query.where((eb) =>
        eb.or([
          ...(visible.workspaces.length
            ? [
                eb(
                  'project_id',
                  'in',
                  eb
                    .selectFrom('project')
                    .select('project.id')
                    .where('project.workspace_id', 'in', visible.workspaces),
                ),
              ]
            : []),
          ...visible.flows.map(([project, file]) =>
            eb.and([eb('project_id', '=', project), eb('flow_file', '=', file)]),
          ),
        ]),
      );
    }
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
   * AFS-232: why a run launched by another run of the same project waits for a place: the project
   * runs as many at once as it may, and the launching run holds one of them until it ends (a
   * run waiting for its child there would wait for ever). Undefined when it does not.
   */
  async heldByLauncher(run: Run, launcher: string): Promise<string | undefined> {
    if (run.state !== 'queued') return undefined;
    const parent = await this.get(launcher);
    if (!parent || parent.project !== run.project || parent.state !== 'running') return undefined;
    const row = await this.db
      .selectFrom('run')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('project_id', '=', run.project)
      .where('state', '=', 'running')
      .executeTakeFirstOrThrow();
    if (Number(row.n) < this.limits.perProject) return undefined;
    const n = this.limits.perProject;
    return `It waits for a place: this project runs ${n === 1 ? 'one run' : `${n} runs`} at once (AFS_MAX_RUNS_PER_PROJECT), and run #${parent.number}, which launched it, holds ${n === 1 ? 'it' : 'one'} until it ends`;
  }

  /**
   * Gives a worker the oldest queued run that fits the limits, with a lease; undefined when
   * there is none. A run of a project that has as many runs going as it may waits its turn,
   * and does not hold back runs of other projects behind it.
   */
  async claim(worker: string, now = new Date()): Promise<Job | undefined> {
    const job = await this.claimed(worker, now);
    if (job) this.onStarted?.(job.run.id);
    return job;
  }

  private claimed(worker: string, now: Date): Promise<Job | undefined> {
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
        ...(row.limit_hosts_json
          ? { limitHosts: JSON.parse(row.limit_hosts_json) as string[] }
          : {}),
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

  /**
   * AFS-163: the image a run without its own got (the server's default then), kept on the run so
   * its page says what it ran in.
   */
  async keepImage(id: string, image: string): Promise<void> {
    await this.db
      .updateTable('run')
      .set({ ee_image: image, ee_default: 1 })
      .where('id', '=', id)
      .where('ee_image', 'is', null)
      .execute();
  }

  /**
   * AFS-177: the step a step-by-step run is paused before now (its title), or none: kept while
   * the worker has it, so that a server that went away ends it as stopped, not lost.
   */
  async setPaused(id: string, token: string, title: string | null): Promise<void> {
    await this.db
      .updateTable('run')
      .set({ step_paused: title ? title.slice(0, 300) : null })
      .where('id', '=', id)
      .where('lease_token', '=', token)
      .execute();
  }

  /** AFS-177: what a step-by-step run keeps (with its driver's last word); none for others. */
  async stepRecord(id: string): Promise<StepRecord | undefined> {
    const row = await this.db
      .selectFrom('run')
      .select('step_json')
      .where('id', '=', id)
      .executeTakeFirst();
    return row?.step_json ? (JSON.parse(row.step_json) as StepRecord) : undefined;
  }

  /**
   * AFS-177: what the driver said last, for the segment after an approval. AFS-205: and who set
   * the pause points it has now, when someone changed them.
   */
  async keepControl(id: string, control: StepRecord['control'], pointsBy?: string): Promise<void> {
    const step = await this.stepRecord(id);
    if (!step) return;
    await this.db
      .updateTable('run')
      .set({
        step_json: JSON.stringify({ ...step, control, ...(pointsBy ? { pointsBy } : {}) }),
      })
      .where('id', '=', id)
      .execute();
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

  /**
   * AFS-28: the segments a run of a flow with approvals has run, in order, each with the
   * designer's folder of its events. A run without approvals has none (its folder is run_dir).
   */
  async segments(id: string): Promise<{ name: string; dir: string }[]> {
    const row = await this.db
      .selectFrom('run')
      .select('segments_json')
      .where('id', '=', id)
      .executeTakeFirst();
    return row?.segments_json ? JSON.parse(row.segments_json) : [];
  }

  /** A segment begins: its folder is the run's current one, after the segments before it. */
  addSegment(
    id: string,
    token: string,
    segment: { name: string; dir: string },
    now = new Date(),
  ): Promise<boolean> {
    return this.locked(async (trx) => {
      const row = await this.leased(trx, id, token, now);
      if (!row) return false;
      const list = row.segments_json ? JSON.parse(row.segments_json) : [];
      await trx
        .updateTable('run')
        .set({
          segments_json: JSON.stringify([...list, segment]),
          run_dir: segment.dir,
          ...(row.started_at ? {} : { started_at: iso(now) }),
          updated_at: iso(now),
        })
        .where('id', '=', id)
        .execute();
      return true;
    });
  }

  /** How the run went so far, while it waits: what its page and canvas show. */
  async saveView(id: string, view: unknown, now = new Date()): Promise<void> {
    await this.db
      .updateTable('run')
      .set({ view_json: JSON.stringify(view), ...hostCounts(view), updated_at: iso(now) })
      .where('id', '=', id)
      .execute();
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
   * The run again, as a new run in the queue asked for by `by`: what `plan` settles (AFS-240: the
   * relaunch route, through the launch's checks); without one, the same commit, flow, mode, inputs
   * (secrets too), credentials and hosts. Undefined when there is no such run.
   */
  relaunch(
    id: string,
    by: { id: string; login: string },
    plan?: RelaunchPlan,
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
      // The inputs are sealed to their run: opened from the old one, sealed to the new one.
      const inputs = plan?.inputs
        ? JSON.stringify(plan.inputs)
        : open(this.key, old.inputs_enc, context(old.id));
      // AFS-177: steps again as it was asked to, from the start (not where its driver left it).
      const step =
        plan === undefined
          ? old.step_json
            ? JSON.stringify(stepAsked(old.step_json))
            : null
          : plan.step
            ? JSON.stringify(plan.step)
            : null;
      const row: Row = {
        ...old,
        id: fresh,
        number: Number(last?.n ?? 0) + 1,
        ...(plan
          ? {
              commit_id: plan.commit,
              git_ref: plan.ref ?? null,
              flow_file: plan.flow.file,
              flow_key: plan.flow.key,
              flow_name: plan.flow.name,
              flow_version: plan.flow.version,
              mode: plan.mode,
              inventory: plan.inventory ?? null,
              ee_image: plan.eeImage ?? null,
              ee_default: plan.eeImage
                ? old.ee_image === plan.eeImage
                  ? old.ee_default
                  : 0
                : null,
              // The hosts' limit file takes the place of the old run's limit (ADR-0038 §2).
              run_limit: plan.limitHosts ? null : (plan.limit ?? null),
              credentials_json: JSON.stringify(plan.credentials),
              ...(plan.shown ? { inputs_shown_json: JSON.stringify(plan.shown) } : {}),
              ...(plan.targets ? { targets_json: JSON.stringify(plan.targets) } : {}),
              relaunch_of_json: JSON.stringify(plan.relaunchOf),
              // A run again of a run again of some hosts keeps to those hosts.
              limit_hosts_json: plan.limitHosts
                ? JSON.stringify(plan.limitHosts)
                : old.limit_hosts_json,
            }
          : {}),
        inputs_enc: seal(this.key, inputs, context(fresh)),
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
        host_count: null,
        failed_count: null,
        run_dir: null,
        segments_json: null,
        step_json: step,
        step_paused: null,
      };
      await trx.insertInto('run').values(row).execute();
      return this.of(row);
    });
  }

  /** How the run ended. False when the worker no longer had it (its word is not taken). */
  async finish(
    id: string,
    token: string,
    outcome: Outcome,
    error?: string,
    now = new Date(),
    /** How it went, as the designer shows it. */
    view?: unknown,
  ): Promise<boolean> {
    const done = await this.locked(async (trx) => {
      const row = await this.leased(trx, id, token, now);
      if (!row) return false;
      // AFS-185 (was AFS-131): a run whose steps all ended before the stop reached it is
      // recorded as it ended: its hosts reached the flow's ends; it was not stopped.
      const state: Outcome = outcome;
      // AFS-147: who stopped it, by the name the pages show people by.
      const who = row.cancelled_by ? await nameOf(trx, row.cancelled_by) : undefined;
      const why = state === 'cancelled' ? stoppedBy(error, who) : error;
      await trx
        .updateTable('run')
        .set({
          state,
          ...(view !== undefined ? { view_json: JSON.stringify(view), ...hostCounts(view) } : {}),
          ended_at: iso(now),
          started_at: row.started_at ?? iso(now),
          error: state === 'succeeded' ? null : (why?.slice(0, 2000) ?? null),
          lease_owner: null,
          lease_token: null,
          lease_until: null,
          step_paused: null,
          updated_at: iso(now),
        })
        .where('id', '=', id)
        .execute();
      return true;
    });
    if (done) this.ended([id]);
    return done;
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
  async cancel(id: string, by: string, now = new Date()): Promise<Run | undefined> {
    let endedNow = false;
    const run = await this.locked(async (trx) => {
      const row = await trx.selectFrom('run').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row) return undefined;
      endedNow = row.state === 'queued' || row.state === 'waiting';
      // AFS-147: a run stopped before it went on says who stopped it and where it was.
      const who = endedNow ? await nameOf(trx, by) : by;
      const gate =
        row.state === 'waiting'
          ? await trx
              .selectFrom('run_gate')
              .select(['title', 'node_id'])
              .where('run_id', '=', id)
              .where('status', '=', 'waiting')
              .executeTakeFirst()
          : undefined;
      if (row.state === 'queued' || row.state === 'waiting')
        await trx
          .updateTable('run')
          .set({
            state: 'cancelled',
            cancel_requested: 1,
            cancelled_by: by,
            ended_at: iso(now),
            updated_at: iso(now),
            error:
              row.state === 'queued'
                ? `Stopped by ${who} before it started`
                : `Stopped by ${who} while it waited for approval${gate ? ` at ${gate.title}` : ''}`,
            // AFS-110: what the canvas shows of it ends too: a run stopped while it waited for a
            // decision no longer reads as waiting there (nothing else writes its view any more).
            ...(row.view_json
              ? { view_json: JSON.stringify(stoppedView(row.view_json, who, gate?.node_id)) }
              : {}),
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
    if (endedNow) this.ended([id]);
    else if (run?.state === 'running' && run.cancelRequested) this.onStopAsked?.(id);
    return run;
  }

  /**
   * Runs whose lease ran out: the worker stopped answering. Not started yet: back in the queue
   * (or cancelled, if that was asked; or lost after MAX_ATTEMPTS). Started: lost.
   */
  async expire(now = new Date()): Promise<{ requeued: number; lost: number; cancelled: number }> {
    const gone: string[] = [];
    const result = await this.locked(async (trx) => {
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
        // AFS-177: a step-by-step run paused when its worker went away waited for a person and
        // changed nothing since its last step: it is stopped (it cannot go on), not lost.
        if (row.started_at && row.step_paused)
          await trx
            .updateTable('run')
            .set({
              ...released,
              state: 'cancelled',
              ended_at: iso(now),
              step_paused: null,
              error: pausedGone(row.step_paused),
              ...(row.view_json
                ? { view_json: JSON.stringify(pausedGoneView(row.view_json, row.step_paused)) }
                : {}),
            })
            .where('id', '=', row.id)
            .execute();
        else if (row.started_at)
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
        if (row.started_at && row.step_paused) counts.cancelled++;
        else if (row.started_at || (row.cancel_requested !== 1 && row.attempts >= MAX_ATTEMPTS))
          counts.lost++;
        else if (row.cancel_requested === 1) counts.cancelled++;
        else counts.requeued++;
        if (row.started_at || row.cancel_requested === 1 || row.attempts >= MAX_ATTEMPTS)
          gone.push(row.id);
      }
      return counts;
    });
    this.ended(gone);
    return result;
  }
}

/**
 * The newest run of each launch configuration of a project (`by: 'config'`, keyed by the
 * configuration's id) or of each of its flows (`by: 'flow'`, keyed by the flow's file), among
 * the runs of flows `maySee` allows. One question for the whole project, not one per row.
 */
export async function lastRuns(
  db: Db,
  project: string,
  by: 'config' | 'flow',
  maySee: (flowFile: string) => boolean,
  /** Only this launch configuration (with `by: 'config'`). */
  config?: string,
): Promise<Map<string, LastRun>> {
  // A project's runs are numbered as they are made: the highest number is the newest. A
  // configuration can have run more than one flow (it was pointed at another since), and
  // someone may see one and not the other: the newest of each pair is read, and which of
  // them count is settled here.
  const rows = await db
    .selectFrom('run')
    .select(['id', 'number', 'state', 'created_at', 'ended_at', 'config_id', 'flow_file'])
    .where('project_id', '=', project)
    .where('number', 'in', (eb) => {
      let newest = eb
        .selectFrom('run as r')
        .select((s) => s.fn.max('r.number').as('n'))
        .where('r.project_id', '=', project);
      if (by === 'config') {
        newest = newest.where('r.config_id', 'is not', null);
        if (config) newest = newest.where('r.config_id', '=', config);
      }
      return newest.groupBy(by === 'config' ? ['r.config_id', 'r.flow_file'] : ['r.flow_file']);
    })
    .execute();
  const out = new Map<string, LastRun>();
  for (const row of rows) {
    const key = by === 'config' ? row.config_id : row.flow_file;
    if (!key || !maySee(row.flow_file)) continue;
    const has = out.get(key);
    if (has && has.number > row.number) continue;
    out.set(key, {
      id: row.id,
      number: row.number,
      state: row.state,
      createdAt: row.created_at,
      ...(row.ended_at ? { endedAt: row.ended_at } : {}),
    });
  }
  return out;
}

/**
 * AFS-185: a run the server called failed whose view reads as Ansible's success (it reached no
 * host, a rejection ended it): the view says failed, with the reason, so the flow page's Run panel
 * and badge never say "went well" for it.
 */
export function failedView(view: unknown, state: string, error: string | null): unknown {
  const v = view as { state?: string; rc?: number; error?: string } | null;
  if (state !== 'failed' || !v || v.state !== 'done' || v.rc !== 0 || v.error) return view;
  const { rc: _rc, ...rest } = v;
  return { ...rest, state: 'error', error: error ?? 'The run failed' };
}

/**
 * AFS-110: the view of a run stopped before it ran on (queued, or waiting at an approval): ended,
 * with who stopped it, and no approval waiting any more.
 */
export function stoppedView(viewJson: string, by: string, at?: string): unknown {
  const { rc: _rc, ...view } = JSON.parse(viewJson) as {
    state?: string;
    rc?: number;
    error?: string;
    approvals?: Record<string, { status: string }>;
    summary?: { running?: string };
  };
  const approvals = Object.fromEntries(
    Object.entries(view.approvals ?? {}).filter(([, a]) => a.status !== 'waiting'),
  );
  // AFS-147: nothing runs any more: no step reads as running, and the step it stopped at is named.
  const { running: _running, ...summary } = view.summary ?? {};
  return {
    ...view,
    ...(view.summary ? { summary } : {}),
    ...(at ? { stoppedAt: at } : {}),
    // An error with the reason, no exit code: the part that ran ended well, the run did not (an
    // exit 0 read as success). The designer then says "Run interrupted" with the reason.
    state: 'error',
    errorCode: 'cancelled',
    error: `Stopped by ${by} before it went on`,
    ...(view.approvals ? { approvals } : {}),
  };
}

/** AFS-177: what a step-by-step run was asked for, from its record (its driver's word left out). */
export function stepAsked(json: string): StepAsked {
  const s = JSON.parse(json) as StepRecord;
  // AFS-205: the pause points it has now (changed while it went), and whose they are.
  return {
    every: s.every,
    points: s.control?.points ?? s.points ?? [],
    timeoutS: s.timeoutS,
    ...(s.pointsBy ? { pointsBy: s.pointsBy } : {}),
    // AFS-214: a debug run (Debug this failure), and pause when a host fails: the designer's
    // engine reads them (ADR-0040); kept and passed on as they were asked.
    ...(s.debug ? { debug: true } : {}),
    ...(s.pauseOnFailure ? { pauseOnFailure: true } : {}),
  };
}

/** AFS-177: the view of a paused run whose server went away: ended as stopped, saying why. */
export function pausedGoneView(viewJson: string, title: string): unknown {
  const { rc: _rc, ...view } = JSON.parse(viewJson) as {
    rc?: number;
    step?: { paused?: { node?: string } };
    summary?: { running?: string };
  };
  const at = view.step?.paused?.node;
  const { running: _running, ...summary } = view.summary ?? {};
  const { paused: _paused, ...step } = view.step ?? {};
  return {
    ...view,
    ...(view.summary ? { summary } : {}),
    ...(view.step ? { step } : {}),
    ...(at ? { stoppedAt: at } : {}),
    state: 'error',
    errorCode: 'cancelled',
    error: pausedGone(title),
  };
}

/** AFS-147: a person's name by their login; the login when they have no name (or are gone). */
async function nameOf(db: Db, login: string): Promise<string> {
  const row = await db
    .selectFrom('user_account')
    .select('name')
    .where('login', '=', login)
    .executeTakeFirst();
  return row?.name || login;
}
