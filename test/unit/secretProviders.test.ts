// Secret providers (AFS-241, AFS-242): the four clients against mocked answers, SigV4 against
// AWS's published example, the provider store (sealed, workspaces, rotation), credentials that
// take a part from a provider, a run's resolver (once per run, revoked at the end, JSON values
// hidden leaf by leaf) and the routes, with a small Conjur-like server on loopback.
// The real providers are tried by test/e2e/secretProviders.test.ts (AFS_SECRETS_LAB).
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { listAudit } from '../../src/server/audit/store';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { createWorkspace } from '../../src/server/projects/store';
import { fromWords, inventoryEnv, runCredentials } from '../../src/server/runs/credentials';
import {
  CredentialError,
  createCredential,
  getCredential,
  reveal,
  rotate,
  shownRefs,
  updateCredential,
} from '../../src/server/secrets/credentials';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import {
  type Caller,
  type Connection,
  clientOf,
  sigv4,
} from '../../src/server/secrets/providers/clients';
import type { Answer, CallOptions } from '../../src/server/secrets/providers/http';
import { SecretReadError, tlsWords } from '../../src/server/secrets/providers/http';
import { jsonLeaves, SecretResolver } from '../../src/server/secrets/providers/resolver';
import {
  connectionOf,
  createSecretProvider,
  deleteSecretProvider,
  ProviderStoreError,
  updateSecretProvider,
} from '../../src/server/secrets/providers/store';
import { refPath, refProblem } from '../../src/server/secrets/providers/types';
import { emptyWorkspaces } from './helpers/clean';
import { grant } from './helpers/grant';

// Fictional values only.
const VALUE = 'lab-switch-password-1';
const keyOf = (bytes = newKey()): MasterKey => ({ key: bytes, id: keyId(bytes), source: 'env' });

/** A caller that answers by the address's path, and keeps what was asked. */
function mock(routes: Record<string, (o: CallOptions, url: URL) => Answer>) {
  const calls: { url: string; options: CallOptions }[] = [];
  const caller: Caller = async (url, options) => {
    calls.push({ url, options });
    const u = new URL(url);
    for (const [path, answer] of Object.entries(routes))
      if (`${u.pathname}${u.search}`.startsWith(path)) return answer(options, u);
    return { status: 599, text: 'no route in the mock' };
  };
  return { caller, calls };
}
const json = (status: number, body: unknown): Answer => ({ status, text: JSON.stringify(body) });
const words = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as SecretReadError;
  }
  throw new Error('it did not fail');
};

const vaultConn = (auth: 'approle' | 'token' = 'approle'): Connection => ({
  key: 'corp-vault',
  name: 'corp-vault',
  kind: 'vault',
  settings: { address: 'https://vault.example.net:8200', auth },
  secret: auth === 'token' ? { token: 'hvs.fictional' } : { roleId: 'r-1', secretId: 's-1' },
});

describe('HashiCorp Vault', () => {
  it('signs in with AppRole once, reads KV v2 and revokes its token at the end', async () => {
    const m = mock({
      '/v1/auth/approle/login': () => json(200, { auth: { client_token: 'hvs.run' } }),
      '/v1/secret/data/network/switches': (o) =>
        o.headers?.['X-Vault-Token'] === 'hvs.run'
          ? json(200, { data: { data: { password: VALUE, other: 'x' } } })
          : json(403, { errors: ['permission denied'] }),
      '/v1/auth/token/revoke-self': () => ({ status: 204, text: '' }),
    });
    const client = clientOf(vaultConn(), m.caller);
    const ref = { provider: 'corp-vault', path: 'network/switches', field: 'password' };
    expect(await client.read(ref)).toBe(VALUE);
    expect(await client.read(ref)).toBe(VALUE);
    expect(m.calls.filter((c) => c.url.includes('/login'))).toHaveLength(1);
    await client.close();
    expect(m.calls.at(-1)?.url).toMatch(/revoke-self$/);
    expect(m.calls.at(-1)?.options.headers?.['X-Vault-Token']).toBe('hvs.run');
  });

  it('does not revoke a token it was given, and says each refusal without the path', async () => {
    const m = mock({
      '/v1/secret/data/denied': () =>
        json(403, { errors: ['1 error occurred: permission denied'] }),
      '/v1/secret/data/expired': () => json(403, { errors: ['permission denied, invalid token'] }),
      '/v1/secret/data/missing': () => json(404, { errors: [] }),
      '/v1/secret/data/nofield': () => json(200, { data: { data: { username: 'netops' } } }),
    });
    const client = clientOf(vaultConn('token'), m.caller);
    const read = (path: string) => client.read({ provider: 'corp-vault', path, field: 'password' });
    const denied = await words(read('denied'));
    expect(denied).toMatchObject({ code: 'denied', status: 403 });
    expect(denied.message).toBe(
      'HashiCorp Vault refused the read (403): "corp-vault" may not read this secret',
    );
    expect((await words(read('expired'))).code).toBe('auth');
    expect((await words(read('missing'))).message).toBe(
      'HashiCorp Vault "corp-vault" has no such secret (404)',
    );
    expect((await words(read('nofield'))).message).toMatch(/not the field asked for/);
    for (const path of ['denied', 'expired', 'missing', 'nofield'])
      expect((await words(read(path))).message).not.toContain(path);
    await client.close();
    expect(m.calls.some((c) => c.url.includes('revoke'))).toBe(false);
  });

  it('a path written with the mount or data/ is told to leave them out', async () => {
    const m = mock({
      '/v1/secret/data/secret/data/lab': () => json(403, { errors: ['permission denied'] }),
      '/v1/secret/data/data/lab': () => json(404, { errors: [] }),
      '/v1/secret/data/elsewhere': () => json(403, { errors: ['permission denied'] }),
    });
    const client = clientOf(vaultConn('token'), m.caller);
    const read = (path: string) => client.read({ provider: 'corp-vault', path, field: 'password' });
    const hint = /leave them out, they are added to it$/;
    expect((await words(read('secret/data/lab/switch'))).message).toMatch(hint);
    expect((await words(read('data/lab/switch'))).message).toMatch(hint);
    expect((await words(read('elsewhere/switch'))).message).not.toMatch(hint);
  });

  it('says an untrusted certificate in words that fit whether an authority is given', () => {
    expect(tlsWords('UNABLE_TO_VERIFY_LEAF_SIGNATURE', true)).toBe(
      'its certificate is not signed by the authority given to the provider (UNABLE_TO_VERIFY_LEAF_SIGNATURE)',
    );
    expect(tlsWords('SELF_SIGNED_CERT_IN_CHAIN', false)).toMatch(
      /add its authority to the provider$/,
    );
    expect(tlsWords('CERT_HAS_EXPIRED', true)).toMatch(/has expired/);
    expect(tlsWords('ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED', false)).toMatch(
      /client certificate/,
    );
  });

  it('a wrong AppRole secret id is a sign-in error', async () => {
    const m = mock({
      '/v1/auth/approle/login': () => json(400, { errors: ['invalid role or secret ID'] }),
    });
    const e = await words(clientOf(vaultConn(), m.caller).test());
    expect(e).toMatchObject({ code: 'auth', status: 400 });
    expect(e.detail).toContain('invalid role or secret ID');
    expect(e.message).not.toContain('invalid role');
  });
});

describe('CyberArk Conjur, CCP and AWS Secrets Manager', () => {
  const conjur: Connection = {
    key: 'conjur',
    name: 'conjur-prod',
    kind: 'conjur',
    settings: { address: 'https://conjur.example.net', account: 'corp', login: 'host/afs' },
    secret: { apiKey: 'fictional-api-key' },
  };
  it('Conjur: the host login is one path part; 404 says it may also be not allowed', async () => {
    const m = mock({
      '/authn/corp/host%2Fafs/authenticate': (o) =>
        o.body === 'fictional-api-key'
          ? { status: 200, text: 'dG9rZW4=' }
          : { status: 401, text: '' },
      '/secrets/corp/variable/network%2Fswitches%2Fpassword': (o) =>
        o.headers?.Authorization === 'Token token="dG9rZW4="'
          ? { status: 200, text: VALUE }
          : { status: 401, text: '' },
      '/secrets/corp/variable/': () =>
        json(404, {
          error: { code: 'not_found', message: 'Variable corp:variable:x is empty or not found' },
        }),
    });
    const client = clientOf(conjur, m.caller);
    expect(await client.read({ provider: 'conjur', variable: 'network/switches/password' })).toBe(
      VALUE,
    );
    const e = await words(client.read({ provider: 'conjur', variable: 'secret/hidden' }));
    expect(e.message).toBe(
      'CyberArk Conjur "conjur-prod" has no such variable, or this server may not read it (404)',
    );
    expect(e.detail).toContain('not found');
    const bad = await words(clientOf({ ...conjur, secret: { apiKey: 'wrong' } }, m.caller).test());
    expect(bad).toMatchObject({ code: 'auth', status: 401 });
  });

  it('CCP: AppID, safe, folder and object in the query; the error code is said, its text is not', async () => {
    const m = mock({
      '/AIMWebService/api/Accounts?AppID=afs&Safe=NET&Folder=Root&Object=core': () =>
        json(200, { Content: VALUE, UserName: 'netops' }),
      '/AIMWebService/api/Accounts?AppID=afs&Safe=NET&Object=gone': () =>
        json(404, {
          ErrorCode: 'APPAP004E',
          ErrorMsg: 'Password object matching query [Safe=NET;Object=gone] was not found',
        }),
    });
    const client = clientOf(
      {
        key: 'ccp',
        name: 'ccp-dc1',
        kind: 'ccp',
        settings: { address: 'https://ccp.example.net', appId: 'afs', clientCert: 'CERT' },
        secret: { clientKey: 'KEY' },
      },
      m.caller,
    );
    expect(
      await client.read({ provider: 'ccp', safe: 'NET', folder: 'Root', object: 'core' }),
    ).toBe(VALUE);
    expect(
      await client.read({
        provider: 'ccp',
        safe: 'NET',
        folder: 'Root',
        object: 'core',
        field: 'UserName',
      }),
    ).toBe('netops');
    expect(m.calls[0]?.options.tls).toMatchObject({ cert: 'CERT', key: 'KEY' });
    const e = await words(client.read({ provider: 'ccp', safe: 'NET', object: 'gone' }));
    expect(e.message).toBe('CyberArk CCP "ccp-dc1" has no such account (404) [APPAP004E]');
    expect(e.detail).toContain('Object=gone');
  });

  it('AWS: signed GetSecretValue, a JSON key or the whole secret, errors by type', async () => {
    const m = mock({
      '/': (o) => {
        const body = JSON.parse(o.body ?? '{}') as { SecretId: string };
        if (!o.headers?.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=AKIAFICTIONAL/'))
          return json(400, { __type: 'UnrecognizedClientException' });
        if (body.SecretId === 'net/switches')
          return json(200, {
            SecretString: JSON.stringify({ username: 'netops', password: VALUE }),
          });
        return json(400, {
          __type: 'com.amazonaws#ResourceNotFoundException',
          message: `${body.SecretId} not found`,
        });
      },
    });
    const client = clientOf(
      {
        key: 'aws',
        name: 'aws-eu',
        kind: 'aws',
        settings: { region: 'eu-central-1', address: 'http://localstack.example.net:4566' },
        secret: { accessKeyId: 'AKIAFICTIONAL', secretAccessKey: 'fictional/secret' },
      },
      m.caller,
    );
    expect(
      await client.read({ provider: 'aws', secretId: 'net/switches', jsonKey: 'password' }),
    ).toBe(VALUE);
    expect(
      JSON.parse(await client.read({ provider: 'aws', secretId: 'net/switches' })),
    ).toMatchObject({
      password: VALUE,
    });
    expect(m.calls[0]?.options.headers?.['x-amz-target']).toBe('secretsmanager.GetSecretValue');
    const e = await words(client.read({ provider: 'aws', secretId: 'net/gone' }));
    expect(e.message).toBe(
      'AWS Secrets Manager "aws-eu" has no such secret (ResourceNotFoundException)',
    );
    expect(e.message).not.toContain('net/gone');
    expect(
      (await words(client.read({ provider: 'aws', secretId: 'net/switches', jsonKey: 'nope' })))
        .code,
    ).toBe('not_found');
  });

  it("SigV4 signs AWS's published example as AWS does", () => {
    // From AWS's Signature Version 4 documentation (IAM ListUsers, documented example keys).
    const headers = sigv4({
      method: 'GET',
      url: 'https://iam.amazonaws.com/?Version=2010-05-08&Action=ListUsers',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: '',
      region: 'us-east-1',
      service: 'iam',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });

  it('references are checked by kind, and their path is said on one line', () => {
    expect(refProblem('vault', { provider: 'v', path: 'a/b' })).toBe('Field is needed');
    expect(refProblem('vault', { provider: 'v', path: 'a/../b', field: 'f' })).toMatch(/\.\./);
    expect(refProblem('conjur', { provider: 'c', variable: 'x', bogus: 'y' })).toMatch(
      /no part "bogus"/,
    );
    expect(refProblem('aws', { provider: 'a', secretId: 's' })).toBeUndefined();
    expect(refPath('vault', { mount: 'kv', path: 'net/sw', field: 'password' })).toBe(
      'kv/net/sw#password',
    );
    expect(jsonLeaves('{"a":"one-value","b":{"c":"two-value"},"n":12345}')).toEqual([
      'one-value',
      'two-value',
      '12345',
    ]);
    expect(jsonLeaves('plain')).toEqual([]);
  });
});

describe('the providers and credentials that read from them', () => {
  let database: Database;
  const key = keyOf();
  let net: string;
  let lab: string;
  beforeAll(async () => {
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
  });
  afterAll(() => database.close());
  beforeEach(async () => {
    await emptyWorkspaces(database.db);
    net = (await createWorkspace(database.db, { key: 'net', name: 'Network' })).id;
    lab = (await createWorkspace(database.db, { key: 'lab', name: 'Lab' })).id;
  });
  const vault = (workspaces: string[]) =>
    createSecretProvider(database.db, key, {
      key: 'corp-vault',
      name: 'Corp Vault',
      kind: 'vault',
      settings: { address: 'https://vault.example.net:8200/', auth: 'approle', timeoutS: 5 },
      secret: { roleId: 'role-fictional', secretId: 'secret-id-fictional' },
      workspaces,
    });
  const REF = { provider: 'corp-vault', path: 'network/switches', field: 'password' };
  const login = (refs = { password: REF }, workspace = net) =>
    createCredential(database.db, key, workspace, {
      name: 'Lab switches',
      kind: 'login',
      fields: { username: 'netops' },
      secret: {},
      refs,
    });

  it('keeps the secret part sealed, and checks settings and workspaces', async () => {
    const p = await vault([net]);
    expect(p).toMatchObject({ kind: 'vault', has: ['roleId', 'secretId'], workspaces: [net] });
    expect(p.settings.address).toBe('https://vault.example.net:8200');
    const row = await database.db
      .selectFrom('secret_provider')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(`${row.settings_json}${row.secret_enc}`).not.toContain('secret-id-fictional');
    expect((await connectionOf(database.db, key, 'corp-vault'))?.secret.secretId).toBe(
      'secret-id-fictional',
    );
    await expect(
      createSecretProvider(database.db, key, {
        key: 'aws',
        name: 'AWS',
        kind: 'aws',
        settings: { region: 'nowhere' },
        secret: { accessKeyId: 'a', secretAccessKey: 'b' },
        workspaces: [],
      }),
    ).rejects.toMatchObject({ field: 'region' });
    await expect(
      createSecretProvider(database.db, key, {
        key: 'v2',
        name: 'V',
        kind: 'vault',
        settings: { address: 'https://v', auth: 'token' },
        workspaces: ['no-such-workspace'],
      }),
    ).rejects.toMatchObject({ field: 'token' });
    // Rotation reseals it: the new key opens it, the old one does not.
    const next = keyOf();
    expect(await rotate(database.db, key, next)).toBeGreaterThan(0);
    expect((await connectionOf(database.db, next, 'corp-vault'))?.secret.roleId).toBe(
      'role-fictional',
    );
    await rotate(database.db, next, key);
  });

  it('a credential points at a provider open to its workspace; its path only for those who may', async () => {
    await vault([net]);
    const c = await login();
    expect(c.has).toEqual(['password']);
    expect(c.refs?.password).toEqual({
      provider: 'corp-vault',
      path: { path: 'network/switches', field: 'password' },
    });
    const [forMember] = await shownRefs(database.db, [c], false);
    expect(forMember?.refs?.password).toEqual({
      provider: 'corp-vault',
      providerName: 'Corp Vault',
      kind: 'vault',
    });
    // Not open to the lab workspace; a reference of the wrong shape.
    await expect(login({ password: REF }, lab)).rejects.toBeInstanceOf(CredentialError);
    await expect(
      login({ password: { provider: 'corp-vault', path: 'x' } as never }),
    ).rejects.toThrow(/Field is needed/);
    // A stored password replaces the reference; the reference replaces a stored one.
    const stored = await updateCredential(database.db, key, c.id, {
      refs: null,
      secret: { password: 'stored-fictional' },
    });
    expect(stored.refs).toBeUndefined();
    const back = await updateCredential(database.db, key, c.id, { refs: { password: REF } });
    expect(back.has).toEqual(['password']);
    // The provider cannot go, change its key or close the workspace while it is read from.
    const p = (await connectionOf(database.db, key, 'corp-vault'))?.id as string;
    await expect(deleteSecretProvider(database.db, p)).rejects.toBeInstanceOf(ProviderStoreError);
    await expect(updateSecretProvider(database.db, key, p, { key: 'other' })).rejects.toThrow(
      /key cannot change/,
    );
    await expect(updateSecretProvider(database.db, key, p, { workspaces: [lab] })).rejects.toThrow(
      /Lab switches/,
    );
  });

  it('a run reads each reference once, hides JSON leaves, names the provider and revokes at the end', async () => {
    await vault([net]);
    const c = await login();
    const env = await createCredential(database.db, key, net, {
      name: 'Device API',
      kind: 'env',
      secret: { REGION: 'eu-lab' },
      refs: { DEVICE_JSON: { provider: 'corp-vault', path: 'network/api', field: 'json' } },
    });
    const m = mock({
      '/v1/auth/approle/login': () => json(200, { auth: { client_token: 'hvs.run' } }),
      '/v1/secret/data/network/switches': () => json(200, { data: { data: { password: VALUE } } }),
      '/v1/secret/data/network/api': () =>
        json(200, { data: { data: { json: { token: 'api-token-fictional', user: 'api' } } } }),
      '/v1/auth/token/revoke-self': () => ({ status: 204, text: '' }),
    });
    const resolver = new SecretResolver(database.db, key, {
      caller: m.caller,
      run: { id: 'run-1', number: 7 },
    });
    for (const id of [c.id, env.id]) await reveal(database.db, key, id, resolver);
    const folder = join(mkdtempSync(join(tmpdir(), 'afs-ext-')), 'run');
    const creds = await runCredentials(
      database.db,
      key,
      [c.id, env.id],
      folder,
      undefined,
      resolver,
    );
    expect(creds.vars.ansible_password).toBe(VALUE);
    // The values read go to a file of their own for the engine (AFD_EXTERNAL_SECRETS_FILE).
    expect(creds.options).toContain('AFD_EXTERNAL_SECRETS_FILE=/afd-cred/external-secrets.json');
    expect(JSON.parse(readFileSync(join(folder, 'external-secrets.json'), 'utf8'))).toEqual(
      expect.arrayContaining([VALUE, 'api-token-fictional']),
    );
    await creds.cleanup();
    expect(existsSync(folder)).toBe(false);
    expect(creds.processEnv.DEVICE_JSON).toBe('{"token":"api-token-fictional","user":"api"}');
    expect(creds.notes[0]).toBe(
      'login "Lab switches" as netops, password from HashiCorp Vault "Corp Vault"',
    );
    expect(creds.notes[1]).toContain('DEVICE_JSON from HashiCorp Vault "Corp Vault"');
    expect(resolver.hidden()).toEqual(
      expect.arrayContaining([
        VALUE,
        'api-token-fictional',
        '{"token":"api-token-fictional","user":"api"}',
      ]),
    );
    // Read once per run, signed in once.
    expect(m.calls.filter((x) => x.url.includes('/data/network/switches'))).toHaveLength(1);
    expect(m.calls.filter((x) => x.url.includes('/login'))).toHaveLength(1);
    await resolver.close();
    expect(m.calls.at(-1)?.url).toMatch(/revoke-self$/);
    const audit = await listAudit(database.db, { action: 'secret-provider.read' } as never);
    expect(JSON.stringify(audit)).not.toContain('network/');
    expect(fromWords({ password: 'Vault "a"', passphrase: 'Vault "a"' })).toBe(
      ', password and passphrase from Vault "a"',
    );
  });

  it('a read that fails says the credential and the provider, never the path', async () => {
    await vault([net]);
    const c = await login();
    const warned: Record<string, unknown>[] = [];
    const m = mock({
      '/v1/auth/approle/login': () => json(200, { auth: { client_token: 'hvs.run' } }),
      '/v1/secret/data/': () => json(403, { errors: ['permission denied on network/switches'] }),
    });
    const resolver = new SecretResolver(database.db, key, {
      caller: m.caller,
      log: { warn: (o) => warned.push(o) },
    });
    const e = await words(reveal(database.db, key, c.id, resolver));
    expect(e).toBeInstanceOf(SecretReadError);
    expect(e.message).toBe(
      'Cannot read the credential "Lab switches" (password): HashiCorp Vault refused the read (403): "Corp Vault" may not read this secret',
    );
    expect(warned[0]).toMatchObject({ provider: 'corp-vault', code: 'denied' });
    expect(String(warned[0]?.detail)).toContain('network/switches');
    await resolver.close();
    // A provider no longer open to the workspace is refused before any call.
    const p = (await connectionOf(database.db, key, 'corp-vault'))?.id as string;
    await database.db
      .updateTable('secret_provider')
      .set({ workspaces_json: '[]' })
      .where('id', '=', p)
      .execute();
    const r2 = new SecretResolver(database.db, key, { caller: m.caller });
    expect((await words(reveal(database.db, key, c.id, r2))).message).toMatch(
      /not open to this workspace/,
    );
    expect((await getCredential(database.db, c.id))?.refs?.password?.provider).toBe('corp-vault');
  });

  it("reading a launch's inventory opens only env credentials: a login's provider is not asked", async () => {
    await vault([net]);
    const c = await login();
    const m = mock({
      '/v1/auth/approle/login': () => json(200, { auth: { client_token: 'hvs.run' } }),
      '/v1/secret/data/': () => json(403, { errors: ['permission denied'] }),
    });
    const resolver = new SecretResolver(database.db, key, {
      caller: m.caller,
      purpose: 'reading the inventory of a launch',
    });
    // AFS-261: a machine password the provider refuses does not stop the inventory's groups.
    expect(await inventoryEnv(database.db, key, [c.id], resolver)).toEqual({
      options: [],
      processEnv: {},
    });
    expect(m.calls).toHaveLength(0);
    await resolver.close();
  });
});

describe('secret providers over the API', () => {
  let database: Database;
  let app: FastifyInstance;
  let conjur: Server;
  let address: string;
  const lines: string[] = [];
  let admin: string;
  let member: string;
  let netAdmin: string;
  let net: string;
  const key = keyOf();

  beforeAll(async () => {
    // A Conjur-like server: the fictional host signs in, one variable reads, others are 404.
    conjur = createServer((req, res) => {
      if (req.url === '/authn/corp/host%2Fafs/authenticate') {
        res.writeHead(200).end('dG9rZW4=');
        return;
      }
      if (req.url === '/secrets/corp/variable/network%2Fswitches') {
        res.writeHead(200).end(VALUE);
        return;
      }
      res
        .writeHead(404)
        .end('{"error":{"message":"Variable corp:variable:secret/elsewhere not found"}}');
    });
    await new Promise<void>((resolve) => conjur.listen(0, '127.0.0.1', resolve));
    address = `http://127.0.0.1:${(conjur.address() as AddressInfo).port}`;
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    app = buildApp({
      log: createLogger({ level: 'debug', format: 'json', write: (l) => lines.push(l) }),
      database,
      instance: 'test',
      masterKey: key,
    });
    const signIn = async (login: string, isAdmin: boolean) => {
      await createUser(database.db, {
        login,
        name: login,
        password: 'pw-fictional-123',
        admin: isAdmin,
      });
      const reply = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { login, password: 'pw-fictional-123' },
      });
      return /afs_session=[^;]*/.exec([reply.headers['set-cookie']].flat().join(';'))?.[0] ?? '';
    };
    admin = await signIn('dana', true);
    member = await signIn('omar', false);
    netAdmin = await signIn('rhea', false);
    net = (await createWorkspace(database.db, { key: 'net', name: 'Network' })).id;
    await grant(database.db, 'net', 'omar');
    await grant(database.db, 'net', 'rhea', 'rw');
  });
  afterAll(async () => {
    await app.close();
    await database.close();
    await new Promise((resolve) => conjur.close(resolve));
  });
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    cookie: string,
    body?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });

  it('administrators keep the list; the key never comes back; tests and Test read say no value', async () => {
    const made = await call('POST', '/api/v1/admin/secret-providers', admin, {
      key: 'conjur-lab',
      name: 'Conjur lab',
      kind: 'conjur',
      settings: { address, account: 'corp', login: 'host/afs', timeoutS: 3 },
      secret: { apiKey: 'api-key-fictional-77' },
      workspaces: [net],
    });
    expect(made.json()).toMatchObject({ key: 'conjur-lab', has: ['apiKey'] });
    const id = made.json().id;
    expect((await call('GET', '/api/v1/admin/secret-providers', member)).statusCode).toBe(403);
    const test = await call('POST', `/api/v1/admin/secret-providers/${id}/test`, admin, {});
    expect(test.json()).toEqual({ ok: true, message: 'Signed in as host/afs' });
    const read = await call('POST', `/api/v1/admin/secret-providers/${id}/test`, admin, {
      ref: { variable: 'network/switches' },
    });
    expect(read.json().ok).toBe(true);
    expect((await call('GET', '/api/v1/workspaces/net/secret-providers', admin)).json()).toEqual([
      { key: 'conjur-lab', name: 'Conjur lab', kind: 'conjur' },
    ]);
    const tried = await call('POST', '/api/v1/workspaces/net/secret-refs/test', admin, {
      ref: { provider: 'conjur-lab', variable: 'secret/elsewhere' },
    });
    expect(tried.json()).toEqual({
      ok: false,
      message:
        'CyberArk Conjur "Conjur lab" has no such variable, or this server may not read it (404)',
    });
    expect(
      (
        await call('POST', '/api/v1/workspaces/net/secret-refs/test', admin, {
          ref: { provider: 'conjur-lab', variable: 'network/switches' },
        })
      ).json(),
    ).toEqual({
      ok: true,
      message: 'Read from CyberArk Conjur "Conjur lab" (the value is not shown)',
    });
    const cred = await call('POST', '/api/v1/workspaces/net/credentials', admin, {
      name: 'Switches',
      kind: 'login',
      fields: { username: 'netops' },
      secret: {},
      refs: { password: { provider: 'conjur-lab', variable: 'network/switches' } },
    });
    expect(cred.statusCode).toBe(201);
    // The workspace's administrator sees the path; a member sees which provider only.
    const asNetAdmin = (await call('GET', '/api/v1/workspaces/net/credentials', netAdmin)).json();
    expect(asNetAdmin[0].refs.password.path).toEqual({ variable: 'network/switches' });
    const asMember = (await call('GET', '/api/v1/workspaces/net/credentials', member)).json();
    expect(asMember[0].refs.password).toEqual({
      provider: 'conjur-lab',
      providerName: 'Conjur lab',
      kind: 'conjur',
    });
    // A credential's use outside a run (as git would) reads through a resolver of its own.
    const revealed = await reveal(database.db, key, cred.json().id);
    expect(revealed?.secret.password).toBe(VALUE);
    expect((await call('DELETE', `/api/v1/admin/secret-providers/${id}`, admin)).statusCode).toBe(
      409,
    );
    const all = lines.join('\n');
    for (const secret of ['api-key-fictional-77', VALUE]) expect(all).not.toContain(secret);
    const entries = await listAudit(database.db, {} as never);
    const actions = JSON.stringify(entries);
    expect(actions).toContain('secret-provider.create');
    expect(actions).toContain('credential.test-read');
    expect(actions).not.toContain('secret/elsewhere');
  });

  it('a change is audited with what differs; a refused add names it; a token sign-in drops AppRole', async () => {
    const made = await call('POST', '/api/v1/admin/secret-providers', admin, {
      key: 'vault-switch',
      name: 'Vault switch',
      kind: 'vault',
      settings: { address: 'https://vault.example.net:8200', auth: 'approle', authMount: 'ar' },
      secret: { roleId: 'role-fictional', secretId: 'secret-id-fictional' },
      workspaces: [net],
    });
    const p = made.json();
    // The form sends every part back; only the address is new.
    const changed = await call('PATCH', `/api/v1/admin/secret-providers/${p.id}`, admin, {
      key: p.key,
      name: p.name,
      settings: { ...p.settings, address: 'https://vault2.example.net:8200' },
      workspaces: p.workspaces,
    });
    expect(changed.statusCode).toBe(200);
    const changes = await listAudit(database.db, { action: 'secret-provider.change' } as never);
    expect(changes.entries.find((e) => e.object.id === p.id)?.detail).toEqual({
      changed: ['settings'],
    });
    // Switched to a token: the token is asked, the AppRole parts and mount are not kept.
    const token = await call('PATCH', `/api/v1/admin/secret-providers/${p.id}`, admin, {
      settings: { address: 'https://vault2.example.net:8200', auth: 'token', authMount: 'ar' },
      secret: { token: 'hvs.fictional-token' },
    });
    expect(token.statusCode).toBe(200);
    expect(token.json()).toMatchObject({ has: ['token'], settings: { auth: 'token' } });
    expect(token.json().settings.authMount).toBeUndefined();
    // A refused add is named by what it was adding.
    const refused = await call('POST', '/api/v1/admin/secret-providers', admin, {
      key: 'vault-switch',
      name: 'Vault again',
      kind: 'vault',
      settings: { address: 'https://vault.example.net:8200', auth: 'token' },
      secret: { token: 'hvs.fictional-token' },
    });
    expect(refused.statusCode).toBe(409);
    const adds = await listAudit(database.db, { action: 'secret-provider.create' } as never);
    expect(adds.entries.find((e) => e.result === 'refused')?.object.name).toBe('Vault again');
    await call('DELETE', `/api/v1/admin/secret-providers/${p.id}`, admin);
  });

  it('a failed test and a failed Test read are audited as failed, with why', async () => {
    const made = await call('POST', '/api/v1/admin/secret-providers', admin, {
      key: 'conjur-gone',
      name: 'Conjur gone',
      kind: 'conjur',
      // Nothing listens on port 1: the provider cannot be reached.
      settings: { address: 'http://127.0.0.1:1', account: 'corp', login: 'host/afs', timeoutS: 2 },
      secret: { apiKey: 'api-key-fictional-78' },
      workspaces: [net],
    });
    const id = made.json().id;
    const test = await call('POST', `/api/v1/admin/secret-providers/${id}/test`, admin, {});
    expect(test.statusCode).toBe(200);
    expect(test.json().ok).toBe(false);
    const tests = await listAudit(database.db, { action: 'secret-provider.test' } as never);
    const failed = tests.entries.find((e) => e.object.id === id);
    expect(failed).toMatchObject({ result: 'failed', detail: { outcome: 'unreachable' } });
    // The earlier Test read of a variable Conjur does not have, and the good one.
    const reads = await listAudit(database.db, { action: 'credential.test-read' } as never);
    const results = reads.entries.map((e) => [e.result, e.detail?.read, e.detail?.outcome]);
    expect(results).toContainEqual(['failed', false, 'not_found']);
    expect(results).toContainEqual(['ok', true, undefined]);
    await call('DELETE', `/api/v1/admin/secret-providers/${id}`, admin);
  });
});
