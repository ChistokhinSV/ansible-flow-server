// Secret providers kept in the database (AFS-241): an administrator's list, built like the OIDC
// providers. The open settings are JSON; the secret part (a token, an API key, a client key) is
// sealed under `secret-provider:<id>`, goes in and never comes out through the API. Each provider
// lists the workspaces whose credentials may read from it.
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Schema } from '../../db/schema';
import { open, seal } from '../crypto';
import type { MasterKey } from '../masterKey';
import type { Connection } from './clients';
import {
  PROVIDER_KEY,
  PROVIDER_KIND_NAME,
  PROVIDER_KINDS,
  type ProviderKind,
  type ProviderSettings,
  SECRETS,
  SETTINGS,
  type SecretProvider,
  type SecretProviderInput,
} from './types';

type Db = Kysely<Schema>;
type Row = Schema['secret_provider'];
const now = () => new Date().toISOString();
export const providerContext = (id: string) => `secret-provider:${id}`;

export class ProviderStoreError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'taken' | 'in_use',
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ProviderStoreError';
  }
}

const invalid = (field: string, message: string) =>
  new ProviderStoreError('invalid', message, field);

const providerOf = (r: Row): SecretProvider => ({
  id: r.id,
  key: r.key,
  name: r.name,
  kind: r.kind as ProviderKind,
  settings: JSON.parse(r.settings_json) as ProviderSettings,
  has: JSON.parse(r.has_json) as string[],
  workspaces: JSON.parse(r.workspaces_json) as string[],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const isPem = (text: string, what: 'CERTIFICATE' | 'PRIVATE KEY') =>
  new RegExp(`-----BEGIN [A-Z0-9 ]*${what}-----[\\s\\S]+-----END [A-Z0-9 ]*${what}-----`).test(
    text,
  );

function addressProblem(address: string): string | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return 'An address starts with https:// (https://vault.example.net:8200)';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return 'An address starts with https:// (or http://)';
  if (url.search || url.hash || url.username) return 'An address has no query, user or #part';
  return undefined;
}

/** The settings as the kind takes them; throws what is wrong, at its field. */
function checkedSettings(kind: ProviderKind, settings: ProviderSettings): ProviderSettings {
  const allowed = SETTINGS[kind];
  const out: ProviderSettings = {};
  for (const [name, value] of Object.entries(settings ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (!allowed.includes(name as keyof ProviderSettings))
      throw invalid(
        name,
        `A ${PROVIDER_KIND_NAME[kind]} provider has no setting "${name.slice(0, 40)}"`,
      );
    if (name === 'timeoutS') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 120)
        throw invalid(name, 'The timeout is 1 to 120 seconds');
      out.timeoutS = value;
      continue;
    }
    if (typeof value !== 'string') throw invalid(name, `${name} must be text`);
    const v = value.trim();
    if (v.length > (name === 'ca' || name === 'clientCert' ? 64 * 1024 : 500))
      throw invalid(name, `${name} is too long`);
    (out as Record<string, unknown>)[name] = v;
  }
  if (kind !== 'aws' && !out.address) throw invalid('address', 'An address is needed');
  if (out.address) {
    const p = addressProblem(out.address);
    if (p) throw invalid('address', p);
    out.address = out.address.replace(/\/+$/, '');
  }
  if (out.ca && !isPem(out.ca, 'CERTIFICATE'))
    throw invalid(
      'ca',
      'The certificate authority is a PEM certificate (-----BEGIN CERTIFICATE-----)',
    );
  if (out.clientCert && !isPem(out.clientCert, 'CERTIFICATE'))
    throw invalid('clientCert', 'The client certificate is a PEM certificate');
  switch (kind) {
    case 'vault':
      out.auth = out.auth ?? 'approle';
      if (out.auth !== 'approle' && out.auth !== 'token')
        throw invalid('auth', 'Vault signs in with approle or token');
      for (const f of ['authMount', 'kvMount'] as const)
        if (out[f] && !/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(out[f] as string))
          throw invalid(f, 'A mount is a path like secret or kv/team');
      break;
    case 'conjur':
      if (!out.account) throw invalid('account', 'The Conjur account is needed');
      if (!out.login) throw invalid('login', 'The host login is needed (host/afs)');
      break;
    case 'ccp':
      if (!out.appId) throw invalid('appId', 'The application id (AppID) is needed');
      break;
    case 'aws':
      if (!/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/.test(out.region ?? ''))
        throw invalid('region', 'A region is like eu-central-1');
      break;
  }
  return out;
}

/** The secret part as the kind takes it (empty values dropped). */
function checkedSecret(kind: ProviderKind, secret: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(secret ?? {})) {
    if (!SECRETS[kind].includes(name))
      throw invalid(name, `A ${PROVIDER_KIND_NAME[kind]} provider keeps no "${name.slice(0, 40)}"`);
    if (typeof value !== 'string') throw invalid(name, `${name} must be text`);
    if (value.length > 64 * 1024) throw invalid(name, `${name} is too long`);
    if (value.trim()) out[name] = name === 'clientKey' ? value : value.trim();
  }
  if (out.clientKey && !isPem(out.clientKey, 'PRIVATE KEY'))
    throw invalid('clientKey', 'The client key is a PEM private key');
  return out;
}

/** What the kind needs of its secret part, given its settings; the field that is missing. */
function missingSecret(
  kind: ProviderKind,
  settings: ProviderSettings,
  has: string[],
): [string, string] | undefined {
  const need = (f: string, words: string): [string, string] | undefined =>
    has.includes(f) ? undefined : [f, words];
  switch (kind) {
    case 'vault':
      return settings.auth === 'token'
        ? need('token', 'A token is needed')
        : (need('roleId', 'The AppRole role id is needed') ??
            need('secretId', 'The AppRole secret id is needed'));
    case 'conjur':
      return need('apiKey', "The host's API key is needed");
    case 'ccp':
      return settings.clientCert
        ? need('clientKey', "The client certificate's key is needed")
        : undefined;
    case 'aws':
      return (
        need('accessKeyId', 'The access key id is needed') ??
        need('secretAccessKey', 'The secret access key is needed')
      );
  }
}

async function checkedWorkspaces(db: Db, ids: string[] | undefined): Promise<string[]> {
  const list = [...new Set((ids ?? []).filter((w) => typeof w === 'string'))];
  if (list.length > 500) throw invalid('workspaces', 'At most 500 workspaces');
  if (!list.length) return [];
  const rows = await db.selectFrom('workspace').select('id').where('id', 'in', list).execute();
  if (rows.length !== list.length)
    throw invalid('workspaces', 'One of the workspaces does not exist');
  return list.sort();
}

export async function listSecretProviders(db: Db): Promise<SecretProvider[]> {
  const rows = await db.selectFrom('secret_provider').selectAll().orderBy('name').execute();
  return rows.map(providerOf);
}

export async function getSecretProvider(
  db: Db,
  idOrKey: string,
): Promise<SecretProvider | undefined> {
  const r = await db
    .selectFrom('secret_provider')
    .selectAll()
    .where((eb) => eb.or([eb('id', '=', idOrKey), eb('key', '=', idOrKey)]))
    .executeTakeFirst();
  return r ? providerOf(r) : undefined;
}

/** The providers a workspace's credentials may read from. */
export async function providersFor(db: Db, workspaceId: string): Promise<SecretProvider[]> {
  return (await listSecretProviders(db)).filter((p) => p.workspaces.includes(workspaceId));
}

/** A provider with its secret part opened: for the server's own use, never an answer. */
export async function connectionOf(
  db: Db,
  key: MasterKey,
  idOrKey: string,
): Promise<(Connection & { id: string; workspaces: string[] }) | undefined> {
  const r = await db
    .selectFrom('secret_provider')
    .selectAll()
    .where((eb) => eb.or([eb('id', '=', idOrKey), eb('key', '=', idOrKey)]))
    .executeTakeFirst();
  if (!r) return undefined;
  const p = providerOf(r);
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    kind: p.kind,
    settings: p.settings,
    workspaces: p.workspaces,
    secret: r.secret_enc
      ? (JSON.parse(open(key, r.secret_enc, providerContext(r.id))) as Record<string, string>)
      : {},
  };
}

/** The credentials that read from a provider: by name, with their workspace's key. */
export async function providerUses(
  db: Db,
  providerKey: string,
): Promise<{ id: string; name: string; workspace: string; workspaceKey: string }[]> {
  const rows = await db
    .selectFrom('credential as c')
    .innerJoin('workspace as w', 'w.id', 'c.workspace_id')
    .select(['c.id', 'c.name', 'c.refs_json', 'c.workspace_id', 'w.key'])
    .where('c.refs_json', 'is not', null)
    .orderBy('c.name')
    .execute();
  return rows
    .filter((r) =>
      Object.values(
        JSON.parse(r.refs_json as string) as Record<string, { provider?: string }>,
      ).some((ref) => ref.provider === providerKey),
    )
    .map((r) => ({ id: r.id, name: r.name, workspace: r.workspace_id, workspaceKey: r.key }));
}

export async function createSecretProvider(
  db: Db,
  key: MasterKey,
  input: SecretProviderInput,
): Promise<SecretProvider> {
  if (!PROVIDER_KEY.test(input.key ?? ''))
    throw invalid('key', 'key: lower-case letters, digits and dashes, up to 40');
  if (!input.name?.trim() || input.name.trim().length > 100)
    throw invalid('name', 'A name of 1 to 100 characters is needed');
  if (!PROVIDER_KINDS.includes(input.kind))
    throw invalid(
      'kind',
      `There is no kind ${input.kind}: use one of ${PROVIDER_KINDS.join(', ')}`,
    );
  const settings = checkedSettings(input.kind, input.settings);
  const secret = checkedSecret(input.kind, input.secret ?? {});
  const missing = missingSecret(input.kind, settings, Object.keys(secret));
  if (missing) throw invalid(missing[0], missing[1]);
  const workspaces = await checkedWorkspaces(db, input.workspaces);
  const id = randomUUID();
  const at = now();
  const done = await db
    .insertInto('secret_provider')
    .values({
      id,
      key: input.key,
      name: input.name.trim(),
      kind: input.kind,
      settings_json: JSON.stringify(settings),
      has_json: JSON.stringify(Object.keys(secret).sort()),
      secret_enc: Object.keys(secret).length
        ? seal(key, JSON.stringify(secret), providerContext(id))
        : null,
      workspaces_json: JSON.stringify(workspaces),
      created_at: at,
      updated_at: at,
    })
    .onConflict((c) => c.column('key').doNothing())
    .executeTakeFirst();
  if (!done.numInsertedOrUpdatedRows)
    throw new ProviderStoreError(
      'taken',
      `A secret provider with the key ${input.key} is there`,
      'key',
    );
  return (await getSecretProvider(db, id)) as SecretProvider;
}

export async function updateSecretProvider(
  db: Db,
  key: MasterKey,
  id: string,
  input: Partial<SecretProviderInput>,
): Promise<SecretProvider> {
  const r = await db
    .selectFrom('secret_provider')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!r) throw new ProviderStoreError('not_found', 'No such secret provider');
  const before = providerOf(r);
  if (input.kind !== undefined && input.kind !== before.kind)
    throw invalid('kind', 'The kind of a provider cannot change: add another');
  const set: Partial<Row> = { updated_at: now() };
  const uses =
    input.key !== undefined || input.workspaces !== undefined
      ? await providerUses(db, before.key)
      : [];
  if (input.key !== undefined && input.key !== before.key) {
    if (!PROVIDER_KEY.test(input.key))
      throw invalid('key', 'key: lower-case letters, digits and dashes, up to 40');
    if (uses.length)
      throw new ProviderStoreError(
        'in_use',
        `The credential "${uses[0]?.name}" reads from it by its key: the key cannot change`,
        'key',
      );
    set.key = input.key;
  }
  if (input.name !== undefined) {
    if (!input.name.trim() || input.name.trim().length > 100)
      throw invalid('name', 'A name of 1 to 100 characters is needed');
    set.name = input.name.trim();
  }
  const settings =
    input.settings !== undefined ? checkedSettings(before.kind, input.settings) : before.settings;
  set.settings_json = JSON.stringify(settings);
  let has = before.has;
  if (input.secret !== undefined) {
    const secret = checkedSecret(before.kind, input.secret);
    has = Object.keys(secret).sort();
    set.has_json = JSON.stringify(has);
    set.secret_enc = has.length ? seal(key, JSON.stringify(secret), providerContext(id)) : null;
  }
  const missing = missingSecret(before.kind, settings, has);
  if (missing) throw invalid(missing[0], missing[1]);
  if (input.workspaces !== undefined) {
    const workspaces = await checkedWorkspaces(db, input.workspaces);
    const cut = uses.find((u) => !workspaces.includes(u.workspace));
    if (cut)
      throw new ProviderStoreError(
        'in_use',
        `The credential "${cut.name}" of the workspace ${cut.workspaceKey} reads from it: change that credential first`,
        'workspaces',
      );
    set.workspaces_json = JSON.stringify(workspaces);
  }
  try {
    await db.updateTable('secret_provider').set(set).where('id', '=', id).execute();
  } catch (e) {
    if (/unique|duplicate/i.test((e as Error).message))
      throw new ProviderStoreError(
        'taken',
        `A secret provider with the key ${input.key} is there`,
        'key',
      );
    throw e;
  }
  return (await getSecretProvider(db, id)) as SecretProvider;
}

/** Removes a provider no credential reads from. */
export async function deleteSecretProvider(db: Db, id: string): Promise<SecretProvider> {
  const before = await getSecretProvider(db, id);
  if (!before) throw new ProviderStoreError('not_found', 'No such secret provider');
  const uses = await providerUses(db, before.key);
  if (uses.length)
    throw new ProviderStoreError(
      'in_use',
      `The credential "${uses[0]?.name}" of the workspace ${uses[0]?.workspaceKey} reads from it: change that credential first`,
    );
  await db.deleteFrom('secret_provider').where('id', '=', before.id).execute();
  return before;
}

/** Re-seals every provider's secret part with another key (`secrets rotate`). */
export async function resealSecretProviders(
  db: Db,
  again: (sealed: string, context: string) => string,
): Promise<number> {
  const rows = await db
    .selectFrom('secret_provider')
    .select(['id', 'secret_enc'])
    .where('secret_enc', 'is not', null)
    .execute();
  for (const r of rows)
    await db
      .updateTable('secret_provider')
      .set({ secret_enc: again(r.secret_enc as string, providerContext(r.id)) })
      .where('id', '=', r.id)
      .execute();
  return rows.length;
}
