// Prometheus metrics (AFS-37) at /metrics, for whoever has AFS_METRICS_TOKEN as a bearer token.
// What is in the database (runs, approvals, deliveries, builds) is counted when Prometheus asks;
// how long runs and builds took is observed when each ends; requests as they are answered. No
// label carries a name a person typed (a flow, a host): only states, outcomes and route patterns.
import { timingSafeEqual } from 'node:crypto';
import { collectDefaultMetrics, Gauge, Histogram, Registry } from '@prometheus-io/client';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';

/** What the executor and the environment builder tell the metrics. */
export interface MetricsSink {
  runEnded(mode: string, outcome: string, seconds: number): void;
  buildEnded(outcome: string, seconds: number): void;
}

/** Nothing is kept: for tests and for a server without metrics. */
export const NO_METRICS: MetricsSink = { runEnded: () => undefined, buildEnded: () => undefined };

const RUN_STATES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'lost'];
const DELIVERY_STATES = ['pending', 'sent', 'failed'];
// Runs take seconds to hours; builds minutes.
const RUN_BUCKETS = [5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14400];
const BUILD_BUCKETS = [30, 60, 120, 300, 600, 1200, 1800, 3600];

export class Metrics implements MetricsSink {
  readonly registry = new Registry();
  private readonly runs: Histogram<'mode' | 'outcome'>;
  private readonly builds: Histogram<'outcome'>;
  private readonly requests: Histogram<'method' | 'route' | 'status'>;

  constructor(source: {
    db: Kysely<Schema>;
    version: string;
    designer: string;
    /** When the certificate in use ends; undefined behind a proxy (AFS_TLS=off). */
    certificateEnds?: () => Date | undefined;
  }) {
    const registers = [this.registry];
    const db = source.db;
    collectDefaultMetrics({ register: this.registry, prefix: 'afs_' });
    new Gauge({
      name: 'afs_info',
      help: 'The server and the designer it carries (always 1)',
      labelNames: ['version', 'designer'],
      registers,
    }).set({ version: source.version, designer: source.designer }, 1);
    new Gauge({
      name: 'afs_runs',
      help: 'Runs kept, by state (queued, running and waiting are going)',
      labelNames: ['state'],
      registers,
      async collect() {
        const rows = await db
          .selectFrom('run')
          .select(['state', db.fn.countAll<number>().as('n')])
          .groupBy('state')
          .execute();
        for (const state of RUN_STATES)
          this.set({ state }, Number(rows.find((r) => r.state === state)?.n ?? 0));
      },
    });
    new Gauge({
      name: 'afs_queue_depth',
      help: 'Runs waiting for a worker',
      registers,
      async collect() {
        const row = await db
          .selectFrom('run')
          .select(db.fn.countAll<number>().as('n'))
          .where('state', '=', 'queued')
          .executeTakeFirst();
        this.set(Number(row?.n ?? 0));
      },
    });
    new Gauge({
      name: 'afs_approvals_waiting',
      help: 'Approval gates waiting for a decision',
      registers,
      async collect() {
        const row = await db
          .selectFrom('run_gate')
          .select(db.fn.countAll<number>().as('n'))
          .where('status', '=', 'waiting')
          .executeTakeFirst();
        this.set(Number(row?.n ?? 0));
      },
    });
    new Gauge({
      name: 'afs_notifications',
      help: 'Notifications in the delivery log, by status (failed: given up after retries)',
      labelNames: ['status'],
      registers,
      async collect() {
        const rows = await db
          .selectFrom('notification')
          .select(['status', db.fn.countAll<number>().as('n')])
          .groupBy('status')
          .execute();
        for (const status of DELIVERY_STATES)
          this.set({ status }, Number(rows.find((r) => r.status === status)?.n ?? 0));
      },
    });
    new Gauge({
      name: 'afs_environment_builds_going',
      help: 'Execution environment builds queued or building',
      registers,
      async collect() {
        const row = await db
          .selectFrom('environment_build')
          .select(db.fn.countAll<number>().as('n'))
          .where('state', 'in', ['queued', 'building'])
          .executeTakeFirst();
        this.set(Number(row?.n ?? 0));
      },
    });
    const ends = source.certificateEnds;
    if (ends)
      new Gauge({
        name: 'afs_certificate_expiry_seconds',
        help: "Seconds until the server's certificate ends (negative: ended)",
        registers,
        collect() {
          const at = ends();
          if (at) this.set(Math.round((at.getTime() - Date.now()) / 1000));
        },
      });
    this.runs = new Histogram({
      name: 'afs_run_duration_seconds',
      help: 'How long runs took, from start to end, by mode and outcome',
      labelNames: ['mode', 'outcome'],
      buckets: RUN_BUCKETS,
      registers,
    });
    this.builds = new Histogram({
      name: 'afs_environment_build_duration_seconds',
      help: 'How long execution environment builds took, by outcome',
      labelNames: ['outcome'],
      buckets: BUILD_BUCKETS,
      registers,
    });
    this.requests = new Histogram({
      name: 'afs_http_request_duration_seconds',
      help: "Requests answered, by method, the route's pattern and status class",
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers,
    });
  }

  runEnded(mode: string, outcome: string, seconds: number): void {
    if (Number.isFinite(seconds) && seconds >= 0) this.runs.observe({ mode, outcome }, seconds);
  }

  buildEnded(outcome: string, seconds: number): void {
    if (Number.isFinite(seconds) && seconds >= 0) this.builds.observe({ outcome }, seconds);
  }

  /** Times every request by its route's pattern (unknown addresses are one route). */
  instrument(app: FastifyInstance): void {
    app.addHook('onResponse', async (request, reply) => {
      const route = request.routeOptions.url ?? 'unknown';
      if (route === '/metrics') return;
      this.requests.observe(
        {
          method: request.method,
          route,
          status: `${Math.floor(reply.statusCode / 100)}xx`,
        },
        reply.elapsedTime / 1000,
      );
    });
  }

  /** `/metrics`: 404 without a token set, 401 without the right one. */
  register(app: FastifyInstance, token: string | undefined): void {
    const wanted = token ? Buffer.from(token) : undefined;
    app.get('/metrics', async (request, reply) => {
      if (!wanted) return reply.code(404).send({ error: 'not_found', message: 'No metrics here' });
      const given = Buffer.from(
        /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '',
      );
      if (given.length !== wanted.length || !timingSafeEqual(given, wanted))
        return reply
          .code(401)
          .header('www-authenticate', 'Bearer')
          .send({ error: 'unauthorized', message: 'The metrics token is needed' });
      return reply.type(this.registry.contentType).send(await this.registry.metrics());
    });
  }
}
