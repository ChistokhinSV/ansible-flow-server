// Event streaming against real receivers (AFS-243, AFS-244): rsyslog 8 and the OpenTelemetry
// collector with Jaeger behind it, from the streaming lab (test/e2e/labs/streaming).
// Runs only when AFS_TEST_STREAM_LAB names that host:
//   AFS_TEST_STREAM_LAB=<the lab's address>
//   AFS_TEST_STREAM_READ="ssh gns3 tail -n 2000 afs-labs/streaming/out"
//                                      prints the end of a lab output file, given its path
//   AFS_TEST_STREAM_CA=path/to/ca.pem  also tries TLS on 6514 (the lab's certs/ca.pem; not
//                                      through a proxy that re-signs TLS)
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
import { createSink, getSink, updateSink } from '../../src/server/stream/store';
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

  it('says a collector on its gRPC port does not answer OTLP/HTTP', async () => {
    await db().deleteFrom('stream_sink').execute();
    const grpc = await createSink(db(), key, {
      name: 'collector on gRPC',
      type: 'otlp',
      otlp: { endpoint: `http://${lab}:4317` },
    });
    expect(await streamer.test(grpc.id, 'olga')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^Not sent: The answer is not HTTP: OTLP\/HTTP .* 4318/),
    });
  });

  /**
   * What waits for a receiver that cannot take it, then goes when an administrator fixes it: at
   * once, all of it, in the order it was written (rsyslog's file shows the order it arrived in).
   */
  const backlogCase = async (
    wrong: { port: number; transport: 'tcp' | 'tls' },
    right: { port: number; ca?: string },
    error: RegExp,
  ) => {
    await db().deleteFrom('stream_sink').execute();
    await db().deleteFrom('stream_delivery').execute();
    const s = await createSink(db(), key, {
      name: `rsyslog ${wrong.transport}`,
      type: 'syslog',
      runs: false,
      syslog: { host: lab as string, ...wrong, windowSeconds: 1 },
    });
    // Plain: the marker's quotes are escaped in rsyslog's JSON.
    const tag = `backlog-${wrong.transport}-${randomUUID().slice(0, 8)}`;
    const ids: string[] = [];
    for (let i = 0; i < 300; i++) {
      ids.push(
        (
          await recordAudit(db(), {
            actor: { id: 'u-91aa', login: 'olga' },
            source: 'ui',
            action: 'session.sign-in',
            object: { type: 'session', name: `${tag} ${i}` },
            result: 'ok',
          })
        ).id,
      );
      if (i % 100 === 0) await streamer.round();
    }
    const failing = await getSink(db(), s.id);
    expect(failing?.status.backlog).toBe(300);
    expect(failing?.status.lastError).toMatch(error);
    expect((await streamer.test(s.id, 'olga'))?.message).toMatch(error);
    const fixedAt = Date.now();
    await updateSink(db(), key, s.id, { syslog: { host: lab as string, ...right } });
    await streamer.round();
    const sent = await until(async () => {
      await new Promise((r) => setTimeout(r, 1100));
      await streamer.round();
      const st = (await getSink(db(), s.id))?.status;
      return st?.backlog === 0 ? st : undefined;
    });
    expect(sent.lastSuccessAt).toBeDefined();
    expect(Date.now() - fixedAt).toBeLessThan(15_000);
    if (!read) return;
    const got = (await until(() => {
      const lines = linesWith('rsyslog/parsed.jsonl', tag) as
        | { sd: Record<string, Record<string, string>> }[]
        | undefined;
      return lines && lines.length >= 300 ? lines : undefined;
    })) as { sd: Record<string, Record<string, string>> }[];
    expect(got.map((l) => l.sd['audit@32473']?.id)).toEqual(ids);
  };

  it(
    'a wrong port: says nothing listens, then drains what waited at once, in order, when fixed',
    () => backlogCase({ port: 10599, transport: 'tcp' }, { port: 10514 }, /Nothing listens on/),
    90_000,
  );

  it.skipIf(!caFile)(
    'TLS without the CA: says the certificate is not trusted, then drains when the CA is added',
    () =>
      backlogCase(
        { port: 6514, transport: 'tls' },
        { port: 6514, ca: readFileSync(caFile as string, 'utf8') },
        /Its certificate is not trusted: add the authority/,
      ),
    90_000,
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
