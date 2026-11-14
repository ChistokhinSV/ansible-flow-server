// Schedules (AFS-34): a launch configuration run on a cron, in a time zone, or once at a set time.
// Kept in the database with the time each fires next; the scheduler looks every half minute for
// the ones due, takes each by moving its next time on (so two servers never fire one twice), and
// launches it as its owner, whose grants are checked then and there, not when it was made.
//   After downtime (a fire found more than two minutes late): one catch-up run, or none (`missed`).
//   While its last run has not ended: skip this fire, or queue another behind it (`overlap`).
//   The commit: the newest on the configuration's branch when it fires, or a pinned one.
// What every fire did is kept on the schedule (its last result) and in the audit log.
import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import type { Kysely } from 'kysely';
import { Access, atLeast } from '../access/grants';
import { recordAudit } from '../audit/store';
import { getUser } from '../auth/users';
import type { ScheduleTable, Schema } from '../db/schema';
import { type LaunchConfig, LaunchConfigs } from '../launch/configs';
import {
  type LaunchRequest,
  type PrepareDeps,
  prepareLaunch,
  withoutSecrets,
} from '../launch/prepare';
import type { Logger } from '../log';
import { getProject } from '../projects/store';
import { ACTIVE, type RunQueue } from '../runs/queue';

type Db = Kysely<Schema>;

import type {
  FireResult,
  MissedPolicy,
  OverlapPolicy,
  Schedule,
  ScheduleInput,
  ScheduleKind,
} from './types';

export type {
  FireResult,
  MissedPolicy,
  OverlapPolicy,
  Schedule,
  ScheduleInput,
  ScheduleKind,
} from './types';

export class ScheduleError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found',
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ScheduleError';
  }
}

const invalid = (message: string, field?: string) => new ScheduleError('invalid', message, field);
const iso = (d: Date) => d.toISOString();
const COMMIT = /^[0-9a-f]{40}$/;
/** A fire found later than this is one the server missed (it was down, or busy). */
export const GRACE_MS = 2 * 60 * 1000;
const UPCOMING = 3;

/** The time zone, checked: an unknown one is refused, not taken as UTC. */
function timeZone(tz: string | undefined): string {
  const zone = tz?.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
  } catch {
    throw invalid(
      `There is no time zone "${zone.slice(0, 60)}": use one like Europe/Berlin`,
      'timezone',
    );
  }
  return zone;
}

const pattern = (cron: string, tz: string) => {
  try {
    return new Cron(cron, { timezone: tz, paused: true });
  } catch (e) {
    throw invalid(`The cron expression cannot be read: ${(e as Error).message}`, 'cron');
  }
};

/** The next `count` times a cron fires after `from`. */
export function cronTimes(cron: string, tz: string, from: Date, count = 1): Date[] {
  const job = pattern(cron, tz);
  try {
    return job.nextRuns(count, from);
  } finally {
    job.stop();
  }
}

/** A cron, checked: five fields or a nickname, and at most once a minute. */
function checkedCron(cron: string | undefined, tz: string): string {
  const text = cron?.trim() ?? '';
  if (!text) throw invalid('Give a cron expression, like 0 3 * * 1-5', 'cron');
  if (!text.startsWith('@') && text.split(/\s+/).length !== 5)
    throw invalid('A cron expression has five fields: minute hour day month weekday', 'cron');
  const [a, b] = cronTimes(text, tz, new Date(), 2);
  if (!a) throw invalid('This cron expression never fires', 'cron');
  if (b && b.getTime() - a.getTime() < 60_000)
    throw invalid('A schedule fires at most once a minute', 'cron');
  return text;
}

type Row = ScheduleTable;

function of(row: Row, now = new Date()): Schedule {
  const upcoming =
    row.enabled && row.kind === 'cron' && row.cron
      ? cronTimes(row.cron, row.timezone, now, UPCOMING).map(iso)
      : row.enabled && row.next_at
        ? [row.next_at]
        : [];
  return {
    id: row.id,
    config: row.config_id,
    name: row.name,
    kind: row.kind as ScheduleKind,
    ...(row.cron ? { cron: row.cron } : {}),
    timezone: row.timezone,
    ...(row.once_at ? { onceAt: row.once_at } : {}),
    enabled: row.enabled === 1,
    ...(row.mode ? { mode: row.mode as 'check' | 'real' } : {}),
    inputs: JSON.parse(row.inputs_json) as Record<string, string>,
    ...(row.commit_id ? { commit: row.commit_id } : {}),
    missed: row.missed as MissedPolicy,
    overlap: row.overlap as OverlapPolicy,
    owner: { id: row.owner_id, login: row.owner_login },
    ...(row.enabled && row.next_at ? { next: row.next_at } : {}),
    upcoming,
    ...(row.last_at && row.last_result
      ? {
          last: {
            at: row.last_at,
            result: row.last_result as FireResult,
            ...(row.last_detail ? { detail: row.last_detail } : {}),
            ...(row.last_run_id ? { run: row.last_run_id } : {}),
          },
        }
      : {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** When a schedule fires next after `after`, by its own rule; null: never again. */
function nextTime(
  row: Pick<Row, 'kind' | 'cron' | 'timezone' | 'once_at'>,
  after: Date,
): string | null {
  if (row.kind === 'once')
    return row.once_at && Date.parse(row.once_at) > after.getTime() ? row.once_at : null;
  const [next] = cronTimes(row.cron as string, row.timezone, after, 1);
  return next ? iso(next) : null;
}

/** The parts of an input that are the schedule's own rule and launch, checked. */
function settled(input: ScheduleInput, before?: Row) {
  const name = input.name.trim();
  if (!name || name.length > 100)
    throw invalid('A schedule has a name of 1 to 100 characters', 'name');
  if (input.kind !== 'cron' && input.kind !== 'once')
    throw invalid('A schedule is cron or once', 'kind');
  const timezone = timeZone(input.timezone ?? before?.timezone);
  let cron: string | null = null;
  let onceAt: string | null = null;
  if (input.kind === 'cron') cron = checkedCron(input.cron, timezone);
  else {
    const at = Date.parse(input.onceAt ?? '');
    if (Number.isNaN(at)) throw invalid('Say when, as a date and time', 'onceAt');
    if (at <= Date.now()) throw invalid('That time has passed', 'onceAt');
    onceAt = iso(new Date(at));
  }
  const mode = input.mode === undefined ? (before?.mode ?? null) : input.mode;
  if (mode !== null && mode !== 'check' && mode !== 'real')
    throw invalid('The mode is check or real', 'mode');
  const commit =
    input.commit === undefined ? (before?.commit_id ?? null) : input.commit?.trim() || null;
  if (commit && !COMMIT.test(commit))
    throw invalid('A pinned commit is its full 40-character id', 'commit');
  const missed = input.missed ?? (before?.missed as MissedPolicy | undefined) ?? 'once';
  if (missed !== 'once' && missed !== 'skip')
    throw invalid('After downtime: once or skip', 'missed');
  const overlap = input.overlap ?? (before?.overlap as OverlapPolicy | undefined) ?? 'skip';
  if (overlap !== 'skip' && overlap !== 'queue')
    throw invalid('While a run goes: skip or queue', 'overlap');
  const inputs =
    input.inputs ?? (before ? (JSON.parse(before.inputs_json) as Record<string, string>) : {});
  for (const [k, v] of Object.entries(inputs))
    if (typeof v !== 'string') throw invalid(`The input ${k.slice(0, 40)} must be text`, 'inputs');
  return { name, timezone, cron, onceAt, mode, commit, missed, overlap, inputs };
}

/** What a launch of the schedule asks for. */
const requestOf = (s: {
  mode: string | null;
  inputs: Record<string, string>;
  commit: string | null;
}): LaunchRequest => ({
  ...(s.mode ? { mode: s.mode as 'check' | 'real' } : {}),
  ...(Object.keys(s.inputs).length ? { inputs: s.inputs } : {}),
  ...(s.commit ? { commit: s.commit } : {}),
});

export interface ScheduleDeps extends PrepareDeps {
  queue: RunQueue;
  log: Logger;
}

export class Schedules {
  private readonly configs: LaunchConfigs;
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<number>;

  constructor(private readonly deps: ScheduleDeps) {
    this.configs = new LaunchConfigs(deps.db, deps.git);
  }

  private get db(): Db {
    return this.deps.db;
  }

  async list(configId: string): Promise<Schedule[]> {
    const rows = await this.db
      .selectFrom('schedule')
      .selectAll()
      .where('config_id', '=', configId)
      .orderBy('name')
      .execute();
    return rows.map((r) => of(r));
  }

  private row(id: string): Promise<Row | undefined> {
    return this.db.selectFrom('schedule').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async get(id: string): Promise<Schedule | undefined> {
    const row = await this.row(id);
    return row ? of(row) : undefined;
  }

  /**
   * Checks that the launch the schedule asks for could run now (the inputs it lacks, a commit
   * that is not there) and names no secret input: a schedule runs with nobody to type one.
   */
  private async launchable(config: LaunchConfig, s: ReturnType<typeof settled>) {
    const prepared = await prepareLaunch(this.deps, config, requestOf(s), false);
    if (!prepared.ok) {
      const first = prepared.problems[0];
      throw invalid(
        first?.message ?? 'The launch is not ready',
        first?.field ? `inputs.${first.field}` : undefined,
      );
    }
    const secret = prepared.form.fields.filter((f) => f.secret).map((f) => f.name);
    const named = Object.keys(s.inputs).find((k) => secret.includes(k));
    if (named)
      throw invalid(
        `${named} is a secret input: a schedule keeps none (give it through a credential)`,
        `inputs.${named}`,
      );
  }

  async create(
    config: LaunchConfig,
    input: ScheduleInput,
    owner: { id: string; login: string },
  ): Promise<Schedule> {
    const s = settled(input);
    await this.launchable(config, s);
    const now = new Date();
    const enabled = input.enabled ?? true;
    const row: Row = {
      id: randomUUID(),
      config_id: config.id,
      name: s.name,
      kind: input.kind,
      cron: s.cron,
      timezone: s.timezone,
      once_at: s.onceAt,
      enabled: enabled ? 1 : 0,
      mode: s.mode,
      inputs_json: JSON.stringify(s.inputs),
      commit_id: s.commit,
      missed: s.missed,
      overlap: s.overlap,
      owner_id: owner.id,
      owner_login: owner.login,
      next_at: enabled
        ? nextTime({ kind: input.kind, cron: s.cron, timezone: s.timezone, once_at: s.onceAt }, now)
        : null,
      last_at: null,
      last_result: null,
      last_detail: null,
      last_run_id: null,
      created_by: owner.login,
      created_at: iso(now),
      updated_at: iso(now),
    };
    await this.db.insertInto('schedule').values(row).execute();
    return of(row, now);
  }

  /** Changes a schedule; a change to its rule, or enabling it, works its next time out again. */
  async update(
    id: string,
    change: Partial<ScheduleInput> & { owner?: { id: string; login: string } },
  ): Promise<Schedule> {
    const before = await this.row(id);
    if (!before) throw new ScheduleError('not_found', 'No such schedule');
    const config = await this.configs.get(before.config_id);
    if (!config)
      throw new ScheduleError('not_found', 'The schedule’s launch configuration is gone');
    const kind = change.kind ?? (before.kind as ScheduleKind);
    const s = settled(
      {
        name: change.name ?? before.name,
        kind,
        cron: change.cron ?? before.cron ?? undefined,
        timezone: change.timezone ?? before.timezone,
        onceAt: change.onceAt ?? before.once_at ?? undefined,
        ...(change.mode !== undefined ? { mode: change.mode } : {}),
        ...(change.inputs !== undefined ? { inputs: change.inputs } : {}),
        ...(change.commit !== undefined ? { commit: change.commit } : {}),
        ...(change.missed ? { missed: change.missed } : {}),
        ...(change.overlap ? { overlap: change.overlap } : {}),
      },
      before,
    );
    await this.launchable(config, s);
    const enabled = change.enabled ?? before.enabled === 1;
    const now = new Date();
    const set: Partial<Row> = {
      name: s.name,
      kind,
      cron: s.cron,
      timezone: s.timezone,
      once_at: s.onceAt,
      enabled: enabled ? 1 : 0,
      mode: s.mode,
      inputs_json: JSON.stringify(s.inputs),
      commit_id: s.commit,
      missed: s.missed,
      overlap: s.overlap,
      next_at: enabled
        ? nextTime({ kind, cron: s.cron, timezone: s.timezone, once_at: s.onceAt }, now)
        : null,
      updated_at: iso(now),
      ...(change.owner ? { owner_id: change.owner.id, owner_login: change.owner.login } : {}),
    };
    await this.db.updateTable('schedule').set(set).where('id', '=', id).execute();
    return of((await this.row(id)) as Row, now);
  }

  /** Someone a schedule may be handed to. */
  owner(id: string) {
    return getUser(this.db, id);
  }

  /** The next times a cron fires, or why it cannot be read. */
  preview(cron: string, tz?: string): string[] {
    const zone = timeZone(tz);
    return cronTimes(checkedCron(cron, zone), zone, new Date(), 5).map(iso);
  }

  async remove(id: string): Promise<void> {
    const done = await this.db.deleteFrom('schedule').where('id', '=', id).executeTakeFirst();
    if (!done.numDeletedRows) throw new ScheduleError('not_found', 'No such schedule');
  }

  // --- firing

  /** Looks for due schedules now, then every `everyMs`. */
  start(everyMs = 30_000): void {
    const look = () => {
      this.ticking ??= this.tick().finally(() => {
        this.ticking = undefined;
      });
      void this.ticking.catch((e) => this.deps.log.error({ err: e }, 'Firing schedules failed'));
    };
    look();
    this.timer = setInterval(look, everyMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.ticking?.catch(() => undefined);
  }

  /** Fires every schedule due at `now`; resolves with how many it took. */
  async tick(now = new Date()): Promise<number> {
    const due = await this.db
      .selectFrom('schedule')
      .selectAll()
      .where('enabled', '=', 1)
      .where('next_at', '<=', iso(now))
      .execute();
    let taken = 0;
    for (const row of due) {
      // A one-time schedule ends when it fires.
      const next = row.kind === 'once' ? null : nextTime(row, now);
      // Taken by moving its next time on: whoever moves it fires it.
      const claim = await this.db
        .updateTable('schedule')
        .set({ next_at: next, ...(next ? {} : { enabled: 0 }) })
        .where('id', '=', row.id)
        .where('next_at', '=', row.next_at)
        .executeTakeFirst();
      if (!claim.numUpdatedRows) continue;
      taken++;
      const late = now.getTime() - Date.parse(row.next_at as string) > GRACE_MS;
      if (late && row.missed === 'skip') {
        await this.settle(
          row,
          now,
          'skipped',
          `Missed at ${row.next_at} while the server was down`,
        );
        continue;
      }
      await this.fire(row, now).catch((e) =>
        this.settle(row, now, 'failed', (e as Error).message || 'The launch failed'),
      );
    }
    return taken;
  }

  private async fire(row: Row, now: Date): Promise<void> {
    const config = await this.configs.get(row.config_id);
    if (!config) return this.settle(row, now, 'failed', 'The launch configuration is gone');
    const project = await getProject(this.db, config.project);
    if (!project) return this.settle(row, now, 'failed', 'The project is gone');
    // Its owner's grants as they are now.
    const owner = await getUser(this.db, row.owner_id);
    if (!owner)
      return this.settle(row, now, 'refused', `Its owner ${row.owner_login} no longer exists`);
    if (owner.disabled)
      return this.settle(row, now, 'refused', `Its owner ${owner.login} is disabled`);
    const access = await Access.of(this.db, owner);
    const level = access.onFlow(project.workspace, project.id, config.flowFile);
    const need = row.commit_id && row.commit_id !== config.commit ? 'rw' : 'operator';
    if (!atLeast(level, need))
      return this.settle(
        row,
        now,
        'refused',
        `Its owner ${owner.login} may no longer launch ${config.flowFile} (needs ${need})`,
      );
    if (row.overlap === 'skip') {
      const going = await this.db
        .selectFrom('run')
        .select('number')
        .where('schedule_id', '=', row.id)
        .where('state', 'in', [...ACTIVE])
        .executeTakeFirst();
      if (going) return this.settle(row, now, 'skipped', `Run ${going.number} has not ended`);
    }
    const prepared = await prepareLaunch(
      this.deps,
      config,
      requestOf({
        mode: row.mode,
        inputs: JSON.parse(row.inputs_json) as Record<string, string>,
        commit: row.commit_id,
      }),
    );
    if (!prepared.ok)
      return this.settle(
        row,
        now,
        'failed',
        prepared.problems[0]?.message ?? 'The launch is not ready',
      );
    const shown = withoutSecrets(prepared.launch, prepared.form.fields).inputs;
    const run = await this.deps.queue.enqueue(
      { ...prepared.launch, schedule: row.id },
      shown,
      { id: owner.id, login: owner.login },
      config.name,
      now,
    );
    this.deps.log.info(
      {
        schedule: row.name,
        run: run.id,
        number: run.number,
        flow: run.flow.file,
        owner: owner.login,
      },
      'Schedule fired: run queued',
    );
    return this.settle(row, now, 'ok', `Run ${run.number} queued`, run.id);
  }

  private async settle(row: Row, now: Date, result: FireResult, detail: string, run?: string) {
    await this.db
      .updateTable('schedule')
      .set({
        last_at: iso(now),
        last_result: result,
        last_detail: detail,
        last_run_id: run ?? null,
      })
      .where('id', '=', row.id)
      .execute();
    if (result !== 'ok')
      this.deps.log.warn({ schedule: row.name, result, detail }, 'Schedule did not launch');
    await recordAudit(this.db, {
      actor: { id: row.owner_id, login: row.owner_login },
      source: 'server',
      action: 'schedule.fire',
      object: { type: 'schedule', id: row.id, name: row.name },
      result: result === 'ok' ? 'ok' : result === 'failed' ? 'failed' : 'refused',
      detail: { outcome: result, why: detail, ...(run ? { run } : {}) },
    });
  }
}
