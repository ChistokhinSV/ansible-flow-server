// AFS-212: `GET /api/v1/inbox`, what needs the asker now (inbox.ts).
import type { FastifyInstance } from 'fastify';
import { Access, accessOf } from '../access/grants';
import { grantedActions } from '../actions/store';
import { signedIn } from '../auth/guards';
import { getWorkspace } from '../projects/store';
import { type InboxDeps, inboxFor } from './inbox';

const DAY_MS = 86_400_000;
/** How far back `since` may go. */
const SINCE_DAYS = 7;

export function registerInbox(app: FastifyInstance, deps: InboxDeps): void {
  app.get<{ Querystring: { workspace?: string; since?: string } }>(
    '/api/v1/inbox',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            workspace: { type: 'string', minLength: 1, maxLength: 100 },
            since: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const access = (await accessOf(deps.db, request)) ?? (await Access.of(deps.db, me));
      // A token made for one workspace sees that workspace only (as every route does: this one
      // spans workspaces, so it narrows itself).
      const scoped = me.token?.workspace;
      let only = scoped;
      const asked = request.query.workspace;
      if (asked) {
        const workspace = await getWorkspace(deps.db, asked);
        // One the asker may not see is not said to be there.
        if (!workspace || !access.sees(workspace.id))
          return reply
            .code(404)
            .send({ error: 'not_found', message: `There is no workspace ${asked}` });
        if (scoped && workspace.id !== scoped)
          return reply.code(403).send({
            error: 'out_of_scope',
            message: 'This token is for one workspace: it cannot reach this',
          });
        only = workspace.id;
      }
      const now = new Date();
      // The start of the asker's day: theirs to say (the page sends its midnight); else the last
      // 24 hours. Never further back than a week: the day's numbers are of a day, and every
      // signed-in person's Home asks every few seconds.
      const since = request.query.since
        ? new Date(request.query.since)
        : new Date(now.getTime() - DAY_MS);
      if (since.getTime() < now.getTime() - SINCE_DAYS * DAY_MS)
        return reply.code(400).send({
          error: 'invalid',
          message: `since is at most ${SINCE_DAYS} days back: the start of your day`,
          field: 'since',
        });
      return inboxFor(deps, request, {
        id: me.id,
        login: me.login,
        admin: me.admin,
        access,
        granted: await grantedActions(deps.db, me.id),
        ...(only ? { only } : {}),
        since,
        now,
      });
    },
  );
}
