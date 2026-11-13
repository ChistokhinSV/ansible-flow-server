// Runs over HTTP. Until access levels exist (AFS-27): everyone signed in sees runs;
// administrators launch (launch/routes.ts), cancel and relaunch.
//   GET  /api/v1/runs?project=&flow=&state=&limit=&before=
//   GET  /api/v1/runs/:id
//   POST /api/v1/runs/:id/cancel
//   POST /api/v1/runs/:id/relaunch    the same run again, as a new run
//   GET  /api/v1/runs/:id/output       what Ansible wrote, secrets hidden
//   GET  /api/v1/runs/:id/view         how it went, as the designer shows it
//   GET  /api/v1/runs/:id/events       all of that, live (server-sent events)
//   GET  /api/v1/runs/:id/hosts/:node/:host   what one host did in one step
import { createReadStream, existsSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { hostOutput } from '@ansible-flow/core/run/events';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { accessOf } from '../access/grants';
import { closeGates } from '../approvals/gates';
import { signedIn } from '../auth/guards';
import type { Schema } from '../db/schema';
import type { RunHub, RunNews } from './hub';
import { ACTIVE, type RunQueue, type RunState, STATES } from './queue';

const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const ID = { params: { type: 'object', properties: { id: text(64, 1) }, required: ['id'] } };
const NONE = { error: 'not_found', message: 'No such run' };
/** How much output a watcher gets at first: the end of it. */
const FIRST_OUTPUT = 1024 * 1024;
/** How often a watcher's stream looks at the run's record, and says it is still there. */
const LOOK_MS = 1000;
const KEEP_ALIVE_MS = 15_000;

/** Up to `max` bytes of a file from `from`, and where it ended. */
async function readFrom(
  file: string,
  from: number,
  max: number,
): Promise<{ text: string; next: number }> {
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return { text: '', next: from };
  try {
    const { size } = await handle.stat();
    const start = Math.min(from, size);
    const length = Math.min(size - start, max);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { text: buffer.toString('utf8'), next: start + length };
  } finally {
    await handle.close();
  }
}

export function registerRuns(
  app: FastifyInstance,
  queue: RunQueue,
  /** Where a run's output is kept, when this server runs flows. */
  outputFile?: (runId: string) => string,
  /** What runs going here say while they go. */
  hub?: RunHub,
  /** The database, to read who may see which runs. */
  db?: Kysely<Schema>,
): void {
  /** The streams open now: a server that closes ends them, or it would wait for them. */
  const streams = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
    streams.clear();
  });
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
      const view = hub?.live(request.params.id) ?? (await queue.view(request.params.id));
      return (
        view ??
        reply
          .code(404)
          .send({ error: 'not_found', message: 'The run has not started, or never ran' })
      );
    },
  );

  /**
   * What one host did in one step of the run, from its events: what the canvas shows when a
   * host is picked on a step. Works while the run goes.
   */
  app.get<{ Params: { id: string; node: string; host: string } }>(
    '/api/v1/runs/:id/hosts/:node/:host',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: text(64, 1), node: text(64, 1), host: text(500, 1) },
          required: ['id', 'node', 'host'],
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      if (!(await queue.get(request.params.id))) return reply.code(404).send(NONE);
      // A run of a flow with approvals ran in segments, each with its folder (AFS-28).
      const segments = await queue.segments(request.params.id);
      const last = await queue.runDir(request.params.id);
      const dirs = segments.length ? segments.map((s) => s.dir) : last ? [last] : [];
      const events = (
        await Promise.all(
          dirs.map((d) => readFile(join(d, 'events.jsonl'), 'utf8').catch(() => '')),
        )
      ).join('\n');
      return { entries: hostOutput(events, request.params.node, request.params.host) };
    },
  );

  /**
   * Everything about a run as it happens, as server-sent events: `run` (its record, when it
   * changes), `view` (the designer's view, about twice a second while it goes), `output` (new
   * output, with `next`: where to go on from after a reconnect) and `end`. A watcher that comes
   * back with `?from=<next>` gets the output from there.
   */
  app.get<{ Params: { id: string }; Querystring: { from?: number } }>(
    '/api/v1/runs/:id/events',
    {
      schema: {
        ...ID,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { from: { type: 'integer', minimum: 0 } },
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const id = request.params.id;
      let run = await queue.get(id);
      if (!run) return reply.code(404).send(NONE);

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        // A proxy must pass each event on at once, not gather them.
        'x-accel-buffering': 'no',
      });
      let streaming = true;
      const send = (event: string, data: unknown) => {
        if (streaming) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const file = outputFile?.(id);
      let next = request.query.from ?? 0;
      let sending = Promise.resolve();
      /** Sends the output written since `next`, one piece after another. */
      const flush = () => {
        sending = sending.then(async () => {
          if (!file || !streaming) return;
          for (;;) {
            const piece = await readFrom(file, next, 256 * 1024);
            if (!piece.text) return;
            next = piece.next;
            send('output', { text: piece.text, next });
          }
        });
        return sending;
      };

      send('run', run);
      const view = hub?.live(id) ?? (await queue.view(id));
      if (view) send('view', view);
      // A first look at a long output gets its end, and is told what it does not get.
      if (file && request.query.from === undefined) {
        const size = await stat(file).then(
          (info) => info.size,
          () => 0,
        );
        if (size > FIRST_OUTPUT) {
          next = size - FIRST_OUTPUT;
          send('output', { text: `… ${next} bytes of earlier output are not shown here\n`, next });
        }
      }
      await flush();

      let changed = await queue.changedAt(id);
      let ending = false;
      let unsubscribe: (() => void) | undefined;
      let looking: NodeJS.Timeout | undefined;
      let alive: NodeJS.Timeout | undefined;
      const stop = () => {
        streaming = false;
        unsubscribe?.();
        clearInterval(looking);
        clearInterval(alive);
        streams.delete(raw);
      };
      const finish = async () => {
        if (ending) return;
        ending = true;
        await flush();
        const last = await queue.view(id);
        if (last) send('view', last);
        send('end', { state: run?.state });
        stop();
        raw.end();
      };
      if (!ACTIVE.includes(run.state as RunState)) {
        await finish();
        return reply;
      }

      streams.add(raw);
      raw.on('close', stop);
      unsubscribe = hub?.subscribe(id, (news: RunNews) => {
        if (news.kind === 'view') send('view', news.view);
        else if (news.kind === 'output') void flush();
      });
      // The record is looked at too: a run another server has, a cancel, a run that ended.
      looking = setInterval(() => {
        void (async () => {
          const at = await queue.changedAt(id);
          if (at === changed) return;
          changed = at;
          run = await queue.get(id);
          if (!run) return finish();
          send('run', run);
          if (!ACTIVE.includes(run.state as RunState)) await finish();
        })().catch(() => undefined);
      }, LOOK_MS);
      alive = setInterval(() => {
        if (streaming) raw.write(': still here\n\n');
      }, KEEP_ALIVE_MS);
      return reply;
    },
  );

  app.get<{
    Querystring: {
      project?: string;
      flow?: string;
      state?: RunState;
      limit?: number;
      before?: string;
    };
  }>(
    '/api/v1/runs',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            project: text(64, 1),
            flow: text(500, 1),
            state: { type: 'string', enum: [...STATES] },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            before: text(40, 1),
          },
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      // Only the runs of what this person may see.
      const visible = db ? (await accessOf(db, request))?.visible() : undefined;
      return queue.list({ ...request.query, ...(visible ? { visible } : {}) });
    },
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
      // operator on the run's flow: checked before (api/catalog.ts).
      const me = signedIn(request, reply);
      if (!me) return reply;
      const run = await queue.cancel(request.params.id, me.login);
      if (!run) return reply.code(404).send(NONE);
      // AFS-28: a run stopped while it waits for approval asks nobody any more.
      if (run.state === 'cancelled' && db) await closeGates(db, run.id);
      hub?.publish(run.id, { kind: 'state' });
      request.log.info(
        { by: me.login, run: run.id, number: run.number, state: run.state },
        run.state === 'cancelled' ? 'Run cancelled' : 'Run asked to stop',
      );
      return reply.code(202).send(run);
    },
  );

  /** The same run again: same commit, flow, mode, inputs and credentials; a new number. */
  app.post<{ Params: { id: string } }>(
    '/api/v1/runs/:id/relaunch',
    { schema: ID },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const run = await queue.relaunch(request.params.id, me);
      if (!run) return reply.code(404).send(NONE);
      request.log.info(
        { by: me.login, run: run.id, number: run.number, of: request.params.id },
        'Run queued again',
      );
      return reply.code(201).send(run);
    },
  );
}
