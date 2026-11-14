// What a flow needs from its execution environment, over HTTP (AFS-33):
//   GET  /api/v1/galaxy/search?q=                             collections from the collection server
//   GET  /api/v1/launch-configs/:id/environment-check         the flow's needs against its environment
//        ?environment=<id>                                    ... or against another of the workspace
//   POST /api/v1/launch-configs/:id/environment               an environment made for the flow, built
// The flow and the requirements file are read at the commit the configuration would run.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { accessOf, atLeast } from '../access/grants';
import { signedIn } from '../auth/guards';
import type { Schema } from '../db/schema';
import { flowAt, type LaunchConfig, LaunchConfigs } from '../launch/configs';
import type { Git } from '../projects/git';
import { getProject } from '../projects/store';
import { checkNeeds, flowNeeds, REQUIREMENTS_FILE, specFor } from './check';
import { EnvironmentError, type Environments } from './environments';
import type { Galaxy } from './galaxy';
import type { FlowCheck } from './types';

export type { FlowCheck } from './types';

const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });

export function registerFlowChecks(
  app: FastifyInstance,
  deps: { db: Kysely<Schema>; git: Git; environments: Environments; galaxy: Galaxy },
): void {
  const configs = new LaunchConfigs(deps.db, deps.git);
  type P = { Params: { id: string }; Querystring: { environment?: string } };
  const PARAMS = { type: 'object', properties: { id: text(64, 1) }, required: ['id'] };

  /** The flow and its needs at the commit the configuration runs now. */
  const needsOf = async (config: LaunchConfig, reply: FastifyReply) => {
    const project = await getProject(deps.db, config.project);
    if (!project) {
      reply.code(404).send({ error: 'not_found', message: 'The project is gone' });
      return undefined;
    }
    let commit = config.commit ?? project.commit;
    if (!config.commit && config.gitRef)
      commit = await deps.git.resolve(project.id, config.gitRef).catch(() => undefined);
    if (!commit) {
      reply
        .code(422)
        .send({ error: 'not_ready', message: 'There is no commit to read the flow at yet' });
      return undefined;
    }
    const flow = await flowAt(deps.git, project.id, commit, config.flowFile);
    if ('problem' in flow) {
      reply.code(422).send({ error: 'not_ready', message: flow.problem, field: 'flowFile' });
      return undefined;
    }
    const requirements = await deps.git
      .read(project.id, commit, REQUIREMENTS_FILE)
      .catch(() => undefined);
    return {
      project,
      commit,
      doc: flow.doc,
      requirementsFile: !!requirements,
      needs: flowNeeds(flow.doc, requirements?.toString('utf8')),
    };
  };

  app.get<{ Querystring: { q: string } }>(
    '/api/v1/galaxy/search',
    {
      schema: { querystring: { type: 'object', required: ['q'], properties: { q: text(100, 2) } } },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      if (!deps.galaxy.search)
        return reply
          .code(503)
          .send({ error: 'unavailable', message: 'The collection server cannot be searched' });
      try {
        return await deps.galaxy.search(request.query.q, 20);
      } catch (e) {
        return reply.code(503).send({
          error: 'unavailable',
          message: `${(e as Error).message}. Type the collection's name and version instead`,
        });
      }
    },
  );

  app.get<P>(
    '/api/v1/launch-configs/:id/environment-check',
    {
      schema: {
        params: PARAMS,
        querystring: { type: 'object', properties: { environment: text(64, 1) } },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const config = await configs.get(request.params.id);
      if (!config)
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'No such launch configuration' });
      const read = await needsOf(config, reply);
      if (!read) return reply;
      const envId = request.query.environment ?? config.environment;
      const env = envId ? await deps.environments.get(envId) : undefined;
      if (envId && (!env || env.workspace !== read.project.workspace))
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'No such environment', field: 'environment' });
      const lines = checkNeeds(read.needs, env?.catalog);
      const answer: FlowCheck = {
        flow: { file: config.flowFile, name: read.doc.flow?.name ?? config.flowFile },
        commit: read.commit,
        requirementsFile: read.requirementsFile,
        ...(env
          ? {
              environment: {
                id: env.id,
                name: env.name,
                ...(env.current ? { image: env.current } : {}),
                ...(env.catalog ? { ansibleCore: env.catalog.ansibleCore } : {}),
              },
            }
          : {}),
        lines,
        ok: !!env && lines.every((l) => l.ok),
      };
      return answer;
    },
  );

  app.post<{ Params: { id: string }; Body: { name: string } }>(
    '/api/v1/launch-configs/:id/environment',
    {
      schema: {
        params: PARAMS,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: { name: text(63, 1) },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string }; Body: { name: string } }>, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const config = await configs.get(request.params.id);
      if (!config)
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'No such launch configuration' });
      const read = await needsOf(config, reply);
      if (!read) return reply;
      // Environments are the workspace's: making one is rw on it, not only on the flow.
      const access = await accessOf(deps.db, request);
      if (!atLeast(access?.onWorkspace(read.project.workspace), 'rw'))
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'This needs rw on the workspace' });
      try {
        const env = await deps.environments.create(
          read.project.workspace,
          { name: request.body.name, kind: 'spec', spec: specFor(read.needs) },
          me.login,
        );
        await deps.environments.queue(env.id, { id: me.id, login: me.login });
        request.log.info(
          { by: me.login, environment: env.name, flow: config.flowFile },
          'Environment made for a flow',
        );
        return reply.code(201).send(await deps.environments.get(env.id));
      } catch (e) {
        if (e instanceof EnvironmentError)
          return reply
            .code(e.code === 'taken' ? 409 : 400)
            .send({ error: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) });
        throw e;
      }
    },
  );
}
