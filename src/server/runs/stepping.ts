// AFS-177: step-by-step runs (the designer's ADR-0039). A launch may ask that its run pause before
// each step (or only at pause points); the run is one ansible-playbook process whose `afd_step`
// strategy waits there, driven through control.json in the run folder by the designer's
// StepDriver, which the executor keeps while the run goes here.
//
//   POST /api/v1/runs/:id/step          {command: step|continue|pause|stop|retry, points?, failures?}
//   POST /api/v1/runs/:id/inspect       AFS-179: variables, evaluate and watch at a debug run's pause
//   GET  /api/v1/runs/:id/debug         AFS-179: what was looked at in a debug run's pauses (kept)
//   GET  /api/v1/projects/:id/pause-points?path=   your pause points on a flow
//   PUT  /api/v1/projects/:id/pause-points?path=   {points, failures?}: kept, and sent to your runs
//
// Who drives: whoever may stop the run (operator on its flow, which the person who launched it
// is, and administrators). A paused run keeps its container, its place among the runs at once and
// its lease; a pause nobody answers stops the run by itself (AFS_RUN_STEP_TIMEOUT_MINUTES).
// AFS-179 (ADR-0038 §1): a debug run is driven and looked into only by the person who launched it
// and administrators; others watching see the pause and its reason (Stop stays an operator's).
import {
  type FailureFilters,
  type InspectAnswer,
  type InspectArgs,
  type InspectOp,
  normalPoints,
  type PointSpec,
  pointNode,
  type StepCommand,
} from '@ansible-flow/core/run/step';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { atLeast } from '../access/grants';
import type { Level } from '../access/types';
import { closeGates } from '../approvals/gates';
import { signedIn } from '../auth/guards';
import type { SessionUser } from '../auth/sessions';
import type { Schema } from '../db/schema';
import type { StepAsked, StepRequest } from '../launch/prepare';
import { getWorkspace } from '../projects/store';
import { debugKept } from './debugStore';

export type { StepRequest };

import type { RunHub } from './hub';
import { ACTIVE, type RunQueue } from './queue';

export const STEP_COMMANDS = ['step', 'continue', 'pause', 'stop', 'retry'] as const;
/** AFS-179: what a paused debug run answers (ADR-0040 §2). */
export const INSPECT_OPS = ['scopes', 'vars', 'facts', 'eval', 'watch'] as const;
/** At most this many pause points on one flow. */
export const MAX_POINTS = 200;
/** How long a pause waits when the server says nothing (minutes). */
export const STEP_TIMEOUT_MINUTES = 60;

const ULIDISH = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' };
/** The longest condition, log message or expression a debug run is sent. */
export const MAX_EXPR = 2000;
/** AFS-179 (ADR-0040 §6): a pause point: a node id, or one with settings. */
export const POINT_SCHEMA = {
  anyOf: [
    ULIDISH,
    {
      type: 'object',
      additionalProperties: false,
      required: ['node'],
      properties: {
        node: ULIDISH,
        condition: { type: 'string', maxLength: MAX_EXPR },
        hits: { type: 'integer', minimum: 1, maximum: 1_000_000 },
        log: { type: 'string', maxLength: MAX_EXPR },
      },
    },
  ],
};
/** AFS-179 (ADR-0040 §7): which failures pause a debug run. */
export const FAILURES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { failed: { type: 'boolean' }, unreachable: { type: 'boolean' } },
};
/** The launch body's `step`. */
export const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    every: { type: 'boolean' },
    points: { type: 'array', maxItems: MAX_POINTS, items: POINT_SCHEMA },
    timeoutMinutes: { type: 'integer', minimum: 1, maximum: 24 * 60 },
    // AFS-214 (ADR-0038 §1): a debug run, and pause when a host fails.
    debug: { type: 'boolean' },
    pauseOnFailure: { type: 'boolean' },
    // AFS-179: the failure filters (failed, unreachable); else pauseOnFailure says failed.
    failures: FAILURES_SCHEMA,
  },
};

/**
 * What a launch's `step` asks for, with the server's longest pause; a refusal in words when it
 * asks for nothing (no every step, no pause point) or for a longer pause than the server allows.
 */
export function stepAsked(
  asked: StepRequest | undefined,
  maxMinutes: number,
): StepAsked | { error: string } | undefined {
  if (!asked) return undefined;
  // AFS-179: one point per step; settings only count in a debug run (a plain run pauses there).
  const points = normalPoints(asked.points ?? []).map((p) => (asked.debug ? p : pointNode(p)));
  const every = asked.every ?? points.length === 0;
  if (!every && points.length === 0)
    return { error: 'A step-by-step run pauses before every step or at pause points: name some' };
  const minutes = asked.timeoutMinutes ?? maxMinutes;
  if (minutes > maxMinutes)
    return {
      error: `A pause waits at most ${maxMinutes} minutes on this server (AFS_RUN_STEP_TIMEOUT_MINUTES)`,
    };
  // ADR-0040 §7: a debug run pauses where a host failed unless told not to.
  const failures = asked.debug
    ? {
        failed: asked.failures?.failed ?? asked.pauseOnFailure ?? true,
        ...(asked.failures?.unreachable ? { unreachable: true } : {}),
      }
    : undefined;
  return {
    every,
    points,
    timeoutS: minutes * 60,
    ...(asked.debug ? { debug: true } : {}),
    ...(asked.pauseOnFailure || failures?.failed ? { pauseOnFailure: true } : {}),
    ...(failures ? { failures } : {}),
  };
}

/** AFS-179: the failure filters a debug run starts with (none for other runs). */
export function failuresOf(step: Pick<StepAsked, 'debug' | 'pauseOnFailure' | 'failures'>) {
  if (!step.debug) return undefined;
  return step.failures ?? { failed: step.pauseOnFailure ?? true };
}

/** AFS-179: what a request asks a paused debug run. */
export type InspectAsk = InspectArgs & { op: InspectOp };

/** What the executor answers for a run going here. */
export interface Stepper {
  /**
   * Drives a step-by-step run going on this server: undefined when it is not going here; else
   * the refusal in words (a command that does not fit its state), or none when it was sent.
   */
  drive(
    run: string,
    ask: { command?: StepCommand; points?: PointSpec[]; failures?: FailureFilters },
    by: string,
  ): Promise<{ error?: string; paused?: boolean } | undefined>;
  /**
   * AFS-179: asks a debug run going here about its pause, waiting for the answer: undefined when
   * the run is not going here.
   */
  inspect?(run: string, ask: InspectAsk): Promise<InspectAnswer | undefined>;
}

/**
 * Whether a command fits a step-by-step run's state: Step and Continue answer a pause, Pause
 * pauses a run that goes, Stop ends it either way. The refusal in words; none when it fits.
 */
export function refusalFor(command: StepCommand, paused: boolean): string | undefined {
  if ((command === 'step' || command === 'continue') && !paused)
    return 'The run is not paused: Pause pauses it before its next step';
  if (command === 'pause' && paused) return 'The run is paused already';
  if (command === 'retry' && !paused)
    return 'The run is not paused: Retry is offered where hosts failed a step';
  return undefined;
}

/**
 * AFS-179 (ADR-0038 §1): whether someone at `level` on a flow may start a debug run of it (it
 * looks into the hosts' variables): rw, or operator where the workspace lets operators debug.
 * The refusal in words; none when they may.
 */
export async function debugRefusal(
  db: Kysely<Schema>,
  workspace: string,
  level: Level | undefined,
  file: string,
): Promise<string | undefined> {
  if (atLeast(level, 'rw')) return undefined;
  if (atLeast(level, 'operator') && (await getWorkspace(db, workspace))?.operatorsDebug)
    return undefined;
  return `A debug run needs rw on ${file} (or operator, where the workspace lets operators debug)`;
}

/**
 * AFS-179 (ADR-0038 §1): who drives a debug run and looks into it: the person who launched it,
 * and administrators. Others watching see the pause and its reason only.
 */
export function mayDebugRun(me: Pick<SessionUser, 'login' | 'admin'>, launcher: string): boolean {
  return me.admin || me.login === launcher;
}

export interface StepRouteDeps {
  queue: RunQueue;
  db: Kysely<Schema>;
  hub?: RunHub;
  /** The executor's drivers; none: this server runs no flows. */
  stepper?: Stepper;
  /** AFS-185: an approval closed because its run was stopped. */
  gateClosed?: (run: string, gate: string) => void;
}

const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const ID = { type: 'object', properties: { id: text(64, 1) }, required: ['id'] };
const PATH = { type: 'object', properties: { path: text(500, 1) }, required: ['path'] };
const HOST = text(300, 1);
const NAME_OR_INDEX = { anyOf: [text(1000), { type: 'integer', minimum: 0 }] };
/** AFS-179: the body of POST /runs/:id/inspect (ADR-0040 §2's ops). */
const INSPECT_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['op'],
  properties: {
    op: { type: 'string', enum: [...INSPECT_OPS] },
    host: HOST,
    hosts: { type: 'array', maxItems: 5000, items: HOST },
    scope: { type: 'string', enum: ['inputs', 'host', 'flow', 'facts'] },
    path: { type: 'array', maxItems: 64, items: NAME_OR_INDEX },
    start: { type: 'integer', minimum: 0 },
    count: { type: 'integer', minimum: 1, maximum: 1000 },
    facts: { type: 'boolean' },
    expr: text(MAX_EXPR, 1),
    exprs: { type: 'array', minItems: 1, maxItems: 20, items: text(MAX_EXPR, 1) },
    timeout: { type: 'number', minimum: 0.1, maximum: 10 },
  },
};

export function registerStepping(app: FastifyInstance, deps: StepRouteDeps): void {
  const { queue, db } = deps;

  app.post<{
    Params: { id: string };
    Body: { command?: StepCommand; points?: PointSpec[]; failures?: FailureFilters };
  }>(
    '/api/v1/runs/:id/step',
    {
      schema: {
        params: ID,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: { type: 'string', enum: [...STEP_COMMANDS] },
            points: { type: 'array', maxItems: MAX_POINTS, items: POINT_SCHEMA },
            failures: FAILURES_SCHEMA,
          },
        },
      },
    },
    async (request, reply) => {
      // operator on the run's flow: checked before (api/catalog.ts).
      const me = signedIn(request, reply);
      if (!me) return reply;
      const { command, failures } = request.body ?? {};
      const points = request.body?.points ? normalPoints(request.body.points) : undefined;
      if (!command && !points && !failures)
        return reply.code(400).send({
          error: 'invalid',
          message: 'Say a command (step, continue, pause, stop, retry)',
        });
      // The log says what was asked: the command, or "points" for new pause points alone.
      request.auditDetail = { command: command ?? (points ? 'points' : 'failures') };
      const run = await queue.get(request.params.id);
      if (!run) return reply.code(404).send({ error: 'not_found', message: 'No such run' });
      const refuse = (message: string) => reply.code(409).send({ error: 'conflict', message });
      if (!run.step) return refuse('This run is not step by step');
      // AFS-179: a debug run is its launcher's (and administrators') to drive; Stop stays an
      // operator's, as for any run.
      if (run.step.debug && command !== 'stop' && !mayDebugRun(me, run.requestedBy.login))
        return reply.code(403).send({
          error: 'forbidden',
          message: `Only ${run.requestedBy.login} (who launched it) or an administrator drives this debug run`,
        });
      if (command === 'retry' && !run.step.debug)
        return refuse('Retry is offered at a failure pause of a debug run');
      if (failures && !run.step.debug) return refuse('Pause on failure needs a debug run');
      if (!ACTIVE.includes(run.state)) return refuse('The run has ended');
      const driven = await deps.stepper?.drive(
        run.id,
        {
          ...(command ? { command } : {}),
          ...(points ? { points: run.step.debug ? points : points.map(pointNode) } : {}),
          ...(failures ? { failures } : {}),
        },
        me.login,
      );
      if (driven) {
        if (driven.error) return refuse(driven.error);
        request.log.info(
          { by: me.login, run: run.id, number: run.number, command: command ?? 'points' },
          'Step-by-step run driven',
        );
        // AFS-205: Step, Continue and Stop answer the pause: the run is not paused any more
        // (its record says so a moment later), so the reply does not say it is.
        const { pausedBefore: _was, ...going } = run;
        const answered =
          command === 'step' || command === 'continue' || command === 'stop' || command === 'retry';
        return reply
          .code(202)
          .send({ ...(answered ? going : run), ...(command ? { sent: command } : {}) });
      }
      // Not going here: queued, waiting at an approval, or on another server of the group.
      if (command === 'stop' && (run.state === 'queued' || run.state === 'waiting')) {
        const stopped = await queue.cancel(run.id, me.login);
        if (stopped?.state === 'cancelled') {
          for (const gate of await closeGates(db, run.id, me.login))
            deps.gateClosed?.(run.id, gate);
          deps.hub?.ended(run.id);
        }
        return reply.code(202).send(stopped);
      }
      if (run.state === 'queued') return refuse('The run has not started yet');
      if (run.state === 'waiting')
        return refuse('The run waits for an approval: it pauses again once it goes on');
      return refuse(
        'The run goes on another server of this group: open its page there to drive it',
      );
    },
  );

  // AFS-179 (ADR-0038 §1): a question to a paused debug run, answered in the reply (the run
  // writes it within its 100 ms tick; an evaluate takes at most its time limit).
  app.post<{ Params: { id: string }; Body: InspectAsk }>(
    '/api/v1/runs/:id/inspect',
    { schema: { params: ID, body: INSPECT_BODY } },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const ask = request.body;
      // Audited with the op and the expression, never what it answered (ADR-0038 §1).
      request.auditDetail = {
        op: ask.op,
        ...(ask.host ? { host: ask.host } : {}),
        ...(ask.expr !== undefined ? { expr: ask.expr } : {}),
        ...(ask.exprs ? { exprs: ask.exprs } : {}),
      };
      const run = await queue.get(request.params.id);
      if (!run) return reply.code(404).send({ error: 'not_found', message: 'No such run' });
      if (!run.step?.debug)
        return reply
          .code(409)
          .send({ error: 'conflict', message: 'This run is not a debug run: Debug starts one' });
      if (!mayDebugRun(me, run.requestedBy.login))
        return reply.code(403).send({
          error: 'forbidden',
          message: `Only ${run.requestedBy.login} (who launched it) or an administrator looks into this debug run`,
        });
      if (!ACTIVE.includes(run.state))
        return reply.code(410).send({ error: 'gone', message: 'The run has ended' });
      const answer = await deps.stepper?.inspect?.(run.id, ask);
      if (!answer) {
        if (run.state === 'queued' || run.state === 'waiting')
          return reply
            .code(409)
            .send({ error: 'conflict', message: 'The run is not paused at a step' });
        return reply.code(409).send({
          error: 'conflict',
          message: 'The run goes on another server of this group: open its page there to debug it',
        });
      }
      if (answer.gone)
        return reply.code(410).send({
          error: 'gone',
          message: 'That pause has ended: the run went on',
        });
      return answer;
    },
  );

  // AFS-179: what was looked at in a debug run's pauses (scopes and watches, masked as the run
  // answered them), kept with the run: a run that ended can be read later.
  app.get<{ Params: { id: string } }>(
    '/api/v1/runs/:id/debug',
    { schema: { params: ID } },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const run = await queue.get(request.params.id);
      if (!run) return reply.code(404).send({ error: 'not_found', message: 'No such run' });
      if (!mayDebugRun(me, run.requestedBy.login))
        return reply.code(403).send({
          error: 'forbidden',
          message: `Only ${run.requestedBy.login} (who launched it) or an administrator reads what its pauses showed`,
        });
      return { pauses: await debugKept(db, run.id) };
    },
  );

  type FlowQuery = { Params: { id: string }; Querystring: { path: string } };
  app.get<FlowQuery>(
    '/api/v1/projects/:id/pause-points',
    { schema: { params: ID, querystring: PATH } },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      return await pausePoints(db, me.id, request.params.id, request.query.path);
    },
  );

  app.put<FlowQuery & { Body: { points: PointSpec[]; failures?: FailureFilters } }>(
    '/api/v1/projects/:id/pause-points',
    {
      schema: {
        params: ID,
        querystring: PATH,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['points'],
          properties: {
            points: { type: 'array', maxItems: MAX_POINTS, items: POINT_SCHEMA },
            failures: FAILURES_SCHEMA,
          },
        },
      },
    },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const points = normalPoints(request.body.points);
      // AFS-179: the failure filters are kept beside them; none sent: as they were.
      const failures =
        request.body.failures ??
        (await pausePoints(db, me.id, request.params.id, request.query.path)).failures;
      await keepPausePoints(db, me.id, request.params.id, request.query.path, points, failures);
      // Sent to this person's step-by-step runs of the flow going here: their next pause uses them.
      const going = await queue.list({
        project: request.params.id,
        flow: request.query.path,
        by: me.login,
        state: 'running',
        limit: 20,
      });
      for (const run of going.filter((r) => r.step))
        await deps.stepper
          ?.drive(
            run.id,
            run.step?.debug
              ? { points, ...(request.body.failures ? { failures: request.body.failures } : {}) }
              : { points: points.map(pointNode) },
            me.login,
          )
          .catch(() => undefined);
      return { points, ...(failures ? { failures } : {}) };
    },
  );
}

/**
 * A person's pause points on a flow (node ids, or points with settings: AFS-179), and their
 * failure filters when they set some; none kept: none.
 */
export async function pausePoints(
  db: Kysely<Schema>,
  user: string,
  project: string,
  file: string,
): Promise<{ points: PointSpec[]; failures?: FailureFilters }> {
  const row = await db
    .selectFrom('pause_point')
    .select(['points_json', 'failures_json'])
    .where('user_id', '=', user)
    .where('project_id', '=', project)
    .where('flow_file', '=', file)
    .executeTakeFirst();
  if (!row) return { points: [] };
  return {
    points: JSON.parse(row.points_json) as PointSpec[],
    ...(row.failures_json ? { failures: JSON.parse(row.failures_json) as FailureFilters } : {}),
  };
}

/** Keeps a person's pause points on a flow; none: the row goes. */
export async function keepPausePoints(
  db: Kysely<Schema>,
  user: string,
  project: string,
  file: string,
  points: PointSpec[],
  failures?: FailureFilters,
  now = new Date(),
): Promise<void> {
  await db
    .deleteFrom('pause_point')
    .where('user_id', '=', user)
    .where('project_id', '=', project)
    .where('flow_file', '=', file)
    .execute();
  if (points.length || failures)
    await db
      .insertInto('pause_point')
      .values({
        user_id: user,
        project_id: project,
        flow_file: file,
        points_json: JSON.stringify(points.slice(0, MAX_POINTS)),
        failures_json: failures ? JSON.stringify(failures) : null,
        updated_at: now.toISOString(),
      })
      .execute();
}
