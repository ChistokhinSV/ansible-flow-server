// Sign-in with OIDC providers over HTTP (AFS-30).
//   GET  /api/v1/auth/methods                  how people may sign in (the sign-in page asks)
//   GET  /api/v1/auth/oidc/:key/start?return=  to the provider
//   GET  /api/v1/auth/oidc/:key/callback       back from it: a session, then the page asked for
//   /api/v1/admin/oidc-providers[/:id]         administrators: list, add, change, remove
//   POST /api/v1/admin/oidc-providers/:id/test whether the provider answers its discovery
//   GET/PUT /api/v1/admin/sign-in              who may sign in with a password here
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { recordAudit } from '../../audit/store';
import type { Schema } from '../../db/schema';
import { getSetting, setSetting } from '../../db/settings';
import type { Logger } from '../../log';
import type { MasterKey } from '../../secrets/masterKey';
import { administrator, inSession } from '../guards';
import { OidcSignIn, redirectUri, SignInError, safeReturn } from './flow';
import {
  createProvider,
  deleteProvider,
  getProvider,
  listProviders,
  ProviderError,
  type ProviderInput,
  updateProvider,
} from './providers';

export type LocalSignIn = 'all' | 'admins';
const LOCAL = 'local_signin';

/** Who may sign in with a password: everyone (the default), or administrators only. */
export async function localSignIn(db: Kysely<Schema>): Promise<LocalSignIn> {
  return (await getSetting(db, LOCAL)) === 'admins' ? 'admins' : 'all';
}

const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const MAPPING = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: { value: text(200, 1), group: text(64, 1), admin: { type: 'boolean' } },
};
const PROVIDER = {
  key: text(40, 1),
  name: text(100, 1),
  issuer: text(500, 1),
  clientId: text(300, 1),
  clientSecret: { type: ['string', 'null'], maxLength: 2000 },
  scopes: text(500, 1),
  groupsClaim: text(100, 1),
  loginClaim: text(100, 1),
  enabled: { type: 'boolean' },
  mappings: { type: 'array', maxItems: 200, items: MAPPING },
};
const ID = { params: { type: 'object', properties: { id: text(64, 1) }, required: ['id'] } };
const STATUS: Record<ProviderError['code'], number> = { invalid: 400, not_found: 404, taken: 409 };

export function registerOidc(
  app: FastifyInstance,
  deps: {
    db: Kysely<Schema>;
    key: MasterKey;
    log: Logger;
    publicUrl?: string;
    /** Starts a session for the person and sets its cookie (auth/routes.ts). */
    signIn(request: FastifyRequest, reply: FastifyReply, userId: string): Promise<void>;
  },
): void {
  const { db } = deps;
  const flow = new OidcSignIn(deps);
  /** The server's own address, as people reach it: the setting, else this request's. */
  const base = (request: FastifyRequest) =>
    deps.publicUrl ?? `${request.protocol}://${request.host}`;
  const failed = (reply: FastifyReply, message: string) =>
    reply.redirect(`/signin?error=${encodeURIComponent(message)}`);
  const answering =
    <R extends FastifyRequest>(handler: (request: R, reply: FastifyReply) => Promise<unknown>) =>
    async (request: R, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (e) {
        if (e instanceof ProviderError)
          return reply.code(STATUS[e.code]).send({
            error: e.code,
            message: e.message,
            ...(e.field ? { field: e.field } : {}),
          });
        throw e;
      }
    };

  app.get('/api/v1/auth/methods', async () => ({
    local: await localSignIn(db),
    providers: (await listProviders(db))
      .filter((p) => p.enabled)
      .map((p) => ({ key: p.key, name: p.name })),
  }));

  app.get<{ Params: { key: string }; Querystring: { return?: string } }>(
    '/api/v1/auth/oidc/:key/start',
    {
      schema: {
        params: { type: 'object', properties: { key: text(40, 1) }, required: ['key'] },
        querystring: { type: 'object', properties: { return: text(2000) } },
      },
    },
    async (request, reply) => {
      try {
        const to = await flow.start(request.params.key, base(request), request.query.return);
        return reply.redirect(to.href);
      } catch (e) {
        request.log.warn(
          { err: e, provider: request.params.key },
          'An OIDC sign-in could not start',
        );
        return failed(
          reply,
          e instanceof SignInError ? e.message : 'The sign-in provider does not answer',
        );
      }
    },
  );

  app.get<{ Params: { key: string } }>(
    '/api/v1/auth/oidc/:key/callback',
    { schema: { params: { type: 'object', properties: { key: text(40, 1) }, required: ['key'] } } },
    async (request, reply) => {
      const query = new URLSearchParams(request.url.slice(request.url.indexOf('?') + 1));
      try {
        const done = await flow.finish(request.params.key, base(request), query);
        await deps.signIn(request, reply, done.userId);
        await recordAudit(db, {
          actor: { id: done.userId, login: done.login },
          source: 'ui',
          action: 'session.sign-in',
          object: { type: 'user', id: done.userId, name: done.login },
          result: 'ok',
          ip: request.ip,
          detail: { provider: done.provider.key },
        }).catch((e) => request.log.error({ err: e }, 'The sign-in was not recorded'));
        request.log.info({ login: done.login, provider: done.provider.key }, 'Signed in');
        return reply.redirect(safeReturn(done.returnTo));
      } catch (e) {
        // Why goes to the log; the person reads a sentence (a provider's own words when it said no).
        request.log.warn({ err: e, provider: request.params.key }, 'An OIDC sign-in failed');
        return failed(
          reply,
          e instanceof SignInError ? e.message : 'The sign-in could not be finished: start again',
        );
      }
    },
  );

  // --- administrators

  const withRedirect = (request: FastifyRequest) => (p: { key: string }) => ({
    ...p,
    redirectUri: redirectUri(base(request), p.key),
  });

  app.get('/api/v1/admin/oidc-providers', async (request, reply) => {
    if (!administrator(request, reply)) return reply;
    return (await listProviders(db)).map(withRedirect(request));
  });

  app.get<{ Params: { id: string } }>(
    '/api/v1/admin/oidc-providers/:id',
    { schema: ID },
    async (request, reply) => {
      if (!administrator(request, reply)) return reply;
      const p = await getProvider(db, request.params.id);
      return p
        ? withRedirect(request)(p)
        : reply.code(404).send({ error: 'not_found', message: 'No such provider' });
    },
  );

  // Who may become an administrator is decided here: a session, not a token.
  app.post<{ Body: ProviderInput }>(
    '/api/v1/admin/oidc-providers',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'name', 'issuer', 'clientId'],
          properties: PROVIDER,
        },
      },
    },
    answering(async (request, reply) => {
      if (!inSession(request, reply, true)) return reply;
      const made = await createProvider(db, deps.key, request.body);
      return reply.code(201).send(withRedirect(request)(made));
    }),
  );

  app.patch<{ Params: { id: string }; Body: Partial<ProviderInput> }>(
    '/api/v1/admin/oidc-providers/:id',
    {
      schema: {
        ...ID,
        body: { type: 'object', additionalProperties: false, properties: PROVIDER },
      },
    },
    answering(async (request, reply) => {
      if (!inSession(request, reply, true)) return reply;
      return withRedirect(request)(
        await updateProvider(db, deps.key, request.params.id, request.body),
      );
    }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/admin/oidc-providers/:id',
    { schema: ID },
    answering(async (request, reply) => {
      if (!inSession(request, reply, true)) return reply;
      await deleteProvider(db, request.params.id);
      return reply.code(204).send();
    }),
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/oidc-providers/:id/test',
    { schema: ID },
    async (request, reply) => {
      if (!administrator(request, reply)) return reply;
      const p = await getProvider(db, request.params.id);
      if (!p) return reply.code(404).send({ error: 'not_found', message: 'No such provider' });
      try {
        const meta = (await flow.configOf(p)).serverMetadata();
        return {
          ok: true,
          issuer: meta.issuer,
          authorizationEndpoint: meta.authorization_endpoint,
          userinfo: !!meta.userinfo_endpoint,
          pkce: (meta.code_challenge_methods_supported ?? []).includes('S256'),
        };
      } catch (e) {
        return {
          ok: false,
          message: `The provider did not answer as expected: ${(e as Error).message}`,
        };
      }
    },
  );

  app.get('/api/v1/admin/sign-in', async (request, reply) => {
    if (!administrator(request, reply)) return reply;
    return { local: await localSignIn(db) };
  });

  app.put<{ Body: { local: LocalSignIn } }>(
    '/api/v1/admin/sign-in',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['local'],
          properties: { local: { type: 'string', enum: ['all', 'admins'] } },
        },
      },
    },
    async (request, reply) => {
      if (!inSession(request, reply, true)) return reply;
      await setSetting(db, LOCAL, request.body.local);
      return { local: request.body.local };
    },
  );
}
