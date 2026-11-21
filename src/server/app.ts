// The HTTP server: what it answers before any feature exists. Whether the process is up
// (/healthz), whether it can do its work (/readyz: the database answers), and what it is
// (/api/v1/meta, which clients read before they talk to it).
import fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { registerAccess } from './access/routes';
import { registerCatalog } from './api/catalog';
import { plainInvalid } from './api/invalid';
import { registerApprovals } from './approvals/routes';
import { registerAudit } from './audit/routes';
import type { Connect } from './auth/ldap/client';
import { LdapSignIn } from './auth/ldap/ldap';
import { registerAuth } from './auth/routes';
import type { Database } from './db/database';
import { Drafts } from './drafts/drafts';
import { registerDrafts } from './drafts/routes';
import { registerStartFrom } from './drafts/startFromRoutes';
import { registerFlowChecks } from './environments/checkRoutes';
import type { Environments } from './environments/environments';
import { registerEnvironments } from './environments/routes';
import { LaunchConfigs } from './launch/configs';
import { type InventoryReader, registerLaunch } from './launch/routes';
import type { Logger } from './log';
import { registerMcp } from './mcp/routes';
import { type ServerMeta, serverMeta } from './meta';
import type { Notifier } from './notify/notifier';
import { registerNotifications } from './notify/routes';
import { type ReadinessDeps, readiness } from './ops/health';
import type { Metrics } from './ops/metrics';
import { registerFiles } from './projects/filesRoutes';
import { registerGit } from './projects/gitHttp';
import { registerHistory } from './projects/historyRoutes';
import { Library } from './projects/library';
import { registerLibrary } from './projects/libraryRoutes';
import { type ProjectDeps, registerProjects } from './projects/routes';
import { VarIndexes } from './projects/vars';
import { registerVars } from './projects/varsRoutes';
import { ProjectWatch } from './projects/watch';
import type { CatalogState } from './runs/catalogs';
import type { RunHub } from './runs/hub';
import type { RunQueue } from './runs/queue';
import { registerRuns } from './runs/routes';
import { registerSchedules } from './schedules/routes';
import type { Schedules } from './schedules/schedules';
import { registerSearch } from './search/routes';
import type { MasterKey } from './secrets/masterKey';
import { registerCredentials } from './secrets/routes';
import { type CertificateDeps, registerCertificate } from './tls/routes';
import { webHandler } from './web';

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
  /** The runs and their queue. */
  runs?: RunQueue;
  /** Where a run's output is kept, when this server runs flows. */
  runOutput?: (runId: string) => string;
  /** What runs going here say while they go. */
  hub?: RunHub;
  /** The master key: with it the server keeps credentials. */
  masterKey?: MasterKey;
  /** The folder of the built web application (dist/web); without it there are no pages. */
  webDir?: string;
  /** AFS-29: what tells people of what happens; without it nobody is told. */
  notifier?: Notifier;
  /** The address people use for the server (AFS_PUBLIC_URL), for links in messages. */
  /** AFS-32: execution environments and their builds. */
  environments?: Environments;
  /** AFS-34: schedules of launch configurations. */
  schedules?: Schedules;
  /** The server certificate's store, for the certificate page and API (AFS-54). */
  certificate?: CertificateDeps;
  publicUrl?: string;
  /** AFS-26: a dev run's bundle at most this many bytes, kept this many hours. */
  dev?: { maxBytes: number; keepHours: number };
  /** AFS-67: reads a launch's inventory in its image (the executor's probes). */
  inventory?: InventoryReader;
  /** AFS-76: the module catalog of an image (the server's default without one), and Rebuild. */
  catalog?: { get(image?: string): CatalogState; retry(image?: string): void };
  /** AFS-31: tests: the directory a test plays, instead of real LDAP connections. */
  ldapConnect?: Connect;
  /** AFS-37: what /readyz checks beyond the database. */
  readiness?: Omit<ReadinessDeps, 'database' | 'log'>;
  /** AFS-37: /metrics, for whoever has the token (AFS_METRICS_TOKEN). */
  metrics?: Metrics;
  metricsToken?: string;
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
  // AFS-37: every request is timed (before any route, so every route is).
  deps.metrics?.instrument(app);

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

  // First: their hooks see every route. The catalog describes and scopes them, the audit log
  // records what they change.
  registerCatalog(app, { db: deps.database.db });
  registerAudit(app, { db: deps.database.db });
  registerAuth(app, {
    db: deps.database.db,
    // Behind a proxy the server itself speaks plain HTTP, but people reach it over HTTPS.
    secureCookies: deps.secureCookies ?? !!deps.https,
    ...(deps.masterKey
      ? {
          oidc: {
            key: deps.masterKey,
            log: deps.log,
            ...(deps.publicUrl ? { publicUrl: deps.publicUrl } : {}),
          },
          // AFS-31: directories, with the server's own connections unless a test plays one.
          ldap: new LdapSignIn({
            db: deps.database.db,
            key: deps.masterKey,
            log: deps.log,
            ...(deps.ldapConnect ? { connect: deps.ldapConnect } : {}),
          }),
        }
      : {}),
  });

  if (deps.projects) {
    // AFS-75: one watcher of the projects' branches for every event stream of this server.
    const watch = deps.projects.watch ?? new ProjectWatch(deps.database.db, deps.log);
    app.addHook('onClose', async () => watch.stop());
    // AFS-79: one library for its routes and for the flows' checks.
    const library = new Library({ db: deps.database.db, git: deps.projects.git });
    registerProjects(app, {
      db: deps.database.db,
      ...deps.projects,
      watch,
      library,
      ...(deps.masterKey ? { masterKey: deps.masterKey } : {}),
    });
    // AFS-78: the project's files in the pages.
    registerFiles(app, { db: deps.database.db, ...deps.projects });
    // AFS-183: the repository's variables for the canvas (where a value comes from), kept per
    // commit; the launch form's origins of the inputs read them too.
    const vars = new VarIndexes(deps.projects.git);
    registerVars(app, { db: deps.database.db, git: deps.projects.git, vars });
    // AFS-123: the project's history: its commits, one commit's files, a flow at a commit.
    registerHistory(app, { db: deps.database.db, git: deps.projects.git });
    // AFS-79: the flow library: library projects' subflows, offered to every project.
    registerLibrary(app, { db: deps.database.db, git: deps.projects.git, library });
    // AFS-76: flows edited in the pages, together.
    const drafts = new Drafts({
      db: deps.database.db,
      git: deps.projects.git,
      sync: deps.projects.sync,
      log: deps.log,
    });
    registerDrafts(app, {
      db: deps.database.db,
      ...(deps.catalog ? { catalog: deps.catalog } : {}),
      drafts,
    });
    // AFS-126: an empty flow starts from a sample, a playbook or an AWX template.
    registerStartFrom(app, {
      db: deps.database.db,
      drafts,
      git: deps.projects.git,
      ...(deps.masterKey ? { key: deps.masterKey } : {}),
    });
    registerGit(app, { db: deps.database.db, ...deps.projects });
    registerLaunch(app, {
      db: deps.database.db,
      git: deps.projects.git,
      sync: deps.projects.sync,
      ...(deps.runs ? { queue: deps.runs } : {}),
      ...(deps.dev ? { dev: deps.dev } : {}),
      ...(deps.inventory ? { inventory: deps.inventory } : {}),
      vars,
    });
  }

  if (deps.projects) registerAccess(app, { db: deps.database.db });
  // AFS-24: agents, over MCP.
  if (deps.projects) registerMcp(app, { db: deps.database.db, git: deps.projects.git });
  if (deps.masterKey) registerCredentials(app, { db: deps.database.db, key: deps.masterKey });
  if (deps.runs) {
    const notifier = deps.notifier;
    registerRuns(
      app,
      deps.runs,
      deps.runOutput,
      deps.hub,
      deps.database.db,
      notifier ? (run, gate) => notifier.approvalCancelled(run, gate) : undefined,
    );
    registerApprovals(app, {
      db: deps.database.db,
      queue: deps.runs,
      ...(deps.hub ? { hub: deps.hub } : {}),
      ...(notifier ? { decided: (run, gate) => notifier.approvalDecided(run, gate) } : {}),
    });
  }
  if (deps.certificate) registerCertificate(app, deps.certificate);
  if (deps.projects) registerSearch(app, { db: deps.database.db, git: deps.projects.git });
  if (deps.environments)
    registerEnvironments(app, { db: deps.database.db, environments: deps.environments });
  if (deps.environments && deps.projects)
    registerFlowChecks(app, {
      db: deps.database.db,
      git: deps.projects.git,
      environments: deps.environments,
      galaxy: deps.environments.galaxy,
    });
  if (deps.schedules && deps.projects)
    registerSchedules(app, {
      schedules: deps.schedules,
      configs: new LaunchConfigs(deps.database.db, deps.projects.git),
    });
  if (deps.notifier && deps.masterKey)
    registerNotifications(app, {
      db: deps.database.db,
      key: deps.masterKey,
      notifier: deps.notifier,
      ...(deps.publicUrl ? { publicUrl: deps.publicUrl } : {}),
    });

  app.get('/healthz', async () => ({ status: 'ok' }));

  // AFS-37: check by check; why goes to the log, not to whoever asks (it can name hosts, files).
  app.get('/readyz', async (_request, reply) => {
    const ready = await readiness({
      database: deps.database,
      ...(deps.readiness ?? {}),
      log: app.log,
    });
    return reply.code(ready.status === 'unavailable' ? 503 : 200).send(ready);
  });
  deps.metrics?.register(app, deps.metricsToken);

  app.get(
    '/api/v1/meta',
    async (): Promise<MetaReply> => ({
      ...serverMeta(),
      api: 'v1',
      instance: deps.instance,
    }),
  );

  // Whatever is not the server's own address is the web application's: one of its files, or
  // one of its pages (which are all the same file).
  const web = deps.webDir ? webHandler(deps.webDir) : undefined;
  if (deps.webDir && !web)
    app.log.warn({ folder: deps.webDir }, 'No built web application: the server has no pages');
  app.setNotFoundHandler(
    (request, reply) =>
      web?.(request, reply) ??
      reply
        .code(404)
        .send({ error: 'not_found', message: `Nothing at ${request.url.split('?')[0]}` }),
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'The request failed');
    // What went wrong inside stays inside: a 500 says only that it happened, and which request.
    return reply
      .code(status)
      .send(
        status >= 500
          ? { error: 'internal', message: 'The server could not do this', request: request.id }
          : error.validation
            ? { error: 'invalid', ...plainInvalid(error.validation) }
            : { error: error.code ?? 'bad_request', message: error.message },
      );
  });

  return app;
}
