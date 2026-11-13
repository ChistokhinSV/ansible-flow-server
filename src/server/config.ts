// The server's settings, read from the environment (and from a .env file main.ts loads into it).
// Nothing is read from the repository, and a value that is wrong stops the start with every
// problem named at once.
import { isAbsolute, join, resolve } from 'node:path';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  /** The address to listen on. Default 127.0.0.1: reachable from this machine only. */
  host: string;
  port: number;
  /** Where the server keeps what it owns: the SQLite database, later repositories and runs. */
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

  const host = text('AFS_HOST') ?? '127.0.0.1';
  const portText = text('AFS_PORT') ?? '8080';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535)
    problems.push(`AFS_PORT is "${portText}": a port is a number from 1 to 65535`);

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
    dataDir,
    database,
    log: { level: level as LogLevel, format: format as 'text' | 'json' },
  };
}
