// Event streaming over HTTP (AFS-53), for administrators:
//   GET    /api/v1/admin/streams              the destinations, each with how it goes
//   POST   /api/v1/admin/streams              add a syslog or OpenTelemetry destination
//   GET    /api/v1/admin/streams/:id          one
//   PATCH  /api/v1/admin/streams/:id          change it (headers: a value left out is kept)
//   DELETE /api/v1/admin/streams/:id          remove it, and what waits for it
//   POST   /api/v1/admin/streams/:id/test     send a test message now and say how it went
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { administrator, inSession } from '../auth/guards';
import type { Schema } from '../db/schema';
import { SealError } from '../secrets/crypto';
import type { MasterKey } from '../secrets/masterKey';
import { createSink, deleteSink, getSink, listSinks, StreamError, updateSink } from './store';
import type { Streamer } from './streamer';
import { SINK_TYPES, type SinkInput, SYSLOG_TRANSPORTS } from './types';

export interface StreamDeps {
  db: Kysely<Schema>;
  key: MasterKey;
  streamer?: Streamer;
}

const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const int = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum });
const ID = {
  params: { type: 'object', properties: { id: text(64, 1) }, required: ['id'] },
};

const SYSLOG = {
  type: 'object',
  additionalProperties: false,
  properties: {
    host: text(255, 1),
    port: int(1, 65535),
    transport: { type: 'string', enum: [...SYSLOG_TRANSPORTS] },
    ca: text(65536),
    facility: int(0, 23),
    enterprise: int(1, 2_147_483_647),
    bom: { type: 'boolean' },
    hostname: text(255),
    framing: { type: 'string', enum: ['octet', 'lf'] },
    windowSeconds: int(0, 60),
  },
};
const OTLP = {
  type: 'object',
  additionalProperties: false,
  properties: {
    endpoint: text(2000, 1),
    ca: text(65536),
    gzip: { type: 'boolean' },
    timeoutSeconds: int(1, 120),
    environment: text(100),
    hostNames: { type: 'boolean' },
    maxHostEvents: int(0, 10_000),
    headers: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: text(100, 1), value: text(8192) },
      },
    },
  },
};
const SINK = {
  name: text(100, 1),
  type: { type: 'string', enum: [...SINK_TYPES] },
  enabled: { type: 'boolean' },
  audit: { type: 'boolean' },
  runs: { type: 'boolean' },
  syslog: SYSLOG,
  otlp: OTLP,
  maxBacklog: int(100, 10_000_000),
  maxAgeDays: int(1, 365),
};

export function registerStreams(app: FastifyInstance, deps: StreamDeps): void {
  const { db, key } = deps;
  const answering =
    <R extends FastifyRequest>(handler: (request: R, reply: FastifyReply) => Promise<unknown>) =>
    async (request: R, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (e) {
        if (e instanceof StreamError)
          return reply.code(400).send({
            error: 'invalid',
            message: e.message,
            ...(e.field ? { field: e.field } : {}),
          });
        if (e instanceof SealError) {
          request.log.error({ why: e.message }, 'A stored secret could not be opened');
          return reply
            .code(500)
            .send({ error: 'sealed', message: 'A stored secret could not be opened' });
        }
        throw e;
      }
    };
  const missing = (reply: FastifyReply) =>
    reply.code(404).send({ error: 'not_found', message: 'No such destination' });

  app.get('/api/v1/admin/streams', async (request, reply) =>
    administrator(request, reply) ? listSinks(db) : reply,
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/admin/streams/:id',
    { schema: ID },
    async (request, reply) => {
      if (!administrator(request, reply)) return reply;
      return (await getSink(db, request.params.id)) ?? missing(reply);
    },
  );

  // Where the audit log goes is decided in a session, as the mail server is: not by a token.
  app.post<{ Body: SinkInput }>(
    '/api/v1/admin/streams',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'type'],
          properties: SINK,
        },
      },
    },
    answering(async (request, reply) => {
      if (!inSession(request, reply, true)) return reply;
      const made = await createSink(db, key, request.body);
      deps.streamer?.wake();
      return reply.code(201).send(made);
    }),
  );

  app.patch<{ Params: { id: string }; Body: Partial<SinkInput> }>(
    '/api/v1/admin/streams/:id',
    {
      schema: { ...ID, body: { type: 'object', additionalProperties: false, properties: SINK } },
    },
    answering(async (request, reply) => {
      if (!inSession(request, reply, true)) return reply;
      const changed = await updateSink(db, key, request.params.id, request.body);
      if (changed) deps.streamer?.changed(request.params.id);
      return changed ?? missing(reply);
    }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/admin/streams/:id',
    { schema: ID },
    answering(async (request, reply) => {
      if (!inSession(request, reply, true)) return reply;
      if (!(await deleteSink(db, request.params.id))) return missing(reply);
      deps.streamer?.changed(request.params.id);
      return reply.code(204).send();
    }),
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/streams/:id/test',
    { schema: ID },
    answering(async (request, reply) => {
      const user = administrator(request, reply);
      if (!user) return reply;
      if (!deps.streamer)
        return reply
          .code(503)
          .send({ error: 'unavailable', message: 'This server does not stream events' });
      return (await deps.streamer.test(request.params.id, user.login)) ?? missing(reply);
    }),
  );
}
