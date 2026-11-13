// Passwords, people, groups and sessions, on both databases the server supports (PostgreSQL when
// AFS_TEST_POSTGRES_URL is set).

import { PassThrough } from 'node:stream';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readPassword, userCommand } from '../../src/server/auth/cli';
import { FailureLimiter } from '../../src/server/auth/limiter';
import { hashPassword, passwordProblem, verifyPassword } from '../../src/server/auth/passwords';
import {
  endSession,
  IDLE_MS,
  MAX_MS,
  sessionCookie,
  sessionUser,
  startSession,
  sweepSessions,
  tokenOf,
} from '../../src/server/auth/sessions';
import { createFirstAdmin, setupCode, setupNeeded } from '../../src/server/auth/setup';
import {
  accountByLogin,
  createGroup,
  createUser,
  deleteGroup,
  deleteUser,
  getUser,
  listGroups,
  listUsers,
  setMembers,
  setPassword,
  UserError,
  updateGroup,
  updateUser,
} from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { emptyPeople } from './helpers/clean';

const PASSWORD = 'correct horse battery staple';

describe('passwords', () => {
  it('says why a password is not accepted', () => {
    expect(passwordProblem('short')).toMatch(/at least 12/);
    expect(passwordProblem('x'.repeat(300))).toMatch(/at most 256/);
    expect(passwordProblem('dana-is-the-best-1', 'Dana')).toMatch(/does not contain the login/);
    expect(passwordProblem('aaaaaaaaaaaaaaaa')).toMatch(/different characters/);
    expect(passwordProblem(PASSWORD, 'dana')).toBeUndefined();
  });

  it('keeps a hash with its own salt, and checks against it', async () => {
    const one = await hashPassword(PASSWORD);
    const two = await hashPassword(PASSWORD);
    expect(one).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(one).not.toBe(two);
    expect(one).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, one)).toBe(true);
    expect(await verifyPassword(`${PASSWORD}!`, one)).toBe(false);
    expect(await verifyPassword('', one)).toBe(false);
  });

  it('with no hash, or text that is no hash, the answer is no', async () => {
    expect(await verifyPassword(PASSWORD, null)).toBe(false);
    expect(await verifyPassword(PASSWORD, 'plain text')).toBe(false);
  });
});

describe('the failure limiter', () => {
  it('refuses after the allowed failures, and allows again when the window has passed', () => {
    const limiter = new FailureLimiter({ max: 3, windowMs: 60_000 });
    expect(limiter.retryAfter('login:dana', 0)).toBe(0);
    limiter.fail('login:dana', 0);
    limiter.fail('login:dana', 10_000);
    expect(limiter.retryAfter('login:dana', 20_000)).toBe(0);
    limiter.fail('login:dana', 20_000);
    expect(limiter.retryAfter('login:dana', 21_000)).toBe(39);
    expect(limiter.retryAfter('login:omar', 21_000)).toBe(0);
    expect(limiter.retryAfter('login:dana', 60_001)).toBe(0);
  });

  it('a success starts the count again', () => {
    const limiter = new FailureLimiter({ max: 2, windowMs: 60_000 });
    limiter.fail('k', 0);
    limiter.fail('k', 1);
    expect(limiter.retryAfter('k', 2)).toBeGreaterThan(0);
    limiter.clear('k');
    expect(limiter.retryAfter('k', 3)).toBe(0);
  });
});

describe('the session cookie', () => {
  it('is not readable by scripts, stays on this site, and is for HTTPS only when asked', () => {
    const secure = sessionCookie('tok', true);
    expect(secure).toContain('afs_session=tok');
    expect(secure).toContain('HttpOnly');
    expect(secure).toContain('SameSite=Lax');
    expect(secure).toContain('Secure');
    expect(secure).toContain(`Max-Age=${MAX_MS / 1000}`);
    expect(sessionCookie('tok', false)).not.toContain('Secure');
    expect(sessionCookie(undefined, true)).toContain('Max-Age=0');
  });

  it('is found among other cookies, and refused when it is not a token', () => {
    const token = 'A'.repeat(43);
    expect(tokenOf(`theme=dark; afs_session=${token}; other=1`)).toBe(token);
    expect(tokenOf('theme=dark')).toBeUndefined();
    expect(tokenOf(undefined)).toBeUndefined();
    expect(tokenOf('afs_session=short')).toBeUndefined();
    expect(tokenOf('afs_session=has spaces and ; stuff')).toBeUndefined();
  });
});

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

for (const [name, config] of databases) {
  describe.skipIf(!config)(`people, groups and sessions on ${name}`, () => {
    let database: Database;
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
      // Each test starts with no people. Children first, for a database without cascades on.
      await emptyPeople(db());
      await sql`delete from setting where name = 'setup.code'`.execute(db());
    });

    it('adds a person; the login is lower case and unique', async () => {
      const dana = await createUser(db(), {
        login: ' Dana ',
        name: 'Dana Whitfield',
        password: PASSWORD,
        email: 'dana@example.net',
        admin: true,
      });
      expect(dana).toMatchObject({
        login: 'dana',
        name: 'Dana Whitfield',
        email: 'dana@example.net',
        admin: true,
        disabled: false,
        groups: [],
      });
      expect(JSON.stringify(dana)).not.toContain('argon2');
      await expect(createUser(db(), { login: 'DANA', name: 'Other' })).rejects.toMatchObject({
        code: 'taken',
      });
      expect((await listUsers(db())).map((u) => u.login)).toEqual(['dana']);
      // The hash is kept, the password is not.
      const account = await accountByLogin(db(), 'Dana');
      expect(account?.password_hash).toMatch(/^\$argon2id\$/);
      expect(await verifyPassword(PASSWORD, account?.password_hash ?? null)).toBe(true);
    });

    it('refuses a login, an email or a webhook address that is not one', async () => {
      for (const input of [
        { login: 'a', name: 'x' },
        { login: 'has space', name: 'x' },
        { login: 'dana', name: 'x', email: 'not-an-email' },
        { login: 'dana', name: 'x', webhookUrl: 'ftp://hooks.example.net/x' },
      ])
        await expect(createUser(db(), input)).rejects.toMatchObject({ code: 'invalid' });
      expect(await listUsers(db())).toEqual([]);
    });

    it('the last administrator who can sign in stays one', async () => {
      const dana = await createUser(db(), { login: 'dana', name: 'Dana', admin: true });
      const omar = await createUser(db(), { login: 'omar', name: 'Omar' });
      for (const change of [{ admin: false }, { disabled: true }])
        await expect(updateUser(db(), dana.id, change)).rejects.toMatchObject({
          code: 'last_admin',
        });
      await expect(deleteUser(db(), dana.id)).rejects.toMatchObject({ code: 'last_admin' });
      // With a second administrator, the first may go.
      await updateUser(db(), omar.id, { admin: true });
      expect((await updateUser(db(), dana.id, { admin: false })).admin).toBe(false);
      // A disabled administrator does not count as one.
      const lena = await createUser(db(), { login: 'lena', name: 'Lena', admin: true });
      await updateUser(db(), lena.id, { disabled: true });
      await expect(updateUser(db(), omar.id, { admin: false })).rejects.toMatchObject({
        code: 'last_admin',
      });
    });

    it('changes a person, and says so when there is no such person', async () => {
      const dana = await createUser(db(), { login: 'dana', name: 'Dana', email: 'd@example.net' });
      const changed = await updateUser(db(), dana.id, {
        name: 'Dana W.',
        email: null,
        webhookUrl: 'https://hooks.example.net/dana',
      });
      expect(changed).toMatchObject({
        name: 'Dana W.',
        webhookUrl: 'https://hooks.example.net/dana',
      });
      expect(changed.email).toBeUndefined();
      await expect(updateUser(db(), 'nobody', { name: 'x' })).rejects.toBeInstanceOf(UserError);
      await expect(deleteUser(db(), 'nobody')).rejects.toMatchObject({ code: 'not_found' });
    });

    it('groups have members, by name on the person and by login on the group', async () => {
      const dana = await createUser(db(), { login: 'dana', name: 'Dana' });
      const omar = await createUser(db(), { login: 'omar', name: 'Omar' });
      const net = await createGroup(db(), { name: 'Network', email: 'net@example.net' });
      await createGroup(db(), { name: 'Approvers' });
      await expect(createGroup(db(), { name: 'Network' })).rejects.toMatchObject({ code: 'taken' });

      expect((await setMembers(db(), net.id, [omar.id, dana.id, dana.id])).members).toEqual([
        'dana',
        'omar',
      ]);
      expect((await getUser(db(), dana.id))?.groups).toEqual(['Network']);
      expect((await setMembers(db(), net.id, [omar.id])).members).toEqual(['omar']);
      await expect(setMembers(db(), net.id, ['nobody'])).rejects.toMatchObject({ code: 'invalid' });
      await expect(setMembers(db(), 'no-group', [])).rejects.toMatchObject({ code: 'not_found' });

      expect((await updateGroup(db(), net.id, { name: 'Network team' })).name).toBe('Network team');
      await expect(updateGroup(db(), net.id, { name: 'Approvers' })).rejects.toMatchObject({
        code: 'taken',
      });
      // A person who is deleted leaves their groups; a group that is deleted leaves its people.
      await deleteUser(db(), omar.id);
      expect((await listGroups(db())).find((g) => g.id === net.id)?.members).toEqual([]);
      await setMembers(db(), net.id, [dana.id]);
      await deleteGroup(db(), net.id);
      expect((await getUser(db(), dana.id))?.groups).toEqual([]);
      expect((await listGroups(db())).map((g) => g.name)).toEqual(['Approvers']);
    });

    it('a session is good until it is ended, goes idle, or reaches its end', async () => {
      const dana = await createUser(db(), { login: 'dana', name: 'Dana', admin: true });
      const t0 = new Date('2026-11-13T08:00:00.000Z');
      const token = await startSession(db(), dana.id, { ip: '10.0.0.7', userAgent: 'test' }, t0);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // The table holds the token's hash, not the token.
      const rows = await db().selectFrom('session').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).not.toBe(token);
      expect(JSON.stringify(rows)).not.toContain(token);
      expect((await getUser(db(), dana.id))?.lastLoginAt).toBe(t0.toISOString());

      const at = (ms: number) => new Date(t0.getTime() + ms);
      expect(await sessionUser(db(), token, at(1000))).toMatchObject({
        login: 'dana',
        admin: true,
      });
      expect(await sessionUser(db(), 'x'.repeat(43), at(1000))).toBeUndefined();
      // Used within the idle time, it stays alive past it...
      expect(await sessionUser(db(), token, at(IDLE_MS - 1000))).toBeDefined();
      expect(await sessionUser(db(), token, at(2 * IDLE_MS - 2000))).toBeDefined();
      // ...and left alone longer than that, it is over.
      expect(await sessionUser(db(), token, at(3 * IDLE_MS))).toBeUndefined();
      expect(await db().selectFrom('session').selectAll().execute()).toHaveLength(0);

      // Its end comes whatever happens.
      const long = await startSession(db(), dana.id, {}, t0);
      for (let ms = IDLE_MS / 2; ms < MAX_MS; ms += IDLE_MS / 2)
        expect(await sessionUser(db(), long, at(ms))).toBeDefined();
      expect(await sessionUser(db(), long, at(MAX_MS + 1))).toBeUndefined();

      const ended = await startSession(db(), dana.id, {}, t0);
      await endSession(db(), ended);
      expect(await sessionUser(db(), ended, at(1000))).toBeUndefined();
    });

    it('disabling a person, or setting their password, signs them out', async () => {
      const dana = await createUser(db(), { login: 'dana', name: 'Dana', password: PASSWORD });
      await createUser(db(), { login: 'omar', name: 'Omar', admin: true });
      const here = await startSession(db(), dana.id, {});
      const there = await startSession(db(), dana.id, {});
      const mine = (await sessionUser(db(), here))?.session;

      // A new password: the session it was changed from stays, the others end.
      await setPassword(db(), dana.id, 'another long passphrase', mine);
      expect(await sessionUser(db(), here)).toBeDefined();
      expect(await sessionUser(db(), there)).toBeUndefined();
      const account = await accountByLogin(db(), 'dana');
      expect(await verifyPassword(PASSWORD, account?.password_hash ?? null)).toBe(false);
      expect(await verifyPassword('another long passphrase', account?.password_hash ?? null)).toBe(
        true,
      );

      await updateUser(db(), dana.id, { disabled: true });
      expect(await sessionUser(db(), here)).toBeUndefined();
    });

    it('removes the sessions that have ended', async () => {
      const dana = await createUser(db(), { login: 'dana', name: 'Dana' });
      const t0 = new Date('2026-11-13T08:00:00.000Z');
      await startSession(db(), dana.id, {}, t0);
      const fresh = await startSession(db(), dana.id, {}, new Date(t0.getTime() + IDLE_MS));
      expect(await sweepSessions(db(), new Date(t0.getTime() + IDLE_MS + 60_000))).toBe(1);
      expect(
        await sessionUser(db(), fresh, new Date(t0.getTime() + IDLE_MS + 60_000)),
      ).toBeDefined();
    });

    it('the first administrator is made once, with the code from the log', async () => {
      expect(await setupNeeded(db())).toBe(true);
      const code = await setupCode(db());
      expect(code).toMatch(/^[A-Za-z0-9_-]{12}$/);
      const input = { login: 'dana', name: 'Dana', password: PASSWORD };
      await expect(createFirstAdmin(db(), 'wrong-code', input)).rejects.toThrow(/setup code/);
      await expect(
        createFirstAdmin(db(), code as string, { ...input, password: 'short' }),
      ).rejects.toThrow(/at least 12/);
      expect(await listUsers(db())).toEqual([]);

      const admin = await createFirstAdmin(db(), code as string, input);
      expect(admin).toMatchObject({ login: 'dana', admin: true });
      // Once there is a user: no more setup, and no new code.
      expect(await setupNeeded(db())).toBe(false);
      expect(await setupCode(db())).toBeUndefined();
      await expect(
        createFirstAdmin(db(), code as string, { ...input, login: 'mallory' }),
      ).rejects.toThrow(/set up already/);
      expect((await listUsers(db())).map((u) => u.login)).toEqual(['dana']);
    });
  });
}

describe('reading a password from piped input', () => {
  it('takes the first line, and nothing when there is none', async () => {
    const piped = new PassThrough();
    const answer = readPassword('Password: ', piped);
    piped.end(['the way back in 2026!', 'second line', ''].join('\n'));
    expect(await answer).toBe('the way back in 2026!');

    const empty = new PassThrough();
    const none = readPassword('Password: ', empty);
    empty.end();
    expect(await none).toBe('');
  });
});

describe('the user commands', () => {
  let database: Database;
  beforeAll(async () => {
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
  });
  afterAll(() => database.close());
  const run = async (password: string | undefined, ...args: string[]) => {
    const out: string[] = [];
    const asked: string[] = [];
    const code = await userCommand(
      database.db,
      args,
      (line) => out.push(line),
      async (prompt) => {
        asked.push(prompt);
        return password ?? '';
      },
    );
    return { code, text: out.join('\n'), asked };
  };

  it('add, list, set a password, disable and make an administrator', async () => {
    expect((await run(undefined, 'list')).text).toBe('No users yet.');
    const added = await run(PASSWORD, 'add', 'Dana', '--name', 'Dana Whitfield', '--admin');
    expect(added).toMatchObject({ code: 0, text: 'Added dana as an administrator.' });
    expect(added.asked).toEqual(['Password for Dana: ']);
    expect((await run(PASSWORD, 'add', 'omar')).code).toBe(0);
    const list = (await run(undefined, 'list')).text.split('\n');
    expect(list[0]).toMatch(/^dana\s+admin\s+active\s+Dana Whitfield$/);
    expect(list[1]).toMatch(/^omar\s+user\s+active\s+omar$/);

    // The password that was typed is the one that signs in; it is printed nowhere.
    const next = 'the way back in again';
    const set = await run(next, 'password', 'omar');
    expect(set.code).toBe(0);
    expect(set.text).not.toContain(next);
    const account = await accountByLogin(database.db, 'omar');
    expect(await verifyPassword(next, account?.password_hash ?? null)).toBe(true);

    expect((await run(undefined, 'disable', 'omar')).text).toMatch(/disabled and signed out/);
    expect((await run(undefined, 'enable', 'omar')).text).toMatch(/enabled/);
    expect((await run(undefined, 'admin', 'omar', 'on')).text).toMatch(/is an administrator/);
  });

  it('refuses what the rules refuse, and says how it is used', async () => {
    expect(await run('short', 'add', 'lena')).toMatchObject({ code: 1 });
    expect((await run(PASSWORD, 'add', 'dana')).text).toMatch(/taken/);
    expect((await run(PASSWORD, 'password', 'nobody')).code).toBe(1);
    expect((await run(undefined, 'admin', 'omar', 'off')).code).toBe(0);
    expect((await run(undefined, 'admin', 'dana', 'off')).text).toMatch(/only administrator/);
    expect((await run(undefined, 'admin', 'dana')).code).toBe(2);
    expect((await run(undefined, 'frobnicate')).code).toBe(2);
    expect((await run(undefined, 'add')).code).toBe(2);
  });
});
