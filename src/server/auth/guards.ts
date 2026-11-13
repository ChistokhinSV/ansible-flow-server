// Who may ask: the checks a route makes before it does anything. `request.user` is set by the
// sign-in hook (auth/routes.ts) when the request carries a good session.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionUser } from './sessions';

/** The person signed in; else answers 401 and gives undefined. */
export function signedIn(request: FastifyRequest, reply: FastifyReply): SessionUser | undefined {
  if (request.user) return request.user;
  reply.code(401).send({ error: 'unauthorized', message: 'Sign in first' });
  return undefined;
}

/** The administrator signed in; else answers 401 or 403 and gives undefined. */
export function administrator(
  request: FastifyRequest,
  reply: FastifyReply,
): SessionUser | undefined {
  const user = signedIn(request, reply);
  if (!user) return undefined;
  if (user.admin) return user;
  reply.code(403).send({ error: 'forbidden', message: 'Only an administrator may do this' });
  return undefined;
}
