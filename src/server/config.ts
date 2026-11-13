// The server's settings, read from the environment (and from a .env file main.ts loads into it).
// Nothing is read from the repository, and a value that is wrong stops the start with every
// problem named at once.
import { isAbsolute, join, resolve } from 'node:path';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  /** The address to listen on. Default 127.0.0.1: reachable from this machine only. */
  host: string;
  /** Default 8443 with HTTPS, 8080 without. */
  port: number;
  /**
   * HTTPS by the server itself (`on`, the default), or plain HTTP behind a proxy that does it
   * (`off`).
   */
  tls: 'on' | 'off';
  /** With HTTPS: a port that answers plain HTTP with a redirect to HTTPS. Unset: none. */
  httpPort?: number;
  /** The address people use for the server (`https://flows.example.net`). */
  publicUrl?: string;
  /**
   * Without HTTPS: the proxies whose word is taken for who asked and over what (addresses or
   * networks). Empty: nobody's.
   */
  trustedProxies: string[];
  /** A file of certificate authorities the server also trusts when it connects out. */
  caFile?: string;
  /** The master key as text (AFS_MASTER_KEY), or the file it is in (AFS_MASTER_KEY_FILE). */
  masterKey?: string;
  masterKeyFile?: string;
  /** The container engine runs use (`auto`: docker, else podman; `off`: none). */
  containerEngine: 'auto' | 'docker' | 'podman' | 'off';
  /** The execution environment image a run uses unless its launch names one. */
  eeImage: string;
  /** A run that takes longer is stopped, in minutes. */
  runTimeoutMinutes: number;
  /** Ended runs older than this many days are removed, and beyond this many of one flow. */
  runsKeepDays: number;
  runsKeepPerFlow: number;
  /** Runs at once on this server, and of one project. */
  maxRuns: number;
  maxRunsPerProject: number;
  /** A project's repository may be a folder of this machine. Default: no. */
  gitLocal: boolean;
  /** Where the server keeps what it owns: the SQLite database, its certificate, the mirrors. */
  dataDir: string;
  database: { kind: 'sqlite'; file: string } | { kind: 'postgres'; url: string };
  log: { level: LogLevel; format: 'text' | 'json' };
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`The settings are not usable:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** A database address for a log line or a message: without its password. */
export function withoutPassword(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return 'an address that is not a URL';
  }
}

/** The settings from `env` (default: the process's environment); throws ConfigError. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const problems: string[] = [];
  const text = (name: string) => env[name]?.trim() || undefined;
  const portOf = (name: string, value: string): number => {
    const port = Number(value);
    if (!/^\d+$/.test(value) || port < 1 || port > 65535)
      problems.push(`${name} is "${value}": a port is a number from 1 to 65535`);
    return port;
  };

  const tlsText = (text('AFS_TLS') ?? 'on').toLowerCase();
  if (tlsText !== 'on' && tlsText !== 'off')
    problems.push(`AFS_TLS is "${tlsText}": use on, or off behind a proxy that does HTTPS`);
  const tls = tlsText === 'off' ? 'off' : 'on';

  const host = text('AFS_HOST') ?? '127.0.0.1';
  const port = portOf('AFS_PORT', text('AFS_PORT') ?? (tls === 'on' ? '8443' : '8080'));
  const httpText = text('AFS_HTTP_PORT');
  let httpPort: number | undefined;
  if (httpText) {
    if (tls === 'off')
      problems.push('AFS_HTTP_PORT is for the redirect to HTTPS: it has no use with AFS_TLS=off');
    else {
      httpPort = portOf('AFS_HTTP_PORT', httpText);
      if (httpPort === port) problems.push('AFS_HTTP_PORT and AFS_PORT are the same port');
    }
  }

  let publicUrl: string | undefined;
  const publicText = text('AFS_PUBLIC_URL');
  if (publicText) {
    try {
      const u = new URL(publicText);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
      if (u.username || u.password || u.search || u.hash) throw new Error('parts');
      if (tls === 'on' && u.protocol !== 'https:')
        problems.push('AFS_PUBLIC_URL starts with http:// but the server speaks HTTPS');
      publicUrl = u.toString().replace(/\/$/, '');
    } catch {
      problems.push(
        `AFS_PUBLIC_URL is "${publicText}": use the address people open, like https://flows.example.net`,
      );
    }
  }

  const trustedProxies = (text('AFS_TRUSTED_PROXIES') ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (trustedProxies.length && tls === 'on')
    problems.push('AFS_TRUSTED_PROXIES is for a server behind a proxy: set AFS_TLS=off with it');
  for (const proxy of trustedProxies)
    if (!/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(proxy))
      problems.push(`AFS_TRUSTED_PROXIES has "${proxy}": use addresses or networks (10.0.0.0/8)`);

  const countOf = (name: string, fallback: number): number => {
    const value = text(name);
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!/^\d+$/.test(value) || n < 1 || n > 256) {
      problems.push(`${name} is "${value}": a number from 1 to 256`);
      return fallback;
    }
    return n;
  };
  const engineText = (text('AFS_CONTAINER_ENGINE') ?? 'auto').toLowerCase();
  if (!['auto', 'docker', 'podman', 'off'].includes(engineText))
    problems.push(`AFS_CONTAINER_ENGINE is "${engineText}": use auto, docker, podman or off`);
  const eeImage = text('AFS_EE_IMAGE') ?? 'ghcr.io/ansible/community-ansible-dev-tools:latest';
  if (!/^[A-Za-z0-9][\w.\-/:@]{0,299}$/.test(eeImage))
    problems.push(`AFS_EE_IMAGE is "${eeImage}": not the name of a container image`);
  const timeoutText = text('AFS_RUN_TIMEOUT_MINUTES') ?? '240';
  const runTimeoutMinutes = Number(timeoutText);
  if (!/^\d+$/.test(timeoutText) || runTimeoutMinutes < 1 || runTimeoutMinutes > 10_080)
    problems.push(`AFS_RUN_TIMEOUT_MINUTES is "${timeoutText}": minutes, from 1 to 10080 (a week)`);
  const keepOf = (name: string, fallback: number, max: number): number => {
    const value = text(name);
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!/^\d+$/.test(value) || n < 1 || n > max) {
      problems.push(`${name} is "${value}": a number from 1 to ${max}`);
      return fallback;
    }
    return n;
  };
  const runsKeepDays = keepOf('AFS_RUNS_KEEP_DAYS', 90, 3650);
  const runsKeepPerFlow = keepOf('AFS_RUNS_KEEP_PER_FLOW', 200, 100_000);
  const maxRuns = countOf('AFS_MAX_RUNS', 4);
  const maxRunsPerProject = countOf('AFS_MAX_RUNS_PER_PROJECT', 1);
  const caFile = text('AFS_CA_FILE');
  const masterKey = text('AFS_MASTER_KEY');
  const masterKeyFile = text('AFS_MASTER_KEY_FILE');
  if (masterKey && masterKeyFile)
    problems.push('AFS_MASTER_KEY and AFS_MASTER_KEY_FILE are both set: use one');
  const localText = (text('AFS_GIT_LOCAL') ?? 'off').toLowerCase();
  if (localText !== 'on' && localText !== 'off')
    problems.push(`AFS_GIT_LOCAL is "${localText}": use on or off`);
  const dataDir = resolve(text('AFS_DATA_DIR') ?? 'data');

  let database: Config['database'] = { kind: 'sqlite', file: join(dataDir, 'afs.db') };
  const url = text('AFS_DATABASE_URL');
  if (url) {
    if (/^postgres(ql)?:\/\//i.test(url)) {
      try {
        new URL(url);
        database = { kind: 'postgres', url };
      } catch {
        problems.push('AFS_DATABASE_URL starts as a PostgreSQL address but is not a URL');
      }
    } else if (/^sqlite:/i.test(url)) {
      const file = url.replace(/^sqlite:(\/\/)?/i, '');
      if (!file) problems.push('AFS_DATABASE_URL is "sqlite:" with no file after it');
      else database = { kind: 'sqlite', file: isAbsolute(file) ? file : resolve(dataDir, file) };
    } else {
      problems.push(
        `AFS_DATABASE_URL is ${withoutPassword(url)}: use sqlite:<file> or postgres://user@host/database`,
      );
    }
  }

  const level = (text('AFS_LOG_LEVEL') ?? 'info').toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(level))
    problems.push(`AFS_LOG_LEVEL is "${level}": use one of ${LOG_LEVELS.join(', ')}`);
  const format = (text('AFS_LOG_FORMAT') ?? 'text').toLowerCase();
  if (format !== 'text' && format !== 'json')
    problems.push(`AFS_LOG_FORMAT is "${format}": use text or json`);

  if (problems.length) throw new ConfigError(problems);
  return {
    host,
    port,
    tls,
    ...(httpPort ? { httpPort } : {}),
    ...(publicUrl ? { publicUrl } : {}),
    trustedProxies,
    ...(caFile ? { caFile: resolve(caFile) } : {}),
    ...(masterKey ? { masterKey } : {}),
    ...(masterKeyFile ? { masterKeyFile: resolve(masterKeyFile) } : {}),
    containerEngine: engineText as Config['containerEngine'],
    eeImage,
    runTimeoutMinutes,
    runsKeepDays,
    runsKeepPerFlow,
    maxRuns,
    maxRunsPerProject,
    gitLocal: localText === 'on',
    dataDir,
    database,
    log: { level: level as LogLevel, format: format as 'text' | 'json' },
  };
}

/** The host people use for the server, when the settings say (the public address's host). */
export function publicHost(config: Config): string | undefined {
  return config.publicUrl ? new URL(config.publicUrl).hostname.replace(/^\[|\]$/g, '') : undefined;
}
