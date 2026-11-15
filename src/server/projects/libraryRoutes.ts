// AFS-79: the flow library over the API: the subflows libraries offer (to the person asking: the
// libraries whose workspace they may read), and one of them as it is now, to copy.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { accessOf, atLeast } from '../access/grants';
import { signedIn } from '../auth/guards';
import type { Schema } from '../db/schema';
import type { Git } from './git';
import { Library } from './library';

export function registerLibrary(
  app: FastifyInstance,
  deps: { db: Kysely<Schema>; git: Git; library?: Library },
): void {
  const library = deps.library ?? new Library(deps);
  const mayRead = async (request: Parameters<typeof accessOf>[1]) => {
    const access = await accessOf(deps.db, request);
    return (workspace: string) => atLeast(access?.onWorkspace(workspace), 'ro');
  };

  app.get('/api/v1/library/subflows', async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    return { subflows: await library.list(await mayRead(request)) };
  });

  app.get<{ Querystring: { from: string } }>(
    '/api/v1/library/subflow',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['from'],
          properties: { from: { type: 'string', minLength: 1, maxLength: 2000 } },
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const found = await library.subflow(await mayRead(request), request.query.from);
      // Not offered and not readable look the same: a library one may not read stays unknown.
      if (!found)
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'The library offers no such subflow' });
      return found;
    },
  );
}
