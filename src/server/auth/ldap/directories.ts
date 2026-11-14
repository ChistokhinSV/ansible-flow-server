// LDAP and Active Directory directories (AFS-31): kept in the database, the service account's
// password sealed with the master key, each with the directory groups that are server groups (or
// make an administrator). Administrators manage them; sign-in tries the enabled ones in order.
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Schema } from '../../db/schema';
import { open, seal } from '../../secrets/crypto';
import type { MasterKey } from '../../secrets/masterKey';
import { forgetSource } from '../external';
import type { Directory, DirectoryInput, DirectoryMapping } from './types';

export type { Directory, DirectoryInput, DirectoryMapping };

type Db = Kysely<Schema>;
type Row = Schema['ldap_directory'];
const now = () => new Date().toISOString();
export const passwordContext = (id: string) => `ldap:${id}`;

export class DirectoryError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'taken',
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ATTR = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

/** What is wrong with a directory's address: ldaps://, or ldap:// with StartTLS (or loopback). */
export function urlProblem(url: string, startTls: boolean): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'url: ldaps://dc1.example.net:636, or ldap://ldap.example.net:389 with StartTLS';
  }
  if (u.protocol === 'ldaps:') return undefined;
  if (u.protocol !== 'ldap:') return 'url: an ldaps:// or ldap:// address';
  // A password never crosses the network in clear: StartTLS, or a directory on this machine.
  if (startTls || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return undefined;
  return 'url: ldap:// needs StartTLS (passwords must not cross the network in clear); or use ldaps://';
}

function checked(input: Partial<DirectoryInput>, partial: boolean, before?: Directory) {
  const v = <K extends keyof DirectoryInput>(k: K) =>
    input[k] ?? (before?.[k as keyof Directory] as DirectoryInput[K]);
  if (!partial || input.key !== undefined)
    if (!KEY.test(input.key ?? '')) return 'key: lower-case letters, digits and dashes, up to 40';
  if ((!partial || input.name !== undefined) && !input.name?.trim())
    return 'name: a name people see';
  if (!partial || input.url !== undefined || input.startTls !== undefined) {
    const p = urlProblem(String(v('url') ?? ''), !!v('startTls'));
    if (p) return p;
  }
  if ((!partial || input.userBase !== undefined) && !input.userBase?.trim())
    return 'userBase: where people are, e.g. OU=Staff,DC=example,DC=net';
  const filter = v('userFilter');
  if (filter !== undefined && !String(filter).includes('{login}'))
    return 'userFilter: must hold {login}, where the typed login goes';
  for (const f of ['idAttr', 'loginAttr', 'nameAttr', 'emailAttr'] as const)
    if (input[f] !== undefined && !ATTR.test(input[f] as string)) return `${f}: an attribute name`;
  const mode = v('groupMode');
  if (mode === 'search') {
    if (!String(v('groupBase') ?? '').trim()) return 'groupBase: where the groups are';
    if (!String(v('groupFilter') ?? '').includes('{dn}'))
      return "groupFilter: must hold {dn}, where the person's DN goes";
  }
  if (input.syncMinutes !== undefined && (input.syncMinutes < 0 || input.syncMinutes > 7 * 24 * 60))
    return 'syncMinutes: 0 (only at sign-in) to a week';
  if (input.bindPassword && !String(v('bindDn') ?? '').trim())
    return 'bindDn: the service account the password is for';
  for (const m of input.mappings ?? []) {
    if (!m.value?.trim() || m.value.length > 500) return 'mappings: each needs the group';
    if (!m.group && !m.admin) return `mappings: ${m.value} is neither a group nor administrator`;
  }
  return undefined;
}

async function mappingsOf(db: Db, ids: string[]): Promise<Map<string, DirectoryMapping[]>> {
  const out = new Map<string, DirectoryMapping[]>();
  if (!ids.length) return out;
  const rows = await db
    .selectFrom('ldap_mapping')
    .selectAll()
    .where('directory_id', 'in', ids)
    .orderBy('group_value')
    .execute();
  for (const r of rows) {
    const list = out.get(r.directory_id) ?? [];
    list.push({ value: r.group_value, ...(r.group_id ? { group: r.group_id } : { admin: true }) });
    out.set(r.directory_id, list);
  }
  return out;
}

const directoryOf = (r: Row, mappings: DirectoryMapping[]): Directory => ({
  id: r.id,
  key: r.key,
  name: r.name,
  position: r.position,
  url: r.url,
  startTls: r.start_tls === 1,
  ...(r.bind_dn ? { bindDn: r.bind_dn } : {}),
  hasBindPassword: r.bind_password_enc !== null,
  userBase: r.user_base,
  userFilter: r.user_filter,
  idAttr: r.id_attr,
  loginAttr: r.login_attr,
  nameAttr: r.name_attr,
  emailAttr: r.email_attr,
  groupMode: r.group_mode,
  ...(r.group_base ? { groupBase: r.group_base } : {}),
  ...(r.group_filter ? { groupFilter: r.group_filter } : {}),
  adDisabled: r.ad_disabled === 1,
  syncMinutes: r.sync_minutes,
  enabled: r.enabled === 1,
  mappings,
  ...(r.last_sync_at ? { lastSyncAt: r.last_sync_at } : {}),
  ...(r.last_sync_result ? { lastSyncResult: r.last_sync_result } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function listDirectories(db: Db): Promise<Directory[]> {
  const rows = await db
    .selectFrom('ldap_directory')
    .selectAll()
    .orderBy('position')
    .orderBy('name')
    .execute();
  const maps = await mappingsOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => directoryOf(r, maps.get(r.id) ?? []));
}

export async function getDirectory(db: Db, idOrKey: string): Promise<Directory | undefined> {
  const r = await db
    .selectFrom('ldap_directory')
    .selectAll()
    .where((eb) => eb.or([eb('id', '=', idOrKey), eb('key', '=', idOrKey)]))
    .executeTakeFirst();
  return r ? directoryOf(r, (await mappingsOf(db, [r.id])).get(r.id) ?? []) : undefined;
}

/** The service account's password, opened; undefined without one. */
export async function bindPassword(
  db: Db,
  key: MasterKey,
  id: string,
): Promise<string | undefined> {
  const r = await db
    .selectFrom('ldap_directory')
    .select('bind_password_enc')
    .where('id', '=', id)
    .executeTakeFirst();
  return r?.bind_password_enc ? open(key, r.bind_password_enc, passwordContext(id)) : undefined;
}

async function knownGroups(db: Db, mappings: DirectoryMapping[]): Promise<void> {
  const ids = [...new Set(mappings.flatMap((m) => (m.group ? [m.group] : [])))];
  if (!ids.length) return;
  const have = await db.selectFrom('user_group').select('id').where('id', 'in', ids).execute();
  if (have.length !== ids.length)
    throw new DirectoryError('invalid', 'mappings: one of the groups does not exist', 'mappings');
}

async function writeMappings(db: Db, id: string, mappings: DirectoryMapping[]): Promise<void> {
  await db.deleteFrom('ldap_mapping').where('directory_id', '=', id).execute();
  if (mappings.length)
    await db
      .insertInto('ldap_mapping')
      .values(
        mappings.map((m) => ({
          id: randomUUID(),
          directory_id: id,
          group_value: m.value.trim(),
          group_id: m.group ?? null,
          admin: m.group ? 0 : 1,
        })),
      )
      .execute();
}

const fieldOf = (problem: string) => problem.slice(0, problem.indexOf(':'));

export async function createDirectory(
  db: Db,
  key: MasterKey,
  input: DirectoryInput,
): Promise<Directory> {
  const problem = checked(input, false);
  if (problem) throw new DirectoryError('invalid', problem, fieldOf(problem));
  await knownGroups(db, input.mappings ?? []);
  const id = randomUUID();
  const at = now();
  const last = await db
    .selectFrom('ldap_directory')
    .select((eb) => eb.fn.max('position').as('p'))
    .executeTakeFirst();
  await db.transaction().execute(async (trx) => {
    const done = await trx
      .insertInto('ldap_directory')
      .values({
        id,
        key: input.key,
        name: input.name.trim(),
        position: input.position ?? Number(last?.p ?? 0) + 1,
        url: input.url.trim(),
        start_tls: input.startTls ? 1 : 0,
        bind_dn: input.bindDn?.trim() || null,
        bind_password_enc: input.bindPassword
          ? seal(key, input.bindPassword, passwordContext(id))
          : null,
        user_base: input.userBase.trim(),
        user_filter: input.userFilter ?? '(&(objectClass=inetOrgPerson)(uid={login}))',
        id_attr: input.idAttr ?? 'entryUUID',
        login_attr: input.loginAttr ?? 'uid',
        name_attr: input.nameAttr ?? 'cn',
        email_attr: input.emailAttr ?? 'mail',
        group_mode: input.groupMode ?? 'memberof',
        group_base: input.groupBase?.trim() || null,
        group_filter: input.groupFilter?.trim() || null,
        ad_disabled: input.adDisabled ? 1 : 0,
        sync_minutes: input.syncMinutes ?? 60,
        enabled: input.enabled === false ? 0 : 1,
        last_sync_at: null,
        last_sync_result: null,
        created_at: at,
        updated_at: at,
      })
      .onConflict((c) => c.column('key').doNothing())
      .executeTakeFirst();
    if (!done.numInsertedOrUpdatedRows)
      throw new DirectoryError('taken', `A directory with the key ${input.key} is there`, 'key');
    await writeMappings(trx, id, input.mappings ?? []);
  });
  return (await getDirectory(db, id)) as Directory;
}

export async function updateDirectory(
  db: Db,
  key: MasterKey,
  id: string,
  input: Partial<DirectoryInput>,
): Promise<Directory> {
  const before = await getDirectory(db, id);
  if (!before) throw new DirectoryError('not_found', 'No such directory');
  const problem = checked(input, true, before);
  if (problem) throw new DirectoryError('invalid', problem, fieldOf(problem));
  if (input.mappings) await knownGroups(db, input.mappings);
  await db.transaction().execute(async (trx) => {
    const set: Partial<Row> = { updated_at: now() };
    if (input.key !== undefined) set.key = input.key;
    if (input.name !== undefined) set.name = input.name.trim();
    if (input.position !== undefined) set.position = input.position;
    if (input.url !== undefined) set.url = input.url.trim();
    if (input.startTls !== undefined) set.start_tls = input.startTls ? 1 : 0;
    if (input.bindDn !== undefined) set.bind_dn = input.bindDn?.trim() || null;
    if (input.bindPassword !== undefined)
      set.bind_password_enc = input.bindPassword
        ? seal(key, input.bindPassword, passwordContext(before.id))
        : null;
    if (input.userBase !== undefined) set.user_base = input.userBase.trim();
    if (input.userFilter !== undefined) set.user_filter = input.userFilter;
    if (input.idAttr !== undefined) set.id_attr = input.idAttr;
    if (input.loginAttr !== undefined) set.login_attr = input.loginAttr;
    if (input.nameAttr !== undefined) set.name_attr = input.nameAttr;
    if (input.emailAttr !== undefined) set.email_attr = input.emailAttr;
    if (input.groupMode !== undefined) set.group_mode = input.groupMode;
    if (input.groupBase !== undefined) set.group_base = input.groupBase?.trim() || null;
    if (input.groupFilter !== undefined) set.group_filter = input.groupFilter?.trim() || null;
    if (input.adDisabled !== undefined) set.ad_disabled = input.adDisabled ? 1 : 0;
    if (input.syncMinutes !== undefined) set.sync_minutes = input.syncMinutes;
    if (input.enabled !== undefined) set.enabled = input.enabled ? 1 : 0;
    try {
      await trx.updateTable('ldap_directory').set(set).where('id', '=', before.id).execute();
    } catch (e) {
      if (/unique|duplicate/i.test((e as Error).message))
        throw new DirectoryError('taken', `A directory with the key ${input.key} is there`, 'key');
      throw e;
    }
    if (input.mappings) await writeMappings(trx, before.id, input.mappings);
  });
  return (await getDirectory(db, before.id)) as Directory;
}

/**
 * Removes a directory. Its people stay (they keep what was given here by hand); the groups and
 * administrator rights it gave go, and the accounts its sync disabled are enabled again.
 */
export async function deleteDirectory(db: Db, id: string): Promise<void> {
  const before = await getDirectory(db, id);
  if (!before) throw new DirectoryError('not_found', 'No such directory');
  await db.transaction().execute(async (trx) => {
    await forgetSource(trx, before.id);
    await trx.deleteFrom('ldap_directory').where('id', '=', before.id).execute();
  });
}

/** Re-seals every directory's bind password with another key (`secrets rotate`). */
export async function resealDirectories(
  db: Db,
  again: (sealed: string, context: string) => string,
): Promise<number> {
  const rows = await db
    .selectFrom('ldap_directory')
    .select(['id', 'bind_password_enc'])
    .where('bind_password_enc', 'is not', null)
    .execute();
  for (const r of rows)
    await db
      .updateTable('ldap_directory')
      .set({ bind_password_enc: again(r.bind_password_enc as string, passwordContext(r.id)) })
      .where('id', '=', r.id)
      .execute();
  return rows.length;
}
