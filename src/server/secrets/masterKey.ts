// The master key: the one secret that is not in the database. Everything the server keeps
// secret (credentials) is encrypted with it, so a copy of the database alone gives nothing away.
// It comes from the settings (AFS_MASTER_KEY, or a file named by AFS_MASTER_KEY_FILE); a server
// that is given neither makes one in its data folder at first start.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface MasterKey {
  /** 32 bytes, for AES-256. */
  key: Buffer;
  /** A short name for the key that gives nothing of it away: what a sealed value says it needs. */
  id: string;
  /** Where it came from: the settings, a file, or a file the server just made. */
  source: 'env' | 'file' | 'generated';
  /** The file it is kept in, when it is in one. */
  file?: string;
}

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyError';
  }
}

/** The name of the key file a server makes for itself. */
export const KEY_FILE = 'master.key';

export const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 8);

/** A key as text: base64 of 32 bytes (either alphabet, padding or not). */
export function parseKey(text: string, where: string): Buffer {
  const cleaned = text.trim();
  const key = /^[A-Za-z0-9+/_-]+={0,2}$/.test(cleaned)
    ? Buffer.from(cleaned.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    : Buffer.alloc(0);
  if (key.length !== 32)
    throw new MasterKeyError(
      `${where} is not a master key: it must be 32 random bytes in base64 (make one with: openssl rand -base64 32)`,
    );
  return key;
}

export const newKey = () => randomBytes(32);

/** Writes a key to a file only its owner reads. Refuses to replace a file that is there. */
export function writeKeyFile(file: string, key: Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
}

export interface KeySettings {
  /** AFS_MASTER_KEY. */
  masterKey?: string;
  /** AFS_MASTER_KEY_FILE. */
  masterKeyFile?: string;
  dataDir: string;
}

/**
 * The server's master key. With nothing in the settings, the key file in the data folder is
 * read, or made when `create` is set and there is none (a server's first start).
 */
export function loadMasterKey(settings: KeySettings, create = true): MasterKey {
  if (settings.masterKey) {
    const key = parseKey(settings.masterKey, 'AFS_MASTER_KEY');
    return { key, id: keyId(key), source: 'env' };
  }
  const named = settings.masterKeyFile;
  const file = named ?? join(settings.dataDir, KEY_FILE);
  if (existsSync(file)) {
    const key = parseKey(readFileSync(file, 'utf8'), `The file ${file}`);
    return { key, id: keyId(key), source: 'file', file };
  }
  // A file someone named and that is not there is a mistake, not a first start.
  if (named) throw new MasterKeyError(`AFS_MASTER_KEY_FILE names ${file}, which is not there`);
  if (!create) throw new MasterKeyError(`There is no master key yet (${file})`);
  const key = newKey();
  writeKeyFile(file, key);
  return { key, id: keyId(key), source: 'generated', file };
}
