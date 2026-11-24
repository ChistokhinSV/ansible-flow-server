// Event streaming (AFS-53) as seen from outside the server: the pages import these, so this file
// imports nothing of the server. A destination ("sink") is a syslog receiver or an OpenTelemetry
// collector; audit entries and the start and end of runs go to it through an outbox.

export const SINK_TYPES = ['syslog', 'otlp'] as const;
export type SinkType = (typeof SINK_TYPES)[number];

/** tls: RFC 5425 (port 6514); tcp: plain, octet counting; udp: RFC 5426, lossy (labs only). */
export const SYSLOG_TRANSPORTS = ['tls', 'tcp', 'udp'] as const;
export type SyslogTransport = (typeof SYSLOG_TRANSPORTS)[number];

/** The documentation enterprise number (RFC 5612), until the product has one of its own. */
export const DEFAULT_ENTERPRISE = 32473;
/** log audit. */
export const DEFAULT_FACILITY = 13;
export const DEFAULT_MAX_BACKLOG = 100_000;
export const DEFAULT_MAX_AGE_DAYS = 7;

export interface SyslogSettings {
  host: string;
  port: number;
  transport: SyslogTransport;
  /** Authorities the receiver's certificate is checked against (PEM); absent: the server's own. */
  ca?: string;
  /** Facility 0 to 23; 13 is "log audit". */
  facility: number;
  /** The private enterprise number in the SD-IDs (`audit@32473`). */
  enterprise: number;
  /** A UTF-8 byte order mark before the message (RFC 5424); some viewers show it. */
  bom: boolean;
  /** HOSTNAME in each message; absent: the server's host name. */
  hostname?: string;
  /** octet: RFC 5425 octet counting; lf: one message per line, for old TCP receivers. */
  framing: 'octet' | 'lf';
  /** Seconds the connection must stay up after a write before those messages count as sent. */
  windowSeconds: number;
}

export interface OtlpSettings {
  /** The collector's address: `/v1/logs` and `/v1/traces` are added to it. */
  endpoint: string;
  ca?: string;
  gzip: boolean;
  timeoutSeconds: number;
  /** `deployment.environment.name` on everything sent. */
  environment?: string;
  /** Host names in the per-host events of a trace; off: counts only. */
  hostNames: boolean;
  /** Per-host events per span at most; the rest are counted. */
  maxHostEvents: number;
}

export interface SinkStatus {
  /** Rows waiting to go (pending, and written but not yet counted sent). */
  backlog: number;
  /** When the oldest of them was made. */
  oldestAt?: string;
  /** Rows dropped because the backlog was over its bounds, since the destination was made. */
  dropped: number;
  lastSuccessAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  /** Failing since then: nothing sent since. */
  failingSince?: string;
  /** Failing: tried again then, with all that waits (a change or a test that reached it: now). */
  nextTryAt?: string;
}

export interface Sink {
  id: string;
  name: string;
  type: SinkType;
  enabled: boolean;
  /** Audit entries: syslog messages, or OTLP log records. */
  audit: boolean;
  /** Runs: syslog lines at their start and end, or an OTLP trace when they end. */
  runs: boolean;
  syslog?: SyslogSettings;
  /** The headers' names only: their values are sealed and never shown. */
  otlp?: OtlpSettings & { headers: string[] };
  maxBacklog: number;
  maxAgeDays: number;
  status: SinkStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SinkInput {
  name: string;
  type: SinkType;
  enabled?: boolean;
  audit?: boolean;
  runs?: boolean;
  syslog?: Partial<SyslogSettings> & { host: string };
  /**
   * `headers`: the headers sent, in full; one without a value keeps the value it has (shown as
   * kept), one left out goes.
   */
  otlp?: Partial<OtlpSettings> & { endpoint: string; headers?: { name: string; value?: string }[] };
  maxBacklog?: number;
  maxAgeDays?: number;
}

/** How a test message went. */
export interface SinkTest {
  ok: boolean;
  message: string;
}
