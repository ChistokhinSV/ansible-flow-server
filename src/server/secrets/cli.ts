// The secrets commands, for whoever administers the machine the server runs on.
//   secrets status    which master key the server has, and whether the stored secrets open with it
//   secrets rotate    make a new master key and seal everything again with it
// Stop the server before `rotate`: a running server keeps the old key in memory.
import { existsSync, renameSync, rmSync } from 'node:fs';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { checkKey, rotate } from './credentials';
import { SealError } from './crypto';
import {
  type KeySettings,
  keyId,
  loadMasterKey,
  type MasterKey,
  MasterKeyError,
  newKey,
  writeKeyFile,
} from './masterKey';

const USAGE = 'Use: secrets status | secrets rotate';

export async function secretsCommand(
  db: Kysely<Schema>,
  settings: KeySettings,
  args: string[],
  print: (line: string) => void = console.log,
): Promise<number> {
  const [command] = args;
  if (command !== 'status' && command !== 'rotate') {
    print(USAGE);
    return 2;
  }
  let key: MasterKey;
  try {
    key = loadMasterKey(settings, false);
  } catch (e) {
    if (!(e instanceof MasterKeyError)) throw e;
    print(e.message);
    return 1;
  }
  const where = key.source === 'env' ? 'the setting AFS_MASTER_KEY' : `the file ${key.file}`;
  const count = await db
    .selectFrom('credential')
    .select((eb) => eb.fn.countAll().as('n'))
    .executeTakeFirstOrThrow();
  try {
    await checkKey(db, key);
  } catch (e) {
    if (!(e instanceof SealError)) throw e;
    print(`The master key ${key.id} (from ${where}) is not the one the stored secrets need.`);
    print(e.message);
    return 1;
  }
  if (command === 'status') {
    print(`Master key ${key.id}, from ${where}.`);
    print(`${Number(count.n)} stored credential(s) open with it.`);
    return 0;
  }

  const next = newKey();
  const to: MasterKey = { key: next, id: keyId(next), source: key.source, file: key.file };
  if (!key.file) {
    // The key lives in the settings: the server cannot change them. The new key is said once.
    const sealed = await rotate(db, key, to);
    print(`${sealed} credential(s) sealed again with the new master key ${to.id}.`);
    print('Set AFS_MASTER_KEY to this value before the server starts again:');
    print(next.toString('base64'));
    return 0;
  }
  // The new key is on disk before the database needs it, and the old one stays beside it: at
  // no moment is there a database whose key is nowhere.
  const pending = `${key.file}.new`;
  rmSync(pending, { force: true });
  writeKeyFile(pending, next);
  const sealed = await rotate(db, key, to);
  const old = `${key.file}.${key.id}.old`;
  if (existsSync(old)) rmSync(old);
  renameSync(key.file, old);
  renameSync(pending, key.file);
  print(`${sealed} credential(s) sealed again with the new master key ${to.id}.`);
  print(`The key is in ${key.file}; the old one is kept as ${old} until you remove it.`);
  return 0;
}
