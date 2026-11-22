// AFS-183: where a value comes from, on the pages: the designer's variable index of a project's
// repository at a commit (vars.ts), for the canvas the pages embed (the flow, a draft, a run, a
// flow at a commit). It reads the repository's files, so it asks what the Files tab asks: ro on the
// project (api/catalog.ts checks it before the handler). Nothing secret is in it.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { pathProblem } from '../launch/configs';
import { type Git, GitError } from './git';
import { getProject } from './store';
import type { VarIndexes } from './vars';

export interface VarsRouteDeps {
  db: Kysely<Schema>;
  git: Git;
  vars: VarIndexes;
}

const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const ID = { params: { type: 'object', properties: { id: text(64, 1) }, required: ['id'] } };
const NAMES = { type: 'array', maxItems: 200, items: text(500, 1) };

export function registerVars(app: FastifyInstance, deps: VarsRouteDeps): void {
  app.post<{
    Params: { id: string };
    Body: { commit: string; inventory?: string; roles?: string[]; files?: string[] };
  }>(
    '/api/v1/projects/:id/vars',
    {
      schema: {
        ...ID,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['commit'],
          properties: {
            commit: { type: 'string', pattern: '^[0-9a-f]{40}$' },
            inventory: text(500),
            roles: NAMES,
            files: NAMES,
          },
        },
      },
    },
    async (request, reply) => {
      // AFS-189: it reads, so a read-only token may ask (signedIn refuses it every POST).
      if (!request.user)
        return reply.code(401).send({ error: 'unauthorized', message: 'Sign in first' });
      const project = await getProject(deps.db, request.params.id);
      if (!project) return reply.code(404).send({ error: 'not_found', message: 'No such project' });
      const { commit, inventory, roles, files } = request.body;
      if (inventory && pathProblem(inventory))
        return reply.code(422).send({
          error: 'invalid',
          message: 'Not a path inside the repository',
          field: 'inventory',
        });
      if (!(await deps.git.hasCommit(project.id, commit)))
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'The project has no such commit' });
      try {
        const index = await deps.vars.index(project.id, commit, {
          ...(inventory ? { inventory } : {}),
          ...(roles ? { roles } : {}),
          ...(files ? { files } : {}),
        });
        return { commit, index };
      } catch (e) {
        if (e instanceof GitError)
          return reply
            .code(404)
            .send({ error: 'not_found', message: 'The repository cannot be read now' });
        throw e;
      }
    },
  );
}
