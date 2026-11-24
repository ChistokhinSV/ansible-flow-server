// Syslog (AFS-243): audit entries and the start and end of runs as RFC 5424 messages, sent over
// TLS (RFC 5425, octet counting), TCP or UDP (RFC 5426). Our own sender, no package (ADR-0038).
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import type { AuditEntry } from '../audit/store';
import type { SyslogSettings } from './types';

const BOM = '﻿';
const APP = 'ansible-flow-server';
/** RFC 5425: receivers must take 2048 octets and should take 8192. */
export const MAX_BYTES = 8192;

// Severities: 3 error, 4 warning, 5 notice, 6 informational.
const AUDIT_SEVERITY: Record<string, number> = { ok: 6, refused: 4, failed: 3 };
const RUN_SEVERITY: Record<string, number> = {
  succeeded: 6,
  failed: 3,
  lost: 3,
  cancelled: 5,
};

/** SD-NAME: printable US-ASCII without space, `=`, `]` and `"`, at most 32 (RFC 5424 6.3.2). */
export function sdName(name: string): string {
  return name.replace(/[^\x21-\x7e]|[= \]"]/g, '_').slice(0, 32) || '_';
}

/** PARAM-VALUE: UTF-8 with `"`, `\` and `]` escaped by a backslash (RFC 5424 6.3.3). */
export function sdValue(value: unknown): string {
  return String(value).replace(/[\\"\]]/g, (c) => `\\${c}`);
}

/** HOSTNAME, APP-NAME, PROCID and MSGID: printable US-ASCII, `-` when empty. */
const headerField = (text: unknown, max: number) =>
  String(text ?? '')
    .replace(/[^\x21-\x7e]/g, '_')
    .slice(0, max) || '-';

/** An SD element; lowercase names, since receivers such as rsyslog lowercase them anyway. */
function element(id: string, params: Record<string, unknown>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${sdName(k.toLowerCase())}="${sdValue(v)}"`);
  return parts.length ? `[${id} ${parts.join(' ')}]` : '';
}

export interface SyslogFormat {
  facility: number;
  enterprise: number;
  bom: boolean;
  hostname: string;
  version: string;
  procid?: number | string;
  maxBytes?: number;
}

export const formatOf = (
  s: Pick<SyslogSettings, 'facility' | 'enterprise' | 'bom'> & { hostname?: string },
  server: { hostname: string; version: string },
): SyslogFormat => ({
  facility: s.facility,
  enterprise: s.enterprise,
  bom: s.bom,
  hostname: s.hostname || server.hostname,
  version: server.version,
});

/** "alice run.launch run r-42 "Deploy web tier": ok (201)": one line a person reads. */
export function auditLine(e: AuditEntry): string {
  const login = e.detail?.login;
  const who = e.actor?.login ?? (typeof login === 'string' ? `(${login})` : '(nobody)');
  const what = [e.object.type, e.object.id, e.object.name ? `"${e.object.name}"` : '']
    .filter(Boolean)
    .join(' ');
  return `${who} ${e.action} ${what}: ${e.result}${e.status ? ` (${e.status})` : ''}`;
}

function message(
  f: SyslogFormat,
  severity: number,
  at: string,
  msgid: string,
  sd: string[],
  text: string,
): string {
  const pri = f.facility * 8 + severity;
  const origin = element('origin', { software: APP, swversion: f.version });
  const head = [
    `<${pri}>1`,
    at,
    headerField(f.hostname, 255),
    APP,
    headerField(f.procid ?? process.pid, 128),
    headerField(msgid, 32),
  ].join(' ');
  const data = [origin, ...sd].join('') || '-';
  return `${head} ${data} ${f.bom ? BOM : ''}${text.replace(/[\r\n]+/g, ' ')}`;
}

/**
 * An audit entry: MSGID is its action; SD elements `audit`, `actor`, `object` and `detail` (the
 * detail as one JSON value: the audit log never holds a secret value, ADR-0018).
 */
export function formatAudit(e: AuditEntry, f: SyslogFormat): string {
  const pen = f.enterprise;
  const sd = [
    element(`audit@${pen}`, {
      id: e.id,
      source: e.source,
      result: e.result,
      status: e.status,
      ip: e.ip,
      request: e.request,
    }),
    element(`actor@${pen}`, { id: e.actor?.id, login: e.actor?.login, token: e.token }),
    element(`object@${pen}`, { type: e.object.type, id: e.object.id, name: e.object.name }),
  ];
  const detail = e.detail ? JSON.stringify(e.detail) : '';
  const severity = AUDIT_SEVERITY[e.result] ?? 5;
  const line = auditLine(e);
  const whole = message(f, severity, e.at, e.action, [...sd, detailElement(pen, detail)], line);
  // A detail too long for one message is cut first: the rest of the entry is worth more.
  const max = f.maxBytes ?? MAX_BYTES;
  if (!detail || Buffer.byteLength(whole) <= max) return whole;
  let keep = Buffer.byteLength(detail);
  let shorter = whole;
  for (let i = 0; i < 8 && keep > 0; i++) {
    // Escaping makes the cut detail longer than its text: cut by what is over, and look again.
    keep -= Buffer.byteLength(shorter) - max + 32;
    const short = `${cutText(detail, Math.max(0, keep))}…`;
    shorter = message(f, severity, e.at, e.action, [...sd, detailElement(pen, short, true)], line);
    if (Buffer.byteLength(shorter) <= max) return shorter;
  }
  return cut(message(f, severity, e.at, e.action, sd, line), max);
}

const detailElement = (pen: number, json: string, cutShort = false) =>
  json ? element(`detail@${pen}`, { json, ...(cutShort ? { cut: 'true' } : {}) }) : '';

/** What a run line says: the facts of the run row (never its inputs). */
export interface RunFacts {
  id: string;
  number: number;
  project: { id: string; name: string };
  flow: { key: string; name: string; version: number; file: string };
  mode: string;
  state: string;
  requestedLogin: string;
  createdAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
  hosts?: number | null;
  failed?: number | null;
  error?: string | null;
}

/** A run's start or end: MSGID `run.started` or `run.ended`, an SD element `run`. */
export function formatRun(run: RunFacts, phase: 'start' | 'end', f: SyslogFormat): string {
  const ended = phase === 'end';
  const at = (ended ? run.endedAt : run.startedAt) ?? run.createdAt;
  const seconds =
    ended && run.startedAt && run.endedAt
      ? Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 100) / 10
      : undefined;
  const sd = element(`run@${f.enterprise}`, {
    id: run.id,
    number: run.number,
    project: run.project.name,
    projectid: run.project.id,
    flow: run.flow.key,
    file: run.flow.file,
    version: run.flow.version,
    mode: run.mode,
    state: ended ? run.state : 'running',
    by: run.requestedLogin,
    ...(ended ? { hosts: run.hosts, failed: run.failed, duration_s: seconds } : {}),
  });
  const name = `run ${run.number} "${run.flow.name}"`;
  const text = ended
    ? `${name} ${run.state}${run.hosts ? `: ${run.failed ?? 0} of ${run.hosts} hosts failed` : ''}`
    : `${name} started (${run.mode}) by ${run.requestedLogin}`;
  const severity = ended ? (RUN_SEVERITY[run.state] ?? 5) : 6;
  return cut(message(f, severity, at, ended ? 'run.ended' : 'run.started', [sd], text), f.maxBytes);
}

/** A test message, from the Event streaming page. */
export function formatTest(by: string, f: SyslogFormat, at = new Date().toISOString()): string {
  return cut(
    message(
      f,
      6,
      at,
      'afs.test',
      [element(`audit@${f.enterprise}`, { source: 'ui', result: 'ok' })],
      `${by} sent this test from the Event streaming page`,
    ),
    f.maxBytes,
  );
}

/** Cut at a UTF-8 boundary to at most `max` bytes. */
function cutText(text: string, max: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) return text;
  let end = max;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
const cut = (text: string, max = MAX_BYTES) => cutText(text, max);

/** One message on a stream: `<length> <message>` (RFC 5425), or the message and a line feed. */
export function frame(text: string, framing: 'octet' | 'lf' = 'octet'): Buffer {
  const body = Buffer.from(text, 'utf8');
  return framing === 'lf'
    ? Buffer.concat([body, Buffer.from('\n')])
    : Buffer.concat([Buffer.from(`${body.length} `), body]);
}

/** What a stream connection needs of a socket (a test gives its own). */
export interface Wire {
  write(chunk: Buffer): boolean;
  readonly writableLength: number;
  readonly destroyed: boolean;
  once(event: 'drain' | 'close', listener: () => void): unknown;
  on(event: 'close' | 'error' | 'end' | 'data', listener: (arg?: unknown) => void): unknown;
  off(event: 'drain' | 'close', listener: () => void): unknown;
  destroy(): void;
  end(): void;
}

/** Opens a TCP or TLS connection to a receiver; rejects when it does not answer in time. */
export function dial(s: SyslogSettings, timeoutMs = 10_000, signal?: AbortSignal): Promise<Wire> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('the destination was changed'));
      return;
    }
    const socket =
      s.transport === 'tls'
        ? tls.connect({
            host: s.host,
            port: s.port,
            ...(s.ca ? { ca: s.ca } : {}),
            ...(net.isIP(s.host) ? {} : { servername: s.host }),
            minVersion: 'TLSv1.2',
          })
        : net.connect({ host: s.host, port: s.port });
    // AFS-262: a destination changed while it waits for an address that does not answer gives
    // up now, not when the 10 s run out.
    const abort = () => fail(new Error('the destination was changed'));
    const fail = (e: Error) => {
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      reject(e);
    };
    signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(timeoutMs, () => fail(new Error('connect timeout')));
    socket.once('error', fail);
    socket.once(s.transport === 'tls' ? 'secureConnect' : 'connect', () => {
      signal?.removeEventListener('abort', abort);
      socket.setTimeout(0);
      socket.off('error', fail);
      socket.setKeepAlive(true, 10_000);
      resolve(socket);
    });
  });
}

/** Resolves when the wire takes more; rejects when it closes first. */
function drained(wire: Wire): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      wire.off('close', onClose);
      resolve();
    };
    const onClose = () => {
      wire.off('drain', onDrain);
      reject(new Error('the connection was closed'));
    };
    wire.once('drain', onDrain);
    wire.once('close', onClose);
  });
}

/**
 * One connection to a receiver, opened when a message is written and again after it was lost.
 * Two fixes of the spike are here, each with its test:
 *  - one socket at a time: whoever asks while one is being opened waits for that one (the spike's
 *    reconnect timer and its pump each opened a socket);
 *  - a write that the socket refuses (its buffer is full) waits for `drain` before the next one
 *    (the spike wrote on and piled 60,000 messages into Node's buffer).
 */
export class SyslogLink {
  private wire: Wire | undefined;
  private opening: Promise<Wire> | undefined;
  /** Counts the sockets opened: messages written on one are sent only while it stays up. */
  generation = 0;
  /** When the current socket was opened, in ms. */
  upSince = 0;
  /** Told when the socket of a generation closes. */
  onLost?: (generation: number, error?: string) => void;
  private lastError: string | undefined;
  private closed = false;
  /** Aborts a connection being opened when the link is closed. */
  private readonly aborting = new AbortController();

  constructor(private readonly open: (signal: AbortSignal) => Promise<Wire>) {}

  /** The socket, opened when there is none. */
  connect(): Promise<Wire> {
    if (this.closed) return Promise.reject(new Error('closed'));
    if (this.wire && !this.wire.destroyed) return Promise.resolve(this.wire);
    if (!this.opening)
      this.opening = this.open(this.aborting.signal)
        .then((wire) => {
          const generation = ++this.generation;
          this.wire = wire;
          this.upSince = Date.now();
          this.lastError = undefined;
          wire.on('error', (e) => {
            this.lastError = (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message;
          });
          // A receiver says nothing back: data or its end means it is going away.
          wire.on('end', () => wire.destroy());
          wire.on('close', () => {
            if (this.wire === wire) this.wire = undefined;
            this.onLost?.(generation, this.lastError);
          });
          if (this.closed) wire.destroy();
          return wire;
        })
        .finally(() => {
          this.opening = undefined;
        });
    return this.opening;
  }

  /** Whether the socket of `generation` is still up, and has nothing left in its buffer. */
  settled(generation: number): boolean {
    return (
      !!this.wire &&
      !this.wire.destroyed &&
      this.generation === generation &&
      this.wire.writableLength === 0
    );
  }

  /** Writes the frames in order; resolves with the generation of the socket they went on. */
  async write(frames: Buffer[]): Promise<number> {
    const wire = await this.connect();
    const generation = this.generation;
    for (const f of frames) {
      if (wire.destroyed) throw new Error('the connection was closed');
      if (!wire.write(f)) await drained(wire);
    }
    return generation;
  }

  close(): void {
    this.closed = true;
    this.aborting.abort();
    const wire = this.wire;
    this.wire = undefined;
    wire?.end();
    wire?.destroy();
  }
}

/** UDP: one datagram per message; nothing says whether it arrived. */
export async function sendUdp(s: SyslogSettings, messages: string[]): Promise<void> {
  const socket = dgram.createSocket(net.isIPv6(s.host) ? 'udp6' : 'udp4');
  try {
    for (const m of messages)
      await new Promise<void>((resolve, reject) =>
        socket.send(Buffer.from(m, 'utf8'), s.port, s.host, (e) => (e ? reject(e) : resolve())),
      );
  } finally {
    socket.close();
  }
}
