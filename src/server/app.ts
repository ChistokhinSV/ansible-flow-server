// The HTTP server: what it answers before any feature exists. Whether the process is up
// (/healthz), whether it can do its work (/readyz: the database answers), and what it is
// (/api/v1/meta, which clients read before they talk to it).
import fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { registerAuth } from './auth/routes';
import type { Database } from './db/database';
import type { Logger } from './log';
import { type ServerMeta, serverMeta } from './meta';
import { type ProjectDeps, registerProjects } from './projects/routes';

export interface AppDeps {
  log: Logger;
  database: Database;
  /** This installation's id (db/settings.ts). */
  instance: string;
  /** The certificate and key to speak HTTPS with; without them the server speaks plain HTTP. */
  https?: { cert: string; key: string };
  /**
   * Proxies whose word is taken for who asked (X-Forwarded-For) and over what
   * (X-Forwarded-Proto): only for a server behind a proxy that does HTTPS.
   */
  trustedProxies?: string[];
  /** Mark the session cookie for HTTPS only. Default: when the server speaks HTTPS itself. */
  secureCookies?: boolean;
  /** Workspaces and projects: the mirrors and what keeps them up to date. */
  projects?: Omit<ProjectDeps, 'db'>;
}

export interface MetaReply extends ServerMeta {
  api: 'v1';
  instance: string;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = fastify({
    loggerInstance: deps.log,
    // A request that names no id gets one; it is on every log line of that request.
    requestIdHeader: 'x-request-id',
    // Bodies are small until a feature says otherwise (a git bundle, a certificate).
    bodyLimit: 1024 * 1024,
    // On shutdown: finish what is in flight, close the connections that are only kept alive.
    forceCloseConnections: 'idle',
    // A field a request has no business sending is refused, not quietly dropped: the sender
    // learns that it had no effect.
    ajv: { customOptions: { removeAdditional: false } },
    ...(deps.https ? { https: deps.https } : {}),
    ...(deps.trustedProxies?.length ? { trustProxy: deps.trustedProxies } : {}),
    // The type of the instance differs with HTTPS; the rest of the server uses neither's own.
  } as Parameters<typeof fastify>[0]) as unknown as FastifyInstance;

  // A request that is being answered when the server is asked to close is answered in full. Its
  // connection would then be kept alive, and the close would wait for it until it timed out
  // (found by a test): once closing, each answer says the connection ends with it, and
  // connections with nothing on them are closed as answers go out.
  let closing = false;
  app.addHook('preClose', async () => {
    closing = true;
  });
  app.addHook('onSend', async (_request, reply) => {
    if (closing) reply.header('connection', 'close');
  });
  app.addHook('onResponse', async () => {
    if (closing) setImmediate(() => app.server.closeIdleConnections());
  });

  registerAuth(app, {
    db: deps.database.db,
    // Behind a proxy the server itself speaks plain HTTP, but people reach it over HTTPS.
    secureCookies: deps.secureCookies ?? !!deps.https,
  });

  if (deps.projects) registerProjects(app, { db: deps.database.db, ...deps.projects });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    try {
      await deps.database.ping();
      return { status: 'ready', database: deps.database.kind };
    } catch (e) {
      // Why goes to the log, not to whoever asks: it can name hosts and files.
      app.log.error({ err: e }, 'The database does not answer');
      return reply.code(503).send({ status: 'unavailable', database: deps.database.kind });
    }
  });

  app.get(
    '/api/v1/meta',
    async (): Promise<MetaReply> => ({
      ...serverMeta(),
      api: 'v1',
      instance: deps.instance,
    }),
  );

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send({ error: 'not_found', message: `Nothing at ${request.url.split('?')[0]}` }),
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'The request failed');
    // What went wrong inside stays inside: a 500 says only that it happened, and which request.
    return reply.code(status).send(
      status >= 500
        ? { error: 'internal', message: 'The server could not do this', request: request.id }
        : {
            error: error.validation ? 'invalid' : (error.code ?? 'bad_request'),
            message: error.message,
          },
    );
  });

  return app;
}
