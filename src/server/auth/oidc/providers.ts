// OIDC providers people sign in with (AFS-30): kept in the database, the client secret sealed with
// the master key, each with the values of its groups claim that are server groups (or make an
// administrator). Administrators manage them; the sign-in page lists the enabled ones.
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Schema } from '../../db/schema';
import { open, seal } from '../../secrets/crypto';
import type { MasterKey } from '../../secrets/masterKey';
import type { Mapping, Provider, ProviderInput } from './types';

type Db = Kysely<Schema>;
const now = () => new Date().toISOString();
export const secretContext = (id: string) => `oidc:${id}`;

export type { Mapping, Provider, ProviderInput } from './types';

export class ProviderError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'taken',
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CLAIM = /^[A-Za-z0-9_.:/-]{1,100}$/;

/** What is wrong with an issuer: https, or http only for this machine (a provider being tried). */
export function issuerProblem(issuer: string): string | undefined {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return "The issuer is the provider's address, such as https://login.example.net/realms/net";
  }
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname))
    return undefined;
  return 'The issuer must be an https address';
}

function checked(input: ProviderInput, partial = false): string | undefined {
  if (!partial || input.key !== undefined)
    if (!KEY.test(input.key ?? ''))
      return 'key: lower-case letters, digits and dashes, up to 40 (it is in the sign-in address)';
  if ((!partial || input.name !== undefined) && !input.name?.trim())
    return 'name: a name people see';
  if (!partial || input.issuer !== undefined) {
    const p = issuerProblem(input.issuer ?? '');
    if (p) return `issuer: ${p}`;
  }
  if ((!partial || input.clientId !== undefined) && !input.clientId?.trim())
    return 'clientId: the client id the provider gave';
  for (const f of ['groupsClaim', 'loginClaim'] as const)
    if (input[f] !== undefined && !CLAIM.test(input[f] as string)) return `${f}: a claim name`;
  if (input.scopes !== undefined && !/(^|\s)openid(\s|$)/.test(input.scopes))
    return 'scopes: must include openid';
  for (const m of input.mappings ?? []) {
    if (!m.value?.trim() || m.value.length > 200) return 'mappings: each needs the claim value';
    if (!m.group && !m.admin) return `mappings: ${m.value} is neither a group nor administrator`;
  }
  return undefined;
}

type Row = Schema['oidc_provider'];

async function mappingsOf(db: Db, ids: string[]): Promise<Map<string, Mapping[]>> {
  const out = new Map<string, Mapping[]>();
  if (!ids.length) return out;
  const rows = await db
    .selectFrom('oidc_mapping')
    .selectAll()
    .where('provider_id', 'in', ids)
    .orderBy('claim_value')
    .execute();
  for (const r of rows) {
    const list = out.get(r.provider_id) ?? [];
    list.push({ value: r.claim_value, ...(r.group_id ? { group: r.group_id } : { admin: true }) });
    out.set(r.provider_id, list);
  }
  return out;
}

const providerOf = (r: Row, mappings: Mapping[]): Provider => ({
  id: r.id,
  key: r.key,
  name: r.name,
  issuer: r.issuer,
  clientId: r.client_id,
  hasSecret: r.secret_enc !== null,
  scopes: r.scopes,
  groupsClaim: r.groups_claim,
  loginClaim: r.login_claim,
  enabled: r.enabled === 1,
  mappings,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function listProviders(db: Db): Promise<Provider[]> {
  const rows = await db.selectFrom('oidc_provider').selectAll().orderBy('name').execute();
  const maps = await mappingsOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => providerOf(r, maps.get(r.id) ?? []));
}

export async function getProvider(db: Db, idOrKey: string): Promise<Provider | undefined> {
  const r = await db
    .selectFrom('oidc_provider')
    .selectAll()
    .where((eb) => eb.or([eb('id', '=', idOrKey), eb('key', '=', idOrKey)]))
    .executeTakeFirst();
  return r ? providerOf(r, (await mappingsOf(db, [r.id])).get(r.id) ?? []) : undefined;
}

/** The client secret of a provider, opened; undefined for a public client. */
export async function providerSecret(
  db: Db,
  key: MasterKey,
  id: string,
): Promise<string | undefined> {
  const r = await db
    .selectFrom('oidc_provider')
    .select('secret_enc')
    .where('id', '=', id)
    .executeTakeFirst();
  return r?.secret_enc ? open(key, r.secret_enc, secretContext(id)) : undefined;
}

async function knownGroups(db: Db, mappings: Mapping[]): Promise<void> {
  const ids = [...new Set(mappings.flatMap((m) => (m.group ? [m.group] : [])))];
  if (!ids.length) return;
  const have = await db.selectFrom('user_group').select('id').where('id', 'in', ids).execute();
  if (have.length !== ids.length)
    throw new ProviderError('invalid', 'mappings: one of the groups does not exist', 'mappings');
}

async function writeMappings(db: Db, id: string, mappings: Mapping[]): Promise<void> {
  await db.deleteFrom('oidc_mapping').where('provider_id', '=', id).execute();
  if (mappings.length)
    await db
      .insertInto('oidc_mapping')
      .values(
        mappings.map((m) => ({
          id: randomUUID(),
          provider_id: id,
          claim_value: m.value.trim(),
          group_id: m.group ?? null,
          admin: m.group ? 0 : 1,
        })),
      )
      .execute();
}

const fieldOf = (problem: string) => problem.slice(0, problem.indexOf(':'));

export async function createProvider(
  db: Db,
  key: MasterKey,
  input: ProviderInput,
): Promise<Provider> {
  const problem = checked(input);
  if (problem) throw new ProviderError('invalid', problem, fieldOf(problem));
  await knownGroups(db, input.mappings ?? []);
  const id = randomUUID();
  const at = now();
  await db.transaction().execute(async (trx) => {
    const done = await trx
      .insertInto('oidc_provider')
      .values({
        id,
        key: input.key,
        name: input.name.trim(),
        issuer: input.issuer.trim().replace(/\/+$/, ''),
        client_id: input.clientId.trim(),
        secret_enc: input.clientSecret ? seal(key, input.clientSecret, secretContext(id)) : null,
        scopes: input.scopes?.trim() || 'openid profile email',
        groups_claim: input.groupsClaim ?? 'groups',
        login_claim: input.loginClaim ?? 'preferred_username',
        enabled: input.enabled === false ? 0 : 1,
        created_at: at,
        updated_at: at,
      })
      .onConflict((c) => c.column('key').doNothing())
      .executeTakeFirst();
    if (!done.numInsertedOrUpdatedRows)
      throw new ProviderError('taken', `A provider with the key ${input.key} is there`, 'key');
    await writeMappings(trx, id, input.mappings ?? []);
  });
  return (await getProvider(db, id)) as Provider;
}

export async function updateProvider(
  db: Db,
  key: MasterKey,
  id: string,
  input: Partial<ProviderInput>,
): Promise<Provider> {
  const before = await getProvider(db, id);
  if (!before) throw new ProviderError('not_found', 'No such provider');
  const problem = checked(input as ProviderInput, true);
  if (problem) throw new ProviderError('invalid', problem, fieldOf(problem));
  if (input.mappings) await knownGroups(db, input.mappings);
  await db.transaction().execute(async (trx) => {
    const set: Partial<Row> = { updated_at: now() };
    if (input.key !== undefined) set.key = input.key;
    if (input.name !== undefined) set.name = input.name.trim();
    if (input.issuer !== undefined) set.issuer = input.issuer.trim().replace(/\/+$/, '');
    if (input.clientId !== undefined) set.client_id = input.clientId.trim();
    if (input.clientSecret !== undefined)
      set.secret_enc = input.clientSecret
        ? seal(key, input.clientSecret, secretContext(before.id))
        : null;
    if (input.scopes !== undefined) set.scopes = input.scopes.trim();
    if (input.groupsClaim !== undefined) set.groups_claim = input.groupsClaim;
    if (input.loginClaim !== undefined) set.login_claim = input.loginClaim;
    if (input.enabled !== undefined) set.enabled = input.enabled ? 1 : 0;
    try {
      await trx.updateTable('oidc_provider').set(set).where('id', '=', before.id).execute();
    } catch (e) {
      if (/unique|duplicate/i.test((e as Error).message))
        throw new ProviderError('taken', `A provider with the key ${input.key} is there`, 'key');
      throw e;
    }
    if (input.mappings) await writeMappings(trx, before.id, input.mappings);
  });
  return (await getProvider(db, before.id)) as Provider;
}

/**
 * Removes a provider. The people who signed in with it stay (an administrator may give them a
 * password, or remove them); the memberships and administrator rights it gave go.
 */
export async function deleteProvider(db: Db, id: string): Promise<void> {
  const before = await getProvider(db, id);
  if (!before) throw new ProviderError('not_found', 'No such provider');
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('group_member').where('source', '=', before.id).execute();
    await trx
      .updateTable('user_account')
      .set({ is_admin: 0, admin_source: null })
      .where('admin_source', '=', before.id)
      .execute();
    await trx.deleteFrom('oidc_provider').where('id', '=', before.id).execute();
  });
}

/** Re-seals every provider's secret with another key (`secrets rotate`). */
export async function resealProviders(
  db: Db,
  again: (sealed: string, context: string) => string,
): Promise<number> {
  const rows = await db
    .selectFrom('oidc_provider')
    .select(['id', 'secret_enc'])
    .where('secret_enc', 'is not', null)
    .execute();
  for (const r of rows)
    await db
      .updateTable('oidc_provider')
      .set({ secret_enc: again(r.secret_enc as string, secretContext(r.id)) })
      .where('id', '=', r.id)
      .execute();
  return rows.length;
}
