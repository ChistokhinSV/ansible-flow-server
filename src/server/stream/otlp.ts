// OpenTelemetry (AFS-244): audit entries as OTLP log records and each run as a trace, sent as
// OTLP/HTTP JSON by our own sender (ADR-0038: the SDK is 68 packages and keeps its own queue,
// where ours is the outbox). Flow inputs are never sent.
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { gzipSync } from 'node:zlib';
import type { RunSummary } from '@ansible-flow/core/run/events';
import type { AuditEntry } from '../audit/store';
import { auditLine, type RunFacts } from './syslog';

const hex = (text: string, chars: number) =>
  createHash('sha256').update(text).digest('hex').slice(0, chars);
/** The run's trace id: the same run sent twice is one trace. */
export const traceIdOf = (runId: string) => hex(`afs-run:${runId}`, 32);
/** A span id of the run: the root (`run`), `queue`, or a step's node id. */
export const spanIdOf = (runId: string, part = 'run') => hex(`afs-span:${runId}:${part}`, 16);

/** Milliseconds (fractions too) as unix nanoseconds, a string: OTLP JSON's int64. */
const nanos = (ms: number) => (BigInt(Math.round(ms * 1000)) * 1000n).toString();
const isoNanos = (iso: string) => nanos(Date.parse(iso));

type AnyValue =
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { stringValue: string };
export interface KeyValue {
  key: string;
  value: AnyValue;
}

function value(v: unknown): AnyValue {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number')
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}
export const attrs = (o: Record<string, unknown>): KeyValue[] =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([key, v]) => ({ key, value: value(v) }));

export interface ResourceOptions {
  version: string;
  hostname: string;
  environment?: string;
}

export const resourceOf = (o: ResourceOptions) => ({
  attributes: attrs({
    'service.name': 'ansible-flow-server',
    'service.version': o.version,
    'service.instance.id': o.hostname,
    'host.name': o.hostname,
    'deployment.environment.name': o.environment,
  }),
});

const SEVERITY: Record<string, [number, string]> = {
  ok: [9, 'INFO'],
  refused: [13, 'WARN'],
  failed: [17, 'ERROR'],
};

/** An audit entry as a log record; one about a run carries the run's trace and root span. */
export function auditRecord(e: AuditEntry, now = Date.now()) {
  const [severityNumber, severityText] = SEVERITY[e.result] ?? [9, 'INFO'];
  const run = e.object.type === 'run' ? e.object.id : undefined;
  return {
    timeUnixNano: isoNanos(e.at),
    observedTimeUnixNano: nanos(now),
    severityNumber,
    severityText,
    eventName: `afs.audit.${e.action}`,
    body: { stringValue: auditLine(e) },
    attributes: attrs({
      'afs.audit.id': e.id,
      'afs.audit.action': e.action,
      'afs.audit.result': e.result,
      'afs.audit.source': e.source,
      'user.id': e.actor?.id,
      'user.name': e.actor?.login,
      'afs.token.id': e.token,
      'afs.object.type': e.object.type,
      'afs.object.id': e.object.id,
      'afs.object.name': e.object.name,
      'http.response.status_code': e.status,
      'client.address': e.ip,
      'afs.request.id': e.request,
      'afs.audit.detail': e.detail ? JSON.stringify(e.detail) : undefined,
    }),
    ...(run ? { traceId: traceIdOf(run), spanId: spanIdOf(run) } : {}),
  };
}

/** A test record, from the Event streaming page. */
export function testRecord(by: string, now = Date.now()) {
  return {
    timeUnixNano: nanos(now),
    observedTimeUnixNano: nanos(now),
    severityNumber: 9,
    severityText: 'INFO',
    eventName: 'afs.test',
    body: { stringValue: `${by} sent this test from the Event streaming page` },
    attributes: attrs({ 'user.name': by }),
  };
}

export const logsPayload = (records: unknown[], resource: ReturnType<typeof resourceOf>) => ({
  resourceLogs: [
    {
      resource,
      scopeLogs: [
        { scope: { name: 'ansible-flow-server.audit', version: '1' }, logRecords: records },
      ],
    },
  ],
});

/** A step as the flow document names it. */
export interface StepName {
  key: string;
  kind: string;
  title?: string;
}

export interface RunTrace extends RunFacts {
  commit?: string;
  eeImage?: string | null;
  summary?: RunSummary;
}

export interface SpanOptions {
  hostNames: boolean;
  maxHostEvents: number;
}

const FAILED_PORTS = new Set(['failed', 'unreachable', 'rejected']);
const RESULT: Record<string, string> = {
  succeeded: 'success',
  failed: 'failure',
  cancelled: 'cancellation',
  lost: 'error',
};

/**
 * A run as spans: the root is the run, `queue` the wait for a worker, one span per step that has
 * timings. Host counts are attributes; per-host events are capped, the rest counted.
 */
export function runSpans(run: RunTrace, steps: Record<string, StepName>, o: SpanOptions) {
  const s = run.summary;
  const traceId = traceIdOf(run.id);
  const root = spanIdOf(run.id);
  const end = run.endedAt ?? new Date().toISOString();
  const failedHosts = Object.keys(s?.outcome ?? {});
  const unreachable = s?.unreachable ?? [];
  const total = s?.hosts.length ?? run.hosts ?? 0;
  const ok = s ? Math.max(0, total - failedHosts.length - unreachable.length) : undefined;
  const failed = s ? failedHosts.length : (run.failed ?? undefined);
  const spans: unknown[] = [];
  spans.push({
    traceId,
    spanId: root,
    name: `RUN ${run.flow.key}`,
    kind: 1,
    startTimeUnixNano: isoNanos(run.createdAt),
    endTimeUnixNano: isoNanos(end),
    attributes: attrs({
      // CI/CD semantic conventions (development), then our own.
      'cicd.pipeline.name': run.flow.name,
      'cicd.pipeline.run.id': run.id,
      'cicd.pipeline.action.name': 'RUN',
      'cicd.pipeline.result': RESULT[run.state] ?? run.state,
      'afs.run.number': run.number,
      'afs.run.mode': run.mode,
      'afs.run.state': run.state,
      'afs.project.id': run.project.id,
      'afs.project.name': run.project.name,
      'afs.flow.key': run.flow.key,
      'afs.flow.version': run.flow.version,
      'afs.flow.file': run.flow.file,
      'vcs.ref.head.revision': run.commit,
      'afs.ee.image': run.eeImage,
      'user.name': run.requestedLogin,
      'afs.hosts.total': total,
      'afs.hosts.ok': ok,
      'afs.hosts.failed': failed,
      'afs.hosts.unreachable': s ? unreachable.length : undefined,
      'afs.run.stopped_early': s?.stoppedEarly,
    }),
    events:
      o.hostNames && s
        ? Object.entries(s.outcome)
            .slice(0, o.maxHostEvents)
            .map(([host, reason]) => ({
              name: 'host.failed',
              timeUnixNano: isoNanos(end),
              attributes: attrs({ 'afs.host': host, 'afs.reason': reason }),
            }))
        : [],
    status:
      run.state === 'succeeded' && !failed
        ? { code: 1 }
        : {
            code: 2,
            message:
              run.state === 'succeeded' || total
                ? `${failed ?? 0} of ${total} hosts failed (${run.state})`
                : `The run ${run.state}${run.error ? `: ${run.error.slice(0, 200)}` : ''}`,
          },
  });
  if (run.startedAt)
    spans.push({
      traceId,
      spanId: spanIdOf(run.id, 'queue'),
      parentSpanId: root,
      name: 'queue',
      kind: 1,
      startTimeUnixNano: isoNanos(run.createdAt),
      endTimeUnixNano: isoNanos(run.startedAt),
      attributes: [],
      status: { code: 0 },
    });
  for (const [node, t] of Object.entries(s?.timings ?? {})) {
    const step = steps[node] ?? { key: node, kind: 'step' };
    const ports = s?.nodes[node] ?? {};
    const problems = s?.problems?.[node] ?? {};
    const counts: Record<string, number> = {};
    for (const [port, hosts] of Object.entries(ports))
      counts[`afs.step.port.${port}`] = hosts.length;
    const bad = Object.entries(ports)
      .filter(([port]) => FAILED_PORTS.has(port))
      .reduce((n, [, hosts]) => n + hosts.length, 0);
    const events: unknown[] = [];
    let left = o.hostNames ? o.maxHostEvents : 0;
    let omitted = 0;
    for (const [host, p] of Object.entries(problems)) {
      if (left-- <= 0) {
        omitted++;
        continue;
      }
      events.push({
        name: `host.${p.status}`,
        timeUnixNano: nanos(t.end * 1000),
        attributes: attrs({
          'afs.host': host,
          'afs.task': p.task,
          'afs.message': p.msg?.slice(0, 500),
        }),
      });
    }
    for (const [port, hosts] of Object.entries(ports))
      for (const host of hosts) {
        if (left-- <= 0) {
          omitted++;
          continue;
        }
        events.push({
          name: 'host.port',
          timeUnixNano: nanos(t.end * 1000),
          attributes: attrs({ 'afs.host': host, 'afs.port': port }),
        });
      }
    spans.push({
      traceId,
      spanId: spanIdOf(run.id, node),
      parentSpanId: root,
      name: `STEP ${step.key}`,
      kind: 1,
      startTimeUnixNano: nanos(t.start * 1000),
      endTimeUnixNano: nanos(t.end * 1000),
      attributes: attrs({
        'cicd.pipeline.task.name': step.key,
        'cicd.pipeline.task.run.id': `${run.id}/${node}`,
        'afs.step.id': node,
        'afs.step.kind': step.kind,
        'afs.step.title': step.title,
        'afs.step.waited_s': s?.waited?.[node],
        'afs.step.hosts_omitted': omitted || undefined,
        ...counts,
      }),
      events,
      status: bad ? { code: 2, message: `${bad} host(s) left by a failure port` } : { code: 0 },
    });
  }
  return spans;
}

export const tracesPayload = (spans: unknown[], resource: ReturnType<typeof resourceOf>) => ({
  resourceSpans: [
    {
      resource,
      scopeSpans: [{ scope: { name: 'ansible-flow-server.runs', version: '1' }, spans }],
    },
  ],
});

export interface Posted {
  ok: boolean;
  /** Worth trying again later (the collector is down or busy). */
  retry: boolean;
  status?: number;
  error?: string;
  /** What the collector refused of the payload (`partialSuccess`), in its words. */
  rejected?: string;
}

const RETRY_STATUS = new Set([408, 429, 502, 503, 504]);

export interface PostOptions {
  ca?: string;
  gzip?: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
  agent?: string;
}

/**
 * One POST of a payload to `<endpoint>/v1/logs` or `/v1/traces`; one try: the outbox tries again.
 * 2xx: sent; 408, 429, 502-504 and network errors: try again later; any other: not.
 */
export function post(
  endpoint: string,
  path: '/v1/logs' | '/v1/traces',
  payload: unknown,
  o: PostOptions = {},
): Promise<Posted> {
  const url = new URL(endpoint.replace(/\/+$/, '') + path);
  const json = JSON.stringify(payload);
  const body = o.gzip === false ? Buffer.from(json) : gzipSync(json);
  const timeoutMs = o.timeoutMs ?? 10_000;
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const request = client.request(
      url,
      {
        method: 'POST',
        headers: {
          ...o.headers,
          'content-type': 'application/json',
          'content-length': String(body.length),
          ...(o.gzip === false ? {} : { 'content-encoding': 'gzip' }),
          ...(o.agent ? { 'user-agent': o.agent } : {}),
        },
        ...(url.protocol === 'https:' && o.ca ? { ca: o.ca } : {}),
        timeout: timeoutMs,
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (c: string) => {
          if (text.length < 4096) text += c;
        });
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            let rejected: string | undefined;
            try {
              const partial = (text ? JSON.parse(text) : {}).partialSuccess;
              if (partial?.rejectedLogRecords || partial?.rejectedSpans)
                rejected = `${partial.rejectedLogRecords ?? partial.rejectedSpans} rejected: ${partial.errorMessage ?? ''}`;
            } catch {}
            resolve({ ok: true, retry: false, status, ...(rejected ? { rejected } : {}) });
            return;
          }
          resolve({
            ok: false,
            retry: RETRY_STATUS.has(status),
            status,
            error: `HTTP ${status}${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`,
          });
        });
        response.on('error', (e) => resolve({ ok: false, retry: true, error: e.message }));
      },
    );
    request.on('timeout', () =>
      request.destroy(new Error(`Timed out: no answer in ${Math.round(timeoutMs / 1000)} s`)),
    );
    request.on('error', (e: NodeJS.ErrnoException) => {
      const certificate = /CERT|SELF_SIGNED|UNABLE_TO_(VERIFY|GET_ISSUER)/.test(e.code ?? '');
      resolve({
        ok: false,
        // A certificate is wrong until someone changes it; the rows stay and are tried later anyway.
        retry: true,
        error: certificate ? `Its certificate is not trusted (${e.code})` : (e.code ?? e.message),
      });
    });
    request.end(body);
  });
}
