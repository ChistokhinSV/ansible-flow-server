// Schedules over HTTP (AFS-34), under the launch configuration they run:
//   GET    /api/v1/launch-configs/:id/schedules              ro on the flow
//   POST   /api/v1/launch-configs/:id/schedules              rw on the flow; the caller owns it
//   PATCH  /api/v1/launch-configs/:id/schedules/:schedule    rw; a new owner: administrators only,
//                                                            and only a service account (or themself)
//   DELETE /api/v1/launch-configs/:id/schedules/:schedule    rw
//   GET    /api/v1/schedule-times?cron=&timezone=            the next times a cron fires
// The level on the flow is checked by the catalog (api/catalog.ts) before a handler runs.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { administrator, signedIn } from '../auth/guards';
import type { LaunchConfigs } from '../launch/configs';
import { ScheduleError, type ScheduleInput, type Schedules } from './schedules';

const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const id = text(64, 1);
const FIELDS = {
  name: text(100, 1),
  kind: { type: 'string', enum: ['cron', 'once'] },
  cron: text(200),
  timezone: text(64),
  onceAt: text(40),
  enabled: { type: 'boolean' },
  mode: { type: ['string', 'null'], enum: ['check', 'real', null] },
  inputs: {
    type: 'object',
    maxProperties: 200,
    additionalProperties: { type: 'string', maxLength: 10_000 },
  },
  commit: { type: ['string', 'null'], maxLength: 40 },
  missed: { type: 'string', enum: ['once', 'skip'] },
  overlap: { type: 'string', enum: ['skip', 'queue'] },
};
const PARAMS = {
  type: 'object',
  properties: { id, schedule: id },
  required: ['id'],
};

export function registerSchedules(
  app: FastifyInstance,
  deps: { schedules: Schedules; configs: LaunchConfigs },
): void {
  const { schedules, configs } = deps;
  const answering =
    <R extends FastifyRequest>(handler: (request: R, reply: FastifyReply) => Promise<unknown>) =>
    async (request: R, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (e) {
        if (e instanceof ScheduleError)
          return reply.code(e.code === 'not_found' ? 404 : 400).send({
            error: e.code,
            message: e.message,
            ...(e.field ? { field: e.field } : {}),
          });
        throw e;
      }
    };
  type P = { Params: { id: string; schedule?: string } };
  const NO_CONFIG = { error: 'not_found', message: 'No such launch configuration' };
  const NO_SCHEDULE = { error: 'not_found', message: 'No such schedule' };

  app.get<P>(
    '/api/v1/launch-configs/:id/schedules',
    { schema: { params: PARAMS } },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      if (!(await configs.get(request.params.id))) return reply.code(404).send(NO_CONFIG);
      return schedules.list(request.params.id);
    },
  );

  app.post<P & { Body: ScheduleInput }>(
    '/api/v1/launch-configs/:id/schedules',
    {
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
      const config = await configs.get(request.params.id);
      if (!config) return reply.code(404).send(NO_CONFIG);
      const made = await schedules.create(config, request.body, { id: me.id, login: me.login });
      request.log.info(
        { by: me.login, schedule: made.name, config: config.name },
        'Schedule added',
      );
      return reply.code(201).send(made);
    }),
  );

  /** The schedule of this configuration, or a 404 sent. */
  const own = async (request: FastifyRequest<P>, reply: FastifyReply) => {
    const found = request.params.schedule
      ? await schedules.get(request.params.schedule)
      : undefined;
    if (found && found.config === request.params.id) return found;
    reply.code(404).send(NO_SCHEDULE);
    return undefined;
  };

  app.patch<P & { Body: Partial<ScheduleInput> & { owner?: string } }>(
    '/api/v1/launch-configs/:id/schedules/:schedule',
    {
      schema: {
        params: PARAMS,
        body: { type: 'object', additionalProperties: false, properties: { ...FIELDS, owner: id } },
      },
    },
    answering(async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const before = await own(request, reply);
      if (!before) return reply;
      const { owner: ownerId, ...change } = request.body;
      let owner: { id: string; login: string } | undefined;
      if (ownerId !== undefined && ownerId !== before.owner.id) {
        // Handing a schedule on is an administrator's: to a service account, so it outlives a
        // person, or to themself.
        if (!administrator(request, reply)) return reply;
        const user = await schedules.owner(ownerId);
        if (!user || (!user.service && user.id !== me.id))
          throw new ScheduleError('invalid', 'A schedule is handed to a service account', 'owner');
        if (user.disabled) throw new ScheduleError('invalid', `${user.login} is disabled`, 'owner');
        owner = { id: user.id, login: user.login };
      }
      const changed = await schedules.update(before.id, { ...change, ...(owner ? { owner } : {}) });
      request.log.info(
        { by: me.login, schedule: changed.name, changed: Object.keys(request.body).join(',') },
        'Schedule changed',
      );
      return changed;
    }),
  );

  app.delete<P>(
    '/api/v1/launch-configs/:id/schedules/:schedule',
    { schema: { params: PARAMS } },
    answering(async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const before = await own(request, reply);
      if (!before) return reply;
      await schedules.remove(before.id);
      request.log.info({ by: me.login, schedule: before.name }, 'Schedule deleted');
      return reply.code(204).send();
    }),
  );

  app.get<{ Querystring: { cron: string; timezone?: string } }>(
    '/api/v1/schedule-times',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['cron'],
          properties: { cron: text(200, 1), timezone: text(64) },
        },
      },
    },
    answering(async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const times = schedules.preview(request.query.cron, request.query.timezone);
      return { times };
    }),
  );
}
