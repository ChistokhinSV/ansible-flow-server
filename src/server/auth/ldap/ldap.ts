// Signing in with an LDAP or Active Directory directory, and keeping people in step with it
// (AFS-31). Sign-in: the service account finds the person by the typed login, then the person's
// own DN and password are bound: the directory checks the password, the server never keeps it.
// Their groups become server groups (and administrator) by the directory's mappings. A sync, on
// a schedule, does the same for everyone the directory made, and disables those it no longer has.
import type { Kysely } from 'kysely';
import type { Schema } from '../../db/schema';
import type { Logger } from '../../log';
import type { MasterKey } from '../../secrets/masterKey';
import { applySource, ExternalError, makeAccount } from '../external';
import {
  BadCredentials,
  BINARY,
  type Connect,
  type DirectoryConnection,
  type DirectoryEntry,
  escapeFilter,
  idFilter,
  ldapConnect,
} from './client';
import { bindPassword, type Directory, getDirectory, listDirectories } from './directories';
import type { DirectoryTest } from './types';

type Db = Kysely<Schema>;
/** Active Directory's userAccountControl "account disabled" bit. */
const ACCOUNTDISABLE = 2;

export class DirectoryRefused extends Error {}

/** A group's name: the first RDN's value (CN=netops,OU=Groups,... is netops). */
export const groupName = (dn: string) =>
  /^[^=]+=((?:\\.|[^,])+)/.exec(dn)?.[1]?.replace(/\\(.)/g, '$1') ?? dn;

/** The server groups and the administrator right a directory's mappings give for these groups. */
export function mapped(d: Directory, groups: string[]): { groups: Set<string>; admin: boolean } {
  const names = new Set(groups.flatMap((g) => [g.toLowerCase(), groupName(g).toLowerCase()]));
  const hit = d.mappings.filter((m) => names.has(m.value.trim().toLowerCase()));
  return {
    groups: new Set(hit.filter((m) => m.group).map((m) => m.group as string)),
    admin: hit.some((m) => m.admin),
  };
}

interface Person {
  dn: string;
  id: string;
  login?: string;
  name?: string;
  email?: string;
  disabled: boolean;
  groups: string[];
}

export class LdapSignIn {
  constructor(private readonly deps: { db: Db; key: MasterKey; log: Logger; connect?: Connect }) {}

  private get connect(): Connect {
    return this.deps.connect ?? ldapConnect;
  }

  /** A connection with the service account bound (or anonymous without one). */
  private async service(d: Directory): Promise<DirectoryConnection> {
    const conn = await this.connect({ url: d.url, startTls: d.startTls });
    try {
      if (d.bindDn)
        await conn.bind(d.bindDn, (await bindPassword(this.deps.db, this.deps.key, d.id)) ?? '');
      return conn;
    } catch (e) {
      await conn.close();
      throw e;
    }
  }

  private attrs(d: Directory): string[] {
    return [
      d.idAttr,
      d.loginAttr,
      d.nameAttr,
      d.emailAttr,
      'memberOf',
      ...(d.adDisabled ? ['userAccountControl'] : []),
    ];
  }

  private binary(d: Directory): string[] {
    return BINARY.has(d.idAttr.toLowerCase()) ? [d.idAttr] : [];
  }

  /** What an entry says about the person, and their groups (DNs). */
  private async personOf(
    d: Directory,
    conn: DirectoryConnection,
    e: DirectoryEntry,
  ): Promise<Person> {
    const one = (a: string) => e.attrs[a.toLowerCase()]?.[0];
    const id = one(d.idAttr);
    if (!id)
      throw new DirectoryRefused(
        `The entry has no ${d.idAttr}: the directory's settings need a look`,
      );
    let groups = e.attrs.memberof ?? [];
    if (d.groupMode === 'search' && d.groupBase && d.groupFilter) {
      const found = await conn.search(
        d.groupBase,
        d.groupFilter.replaceAll('{dn}', escapeFilter(e.dn)),
        ['cn'],
      );
      groups = found.map((g) => g.dn);
    }
    const uac = Number(one('userAccountControl') ?? 0);
    return {
      dn: e.dn,
      id,
      ...(one(d.loginAttr) ? { login: one(d.loginAttr) } : {}),
      ...(one(d.nameAttr) ? { name: one(d.nameAttr) } : {}),
      ...(one(d.emailAttr) ? { email: one(d.emailAttr) } : {}),
      disabled: d.adDisabled && (uac & ACCOUNTDISABLE) !== 0,
      groups,
    };
  }

  /** The person's entry for a typed login: none, or exactly one. */
  private async find(
    d: Directory,
    conn: DirectoryConnection,
    login: string,
  ): Promise<DirectoryEntry | undefined> {
    const found = await conn.search(
      d.userBase,
      d.userFilter.replaceAll('{login}', escapeFilter(login)),
      this.attrs(d),
      {
        binary: this.binary(d),
        limit: 2,
      },
    );
    if (found.length > 1)
      throw new DirectoryRefused(`Two entries in ${d.name} answer to this login`);
    return found[0];
  }

  /**
   * Signs a person in with the directories, in order. Resolves with the account, or undefined when
   * no directory knows the login; rejects (DirectoryRefused) when one knows it and says no.
   */
  async authenticate(
    login: string,
    password: string,
  ): Promise<{ userId: string; login: string } | undefined> {
    // An empty password would be an anonymous bind, which many directories accept.
    if (!password || !login.trim()) return undefined;
    for (const d of (await listDirectories(this.deps.db)).filter((x) => x.enabled)) {
      let conn: DirectoryConnection | undefined;
      try {
        conn = await this.service(d);
        const entry = await this.find(d, conn, login.trim());
        if (!entry) continue;
        const person = await this.personOf(d, conn, entry);
        // The person's own password, on a connection of its own.
        const own = await this.connect({ url: d.url, startTls: d.startTls });
        try {
          await own.bind(entry.dn, password);
        } catch (e) {
          if (e instanceof BadCredentials)
            throw new DirectoryRefused('The login or the password is wrong');
          throw e;
        } finally {
          await own.close();
        }
        if (person.disabled) throw new DirectoryRefused('The account is disabled in the directory');
        return await this.apply(d, person, login.trim(), true);
      } catch (e) {
        if (e instanceof DirectoryRefused || e instanceof ExternalError) throw e;
        // A directory that does not answer: the next one is asked; the log says why.
        this.deps.log.warn({ err: e, directory: d.key }, 'A directory could not be asked');
      } finally {
        await conn?.close();
      }
    }
    return undefined;
  }

  /** Finds or makes the account for a directory's person, and sets what the directory says. */
  private async apply(
    d: Directory,
    person: Person,
    typed: string,
    signingIn: boolean,
  ): Promise<{ userId: string; login: string }> {
    const at = new Date().toISOString();
    const { groups, admin } = mapped(d, person.groups);
    return this.deps.db.transaction().execute(async (trx) => {
      const known = await trx
        .selectFrom('ldap_identity')
        .innerJoin('user_account', 'user_account.id', 'ldap_identity.user_id')
        .select([
          'user_account.id',
          'user_account.login',
          'user_account.disabled',
          'user_account.disabled_source',
          'user_account.service',
        ])
        .where('ldap_identity.directory_id', '=', d.id)
        .where('ldap_identity.object_id', '=', person.id)
        .executeTakeFirst();
      let userId: string;
      let login: string;
      if (known) {
        // Disabled here by hand: the directory does not undo that.
        if (known.service || (known.disabled && known.disabled_source !== d.id))
          throw new DirectoryRefused('This account is disabled here: ask an administrator');
        userId = known.id;
        login = known.login;
        await trx
          .updateTable('ldap_identity')
          .set({ dn: person.dn, last_at: at })
          .where('directory_id', '=', d.id)
          .where('object_id', '=', person.id)
          .execute();
        await trx
          .updateTable('user_account')
          .set({
            ...(person.name ? { name: person.name } : {}),
            ...(person.email ? { email: person.email } : {}),
            // Back in the directory: enabled again (only what the sync disabled).
            ...(known.disabled_source === d.id ? { disabled: 0, disabled_source: null } : {}),
            ...(signingIn ? { last_login_at: at } : {}),
            updated_at: at,
          })
          .where('id', '=', userId)
          .execute();
      } else {
        ({ userId, login } = await makeAccount(trx, {
          login: person.login ?? typed,
          ...(person.name ? { name: person.name } : {}),
          ...(person.email ? { email: person.email } : {}),
        }));
        await trx
          .insertInto('ldap_identity')
          .values({
            directory_id: d.id,
            object_id: person.id,
            dn: person.dn,
            user_id: userId,
            created_at: at,
            last_at: at,
          })
          .execute();
        this.deps.log.info(
          { login, directory: d.key },
          'A person signed in from a directory for the first time',
        );
      }
      await applySource(trx, userId, d.id, groups, admin);
      return { userId, login };
    });
  }

  /**
   * Brings everyone a directory made in step with it: name, email, groups, administrator; those it
   * no longer has (or has disabled) are disabled here. A directory that does not answer disables
   * nobody.
   */
  async sync(id: string): Promise<{ checked: number; disabled: number; message: string }> {
    const d = await getDirectory(this.deps.db, id);
    if (!d) throw new DirectoryRefused('No such directory');
    const people = await this.deps.db
      .selectFrom('ldap_identity')
      .innerJoin('user_account', 'user_account.id', 'ldap_identity.user_id')
      .select([
        'ldap_identity.object_id',
        'ldap_identity.user_id',
        'user_account.disabled',
        'user_account.disabled_source',
        'user_account.login',
      ])
      .where('ldap_identity.directory_id', '=', d.id)
      .execute();
    let checked = 0;
    let disabled = 0;
    let conn: DirectoryConnection | undefined;
    let message: string;
    try {
      conn = await this.service(d);
      for (const p of people) {
        const binary = BINARY.has(d.idAttr.toLowerCase());
        let found: DirectoryEntry[];
        try {
          found = await conn.search(
            d.userBase,
            idFilter(d.idAttr, p.object_id, binary),
            this.attrs(d),
            {
              binary: this.binary(d),
              limit: 2,
            },
          );
        } catch (e) {
          // One search that fails is not a person who left.
          this.deps.log.warn(
            { err: e, directory: d.key, login: p.login },
            'A person could not be looked up',
          );
          continue;
        }
        checked++;
        const entry = found[0];
        const person = entry ? await this.personOf(d, conn, entry) : undefined;
        if (!person || person.disabled) {
          if (!p.disabled) {
            await this.deps.db
              .updateTable('user_account')
              .set({ disabled: 1, disabled_source: d.id, updated_at: new Date().toISOString() })
              .where('id', '=', p.user_id)
              .execute();
            disabled++;
            this.deps.log.info(
              { login: p.login, directory: d.key },
              'Disabled: the directory no longer has this person',
            );
          }
          continue;
        }
        if (p.disabled && p.disabled_source !== d.id) continue;
        await this.apply(d, person, p.login, false);
      }
      message = `${checked} of ${people.length} people looked up${disabled ? `, ${disabled} disabled` : ''}`;
    } catch (e) {
      this.deps.log.error({ err: e, directory: d.key }, 'A directory sync failed');
      message = `The directory did not answer: ${(e as Error).message}`;
    } finally {
      await conn?.close();
    }
    await this.deps.db
      .updateTable('ldap_directory')
      .set({ last_sync_at: new Date().toISOString(), last_sync_result: message })
      .where('id', '=', d.id)
      .execute();
    return { checked, disabled, message };
  }

  /** Whether the service account binds and the bases answer; with a login, what is found for it. */
  async test(id: string, login?: string): Promise<DirectoryTest> {
    const d = await getDirectory(this.deps.db, id);
    if (!d) return { ok: false, message: 'No such directory' };
    let conn: DirectoryConnection | undefined;
    try {
      conn = await this.service(d);
      await conn.search(d.userBase, '(objectClass=*)', ['1.1'], { scope: 'base' });
      if (!login)
        return {
          ok: true,
          message: `Connected${d.bindDn ? ` as ${d.bindDn}` : ''}; ${d.userBase} answers`,
        };
      const entry = await this.find(d, conn, login);
      if (!entry) return { ok: true, message: `Connected; no entry for ${login} in ${d.userBase}` };
      const person = await this.personOf(d, conn, entry);
      const m = mapped(d, person.groups);
      const names = new Map(
        (await this.deps.db.selectFrom('user_group').select(['id', 'name']).execute()).map((g) => [
          g.id,
          g.name,
        ]),
      );
      return {
        ok: true,
        message: `Found ${login}`,
        person: {
          dn: person.dn,
          ...(person.login ? { login: person.login } : {}),
          ...(person.name ? { name: person.name } : {}),
          ...(person.email ? { email: person.email } : {}),
          disabled: person.disabled,
          groups: person.groups,
          mapped: [
            ...[...m.groups].map((g) => names.get(g) ?? g),
            ...(m.admin ? ['administrator'] : []),
          ],
        },
      };
    } catch (e) {
      return {
        ok: false,
        message:
          e instanceof BadCredentials
            ? 'The service account could not sign in: check its DN and password'
            : `The directory did not answer as expected: ${(e as Error).message}`,
      };
    } finally {
      await conn?.close();
    }
  }
}

/** Syncs the directories that are due, every minute; one at a time. */
export class DirectorySync {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly ldap: LdapSignIn,
    private readonly db: Db,
    private readonly log: Logger,
  ) {}

  start(everyMs = 60_000): void {
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const d of await listDirectories(this.db)) {
        if (!d.enabled || d.syncMinutes <= 0) continue;
        const last = d.lastSyncAt ? Date.parse(d.lastSyncAt) : 0;
        if (now - last < d.syncMinutes * 60_000) continue;
        await this.ldap.sync(d.id);
      }
    } catch (e) {
      this.log.error({ err: e }, 'The directory sync failed');
    } finally {
      this.running = false;
    }
  }
}
