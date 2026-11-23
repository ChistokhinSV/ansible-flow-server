// Event streaming against real receivers (AFS-243, AFS-244): rsyslog 8 and the OpenTelemetry
// collector with Jaeger behind it, from the spike's lab (spike S10: lab/up.sh on a Docker host).
// Runs only when AFS_TEST_STREAM_LAB names that host:
//   AFS_TEST_STREAM_LAB=192.168.200.128
//   AFS_TEST_STREAM_READ="ssh gns3 tail -n 2000 spike-s10/out"  prints the end of a lab output
//                                                       file, given its path
//   AFS_TEST_STREAM_CA=path/to/ca.pem                   also tries TLS on 6514 (not through a
//                                                       proxy that re-signs TLS)
// It checks what the receivers made of our messages: rsyslog's parsed structured data, the
// collector's log records, and the trace as Jaeger shows it. Fictional data only.
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordAudit } from '../../src/server/audit/store';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { createProject, createWorkspace } from '../../src/server/projects/store';
import { RunQueue } from '../../src/server/runs/queue';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { traceIdOf } from '../../src/server/stream/otlp';
import { createSink } from '../../src/server/stream/store';
import { Streamer } from '../../src/server/stream/streamer';

const lab = process.env.AFS_TEST_STREAM_LAB;
const read = process.env.AFS_TEST_STREAM_READ;
const caFile = process.env.AFS_TEST_STREAM_CA;
const log = createLogger({ level: 'silent', format: 'json', write: () => undefined });
const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };

const until = async <T>(check: () => Promise<T | undefined> | T | undefined, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const got = await check();
    if (got !== undefined) return got;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 500));
  }
};
/** The lines of a lab output file that hold `text`, as JSON. */
const linesWith = (file: string, text: string): unknown[] | undefined => {
  if (!read) return undefined;
  const out = execSync(`${read}/${file}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const found = out
    .split('\n')
    .filter((l) => l.includes(text))
    .map((l) => JSON.parse(l));
  return found.length ? found : undefined;
};

describe.skipIf(!lab)('event streaming against the lab receivers', () => {
  let database: Database;
  let streamer: Streamer;
  const db = () => database.db;
  const marker = `Lab "core" key \\ [ssh] — Zürich ${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    streamer = new Streamer({
      db: db(),
      key,
      log,
      version: '1.2.0',
      hostname: 'afs-contract',
      everyMs: 60_000,
      steps: async () => ({
        N1: { key: 'precheck', kind: 'subflow', title: 'Pre-checks' },
        N2: { key: 'backup', kind: 'module', title: 'Back up config' },
      }),
    });
  });
  afterAll(async () => {
    await streamer?.stop();
    await database?.close();
  });

  const syslogCase = async (transport: 'tcp' | 'tls', port: number, ca?: string) => {
    await db().deleteFrom('stream_sink').execute();
    await createSink(db(), key, {
      name: `rsyslog ${transport}`,
      type: 'syslog',
      runs: false,
      syslog: { host: lab as string, port, transport, windowSeconds: 1, ...(ca ? { ca } : {}) },
    });
    const entry = await recordAudit(db(), {
      actor: { id: 'u-91aa', login: 'olga' },
      source: 'api',
      action: 'credential.change',
      object: { type: 'credential', id: 'c-12', name: `${marker} ${transport}` },
      result: 'failed',
      status: 500,
      detail: { fields: ['username', 'private_key'], code: 'DB_LOCKED' },
    });
    await streamer.round();
    await new Promise((r) => setTimeout(r, 1200));
    await streamer.round();
    const row = await db()
      .selectFrom('stream_delivery')
      .select(['status', 'last_error'])
      .executeTakeFirst();
    expect(row).toEqual({ status: 'sent', last_error: null });
    if (!read) return;
    const [parsed] = (await until(() => linesWith('rsyslog/parsed.jsonl', entry.id))) as {
      msgid: string;
      severity: string;
      host: string;
      sd: Record<string, Record<string, string>>;
    }[];
    expect(parsed).toMatchObject({
      msgid: 'credential.change',
      severity: 'err',
      host: 'afs-contract',
    });
    expect(parsed?.sd['audit@32473']).toMatchObject({
      id: entry.id,
      result: 'failed',
      status: '500',
    });
    expect(parsed?.sd['object@32473']?.name).toBe(`${marker} ${transport}`);
    expect(JSON.parse(parsed?.sd['detail@32473']?.json ?? '{}')).toEqual({
      fields: ['username', 'private_key'],
      code: 'DB_LOCKED',
    });
  };

  it(
    'rsyslog parses an audit entry sent over TCP, escaping and all',
    () => syslogCase('tcp', 10514),
    60_000,
  );

  it.skipIf(!caFile)(
    'and over TLS (RFC 5425), checking the receiver against its CA',
    () => syslogCase('tls', 6514, readFileSync(caFile as string, 'utf8')),
    60_000,
  );

  it('the collector takes audit log records, and Jaeger shows a run as one trace, even sent twice', async () => {
    await db().deleteFrom('stream_sink').execute();
    await db().deleteFrom('stream_delivery').execute();
    await createSink(db(), key, {
      name: 'collector',
      type: 'otlp',
      otlp: { endpoint: `http://${lab}:4318`, environment: 'contract' },
    });
    const user = await createUser(db(), {
      login: 'olga',
      name: 'Olga',
      password: 'correct horse battery staple',
    });
    const workspace = await createWorkspace(db(), { key: 'net', name: 'Network' });
    const project = (await createProject(db(), workspace.id, { key: 'edge', name: 'Edge' }, false))
      .id;
    const queue = new RunQueue(db(), 'sqlite', key, { maxRuns: 4, perProject: 4 });
    queue.onEnded = (id) => streamer.runEnded(id);
    const run = await queue.enqueue(
      {
        config: 'c-1',
        project,
        commit: 'a'.repeat(40),
        ref: 'main',
        flow: {
          file: 'flows/deploy-web.flow.yaml',
          key: 'deploy-web',
          name: 'Deploy web tier',
          version: 7,
        },
        mode: 'real',
        inputs: { ticket: 'CHG-CONTRACT-SECRET' },
        targets: ['web01'],
        credentials: [],
      },
      { ticket: 'CHG-CONTRACT-SHOWN' },
      { id: user.id, login: 'olga' },
    );
    const entry = await recordAudit(db(), {
      actor: { id: user.id, login: 'olga' },
      source: 'ui',
      action: 'run.launch',
      object: { type: 'run', id: run.id, name: marker },
      result: 'ok',
      status: 201,
    });
    const job = await queue.claim('w1');
    const t0 = Date.now() / 1000 - 30;
    await queue.finish(run.id, job?.token as string, 'failed', 'web02 failed', new Date(), {
      summary: {
        hosts: ['web01', 'web02'],
        nodes: { N1: { ok: ['web01', 'web02'] }, N2: { ok: ['web01'], failed: ['web02'] } },
        outcome: { web02: 'open port: backup.failed' },
        failures: [],
        unreachable: [],
        stoppedEarly: false,
        timings: { N1: { start: t0, end: t0 + 10 }, N2: { start: t0 + 11, end: t0 + 20 } },
        problems: { N2: { web02: { task: 'Fetch config', status: 'failed', msg: 'Timed out' } } },
      },
    });
    await until(async () =>
      (
        await db()
          .selectFrom('stream_delivery')
          .select('kind')
          .where('kind', '=', 'run-end')
          .execute()
      ).length
        ? true
        : undefined,
    );
    await streamer.round();
    const rows = await db()
      .selectFrom('stream_delivery')
      .select(['kind', 'status', 'last_error'])
      .execute();
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
    // Sent again (as after a restart): still one trace.
    await db()
      .updateTable('stream_delivery')
      .set({ status: 'pending', next_at: new Date(0).toISOString() })
      .where('kind', '=', 'run-end')
      .execute();
    await streamer.round();
    const trace = await until(async () => {
      const r = await fetch(`http://${lab}:16686/api/traces/${traceIdOf(run.id)}`);
      if (!r.ok) return undefined;
      const body = (await r.json()) as { data: { spans: { operationName: string }[] }[] };
      return body.data?.[0]?.spans.length === 4 ? body.data[0] : undefined;
    });
    expect(trace.spans.map((s) => s.operationName).sort()).toEqual([
      'RUN deploy-web',
      'STEP backup',
      'STEP precheck',
      'queue',
    ]);
    expect(JSON.stringify(trace)).not.toContain('CHG-CONTRACT');
    if (!read) return;
    const logs = (await until(() => linesWith('otel/logs.jsonl', entry.id))) as unknown[];
    const text = JSON.stringify(logs);
    expect(text).toContain('afs.audit.run.launch');
    expect(text).toContain(traceIdOf(run.id));
  }, 90_000);
});
