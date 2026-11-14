// GET /api/v1/search?q= (AFS-69): what the question names, among what the person may see.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { Access, accessOf } from '../access/grants';
import { signedIn } from '../auth/guards';
import type { Schema } from '../db/schema';
import { ProjectFlows } from '../projects/flows';
import type { Git } from '../projects/git';
import { search } from './search';

export function registerSearch(app: FastifyInstance, deps: { db: Kysely<Schema>; git: Git }): void {
  const flows = new ProjectFlows(deps.git);
  app.get<{ Querystring: { q: string } }>(
    '/api/v1/search',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          properties: { q: { type: 'string', minLength: 1, maxLength: 100 } },
        },
      },
    },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const access = (await accessOf(deps.db, request)) ?? (await Access.of(deps.db, me));
      // A token made for one workspace searches only there: it reaches nothing else.
      const scoped = me.token?.workspace;
      return search({ db: deps.db, flows }, access, me.admin && !scoped, request.query.q, scoped);
    },
  );
}
