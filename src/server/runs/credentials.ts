// How a run gets its credentials: as Ansible's own variables, a vault password, a key file in a
// folder only the run's container sees, and environment variables. Never as an argument of a
// command, never in a file the repository can see, and every value is hidden from the output.
import { chmod, chown, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Mount } from '@ansible-flow/core/run/environment';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { type Revealed, reveal } from '../secrets/credentials';
import { KIND_NAME } from '../secrets/kinds';
import type { MasterKey } from '../secrets/masterKey';
import type { SecretResolver } from '../secrets/providers/resolver';
import type { RegistrySignIn } from './registry';

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

/** AFS-241: the file of values read from secret providers, in the run's credential folder. */
export const EXTERNAL_FILE = 'external-secrets.json';

/** The variable the container's agent script reads the key's passphrase from. */
const PASSPHRASE_VAR = 'AFS_SSH_PASSPHRASE';

/** What the agent script says when it cannot start the run; the executor makes it the run's error. */
export const AGENT_FAILURES = [
  'This image has no ssh-agent: a key with a passphrase needs openssh-client in the image',
  'The SSH key could not be unlocked: is its passphrase right?',
] as const;

/**
 * The entrypoint of a run whose key has a passphrase: an ssh-agent, the key added to it (ssh-add
 * asks the askpass script, which prints the variable), the variable dropped, then the run's own
 * command. Ansible's ssh finds the key through SSH_AUTH_SOCK.
 */
const AGENT_SCRIPT = [
  '#!/bin/sh',
  "# Ansible Flow Server: unlocks the run's SSH key into an ssh-agent, then runs the run's command.",
  'if ! command -v ssh-agent >/dev/null 2>&1 || ! command -v ssh-add >/dev/null 2>&1; then',
  `  echo "${AGENT_FAILURES[0]}" >&2`,
  '  exit 70',
  'fi',
  'eval "$(ssh-agent -s)" >/dev/null || exit 70',
  // ssh-add asks again after a wrong passphrase until it gets an empty one: askpass answers once.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's ${TMPDIR:-/tmp}, not a template.
  'AFS_ASKPASS_ANSWERED="${TMPDIR:-/tmp}/.afs-askpass-$$"',
  'export AFS_ASKPASS_ANSWERED',
  'rm -f "$AFS_ASKPASS_ANSWERED"',
  `SSH_ASKPASS=${CREDENTIAL_DIR}/askpass SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ssh-add ${CREDENTIAL_DIR}/ssh_key </dev/null >/dev/null 2>&1`,
  'added=$?',
  'rm -f "$AFS_ASKPASS_ANSWERED"',
  `unset ${PASSPHRASE_VAR} AFS_ASKPASS_ANSWERED`,
  'if [ "$added" -ne 0 ]; then',
  `  echo "${AGENT_FAILURES[1]}" >&2`,
  '  ssh-agent -k >/dev/null 2>&1',
  '  exit 70',
  'fi',
  'exec "$@"',
  '',
].join('\n');
// A second question means the passphrase was wrong: no answer, so ssh-add gives up.
const ASKPASS_SCRIPT = [
  '#!/bin/sh',
  '[ -e "$AFS_ASKPASS_ANSWERED" ] && exit 1',
  ': > "$AFS_ASKPASS_ANSWERED" || exit 1',
  `printf '%s\\n' "$${PASSPHRASE_VAR}"`,
  '',
].join('\n');

/** AFS-241: ", password from HashiCorp Vault "corp-vault"": where the read parts came from. */
export function fromWords(from: Record<string, string>): string {
  const byProvider = new Map<string, string[]>();
  for (const [part, provider] of Object.entries(from))
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), part]);
  return [...byProvider]
    .map(([provider, parts]) => `, ${parts.join(' and ')} from ${provider}`)
    .join('');
}

/** The registry sign-in among a run's credentials, if it has one (AFS-66). */
export async function registrySignIn(
  db: Kysely<Schema>,
  key: MasterKey,
  ids: string[],
  resolver?: SecretResolver,
): Promise<RegistrySignIn | undefined> {
  for (const id of ids) {
    const c = await reveal(db, key, id, resolver);
    if (c?.kind === 'registry' && c.fields.host && c.fields.username && c.secret.password)
      return {
        name: c.name,
        host: c.fields.host,
        username: c.fields.username,
        password: c.secret.password,
      };
  }
  return undefined;
}

/**
 * AFS-67: the variables of a run's `env` credentials, for reading its inventory (a dynamic source
 * may need a token): `-e NAME` options, the values in the engine's own environment.
 */
export async function inventoryEnv(
  db: Kysely<Schema>,
  key: MasterKey,
  ids: string[],
  resolver?: SecretResolver,
): Promise<{ options: string[]; processEnv: Record<string, string> }> {
  const out = { options: [] as string[], processEnv: {} as Record<string, string> };
  for (const id of ids) {
    const c = await reveal(db, key, id, resolver);
    if (c?.kind !== 'env') continue;
    for (const [name, value] of Object.entries(c.secret)) {
      out.options.push('-e', name);
      out.processEnv[name] = value;
    }
  }
  return out;
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
  /**
   * AFS-241: reads the parts taken from secret providers, once per run; the run closes it as it
   * ends (Vault tokens are revoked then).
   */
  resolver?: SecretResolver,
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
    const credential = await reveal(db, key, id, resolver);
    if (!credential) throw new CredentialProblem('A credential of the run is gone');
    revealed.push(credential);
  }
  const secret = (value: string | undefined) => {
    if (value) result.secrets.push(value);
    return value;
  };
  for (const c of revealed) {
    const { fields, secret: s } = c;
    const notes = result.notes.length;
    switch (c.kind) {
      case 'ssh_key': {
        await mkdir(secretsDir, { recursive: true, mode: 0o700 });
        await chmod(secretsDir, 0o700);
        const file = join(secretsDir, 'ssh_key');
        // A key file must end with a line end, or ssh refuses it.
        await writeFile(file, `${(s.privateKey ?? '').trimEnd()}\n`, { mode: 0o600 });
        await chmod(file, 0o600);
        // AFS-66: a key with a passphrase goes into an ssh-agent in the run's container, unlocked by
        // a script that reads the passphrase from the container's environment (the engine gives it
        // from its own environment: in no argument and no file), then runs the run's command.
        const scripts: [string, string][] = s.passphrase
          ? [
              ['agent', AGENT_SCRIPT],
              ['askpass', ASKPASS_SCRIPT],
            ]
          : [];
        for (const [name, text] of scripts)
          await writeFile(join(secretsDir, name), text, { mode: 0o700 });
        if (owner) {
          await chown(secretsDir, owner.uid, owner.gid);
          await chown(file, owner.uid, owner.gid);
          for (const [name] of scripts) await chown(join(secretsDir, name), owner.uid, owner.gid);
        }
        secret(s.privateKey);
        result.mounts.push({ src: secretsDir, dest: CREDENTIAL_DIR, options: 'ro' });
        if (s.passphrase) {
          result.options.push('--entrypoint', `${CREDENTIAL_DIR}/agent`, '-e', PASSPHRASE_VAR);
          result.processEnv[PASSPHRASE_VAR] = s.passphrase;
          secret(s.passphrase);
        } else result.options.push('-e', `ANSIBLE_PRIVATE_KEY_FILE=${CREDENTIAL_DIR}/ssh_key`);
        if (fields.username) result.vars.ansible_user = fields.username;
        result.cleanup = () => rm(secretsDir, { recursive: true, force: true });
        result.notes.push(
          `SSH key "${c.name}"${fields.username ? ` as ${fields.username}` : ''}${s.passphrase ? ', with its passphrase, through an ssh-agent' : ''}`,
        );
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
        // Used before the run, to pull the image (registrySignIn, runs/registry.ts).
        break;
      default:
        throw new CredentialProblem(`${c.name} (${KIND_NAME[c.kind]}) is not for a run`);
    }
    // AFS-241: the note names the provider a part came from, never its path.
    if (c.from && result.notes.length > notes)
      result.notes[result.notes.length - 1] += fromWords(c.from);
  }
  // AFS-241: values read from secret providers (and each value inside a JSON one) go to a file
  // of their own in the run's credential folder, named by AFD_EXTERNAL_SECRETS_FILE: the engine
  // masks them as "external" in every event. Not AFD_SECRETS_FILE, which is also given to Ansible
  // as extra variables.
  const external = resolver?.hidden() ?? [];
  if (external.length) {
    await mkdir(secretsDir, { recursive: true, mode: 0o700 });
    await chmod(secretsDir, 0o700);
    const file = join(secretsDir, EXTERNAL_FILE);
    await writeFile(file, JSON.stringify(external), { mode: 0o600 });
    await chmod(file, 0o600);
    if (owner) {
      await chown(secretsDir, owner.uid, owner.gid);
      await chown(file, owner.uid, owner.gid);
    }
    if (!result.mounts.some((m) => m.dest === CREDENTIAL_DIR))
      result.mounts.push({ src: secretsDir, dest: CREDENTIAL_DIR, options: 'ro' });
    result.options.push('-e', `AFD_EXTERNAL_SECRETS_FILE=${CREDENTIAL_DIR}/${EXTERNAL_FILE}`);
    result.cleanup = () => rm(secretsDir, { recursive: true, force: true });
    result.secrets.push(...external);
  }
  // Short values would hide ordinary words in the output; the store's rules make them rare.
  result.secrets = [...new Set(result.secrets.filter((v) => v.length >= 4))];
  return result;
}
