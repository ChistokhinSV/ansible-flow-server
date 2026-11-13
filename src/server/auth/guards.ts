// Who may ask: the checks a route makes before it does anything. `request.user` is set by the
// sign-in hook (auth/routes.ts) when the request carries a good session or a good token.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionUser } from './sessions';

const READS = ['GET', 'HEAD', 'OPTIONS'];

/** The person signed in; else answers 401 (or 403 for a read-only token) and gives undefined. */
export function signedIn(request: FastifyRequest, reply: FastifyReply): SessionUser | undefined {
  const user = request.user;
  if (!user) {
    reply.code(401).send({ error: 'unauthorized', message: 'Sign in first' });
    return undefined;
  }
  if (user.token?.readOnly && !READS.includes(request.method)) {
    reply.code(403).send({ error: 'read_only_token', message: 'This token may only read' });
    return undefined;
  }
  return user;
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

/**
 * The person signed in with a session, not a token: for what a leaked token must not be able to
 * do (make more tokens, change the password).
 */
export function inSession(
  request: FastifyRequest,
  reply: FastifyReply,
  admin = false,
): SessionUser | undefined {
  const user = admin ? administrator(request, reply) : signedIn(request, reply);
  if (!user) return undefined;
  if (!user.token) return user;
  reply
    .code(403)
    .send({ error: 'session_needed', message: 'Sign in with your password to do this' });
  return undefined;
}
