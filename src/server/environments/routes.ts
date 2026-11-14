// Execution environments over HTTP (AFS-32). The level on the workspace is checked by the catalog
// (api/catalog.ts) before a handler runs: ro reads, rw changes and builds.
//   GET|POST /api/v1/workspaces/:id/environments
//   GET|PATCH|DELETE /api/v1/environments/:id
//   GET|POST /api/v1/environments/:id/builds
//   GET /api/v1/environments/:id/builds/:build/log
//   GET /api/v1/environments/:id/execution-environment.yml
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { signedIn } from '../auth/guards';
import type { Schema } from '../db/schema';
import { getWorkspace } from '../projects/store';
import { EnvironmentError, type Environments } from './environments';
import type { EnvironmentInput } from './types';

const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const id = text(64, 1);
const SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    baseImage: text(300),
    ansibleCore: text(20),
    collections: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: text(130, 1), version: text(100) },
      },
    },
    python: { type: 'array', maxItems: 200, items: text(200) },
    system: { type: 'array', maxItems: 200, items: text(100) },
    caCertificates: text(64 * 1024),
  },
};
const FIELDS = {
  name: text(63, 1),
  description: { type: ['string', 'null'], maxLength: 1000 },
  kind: { type: 'string', enum: ['spec', 'image'] },
  image: text(300),
  spec: SPEC,
  keep: { type: 'integer', minimum: 1, maximum: 50 },
};
const STATUS: Record<EnvironmentError['code'], number> = {
  invalid: 400,
  not_found: 404,
  taken: 409,
  in_use: 409,
};

export function registerEnvironments(
  app: FastifyInstance,
  deps: { db: Kysely<Schema>; environments: Environments },
): void {
  const { environments } = deps;
  const answering =
    <R extends FastifyRequest>(handler: (request: R, reply: FastifyReply) => Promise<unknown>) =>
    async (request: R, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (e) {
        if (e instanceof EnvironmentError)
          return reply.code(STATUS[e.code]).send({
            error: e.code,
            message: e.message,
            ...(e.field ? { field: e.field } : {}),
          });
        throw e;
      }
    };
  type P = { Params: { id: string; build?: string } };
  const PARAMS = { type: 'object', properties: { id, build: id }, required: ['id'] };
  const NONE = { error: 'not_found', message: 'No such environment' };

  app.get<P>(
    '/api/v1/workspaces/:id/environments',
    { schema: { params: PARAMS } },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const ws = await getWorkspace(deps.db, request.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found', message: 'No such workspace' });
      return environments.list(ws.id);
    },
  );

  app.post<P & { Body: EnvironmentInput }>(
    '/api/v1/workspaces/:id/environments',
    {
      bodyLimit: 512 * 1024,
      schema: {
        params: PARAMS,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'kind'],
          properties: FIELDS,
        },
      },
    },
    answering(async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const ws = await getWorkspace(deps.db, request.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found', message: 'No such workspace' });
      const made = await environments.create(ws.id, request.body, me.login);
      request.log.info(
        { by: me.login, environment: made.name, kind: made.kind },
        'Environment added',
      );
      return reply.code(201).send(made);
    }),
  );

  app.get<P>('/api/v1/environments/:id', { schema: { params: PARAMS } }, async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    return (await environments.get(request.params.id)) ?? reply.code(404).send(NONE);
  });

  app.patch<P & { Body: Partial<EnvironmentInput> }>(
    '/api/v1/environments/:id',
    {
      bodyLimit: 512 * 1024,
      schema: {
        params: PARAMS,
        body: { type: 'object', additionalProperties: false, properties: FIELDS },
      },
    },
    answering(async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const changed = await environments.update(request.params.id, request.body);
      request.log.info(
        { by: me.login, environment: changed.name, changed: Object.keys(request.body).join(',') },
        'Environment changed',
      );
      return changed;
    }),
  );

  app.delete<P>(
    '/api/v1/environments/:id',
    { schema: { params: PARAMS } },
    answering(async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      await environments.remove(request.params.id);
      request.log.info({ by: me.login, environment: request.params.id }, 'Environment deleted');
      return reply.code(204).send();
    }),
  );

  app.get<P>(
    '/api/v1/environments/:id/builds',
    { schema: { params: PARAMS } },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      if (!(await environments.get(request.params.id))) return reply.code(404).send(NONE);
      return environments.builds(request.params.id);
    },
  );

  app.post<P>(
    '/api/v1/environments/:id/builds',
    { schema: { params: PARAMS } },
    answering(async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const queued = await environments.queue(request.params.id, { id: me.id, login: me.login });
      request.log.info(
        { by: me.login, environment: request.params.id, build: queued.number },
        'Environment build queued',
      );
      return reply.code(201).send(queued);
    }),
  );

  app.get<P>(
    '/api/v1/environments/:id/builds/:build/log',
    { schema: { params: PARAMS } },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const build = request.params.build
        ? await environments.build(request.params.build)
        : undefined;
      if (!build || build.environment !== request.params.id)
        return reply.code(404).send({ error: 'not_found', message: 'No such build' });
      return reply.type('text/plain; charset=utf-8').send(environments.log(build.id));
    },
  );

  app.get<P>(
    '/api/v1/environments/:id/execution-environment.yml',
    { schema: { params: PARAMS } },
    answering(async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const env = await environments.get(request.params.id);
      if (!env) return reply.code(404).send(NONE);
      return reply
        .type('application/yaml; charset=utf-8')
        .header('content-disposition', 'attachment; filename="execution-environment.yml"')
        .send(await environments.builderFile(env.id));
    }),
  );
}
