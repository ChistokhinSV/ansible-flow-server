// Sign-in with an OIDC provider (AFS-30), against a small provider played by the test: discovery,
// keys, a token endpoint that checks the code and the PKCE verifier and signs an ID token. The
// person is made at their first sign-in, their groups and administrator right follow the claim,
// and what was set here by hand stays.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { createGroup, createUser, setMembers } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';

const PASSWORD = 'correct horse battery staple';
const CLIENT = { id: 'flows', secret: 'client-secret-for-tests' };
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** The provider: who signs in next is set by the test (`next`). */
function provider() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<
    string,
    { challenge: string; nonce: string; redirect: string; claims: object }
  >();
  let issuer = '';
  const state = { next: {} as Record<string, unknown> };
  const idToken = (claims: object) => {
    const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
    const body = b64url(JSON.stringify(claims));
    return `${head}.${body}.${b64url(sign('sha256', Buffer.from(`${head}.${body}`), privateKey))}`;
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.endsWith('/.well-known/openid-configuration'))
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname.endsWith('/jwks')) return json(200, { keys: [jwk] });
    if (url.pathname.endsWith('/token') && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        const p = new URLSearchParams(raw);
        const code = codes.get(p.get('code') ?? '');
        codes.delete(p.get('code') ?? '');
        const verifier = p.get('code_verifier') ?? '';
        const ok =
          code &&
          p.get('client_id') === CLIENT.id &&
          p.get('client_secret') === CLIENT.secret &&
          p.get('redirect_uri') === code.redirect &&
          b64url(createHash('sha256').update(verifier).digest()) === code.challenge;
        if (!ok || !code) return json(400, { error: 'invalid_grant' });
        const now = Math.floor(Date.now() / 1000);
        return json(200, {
          access_token: 'access',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken({
            iss: issuer,
            aud: CLIENT.id,
            iat: now,
            exp: now + 300,
            nonce: code.nonce,
            ...code.claims,
          }),
        });
      });
      return undefined;
    }
    res.writeHead(404).end();
    return undefined;
  });
  return {
    server,
    state,
    /** What the provider's sign-in page does: a code for the person `next`, back to the server. */
    authorize(location: string): URLSearchParams {
      const a = new URL(location);
      const code = `code-${Math.random().toString(36).slice(2)}`;
      codes.set(code, {
        challenge: a.searchParams.get('code_challenge') ?? '',
        nonce: a.searchParams.get('nonce') ?? '',
        redirect: a.searchParams.get('redirect_uri') ?? '',
        claims: state.next,
      });
      return new URLSearchParams({ code, state: a.searchParams.get('state') ?? '' });
    },
    async listen() {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/realms/net`;
      return issuer;
    },
  };
}

describe('sign-in with an OIDC provider', () => {
  const idp = provider();
  let issuer: string;
  let database: Database;
  let app: FastifyInstance;
  let admin: string;
  let netops: string;
  let lab: string;
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
  /** The whole round: to the provider, a code for `claims`, back; resolves with the answer. */
  const signInAs = async (claims: Record<string, unknown>, returnTo = '/runs') => {
    idp.state.next = claims;
    const start = await call(
      'GET',
      `/api/v1/auth/oidc/keycloak/start?return=${encodeURIComponent(returnTo)}`,
    );
    expect(start.statusCode).toBe(302);
    const back = idp.authorize(start.headers.location as string);
    return call('GET', `/api/v1/auth/oidc/keycloak/callback?${back}`);
  };

  beforeAll(async () => {
    issuer = await idp.listen();
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    app = buildApp({
      log: createLogger({ level: 'error', format: 'json', write: () => undefined }),
      database,
      instance: 'test',
      masterKey: key,
      publicUrl: 'https://flows.example.net',
    });
    await createUser(database.db, { login: 'dana', name: 'Dana', password: PASSWORD, admin: true });
    await createUser(database.db, { login: 'omar', name: 'Omar', password: PASSWORD });
    netops = (await createGroup(database.db, { name: 'netops' })).id;
    lab = (await createGroup(database.db, { name: 'lab' })).id;
    const signed = await call('POST', '/api/v1/session', undefined, {
      login: 'dana',
      password: PASSWORD,
    });
    admin = cookieOf(signed.headers['set-cookie']);
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
    idp.server.close();
  });

  it('an administrator adds a provider; the sign-in page lists it', async () => {
    const made = await call('POST', '/api/v1/admin/oidc-providers', admin, {
      key: 'keycloak',
      name: 'Keycloak',
      issuer,
      clientId: CLIENT.id,
      clientSecret: CLIENT.secret,
      mappings: [
        { value: '/netops', group: netops },
        { value: 'flows-admins', admin: true },
      ],
    });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({
      key: 'keycloak',
      hasSecret: true,
      groupsClaim: 'groups',
      redirectUri: 'https://flows.example.net/api/v1/auth/oidc/keycloak/callback',
    });
    expect(made.body).not.toContain(CLIENT.secret);
    expect((await call('GET', '/api/v1/auth/methods')).json()).toEqual({
      local: 'all',
      providers: [{ key: 'keycloak', name: 'Keycloak' }],
    });
    const test = await call('POST', `/api/v1/admin/oidc-providers/${made.json().id}/test`, admin);
    expect(test.json()).toMatchObject({ ok: true, issuer, pkce: true });
    // Not with http to another machine; not by a person who is not an administrator.
    const far = await call('POST', '/api/v1/admin/oidc-providers', admin, {
      key: 'far',
      name: 'Far',
      issuer: 'http://login.example.net/realms/net',
      clientId: 'x',
    });
    expect(far.json()).toMatchObject({ error: 'invalid', field: 'issuer' });
  });

  it('the first sign-in makes the person with the groups and the right the claim maps to', async () => {
    const back = await signInAs({
      sub: 'f3c1-mia',
      preferred_username: 'Mia.Ortega',
      name: 'Mia Ortega',
      email: 'mia@example.net',
      groups: ['/netops', 'flows-admins', '/unmapped'],
    });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe('/runs');
    const mia = cookieOf(back.headers['set-cookie']);
    const me = (await call('GET', '/api/v1/session', mia)).json();
    expect(me).toMatchObject({
      login: 'mia.ortega',
      name: 'Mia Ortega',
      email: 'mia@example.net',
      admin: true,
    });
    expect(me.groups).toEqual(['netops']);
    // No password: such a person signs in at the provider only.
    expect(
      (
        await call('POST', '/api/v1/session', undefined, {
          login: 'mia.ortega',
          password: PASSWORD,
        })
      ).statusCode,
    ).toBe(401);

    // A group given here by hand stays when the claim changes; what the provider gave goes.
    await setMembers(database.db, lab, [me.id]);
    const again = await signInAs({ sub: 'f3c1-mia', preferred_username: 'mia.ortega', groups: [] });
    const now = (
      await call('GET', '/api/v1/session', cookieOf(again.headers['set-cookie']))
    ).json();
    expect(now.admin).toBe(false);
    expect(now.groups).toEqual(['lab']);
    expect(now.login).toBe('mia.ortega');
  });

  it('another person with the same login is told apart; a used or forged return is refused', async () => {
    const other = await signInAs({ sub: 'zz-9', preferred_username: 'mia.ortega' });
    const me = (await call('GET', '/api/v1/session', cookieOf(other.headers['set-cookie']))).json();
    expect(me.login).toBe('mia.ortega-2');

    // The same answer twice: the second is refused.
    idp.state.next = { sub: 'f3c1-mia' };
    const start = await call('GET', '/api/v1/auth/oidc/keycloak/start');
    const back = idp.authorize(start.headers.location as string);
    expect(
      (await call('GET', `/api/v1/auth/oidc/keycloak/callback?${back}`)).headers.location,
    ).toBe('/');
    const replay = await call('GET', `/api/v1/auth/oidc/keycloak/callback?${back}`);
    expect(replay.headers.location).toMatch(
      /^\/signin\?error=.*expired%20or%20was%20already%20used/,
    );
    // A state nobody started.
    const forged = await call('GET', '/api/v1/auth/oidc/keycloak/callback?code=x&state=forged');
    expect(forged.headers.location).toMatch(/^\/signin\?error=/);
    expect(forged.headers['set-cookie']).toBeUndefined();
    // A return to another site is the start page.
    const away = await signInAs({ sub: 'f3c1-mia' }, '//evil.example.net/');
    expect(away.headers.location).toBe('/');
  });

  it('passwords for administrators only: others are sent to the provider', async () => {
    expect(
      (await call('PUT', '/api/v1/admin/sign-in', admin, { local: 'admins' })).statusCode,
    ).toBe(200);
    expect((await call('GET', '/api/v1/auth/methods')).json().local).toBe('admins');
    const omar = await call('POST', '/api/v1/session', undefined, {
      login: 'omar',
      password: PASSWORD,
    });
    expect(omar.statusCode).toBe(403);
    expect(omar.json().error).toBe('provider_only');
    const dana = await call('POST', '/api/v1/session', undefined, {
      login: 'dana',
      password: PASSWORD,
    });
    expect(dana.statusCode).toBe(200);
    await call('PUT', '/api/v1/admin/sign-in', admin, { local: 'all' });
  });

  it('removing the provider takes back what it gave; its people stay', async () => {
    const back = await signInAs({ sub: 'f3c1-mia', groups: ['/netops', 'flows-admins'] });
    const mia = (await call('GET', '/api/v1/session', cookieOf(back.headers['set-cookie']))).json();
    expect(mia.admin).toBe(true);
    const [p] = (await call('GET', '/api/v1/admin/oidc-providers', admin)).json();
    expect((await call('DELETE', `/api/v1/admin/oidc-providers/${p.id}`, admin)).statusCode).toBe(
      204,
    );
    const user = (await call('GET', `/api/v1/users/${mia.id}`, admin)).json();
    expect(user.admin).toBe(false);
    expect(user.groups).toEqual(['lab']);
    expect((await call('GET', '/api/v1/auth/methods')).json().providers).toEqual([]);
  });
});
