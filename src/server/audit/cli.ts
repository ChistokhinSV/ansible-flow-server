// The server's commands change things too (a user, a token, the certificate, the master key):
// what they did goes into the same audit log, as done on the server's machine. The arguments are
// kept as given: these commands ask for passwords at a prompt and take keys as file names.
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { type AuditEntry, recordAudit } from './store';

/** What each changing command is, as the audit log names it. */
const COMMANDS: Record<string, Record<string, string>> = {
  user: {
    add: 'user.create',
    password: 'user.password-set',
    enable: 'user.change',
    disable: 'user.change',
    admin: 'user.change',
    token: 'token.create',
  },
  cert: {
    request: 'certificate.request',
    install: 'certificate.install',
    'self-signed': 'certificate.self-signed',
    rollback: 'certificate.rollback',
  },
  secrets: { rotate: 'master-key.rotate' },
};

/** Options that take a value. */
const VALUED = new Set(['--name', '--email', '--days', '--org', '--out', '--key']);

/** The first argument that is neither an option nor an option's value. */
function firstWord(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (VALUED.has(arg)) i++;
    else if (!arg.startsWith('--')) return arg;
  }
  return undefined;
}

const optionValue = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

/** Whether a command changes something, and so is recorded. */
export const changes = (command: string, args: string[]): boolean =>
  !!COMMANDS[command]?.[args[0] ?? ''];

/**
 * Records a command that ran to its end (exit code 0) or failed at its work (1); a command that
 * was not understood (2) did nothing.
 */
export async function auditCommand(
  db: Kysely<Schema>,
  command: string,
  args: string[],
  code: number,
  osUser: string,
): Promise<AuditEntry | undefined> {
  const [sub = '', ...rest] = args;
  const action = COMMANDS[command]?.[sub];
  if (!action || (code !== 0 && code !== 1)) return undefined;
  const type = action.slice(0, action.indexOf('.'));
  // A user command names the user first; the token one makes a token of that user.
  const login = command === 'user' ? firstWord(rest) : undefined;
  return recordAudit(db, {
    actor: null,
    source: 'cli',
    action,
    object: {
      type,
      ...(login && type === 'user' ? { name: login } : {}),
      ...(type === 'token' ? { name: optionValue(rest, '--name') ?? 'made on the server' } : {}),
    },
    result: code === 0 ? 'ok' : 'failed',
    detail: {
      command: [command, ...args].join(' '),
      osUser,
      ...(login && type === 'token' ? { user: login } : {}),
    },
  });
}
