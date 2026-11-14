// Sign-in with an LDAP directory (AFS-31), against a directory the test plays: entries, passwords,
// and the filters the server builds (equality, AND, the AD in-chain rule). A person signs in with
// the password form; their groups follow the directory's mappings; the sync disables those who
// left (their open session stops) and enables them when they are back.
import type { FastifyInstance } from 'fastify';
import { EqualityFilter } from 'ldapts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import {
  BadCredentials,
  binaryEquality,
  type Connect,
  type DirectoryEntry,
  idFilter,
} from '../../src/server/auth/ldap/client';
import { groupName } from '../../src/server/auth/ldap/ldap';
import { createGroup, createUser, updateUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';

const PASSWORD = 'correct horse battery staple';
const SERVICE = { dn: 'cn=svc-flows,ou=services,dc=example,dc=net', password: 'svc-s3cret' };

/** The directory: entries by DN, passwords by DN, and whether it answers at all. */
function directory() {
  const entries = new Map<string, Record<string, string[]>>();
  const passwords = new Map<string, string>([[SERVICE.dn, SERVICE.password]]);
  const state = { down: false, binds: [] as string[] };
  const decode = (v: string) =>
    v.replace(/\\([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)));
  /** Every (attr=value) of the filter must hold (the filters this server builds are ANDs). */
  const matches = (attrs: Record<string, string[]>, dn: string, filter: string) => {
    const terms = [...filter.matchAll(/\(([A-Za-z][\w-]*)(:[\d.]+:)?=([^()]*)\)/g)];
    return (
      terms.every(([, name, rule, raw]) => {
        const attr = (name as string).toLowerCase();
        let value = decode(raw as string);
        if (attr === 'objectguid') value = Buffer.from(value, 'latin1').toString('hex');
        if (raw === '*') return attr in attrs || attr === 'objectclass';
        if (rule) return (attrs[attr] ?? []).some((v) => v.toLowerCase() === value.toLowerCase());
        return (attrs[attr] ?? []).some((v) => v.toLowerCase() === value.toLowerCase());
      }) && dn.length > 0
    );
  };
  const connect: Connect = async () => {
    if (state.down) throw new Error('connect ECONNREFUSED 192.0.2.10:636');
    return {
      async bind(dn, password) {
        state.binds.push(dn);
        if (!password || passwords.get(dn) !== password)
          throw new BadCredentials('Wrong DN or password');
      },
      async search(base, filter, attributes, options = {}) {
        const out: DirectoryEntry[] = [];
        for (const [dn, attrs] of entries) {
          const inBase =
            options.scope === 'base' ? dn === base : dn.toLowerCase().endsWith(base.toLowerCase());
          if (inBase && (options.scope === 'base' || matches(attrs, dn, filter)))
            out.push({
              dn,
              attrs: Object.fromEntries(
                Object.entries(attrs).filter(
                  ([k]) =>
                    attributes.map((a) => a.toLowerCase()).includes(k) || k === 'objectclass',
                ),
              ),
            });
        }
        if (options.scope === 'base' && !out.length && base) out.push({ dn: base, attrs: {} });
        return out;
      },
      async close() {},
    };
  };
  return { entries, passwords, state, connect };
}

describe('sign-in with an LDAP directory', () => {
  const ldap = directory();
  let database: Database;
  let app: FastifyInstance;
  let admin: string;
  let netops: string;
  let dirId: string;
  const bytes = newKey();
  const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
  const cookieOf = (setCookie: string | string[] | undefined) =>
    /afs_session=[^;]*/.exec([setCookie].flat().join(';'))?.[0] ?? '';
  const call = (method: string, url: string, cookie?: string, body?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  const signIn = (login: string, password: string) =>
    call('POST', '/api/v1/session', undefined, { login, password });
  const MIA = 'uid=mia,ou=people,dc=example,dc=net';

  beforeAll(async () => {
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    app = buildApp({
      log: createLogger({ level: 'error', format: 'json', write: () => undefined }),
      database,
      instance: 'test',
      masterKey: key,
      ldapConnect: ldap.connect,
    });
    await createUser(database.db, { login: 'dana', name: 'Dana', password: PASSWORD, admin: true });
    netops = (await createGroup(database.db, { name: 'netops' })).id;
    admin = cookieOf((await signIn('dana', PASSWORD)).headers['set-cookie']);
    ldap.entries.set(MIA, {
      objectclass: ['inetOrgPerson'],
      uid: ['mia'],
      cn: ['Mia Ortega'],
      mail: ['mia@example.net'],
      entryuuid: ['0b6c3e0e-1111-4c1e-9d55-2f6a1d4b8e90'],
    });
    ldap.passwords.set(MIA, 'mia-directory-pw');
    for (const g of ['netops', 'flows-admins'])
      ldap.entries.set(`cn=${g},ou=groups,dc=example,dc=net`, {
        objectclass: ['groupOfNames'],
        cn: [g],
        member: [MIA],
      });
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  it('an administrator adds a directory; a test finds a person and what they are here', async () => {
    const made = await call('POST', '/api/v1/admin/ldap-directories', admin, {
      key: 'corp',
      name: 'Corp LDAP',
      url: 'ldaps://ldap.example.net:636',
      bindDn: SERVICE.dn,
      bindPassword: SERVICE.password,
      userBase: 'ou=people,dc=example,dc=net',
      userFilter: '(&(objectClass=inetOrgPerson)(uid={login}))',
      groupMode: 'search',
      groupBase: 'ou=groups,dc=example,dc=net',
      groupFilter: '(&(objectClass=groupOfNames)(member={dn}))',
      mappings: [
        { value: 'netops', group: netops },
        { value: 'CN=flows-admins,OU=groups,DC=example,DC=net', admin: true },
      ],
    });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ key: 'corp', hasBindPassword: true, idAttr: 'entryUUID' });
    expect(made.body).not.toContain(SERVICE.password);
    dirId = made.json().id;
    // Passwords never in clear over the network: ldap:// needs StartTLS.
    const clear = await call('POST', '/api/v1/admin/ldap-directories', admin, {
      key: 'clear',
      name: 'Clear',
      url: 'ldap://ldap.example.net:389',
      userBase: 'dc=example,dc=net',
    });
    expect(clear.json()).toMatchObject({ error: 'invalid', field: 'url' });

    const test = await call('POST', `/api/v1/admin/ldap-directories/${dirId}/test`, admin, {
      login: 'mia',
    });
    expect(test.json()).toMatchObject({
      ok: true,
      person: { dn: MIA, name: 'Mia Ortega', disabled: false, mapped: ['netops', 'administrator'] },
    });
  });

  it('a person signs in with the password form; local accounts never ask the directory', async () => {
    expect((await signIn('mia', 'wrong')).statusCode).toBe(401);
    expect((await signIn('nobody', 'whatever')).statusCode).toBe(401);
    // A login that is a filter: escaped, so it finds nothing.
    expect((await signIn('*', 'mia-directory-pw')).statusCode).toBe(401);
    const ok = await signIn('Mia', 'mia-directory-pw');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      login: 'mia',
      name: 'Mia Ortega',
      email: 'mia@example.net',
      admin: true,
      groups: ['netops'],
    });

    ldap.state.binds = [];
    expect((await signIn('dana', PASSWORD)).statusCode).toBe(200);
    expect(ldap.state.binds).toEqual([]);
    expect(groupName('CN=Net\\, Ops,OU=Groups,DC=example,DC=net')).toBe('Net, Ops');
  });

  it('the sync disables who left (their session stops), and enables them when they are back', async () => {
    const mia = cookieOf((await signIn('mia', 'mia-directory-pw')).headers['set-cookie']);
    expect((await call('GET', '/api/v1/session', mia)).statusCode).toBe(200);
    const kept = ldap.entries.get(MIA) as Record<string, string[]>;
    ldap.entries.delete(MIA);
    const sync = await call('POST', `/api/v1/admin/ldap-directories/${dirId}/sync`, admin);
    expect(sync.json()).toMatchObject({ checked: 1, disabled: 1 });
    // Signed in or not: the next request is refused.
    expect((await call('GET', '/api/v1/session', mia)).statusCode).toBe(401);

    ldap.entries.set(MIA, kept);
    await call('POST', `/api/v1/admin/ldap-directories/${dirId}/sync`, admin);
    const back = await signIn('mia', 'mia-directory-pw');
    expect(back.statusCode).toBe(200);

    // Disabled here by hand: neither the sync nor a sign-in undoes that.
    await updateUser(database.db, back.json().id, { disabled: true });
    await call('POST', `/api/v1/admin/ldap-directories/${dirId}/sync`, admin);
    expect((await signIn('mia', 'mia-directory-pw')).statusCode).toBe(401);
    await updateUser(database.db, back.json().id, { disabled: false });

    // A directory that does not answer disables nobody.
    ldap.state.down = true;
    const down = await call('POST', `/api/v1/admin/ldap-directories/${dirId}/sync`, admin);
    expect(down.json()).toMatchObject({
      disabled: 0,
      message: expect.stringMatching(/did not answer/),
    });
    ldap.state.down = false;
    expect((await signIn('mia', 'mia-directory-pw')).statusCode).toBe(200);
    const list = (await call('GET', '/api/v1/admin/ldap-directories', admin)).json();
    expect(list[0].lastSyncResult).toMatch(/did not answer/);
  });

  it('Active Directory: an account disabled there cannot sign in', async () => {
    const BOB = 'CN=Bob Lane,OU=Staff,DC=corp,DC=example,DC=net';
    ldap.entries.set(BOB, {
      objectclass: ['user'],
      objectcategory: ['person'],
      samaccountname: ['bob'],
      displayname: ['Bob Lane'],
      objectguid: ['4f2a0d0e9b1c4e5f8a7b6c5d4e3f2a1b'],
      useraccountcontrol: ['514'],
    });
    ldap.passwords.set(BOB, 'bob-pw');
    const ad = await call('POST', '/api/v1/admin/ldap-directories', admin, {
      key: 'ad',
      name: 'Corp AD',
      url: 'ldaps://dc1.corp.example.net',
      bindDn: SERVICE.dn,
      bindPassword: SERVICE.password,
      userBase: 'OU=Staff,DC=corp,DC=example,DC=net',
      userFilter: '(&(objectCategory=person)(objectClass=user)(sAMAccountName={login}))',
      idAttr: 'objectGUID',
      loginAttr: 'sAMAccountName',
      nameAttr: 'displayName',
      groupMode: 'memberof',
      adDisabled: true,
    });
    expect(ad.statusCode).toBe(201);
    expect((await signIn('bob', 'bob-pw')).statusCode).toBe(401);
    (ldap.entries.get(BOB) as Record<string, string[]>).useraccountcontrol = ['512'];
    const ok = await signIn('bob', 'bob-pw');
    expect(ok.json()).toMatchObject({ login: 'bob', name: 'Bob Lane' });
    // Found again by objectGUID (a binary id) at the next sync.
    const sync = await call('POST', `/api/v1/admin/ldap-directories/${ad.json().id}/sync`, admin);
    expect(sync.json()).toMatchObject({ checked: 1, disabled: 0 });
  });
});

describe('ids that are bytes', () => {
  it('an objectGUID filter goes to the directory as the bytes, not as UTF-8 text', () => {
    const guid = '0ab3c8aa0dc5534ab69ebf85d0a2c78b';
    const filter = binaryEquality(idFilter('objectGUID', guid, true), ['objectGUID']);
    expect(filter).toBeInstanceOf(EqualityFilter);
    expect(((filter as EqualityFilter).value as Buffer).toString('hex')).toBe(guid);
    // Text ids and other filters stay strings.
    expect(binaryEquality('(entryUUID=0b6c3e0e)', ['objectGUID'])).toBe('(entryUUID=0b6c3e0e)');
    expect(binaryEquality('(&(a=b)(objectGUID=\\0a))', ['objectGUID'])).toBeTypeOf('string');
  });
});
