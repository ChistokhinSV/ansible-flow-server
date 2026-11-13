// Grants over HTTP: administrators give and take levels in a workspace, and see who can do what.
//   /api/v1/workspaces/:id/grants      list, give
//   /api/v1/grants/:id                 take back
//   /api/v1/workspaces/:id/access      who can do what: every user with access, as it comes out
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { administrator } from '../auth/guards';
import type { Schema } from '../db/schema';
import { getWorkspace } from '../projects/store';
import { createGrant, deleteGrant, GrantError, listGrants, type NewGrant, whoCan } from './grants';

const STATUS: Record<GrantError['code'], number> = { invalid: 400, not_found: 404, taken: 409 };
const text = (max: number, min = 1) => ({ type: 'string', minLength: min, maxLength: max });
const ID = { params: { type: 'object', properties: { id: text(64) }, required: ['id'] } };
const NO_WORKSPACE = { error: 'not_found', message: 'No such workspace' };

export function registerAccess(app: FastifyInstance, deps: { db: Kysely<Schema> }): void {
  const { db } = deps;
  type WithId = { Params: { id: string } };

  app.get<WithId>('/api/v1/workspaces/:id/grants', { schema: ID }, async (request, reply) => {
    if (!administrator(request, reply)) return reply;
    const workspace = await getWorkspace(db, request.params.id);
    return workspace ? listGrants(db, workspace.id) : reply.code(404).send(NO_WORKSPACE);
  });

  app.post<WithId & { Body: NewGrant }>(
    '/api/v1/workspaces/:id/grants',
    {
      schema: {
        ...ID,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['level'],
          properties: {
            // A user by id or login, or a group by id or name.
            user: text(64),
            group: text(200),
            level: { type: 'string', enum: ['ro', 'operator', 'rw', 'approve'] },
            // For a grant on one flow: its project (id) and its file.
            project: text(64),
            flow: text(500),
          },
        },
      },
    },
    async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const workspace = await getWorkspace(db, request.params.id);
      if (!workspace) return reply.code(404).send(NO_WORKSPACE);
      try {
        const grant = await createGrant(db, workspace.id, request.body, me.login);
        request.log.info(
          {
            by: me.login,
            workspace: workspace.key,
            to: `${grant.principal.type}:${grant.principal.name}`,
            level: grant.level,
            ...(grant.flow ? { flow: `${grant.flow.projectKey}/${grant.flow.file}` } : {}),
          },
          'Access granted',
        );
        return reply.code(201).send(grant);
      } catch (e) {
        if (e instanceof GrantError)
          return reply.code(STATUS[e.code]).send({ error: e.code, message: e.message });
        throw e;
      }
    },
  );

  app.delete<WithId>('/api/v1/grants/:id', { schema: ID }, async (request, reply) => {
    const me = administrator(request, reply);
    if (!me) return reply;
    if (!(await deleteGrant(db, request.params.id)))
      return reply.code(404).send({ error: 'not_found', message: 'No such grant' });
    request.log.info({ by: me.login, grant: request.params.id }, 'Access taken back');
    return reply.code(204).send();
  });

  app.get<WithId>('/api/v1/workspaces/:id/access', { schema: ID }, async (request, reply) => {
    if (!administrator(request, reply)) return reply;
    const workspace = await getWorkspace(db, request.params.id);
    return workspace ? whoCan(db, workspace.id) : reply.code(404).send(NO_WORKSPACE);
  });
}
