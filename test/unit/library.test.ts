// AFS-79: the flow library: an administrator marks a project a library, and its flows' subflows
// are offered to every project, to people who may read the library's workspace; one is read as it
// is now, to copy, and a new commit of the library is a new version.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { ProjectSync } from '../../src/server/projects/sync';
import { grant } from './helpers/grant';

const root = mkdtempSync(join(tmpdir(), 'afs-library-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const PASSWORD = 'correct horse battery staple';
const FILE = 'flows/firewall-upgrade/firewall-upgrade.flow.yaml';
const BACKUP = `afs://platform/patterns/${FILE}#backup`;

let database: Database;
let app: FastifyInstance;
let git: Git;
let dana: string;
let omar: string;
let library: { id: string; commit: string };

beforeAll(async () => {
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
  git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
  const sync = new ProjectSync(database.db, git, log);
  app = buildApp({ log, database, instance: 'test', projects: { git, sync, allowLocal: true } });
  const signIn = async (login: string, admin: boolean) => {
    await createUser(database.db, { login, name: login, password: PASSWORD, admin });
    const reply = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { login, password: PASSWORD },
    });
    return /afs_session=[^;]*/.exec([reply.headers['set-cookie']].flat().join(';'))?.[0] ?? '';
  };
  dana = await signIn('dana', true);
  omar = await signIn('omar', false);
  await call(dana, 'POST', '/api/v1/workspaces', { key: 'platform', name: 'Platform' });
  await call(dana, 'POST', '/api/v1/workspaces', { key: 'net', name: 'Network' });
  await grant(database.db, 'net', 'omar', 'rw');
  library = (
    await call(dana, 'POST', '/api/v1/workspaces/platform/projects', {
      key: 'patterns',
      name: 'Patterns',
      sample: 'firewall-upgrade',
    })
  ).json();
});
afterAll(async () => {
  await app.close();
  await database.close();
});

function call(cookie: string, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
}
const listed = async (who: string) =>
  (await call(who, 'GET', '/api/v1/library/subflows')).json().subflows as { from: string }[];

describe('the flow library', () => {
  it('offers a library project subflows to those who may read its workspace', async () => {
    // Not a library yet: nothing offered.
    expect(await listed(dana)).toEqual([]);
    // Only an administrator makes a project a library.
    expect(
      (await call(omar, 'PATCH', `/api/v1/projects/${library.id}`, { library: true })).statusCode,
    ).toBe(403);
    const made = await call(dana, 'PATCH', `/api/v1/projects/${library.id}`, { library: true });
    expect(made.json()).toMatchObject({ library: true });

    const all = await listed(dana);
    expect(all.map((s) => s.from)).toEqual(
      ['backup', 'postcheck', 'precheck', 'rollback', 'upgrade'].map(
        (k) => `afs://platform/patterns/${FILE}#${k}`,
      ),
    );
    expect(all.find((s) => s.from === BACKUP)).toEqual({
      from: BACKUP,
      workspace: 'platform',
      project: 'patterns',
      file: FILE,
      path: 'backup',
      title: 'Backup',
      intent: expect.any(String),
      flow: expect.any(String),
      version: 1,
      commit: library.commit,
    });

    // Omar may not read the platform workspace: the library is not his to see.
    expect(await listed(omar)).toEqual([]);
    const hidden = await call(
      omar,
      'GET',
      `/api/v1/library/subflow?from=${encodeURIComponent(BACKUP)}`,
    );
    expect(hidden.statusCode).toBe(404);
    await grant(database.db, 'platform', 'omar', 'ro');
    expect((await listed(omar)).length).toBe(5);

    const one = (
      await call(omar, 'GET', `/api/v1/library/subflow?from=${encodeURIComponent(BACKUP)}`)
    ).json();
    expect(one).toMatchObject({ from: BACKUP, version: 1, commit: library.commit });
    expect(one.node).toMatchObject({ key: 'backup', type: 'subflow' });
    expect(one.node.subflow.nodes.length).toBeGreaterThan(0);
    expect(
      (await call(omar, 'GET', '/api/v1/library/subflow?from=afs%3A%2F%2Fplatform%2Fx')).statusCode,
    ).toBe(404);
  });

  it('a new commit of the library flow is what it offers next', async () => {
    const text = (await git.read(library.id, library.commit, FILE))?.toString('utf8') ?? '';
    const next = await git.commitFile(library.id, {
      parent: library.commit,
      path: FILE,
      text: text.replace(/^ {2}version: 1$/m, '  version: 2'),
      author: { name: 'Dana', email: 'dana@example.net' },
      message: 'Version 2',
    });
    await git.publish(library.id, 'main', library.commit, next);
    await call(dana, 'POST', `/api/v1/projects/${library.id}/sync`);
    const one = (
      await call(omar, 'GET', `/api/v1/library/subflow?from=${encodeURIComponent(BACKUP)}`)
    ).json();
    expect(one).toMatchObject({ version: 2, commit: next });
  });
});
