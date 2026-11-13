// The master key, sealing, and the credentials store: the rules on both databases the server
// supports (PostgreSQL when AFS_TEST_POSTGRES_URL is set), the API and the commands.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import { type Config, loadConfig } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { createProject, createWorkspace, updateProject } from '../../src/server/projects/store';
import { secretsCommand } from '../../src/server/secrets/cli';
import {
  CredentialError,
  checkKey,
  createCredential,
  deleteCredential,
  getCredential,
  gitAuthOf,
  listCredentials,
  reveal,
  rotate,
  updateCredential,
} from '../../src/server/secrets/credentials';
import { open, SealError, seal, sealedWith } from '../../src/server/secrets/crypto';
import {
  keyId,
  loadMasterKey,
  type MasterKey,
  MasterKeyError,
  newKey,
  parseKey,
} from '../../src/server/secrets/masterKey';
import { emptyWorkspaces } from './helpers/clean';
import { grant } from './helpers/grant';

const PASSWORD = 'correct horse battery staple';
// Made up for the tests; not a key of anything.
const PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'b3BlbnNzaC1rZXktdjEAAAAA'.repeat(4)}\n-----END OPENSSH PRIVATE KEY-----\n`;
const root = mkdtempSync(join(tmpdir(), 'afs-secrets-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const keyOf = (bytes = newKey()): MasterKey => ({ key: bytes, id: keyId(bytes), source: 'env' });

describe('the master key', () => {
  it('is 32 bytes in base64, from the setting or a file', () => {
    const bytes = newKey();
    const fromEnv = loadMasterKey({ masterKey: bytes.toString('base64'), dataDir: root });
    expect(fromEnv).toMatchObject({ source: 'env', id: keyId(bytes) });
    expect(fromEnv.key.equals(bytes)).toBe(true);
    expect(parseKey(bytes.toString('base64url'), 'x').equals(bytes)).toBe(true);

    const file = join(root, 'given.key');
    writeFileSync(file, `${bytes.toString('base64')}\n`);
    expect(loadMasterKey({ masterKeyFile: file, dataDir: root })).toMatchObject({
      source: 'file',
      file,
      id: keyId(bytes),
    });
    // The id says which key, and nothing of the key.
    expect(fromEnv.id).toMatch(/^[0-9a-f]{8}$/);
    expect(bytes.toString('hex')).not.toContain(fromEnv.id);
  });

  it('refuses what is not a key, and never repeats it', () => {
    for (const bad of ['short', 'not base64 !!', Buffer.alloc(16).toString('base64'), '']) {
      try {
        parseKey(bad, 'AFS_MASTER_KEY');
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(MasterKeyError);
        expect((e as Error).message).toMatch(/32 random bytes in base64/);
        if (bad) expect((e as Error).message).not.toContain(bad);
      }
    }
    expect(() =>
      loadMasterKey({ masterKeyFile: join(root, 'nowhere.key'), dataDir: root }),
    ).toThrow(/is not there/);
    expect(() => loadConfig({ AFS_MASTER_KEY: 'x', AFS_MASTER_KEY_FILE: 'y' })).toThrow(/use one/);
  });

  it('is made in the data folder at a first start, and read from there afterwards', () => {
    const dataDir = join(root, 'fresh');
    expect(() => loadMasterKey({ dataDir }, false)).toThrow(/no master key yet/);
    const made = loadMasterKey({ dataDir });
    expect(made.source).toBe('generated');
    expect(made.file).toBe(join(dataDir, 'master.key'));
    expect(readFileSync(made.file as string, 'utf8').trim()).toBe(made.key.toString('base64'));
    const again = loadMasterKey({ dataDir });
    expect(again).toMatchObject({ source: 'file', id: made.id });
  });
});

describe('sealing', () => {
  const key = keyOf();
  it('opens to what was sealed, differently sealed each time', () => {
    const one = seal(key, 'hunter2 ünïcode', 'credential:a');
    const two = seal(key, 'hunter2 ünïcode', 'credential:a');
    expect(one).not.toBe(two);
    expect(one).not.toContain('hunter2');
    expect(sealedWith(one)).toBe(key.id);
    expect(open(key, one, 'credential:a')).toBe('hunter2 ünïcode');
    expect(open(key, seal(key, '', 'x'), 'x')).toBe('');
  });

  it('does not open with another key, in another place, or when changed', () => {
    const sealed = seal(key, 'secret', 'credential:a');
    const why = (run: () => unknown) => {
      try {
        run();
        return 'opened';
      } catch (e) {
        return e instanceof SealError ? e.code : 'other';
      }
    };
    expect(why(() => open(keyOf(), sealed, 'credential:a'))).toBe('other_key');
    expect(why(() => open(key, sealed, 'credential:b'))).toBe('damaged');
    const parts = sealed.split('.');
    const flipped = [...parts];
    flipped[3] = Buffer.from('other!').toString('base64url');
    expect(why(() => open(key, flipped.join('.'), 'credential:a'))).toBe('damaged');
    expect(why(() => open(key, 'plain text', 'credential:a'))).toBe('damaged');
    // A key with the same id and other bytes (it cannot happen by chance) still does not open.
    const liar: MasterKey = { ...keyOf(), id: key.id };
    expect(why(() => open(liar, sealed, 'credential:a'))).toBe('damaged');
  });
});

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

for (const [name, config] of databases) {
  describe.skipIf(!config)(`credentials on ${name}`, () => {
    let database: Database;
    let workspace: string;
    const key = keyOf();
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
      await emptyWorkspaces(db());
      await db().deleteFrom('setting').where('name', '=', 'secrets.check').execute();
      // Sealed settings of other test files (another key): this file's key is the only one.
      await db().deleteFrom('setting').where('name', 'like', 'notify.%').execute();
      workspace = (await createWorkspace(db(), { key: 'net', name: 'Network' })).id;
    });
    const refused = (run: () => Promise<unknown>) =>
      run().then(
        () => 'done',
        (e) => (e instanceof CredentialError ? `${e.code}: ${e.message}` : `other: ${e}`),
      );

    it('keeps the secret part sealed, and says only what it holds', async () => {
      const made = await createCredential(db(), key, workspace, {
        name: ' Edge switches ',
        kind: 'login',
        description: 'Read-only account',
        fields: { username: 'netops' },
        secret: { password: 'Tr0ub4dor&3' },
      });
      expect(made).toMatchObject({
        name: 'Edge switches',
        kind: 'login',
        description: 'Read-only account',
        fields: { username: 'netops' },
        has: ['password'],
        usedBy: 0,
      });
      expect(JSON.stringify(made)).not.toContain('Tr0ub4dor');
      const row = await db().selectFrom('credential').selectAll().executeTakeFirstOrThrow();
      expect(JSON.stringify(row)).not.toContain('Tr0ub4dor');
      expect(sealedWith(row.secret_enc)).toBe(key.id);
      expect(JSON.stringify(await listCredentials(db(), workspace))).not.toContain('Tr0ub4dor');
      expect(JSON.stringify(await getCredential(db(), made.id))).not.toContain('Tr0ub4dor');

      // The server itself reads it, with the key; not with another, and not from another row.
      expect(await reveal(db(), key, made.id)).toMatchObject({
        kind: 'login',
        fields: { username: 'netops' },
        secret: { password: 'Tr0ub4dor&3' },
      });
      await expect(reveal(db(), keyOf(), made.id)).rejects.toBeInstanceOf(SealError);
      const other = await createCredential(db(), key, workspace, {
        name: 'Other',
        kind: 'vault',
        secret: { password: 'x' },
      });
      await db()
        .updateTable('credential')
        .set({ secret_enc: row.secret_enc })
        .where('id', '=', other.id)
        .execute();
      await expect(reveal(db(), key, other.id)).rejects.toBeInstanceOf(SealError);
      expect(await reveal(db(), key, 'nothing')).toBeUndefined();
    });

    it('each kind holds what it is for, and refuses the rest', async () => {
      const make = (input: Parameters<typeof createCredential>[3]) =>
        refused(() => createCredential(db(), key, workspace, input));
      expect(
        await make({
          name: 'key',
          kind: 'ssh_key',
          fields: { username: 'ansible' },
          secret: { privateKey: PRIVATE_KEY, passphrase: 'open sesame' },
        }),
      ).toBe('done');
      expect(await make({ name: 'become', kind: 'become', secret: { password: 'p' } })).toBe(
        'done',
      );
      expect(
        await make({
          name: 'vault',
          kind: 'vault',
          fields: { vaultId: 'prod' },
          secret: { password: 'p' },
        }),
      ).toBe('done');
      expect(await make({ name: 'token', kind: 'git_token', secret: { token: 't' } })).toBe('done');
      expect(
        await make({
          name: 'registry',
          kind: 'registry',
          fields: { host: 'registry.example.net', username: 'ci' },
          secret: { password: 'p' },
        }),
      ).toBe('done');
      expect(
        await make({ name: 'env', kind: 'env', secret: { API_URL: 'https://x', API_KEY: 'k' } }),
      ).toBe('done');
      const all = await listCredentials(db(), workspace);
      expect(all.map((c) => c.name)).toEqual([
        'become',
        'env',
        'key',
        'registry',
        'token',
        'vault',
      ]);
      expect(all.find((c) => c.name === 'env')?.has).toEqual(['API_KEY', 'API_URL']);
      expect(all.find((c) => c.name === 'key')?.has).toEqual(['passphrase', 'privateKey']);

      expect(await make({ name: 'token', kind: 'git_token', secret: { token: 't' } })).toMatch(
        /^taken/,
      );
      expect(await make({ name: '', kind: 'vault', secret: { password: 'p' } })).toMatch(
        /name of 1 to 100/,
      );
      expect(await make({ name: 'a', kind: 'login', secret: { password: 'p' } })).toMatch(
        /needs username/,
      );
      expect(
        await make({ name: 'a', kind: 'login', fields: { username: 'u' }, secret: {} }),
      ).toMatch(/needs password/);
      expect(
        await make({ name: 'a', kind: 'vault', secret: { password: 'p', token: 't' } }),
      ).toMatch(/no secret "token"/);
      expect(
        await make({ name: 'a', kind: 'vault', fields: { host: 'h' }, secret: { password: 'p' } }),
      ).toMatch(/no field "host"/);
      expect(
        await make({ name: 'a', kind: 'ssh_key', secret: { privateKey: 'not a key' } }),
      ).toMatch(/not a private key/);
      expect(await make({ name: 'a', kind: 'env', secret: {} })).toMatch(/at least one variable/);
      expect(await make({ name: 'a', kind: 'env', secret: { '1BAD': 'x' } })).toMatch(
        /not a variable name/,
      );
      expect(await make({ name: 'a', kind: 'nope' as never, secret: {} })).toMatch(/no kind nope/);
      // What was refused is in no message.
      expect(
        await make({ name: 'a', kind: 'ssh_key', secret: { privateKey: 'S3CR3T' } }),
      ).not.toContain('S3CR3T');
      expect(
        await refused(() =>
          createCredential(db(), key, 'no-workspace', {
            name: 'a',
            kind: 'vault',
            secret: { password: 'p' },
          }),
        ),
      ).toMatch(/^not_found/);
    });

    it('changes its name, its open part and its secret part, each on its own', async () => {
      const made = await createCredential(db(), key, workspace, {
        name: 'git',
        kind: 'git_token',
        secret: { token: 'first' },
      });
      const renamed = await updateCredential(db(), key, made.id, {
        name: 'Git host',
        description: 'For the edge repositories',
        fields: { username: 'deploy' },
      });
      expect(renamed).toMatchObject({
        name: 'Git host',
        fields: { username: 'deploy' },
        has: ['token'],
      });
      expect((await reveal(db(), key, made.id))?.secret).toEqual({ token: 'first' });
      await updateCredential(db(), key, made.id, { secret: { token: 'second' } });
      expect(await reveal(db(), key, made.id)).toMatchObject({
        fields: { username: 'deploy' },
        secret: { token: 'second' },
      });
      expect(await refused(() => updateCredential(db(), key, made.id, { secret: {} }))).toMatch(
        /needs token/,
      );
      await createCredential(db(), key, workspace, {
        name: 'other',
        kind: 'vault',
        secret: { password: 'p' },
      });
      expect(await refused(() => updateCredential(db(), key, made.id, { name: 'other' }))).toMatch(
        /^taken/,
      );
      expect(await refused(() => updateCredential(db(), key, 'nothing', { name: 'x' }))).toMatch(
        /^not_found/,
      );
      expect((await reveal(db(), key, made.id))?.secret).toEqual({ token: 'second' });
    });

    it('a project signs in to an https source with a token or a login of its own workspace', async () => {
      const token = await createCredential(db(), key, workspace, {
        name: 'token',
        kind: 'git_token',
        secret: { token: 'glpat-not-real' },
      });
      const login = await createCredential(db(), key, workspace, {
        name: 'login',
        kind: 'login',
        fields: { username: 'deploy' },
        secret: { password: 'p' },
      });
      const vault = await createCredential(db(), key, workspace, {
        name: 'vault',
        kind: 'vault',
        secret: { password: 'p' },
      });
      const elsewhere = await createWorkspace(db(), { key: 'dc', name: 'Data centre' });
      const foreign = await createCredential(db(), key, elsewhere.id, {
        name: 'token',
        kind: 'git_token',
        secret: { token: 't' },
      });
      const URL_OK = 'https://git.example.net/network/edge.git';
      const make = (input: Partial<Parameters<typeof createProject>[2]>) =>
        createProject(
          db(),
          workspace,
          { key: `p${Math.random().toString(36).slice(2, 8)}`, name: 'P', ...input },
          false,
        ).then(
          (p) => p,
          (e) => `${e.code}: ${e.message}`,
        );
      const project = await make({ gitUrl: URL_OK, gitCredential: token.id });
      expect(project).toMatchObject({ gitCredential: token.id });
      expect(await make({ gitUrl: URL_OK, gitCredential: vault.id })).toMatch(
        /git token or a login/,
      );
      expect(await make({ gitUrl: URL_OK, gitCredential: foreign.id })).toMatch(
        /no such credential/,
      );
      expect(await make({ gitUrl: URL_OK, gitCredential: 'nothing' })).toMatch(
        /no such credential/,
      );
      expect(
        await make({ gitUrl: 'git@git.example.net:network/edge.git', gitCredential: token.id }),
      ).toMatch(/reached over https/);
      expect(await make({ gitCredential: token.id })).toMatch(/server hosts this project/);

      // What git is given for each kind.
      expect(gitAuthOf((await reveal(db(), key, token.id)) as never)).toEqual({
        username: 'git',
        password: 'glpat-not-real',
      });
      expect(gitAuthOf((await reveal(db(), key, login.id)) as never)).toEqual({
        username: 'deploy',
        password: 'p',
      });
      expect(gitAuthOf((await reveal(db(), key, vault.id)) as never)).toBeUndefined();

      // In use: counted, not deleted from under the project; freed, it goes.
      const id = (project as { id: string }).id;
      expect((await getCredential(db(), token.id))?.usedBy).toBe(1);
      expect(await refused(() => deleteCredential(db(), token.id))).toMatch(
        /^in_use: The project p/,
      );
      expect(await updateProject(db(), id, { gitCredential: login.id }, false)).toMatchObject({
        gitCredential: login.id,
        sync: { state: 'never' },
      });
      expect(await refused(() => deleteCredential(db(), token.id))).toBe('done');
      // A source that is no longer https has no use for it; taking it away by hand works too.
      const moved = await updateProject(
        db(),
        id,
        { gitUrl: 'git@git.example.net:network/edge.git' },
        false,
      );
      expect(moved.gitCredential).toBeUndefined();
      await updateProject(db(), id, { gitUrl: URL_OK, gitCredential: login.id }, false);
      expect(
        (await updateProject(db(), id, { gitCredential: null }, false)).gitCredential,
      ).toBeUndefined();
      expect(await refused(() => deleteCredential(db(), 'nothing'))).toMatch(/^not_found/);
    });

    it('the database remembers its key; another key is refused; rotating seals all again', async () => {
      expect(await checkKey(db(), key)).toBe('new');
      expect(await checkKey(db(), key)).toBe('same');
      await expect(checkKey(db(), keyOf())).rejects.toMatchObject({ code: 'other_key' });

      const one = await createCredential(db(), key, workspace, {
        name: 'one',
        kind: 'vault',
        secret: { password: 'first secret' },
      });
      const two = await createCredential(db(), key, workspace, {
        name: 'two',
        kind: 'env',
        secret: { TOKEN: 'second secret' },
      });
      const next = keyOf();
      expect(await rotate(db(), key, next)).toBe(2);
      expect((await reveal(db(), next, one.id))?.secret).toEqual({ password: 'first secret' });
      expect((await reveal(db(), next, two.id))?.secret).toEqual({ TOKEN: 'second secret' });
      await expect(reveal(db(), key, one.id)).rejects.toMatchObject({ code: 'other_key' });
      expect(await checkKey(db(), next)).toBe('same');
      await expect(checkKey(db(), key)).rejects.toBeInstanceOf(SealError);
      // With the wrong old key nothing changes: all or nothing.
      await expect(rotate(db(), key, keyOf())).rejects.toBeInstanceOf(SealError);
      expect((await reveal(db(), next, two.id))?.secret).toEqual({ TOKEN: 'second secret' });
    });
  });
}

describe('credentials over the API', () => {
  let database: Database;
  let app: FastifyInstance;
  let lines: string[];
  let admin: string;
  let member: string;
  let readOnly: string;
  const key = keyOf();

  beforeAll(async () => {
    lines = [];
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    app = buildApp({
      log: createLogger({ level: 'debug', format: 'json', write: (l) => lines.push(l) }),
      database,
      instance: 'test',
      masterKey: key,
    });
    const signIn = async (login: string, isAdmin: boolean) => {
      const user = await createUser(database.db, {
        login,
        name: login,
        password: PASSWORD,
        admin: isAdmin,
      });
      const reply = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { login, password: PASSWORD },
      });
      return {
        id: user.id,
        cookie: /afs_session=[^;]*/.exec([reply.headers['set-cookie']].flat().join(';'))?.[0] ?? '',
      };
    };
    const dana = await signIn('dana', true);
    admin = dana.cookie;
    member = (await signIn('omar', false)).cookie;
    readOnly = (await createToken(database.db, dana.id, { name: 'ro', readOnly: true })).token;
    await createWorkspace(database.db, { key: 'net', name: 'Network' });
    await grant(database.db, 'net', 'omar');
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

  it('a secret goes in and is in no answer and no log line', async () => {
    const SECRET = 'S3cr3t-V4lue-9f2c1e7a';
    const made = await call('POST', '/api/v1/workspaces/net/credentials', {
      cookie: admin,
      body: {
        name: 'Vault',
        kind: 'vault',
        fields: { vaultId: 'prod' },
        secret: { password: SECRET },
      },
    });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ name: 'Vault', kind: 'vault', has: ['password'] });
    const id = made.json().id;

    const replies = [
      made,
      await call('GET', '/api/v1/workspaces/net/credentials', { cookie: member }),
      await call('GET', `/api/v1/credentials/${id}`, { cookie: member }),
      await call('PATCH', `/api/v1/credentials/${id}`, {
        cookie: admin,
        body: { name: 'Vault prod', secret: { password: `${SECRET}-2` } },
      }),
      // A refusal does not repeat what was sent either.
      await call('PATCH', `/api/v1/credentials/${id}`, {
        cookie: admin,
        body: { secret: { password: SECRET, bogus: SECRET } },
      }),
      await call('POST', '/api/v1/workspaces/net/credentials', {
        cookie: admin,
        body: { name: 'Vault prod', kind: 'vault', secret: { password: SECRET } },
      }),
    ];
    expect(replies.map((r) => r.statusCode)).toEqual([201, 200, 200, 200, 400, 409]);
    for (const reply of replies) expect(reply.body).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines.join('\n')).toContain('Credential added');
    expect((await reveal(database.db, key, id))?.secret).toEqual({ password: `${SECRET}-2` });
  });

  it('everyone signed in sees which there are; administrators change them', async () => {
    const body = { name: 'Token', kind: 'git_token', secret: { token: 't' } };
    expect((await call('GET', '/api/v1/workspaces/net/credentials')).statusCode).toBe(401);
    expect(
      (await call('POST', '/api/v1/workspaces/net/credentials', { cookie: member, body }))
        .statusCode,
    ).toBe(403);
    const byReadOnly = await call('POST', '/api/v1/workspaces/net/credentials', {
      auth: `Bearer ${readOnly}`,
      body,
    });
    expect(byReadOnly.statusCode).toBe(403);
    expect(byReadOnly.json().error).toBe('read_only_token');
    expect(
      (await call('GET', '/api/v1/workspaces/net/credentials', { auth: `Bearer ${readOnly}` }))
        .statusCode,
    ).toBe(200);
    const made = await call('POST', '/api/v1/workspaces/net/credentials', { cookie: admin, body });
    const id = made.json().id;
    expect(
      (await call('PATCH', `/api/v1/credentials/${id}`, { cookie: member, body: { name: 'x' } }))
        .statusCode,
    ).toBe(403);
    expect((await call('DELETE', `/api/v1/credentials/${id}`, { cookie: member })).statusCode).toBe(
      403,
    );
    expect((await call('DELETE', `/api/v1/credentials/${id}`, { cookie: admin })).statusCode).toBe(
      204,
    );
    expect((await call('GET', `/api/v1/credentials/${id}`, { cookie: admin })).statusCode).toBe(
      404,
    );
    expect(
      (await call('GET', '/api/v1/workspaces/nowhere/credentials', { cookie: admin })).statusCode,
    ).toBe(404);
    for (const bad of [
      { name: 'x', kind: 'nope', secret: {} },
      { name: 'x', kind: 'vault' },
      { name: 'x', kind: 'vault', secret: { password: 'p' }, admin: true },
    ])
      expect(
        (await call('POST', '/api/v1/workspaces/net/credentials', { cookie: admin, body: bad }))
          .statusCode,
        JSON.stringify(bad),
      ).toBe(400);
  });
});

describe('the secrets commands', () => {
  it('say which key there is, and rotate it with the key file', async () => {
    const dataDir = join(root, 'cli');
    const database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    const run = async (...args: string[]) => {
      const out: string[] = [];
      const code = await secretsCommand(database.db, { dataDir }, args, (l) => out.push(l));
      return { code, text: out.join('\n') };
    };
    expect(await run('status')).toMatchObject({ code: 1 });
    expect((await run('frobnicate')).code).toBe(2);

    const key = loadMasterKey({ dataDir });
    await checkKey(database.db, key);
    const workspace = await createWorkspace(database.db, { key: 'net', name: 'Network' });
    const made = await createCredential(database.db, key, workspace.id, {
      name: 'vault',
      kind: 'vault',
      secret: { password: 'kept through a rotation' },
    });
    const status = await run('status');
    expect(status.code).toBe(0);
    expect(status.text).toContain(`Master key ${key.id}`);
    expect(status.text).toContain('1 stored credential(s)');
    expect(status.text).not.toContain(key.key.toString('base64'));

    const rotated = await run('rotate');
    expect(rotated.code).toBe(0);
    const next = loadMasterKey({ dataDir }, false);
    expect(next.id).not.toBe(key.id);
    expect(rotated.text).toContain(next.id);
    expect(rotated.text).not.toContain(next.key.toString('base64'));
    expect(existsSync(join(dataDir, `master.key.${key.id}.old`))).toBe(true);
    expect(existsSync(join(dataDir, 'master.key.new'))).toBe(false);
    expect((await reveal(database.db, next, made.id))?.secret).toEqual({
      password: 'kept through a rotation',
    });
    expect((await run('status')).code).toBe(0);

    // A key from the settings cannot be written by the server: the new one is said, once.
    const env = { masterKey: next.key.toString('base64'), dataDir: join(root, 'cli-env') };
    const out: string[] = [];
    expect(await secretsCommand(database.db, env, ['rotate'], (l) => out.push(l))).toBe(0);
    const said = parseKey(out.at(-1) ?? '', 'the printed key');
    expect(
      (await reveal(database.db, { key: said, id: keyId(said), source: 'env' }, made.id))?.secret,
    ).toEqual({
      password: 'kept through a rotation',
    });
    // The old key is now the wrong one.
    const wrong: string[] = [];
    expect(await secretsCommand(database.db, env, ['status'], (l) => wrong.push(l))).toBe(1);
    expect(wrong.join('\n')).toMatch(/not the one the stored secrets need/);
    await database.close();
  });
});
