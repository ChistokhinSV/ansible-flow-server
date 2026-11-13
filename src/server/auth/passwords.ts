// Passwords: what one must be, how it is kept, how it is checked. A password is kept only as an
// argon2id hash with its own salt, in the usual `$argon2id$…` form, so the cost can be raised
// later and old hashes still check.
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(argon2);

/** OWASP's first choice for argon2id: 19 MiB of memory, 2 passes, 1 lane. */
const COST = { memory: 19_456, passes: 2, parallelism: 1 };
const TAG_BYTES = 32;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

/** Why a password is not accepted, for the person choosing it; undefined when it is. */
export function passwordProblem(password: string, login?: string): string | undefined {
  if (password.length < PASSWORD_MIN) return `A password has at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `A password has at most ${PASSWORD_MAX} characters`;
  if (login && password.toLowerCase().includes(login.toLowerCase()))
    return 'A password does not contain the login';
  if (new Set(password).size < 5) return 'A password uses more than a few different characters';
  return undefined;
}

const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');

async function hashWith(
  password: string,
  salt: Buffer,
  cost: typeof COST,
  bytes: number,
): Promise<Buffer> {
  return derive('argon2id', {
    message: Buffer.from(password, 'utf8'),
    nonce: salt,
    parallelism: cost.parallelism,
    tagLength: bytes,
    memory: cost.memory,
    passes: cost.passes,
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await hashWith(password, salt, COST, TAG_BYTES);
  return `$argon2id$v=19$m=${COST.memory},t=${COST.passes},p=${COST.parallelism}$${b64(salt)}$${b64(hash)}`;
}

/** A hash of nothing anyone knows: checked when a login does not exist, so that takes as long. */
let decoy: Promise<string> | undefined;

/**
 * True when `password` is the one `stored` was made from. With no stored hash (no such account,
 * or one without a password) it still does the work and says false, so the time it takes does
 * not tell whether the login exists.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  decoy ??= hashPassword(randomBytes(24).toString('hex'));
  const encoded = stored ?? (await decoy);
  const match =
    /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(encoded);
  if (!match) return false;
  const [, memory, passes, parallelism, salt, hash] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const expected = Buffer.from(hash, 'base64');
  const actual = await hashWith(
    password,
    Buffer.from(salt, 'base64'),
    { memory: Number(memory), passes: Number(passes), parallelism: Number(parallelism) },
    expected.length,
  );
  return timingSafeEqual(actual, expected) && stored !== null;
}
