// Sign-in, the first administrator, and people and groups, over HTTP.
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { setupCode } from '../../src/server/auth/setup';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';

const PASSWORD = 'correct horse battery staple';
let database: Database;
let app: FastifyInstance;
let lines: string[];

beforeEach(async () => {
  lines = [];
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  app = buildApp({
    log: createLogger({ level: 'info', format: 'json', write: (line) => lines.push(line) }),
    database,
    instance: 'test',
    secureCookies: true,
  });
});
afterEach(async () => {
  await app.close();
  await database.close();
});

type Reply = Awaited<ReturnType<FastifyInstance['inject']>>;
/** The session cookie a reply set, as a request sends it back. */
const cookieOf = (reply: Reply): string => {
  const set = [reply.headers['set-cookie']].flat().join('; ');
  return /afs_session=[^;]*/.exec(set)?.[0] ?? '';
};
const call = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
) =>
  app.inject({
    method,
    url,
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
  });
/** Makes a person and signs them in; resolves with their cookie. */
async function signedIn(login: string, admin = false): Promise<{ cookie: string; id: string }> {
  const user = await createUser(database.db, { login, name: login, password: PASSWORD, admin });
  const reply = await call('POST', '/api/v1/session', { body: { login, password: PASSWORD } });
  expect(reply.statusCode).toBe(200);
  return { cookie: cookieOf(reply), id: user.id };
}

describe('the first administrator', () => {
  it('is made with the setup code, is signed in, and setup is then closed', async () => {
    expect((await call('GET', '/api/v1/setup')).json()).toEqual({ needed: true });
    const code = (await setupCode(database.db)) as string;
    const input = { login: 'dana', name: 'Dana Whitfield', password: PASSWORD };

    const wrong = await call('POST', '/api/v1/setup', { body: { ...input, code: 'guess' } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().message).toMatch(/setup code/);

    const made = await call('POST', '/api/v1/setup', { body: { ...input, code } });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ login: 'dana', admin: true });
    const me = await call('GET', '/api/v1/session', { cookie: cookieOf(made) });
    expect(me.json()).toMatchObject({ login: 'dana', name: 'Dana Whitfield' });

    expect((await call('GET', '/api/v1/setup')).json()).toEqual({ needed: false });
    const again = await call('POST', '/api/v1/setup', {
      body: { ...input, login: 'mallory', code },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().message).toMatch(/set up already/);
  });

  it('guessing the setup code is stopped', async () => {
    await setupCode(database.db);
    const guess = (n: number) =>
      call('POST', '/api/v1/setup', {
        body: { code: `guess-${n}`, login: 'mallory', password: PASSWORD },
      });
    let last = await guess(0);
    for (let n = 1; n <= 30; n++) last = await guess(n);
    expect(last.statusCode).toBe(429);
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('signing in', () => {
  it('sets a cookie for this site only; with it the server knows who asks', async () => {
    await createUser(database.db, { login: 'dana', name: 'Dana', password: PASSWORD });
    const reply = await call('POST', '/api/v1/session', {
      body: { login: 'Dana', password: PASSWORD },
    });
    expect(reply.statusCode).toBe(200);
    const set = String(reply.headers['set-cookie']);
    expect(set).toMatch(/afs_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Secure;/);
    expect(reply.json()).toMatchObject({ login: 'dana' });
    expect(reply.body).not.toContain('argon2');

    expect(
      (await call('GET', '/api/v1/session', { cookie: cookieOf(reply) })).json(),
    ).toMatchObject({ login: 'dana', admin: false });
    expect((await call('GET', '/api/v1/session')).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/session', { cookie: 'afs_session=nope' })).statusCode).toBe(
      401,
    );
  });

  it('gives one answer for a wrong password, an unknown login and a disabled account', async () => {
    const user = await createUser(database.db, { login: 'dana', name: 'Dana', password: PASSWORD });
    await createUser(database.db, { login: 'gone', name: 'Gone', password: PASSWORD });
    const gone = await call('POST', '/api/v1/session', {
      body: { login: 'gone', password: PASSWORD },
    });
    expect(gone.statusCode).toBe(200);
    await database.db
      .updateTable('user_account')
      .set({ disabled: 1 })
      .where('login', '=', 'gone')
      .execute();
    const answers = await Promise.all(
      [
        { login: 'dana', password: 'not the password!' },
        { login: 'nobody', password: PASSWORD },
        { login: 'gone', password: PASSWORD },
      ].map((body) => call('POST', '/api/v1/session', { body })),
    );
    for (const answer of answers) {
      expect(answer.statusCode).toBe(401);
      expect(answer.json()).toEqual({
        error: 'invalid_credentials',
        message: 'The login or the password is wrong',
      });
      expect(answer.headers['set-cookie']).toBeUndefined();
    }
    expect(user.id).toBeTruthy();
    // The log names the login that failed, never the password.
    const log = lines.join('\n');
    expect(log).toContain('Sign-in refused');
    expect(log).not.toContain('not the password!');
    expect(log).not.toContain(PASSWORD);
  });

  it('stops after five wrong passwords for a login, also for the right one, and says how long', async () => {
    await createUser(database.db, { login: 'dana', name: 'Dana', password: PASSWORD });
    for (let i = 0; i < 5; i++) {
      const wrong = await call('POST', '/api/v1/session', {
        body: { login: 'dana', password: `wrong password ${i}` },
      });
      expect(wrong.statusCode).toBe(401);
    }
    const blocked = await call('POST', '/api/v1/session', {
      body: { login: 'dana', password: PASSWORD },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('too_many_attempts');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(800);
    // Another login is not held back by it.
    await createUser(database.db, { login: 'omar', name: 'Omar', password: PASSWORD });
    const other = await call('POST', '/api/v1/session', {
      body: { login: 'omar', password: PASSWORD },
    });
    expect(other.statusCode).toBe(200);
  });

  it('signing out ends the session and clears the cookie', async () => {
    const { cookie } = await signedIn('dana');
    const out = await call('DELETE', '/api/v1/session', { cookie });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await call('GET', '/api/v1/session', { cookie })).statusCode).toBe(401);
  });

  it("refuses a change that another site asks for in the user's name", async () => {
    const { cookie } = await signedIn('dana');
    const foreign = await call('DELETE', '/api/v1/session', {
      cookie,
      headers: { origin: 'https://evil.example', host: 'flows.example.net' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error).toBe('cross_site');
    // The session is still there: the request did nothing.
    expect((await call('GET', '/api/v1/session', { cookie })).statusCode).toBe(200);
    const own = await call('DELETE', '/api/v1/session', {
      cookie,
      headers: { origin: 'https://flows.example.net', host: 'flows.example.net' },
    });
    expect(own.statusCode).toBe(204);
  });

  it('a body that does not fit is a 400 with the reason, and unknown fields are refused', async () => {
    const missing = await call('POST', '/api/v1/session', { body: { login: 'dana' } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe('invalid');
    const extra = await call('POST', '/api/v1/session', {
      body: { login: 'dana', password: PASSWORD, admin: true },
    });
    expect(extra.statusCode).toBe(400);
  });
});

describe('changing my password', () => {
  it('needs the current one, keeps this session and ends my others', async () => {
    const { cookie } = await signedIn('dana');
    const second = await call('POST', '/api/v1/session', {
      body: { login: 'dana', password: PASSWORD },
    });
    const next = 'a much better passphrase';

    const wrong = await call('PUT', '/api/v1/session/password', {
      cookie,
      body: { current: 'not it at all!', password: next },
    });
    expect(wrong.statusCode).toBe(403);
    const weak = await call('PUT', '/api/v1/session/password', {
      cookie,
      body: { current: PASSWORD, password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().message).toMatch(/at least 12/);

    const done = await call('PUT', '/api/v1/session/password', {
      cookie,
      body: { current: PASSWORD, password: next },
    });
    expect(done.statusCode).toBe(204);
    expect((await call('GET', '/api/v1/session', { cookie })).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/session', { cookie: cookieOf(second) })).statusCode).toBe(
      401,
    );
    const old = await call('POST', '/api/v1/session', {
      body: { login: 'dana', password: PASSWORD },
    });
    expect(old.statusCode).toBe(401);
    const fresh = await call('POST', '/api/v1/session', {
      body: { login: 'dana', password: next },
    });
    expect(fresh.statusCode).toBe(200);
    expect(lines.join('\n')).not.toContain(next);
  });
});

describe('people and groups, for administrators', () => {
  it('nobody else may read or change them', async () => {
    const { cookie } = await signedIn('omar');
    for (const [method, url, body] of [
      ['GET', '/api/v1/users', undefined],
      ['POST', '/api/v1/users', { login: 'x1' }],
      ['GET', '/api/v1/groups', undefined],
      ['POST', '/api/v1/groups', { name: 'Network' }],
    ] as const) {
      expect((await call(method, url, { body })).statusCode, `${method} ${url} signed out`).toBe(
        401,
      );
      expect((await call(method, url, { cookie, body })).statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('an administrator adds, changes, disables and deletes people', async () => {
    const admin = await signedIn('dana', true);
    const made = await call('POST', '/api/v1/users', {
      cookie: admin.cookie,
      body: { login: 'Omar', name: 'Omar Haddad', password: PASSWORD, email: 'omar@example.net' },
    });
    expect(made.statusCode).toBe(201);
    const omar = made.json() as { id: string };
    expect(made.json()).toMatchObject({ login: 'omar', admin: false, email: 'omar@example.net' });
    expect(made.body).not.toContain('argon2');

    expect(
      (await call('POST', '/api/v1/users', { cookie: admin.cookie, body: { login: 'omar' } }))
        .statusCode,
    ).toBe(409);
    const weak = await call('POST', '/api/v1/users', {
      cookie: admin.cookie,
      body: { login: 'lena', password: 'short' },
    });
    expect(weak.statusCode).toBe(400);

    const list = (await call('GET', '/api/v1/users', { cookie: admin.cookie })).json() as {
      login: string;
    }[];
    expect(list.map((u) => u.login)).toEqual(['dana', 'omar']);

    // Omar signs in; once disabled, his session is over and he cannot sign in.
    const session = await call('POST', '/api/v1/session', {
      body: { login: 'omar', password: PASSWORD },
    });
    const off = await call('PATCH', `/api/v1/users/${omar.id}`, {
      cookie: admin.cookie,
      body: { disabled: true, name: 'Omar H.' },
    });
    expect(off.json()).toMatchObject({ disabled: true, name: 'Omar H.' });
    expect((await call('GET', '/api/v1/session', { cookie: cookieOf(session) })).statusCode).toBe(
      401,
    );

    // An administrator sets a password for someone; a weak one is refused.
    expect(
      (
        await call('PUT', `/api/v1/users/${omar.id}/password`, {
          cookie: admin.cookie,
          body: { password: 'a new long passphrase' },
        })
      ).statusCode,
    ).toBe(204);

    expect(
      (await call('DELETE', `/api/v1/users/${omar.id}`, { cookie: admin.cookie })).statusCode,
    ).toBe(204);
    expect(
      (await call('GET', `/api/v1/users/${omar.id}`, { cookie: admin.cookie })).statusCode,
    ).toBe(404);
  });

  it('the only administrator cannot be removed, by others or by themself', async () => {
    const admin = await signedIn('dana', true);
    const demote = await call('PATCH', `/api/v1/users/${admin.id}`, {
      cookie: admin.cookie,
      body: { admin: false },
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error).toBe('last_admin');
    const self = await call('DELETE', `/api/v1/users/${admin.id}`, { cookie: admin.cookie });
    expect(self.statusCode).toBe(400);
    expect((await call('GET', '/api/v1/session', { cookie: admin.cookie })).statusCode).toBe(200);
  });

  it('groups: made, given members, renamed, deleted', async () => {
    const admin = await signedIn('dana', true);
    const omar = await createUser(database.db, { login: 'omar', name: 'Omar' });
    const made = await call('POST', '/api/v1/groups', {
      cookie: admin.cookie,
      body: { name: 'Change approvers', email: 'cab@example.net' },
    });
    expect(made.statusCode).toBe(201);
    const group = made.json() as { id: string };

    const members = await call('PUT', `/api/v1/groups/${group.id}/members`, {
      cookie: admin.cookie,
      body: { users: [omar.id, admin.id] },
    });
    expect(members.json()).toMatchObject({ members: ['dana', 'omar'] });
    expect((await call('GET', '/api/v1/session', { cookie: admin.cookie })).json()).toMatchObject({
      groups: ['Change approvers'],
    });

    const renamed = await call('PATCH', `/api/v1/groups/${group.id}`, {
      cookie: admin.cookie,
      body: { name: 'CAB', webhookUrl: 'https://hooks.example.net/cab' },
    });
    expect(renamed.json()).toMatchObject({
      name: 'CAB',
      webhookUrl: 'https://hooks.example.net/cab',
    });
    expect(
      (
        await call('PUT', `/api/v1/groups/${group.id}/members`, {
          cookie: admin.cookie,
          body: { users: ['nobody'] },
        })
      ).statusCode,
    ).toBe(400);

    expect(
      (await call('DELETE', `/api/v1/groups/${group.id}`, { cookie: admin.cookie })).statusCode,
    ).toBe(204);
    expect(
      (await call('GET', `/api/v1/groups/${group.id}`, { cookie: admin.cookie })).statusCode,
    ).toBe(404);
    expect((await call('DELETE', '/api/v1/groups/nope', { cookie: admin.cookie })).statusCode).toBe(
      404,
    );
  });
});
