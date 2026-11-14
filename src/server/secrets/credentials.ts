// Credentials: what a run or a look at a repository needs to prove who it is. Each belongs to a
// workspace, has a kind that says what it holds, and keeps its secret part sealed with the
// master key. The secret part goes in and never comes out through the API: `reveal` is for the
// server's own use (handing it to git, later to a run).
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { SEALED_SETTINGS, settingContext } from '../notify/settings';
import { open, seal } from './crypto';
import { type CredentialKind, KINDS, SPEC } from './kinds';
import type { MasterKey } from './masterKey';

export type { CredentialKind } from './kinds';
export { GIT_KINDS, KINDS } from './kinds';

/** The most one secret value may be: a private key with room to spare. */
const MAX_VALUE = 64 * 1024;
const MAX_VARIABLES = 100;

export interface Credential {
  id: string;
  workspace: string;
  name: string;
  kind: CredentialKind;
  description?: string;
  /** The part that is not secret (a user name, a registry's host). */
  fields: Record<string, string>;
  /** The names of the secret parts it holds; for `env`, the names of its variables. */
  has: string[];
  /** How many projects (for their repository) and launch configurations use it. */
  usedBy: number;
  createdAt: string;
  updatedAt: string;
}

/** A credential with its secret part, for the server's own use only. */
export interface Revealed {
  kind: CredentialKind;
  name: string;
  fields: Record<string, string>;
  secret: Record<string, string>;
}

export class CredentialError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'taken' | 'in_use',
    message: string,
  ) {
    super(message);
    this.name = 'CredentialError';
  }
}

export interface CredentialInput {
  name: string;
  kind: CredentialKind;
  description?: string;
  fields?: Record<string, string>;
  secret: Record<string, string>;
}

type Db = Kysely<Schema>;
type Row = Schema['credential'];
const now = () => new Date().toISOString();
const context = (id: string) => `credential:${id}`;
const invalid = (message: string) => new CredentialError('invalid', message);

function checkedName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 100)
    throw invalid('A credential has a name of 1 to 100 characters');
  return trimmed;
}

/** The public and secret parts as the kind allows them; throws what is wrong, in words. */
function checked(
  kind: CredentialKind,
  fields: Record<string, string> = {},
  secret: Record<string, string>,
): { fields: Record<string, string>; secret: Record<string, string> } {
  const spec = SPEC[kind];
  if (!spec) throw invalid(`There is no kind ${kind}: use one of ${KINDS.join(', ')}`);
  const text = (value: unknown, what: string, max: number) => {
    if (typeof value !== 'string') throw invalid(`${what} must be text`);
    if (value.length > max) throw invalid(`${what} is too long`);
    return value;
  };
  if (kind === 'env') {
    const names = Object.keys(secret);
    if (Object.keys(fields).length) throw invalid('Variables have no other fields');
    if (!names.length) throw invalid('Give at least one variable');
    if (names.length > MAX_VARIABLES) throw invalid(`At most ${MAX_VARIABLES} variables`);
    for (const name of names) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(name))
        throw invalid(`"${name.slice(0, 40)}" is not a variable name`);
      text(secret[name], `The value of ${name}`, MAX_VALUE);
    }
    return { fields: {}, secret };
  }
  const cleanFields: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!spec.fields.includes(name))
      throw invalid(`A ${kind} credential has no field "${name.slice(0, 40)}"`);
    const trimmed = text(value, name, 500).trim();
    if (trimmed) cleanFields[name] = trimmed;
  }
  const cleanSecret: Record<string, string> = {};
  for (const [name, value] of Object.entries(secret)) {
    if (!spec.secret.includes(name))
      throw invalid(`A ${kind} credential has no secret "${name.slice(0, 40)}"`);
    if (text(value, name, MAX_VALUE)) cleanSecret[name] = value;
  }
  for (const name of spec.required)
    if (!(cleanFields[name] ?? cleanSecret[name]))
      throw invalid(`A ${kind} credential needs ${name}`);
  if (
    cleanSecret.privateKey &&
    !/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(
      cleanSecret.privateKey,
    )
  )
    throw invalid('privateKey is not a private key in PEM or OpenSSH form');
  return { fields: cleanFields, secret: cleanSecret };
}

const credentialOf = (row: Row, usedBy = 0): Credential => ({
  id: row.id,
  workspace: row.workspace_id,
  name: row.name,
  kind: row.kind as CredentialKind,
  ...(row.description ? { description: row.description } : {}),
  fields: JSON.parse(row.fields_json) as Record<string, string>,
  has: JSON.parse(row.has_json) as string[],
  usedBy,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

async function uses(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom('project')
    .select(['git_credential_id', (eb) => eb.fn.countAll().as('n')])
    .where('git_credential_id', 'is not', null)
    .groupBy('git_credential_id')
    .execute();
  const used = new Map(rows.map((row) => [row.git_credential_id as string, Number(row.n)]));
  const launches = await db
    .selectFrom('launch_config_credential')
    .select(['credential_id', (eb) => eb.fn.countAll().as('n')])
    .groupBy('credential_id')
    .execute();
  for (const row of launches)
    used.set(row.credential_id, (used.get(row.credential_id) ?? 0) + Number(row.n));
  return used;
}

export async function listCredentials(db: Db, workspaceId: string): Promise<Credential[]> {
  const rows = await db
    .selectFrom('credential')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .orderBy('name')
    .execute();
  const used = await uses(db);
  return rows.map((row) => credentialOf(row, used.get(row.id) ?? 0));
}

export async function getCredential(db: Db, id: string): Promise<Credential | undefined> {
  const row = await db.selectFrom('credential').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? credentialOf(row, (await uses(db)).get(row.id) ?? 0) : undefined;
}

export async function createCredential(
  db: Db,
  key: MasterKey,
  workspaceId: string,
  input: CredentialInput,
): Promise<Credential> {
  const name = checkedName(input.name);
  const { fields, secret } = checked(input.kind, input.fields, input.secret);
  if (
    !(await db
      .selectFrom('workspace')
      .select('id')
      .where('id', '=', workspaceId)
      .executeTakeFirst())
  )
    throw new CredentialError('not_found', 'No such workspace');
  const id = randomUUID();
  const at = now();
  const row: Row = {
    id,
    workspace_id: workspaceId,
    name,
    kind: input.kind,
    description: input.description?.trim() || null,
    fields_json: JSON.stringify(fields),
    has_json: JSON.stringify(Object.keys(secret).sort()),
    secret_enc: seal(key, JSON.stringify(secret), context(id)),
    created_at: at,
    updated_at: at,
  };
  const done = await db
    .insertInto('credential')
    .values(row)
    .onConflict((c) => c.columns(['workspace_id', 'name']).doNothing())
    .executeTakeFirst();
  if (!done.numInsertedOrUpdatedRows)
    throw new CredentialError('taken', `The workspace has a credential "${name}" already`);
  return credentialOf(row);
}

export interface CredentialChange {
  name?: string;
  description?: string | null;
  /** Replaces the part that is not secret. */
  fields?: Record<string, string>;
  /** Replaces the secret part, whole: what is there cannot be read to be kept. */
  secret?: Record<string, string>;
}

export async function updateCredential(
  db: Db,
  key: MasterKey,
  id: string,
  change: CredentialChange,
): Promise<Credential> {
  const row = await db.selectFrom('credential').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw new CredentialError('not_found', 'No such credential');
  const kind = row.kind as CredentialKind;
  const set: Partial<Row> = { updated_at: now() };
  if (change.name !== undefined) set.name = checkedName(change.name);
  if (change.description !== undefined) set.description = change.description?.trim() || null;
  if (change.fields !== undefined || change.secret !== undefined) {
    // The two parts are checked together: what one needs may be in the other.
    const secret =
      change.secret ??
      (JSON.parse(open(key, row.secret_enc, context(id))) as Record<string, string>);
    const fields = change.fields ?? (JSON.parse(row.fields_json) as Record<string, string>);
    const good = checked(kind, fields, secret);
    set.fields_json = JSON.stringify(good.fields);
    if (change.secret !== undefined) {
      set.has_json = JSON.stringify(Object.keys(good.secret).sort());
      set.secret_enc = seal(key, JSON.stringify(good.secret), context(id));
    }
  }
  try {
    await db.updateTable('credential').set(set).where('id', '=', id).execute();
  } catch (e) {
    if (/unique|duplicate/i.test(String((e as Error).message)))
      throw new CredentialError('taken', `The workspace has a credential "${set.name}" already`);
    throw e;
  }
  return (await getCredential(db, id)) as Credential;
}

/** Deletes a credential nothing uses. One a project signs in with is not taken from under it. */
export async function deleteCredential(db: Db, id: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom('project')
      .select('key')
      .where('git_credential_id', '=', id)
      .executeTakeFirst();
    if (user)
      throw new CredentialError(
        'in_use',
        `The project ${user.key} signs in to its repository with it: give the project another first`,
      );
    const launch = await trx
      .selectFrom('launch_config_credential')
      .innerJoin('launch_config', 'launch_config.id', 'launch_config_credential.config_id')
      .select('launch_config.name')
      .where('launch_config_credential.credential_id', '=', id)
      .executeTakeFirst();
    if (launch)
      throw new CredentialError(
        'in_use',
        `The launch configuration "${launch.name}" gives it to its runs: take it out there first`,
      );
    const done = await trx.deleteFrom('credential').where('id', '=', id).executeTakeFirst();
    if (!done.numDeletedRows) throw new CredentialError('not_found', 'No such credential');
  });
}

/** A credential with its secret part. For the server's own use: never an answer to a request. */
export async function reveal(db: Db, key: MasterKey, id: string): Promise<Revealed | undefined> {
  const row = await db.selectFrom('credential').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) return undefined;
  return {
    kind: row.kind as CredentialKind,
    name: row.name,
    fields: JSON.parse(row.fields_json) as Record<string, string>,
    secret: JSON.parse(open(key, row.secret_enc, context(id))) as Record<string, string>,
  };
}

/** What git sends as HTTP Basic sign-in for a credential a project may use for its source. */
export function gitAuthOf(revealed: Revealed): { username: string; password: string } | undefined {
  if (revealed.kind === 'git_token' && revealed.secret.token)
    // A token needs a user name on the wire; most hosts accept any.
    return { username: revealed.fields.username ?? 'git', password: revealed.secret.token };
  if (revealed.kind === 'login' && revealed.fields.username && revealed.secret.password)
    return { username: revealed.fields.username, password: revealed.secret.password };
  return undefined;
}

// --- the key itself

const CHECK = 'secrets.check';
const CHECK_TEXT = 'ansible-flow-server';

/**
 * Makes sure the key is the one the stored secrets were sealed with. A new database remembers
 * the key (a sealed word, not the key). Throws a SealError when the key is another one: better
 * to refuse at start than to find out when a run needs a password.
 */
export async function checkKey(db: Db, key: MasterKey): Promise<'new' | 'same'> {
  const row = await db
    .selectFrom('setting')
    .select('value')
    .where('name', '=', CHECK)
    .executeTakeFirst();
  if (row) {
    open(key, row.value, CHECK);
    return 'same';
  }
  await db
    .insertInto('setting')
    .values({ name: CHECK, value: seal(key, CHECK_TEXT, CHECK), updated_at: now() })
    .onConflict((c) => c.column('name').doNothing())
    .execute();
  return 'new';
}

/**
 * Seals everything again with another key, all or nothing: credentials, runs' inputs (AFS-19) and
 * sealed settings (AFS-29). Resolves with how many secrets.
 */
export async function rotate(db: Db, from: MasterKey, to: MasterKey): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const again = (sealed: string, where: string) => seal(to, open(from, sealed, where), where);
    const rows = await trx.selectFrom('credential').select(['id', 'secret_enc']).execute();
    for (const row of rows)
      await trx
        .updateTable('credential')
        .set({ secret_enc: again(row.secret_enc, context(row.id)) })
        .where('id', '=', row.id)
        .execute();
    // A run's inputs can hold secrets; a run relaunched later opens them again.
    const runs = await trx.selectFrom('run').select(['id', 'inputs_enc']).execute();
    for (const run of runs)
      await trx
        .updateTable('run')
        .set({ inputs_enc: again(run.inputs_enc, `run:${run.id}`) })
        .where('id', '=', run.id)
        .execute();
    const settings = await trx
      .selectFrom('setting')
      .select(['name', 'value'])
      .where('name', 'in', SEALED_SETTINGS)
      .execute();
    for (const s of settings)
      await trx
        .updateTable('setting')
        .set({ value: again(s.value, settingContext(s.name)) })
        .where('name', '=', s.name)
        .execute();
    await trx.deleteFrom('setting').where('name', '=', CHECK).execute();
    await trx
      .insertInto('setting')
      .values({ name: CHECK, value: seal(to, CHECK_TEXT, CHECK), updated_at: now() })
      .execute();
    return rows.length + runs.length + settings.length;
  });
}
