// Event streaming (AFS-243, AFS-244): the RFC 5424 format, the syslog connection (the two bugs of
// the spike: backpressure and a second socket on reconnect), the OTLP mapping and sender, and on
// both databases (PostgreSQL when AFS_TEST_POSTGRES_URL is set) the outbox, the sender against
// local receivers, the bounds, stream.failing and the administrators' API. Fictional data only.
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createTcpServer, type Socket, type Server as TcpServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { gunzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { type AuditEntry, auditStream, listAudit, recordAudit } from '../../src/server/audit/store';
import { createUser } from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import type { PreparedLaunch } from '../../src/server/launch/prepare';
import { createLogger } from '../../src/server/log';
import { createProject, createWorkspace } from '../../src/server/projects/store';
import { RunQueue } from '../../src/server/runs/queue';
import { rotate } from '../../src/server/secrets/credentials';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import {
  auditRecord,
  post,
  type RunTrace,
  runSpans,
  spanIdOf,
  traceIdOf,
} from '../../src/server/stream/otlp';
import {
  createSink,
  enforceBounds,
  enqueueDeliveries,
  getSink,
  markRetry,
  sinkForSending,
  takeDue,
  updateSink,
} from '../../src/server/stream/store';
import { Streamer } from '../../src/server/stream/streamer';
import {
  dial,
  formatAudit,
  formatRun,
  frame,
  type SyslogFormat,
  SyslogLink,
  sdValue,
  type Wire,
} from '../../src/server/stream/syslog';
import { problemOf } from '../../src/server/stream/words';
import { selfSignedCertificate } from '../../src/server/tls/certificates';
import { emptyPeople, emptyWorkspaces } from './helpers/clean';

const keyOf = (): MasterKey => {
  const bytes = newKey();
  return { key: bytes, id: keyId(bytes), source: 'env' };
};
const log = createLogger({ level: 'silent', format: 'json', write: () => undefined });
const FORMAT: SyslogFormat = {
  facility: 13,
  enterprise: 32473,
  bom: true,
  hostname: 'flows-01',
  version: '1.2.0',
  procid: 4123,
};
const ENTRY: AuditEntry = {
  id: '0b6f6a8e-41d2-4c3e-9a51-6c0e2f1d7b03',
  at: '2026-11-23T18:04:00.500Z',
  actor: { id: 'u-91aa', login: 'olga' },
  source: 'api',
  action: 'credential.change',
  object: { type: 'credential', id: 'c-12', name: 'Lab "core" key \\ [ssh] — Zürich' },
  result: 'failed',
  status: 500,
  ip: '2001:db8::17',
  request: 'req-1a2d',
  detail: { fields: ['username', 'private_key'], code: 'DB_LOCKED' },
};

/** Reads RFC 5425 frames (`<len> <msg>`) from a byte stream. */
function frames(buffer: Buffer): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < buffer.length) {
    const space = buffer.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number(buffer.subarray(at, space).toString());
    if (space + 1 + length > buffer.length) break;
    out.push(buffer.subarray(space + 1, space + 1 + length).toString('utf8'));
    at = space + 1 + length;
  }
  return out;
}

describe('syslog messages', () => {
  it('formats an audit entry as RFC 5424, with escaped, lowercase structured data', () => {
    const text = formatAudit(ENTRY, FORMAT);
    // facility 13 * 8 + error 3
    expect(
      text.startsWith(
        '<107>1 2026-11-23T18:04:00.500Z flows-01 ansible-flow-server 4123 credential.change [origin software="ansible-flow-server" swversion="1.2.0"]',
      ),
    ).toBe(true);
    expect(text).toContain(
      '[audit@32473 id="0b6f6a8e-41d2-4c3e-9a51-6c0e2f1d7b03" source="api" result="failed" status="500" ip="2001:db8::17" request="req-1a2d"]',
    );
    expect(text).toContain(
      '[object@32473 type="credential" id="c-12" name="Lab \\"core\\" key \\\\ [ssh\\] — Zürich"]',
    );
    expect(text).toContain(
      '[detail@32473 json="{\\"fields\\":[\\"username\\",\\"private_key\\"\\],\\"code\\":\\"DB_LOCKED\\"}"]',
    );
    expect(text).toContain('﻿olga credential.change credential c-12');
    expect(text).not.toMatch(/[\r\n]/);
    expect(formatAudit(ENTRY, { ...FORMAT, bom: false })).not.toContain('﻿');
    expect(formatAudit({ ...ENTRY, result: 'ok' }, { ...FORMAT, facility: 10 })).toMatch(/^<86>1 /);
    expect(formatAudit(ENTRY, { ...FORMAT, enterprise: 99999 })).toContain(
      '[actor@99999 id="u-91aa" login="olga"]',
    );
    expect(sdValue('a"b\\c]d')).toBe('a\\"b\\\\c\\]d');
  });

  it('cuts a long detail first, keeping a message within 8192 bytes on a UTF-8 boundary', () => {
    const text = formatAudit({ ...ENTRY, detail: { note: 'ü"'.repeat(6000) } }, FORMAT);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
    expect(text).toContain('cut="true"');
    expect(text).toContain('[object@32473');
    expect(text).toContain('olga credential.change');
    expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
  });

  it('formats the start and end of a run, without its inputs', () => {
    const run = {
      id: 'r-42',
      number: 42,
      project: { id: 'p-3', name: 'edge' },
      flow: { key: 'fw-upgrade', name: 'Firewall upgrade', version: 7, file: 'flows/fw.flow.yaml' },
      mode: 'real',
      state: 'failed',
      requestedLogin: 'olga',
      createdAt: '2026-11-23T18:01:02.345Z',
      startedAt: '2026-11-23T18:01:04.900Z',
      endedAt: '2026-11-23T18:03:31.000Z',
      hosts: 4,
      failed: 2,
    };
    const start = formatRun(run, 'start', FORMAT);
    expect(start).toMatch(
      /^<110>1 2026-11-23T18:01:04.900Z flows-01 ansible-flow-server 4123 run.started /,
    );
    expect(start).toContain('state="running"');
    const end = formatRun(run, 'end', FORMAT);
    expect(end).toMatch(/^<107>1 2026-11-23T18:03:31.000Z .* run.ended /);
    expect(end).toContain('[run@32473 id="r-42" number="42" project="edge"');
    expect(end).toContain('duration_s="146.1"');
    expect(end).toContain('run 42 "Firewall upgrade" failed: 2 of 4 hosts failed');
  });

  it('frames by octet counting or by line', () => {
    expect(frame('héllo').toString()).toBe('6 héllo');
    expect(frame('hi', 'lf').toString()).toBe('hi\n');
  });
});

/** A socket of a test: what was written, and whether it takes more. */
class FakeWire extends EventEmitter implements Wire {
  written: Buffer[] = [];
  full = false;
  destroyed = false;
  writableLength = 0;
  write(chunk: Buffer): boolean {
    this.written.push(chunk);
    return !this.full;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
  end(): void {
    this.destroy();
  }
}

describe('the syslog connection', () => {
  it('waits for drain when the socket is full: backpressure is not bypassed (spike bug 1)', async () => {
    const wire = new FakeWire();
    wire.full = true;
    const link = new SyslogLink(async () => wire);
    const writing = link.write([frame('a'), frame('b'), frame('c')]);
    await new Promise((r) => setTimeout(r, 20));
    // The spike wrote on and on; here the second frame waits.
    expect(wire.written).toHaveLength(1);
    wire.full = false;
    wire.emit('drain');
    await writing;
    expect(wire.written.map((b) => b.toString())).toEqual(['1 a', '1 b', '1 c']);
  });

  it('opens one socket however many ask at once, also after it was lost (spike bug 2)', async () => {
    const wires: FakeWire[] = [];
    const link = new SyslogLink(async () => {
      await new Promise((r) => setTimeout(r, 10));
      const w = new FakeWire();
      wires.push(w);
      return w;
    });
    const lost: number[] = [];
    link.onLost = (g) => lost.push(g);
    await Promise.all([link.connect(), link.connect(), link.write([frame('x')])]);
    expect(wires).toHaveLength(1);
    expect(link.settled(1)).toBe(true);
    wires[0]?.destroy();
    expect(lost).toEqual([1]);
    expect(link.settled(1)).toBe(false);
    // A timer and a pump both reconnecting: still one new socket.
    await Promise.all([link.write([frame('y')]), link.connect(), link.write([frame('z')])]);
    expect(wires).toHaveLength(2);
    expect(link.generation).toBe(2);
    expect(wires[1]?.written.map((b) => b.toString())).toEqual(['1 y', '1 z']);
  });

  it('speaks TLS to a receiver its CA vouches for, and refuses one it does not', async () => {
    const served = await selfSignedCertificate(['127.0.0.1']);
    const stranger = await selfSignedCertificate(['127.0.0.1']);
    const got: Buffer[] = [];
    const server = createTlsServer({ cert: served.certificate, key: served.key }, (s) =>
      s.on('data', (c: Buffer) => got.push(c)),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const settings = {
      host: '127.0.0.1',
      port,
      transport: 'tls' as const,
      facility: 13,
      enterprise: 32473,
      bom: true,
      framing: 'octet' as const,
      windowSeconds: 0,
    };
    try {
      const link = new SyslogLink(() => dial({ ...settings, ca: served.certificate }));
      await link.write([frame('<110>1 - - - - - - hello')]);
      await until(() => frames(Buffer.concat(got)).length === 1);
      link.close();
      await expect(dial({ ...settings, ca: stranger.certificate })).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  it('fails a write whose socket closes while it waits for drain', async () => {
    const wire = new FakeWire();
    wire.full = true;
    const link = new SyslogLink(async () => wire);
    const writing = link.write([frame('a'), frame('b')]);
    await new Promise((r) => setTimeout(r, 10));
    wire.destroy();
    await expect(writing).rejects.toThrow('closed');
  });
});

const SUMMARY = {
  hosts: ['web01', 'web02', 'web03', 'web04'],
  nodes: {
    N1: { ok: ['web01', 'web02', 'web03', 'web04'] },
    N2: { ok: ['web01', 'web02', 'web03'], failed: ['web04'] },
  },
  outcome: { web04: 'open port: backup.failed' },
  failures: [],
  unreachable: [],
  stoppedEarly: false,
  timings: {
    N1: { start: 1795456865, end: 1795456877.4 },
    N2: { start: 1795456877.6, end: 1795456885.1 },
  },
  waited: { N2: 3.5 },
  problems: {
    N2: { web04: { task: 'Fetch config', status: 'failed' as const, msg: 'Timed out' } },
  },
};
const TRACE: RunTrace = {
  id: 'r-0042',
  number: 42,
  project: { id: 'p-3', name: 'edge' },
  flow: {
    key: 'deploy-web',
    name: 'Deploy web tier',
    version: 7,
    file: 'flows/deploy-web.flow.yaml',
  },
  mode: 'real',
  state: 'failed',
  requestedLogin: 'olga',
  createdAt: '2026-11-23T18:01:02.345Z',
  startedAt: '2026-11-23T18:01:04.900Z',
  endedAt: '2026-11-23T18:03:31.000Z',
  commit: '3f9c2e1a7b',
  summary: SUMMARY,
};

describe('OpenTelemetry', () => {
  it('maps a run to a trace with ids from the run id, steps by key, and capped host events', () => {
    const spans = runSpans(
      TRACE,
      {
        N1: { key: 'precheck', kind: 'subflow' },
        N2: { key: 'backup', kind: 'module', title: 'Back up' },
      },
      { hostNames: true, maxHostEvents: 2 },
    ) as {
      traceId: string;
      spanId: string;
      parentSpanId?: string;
      name: string;
      status: { code: number };
      events: unknown[];
      attributes: { key: string; value: unknown }[];
    }[];
    expect(spans.map((s) => s.name)).toEqual([
      'RUN deploy-web',
      'queue',
      'STEP precheck',
      'STEP backup',
    ]);
    expect(traceIdOf('r-0042')).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([traceIdOf('r-0042')]));
    expect(spans[0]?.spanId).toBe(spanIdOf('r-0042'));
    expect(spans.slice(1).every((s) => s.parentSpanId === spanIdOf('r-0042'))).toBe(true);
    expect(spans[0]?.status).toEqual({ code: 2, message: '1 of 4 hosts failed (failed)' });
    const backup = spans[3];
    expect(backup?.status.code).toBe(2);
    expect(backup?.events).toHaveLength(2);
    const attr = (k: string) => backup?.attributes.find((a) => a.key === k)?.value;
    expect(attr('afs.step.port.failed')).toEqual({ intValue: '1' });
    expect(attr('afs.step.waited_s')).toEqual({ doubleValue: 3.5 });
    expect(attr('afs.step.hosts_omitted')).toEqual({ intValue: '3' });
    // The same run gives the same ids: sent twice, it is one trace.
    expect(JSON.stringify(runSpans(TRACE, {}, { hostNames: true, maxHostEvents: 2 }))).toBe(
      JSON.stringify(runSpans(TRACE, {}, { hostNames: true, maxHostEvents: 2 })),
    );
    const counts = runSpans(TRACE, {}, { hostNames: false, maxHostEvents: 100 }) as {
      events?: unknown[];
    }[];
    expect(counts.every((s) => (s.events ?? []).length === 0)).toBe(true);
  });

  it("gives an audit entry about a run that run's trace", () => {
    const r = auditRecord({
      ...ENTRY,
      action: 'run.launch',
      result: 'ok',
      object: { type: 'run', id: 'r-0042' },
    });
    expect(r).toMatchObject({
      severityNumber: 9,
      eventName: 'afs.audit.run.launch',
      traceId: traceIdOf('r-0042'),
      spanId: spanIdOf('r-0042'),
    });
    expect(auditRecord(ENTRY)).toMatchObject({ severityNumber: 17, severityText: 'ERROR' });
    expect(auditRecord(ENTRY)).not.toHaveProperty('traceId');
  });

  it('leaves out a step no host reached: a rollback that did not run has no span', () => {
    const run: RunTrace = {
      ...TRACE,
      state: 'succeeded',
      summary: {
        ...SUMMARY,
        nodes: { ...SUMMARY.nodes, N3: {} },
        timings: { ...SUMMARY.timings, N3: { start: 1795456885.2, end: 1795456885.2 } },
      },
    };
    const names = (
      runSpans(
        run,
        { N3: { key: 'rollback', kind: 'task' } },
        {
          hostNames: true,
          maxHostEvents: 10,
        },
      ) as { name: string }[]
    ).map((s) => s.name);
    expect(names).toEqual(['RUN deploy-web', 'queue', 'STEP N1', 'STEP N2']);
    // A task's failure port is failed_hosts: its span is an error.
    const task = runSpans(
      {
        ...TRACE,
        summary: {
          ...SUMMARY,
          nodes: { N5: { ok_hosts: ['web01'], failed_hosts: ['web02'] } },
          timings: { N5: { start: 1795456865, end: 1795456870 } },
          problems: {},
        },
      },
      {},
      { hostNames: false, maxHostEvents: 0 },
    ) as { name: string; status: { code: number } }[];
    expect(task.find((x) => x.name === 'STEP N5')?.status).toEqual({
      code: 2,
      message: '1 host(s) left by a failure port',
    });
  });

  it('says why a destination failed in words, with the code for a search', () => {
    expect(problemOf({ code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'self-signed' })).toBe(
      'Its certificate is not trusted: add the authority (CA) that signed it (SELF_SIGNED_CERT_IN_CHAIN)',
    );
    expect(problemOf({ code: 'ECONNREFUSED', message: 'x' }, '192.0.2.10:10599')).toBe(
      'Nothing listens on 192.0.2.10:10599: check the port, and that the receiver is up (ECONNREFUSED)',
    );
    expect(problemOf({ code: 'HPE_INVALID_CONSTANT', message: 'Parse Error' })).toMatch(
      /^The answer is not HTTP: OTLP\/HTTP is usually on port 4318/,
    );
    expect(problemOf(new Error('connect timeout'), 'siem.example.net:6514')).toBe(
      'Not reachable: no answer from siem.example.net:6514',
    );
    expect(problemOf('ECONNRESET')).toBe('The receiver closed the connection (ECONNRESET)');
  });

  it('posts gzipped JSON with its headers; tries again only where that can help', async () => {
    const got: { path: string; headers: IncomingMessage['headers']; body: unknown }[] = [];
    const server: Server = createServer((request, reply) => {
      const chunks: Buffer[] = [];
      request.on('data', (c: Buffer) => chunks.push(c));
      request.on('end', () => {
        got.push({
          path: request.url ?? '',
          headers: request.headers,
          body: JSON.parse(gunzipSync(Buffer.concat(chunks)).toString()),
        });
        const status = Number(request.headers['x-answer'] ?? 200);
        reply
          .writeHead(status, { 'content-type': 'application/json' })
          .end(status === 200 ? '{}' : '{"message":"bad"}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const ok = await post(
        endpoint,
        '/v1/logs',
        { a: 1 },
        { headers: { authorization: 'Bearer example-token' } },
      );
      expect(ok).toMatchObject({ ok: true, status: 200 });
      expect(got[0]).toMatchObject({ path: '/v1/logs', body: { a: 1 } });
      expect(got[0]?.headers).toMatchObject({
        authorization: 'Bearer example-token',
        'content-encoding': 'gzip',
        'content-type': 'application/json',
      });
      expect(
        await post(endpoint, '/v1/traces', {}, { headers: { 'x-answer': '503' } }),
      ).toMatchObject({ ok: false, retry: true, status: 503 });
      expect(
        await post(endpoint, '/v1/traces', {}, { headers: { 'x-answer': '400' } }),
      ).toMatchObject({ ok: false, retry: false, status: 400 });
    } finally {
      server.close();
    }
    expect(await post('http://127.0.0.1:1', '/v1/logs', {})).toMatchObject({
      ok: false,
      retry: true,
    });
  });
});

/** A syslog receiver over TCP: what it got, and a way to drop its connections. */
async function receiver(): Promise<{
  port: number;
  got: () => string[];
  drop(): void;
  close(): void;
  connections: number;
}> {
  const chunks: Buffer[] = [];
  const sockets = new Set<Socket>();
  const state = { connections: 0 };
  const server: TcpServer = createTcpServer((s) => {
    state.connections++;
    sockets.add(s);
    s.on('data', (c: Buffer) => chunks.push(c));
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    got: () => frames(Buffer.concat(chunks)),
    drop: () => {
      for (const s of sockets) s.destroy();
    },
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
    get connections() {
      return state.connections;
    },
  };
}

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];
const launchOf = (project: string): PreparedLaunch => ({
  config: 'c-stream',
  project,
  commit: 'a'.repeat(40),
  ref: 'main',
  flow: { file: 'flows/upgrade.flow.yaml', key: 'upgrade', name: 'Firewall upgrade', version: 1 },
  mode: 'real',
  inputs: { change_ticket: 'CHG-SECRET-4711' },
  targets: ['fw-edge-01'],
  credentials: [],
});
const until = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

for (const [name, config] of databases) {
  describe.skipIf(!config)(`event streaming on ${name}`, () => {
    let database: Database;
    const key = keyOf();
    const db = () => database.db;
    let project: string;
    let admin: { id: string; login: string };

    beforeAll(async () => {
      if (!config) return;
      database = openDatabase(config);
      await migrate(database.db as never);
      await db().deleteFrom('stream_delivery').execute();
      await db().deleteFrom('stream_sink').execute();
      await emptyWorkspaces(db());
      await emptyPeople(db());
      const user = await createUser(db(), {
        login: 'dana',
        name: 'Dana',
        password: 'correct horse battery staple',
        admin: true,
      });
      admin = { id: user.id, login: 'dana' };
      const workspace = await createWorkspace(db(), { key: 'net', name: 'Network' });
      project = (await createProject(db(), workspace.id, { key: 'edge', name: 'Edge' }, false)).id;
    });
    afterAll(async () => {
      await db()?.deleteFrom('stream_delivery').execute();
      await db()?.deleteFrom('stream_sink').execute();
      await database?.close();
    });
    const clear = async () => {
      await db().deleteFrom('stream_delivery').execute();
      await db().deleteFrom('stream_sink').execute();
    };
    const audit = (action = 'run.launch') =>
      recordAudit(db(), {
        actor: admin,
        source: 'ui',
        action,
        object: { type: 'run', id: 'r-1' },
        result: 'ok',
        status: 201,
      });

    it('checks settings, seals headers, and keeps a header whose value is left out', async () => {
      await clear();
      await expect(
        createSink(db(), key, { name: 'x', type: 'syslog', syslog: { host: 'bad host!' } }),
      ).rejects.toMatchObject({ field: 'syslog.host' });
      await expect(
        createSink(db(), key, {
          name: 'x',
          type: 'syslog',
          syslog: { host: 'siem.example.net', facility: 24 },
        }),
      ).rejects.toMatchObject({ field: 'syslog.facility' });
      await expect(
        createSink(db(), key, {
          name: 'x',
          type: 'otlp',
          otlp: { endpoint: 'https://u:p@collector.example.net' },
        }),
      ).rejects.toMatchObject({ field: 'otlp.endpoint' });
      await expect(
        createSink(db(), key, {
          name: 'x',
          type: 'otlp',
          otlp: {
            endpoint: 'https://collector.example.net',
            headers: [{ name: 'content-type', value: 'x' }],
          },
        }),
      ).rejects.toMatchObject({ field: 'otlp.headers' });
      const s = await createSink(db(), key, {
        name: 'SIEM',
        type: 'syslog',
        syslog: { host: 'siem.example.net' },
      });
      expect(s.syslog).toEqual({
        host: 'siem.example.net',
        port: 6514,
        transport: 'tls',
        facility: 13,
        enterprise: 32473,
        bom: true,
        framing: 'octet',
        windowSeconds: 3,
      });
      expect(s).toMatchObject({
        enabled: true,
        audit: true,
        runs: true,
        maxBacklog: 100_000,
        maxAgeDays: 7,
      });
      const o = await createSink(db(), key, {
        name: 'Collector',
        type: 'otlp',
        otlp: {
          endpoint: 'https://collector.example.net:4318/',
          headers: [{ name: 'Authorization', value: 'Bearer example-token-1' }],
        },
      });
      expect(o.otlp).toMatchObject({
        endpoint: 'https://collector.example.net:4318',
        headers: ['Authorization'],
      });
      expect(JSON.stringify(o)).not.toContain('example-token-1');
      const row = await db()
        .selectFrom('stream_sink')
        .selectAll()
        .where('id', '=', o.id)
        .executeTakeFirstOrThrow();
      expect(row.config_json + (row.headers_enc ?? '')).not.toContain('example-token-1');
      await updateSink(db(), key, o.id, {
        otlp: {
          endpoint: o.otlp?.endpoint ?? '',
          headers: [{ name: 'Authorization' }, { name: 'api-key', value: 'k-2' }],
        },
      });
      expect((await sinkForSending(db(), key, o.id))?.headerValues).toEqual({
        Authorization: 'Bearer example-token-1',
        'api-key': 'k-2',
      });
      await expect(updateSink(db(), key, o.id, { type: 'syslog' })).rejects.toMatchObject({
        field: 'type',
      });
      // A new master key seals the headers again.
      const next = keyOf();
      await rotate(db(), key, next);
      expect((await sinkForSending(db(), next, o.id))?.headerValues.Authorization).toBe(
        'Bearer example-token-1',
      );
      await rotate(db(), next, key);
    });

    it('feeds the outbox from the audit log, once per sink and entry, and takes each row once', async () => {
      await clear();
      const woken: number[] = [];
      auditStream.recorded = () => woken.push(1);
      try {
        const syslog = await createSink(db(), key, {
          name: 'SIEM',
          type: 'syslog',
          syslog: { host: 'siem.example.net' },
        });
        const quiet = await createSink(db(), key, {
          name: 'Traces only',
          type: 'otlp',
          audit: false,
          otlp: { endpoint: 'http://collector.example.net' },
        });
        await createSink(db(), key, {
          name: 'Off',
          type: 'syslog',
          enabled: false,
          syslog: { host: 'old.example.net' },
        });
        const entries = [];
        for (let i = 0; i < 6; i++) entries.push(await audit());
        expect(woken.length).toBe(6);
        const rows = await db().selectFrom('stream_delivery').selectAll().execute();
        expect(rows).toHaveLength(6);
        expect(new Set(rows.map((r) => r.sink_id))).toEqual(new Set([syslog.id]));
        // Again: nothing more (unique on sink, kind, ref).
        await enqueueDeliveries(db(), 'audit', entries[0]?.id as string);
        // A run's start goes to syslog only; its end to both.
        await enqueueDeliveries(db(), 'run-start', 'r-9');
        await enqueueDeliveries(db(), 'run-end', 'r-9');
        await enqueueDeliveries(db(), 'run-end', 'r-9');
        const runs = await db()
          .selectFrom('stream_delivery')
          .select(['sink_id', 'kind'])
          .where('ref_id', '=', 'r-9')
          .execute();
        expect(
          runs.map((r) => `${r.sink_id === syslog.id ? 'syslog' : 'otlp'}:${r.kind}`).sort(),
        ).toEqual(['otlp:run-end', 'syslog:run-end', 'syslog:run-start']);
        expect(runs.some((r) => r.sink_id === quiet.id && r.kind === 'run-start')).toBe(false);
        // Two servers at once: every row is taken by one of them.
        const [a, b] = await Promise.all([
          takeDue(db(), syslog.id, ['audit', 'run-start', 'run-end'], 5),
          takeDue(db(), syslog.id, ['audit', 'run-start', 'run-end'], 5),
        ]);
        const all = [...a, ...b].map((t) => `${t.kind}:${t.ref}`);
        expect(new Set(all).size).toBe(all.length);
        expect(all.length).toBe(8);
        expect(await takeDue(db(), syslog.id, ['audit'], 5)).toEqual([]);
        // Given back: due again after the delay.
        await markRetry(db(), syslog.id, a, 'down', 0);
        expect((await takeDue(db(), syslog.id, ['audit', 'run-start', 'run-end'], 50)).length).toBe(
          a.length,
        );
      } finally {
        auditStream.recorded = undefined;
      }
    });

    it('drops the oldest over the bounds, counts them, and keeps the rest', async () => {
      await clear();
      const s = await createSink(db(), key, {
        name: 'SIEM',
        type: 'syslog',
        maxBacklog: 100,
        syslog: { host: 'siem.example.net' },
      });
      const t0 = Date.parse('2026-11-01T00:00:00Z');
      for (let i = 0; i < 130; i++)
        await enqueueDeliveries(
          db(),
          'audit',
          `e-${String(i).padStart(3, '0')}`,
          new Date(t0 + i * 60_000),
        );
      const dropped = await enforceBounds(
        db(),
        { id: s.id, maxBacklog: 100, maxAgeDays: 7 },
        new Date(t0 + 200 * 60_000),
      );
      expect(dropped).toBe(30);
      const left = await db()
        .selectFrom('stream_delivery')
        .select('ref_id')
        .where('status', '=', 'pending')
        .orderBy('ref_id')
        .execute();
      expect(left).toHaveLength(100);
      expect(left[0]?.ref_id).toBe('e-030');
      // Past the age limit, all of them.
      expect(
        await enforceBounds(
          db(),
          { id: s.id, maxBacklog: 100, maxAgeDays: 7 },
          new Date(t0 + 9 * 86_400_000),
        ),
      ).toBe(100);
      expect((await getSink(db(), s.id))?.status).toMatchObject({ backlog: 0, dropped: 130 });
    });

    it('sends to a syslog receiver, counts rows sent after the window, and sends again what a lost connection had', async () => {
      await clear();
      const rx = await receiver();
      const streamer = new Streamer({
        db: db(),
        key,
        log,
        version: '1.2.0',
        hostname: 'flows-01',
        everyMs: 60_000,
      });
      try {
        const s = await createSink(db(), key, {
          name: 'Lab',
          type: 'syslog',
          syslog: { host: '127.0.0.1', port: rx.port, transport: 'tcp', windowSeconds: 1 },
        });
        const first = await audit('session.sign-in');
        await streamer.round();
        await until(() => rx.got().length === 1);
        expect(rx.got()[0]).toContain(`[audit@32473 id="${first.id}"`);
        expect((await getSink(db(), s.id))?.status.backlog).toBe(1);
        // The connection drops inside the window: the row goes again, first.
        rx.drop();
        await until(
          async () =>
            (await db().selectFrom('stream_delivery').select('status').executeTakeFirst())
              ?.status === 'pending',
        );
        await streamer.round();
        await until(() => rx.got().length === 2);
        expect(rx.connections).toBe(2);
        expect(rx.got()[1]).toContain(first.id);
        await new Promise((r) => setTimeout(r, 1100));
        await streamer.round();
        const status = (await getSink(db(), s.id))?.status;
        expect(status).toMatchObject({ backlog: 0 });
        expect(status?.lastSuccessAt).toBeDefined();
        expect(status?.failingSince).toBeUndefined();
        expect(await streamer.test(s.id, 'dana')).toMatchObject({ ok: true });
        await until(() => rx.got().some((m) => m.includes(' afs.test ')));
      } finally {
        await streamer.stop();
        rx.close();
      }
    });

    it('sends a run as a trace when it ends, and its start and end as syslog lines, never its inputs', async () => {
      await clear();
      const rx = await receiver();
      const bodies: { path: string; body: string }[] = [];
      const http: Server = createServer((request, reply) => {
        const chunks: Buffer[] = [];
        request.on('data', (c: Buffer) => chunks.push(c));
        request.on('end', () => {
          bodies.push({
            path: request.url ?? '',
            body: gunzipSync(Buffer.concat(chunks)).toString(),
          });
          reply.writeHead(200).end('{}');
        });
      });
      await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
      const streamer = new Streamer({
        db: db(),
        key,
        log,
        version: '1.2.0',
        hostname: 'flows-01',
        everyMs: 60_000,
      });
      const queue = new RunQueue(db(), database.kind, key, { maxRuns: 8, perProject: 8 });
      queue.onStarted = (id) => streamer.runStarted(id);
      queue.onEnded = (id) => streamer.runEnded(id);
      try {
        await createSink(db(), key, {
          name: 'Lab',
          type: 'syslog',
          audit: false,
          syslog: { host: '127.0.0.1', port: rx.port, transport: 'tcp', windowSeconds: 0 },
        });
        await createSink(db(), key, {
          name: 'Collector',
          type: 'otlp',
          audit: false,
          otlp: { endpoint: `http://127.0.0.1:${(http.address() as { port: number }).port}` },
        });
        const run = await queue.enqueue(
          launchOf(project),
          { change_ticket: 'CHG-SHOWN-4711' },
          admin,
          'Upgrade',
        );
        const job = await queue.claim('w1');
        expect(job?.run.id).toBe(run.id);
        await queue.finish(
          run.id,
          job?.token as string,
          'failed',
          'fw-edge-01 failed',
          new Date(),
          {
            summary: {
              ...SUMMARY,
              hosts: ['fw-edge-01'],
              outcome: { 'fw-edge-01': 'failed' },
              nodes: {},
              timings: {},
            },
          },
        );
        await until(
          async () =>
            (
              await db()
                .selectFrom('stream_delivery')
                .select('kind')
                .where('ref_id', '=', run.id)
                .execute()
            ).length === 3,
        );
        await streamer.round();
        await until(() => rx.got().length === 2 && bodies.length === 1);
        expect(rx.got()[0]).toContain(' run.started ');
        expect(rx.got()[1]).toContain(' run.ended ');
        expect(rx.got()[1]).toContain(
          `run ${run.number} "Firewall upgrade" failed: 1 of 1 hosts failed`,
        );
        expect(bodies[0]?.path).toBe('/v1/traces');
        const trace = JSON.parse(bodies[0]?.body ?? '{}');
        expect(trace.resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject({
          traceId: traceIdOf(run.id),
          name: 'RUN upgrade',
        });
        for (const text of [...rx.got(), bodies[0]?.body ?? '']) {
          expect(text).not.toContain('CHG-SECRET-4711');
          expect(text).not.toContain('CHG-SHOWN-4711');
        }
      } finally {
        await streamer.stop();
        rx.close();
        http.close();
      }
    });

    it('tells once when a destination has failed for 15 minutes, and drops what a collector refuses', async () => {
      await clear();
      const told: string[] = [];
      const http: Server = createServer((_request, reply) =>
        reply.writeHead(400).end('{"message":"bad payload"}'),
      );
      await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
      const streamer = new Streamer({
        db: db(),
        key,
        log,
        version: '1.2.0',
        everyMs: 60_000,
        failing: (s) => told.push(s.name),
      });
      try {
        const down = await createSink(db(), key, {
          name: 'Down',
          type: 'syslog',
          syslog: { host: '127.0.0.1', port: 1, transport: 'tcp' },
        });
        const refusing = await createSink(db(), key, {
          name: 'Refusing',
          type: 'otlp',
          otlp: { endpoint: `http://127.0.0.1:${(http.address() as { port: number }).port}` },
        });
        await audit();
        await streamer.round();
        const d = await getSink(db(), down.id);
        expect(d?.status).toMatchObject({ backlog: 1 });
        expect(d?.status.lastError).toBe(
          'Nothing listens on 127.0.0.1:1: check the port, and that the receiver is up (ECONNREFUSED)',
        );
        expect(d?.status.failingSince).toBeDefined();
        expect(d?.status.nextTryAt).toBeDefined();
        expect(told).toEqual([]);
        const r = await getSink(db(), refusing.id);
        expect(r?.status).toMatchObject({ backlog: 0, dropped: 1 });
        expect(r?.status.lastError).toContain('HTTP 400');
        await db()
          .updateTable('stream_sink')
          .set({ failing_since: new Date(Date.now() - 16 * 60_000).toISOString() })
          .where('id', '=', down.id)
          .execute();
        await streamer.round();
        await streamer.round();
        expect(told.sort()).toEqual(['Down']);
      } finally {
        await streamer.stop();
        http.close();
      }
    });

    it('drains what waited at once, oldest first, when the receiver is fixed, and keeps written rows over a restart', async () => {
      await clear();
      const rx = await receiver();
      const options = {
        db: db(),
        key,
        log,
        version: '1.2.0',
        hostname: 'flows-01',
        everyMs: 60_000,
      };
      let streamer = new Streamer(options);
      try {
        // A wrong port: everything waits, and the destination waits as a whole.
        const s = await createSink(db(), key, {
          name: 'Lab',
          type: 'syslog',
          syslog: { host: '127.0.0.1', port: 1, transport: 'tcp', windowSeconds: 60 },
        });
        const ids: string[] = [];
        for (let i = 0; i < 520; i++) {
          ids.push((await audit(`session.sign-in`)).id);
          if (i === 3) await streamer.round();
        }
        await streamer.round();
        await streamer.round();
        const failing = await getSink(db(), s.id);
        expect(failing?.status).toMatchObject({ backlog: 520 });
        expect(Date.parse(failing?.status.nextTryAt ?? '')).toBeGreaterThan(Date.now());
        // Fixed: one round sends all of it (more than a batch), in the order it was written.
        await updateSink(db(), key, s.id, { syslog: { host: '127.0.0.1', port: rx.port } });
        expect((await getSink(db(), s.id))?.status.nextTryAt).toBeUndefined();
        await streamer.round();
        await until(() => rx.got().length === 520);
        const sent = rx.got().map((m) => /\[audit@32473 id="([^"]+)"/.exec(m)?.[1]);
        expect(sent).toEqual(ids);
        // Written, not yet counted sent (the window is 60 s): a restart gives them back, and the
        // next server sends them first, not minutes later.
        await streamer.stop();
        const statuses = await db()
          .selectFrom('stream_delivery')
          .select('status')
          .where('sink_id', '=', s.id)
          .execute();
        expect(new Set(statuses.map((r) => r.status))).toEqual(new Set(['pending']));
        const later = await audit('session.sign-out');
        streamer = new Streamer(options);
        await streamer.round();
        await until(() => rx.got().length === 1041);
        const again = rx
          .got()
          .slice(520)
          .map((m) => /\[audit@32473 id="([^"]+)"/.exec(m)?.[1]);
        expect(again).toEqual([...ids, later.id]);
      } finally {
        await streamer.stop();
        rx.close();
      }
    });

    it('sends what waits as soon as a test reaches a failing destination', async () => {
      await clear();
      const rx = await receiver();
      const streamer = new Streamer({
        db: db(),
        key,
        log,
        version: '1.2.0',
        hostname: 'flows-01',
        everyMs: 60_000,
      });
      try {
        const s = await createSink(db(), key, {
          name: 'Lab',
          type: 'syslog',
          syslog: { host: '127.0.0.1', port: rx.port, transport: 'tcp', windowSeconds: 0 },
        });
        // It failed a moment ago (the receiver was restarting): it waits a minute.
        await db()
          .updateTable('stream_sink')
          .set({
            retry_at: new Date(Date.now() + 60_000).toISOString(),
            retries: 5,
            failing_since: new Date().toISOString(),
          })
          .where('id', '=', s.id)
          .execute();
        const entry = await audit();
        await streamer.round();
        expect(rx.got()).toEqual([]);
        expect(await streamer.test(s.id, 'dana')).toMatchObject({ ok: true });
        await until(() => rx.got().some((m) => m.includes(entry.id)));
        await until(async () => (await getSink(db(), s.id))?.status.backlog === 0);
      } finally {
        await streamer.stop();
        rx.close();
      }
    });

    it('gives run.started the same time on a destination that was down as on one that was up', async () => {
      await clear();
      const up = await receiver();
      const fixed = await receiver();
      const streamer = new Streamer({
        db: db(),
        key,
        log,
        version: '1.2.0',
        hostname: 'flows-01',
        everyMs: 60_000,
      });
      const queue = new RunQueue(db(), database.kind, key, { maxRuns: 8, perProject: 8 });
      queue.onStarted = (id) => streamer.runStarted(id);
      try {
        await createSink(db(), key, {
          name: 'Up',
          type: 'syslog',
          audit: false,
          syslog: { host: '127.0.0.1', port: up.port, transport: 'tcp', windowSeconds: 0 },
        });
        const down = await createSink(db(), key, {
          name: 'Down',
          type: 'syslog',
          audit: false,
          syslog: { host: '127.0.0.1', port: 1, transport: 'tcp', windowSeconds: 0 },
        });
        const run = await queue.enqueue(launchOf(project), {}, admin, 'Upgrade');
        const job = await queue.claim('w1');
        await until(
          async () =>
            (
              await db()
                .selectFrom('stream_delivery')
                .select('kind')
                .where('ref_id', '=', run.id)
                .execute()
            ).length === 2,
        );
        await streamer.round();
        await until(() => up.got().length === 1);
        // The worker begins a few seconds later: the run page's Started.
        await queue.start(run.id, job?.token as string, new Date(Date.now() + 3_000));
        await updateSink(db(), key, down.id, { syslog: { host: '127.0.0.1', port: fixed.port } });
        streamer.changed(down.id);
        await streamer.round();
        await until(() => fixed.got().length === 1);
        const stamp = (m: string | undefined) => /^<\d+>1 (\S+) /.exec(m ?? '')?.[1];
        expect(fixed.got()[0]).toContain(' run.started ');
        expect(stamp(fixed.got()[0])).toBe(stamp(up.got()[0]));
      } finally {
        await streamer.stop();
        up.close();
        fixed.close();
      }
    });

    it('sends what waits at once after a change away from an address that does not answer', async () => {
      await clear();
      const rx = await receiver();
      // 192.0.2.55 answers nothing: the connection waits until it is given up.
      const streamer = new Streamer({
        db: db(),
        key,
        log,
        version: '1.2.0',
        hostname: 'flows-01',
        everyMs: 60_000,
        dial: (s, signal) =>
          s.host === '192.0.2.55'
            ? new Promise((_, reject) =>
                signal?.addEventListener('abort', () => reject(new Error('changed'))),
              )
            : dial(s, 2_000, signal),
      });
      try {
        const s = await createSink(db(), key, {
          name: 'Lab',
          type: 'syslog',
          syslog: { host: '127.0.0.1', port: 1, transport: 'tcp', windowSeconds: 0 },
        });
        const entry = await audit();
        // A refused port first: the destination has a last error.
        await streamer.round();
        expect((await getSink(db(), s.id))?.status.lastError).toMatch(/Nothing listens/);
        await updateSink(db(), key, s.id, { syslog: { host: '192.0.2.55', port: 10514 } });
        streamer.changed(s.id);
        const hanging = streamer.round();
        await new Promise((r) => setTimeout(r, 300));
        expect(rx.got()).toEqual([]);
        const at = Date.now();
        await updateSink(db(), key, s.id, { syslog: { host: '127.0.0.1', port: rx.port } });
        streamer.changed(s.id);
        await hanging;
        await streamer.round();
        await until(() => rx.got().some((m) => m.includes(entry.id)), 2_000);
        expect(Date.now() - at).toBeLessThan(2_000);
        const status = (await getSink(db(), s.id))?.status;
        expect(status?.nextTryAt).toBeUndefined();
        // The errors were the old addresses': none is left on a destination that sends.
        expect(status?.lastError).toBeUndefined();
        expect(status?.lastSuccessAt).toBeDefined();
      } finally {
        await streamer.stop();
        rx.close();
      }
    });

    describe('the API', () => {
      let app: FastifyInstance;
      let cookie: string;
      beforeAll(async () => {
        if (!config) return;
        await clear();
        app = buildApp({
          log,
          database,
          instance: 'test',
          masterKey: key,
          streamer: new Streamer({ db: db(), key, log, version: '1.2.0' }),
        });
        const reply = await app.inject({
          method: 'POST',
          url: '/api/v1/session',
          payload: { login: 'dana', password: 'correct horse battery staple' },
        });
        cookie =
          /afs_session=[^;]*/.exec([reply.headers['set-cookie']].flat().join(';'))?.[0] ?? '';
      });
      afterAll(async () => {
        await app?.close();
      });

      it('adds, lists, changes, tests and removes a destination, each audited, values never shown', async () => {
        const made = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/streams',
          headers: { cookie },
          payload: {
            name: 'Collector',
            type: 'otlp',
            otlp: {
              endpoint: 'http://127.0.0.1:1',
              headers: [{ name: 'Authorization', value: 'Bearer example-token-9' }],
            },
          },
        });
        expect(made.statusCode).toBe(201);
        expect(made.body).not.toContain('example-token-9');
        const id = made.json().id as string;
        const bad = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/streams',
          headers: { cookie },
          payload: { name: 'x', type: 'syslog', syslog: { host: 'a b' } },
        });
        expect(bad.statusCode).toBe(400);
        expect(bad.json()).toMatchObject({ field: 'syslog.host' });
        const list = await app.inject({ url: '/api/v1/admin/streams', headers: { cookie } });
        expect(list.json()).toHaveLength(1);
        expect(list.body).not.toContain('example-token-9');
        const changed = await app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/streams/${id}`,
          headers: { cookie },
          payload: { enabled: false },
        });
        expect(changed.json()).toMatchObject({ enabled: false });
        const tested = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/streams/${id}/test`,
          headers: { cookie },
        });
        expect(tested.json()).toMatchObject({ ok: false });
        expect(
          (
            await app.inject({
              method: 'DELETE',
              url: `/api/v1/admin/streams/${id}`,
              headers: { cookie },
            })
          ).statusCode,
        ).toBe(204);
        expect(
          (await app.inject({ url: `/api/v1/admin/streams/${id}`, headers: { cookie } }))
            .statusCode,
        ).toBe(404);
        const { entries } = await listAudit(db(), { action: 'stream' });
        expect(entries.map((e) => e.action).sort()).toEqual([
          'stream.change',
          'stream.create',
          'stream.create',
          'stream.delete',
          'stream.test',
        ]);
        expect(entries.find((e) => e.action === 'stream.change')?.object).toMatchObject({
          type: 'stream',
          id,
          name: 'Collector',
        });
        expect(JSON.stringify(entries)).not.toContain('example-token-9');
        expect((await app.inject({ url: '/api/v1/admin/streams' })).statusCode).toBe(401);
      });
    });
  });
}
