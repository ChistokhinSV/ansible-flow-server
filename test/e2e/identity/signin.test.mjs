// Sign-in with the identity lab (test/e2e/labs/identity): OIDC through Keycloak and LDAP through
// OpenLDAP, against a running server. It adds an OIDC provider, an LDAP directory and three groups
// (names starting e2e-), signs the lab's people in and checks the groups the mappings give, that a
// group added by hand stays, and that what the provider no longer says is taken back. It removes
// what it made, the people included. Run by on-vm.mjs, where TLS is not intercepted.
// Settings (environment):
//   AFS_URL        the server, as AFS_PUBLIC_URL names it (Keycloak sends the browser back there)
//   AFS_SESSION    an administrator's session cookie (identity settings take a session, not a token)
//   AFS_IDENTITY_LAB  the lab's out folder (people.txt, oidc-client-secret, ldap-admin-password)
//   AFS_IDENTITY_LAB_HOST  the address the lab's ports are published on
// NODE_EXTRA_CA_CERTS must hold the server's certificate and the lab CA.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Set ${k}`);
  return v;
};
const BASE = env('AFS_URL').replace(/\/+$/, '');
const SESSION = env('AFS_SESSION');
const LAB = env('AFS_IDENTITY_LAB');
const HOST = env('AFS_IDENTITY_LAB_HOST');
const lab = (f) => readFileSync(join(LAB, f), 'utf8').trim();
const people = Object.fromEntries(
  lab('people.txt')
    .split('\n')
    .map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)]),
);
const KEY = 'e2e-keycloak';

async function api(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie: SESSION,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}
const items = (r) => (Array.isArray(r) ? r : (Object.values(r ?? {}).find(Array.isArray) ?? []));

/** A cookie jar per host, enough for the server and Keycloak. */
class Jar {
  #c = new Map();
  take(url, res) {
    const host = new URL(url).host;
    const m = this.#c.get(host) ?? new Map();
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      m.set(pair.slice(0, i), pair.slice(i + 1));
    }
    this.#c.set(host, m);
  }
  header(url) {
    const m = this.#c.get(new URL(url).host);
    return m ? [...m].map(([k, v]) => `${k}=${v}`).join('; ') : '';
  }
}

async function go(jar, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    redirect: 'manual',
    headers: { ...(init.headers ?? {}), cookie: jar.header(url) },
  });
  jar.take(url, res);
  return res;
}

/** Signs in through Keycloak as a browser would; returns the server session's cookie header. */
async function oidcSignIn(login) {
  const jar = new Jar();
  let res = await go(jar, `${BASE}/api/v1/auth/oidc/${KEY}/start`);
  assert.equal(res.status, 302, 'start sends the browser to the provider');
  let at = res.headers.get('location');
  assert.ok(at.startsWith(`https://${HOST}:18843/`), `to Keycloak: ${at}`);
  assert.match(at, /code_challenge=/, 'with PKCE');
  res = await go(jar, at);
  const html = await res.text();
  const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html)?.[1];
  assert.ok(action, 'Keycloak shows its login form');
  const post = action.replaceAll('&amp;', '&');
  res = await go(jar, post, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: login, password: people[login], credentialId: '' }),
  });
  assert.equal(res.status, 302, 'Keycloak accepts the password');
  at = res.headers.get('location');
  assert.ok(at.startsWith(`${BASE}/api/v1/auth/oidc/${KEY}/callback`), `back to the server: ${at}`);
  res = await go(jar, at);
  assert.equal(res.status, 302);
  assert.doesNotMatch(res.headers.get('location') ?? '', /error=/, 'the callback signs in');
  return jar.header(BASE);
}

async function ldapSignIn(login) {
  const r = await fetch(`${BASE}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password: people[login] }),
  });
  assert.equal(r.status, 200, `LDAP sign-in of ${login}: ${r.status}`);
  return r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

async function me(cookie) {
  const r = await fetch(`${BASE}/api/v1/session`, { headers: { cookie } });
  assert.equal(r.status, 200);
  return r.json();
}

const made = { groups: {}, provider: undefined, directory: undefined, users: new Set() };
const userId = async (login) => {
  const u = items(await api('GET', '/api/v1/users')).find((x) => x.login === login);
  if (u) made.users.add(u.id);
  return u?.id;
};

before(async () => {
  // A run that stopped half way leaves these: start clean.
  for (const p of items(await api('GET', '/api/v1/admin/oidc-providers')))
    if (p.key === KEY) await api('DELETE', `/api/v1/admin/oidc-providers/${p.id}`);
  for (const d of items(await api('GET', '/api/v1/admin/ldap-directories')))
    if (d.key === 'e2e-openldap') await api('DELETE', `/api/v1/admin/ldap-directories/${d.id}`);
  for (const g of items(await api('GET', '/api/v1/groups')))
    if (g.name.startsWith('e2e-')) await api('DELETE', `/api/v1/groups/${g.id}`);
  for (const u of items(await api('GET', '/api/v1/users')))
    if (u.login in people) await api('DELETE', `/api/v1/users/${u.id}`);
  for (const name of ['e2e-net-ops', 'e2e-change-board', 'e2e-by-hand'])
    made.groups[name] = (await api('POST', '/api/v1/groups', { name })).id;
});

after(async () => {
  const quiet = (p) => p.catch(() => undefined);
  if (made.provider) await quiet(api('DELETE', `/api/v1/admin/oidc-providers/${made.provider}`));
  if (made.directory)
    await quiet(api('DELETE', `/api/v1/admin/ldap-directories/${made.directory}`));
  for (const id of made.users) await quiet(api('DELETE', `/api/v1/users/${id}`));
  for (const id of Object.values(made.groups)) await quiet(api('DELETE', `/api/v1/groups/${id}`));
});

test('OIDC: the provider test finds Keycloak, with PKCE', async () => {
  const p = await api('POST', '/api/v1/admin/oidc-providers', {
    key: KEY,
    name: 'Lab Keycloak',
    issuer: `https://${HOST}:18843/realms/afs-lab`,
    clientId: 'afs',
    clientSecret: lab('oidc-client-secret'),
    groupsClaim: 'groups',
    loginClaim: 'preferred_username',
    mappings: [
      { value: 'net-ops', group: made.groups['e2e-net-ops'] },
      { value: 'change-board', group: made.groups['e2e-change-board'] },
      { value: 'afs-admins', admin: true },
    ],
  });
  made.provider = p.id;
  const t = await api('POST', `/api/v1/admin/oidc-providers/${p.id}/test`);
  assert.equal(t.ok, true, t.message);
  assert.equal(t.pkce, true);
  const methods = await (await fetch(`${BASE}/api/v1/auth/methods`)).json();
  assert.ok(
    methods.providers.some((x) => x.key === KEY),
    'the sign-in page offers it',
  );
});

test('OIDC: sign-in gives the mapped groups and administrator', async () => {
  const sam = await me(await oidcSignIn('sam.reyes'));
  assert.equal(sam.login, 'sam.reyes');
  assert.deepEqual(sam.groups, ['e2e-net-ops']);
  assert.equal(sam.admin, false);
  const lee = await me(await oidcSignIn('lee.okafor'));
  assert.deepEqual(lee.groups, ['e2e-net-ops']);
  assert.equal(lee.admin, true, 'afs-admins maps to administrator');
});

test('OIDC: a group added by hand stays; what the provider stops saying is taken back', async () => {
  const sam = await userId('sam.reyes');
  await userId('lee.okafor');
  await api('PUT', `/api/v1/groups/${made.groups['e2e-by-hand']}/members`, { users: [sam] });
  const p = await api('GET', `/api/v1/admin/oidc-providers/${made.provider}`);
  await api('PATCH', `/api/v1/admin/oidc-providers/${made.provider}`, {
    mappings: p.mappings.filter((m) => m.value !== 'net-ops'),
  });
  const again = await me(await oidcSignIn('sam.reyes'));
  assert.deepEqual(again.groups, ['e2e-by-hand']);
});

test('LDAP: ldaps:// and StartTLS directories test ok', async () => {
  const d = await api('POST', '/api/v1/admin/ldap-directories', {
    key: 'e2e-openldap',
    name: 'Lab OpenLDAP',
    url: `ldaps://${HOST}:10636`,
    bindDn: 'cn=admin,dc=example,dc=net',
    bindPassword: lab('ldap-admin-password'),
    userBase: 'ou=people,dc=example,dc=net',
    userFilter: '(uid={login})',
    idAttr: 'uid',
    loginAttr: 'uid',
    nameAttr: 'cn',
    emailAttr: 'mail',
    groupMode: 'search',
    groupBase: 'ou=groups,dc=example,dc=net',
    groupFilter: '(member={dn})',
    mappings: [
      {
        value: 'cn=change-board,ou=groups,dc=example,dc=net',
        group: made.groups['e2e-change-board'],
      },
      { value: 'afs-admins', admin: true },
    ],
  });
  made.directory = d.id;
  const t = await api('POST', `/api/v1/admin/ldap-directories/${d.id}/test`, {
    login: 'nora.lind',
  });
  assert.equal(t.ok, true, t.message);
  await api('PATCH', `/api/v1/admin/ldap-directories/${d.id}`, {
    url: `ldap://${HOST}:10389`,
    startTls: true,
  });
  const s = await api('POST', `/api/v1/admin/ldap-directories/${d.id}/test`, {
    login: 'nora.lind',
  });
  assert.equal(s.ok, true, s.message);
});

test('LDAP: sign-in gives the mapped groups, mapped by DN', async () => {
  const nora = await me(await ldapSignIn('nora.lind'));
  assert.equal(nora.login, 'nora.lind');
  assert.equal(nora.name, 'Nora Lind');
  assert.deepEqual(nora.groups, ['e2e-change-board']);
  assert.equal(nora.admin, false);
  await userId('nora.lind');
  const wrong = await fetch(`${BASE}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'nora.lind', password: `${people['nora.lind']}x` }),
  });
  assert.equal(wrong.status, 401, 'a wrong password is refused');
});
