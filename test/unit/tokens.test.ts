// Personal access tokens, on both databases the server supports (PostgreSQL when
// AFS_TEST_POSTGRES_URL is set), and over HTTP.
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { userCommand } from '../../src/server/auth/cli';
import {
  createToken,
  listTokens,
  looksLikeToken,
  revokeToken,
  sweepTokens,
  TOKEN_DAYS,
  TOKEN_LIMIT,
  tokenOfHeader,
  tokenUser,
} from '../../src/server/auth/tokens';
import { createUser, deleteUser, UserError, updateUser } from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger, HIDDEN } from '../../src/server/log';

const PASSWORD = 'correct horse battery staple';
const DAY = 24 * 60 * 60 * 1000;
const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

describe('a token in a request', () => {
  const token = `afs_${'A'.repeat(43)}`;

  it('is a bearer, or the password git sends', () => {
    expect(tokenOfHeader(`Bearer ${token}`)).toBe(token);
    expect(tokenOfHeader(`bearer ${token}`)).toBe(token);
    expect(tokenOfHeader(basic('dana', token))).toBe(token);
    expect(tokenOfHeader(basic('', token))).toBe(token);
    expect(tokenOfHeader(basic('dana', 'has:colons'))).toBe('has:colons');
    expect(tokenOfHeader(undefined)).toBeUndefined();
    expect(tokenOfHeader('Digest abc')).toBeUndefined();
    expect(tokenOfHeader(`Basic ${Buffer.from('nocolon').toString('base64')}`)).toBeUndefined();
  });

  it('has one shape', () => {
    expect(looksLikeToken(token)).toBe(true);
    expect(looksLikeToken(token.slice(0, -1))).toBe(false);
    expect(looksLikeToken(`${token}A`)).toBe(false);
    expect(looksLikeToken(`ghp_${'A'.repeat(43)}`)).toBe(false);
    expect(looksLikeToken(`afs_${'A'.repeat(42)}!`)).toBe(false);
  });

  it('is never written to the log, whatever the field is called', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', format: 'text', write: (l) => lines.push(l) });
    log.info({ url: `https://dana:${token}@afs.example.net/x`, note: token }, 'Fetch');
    expect(lines[0]).not.toContain(token);
    expect(lines[0]).toContain(`note=${HIDDEN}`);
  });
});

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

for (const [name, config] of databases) {
  describe.skipIf(!config)(`tokens on ${name}`, () => {
    let database: Database;
    let dana: string;
    const db = () => database.db;

    beforeAll(async () => {
      if (!config) return;
      database = openDatabase(config);
      await migrate(database.db as never);
    });
    afterAll(async () => {
      await database?.close();
    });
    beforeEach(async () => {
      for (const table of ['api_token', 'session', 'group_member', 'user_account'] as const)
        await db().deleteFrom(table).execute();
      dana = (await createUser(db(), { login: 'dana', name: 'Dana Whitfield', password: PASSWORD }))
        .id;
    });

    it('is shown once, kept as a hash, and acts as its owner', async () => {
      const now = new Date('2026-11-13T09:00:00Z');
      const { token, info } = await createToken(db(), dana, { name: ' laptop git ' }, now);
      expect(looksLikeToken(token)).toBe(true);
      expect(info).toMatchObject({ name: 'laptop git', hint: token.slice(-4), readOnly: false });
      expect(Date.parse(info.expiresAt ?? '')).toBe(now.getTime() + TOKEN_DAYS * DAY);

      const row = await db().selectFrom('api_token').selectAll().executeTakeFirstOrThrow();
      expect(JSON.stringify(row)).not.toContain(token.slice(4));
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);

      const user = await tokenUser(db(), token, now);
      expect(user).toMatchObject({
        id: dana,
        login: 'dana',
        admin: false,
        token: { id: info.id, readOnly: false },
      });
      expect(await tokenUser(db(), `afs_${'B'.repeat(43)}`, now)).toBeUndefined();
      expect(await tokenUser(db(), 'not a token', now)).toBeUndefined();
    });

    it('notes when it was last used, at most once a minute', async () => {
      const now = new Date('2026-11-13T09:00:00Z');
      const { token } = await createToken(db(), dana, { name: 'ci' }, now);
      expect((await listTokens(db(), dana))[0]?.lastUsedAt).toBeUndefined();
      await tokenUser(db(), token, now);
      await tokenUser(db(), token, new Date(now.getTime() + 30_000));
      expect((await listTokens(db(), dana))[0]?.lastUsedAt).toBe(now.toISOString());
      const later = new Date(now.getTime() + 61_000);
      await tokenUser(db(), token, later);
      expect((await listTokens(db(), dana))[0]?.lastUsedAt).toBe(later.toISOString());
    });

    it('stops at its end, when revoked, and when its owner is disabled or deleted', async () => {
      const now = new Date('2026-11-13T09:00:00Z');
      const short = await createToken(db(), dana, { name: 'short', days: 1 }, now);
      const long = await createToken(db(), dana, { name: 'long', days: 365, readOnly: true }, now);
      expect(await tokenUser(db(), short.token, new Date(now.getTime() + DAY - 1))).toBeDefined();
      expect(await tokenUser(db(), short.token, new Date(now.getTime() + DAY))).toBeUndefined();
      expect((await tokenUser(db(), long.token, now))?.token).toEqual({
        id: long.info.id,
        readOnly: true,
      });

      // The sweep removes only what is past its end.
      expect(await sweepTokens(db(), new Date(now.getTime() + 2 * DAY))).toBe(1);
      expect((await listTokens(db(), dana)).map((t) => t.name)).toEqual(['long']);

      await updateUser(db(), dana, { disabled: true });
      expect(await tokenUser(db(), long.token, now)).toBeUndefined();
      await updateUser(db(), dana, { disabled: false });
      expect(await tokenUser(db(), long.token, now)).toBeDefined();

      // Someone else cannot revoke it; its owner can.
      const omar = await createUser(db(), { login: 'omar', name: 'Omar', password: PASSWORD });
      expect(await revokeToken(db(), omar.id, long.info.id)).toBe(false);
      expect(await revokeToken(db(), dana, long.info.id)).toBe(true);
      expect(await tokenUser(db(), long.token, now)).toBeUndefined();

      const last = await createToken(db(), omar.id, { name: 'gone with omar' }, now);
      await deleteUser(db(), omar.id);
      expect(await tokenUser(db(), last.token, now)).toBeUndefined();
      expect(await db().selectFrom('api_token').selectAll().execute()).toEqual([]);
    });

    it('refuses a bad name, a bad length of life, and one token too many', async () => {
      const refused = async (input: Parameters<typeof createToken>[2]) =>
        createToken(db(), dana, input).then(
          () => 'made',
          (e) => (e instanceof UserError ? e.message : 'other'),
        );
      expect(await refused({ name: '  ' })).toMatch(/name of 1 to 100/);
      expect(await refused({ name: 'x'.repeat(101) })).toMatch(/name of 1 to 100/);
      expect(await refused({ name: 'ci', days: 0 })).toMatch(/1 to 365 days/);
      expect(await refused({ name: 'ci', days: 366 })).toMatch(/1 to 365 days/);
      expect(await refused({ name: 'ci', days: 1.5 })).toMatch(/1 to 365 days/);
      for (let i = 0; i < TOKEN_LIMIT; i++) await createToken(db(), dana, { name: `t${i}` });
      expect(await refused({ name: 'one more' })).toMatch(/at most 50 tokens/);
    });
  });
}

describe('tokens over HTTP', () => {
  let database: Database;
  let app: FastifyInstance;
  let lines: string[];

  beforeEach(async () => {
    lines = [];
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    app = buildApp({
      log: createLogger({ level: 'debug', format: 'json', write: (line) => lines.push(line) }),
      database,
      instance: 'test',
      secureCookies: true,
    });
  });
  afterEach(async () => {
    await app.close();
    await database.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    options: { cookie?: string; auth?: string; body?: unknown } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.auth ? { authorization: options.auth } : {}),
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
    });
  async function person(login: string, admin = false) {
    const user = await createUser(database.db, { login, name: login, password: PASSWORD, admin });
    const reply = await call('POST', '/api/v1/session', { body: { login, password: PASSWORD } });
    const set = [reply.headers['set-cookie']].flat().join('; ');
    return { id: user.id, cookie: /afs_session=[^;]*/.exec(set)?.[0] ?? '' };
  }
  const made = async (cookie: string, body: Record<string, unknown>) => {
    const reply = await call('POST', '/api/v1/tokens', { cookie, body });
    expect(reply.statusCode).toBe(201);
    return reply.json() as { id: string; token: string; hint: string; readOnly: boolean };
  };

  it('is made in a session, shown once, and signs a program in', async () => {
    const dana = await person('dana');
    expect((await call('POST', '/api/v1/tokens', { body: { name: 'x' } })).statusCode).toBe(401);
    const token = await made(dana.cookie, { name: 'laptop git', expiresInDays: 30 });
    expect(looksLikeToken(token.token)).toBe(true);

    const list = (await call('GET', '/api/v1/tokens', { cookie: dana.cookie })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: token.id, name: 'laptop git', hint: token.hint });
    expect(JSON.stringify(list)).not.toContain(token.token);

    for (const auth of [`Bearer ${token.token}`, basic('anything', token.token)]) {
      const me = await call('GET', '/api/v1/session', { auth });
      expect(me.statusCode).toBe(200);
      expect(me.json().login).toBe('dana');
      // A token sign-in starts no session.
      expect(me.headers['set-cookie']).toBeUndefined();
    }
    // The token is in the answer that made it, and in no log line.
    expect(lines.join('\n')).not.toContain(token.token);
    expect(lines.join('\n')).toContain('Access token made');
  });

  it('cannot make tokens, revoke them or set passwords: that takes a session', async () => {
    const admin = await person('root', true);
    const token = await made(admin.cookie, { name: 'automation' });
    const auth = `Bearer ${token.token}`;
    const needs = async (method: 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => {
      const reply = await call(method, url, { auth, body });
      expect(reply.statusCode, `${method} ${url}`).toBe(403);
      expect(reply.json().error).toBe('session_needed');
    };
    await needs('POST', '/api/v1/tokens', { name: 'successor' });
    await needs('DELETE', `/api/v1/tokens/${token.id}`);
    await needs('PUT', '/api/v1/session/password', { current: PASSWORD, password: `${PASSWORD}!` });
    await needs('PUT', `/api/v1/users/${admin.id}/password`, { password: `${PASSWORD}!` });
    // What an administrator's token may do, it does.
    expect((await call('GET', '/api/v1/users', { auth })).statusCode).toBe(200);
  });

  it('a read-only token reads and changes nothing', async () => {
    const admin = await person('root', true);
    const token = await made(admin.cookie, { name: 'dashboard', readOnly: true });
    const auth = `Bearer ${token.token}`;
    expect((await call('GET', '/api/v1/users', { auth })).statusCode).toBe(200);
    const write = await call('POST', '/api/v1/groups', { auth, body: { name: 'ops' } });
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toBe('read_only_token');
    expect((await call('GET', '/api/v1/groups', { auth })).json()).toEqual([]);
  });

  it('a wrong token is refused even where no sign-in is needed, and guessing is limited', async () => {
    const wrong = `Bearer afs_${'x'.repeat(43)}`;
    const reply = await call('GET', '/api/v1/setup', { auth: wrong });
    expect(reply.statusCode).toBe(401);
    expect(reply.json().message).toMatch(/not valid/);
    // Something that is no token of ours is not looked at.
    expect((await call('GET', '/api/v1/setup', { auth: 'Bearer other' })).statusCode).toBe(200);
    for (let i = 0; i < 29; i++) await call('GET', '/api/v1/setup', { auth: wrong });
    const limited = await call('GET', '/api/v1/setup', { auth: wrong });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('is revoked by its owner or an administrator, and by nobody else', async () => {
    const admin = await person('root', true);
    const dana = await person('dana');
    const omar = await person('omar');
    const one = await made(dana.cookie, { name: 'one' });
    const two = await made(dana.cookie, { name: 'two' });

    // Someone else neither sees nor revokes it.
    expect((await call('GET', '/api/v1/tokens', { cookie: omar.cookie })).json()).toEqual([]);
    expect(
      (await call('DELETE', `/api/v1/tokens/${one.id}`, { cookie: omar.cookie })).statusCode,
    ).toBe(404);
    expect(
      (await call('GET', `/api/v1/users/${dana.id}/tokens`, { cookie: omar.cookie })).statusCode,
    ).toBe(403);

    expect(
      (await call('DELETE', `/api/v1/tokens/${one.id}`, { cookie: dana.cookie })).statusCode,
    ).toBe(204);
    expect((await call('GET', '/api/v1/session', { auth: `Bearer ${one.token}` })).statusCode).toBe(
      401,
    );

    const seen = await call('GET', `/api/v1/users/${dana.id}/tokens`, { cookie: admin.cookie });
    expect(seen.json().map((t: { name: string }) => t.name)).toEqual(['two']);
    expect(
      (
        await call('DELETE', `/api/v1/users/${dana.id}/tokens/${two.id}`, {
          cookie: admin.cookie,
        })
      ).statusCode,
    ).toBe(204);
    expect((await call('GET', '/api/v1/session', { auth: `Bearer ${two.token}` })).statusCode).toBe(
      401,
    );
  });

  it('is not made with fields the server does not know, or a life that is too long', async () => {
    const dana = await person('dana');
    for (const body of [
      { name: 'x', admin: true },
      { name: 'x', expiresInDays: 400 },
      { name: '' },
      {},
    ]) {
      const reply = await call('POST', '/api/v1/tokens', { cookie: dana.cookie, body });
      expect(reply.statusCode, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('the token command', () => {
  it('prints the token and nothing else', async () => {
    const database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    const user = await createUser(database.db, { login: 'ci', name: 'CI', password: PASSWORD });
    const run = async (...args: string[]) => {
      const out: string[] = [];
      const code = await userCommand(
        database.db,
        args,
        (line) => out.push(line),
        async () => '',
      );
      return { code, out };
    };
    const made = await run('token', 'ci', '--name', 'pipeline', '--days', '7', '--read-only');
    expect(made.code).toBe(0);
    expect(made.out).toHaveLength(1);
    expect(await tokenUser(database.db, made.out[0] ?? '')).toMatchObject({
      id: user.id,
      token: { readOnly: true },
    });
    expect((await listTokens(database.db, user.id))[0]).toMatchObject({ name: 'pipeline' });
    expect((await run('token', 'nobody')).code).toBe(1);
    expect((await run('token', 'ci', '--days', 'many')).code).toBe(1);
    expect((await run('token')).code).toBe(1);
    await database.close();
  });
});
