// The server's log. One line per event, to the standard output:
//   text   [09:44:37 13.11.2026] INFO  Listening host=127.0.0.1 port=8080
//   json   {"time":"2026-11-13T08:44:37.512Z","level":"info","msg":"Listening","host":"127.0.0.1","port":8080}
// Values whose names look secret are never written. The shape is the one Fastify asks of a logger
// (Pino's: a level, the level methods, child), so the HTTP server logs through it too.
import type { LogLevel } from './config';

const ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

/** Names of values that are never logged, whatever they hold. */
const SECRET = /pass(word|phrase)?|secret|token|authorization|cookie|api[-_]?key|private[-_]?key/i;
export const HIDDEN = '***';

type Fields = Record<string, unknown>;
type LogFn = (first?: unknown, ...rest: unknown[]) => void;

export interface Logger {
  level: string;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  silent: LogFn;
  child(bindings: Fields): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  format: 'text' | 'json';
  /** Where a line goes (default: the standard output). */
  write?: (line: string) => void;
  /** The time of a line (default: now). */
  now?: () => Date;
}

const two = (n: number) => String(n).padStart(2, '0');

/** `[HH:MM:SS dd.mm.yyyy]`, in the server's local time. */
export function stampOf(d: Date): string {
  return `[${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()}]`;
}

/**
 * What is written of a value. Fastify hands the logger whole requests, replies and errors: a
 * request is its method and address, a reply its status, an error its message (never its
 * headers or body).
 */
function plain(key: string, value: unknown, depth = 0): unknown {
  if (SECRET.test(key)) return HIDDEN;
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return { message: value.message, ...(code ? { code } : {}) };
  }
  if (typeof value === 'bigint') return value.toString();
  // An access token is recognised by its shape, whatever the field around it is called.
  if (typeof value === 'string' && /afs_[A-Za-z0-9_-]{43}/.test(value))
    return value.replace(/afs_[A-Za-z0-9_-]{43}/g, HIDDEN);
  if (typeof value !== 'object') return value;
  const o = value as Record<string, unknown>;
  if (key === 'req' && typeof o.method === 'string')
    return { method: o.method, url: String(o.url ?? '').split('?')[0], from: o.ip };
  if (key === 'res' && typeof o.statusCode === 'number') return { status: o.statusCode };
  if (depth >= 3) return '[...]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => plain(key, v, depth + 1));
  const out: Fields = {};
  for (const [k, v] of Object.entries(o)) out[k] = plain(k, v, depth + 1);
  return out;
}

/** `key=value` for a text line; a nested object as `key.inner=value`. */
function pairs(fields: Fields, prefix = ''): string[] {
  return Object.entries(fields).flatMap(([k, v]) => {
    if (v === undefined) return [];
    if (v && typeof v === 'object' && !Array.isArray(v))
      return pairs(v as Fields, `${prefix}${k}.`);
    const text =
      typeof v === 'string'
        ? v
        : typeof v === 'number' && !Number.isInteger(v)
          ? String(Math.round(v * 1000) / 1000)
          : JSON.stringify(v);
    return [`${prefix}${k}=${/[\s"=]/.test(text) || text === '' ? JSON.stringify(text) : text}`];
  });
}

export function createLogger(options: LoggerOptions, bindings: Fields = {}): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const logger: Logger = {
    level: options.level,
    child: (more) => createLogger(options, { ...bindings, ...more }),
    silent: () => undefined,
  } as Logger;
  const at = (level: Exclude<LogLevel, 'silent'>): LogFn => {
    return (first, ...rest) => {
      if (ORDER[level] < ORDER[logger.level as LogLevel]) return;
      // Pino's call shapes: (message), (fields, message) or (error, message).
      let fields: Fields = {};
      let message = '';
      if (typeof first === 'string') message = first;
      else if (first instanceof Error) {
        fields = { err: first };
        message = typeof rest[0] === 'string' ? rest[0] : first.message;
      } else if (first && typeof first === 'object') {
        fields = first as Fields;
        message = typeof rest[0] === 'string' ? rest[0] : '';
      }
      const all = plain('', { ...bindings, ...fields }) as Fields;
      const time = now();
      if (options.format === 'json') {
        write(JSON.stringify({ time: time.toISOString(), level, msg: message, ...all }));
      } else {
        const tail = pairs(all).join(' ');
        write(
          `${stampOf(time)} ${level.toUpperCase().padEnd(5)} ${message}${tail && message ? ' ' : ''}${tail}`,
        );
      }
    };
  };
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const)
    logger[level] = at(level);
  return logger;
}
