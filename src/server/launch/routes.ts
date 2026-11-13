// Launch configurations over HTTP (AFS-27): ro on a flow sees its configurations and asks what a
// launch would run; operator launches as the configuration says; rw makes and changes them and
// launches another branch or commit. Most of it is checked before (api/catalog.ts); what depends
// on the body (the flow of a new configuration, another branch at launch) is checked here.
//   /api/v1/projects/:id/launch-configs
//   /api/v1/launch-configs/:id
//   /api/v1/launch-configs/:id/form     the flow's inputs as a form, with the start values
//   /api/v1/launch-configs/:id/check    what a launch would run, or what stands in its way
//   /api/v1/launch-configs/:id/launch   the same, and the run goes in the queue
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { accessOf, atLeast } from '../access/grants';
import { signedIn } from '../auth/guards';
import { getProject } from '../projects/store';
import type { RunQueue } from '../runs/queue';
import { type LaunchConfigInput, LaunchConfigs, LaunchError } from './configs';
import { type LaunchRequest, type PrepareDeps, prepareLaunch, withoutSecrets } from './prepare';

const STATUS: Record<LaunchError['code'], number> = { invalid: 400, not_found: 404, taken: 409 };
const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const orNull = (max: number) => ({ type: ['string', 'null'], maxLength: max });
const ID = { params: { type: 'object', properties: { id: text(64, 1) }, required: ['id'] } };
const NONE = { error: 'not_found', message: 'No such launch configuration' };

const CONFIG = {
  name: text(100, 1),
  description: text(1000),
  flowFile: text(500, 1),
  gitRef: orNull(200),
  commit: orNull(40),
  inventory: orNull(500),
  eeImage: orNull(300),
  mode: { type: 'string', enum: ['check', 'real'] },
  limit: orNull(500),
  // Values of any kind the flow's inputs take; the store checks each against its input.
  inputs: { type: 'object', maxProperties: 200 },
  credentials: { type: 'array', maxItems: 20, items: text(64, 1) },
};
const REQUEST = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: CONFIG.mode,
    ref: text(200, 1),
    commit: text(40, 40),
    limit: text(500),
    inputs: {
      type: 'object',
      maxProperties: 200,
      additionalProperties: { type: 'string', maxLength: 100_000 },
    },
  },
};

export function registerLaunch(
  app: FastifyInstance,
  deps: PrepareDeps & { queue?: RunQueue },
): void {
  const configs = new LaunchConfigs(deps.db, deps.git);
  const answering =
    <R extends FastifyRequest>(handler: (request: R, reply: FastifyReply) => Promise<unknown>) =>
    async (request: R, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (e) {
        if (e instanceof LaunchError)
          return reply.code(STATUS[e.code]).send({
            error: e.code,
            message: e.message,
            ...(e.field ? { field: e.field } : {}),
          });
        throw e;
      }
    };
  type WithId = { Params: { id: string } };
  /** True when the person asking has `rw` on this flow of this project; else answers 403. */
  const mayManage = async (
    request: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
    file: string,
  ) => {
    const project = await getProject(deps.db, projectId);
    const access = await accessOf(deps.db, request);
    if (project && access && atLeast(access.onFlow(project.workspace, project.id, file), 'rw'))
      return true;
    reply.code(403).send({ error: 'forbidden', message: `This needs rw on ${file}` });
    return false;
  };

  app.get<WithId>('/api/v1/projects/:id/launch-configs', { schema: ID }, async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    const project = await getProject(deps.db, request.params.id);
    if (!project) return reply.code(404).send({ error: 'not_found', message: 'No such project' });
    // The configurations of the flows this person may see.
    const access = await accessOf(deps.db, request);
    return (await configs.list(project.id)).filter((c) =>
      access?.onFlow(project.workspace, project.id, c.flowFile),
    );
  });

  app.post<WithId & { Body: LaunchConfigInput }>(
    '/api/v1/projects/:id/launch-configs',
    {
      schema: {
        ...ID,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'flowFile'],
          properties: CONFIG,
        },
      },
    },
    answering(async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      if (!(await mayManage(request, reply, request.params.id, request.body.flowFile)))
        return reply;
      const made = await configs.create(request.params.id, request.body);
      request.log.info(
        { by: me.login, config: made.name, flow: made.flowFile, mode: made.mode },
        'Launch configuration added',
      );
      return reply.code(201).send(made);
    }),
  );

  app.get<WithId>('/api/v1/launch-configs/:id', { schema: ID }, async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    return (await configs.get(request.params.id)) ?? reply.code(404).send(NONE);
  });

  app.patch<WithId & { Body: Partial<LaunchConfigInput> }>(
    '/api/v1/launch-configs/:id',
    {
      schema: {
        ...ID,
        body: { type: 'object', additionalProperties: false, properties: CONFIG },
      },
    },
    answering(async (request, reply) => {
      // rw on its flow: checked before; pointed at another flow, rw on that one too.
      const me = signedIn(request, reply);
      if (!me) return reply;
      const before = await configs.get(request.params.id);
      if (
        before &&
        request.body.flowFile &&
        request.body.flowFile !== before.flowFile &&
        !(await mayManage(request, reply, before.project, request.body.flowFile))
      )
        return reply;
      const changed = await configs.update(request.params.id, request.body);
      request.log.info(
        { by: me.login, config: changed.name, changed: Object.keys(request.body) },
        'Launch configuration changed',
      );
      return changed;
    }),
  );

  app.delete<WithId>(
    '/api/v1/launch-configs/:id',
    { schema: ID },
    answering(async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const config = await configs.get(request.params.id);
      if (!config) return reply.code(404).send(NONE);
      await configs.delete(config.id);
      request.log.info({ by: me.login, config: config.name }, 'Launch configuration deleted');
      return reply.code(204).send();
    }),
  );

  /** The form of a launch: reads only, and does not ask the source (a page opens fast). */
  app.get<WithId & { Querystring: { mode?: 'check' | 'real'; ref?: string; commit?: string } }>(
    '/api/v1/launch-configs/:id/form',
    {
      schema: {
        ...ID,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { mode: CONFIG.mode, ref: text(200, 1), commit: text(40, 40) },
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const config = await configs.get(request.params.id);
      if (!config) return reply.code(404).send(NONE);
      const prepared = await prepareLaunch(deps, config, request.query, false);
      // A form with empty required inputs is still a form: only what leaves no form is refused.
      if (prepared.form) return prepared.form;
      return reply
        .code(422)
        .send({ error: 'not_ready', problems: prepared.ok ? [] : prepared.problems });
    },
  );

  /**
   * What a launch would run: the commit (after a look at the source), the inputs as the flow
   * reads them, the hosts it starts on. Nothing runs. 422 lists everything in the way.
   * It is a POST because typed inputs can be secret: they do not belong in an address.
   */
  app.post<WithId & { Body: LaunchRequest }>(
    '/api/v1/launch-configs/:id/check',
    { schema: { ...ID, body: REQUEST } },
    async (request, reply) => {
      // Asking changes nothing, so a read-only token may ask.
      if (!request.user)
        return reply.code(401).send({ error: 'unauthorized', message: 'Sign in first' });
      const config = await configs.get(request.params.id);
      if (!config) return reply.code(404).send(NONE);
      const prepared = await prepareLaunch(deps, config, request.body ?? {});
      if (!prepared.ok)
        return reply.code(422).send({
          error: 'not_ready',
          message: prepared.problems[0]?.message ?? 'The launch is not ready',
          problems: prepared.problems,
          ...(prepared.form ? { form: prepared.form } : {}),
        });
      return { launch: withoutSecrets(prepared.launch, prepared.form.fields), form: prepared.form };
    },
  );

  const queue = deps.queue;
  if (!queue) return;
  /** Settles a launch as `check` does, and puts the run in the queue. */
  app.post<WithId & { Body: LaunchRequest }>(
    '/api/v1/launch-configs/:id/launch',
    { schema: { ...ID, body: REQUEST } },
    async (request, reply) => {
      // operator on its flow: checked before. Another branch or commit than the configuration
      // names is rw's: an operator runs what was set up for them.
      const me = signedIn(request, reply);
      if (!me) return reply;
      const config = await configs.get(request.params.id);
      if (!config) return reply.code(404).send(NONE);
      const asked = request.body ?? {};
      if (
        ((asked.ref && asked.ref !== config.gitRef) ||
          (asked.commit && asked.commit !== config.commit)) &&
        !(await mayManage(request, reply, config.project, config.flowFile))
      )
        return reply;
      const prepared = await prepareLaunch(deps, config, request.body ?? {});
      if (!prepared.ok)
        return reply.code(422).send({
          error: 'not_ready',
          message: prepared.problems[0]?.message ?? 'The launch is not ready',
          problems: prepared.problems,
          ...(prepared.form ? { form: prepared.form } : {}),
        });
      const shown = withoutSecrets(prepared.launch, prepared.form.fields).inputs;
      const run = await queue.enqueue(prepared.launch, shown, me, config.name);
      request.log.info(
        {
          by: me.login,
          run: run.id,
          number: run.number,
          flow: run.flow.file,
          commit: run.commit.slice(0, 12),
          mode: run.mode,
        },
        'Run queued',
      );
      return reply.code(201).send(run);
    },
  );
}
