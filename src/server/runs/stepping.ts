// AFS-177: step-by-step runs (the designer's ADR-0039). A launch may ask that its run pause before
// each step (or only at pause points); the run is one ansible-playbook process whose `afd_step`
// strategy waits there, driven through control.json in the run folder by the designer's
// StepDriver, which the executor keeps while the run goes here.
//
//   POST /api/v1/runs/:id/step          {command: step|continue|pause|stop, points?}
//   GET  /api/v1/projects/:id/pause-points?path=   your pause points on a flow
//   PUT  /api/v1/projects/:id/pause-points?path=   {points}: kept, and sent to your runs of it
//
// Who drives: whoever may stop the run (operator on its flow, which the person who launched it
// is, and administrators). A paused run keeps its container, its place among the runs at once and
// its lease; a pause nobody answers stops the run by itself (AFS_RUN_STEP_TIMEOUT_MINUTES).
import type { StepCommand } from '@ansible-flow/core/run/step';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { closeGates } from '../approvals/gates';
import { signedIn } from '../auth/guards';
import type { Schema } from '../db/schema';
import type { StepAsked, StepRequest } from '../launch/prepare';

export type { StepRequest };

import type { RunHub } from './hub';
import { ACTIVE, type RunQueue } from './queue';

export const STEP_COMMANDS = ['step', 'continue', 'pause', 'stop'] as const;
/** At most this many pause points on one flow. */
export const MAX_POINTS = 200;
/** How long a pause waits when the server says nothing (minutes). */
export const STEP_TIMEOUT_MINUTES = 60;

const ULIDISH = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' };
/** The launch body's `step`. */
export const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    every: { type: 'boolean' },
    points: { type: 'array', maxItems: MAX_POINTS, items: ULIDISH },
    timeoutMinutes: { type: 'integer', minimum: 1, maximum: 24 * 60 },
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
  const points = [...new Set(asked.points ?? [])];
  const every = asked.every ?? points.length === 0;
  if (!every && points.length === 0)
    return { error: 'A step-by-step run pauses before every step or at pause points: name some' };
  const minutes = asked.timeoutMinutes ?? maxMinutes;
  if (minutes > maxMinutes)
    return {
      error: `A pause waits at most ${maxMinutes} minutes on this server (AFS_RUN_STEP_TIMEOUT_MINUTES)`,
    };
  return { every, points, timeoutS: minutes * 60 };
}

/** What the executor answers for a run going here. */
export interface Stepper {
  /**
   * Drives a step-by-step run going on this server: undefined when it is not going here; else
   * the refusal in words (a command that does not fit its state), or none when it was sent.
   */
  drive(
    run: string,
    ask: { command?: StepCommand; points?: string[] },
    by: string,
  ): Promise<{ error?: string; paused?: boolean } | undefined>;
}

/**
 * Whether a command fits a step-by-step run's state: Step and Continue answer a pause, Pause
 * pauses a run that goes, Stop ends it either way. The refusal in words; none when it fits.
 */
export function refusalFor(command: StepCommand, paused: boolean): string | undefined {
  if ((command === 'step' || command === 'continue') && !paused)
    return 'The run is not paused: Pause pauses it before its next step';
  if (command === 'pause' && paused) return 'The run is paused already';
  return undefined;
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

export function registerStepping(app: FastifyInstance, deps: StepRouteDeps): void {
  const { queue, db } = deps;

  app.post<{ Params: { id: string }; Body: { command?: StepCommand; points?: string[] } }>(
    '/api/v1/runs/:id/step',
    {
      schema: {
        params: ID,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: { type: 'string', enum: [...STEP_COMMANDS] },
            points: { type: 'array', maxItems: MAX_POINTS, items: ULIDISH },
          },
        },
      },
    },
    async (request, reply) => {
      // operator on the run's flow: checked before (api/catalog.ts).
      const me = signedIn(request, reply);
      if (!me) return reply;
      const { command, points } = request.body ?? {};
      if (!command && !points)
        return reply
          .code(400)
          .send({ error: 'invalid', message: 'Say a command (step, continue, pause, stop)' });
      // The log says what was asked: the command, or "points" for new pause points alone.
      request.auditDetail = { command: command ?? 'points' };
      const run = await queue.get(request.params.id);
      if (!run) return reply.code(404).send({ error: 'not_found', message: 'No such run' });
      const refuse = (message: string) => reply.code(409).send({ error: 'conflict', message });
      if (!run.step) return refuse('This run is not step by step');
      if (!ACTIVE.includes(run.state)) return refuse('The run has ended');
      const driven = await deps.stepper?.drive(run.id, { command, points }, me.login);
      if (driven) {
        if (driven.error) return refuse(driven.error);
        request.log.info(
          { by: me.login, run: run.id, number: run.number, command: command ?? 'points' },
          'Step-by-step run driven',
        );
        // AFS-205: Step, Continue and Stop answer the pause: the run is not paused any more
        // (its record says so a moment later), so the reply does not say it is.
        const { pausedBefore: _was, ...going } = run;
        const answered = command === 'step' || command === 'continue' || command === 'stop';
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

  type FlowQuery = { Params: { id: string }; Querystring: { path: string } };
  app.get<FlowQuery>(
    '/api/v1/projects/:id/pause-points',
    { schema: { params: ID, querystring: PATH } },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      return { points: await pausePoints(db, me.id, request.params.id, request.query.path) };
    },
  );

  app.put<FlowQuery & { Body: { points: string[] } }>(
    '/api/v1/projects/:id/pause-points',
    {
      schema: {
        params: ID,
        querystring: PATH,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['points'],
          properties: { points: { type: 'array', maxItems: MAX_POINTS, items: ULIDISH } },
        },
      },
    },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const points = [...new Set(request.body.points)];
      await keepPausePoints(db, me.id, request.params.id, request.query.path, points);
      // Sent to this person's step-by-step runs of the flow going here: their next pause uses them.
      const going = await queue.list({
        project: request.params.id,
        flow: request.query.path,
        by: me.login,
        state: 'running',
        limit: 20,
      });
      for (const run of going.filter((r) => r.step))
        await deps.stepper?.drive(run.id, { points }, me.login).catch(() => undefined);
      return { points };
    },
  );
}

/** A person's pause points on a flow (node ids); none kept: none. */
export async function pausePoints(
  db: Kysely<Schema>,
  user: string,
  project: string,
  file: string,
): Promise<string[]> {
  const row = await db
    .selectFrom('pause_point')
    .select('points_json')
    .where('user_id', '=', user)
    .where('project_id', '=', project)
    .where('flow_file', '=', file)
    .executeTakeFirst();
  return row ? (JSON.parse(row.points_json) as string[]) : [];
}

/** Keeps a person's pause points on a flow; none: the row goes. */
export async function keepPausePoints(
  db: Kysely<Schema>,
  user: string,
  project: string,
  file: string,
  points: string[],
  now = new Date(),
): Promise<void> {
  await db
    .deleteFrom('pause_point')
    .where('user_id', '=', user)
    .where('project_id', '=', project)
    .where('flow_file', '=', file)
    .execute();
  if (points.length)
    await db
      .insertInto('pause_point')
      .values({
        user_id: user,
        project_id: project,
        flow_file: file,
        points_json: JSON.stringify(points.slice(0, MAX_POINTS)),
        updated_at: now.toISOString(),
      })
      .execute();
}
