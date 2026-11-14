// The server certificate over HTTP (AFS-54): an administrator signed in with a password makes a
// self-signed certificate, makes a request and downloads it, installs the signed answer (the
// request's key used, the request gone), sees a refused certificate with every reason, rolls back,
// and reads the history with their login. Others, and tokens, may not change it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { listAudit } from '../../src/server/audit/store';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { selfSignedCertificate } from '../../src/server/tls/certificates';
import { CertificateStore } from '../../src/server/tls/store';
import { testAuthority } from './helpers/ca';

const PASSWORD = 'correct horse battery staple';
const root = mkdtempSync(join(tmpdir(), 'afs-cert-api-'));
let database: Database;
let app: FastifyInstance;
let dana = '';
let omar = '';
let danaToken = '';

const call = (
  method: 'GET' | 'POST',
  url: string,
  options: { cookie?: string; body?: unknown; token?: string } = {},
) =>
  app.inject({
    method,
    url: `/api/v1/admin/certificate${url}`,
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
  });

async function signIn(login: string, admin: boolean): Promise<string> {
  const user = await createUser(database.db, { login, name: login, password: PASSWORD, admin });
  if (admin) danaToken = (await createToken(database.db, user.id, { name: 't' })).token;
  const reply = await app.inject({
    method: 'POST',
    url: '/api/v1/session',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ login, password: PASSWORD }),
  });
  return /afs_session=[^;]*/.exec([reply.headers['set-cookie']].flat().join(';'))?.[0] ?? '';
}

beforeAll(async () => {
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  app = buildApp({
    log: createLogger({ level: 'silent', format: 'json', write: () => undefined }),
    database,
    instance: 'test',
    certificate: {
      store: new CertificateStore(join(root, 'tls')),
      tls: 'on',
      host: 'flows.example.net',
      defaultNames: ['flows.example.net', 'localhost'],
    },
  });
  dana = await signIn('dana', true);
  omar = await signIn('omar', false);
});
afterAll(async () => {
  await app?.close();
  await database?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('the server certificate over HTTP', () => {
  it('only an administrator reads it; changes need a password sign-in, not a token', async () => {
    expect((await call('GET', '', { cookie: omar })).statusCode).toBe(403);
    expect((await call('POST', '/self-signed', { cookie: omar, body: {} })).statusCode).toBe(403);
    const byToken = await call('POST', '/self-signed', { token: danaToken, body: {} });
    expect(byToken.statusCode).toBe(403);
    expect(byToken.json().error).toBe('session_needed');
    // Reading with a token is fine.
    expect((await call('GET', '', { token: danaToken })).json()).toMatchObject({ tls: 'on' });
  });

  it('self-signed, request and download, install for the request, refusals, rollback, history', async () => {
    const made = await call('POST', '/self-signed', { cookie: dana, body: {} });
    expect(made.statusCode).toBe(200);
    expect(made.json().current).toMatchObject({
      source: 'self-signed',
      info: { selfSigned: true, names: ['flows.example.net', 'localhost'] },
    });

    const asked = await call('POST', '/request', {
      cookie: dana,
      body: { names: ['flows.example.net'], organization: 'Example Networks' },
    });
    expect(asked.statusCode).toBe(201);
    const request = asked.json().request as string;
    expect(request).toMatch(/BEGIN CERTIFICATE REQUEST/);
    const file = await call('GET', '/request.pem', { cookie: dana });
    expect(file.headers['content-disposition']).toMatch(/attachment/);
    expect(file.body).toBe(request);

    // Refused: not a certificate; one for another name with a key that is not its own.
    const junk = await call('POST', '/install', { cookie: dana, body: { certificate: 'hello' } });
    expect(junk.statusCode).toBe(422);
    expect(junk.json().problems).toEqual([
      'The certificate is not PEM text: no BEGIN CERTIFICATE block',
    ]);
    const other = await selfSignedCertificate(['elsewhere.example.org']);
    const stranger = await selfSignedCertificate(['flows.example.net']);
    const wrong = await call('POST', '/install', {
      cookie: dana,
      body: { certificate: other.certificate, key: stranger.key },
    });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().problems.join(' ')).toMatch(/does not belong/);
    expect(wrong.json().problems.join(' ')).toMatch(/flows\.example\.net/);

    // The authority's answer, with its certificate after it: installed with the request's key.
    const authority = await testAuthority();
    const signed = await authority.sign(request);
    const installed = await call('POST', '/install', {
      cookie: dana,
      body: { certificate: signed + authority.certificate },
    });
    expect(installed.statusCode).toBe(200);
    const state = installed.json();
    expect(state.current).toMatchObject({
      source: 'installed',
      info: { selfSigned: false, chain: 1 },
    });
    expect(state.request).toBeUndefined();
    expect(state.previous).toMatchObject({ selfSigned: true });
    expect((await call('GET', '/request.pem', { cookie: dana })).statusCode).toBe(404);

    const back = await call('POST', '/rollback', { cookie: dana });
    expect(back.json().current).toMatchObject({ source: 'self-signed' });

    const history = (await call('GET', '/history', { cookie: dana })).json();
    expect(history.map((h: { action: string }) => h.action)).toEqual([
      'rollback',
      'install',
      'request',
      'self-signed',
    ]);
    expect(history.every((h: { by: string }) => h.by === 'dana')).toBe(true);

    const audit = (await listAudit(database.db, { action: 'certificate' })).entries.map(
      (e) => `${e.action} ${e.result}`,
    );
    expect(audit).toContain('certificate.install ok');
    expect(audit.filter((a) => a.startsWith('certificate.install ')).length).toBe(3);
  });
});
