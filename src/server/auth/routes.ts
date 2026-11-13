// Sign-in and the people who sign in, over HTTP.
//   /api/v1/setup              is a first administrator needed; make one (with the setup code)
//   /api/v1/session            sign in (POST), who am I (GET), sign out (DELETE)
//   /api/v1/session/password   change my password
//   /api/v1/users, /groups     administrators: people and groups
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { getWorkspace } from '../projects/store';
import { administrator, inSession, signedIn } from './guards';
import { FailureLimiter } from './limiter';
import { PASSWORD_MAX, passwordProblem, verifyPassword } from './passwords';
import {
  endSession,
  type SessionUser,
  sessionCookie,
  sessionUser,
  startSession,
  tokenOf,
} from './sessions';
import { createFirstAdmin, setupNeeded } from './setup';
import {
  createToken,
  listTokens,
  looksLikeToken,
  revokeToken,
  TOKEN_MAX_DAYS,
  tokenOfHeader,
  tokenUser,
} from './tokens';
import {
  accountByLogin,
  createGroup,
  createUser,
  deleteGroup,
  deleteUser,
  getGroup,
  getUser,
  listGroups,
  listUsers,
  normalLogin,
  setMembers,
  setPassword,
  UserError,
  updateGroup,
  updateUser,
} from './users';

declare module 'fastify' {
  interface FastifyRequest {
    /** The person signed in on this request, when its session is good. */
    user?: SessionUser;
    sessionToken?: string;
  }
}

export interface AuthDeps {
  db: Kysely<Schema>;
  /** The session cookie is marked for HTTPS only (always, unless the server speaks plain HTTP). */
  secureCookies: boolean;
}

/** Five wrong passwords for a login, or thirty from an address, in fifteen minutes. */
const WINDOW_MS = 15 * 60 * 1000;

const STATUS: Record<UserError['code'], number> = {
  invalid: 400,
  not_found: 404,
  taken: 409,
  last_admin: 409,
};

const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const optional = (max: number) => ({ type: ['string', 'null'], maxLength: max });
const body = (required: string[], properties: Record<string, unknown>) => ({
  body: { type: 'object', additionalProperties: false, required, properties },
});
const ID = { params: { type: 'object', properties: { id: text(64, 1) }, required: ['id'] } };

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const { db } = deps;
  const byLogin = new FailureLimiter({ max: 5, windowMs: WINDOW_MS });
  const byAddress = new FailureLimiter({ max: 30, windowMs: WINDOW_MS });

  app.decorateRequest('user', undefined);
  app.decorateRequest('sessionToken', undefined);

  /** 429 with how long to wait, when this login or this address has failed too often. */
  const tooMany = (reply: FastifyReply, ...waits: number[]) => {
    const wait = Math.max(...waits);
    if (wait <= 0) return false;
    reply
      .code(429)
      .header('retry-after', String(wait))
      .send({
        error: 'too_many_attempts',
        message: `Too many wrong attempts: try again in ${Math.ceil(wait / 60)} minutes`,
        retryAfter: wait,
      });
    return true;
  };

  app.addHook('onRequest', async (request, reply) => {
    // A request that changes something must come from this server's own pages, not from another
    // site's: browsers name the page's origin, and it has to be the address that was asked.
    const origin = request.headers.origin;
    if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      let host: string | undefined;
      try {
        host = new URL(origin).host;
      } catch {}
      if (host !== request.headers.host)
        return reply
          .code(403)
          .send({ error: 'cross_site', message: 'This request came from another site' });
    }
    const token = tokenOf(request.headers.cookie);
    if (token) {
      request.user = await sessionUser(db, token);
      if (request.user) request.sessionToken = token;
    }
    // No session: a personal access token, as a bearer or as the password git sends.
    const access = request.user ? undefined : tokenOfHeader(request.headers.authorization);
    if (access && looksLikeToken(access)) {
      const address = `ip:${request.ip}`;
      if (tooMany(reply, byAddress.retryAfter(address))) return reply;
      request.user = await tokenUser(db, access);
      // A token that is not one counts as a wrong attempt: it must not be guessable.
      if (!request.user) {
        byAddress.fail(address);
        if (request.url.startsWith('/git/'))
          reply.header('www-authenticate', 'Basic realm="Ansible Flow Server"');
        return reply
          .code(401)
          .send({ error: 'unauthorized', message: 'The token is not valid, or is past its end' });
      }
    }
    return undefined;
  });

  /** Runs a handler; what the rules refuse becomes its HTTP answer. */
  const answering =
    <R extends FastifyRequest>(handler: (request: R, reply: FastifyReply) => Promise<unknown>) =>
    async (request: R, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (e) {
        if (e instanceof UserError)
          return reply.code(STATUS[e.code]).send({ error: e.code, message: e.message });
        throw e;
      }
    };
  const signIn = async (request: FastifyRequest, reply: FastifyReply, userId: string) => {
    const token = await startSession(db, userId, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    reply.header('set-cookie', sessionCookie(token, deps.secureCookies));
  };
  // --- the first administrator

  app.get('/api/v1/setup', async () => ({ needed: await setupNeeded(db) }));

  type SetupBody = { code: string; login: string; name?: string; password: string; email?: string };
  app.post<{ Body: SetupBody }>(
    '/api/v1/setup',
    {
      schema: body(['code', 'login', 'password'], {
        code: text(64, 1),
        login: text(64, 1),
        name: text(200),
        password: text(PASSWORD_MAX, 1),
        email: text(320),
      }),
    },
    answering(async (request, reply) => {
      const address = `ip:${request.ip}`;
      if (tooMany(reply, byAddress.retryAfter(address))) return reply;
      const { code, ...input } = request.body;
      try {
        const user = await createFirstAdmin(db, code, { ...input, name: input.name ?? '' });
        request.log.info({ login: user.login }, 'The first administrator was made');
        await signIn(request, reply, user.id);
        return reply.code(201).send(user);
      } catch (e) {
        // A wrong code counts as a wrong attempt: it must not be guessable.
        if (e instanceof UserError && /setup code/.test(e.message)) byAddress.fail(address);
        throw e;
      }
    }),
  );

  // --- the session

  app.post<{ Body: { login: string; password: string } }>(
    '/api/v1/session',
    {
      schema: body(['login', 'password'], { login: text(64, 1), password: text(PASSWORD_MAX, 1) }),
    },
    async (request, reply) => {
      const login = normalLogin(request.body.login);
      const keys = [`login:${login}`, `ip:${request.ip}`] as const;
      if (tooMany(reply, byLogin.retryAfter(keys[0]), byAddress.retryAfter(keys[1]))) return reply;
      const account = await accountByLogin(db, login);
      const right = await verifyPassword(request.body.password, account?.password_hash ?? null);
      if (!account || !right || account.disabled === 1) {
        byLogin.fail(keys[0]);
        byAddress.fail(keys[1]);
        request.log.warn({ login }, 'Sign-in refused');
        // One answer for a wrong login, a wrong password and a disabled account.
        return reply
          .code(401)
          .send({ error: 'invalid_credentials', message: 'The login or the password is wrong' });
      }
      byLogin.clear(keys[0]);
      await signIn(request, reply, account.id);
      request.log.info({ login }, 'Signed in');
      return getUser(db, account.id);
    },
  );

  app.get('/api/v1/session', async (request, reply) => {
    const me = signedIn(request, reply);
    return me ? getUser(db, me.id) : reply;
  });

  // AFS-29: a person changes their own name and email address; a webhook (the server calls the
  // address it is given) only an administrator. With a session: a token that leaked must not be
  // able to send someone's mail elsewhere.
  type ProfileBody = { name?: string; email?: string | null; webhookUrl?: string | null };
  app.patch<{ Body: ProfileBody }>(
    '/api/v1/session',
    {
      schema: body([], { name: text(200, 1), email: optional(320), webhookUrl: optional(2000) }),
    },
    answering(async (request, reply) => {
      const me = inSession(request, reply);
      if (!me) return reply;
      if (request.body.webhookUrl !== undefined && !me.admin)
        return reply.code(403).send({
          error: 'forbidden',
          message: 'Only an administrator sets a webhook: the server calls the address it is given',
          field: 'webhookUrl',
        });
      const user = await updateUser(db, me.id, request.body);
      request.log.info(
        { login: me.login, changed: Object.keys(request.body).join(',') },
        'Own account changed',
      );
      return user;
    }),
  );

  app.delete('/api/v1/session', async (request, reply) => {
    if (request.sessionToken) await endSession(db, request.sessionToken);
    return reply
      .header('set-cookie', sessionCookie(undefined, deps.secureCookies))
      .code(204)
      .send();
  });

  app.put<{ Body: { current: string; password: string } }>(
    '/api/v1/session/password',
    {
      schema: body(['current', 'password'], {
        current: text(PASSWORD_MAX, 1),
        password: text(PASSWORD_MAX, 1),
      }),
    },
    answering(async (request, reply) => {
      const me = inSession(request, reply);
      if (!me) return reply;
      const key = `login:${me.login}`;
      if (tooMany(reply, byLogin.retryAfter(key))) return reply;
      const account = await accountByLogin(db, me.login);
      if (!(await verifyPassword(request.body.current, account?.password_hash ?? null))) {
        byLogin.fail(key);
        return reply
          .code(403)
          .send({ error: 'invalid_credentials', message: 'The current password is wrong' });
      }
      const problem = passwordProblem(request.body.password, me.login);
      if (problem) throw new UserError('invalid', problem);
      // The other sessions of this person end: whoever knew the old password is out.
      await setPassword(db, me.id, request.body.password, me.session);
      request.log.info({ login: me.login }, 'Password changed');
      return reply.code(204).send();
    }),
  );

  // --- my tokens

  app.get('/api/v1/tokens', async (request, reply) => {
    const me = signedIn(request, reply);
    return me ? listTokens(db, me.id) : reply;
  });

  type TokenBody = {
    name: string;
    expiresInDays?: number;
    readOnly?: boolean;
    workspace?: string;
  };
  const TOKEN_BODY = body(['name'], {
    name: text(100, 1),
    expiresInDays: { type: 'integer', minimum: 1, maximum: TOKEN_MAX_DAYS },
    readOnly: { type: 'boolean' },
    // A workspace's id or key: the token reaches that workspace only.
    workspace: text(64, 1),
  });
  /** What a token is made with, the workspace named by its id or its key, checked. */
  const tokenInput = async (input: TokenBody) => {
    const workspace = input.workspace ? await getWorkspace(db, input.workspace) : undefined;
    if (input.workspace && !workspace)
      throw new UserError('invalid', `No workspace ${input.workspace}`);
    return {
      name: input.name,
      days: input.expiresInDays,
      readOnly: input.readOnly,
      ...(workspace ? { workspace: workspace.id } : {}),
    };
  };

  app.post<{ Body: TokenBody }>(
    '/api/v1/tokens',
    { schema: TOKEN_BODY },
    answering(async (request, reply) => {
      // Not with a token: a token that leaked must not be able to make itself a successor.
      const me = inSession(request, reply);
      if (!me) return reply;
      const made = await createToken(db, me.id, await tokenInput(request.body));
      request.log.info({ login: me.login, name: made.info.name }, 'Access token made');
      // The token is in this answer and nowhere else, ever.
      return reply.code(201).send({ ...made.info, token: made.token });
    }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/tokens/:id',
    { schema: ID },
    async (request, reply) => {
      const me = inSession(request, reply);
      if (!me) return reply;
      if (!(await revokeToken(db, me.id, request.params.id)))
        return reply.code(404).send({ error: 'not_found', message: 'No such token' });
      request.log.info({ login: me.login }, 'Access token revoked');
      return reply.code(204).send();
    },
  );

  // --- other people's tokens (administrators): seen and revoked; made only for a service
  // account, which has no session to make its own

  app.post<{ Params: { id: string }; Body: TokenBody }>(
    '/api/v1/users/:id/tokens',
    { schema: { ...ID, ...TOKEN_BODY } },
    answering(async (request, reply) => {
      const me = inSession(request, reply, true);
      if (!me) return reply;
      const account = await getUser(db, request.params.id);
      if (!account) return reply.code(404).send({ error: 'not_found', message: 'No such user' });
      if (!account.service)
        throw new UserError(
          'invalid',
          'Tokens are made by the person themself; administrators make them for service accounts only',
        );
      const made = await createToken(db, account.id, await tokenInput(request.body));
      request.log.info(
        { by: me.login, login: account.login, name: made.info.name },
        'Access token made for a service account',
      );
      return reply.code(201).send({ ...made.info, token: made.token });
    }),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/users/:id/tokens',
    { schema: ID },
    async (request, reply) =>
      administrator(request, reply) ? listTokens(db, request.params.id) : reply,
  );

  app.delete<{ Params: { id: string; token: string } }>(
    '/api/v1/users/:id/tokens/:token',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: text(64, 1), token: text(64, 1) },
          required: ['id', 'token'],
        },
      },
    },
    async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      if (!(await revokeToken(db, request.params.id, request.params.token)))
        return reply.code(404).send({ error: 'not_found', message: 'No such token' });
      request.log.info({ by: me.login, user: request.params.id }, 'Access token revoked');
      return reply.code(204).send();
    },
  );

  // --- people (administrators)

  app.get('/api/v1/users', async (request, reply) =>
    administrator(request, reply) ? listUsers(db) : reply,
  );

  type NewUserBody = {
    login: string;
    name?: string;
    password?: string;
    email?: string;
    webhookUrl?: string;
    admin?: boolean;
    service?: boolean;
  };
  app.post<{ Body: NewUserBody }>(
    '/api/v1/users',
    {
      schema: body(['login'], {
        login: text(64, 1),
        name: text(200),
        password: text(PASSWORD_MAX, 1),
        email: text(320),
        webhookUrl: text(2000),
        admin: { type: 'boolean' },
        service: { type: 'boolean' },
      }),
    },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const input = request.body;
      const problem = input.password ? passwordProblem(input.password, input.login) : undefined;
      if (problem) throw new UserError('invalid', problem);
      const user = await createUser(db, { ...input, name: input.name ?? '' });
      request.log.info({ by: me.login, login: user.login, admin: user.admin }, 'User added');
      return reply.code(201).send(user);
    }),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/users/:id',
    { schema: ID },
    async (request, reply) => {
      if (!administrator(request, reply)) return reply;
      return (
        (await getUser(db, request.params.id)) ??
        reply.code(404).send({ error: 'not_found', message: 'No such user' })
      );
    },
  );

  type UserChangeBody = {
    name?: string;
    email?: string | null;
    webhookUrl?: string | null;
    admin?: boolean;
    disabled?: boolean;
  };
  app.patch<{ Params: { id: string }; Body: UserChangeBody }>(
    '/api/v1/users/:id',
    {
      schema: {
        ...ID,
        ...body([], {
          name: text(200),
          email: optional(320),
          webhookUrl: optional(2000),
          admin: { type: 'boolean' },
          disabled: { type: 'boolean' },
        }),
      },
    },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const user = await updateUser(db, request.params.id, request.body);
      // What changed, by name: a webhook's address can be its secret.
      request.log.info(
        { by: me.login, login: user.login, changed: Object.keys(request.body).join(',') },
        'User changed',
      );
      return user;
    }),
  );

  app.put<{ Params: { id: string }; Body: { password: string } }>(
    '/api/v1/users/:id/password',
    { schema: { ...ID, ...body(['password'], { password: text(PASSWORD_MAX, 1) }) } },
    answering(async (request, reply) => {
      // Not with a token: one that leaked must not be able to give anyone a password it knows.
      const me = inSession(request, reply, true);
      if (!me) return reply;
      const user = await getUser(db, request.params.id);
      if (!user) throw new UserError('not_found', 'No such user');
      const problem = passwordProblem(request.body.password, user.login);
      if (problem) throw new UserError('invalid', problem);
      await setPassword(
        db,
        user.id,
        request.body.password,
        user.id === me.id ? me.session : undefined,
      );
      request.log.info({ by: me.login, login: user.login }, 'Password set by an administrator');
      return reply.code(204).send();
    }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/users/:id',
    { schema: ID },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      if (request.params.id === me.id)
        throw new UserError('invalid', 'You cannot delete your own account');
      await deleteUser(db, request.params.id);
      request.log.info({ by: me.login, user: request.params.id }, 'User deleted');
      return reply.code(204).send();
    }),
  );

  // --- groups (administrators)

  app.get('/api/v1/groups', async (request, reply) =>
    administrator(request, reply) ? listGroups(db) : reply,
  );

  type GroupBody = { name: string; email?: string; webhookUrl?: string };
  app.post<{ Body: GroupBody }>(
    '/api/v1/groups',
    { schema: body(['name'], { name: text(64, 1), email: text(320), webhookUrl: text(2000) }) },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const group = await createGroup(db, request.body);
      request.log.info({ by: me.login, group: group.name }, 'Group added');
      return reply.code(201).send(group);
    }),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/groups/:id',
    { schema: ID },
    async (request, reply) => {
      if (!administrator(request, reply)) return reply;
      return (
        (await getGroup(db, request.params.id)) ??
        reply.code(404).send({ error: 'not_found', message: 'No such group' })
      );
    },
  );

  type GroupChangeBody = { name?: string; email?: string | null; webhookUrl?: string | null };
  app.patch<{ Params: { id: string }; Body: GroupChangeBody }>(
    '/api/v1/groups/:id',
    {
      schema: {
        ...ID,
        ...body([], { name: text(64, 1), email: optional(320), webhookUrl: optional(2000) }),
      },
    },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const group = await updateGroup(db, request.params.id, request.body);
      request.log.info({ by: me.login, group: group.name }, 'Group changed');
      return group;
    }),
  );

  app.put<{ Params: { id: string }; Body: { users: string[] } }>(
    '/api/v1/groups/:id/members',
    {
      schema: {
        ...ID,
        ...body(['users'], { users: { type: 'array', maxItems: 10_000, items: text(64, 1) } }),
      },
    },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const group = await setMembers(db, request.params.id, request.body.users);
      request.log.info(
        { by: me.login, group: group.name, members: group.members.length },
        'Group members set',
      );
      return group;
    }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/groups/:id',
    { schema: ID },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      await deleteGroup(db, request.params.id);
      request.log.info({ by: me.login, group: request.params.id }, 'Group deleted');
      return reply.code(204).send();
    }),
  );
}
