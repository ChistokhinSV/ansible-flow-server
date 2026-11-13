// Runs over HTTP. Until access levels exist (AFS-27): everyone signed in sees runs;
// administrators launch (launch/routes.ts) and cancel.
//   GET  /api/v1/runs?project=&state=&limit=&before=
//   GET  /api/v1/runs/:id
//   POST /api/v1/runs/:id/cancel
//   GET  /api/v1/runs/:id/output     what Ansible wrote, secrets hidden
//   GET  /api/v1/runs/:id/view       how it went, as the designer shows it
import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { administrator, signedIn } from '../auth/guards';
import { type RunQueue, type RunState, STATES } from './queue';

const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const ID = { params: { type: 'object', properties: { id: text(64, 1) }, required: ['id'] } };
const NONE = { error: 'not_found', message: 'No such run' };

export function registerRuns(
  app: FastifyInstance,
  queue: RunQueue,
  /** Where a run's output is kept, when this server runs flows. */
  outputFile?: (runId: string) => string,
): void {
  app.get<{ Params: { id: string } }>(
    '/api/v1/runs/:id/output',
    { schema: ID },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const run = await queue.get(request.params.id);
      if (!run) return reply.code(404).send(NONE);
      const file = outputFile?.(run.id);
      reply.header('content-type', 'text/plain; charset=utf-8').header('cache-control', 'no-store');
      if (!file || !existsSync(file)) return reply.send('');
      return reply.send(createReadStream(file));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/runs/:id/view',
    { schema: ID },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      if (!(await queue.get(request.params.id))) return reply.code(404).send(NONE);
      const view = await queue.view(request.params.id);
      return (
        view ??
        reply.code(404).send({ error: 'not_found', message: 'The run has not ended, or never ran' })
      );
    },
  );

  app.get<{ Querystring: { project?: string; state?: RunState; limit?: number; before?: string } }>(
    '/api/v1/runs',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            project: text(64, 1),
            state: { type: 'string', enum: [...STATES] },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            before: text(40, 1),
          },
        },
      },
    },
    async (request, reply) => (signedIn(request, reply) ? queue.list(request.query) : reply),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/runs/:id',
    { schema: ID },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      return (await queue.get(request.params.id)) ?? reply.code(404).send(NONE);
    },
  );

  /**
   * Stops a run: at once when no worker has it, else at the worker's next heartbeat. Asking
   * again, or for a run that has ended, changes nothing and answers with the run as it is.
   */
  app.post<{ Params: { id: string } }>(
    '/api/v1/runs/:id/cancel',
    { schema: ID },
    async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const run = await queue.cancel(request.params.id, me.login);
      if (!run) return reply.code(404).send(NONE);
      request.log.info(
        { by: me.login, run: run.id, number: run.number, state: run.state },
        run.state === 'cancelled' ? 'Run cancelled' : 'Run asked to stop',
      );
      return reply.code(202).send(run);
    },
  );
}
