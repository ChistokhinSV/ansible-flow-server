// Runs over HTTP. Until access levels exist (AFS-27): everyone signed in sees runs;
// administrators launch (launch/routes.ts), cancel and relaunch.
//   GET  /api/v1/runs?project=&flow=&state=&config=&by=&q=&limit=&before=
//   GET  /api/v1/runs/:id
//   POST /api/v1/runs/:id/cancel
//   POST /api/v1/runs/:id/relaunch    the same run again, as a new run
//   GET  /api/v1/runs/:id/output       what Ansible wrote, secrets hidden
//   GET  /api/v1/runs/:id/view         how it went, as the designer shows it
//   GET  /api/v1/runs/:id/events       all of that, live (server-sent events)
//   GET  /api/v1/runs/:id/hosts/:node/:host   what one host did in one step
//   GET  /api/v1/runs/:id/hosts/:host         what one host did, step by step
import { existsSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { stripAnsi } from '@ansible-flow/core/run/ansi';
import { hostOutput, type OutputEntry } from '@ansible-flow/core/run/events';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { accessOf } from '../access/grants';
import { closeGates, type Gate, gatesOf } from '../approvals/gates';
import { signedIn } from '../auth/guards';
import type { Schema } from '../db/schema';
import { readBefore } from './cursor';
import type { RunHub, RunNews } from './hub';
import { ACTIVE, type Run, type RunQueue, type RunState, STATES } from './queue';

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
  /** AFS-185: an approval closed because its run was stopped (its approvers are told). */
  gateClosed?: (run: string, gate: string) => void,
): void {
  /** The streams open now: a server that closes ends them, or it would wait for them. */
  const streams = new Set<ServerResponse>();
  /** AFS-143: who asked for each run by name too: the pages show people by their names. */
  const named = async (runs: Run[]): Promise<Run[]> => {
    if (!db || runs.length === 0) return runs;
    const ids = [...new Set(runs.map((r) => r.requestedBy.id))];
    const names = new Map(
      (await db.selectFrom('user_account').select(['id', 'name']).where('id', 'in', ids).execute())
        .filter((u) => u.name)
        .map((u) => [u.id, u.name]),
    );
    // AFS-146: a failed run whose approval was decided against reads as that.
    const failed = runs.filter((r) => r.state === 'failed').map((r) => r.id);
    const against = new Map(
      failed.length
        ? (
            await db
              .selectFrom('run_gate')
              .select(['run_id', 'status'])
              .where('run_id', 'in', failed)
              .where('status', 'in', ['rejected', 'timed out'])
              .execute()
          ).map((g) => [g.run_id, g.status as 'rejected' | 'timed out'])
        : [],
    );
    return runs.map((r) => {
      const name = names.get(r.requestedBy.id);
      const decided = against.get(r.id);
      return {
        ...r,
        ...(name ? { requestedBy: { ...r.requestedBy, name } } : {}),
        ...(decided ? { decidedAgainst: decided } : {}),
      };
    });
  };
  /** A run's events: a run of a flow with approvals ran in segments, a folder each (AFS-28). */
  const eventsOf = async (id: string): Promise<string> => {
    const segments = await queue.segments(id);
    const last = await queue.runDir(id);
    const dirs = segments.length ? segments.map((s) => s.dir) : last ? [last] : [];
    return (
      await Promise.all(dirs.map((d) => readFile(join(d, 'events.jsonl'), 'utf8').catch(() => '')))
    ).join('\n');
  };
  /** AFS-147: one run as its page shows it: what it ran with, named. */
  const nameOne = async (run: Run | undefined) => {
    if (!run) return undefined;
    const [one] = await named([run]);
    if (!db || !one) return one;
    const creds = run.credentials.length
      ? new Map(
          (
            await db
              .selectFrom('credential')
              .select(['id', 'name'])
              .where('id', 'in', run.credentials)
              .execute()
          ).map((c) => [c.id, c.name]),
        )
      : new Map<string, string>();
    // The image names its environment: a registered image, or one of its builds.
    const image = run.eeImage;
    const env = image
      ? ((await db
          .selectFrom('environment')
          .select(['id', 'name', 'workspace_id'])
          .where('image', '=', image)
          .executeTakeFirst()) ??
        (await db
          .selectFrom('environment_build')
          .innerJoin('environment', 'environment.id', 'environment_build.environment_id')
          .select(['environment.id', 'environment.name', 'environment.workspace_id'])
          .where('environment_build.image', '=', image)
          .executeTakeFirst()))
      : undefined;
    // AFS-170: whether the image was the server's default is recorded when the run starts; runs
    // from before that read their launch configuration as it is now.
    const recorded = await db
      .selectFrom('run')
      .select('ee_default')
      .where('id', '=', run.id)
      .executeTakeFirst();
    const config =
      recorded?.ee_default == null && run.eeImage && run.config
        ? await db
            .selectFrom('launch_config')
            .select(['environment_id', 'ee_image'])
            .where('id', '=', run.config.id)
            .executeTakeFirst()
        : undefined;
    const serverDefault =
      recorded?.ee_default === 1 || (!!config && !config.environment_id && !config.ee_image);
    const view = (await queue.view(run.id)) as { skippedTargets?: unknown } | undefined;
    const skipped = Array.isArray(view?.skippedTargets)
      ? view.skippedTargets.filter((t): t is string => typeof t === 'string')
      : [];
    return {
      ...one,
      ...(run.credentials.length
        ? { credentialNames: run.credentials.map((id) => creds.get(id) ?? id) }
        : {}),
      ...(env ? { environment: { id: env.id, name: env.name, workspace: env.workspace_id } } : {}),
      ...(skipped.length ? { skippedTargets: skipped } : {}),
      ...(serverDefault ? { serverDefault: true as const } : {}),
    };
  };
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
      // Kept with Ansible's colour codes for the run page (AFS-96); as text, plain. The file is
      // bounded (MAX_OUTPUT), so it is read whole.
      return reply.send(stripAnsi(await readFile(file, 'utf8')));
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
      const events = await eventsOf(request.params.id);
      return { entries: hostOutput(events, request.params.node, request.params.host) };
    },
  );

  /**
   * AFS-170: what one host did in the whole run, step by step in the order they ran: what the
   * run page opens from its host list.
   */
  app.get<{ Params: { id: string; host: string } }>(
    '/api/v1/runs/:id/hosts/:host',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: text(64, 1), host: text(500, 1) },
          required: ['id', 'host'],
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const id = request.params.id;
      const host = request.params.host;
      if (!(await queue.get(id))) return reply.code(404).send(NONE);
      // AFS-193: a run of a flow with approvals: segment by segment, each approval the host
      // waited at (and how it was decided) after the segment that ended there.
      const segments = await queue.segments(id);
      const gates = db && segments.length ? await gatesOf(db, id) : [];
      if (!gates.length) return { steps: hostSteps(await eventsOf(id), host) };
      const steps: ReturnType<typeof hostSteps> = [];
      for (const segment of segments) {
        const events = await readFile(join(segment.dir, 'events.jsonl'), 'utf8').catch(() => '');
        steps.push(...hostSteps(events, host));
        for (const gate of gates)
          if (gate.segment === segment.name && gate.hosts?.includes(host))
            steps.push(gateStep(gate));
      }
      return { steps };
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
      let run = await nameOne(await queue.get(id));
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
          run = await nameOne(await queue.get(id));
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
      state?: RunState | 'rejected' | 'paused';
      config?: string;
      by?: string;
      q?: string;
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
            // AFS-193: and rejected (a failed run decided against); failed leaves those out.
            // AFS-205: and paused (a step-by-step run paused before a step); waiting has them too.
            state: { type: 'string', enum: [...STATES, 'rejected', 'paused'] },
            // A launch configuration's id: its runs.
            config: text(64, 1),
            // A login: the runs that person asked for.
            by: text(200, 1),
            // AFS-147: words in the flow's name or file, the configuration's, or a login; or #number.
            q: text(200),
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            // A time, or where the last page ended: `createdAt,number,id` of its last run.
            before: text(120, 1),
          },
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      if (request.query.before && !readBefore(request.query.before))
        return reply.code(400).send({
          error: 'invalid',
          message: "before is a time, or the last run's createdAt,number,id",
          field: 'before',
        });
      // Only the runs of what this person may see: the filters narrow that, never widen it.
      const visible = db ? (await accessOf(db, request))?.visible() : undefined;
      return named(await queue.list({ ...request.query, ...(visible ? { visible } : {}) }));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/runs/:id',
    { schema: ID },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      return (await nameOne(await queue.get(request.params.id))) ?? reply.code(404).send(NONE);
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
      if (run.state === 'cancelled' && db)
        for (const gate of await closeGates(db, run.id, me.login)) gateClosed?.(run.id, gate);
      // AFS-147: a run that ended here and now has its view in its record, not a live one.
      if (run.state === 'cancelled') hub?.ended(run.id);
      else hub?.publish(run.id, { kind: 'state' });
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

/**
 * AFS-170: one host's results in each step it ran in, in the order the steps ran. A step is named
 * as its play is ("[key] Title" says Title); its routing tasks are left out, as on the canvas.
 */
/** AFS-193: an approval a host waited at, as a step of what the host did. */
export function gateStep(gate: Gate): { node: string; step: string; entries: OutputEntry[] } {
  const by = gate.decidedByName ?? gate.decidedBy;
  const entry: OutputEntry =
    gate.status === 'waiting'
      ? { task: 'for a decision', status: 'waiting' }
      : gate.status === 'timed out'
        ? { task: 'nobody decided in time', status: 'timed out' }
        : {
            task: by ? `by ${by}` : '',
            status: gate.status === 'cancelled' ? 'run stopped' : gate.status,
            ...(gate.comment ? { msg: gate.comment } : {}),
          };
  return { node: gate.node.id, step: gate.node.title, entries: [entry] };
}

export function hostSteps(
  events: string,
  host: string,
): { node: string; step: string; entries: OutputEntry[] }[] {
  const names = new Map<string, string>();
  const order: string[] = [];
  let playNode: string | null = null;
  for (const line of events.split('\n')) {
    if (!line.trim()) continue;
    let e: { event?: string; node?: string; name?: string; host?: string };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.event === 'play') {
      playNode = e.node ?? null;
      if (e.node && e.name && !names.has(e.node))
        names.set(e.node, e.name.replace(/^\[[^\]]*\]\s*/, ''));
    }
    const node = e.node ?? playNode;
    if (e.event === 'result' && e.host === host && node && !order.includes(node)) order.push(node);
  }
  return order
    .map((node) => ({
      node,
      step: names.get(node) ?? node,
      entries: hostOutput(events, node, host),
    }))
    .filter((s) => s.entries.length > 0);
}
