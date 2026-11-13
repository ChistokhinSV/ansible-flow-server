// How a run gets its credentials: as Ansible's own variables, a vault password, a key file in a
// folder only the run's container sees, and environment variables. Never as an argument of a
// command, never in a file the repository can see, and every value is hidden from the output.
import { chmod, chown, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Mount } from '@ansible-flow/core/run/environment';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { type Revealed, reveal } from '../secrets/credentials';
import type { MasterKey } from '../secrets/masterKey';

/** Where the run's container finds its key. */
export const CREDENTIAL_DIR = '/afd-cred';

export interface RunCredentials {
  /** Variables for Ansible (ansible_user, ansible_password…). Secret-looking ones stay secret. */
  vars: Record<string, string>;
  vaultPassword?: string;
  /** Container options: `-e NAME` for each variable below, and the key's path. */
  options: string[];
  mounts: Mount[];
  /** Values for the container's variables, given to the engine's command, not its arguments. */
  processEnv: Record<string, string>;
  /** Every secret value, to hide from the run's output. */
  secrets: string[];
  /** What the run's log says about them (names and kinds, never values). */
  notes: string[];
  /** Removes the key file. */
  cleanup(): Promise<void>;
}

export class CredentialProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialProblem';
  }
}

/** Reads a run's credentials and makes them what its container needs. */
export async function runCredentials(
  db: Kysely<Schema>,
  key: MasterKey,
  ids: string[],
  secretsDir: string,
  /**
   * The user the image runs as: the key file is given to it (only root may), since ssh reads a
   * key only its owner can read.
   */
  owner?: { uid: number; gid: number },
): Promise<RunCredentials> {
  const result: RunCredentials = {
    vars: {},
    options: [],
    mounts: [],
    processEnv: {},
    secrets: [],
    notes: [],
    cleanup: async () => undefined,
  };
  const revealed: Revealed[] = [];
  for (const id of ids) {
    const credential = await reveal(db, key, id);
    if (!credential) throw new CredentialProblem('A credential of the run is gone');
    revealed.push(credential);
  }
  const secret = (value: string | undefined) => {
    if (value) result.secrets.push(value);
    return value;
  };
  for (const c of revealed) {
    const { fields, secret: s } = c;
    switch (c.kind) {
      case 'ssh_key': {
        if (s.passphrase)
          throw new CredentialProblem(
            `${c.name}: a key with a passphrase cannot be used by a run yet; use a key without one`,
          );
        await mkdir(secretsDir, { recursive: true, mode: 0o700 });
        await chmod(secretsDir, 0o700);
        const file = join(secretsDir, 'ssh_key');
        // A key file must end with a line end, or ssh refuses it.
        await writeFile(file, `${(s.privateKey ?? '').trimEnd()}\n`, { mode: 0o600 });
        await chmod(file, 0o600);
        if (owner) {
          await chown(secretsDir, owner.uid, owner.gid);
          await chown(file, owner.uid, owner.gid);
        }
        secret(s.privateKey);
        result.mounts.push({ src: secretsDir, dest: CREDENTIAL_DIR, options: 'ro' });
        result.options.push('-e', `ANSIBLE_PRIVATE_KEY_FILE=${CREDENTIAL_DIR}/ssh_key`);
        if (fields.username) result.vars.ansible_user = fields.username;
        result.cleanup = () => rm(secretsDir, { recursive: true, force: true });
        result.notes.push(`SSH key "${c.name}"${fields.username ? ` as ${fields.username}` : ''}`);
        break;
      }
      case 'login':
        if (fields.username) result.vars.ansible_user = fields.username;
        result.vars.ansible_password = secret(s.password) ?? '';
        result.notes.push(`login "${c.name}" as ${fields.username}`);
        break;
      case 'become':
        result.vars.ansible_become_password = secret(s.password) ?? '';
        if (fields.method) result.vars.ansible_become_method = fields.method;
        if (fields.username) result.vars.ansible_become_user = fields.username;
        result.notes.push(`become password "${c.name}"`);
        break;
      case 'vault':
        if (result.vaultPassword !== undefined)
          throw new CredentialProblem('A run takes one vault password');
        result.vaultPassword = secret(s.password);
        result.notes.push(`vault password "${c.name}"`);
        break;
      case 'env':
        for (const [name, value] of Object.entries(s)) {
          // The engine reads the value from its own environment: it is in no argument list.
          result.options.push('-e', name);
          result.processEnv[name] = value;
          secret(value);
        }
        result.notes.push(`variables "${c.name}": ${Object.keys(s).join(', ')}`);
        break;
      case 'registry':
        result.notes.push(`registry "${c.name}" is not used by runs yet: the image must be there`);
        break;
      default:
        throw new CredentialProblem(`${c.name}: a ${c.kind} credential is not for a run`);
    }
  }
  // Short values would hide ordinary words in the output; the store's rules make them rare.
  result.secrets = result.secrets.filter((v) => v.length >= 4);
  return result;
}
