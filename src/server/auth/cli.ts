// The user commands, for whoever administers the machine the server runs on. They are the way
// back in when nobody can sign in: a lost password, the only administrator gone.
//   user list
//   user add <login> [--name <name>] [--email <address>] [--admin]
//   user password <login>
//   user enable <login> | user disable <login>
//   user admin <login> on|off
// A password is read from the terminal without showing it, or from the input when that is a
// pipe; it is never an argument, so it is in no shell history and no process list.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { passwordProblem } from './passwords';
import { accountByLogin, createUser, listUsers, setPassword, UserError, updateUser } from './users';

/** Reads a password: typed unseen at a terminal, or the first line of piped input. */
export function readPassword(
  prompt: string,
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
): Promise<string> {
  const terminal = input.isTTY === true;
  let hide = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!hide) process.stderr.write(chunk);
      done();
    },
  });
  const reader = createInterface({ input, output, terminal });
  return new Promise((resolve) => {
    if (terminal) {
      reader.question(prompt, (answer) => {
        process.stderr.write('\n');
        reader.close();
        resolve(answer);
      });
      hide = true;
    } else {
      reader.once('line', (line) => {
        // The answer first: closing the reader says "closed", which answers with nothing.
        resolve(line);
        reader.close();
      });
      reader.once('close', () => resolve(''));
    }
  });
}

/** Takes `--name value` out of the arguments. */
function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const [, value] = args.splice(at, 2);
  if (value === undefined) throw new UserError('invalid', `${name} needs a value`);
  return value;
}

function flag(args: string[], name: string): boolean {
  const at = args.indexOf(name);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

const USAGE =
  'Use: user list | add <login> [--name N] [--email E] [--admin] | password <login> | enable <login> | disable <login> | admin <login> on|off';

/** Runs a `user` command; resolves with the process's exit code. */
export async function userCommand(
  db: Kysely<Schema>,
  args: string[],
  print: (line: string) => void = console.log,
  ask: (prompt: string) => Promise<string> = readPassword,
): Promise<number> {
  const [command, ...rest] = args;
  const idOf = async (login: string | undefined) => {
    const account = login ? await accountByLogin(db, login) : undefined;
    if (!account) throw new UserError('not_found', `No user ${login ?? '(no login given)'}`);
    return account.id;
  };
  const newPassword = async (login: string) => {
    const password = await ask(`Password for ${login}: `);
    const problem = passwordProblem(password, login);
    if (problem) throw new UserError('invalid', problem);
    return password;
  };
  try {
    switch (command) {
      case 'list': {
        const users = await listUsers(db);
        if (users.length === 0) print('No users yet.');
        for (const u of users)
          print(
            [
              u.login.padEnd(24),
              (u.admin ? 'admin' : 'user').padEnd(6),
              (u.disabled ? 'disabled' : 'active').padEnd(9),
              u.name,
              u.groups.length ? `[${u.groups.join(', ')}]` : '',
            ]
              .join(' ')
              .trimEnd(),
          );
        return 0;
      }
      case 'add': {
        const name = option(rest, '--name');
        const email = option(rest, '--email');
        const admin = flag(rest, '--admin');
        const [login] = rest;
        if (!login) {
          print(USAGE);
          return 2;
        }
        const password = await newPassword(login);
        const user = await createUser(db, { login, name: name ?? '', email, password, admin });
        print(`Added ${user.login}${user.admin ? ' as an administrator' : ''}.`);
        return 0;
      }
      case 'password': {
        const id = await idOf(rest[0]);
        await setPassword(db, id, await newPassword(rest[0] as string));
        print(`The password of ${rest[0]} is set; their sessions are ended.`);
        return 0;
      }
      case 'enable':
      case 'disable': {
        const user = await updateUser(db, await idOf(rest[0]), { disabled: command === 'disable' });
        print(`${user.login} is ${user.disabled ? 'disabled and signed out' : 'enabled'}.`);
        return 0;
      }
      case 'admin': {
        if (rest[1] !== 'on' && rest[1] !== 'off') {
          print(USAGE);
          return 2;
        }
        const user = await updateUser(db, await idOf(rest[0]), { admin: rest[1] === 'on' });
        print(`${user.login} is ${user.admin ? 'an administrator' : 'not an administrator'}.`);
        return 0;
      }
      default:
        print(USAGE);
        return 2;
    }
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    print(e.message);
    return 1;
  }
}
