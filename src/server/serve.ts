// Starts the server and says how to stop it. main.ts calls it with the settings and stops it on a
// signal; tests call it with their own.
import { type FSWatcher, mkdirSync, readFileSync, watch } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { isIP } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { timeOutDue } from './approvals/gates';
import { pruneAudit } from './audit/store';
import { sweepSessions } from './auth/sessions';
import { setupCode } from './auth/setup';
import { sweepTokens } from './auth/tokens';
import { type Config, publicHost, withoutPassword } from './config';
import { openDatabase } from './db/database';
import { migrate } from './db/migrations';
import { instanceId } from './db/settings';
import { Environments } from './environments/environments';
import { galaxyClient } from './environments/galaxy';
import { pruneDevBundles } from './launch/dev';
import type { Logger } from './log';
import { serverMeta } from './meta';
import { emailChannel, webhookChannel } from './notify/channels';
import { Notifier } from './notify/notifier';
import { smtpForSending, webhookKey } from './notify/settings';
import { Git } from './projects/git';
import { ProjectSync } from './projects/sync';
import { Executor } from './runs/executor';
import { RunHub } from './runs/hub';
import { RunQueue } from './runs/queue';
import { pruneRuns } from './runs/retention';
import { Schedules } from './schedules/schedules';
import { checkKey, gitAuthOf, reveal } from './secrets/credentials';
import { SealError } from './secrets/crypto';
import { loadMasterKey } from './secrets/masterKey';
import { type CertificateInfo, certificateProblems, certificatesOf } from './tls/certificates';
import { CertificateStore } from './tls/store';

/** A certificate this close to its end is warned about, at start and once a day. */
export const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RunningServer {
  /** The address it answers at, as a URL. */
  url: string;
  /** With HTTPS and a redirect port: the plain HTTP address that redirects. */
  redirectUrl?: string;
  /** With HTTPS: the certificate new connections get now. */
  certificate?(): CertificateInfo;
  /**
   * With HTTPS: reads the certificate from the store again and serves it to new connections.
   * False when the stored pair is the one already served, or is not usable (it is logged).
   */
  reloadCertificate?(): boolean;
  /**
   * Stops it in order: no new requests, the ones in flight finish, the database is closed.
   * Resolves once all of it is done; a second call waits for the first.
   */
  stop(why: string): Promise<void>;
}

/** Where the certificate is kept. */
export const certificateStore = (config: Config) =>
  new CertificateStore(join(config.dataDir, 'tls'));

/**
 * The names a self-signed certificate is made for: the public address's host when the settings
 * name one, the address the server listens on, this machine's name, and localhost.
 */
export function selfSignedNames(config: Config): string[] {
  const listen = /^(0\.0\.0\.0|::|)$/.test(config.host) ? undefined : config.host;
  return [
    ...new Set(
      [publicHost(config), listen, hostname(), 'localhost', '127.0.0.1', '::1'].filter(
        (name): name is string => !!name,
      ),
    ),
  ];
}

/** `flows.example.net` or `[::1]`, with the port unless it is the default for HTTPS. */
function httpsAuthority(host: string, port: number): string {
  return `${isIP(host) === 6 ? `[${host}]` : host}${port === 443 ? '' : `:${port}`}`;
}

/**
 * Plain HTTP beside HTTPS: every request is sent to the same address over HTTPS. Only this
 * machine may ask /healthz without it, for a probe that has no certificate to trust.
 */
function redirectServer(config: Config, httpsPort: number): Server {
  const known = config.publicUrl ? new URL(config.publicUrl).host : undefined;
  return createServer((request, reply) => {
    const local = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(
      request.socket.remoteAddress ?? '',
    );
    if (local && request.url === '/healthz') {
      reply.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    // The host comes from the settings when they name it; else from the request, and only when
    // it reads as a host: the answer must not send anyone where a header says.
    const asked = (request.headers.host ?? '').replace(/:\d+$/, '');
    const host = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)$/.test(asked) ? asked : undefined;
    const to =
      known ?? (host ? httpsAuthority(host.replace(/^\[|\]$/g, ''), httpsPort) : undefined);
    if (!to) {
      reply.writeHead(400, { 'content-type': 'text/plain' }).end('Use HTTPS\n');
      return;
    }
    reply.writeHead(308, { location: `https://${to}${request.url ?? '/'}` }).end();
  });
}

/** Rejects when the server cannot start; whatever it had opened by then is closed again. */
export async function startServer(config: Config, log: Logger): Promise<RunningServer> {
  const meta = serverMeta();
  log.info({ version: meta.version, designer: meta.designer.version }, `${meta.name} starts`);

  if (config.caFile) {
    // Authorities of an internal network, for what the server connects to (git, sign-in, mail).
    const extra = certificatesOf(readFileSync(config.caFile, 'utf8'));
    if (extra.length === 0) throw new Error(`AFS_CA_FILE has no certificate: ${config.caFile}`);
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...extra]);
    log.info({ file: config.caFile, authorities: extra.length }, 'Also trusting the authorities');
  }

  const store = certificateStore(config);
  // Made once the database is open; the certificate's warnings reach it from then on.
  let notifier: Notifier | undefined;
  let served =
    config.tls === 'on' ? await store.ensure(selfSignedNames(config), { by: 'server' }) : undefined;
  const warnOfExpiry = () => {
    if (!served) return;
    const { daysLeft, notAfter, subject } = served.info;
    if (daysLeft < 0)
      log.error({ subject, expired: notAfter }, 'The server certificate has expired');
    else if (daysLeft <= EXPIRY_WARNING_DAYS)
      log.warn(
        { subject, expires: notAfter, days: daysLeft },
        'The server certificate expires soon',
      );
    // AFS-29: and the administrators are told, once per step (notify/notifier.ts).
    notifier?.certificate(served.info);
  };
  if (served) {
    log.info(
      {
        subject: served.info.subject,
        names: served.info.names.join(','),
        expires: served.info.notAfter,
        source: served.source,
      },
      'Server certificate',
    );
    warnOfExpiry();
  }

  const database = openDatabase(config.database);
  let app: ReturnType<typeof buildApp> | undefined;
  let redirect: Server | undefined;
  let watcher: FSWatcher | undefined;
  let daily: NodeJS.Timeout | undefined;
  let sweep: NodeJS.Timeout | undefined;
  let leases: NodeJS.Timeout | undefined;
  let executor: Executor | undefined;
  let schedules: Schedules | undefined;
  let environments: Environments | undefined;
  let retention: NodeJS.Timeout | undefined;
  let stopPruning: () => Promise<unknown> = async () => undefined;
  const hub = new RunHub();
  let projects: ProjectSync | undefined;
  try {
    await database.ping();
    const applied = await migrate(database.db as never);
    log.info(
      {
        kind: database.kind,
        where:
          config.database.kind === 'sqlite'
            ? config.database.file
            : withoutPassword(config.database.url),
        changes: applied.length,
      },
      'Database ready',
    );
    const git = new Git({
      reposDir: join(config.dataDir, 'repos'),
      allowLocal: config.gitLocal,
      // With authorities of the network's own (AFS_CA_FILE), git is given all the server trusts.
      ...(config.caFile ? { caBundle: tls.getCACertificates('default').join('\n') } : {}),
    });
    // The master key: made at a first start, and then it must be the one the secrets need.
    const masterKey = loadMasterKey(config);
    try {
      await checkKey(database.db, masterKey);
    } catch (e) {
      if (e instanceof SealError)
        throw new Error(
          `The master key is not the one this database's secrets were sealed with. ${e.message}. Give the server the right key (AFS_MASTER_KEY or AFS_MASTER_KEY_FILE).`,
        );
      throw e;
    }
    if (masterKey.source === 'generated')
      log.warn(
        { file: masterKey.file, key: masterKey.id },
        'Made a master key. Keep a copy somewhere safe: stored credentials cannot be read without it',
      );
    else log.info({ key: masterKey.id, from: masterKey.source }, 'Master key ready');
    const db = database.db;
    const runs = new RunQueue(db, database.kind, masterKey, {
      maxRuns: config.maxRuns,
      perProject: config.maxRunsPerProject,
    });
    // AFS-29: what happens is told by email and webhook, from an outbox in the database.
    const notify = new Notifier(
      db,
      [
        emailChannel(() => smtpForSending(db, masterKey)),
        webhookChannel(() => webhookKey(db, masterKey), `${meta.name}/${meta.version}`),
      ],
      log,
      {
        keepDays: config.notificationsKeepDays,
        ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
      },
    );
    notifier = notify;
    runs.onEnded = (id) => notify.runEnded(id);
    notify.start();
    if (served) notify.certificate(served.info);
    // A worker that stops answering lets its runs go: back to the queue, or lost (runs/queue.ts).
    leases = setInterval(() => {
      // AFS-28: approvals whose time ran out time out, and their runs go on.
      void timeOutDue(
        database.db,
        (id) => runs.resume(id),
        new Date(),
        (run, gate) => notify.approvalDecided(run, gate),
      ).then(
        (went) => {
          if (went.length) log.info({ runs: went.length }, 'Approvals timed out: runs go on');
        },
        (e) => log.error({ err: e }, 'Timing out approvals failed'),
      );
      void runs.expire().then(
        (n) => {
          if (n.requeued || n.lost || n.cancelled)
            log.warn(n, 'Runs whose worker stopped answering');
        },
        (e) => log.error({ err: e }, 'Looking for runs whose worker went away failed'),
      );
    }, 15_000);
    leases.unref();
    projects = new ProjectSync(db, git, log, async (project) => {
      if (!project.gitCredential) return undefined;
      const revealed = await reveal(db, masterKey, project.gitCredential);
      if (!revealed) throw new Error('The credential is gone');
      return gitAuthOf(revealed);
    });
    schedules = new Schedules({ db, git, sync: projects, queue: runs, log });
    // AFS-32: execution environments are built on the same engine as runs, one at a time.
    environments = new Environments({
      db,
      log,
      galaxy: galaxyClient(config.galaxyUrl),
      dir: join(config.dataDir, 'environments'),
      engine: config.containerEngine,
      timeoutMs: config.buildTimeoutMinutes * 60_000,
    });
    app = buildApp({
      log,
      database,
      projects: { git, sync: projects, allowLocal: config.gitLocal },
      masterKey,
      runs,
      runOutput: (id) => executor?.outputFile(id) ?? '',
      // AFS-67: the executor reads inventories with the engine it found.
      inventory: (q) =>
        executor
          ? executor.inventory(q)
          : Promise.resolve({ factsError: 'This server is still starting', environment: '' }),
      hub,
      // The pages are built beside the server (dist/server.js, dist/web).
      webDir: fileURLToPath(new URL('./web', import.meta.url)),
      instance: await instanceId(database.db),
      ...(served ? { https: { cert: served.certificate, key: served.key } } : {}),
      notifier: notify,
      schedules,
      environments,
      certificate: {
        store,
        tls: config.tls,
        defaultNames: selfSignedNames(config),
        ...(publicHost(config) ? { host: publicHost(config) } : {}),
      },
      dev: { maxBytes: config.devBundleMaxMb * 1024 * 1024, keepHours: config.devKeepHours },
      ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
      trustedProxies: config.trustedProxies,
      // Plain HTTP by the server itself is only for behind a proxy that does HTTPS; when the
      // settings say people come over plain HTTP, the cookie must travel that way too.
      secureCookies:
        !config.publicUrl?.startsWith('http://') && (config.tls === 'on' || !!config.publicUrl),
    });
    // A new server has no user. Its first administrator is made by whoever can read this line.
    const code = await setupCode(database.db);
    if (code)
      log.warn(
        { setup: code },
        'No user yet. Make the first administrator with this setup code (POST /api/v1/setup, or: user add --admin)',
      );
    sweep = setInterval(
      () =>
        void Promise.all([sweepSessions(database.db), sweepTokens(database.db)]).catch((e) =>
          log.warn({ err: e }, 'Ended sessions were not removed'),
        ),
      60 * 60 * 1000,
    );
    sweep.unref();
    const url = await app.listen({ host: config.host, port: config.port });
    const running = app;
    // From now on the projects' sources are looked at when they are due.
    projects.start();
    // And runs are taken from the queue, when a container engine answers.
    executor = new Executor(
      {
        db: database.db,
        git,
        sync: projects,
        queue: runs,
        key: masterKey,
        log,
        hub,
        approvalWaiting: (run, gate) => notify.approvalWaiting(run, gate),
      },
      {
        dataDir: config.dataDir,
        engine: config.containerEngine,
        image: config.eeImage,
        worker: `server:${await instanceId(database.db)}`,
        slots: config.maxRuns,
        timeoutMs: config.runTimeoutMinutes * 60_000,
      },
    );
    await executor.start();
    // AFS-34: schedules fire from here: due ones are looked for every half minute.
    schedules.start();
    await environments.start();
    // Ended runs and audit entries past their keeping go, now and every hour.
    // What is being removed now: a server that stops waits for it before it closes the database
    // (closing SQLite under a query in flight can bring the process down).
    const pruning = new Set<Promise<unknown>>();
    const track = (work: Promise<unknown>) => {
      pruning.add(work);
      void work.finally(() => pruning.delete(work));
    };
    stopPruning = () => Promise.allSettled([...pruning]);
    const prune = () => {
      track(
        pruneAudit(database.db, config.auditKeepDays).then(
          (n) => {
            if (n) log.info({ entries: n }, 'Removed audit entries past their keeping');
          },
          (e) => log.error({ err: e }, 'Removing old audit entries failed'),
        ),
      );
      track(
        pruneDevBundles(database.db, git).then(
          (n) => {
            if (n) log.info({ bundles: n }, 'Removed dev bundles past their time');
          },
          (e) => log.error({ err: e }, 'Removing old dev bundles failed'),
        ),
      );
      track(
        notify.prune().then(
          (n) => {
            if (n) log.info({ notifications: n }, 'Removed notifications past their keeping');
          },
          (e) => log.error({ err: e }, 'Removing old notifications failed'),
        ),
      );
      if (!executor) return;
      const output = executor.outputFile.bind(executor);
      track(
        pruneRuns(
          database.db,
          { days: config.runsKeepDays, perFlow: config.runsKeepPerFlow },
          output,
        ).then(
          (n) => {
            if (n) log.info({ runs: n }, 'Removed runs past their keeping');
          },
          (e) => log.error({ err: e }, 'Removing old runs failed'),
        ),
      );
    };
    prune();
    retention = setInterval(prune, 60 * 60 * 1000);
    retention.unref();

    let reloadCertificate: (() => boolean) | undefined;
    if (served) {
      reloadCertificate = () => {
        let next: ReturnType<CertificateStore['current']>;
        try {
          next = store.current();
        } catch (e) {
          log.error({ err: e }, 'The stored certificate cannot be read: the one in use stays');
          return false;
        }
        if (!next || next.info.fingerprint === served?.info.fingerprint) return false;
        // The store checks before it writes; this is for a file changed by hand.
        const problems = certificateProblems(next);
        if (problems.length) {
          log.error(
            { problems: problems.join('; ') },
            'The stored certificate is not usable: the one in use stays',
          );
          return false;
        }
        (running.server as unknown as tls.Server).setSecureContext({
          cert: next.certificate,
          key: next.key,
        });
        served = next;
        log.info(
          { subject: next.info.subject, expires: next.info.notAfter, source: next.source },
          'Server certificate replaced: new connections get it',
        );
        warnOfExpiry();
        return true;
      };
      // A change made by the cert commands, or by another process, is picked up here. The folder
      // is watched, not the file: the store replaces its files by renaming.
      mkdirSync(join(config.dataDir, 'tls'), { recursive: true });
      let timer: NodeJS.Timeout | undefined;
      const reload = reloadCertificate;
      watcher = watch(join(config.dataDir, 'tls'), () => {
        clearTimeout(timer);
        timer = setTimeout(reload, 300);
      });
      watcher.on('error', (e) => log.warn({ err: e }, 'The certificate folder is not watched'));
      daily = setInterval(warnOfExpiry, DAY_MS);
      daily.unref();
    }

    let redirectUrl: string | undefined;
    if (config.httpPort && served) {
      const listener = redirectServer(config, new URL(url).port ? Number(new URL(url).port) : 443);
      redirect = listener;
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(config.httpPort, config.host, resolve);
      });
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : config.httpPort;
      redirectUrl = `http://${httpsAuthority(config.host, port).replace(/:443$/, '')}`;
      log.info({ port }, 'Plain HTTP redirects to HTTPS');
    }

    let stopping: Promise<void> | undefined;
    return {
      url,
      ...(redirectUrl ? { redirectUrl } : {}),
      ...(served && reloadCertificate
        ? { certificate: () => (served as NonNullable<typeof served>).info, reloadCertificate }
        : {}),
      stop(why) {
        stopping ??= (async () => {
          log.info({ why }, 'Shutting down');
          watcher?.close();
          clearInterval(daily);
          clearInterval(sweep);
          clearInterval(leases);
          clearInterval(retention);
          redirect?.close();
          redirect?.closeAllConnections();
          // A fetch that is going is waited for: a mirror is not left half written.
          await schedules?.stop();
          await environments?.stop();
          await executor?.stop();
          await projects?.stop();
          await running.close();
          await stopPruning();
          // Messages being written or sent are finished; the rest wait in the outbox.
          await notifier?.stop();
          await database.close();
          log.info('Stopped');
        })();
        return stopping;
      },
    };
  } catch (e) {
    watcher?.close();
    clearInterval(daily);
    clearInterval(sweep);
    clearInterval(leases);
    clearInterval(retention);
    redirect?.close();
    await schedules?.stop().catch(() => undefined);
    await environments?.stop().catch(() => undefined);
    await executor?.stop().catch(() => undefined);
    await projects?.stop().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await stopPruning();
    await notifier?.stop().catch(() => undefined);
    await database.close().catch(() => undefined);
    throw e;
  }
}
