// The audit log: every changing request leaves an entry (who, what, to what, how it ended),
// never a secret; administrators read it a page at a time or take it as CSV or JSON. On both
// databases the server supports (PostgreSQL when AFS_TEST_POSTGRES_URL is set).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { auditCommand, changes } from '../../src/server/audit/cli';
import { ACTIONS } from '../../src/server/audit/routes';
import {
  type AuditEntry,
  auditCsv,
  listAudit,
  pruneAudit,
  recordAudit,
} from '../../src/server/audit/store';
import { createUser } from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { ProjectSync } from '../../src/server/projects/sync';
import { RunQueue } from '../../src/server/runs/queue';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { emptyPeople, emptyWorkspaces } from './helpers/clean';

const PASSWORD = 'correct horse battery staple';
const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const root = mkdtempSync(join(tmpdir(), 'afs-audit-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

for (const [name, config] of databases) {
  describe.skipIf(!config)(`the audit log on ${name}`, () => {
    let database: Database;
    let app: FastifyInstance;
    let admin: string;
    let member: string;
    const db = () => database.db;
    const newest = async (action: string) => (await listAudit(db(), { action })).entries[0];

    beforeAll(async () => {
      if (!config) return;
      database = openDatabase(config);
      await migrate(database.db as never);
      await emptyWorkspaces(db());
      await emptyPeople(db());
      const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
      const git = new Git({ reposDir: join(root, `repos-${name}`), allowLocal: true });
      app = buildApp({
        log,
        database,
        instance: 'test',
        masterKey: key,
        runs: new RunQueue(db(), database.kind, key),
        projects: { git, sync: new ProjectSync(db(), git, log), allowLocal: true },
      });
      const signIn = async (login: string, isAdmin: boolean) => {
        await createUser(db(), { login, name: login, password: PASSWORD, admin: isAdmin });
        const reply = await app.inject({
          method: 'POST',
          url: '/api/v1/session',
          headers: { 'sec-fetch-site': 'same-origin' },
          payload: { login, password: PASSWORD },
        });
        return /afs_session=[^;]*/.exec([reply.headers['set-cookie']].flat().join(';'))?.[0] ?? '';
      };
      admin = await signIn('dana', true);
      member = await signIn('omar', false);
    });
    afterAll(async () => {
      await app?.close();
      await database?.close();
    });

    it('every changing route of the server is in the list of actions, and only those', async () => {
      // Building the app would have thrown for a changing route the list does not name.
      await app.ready();
      for (const route of Object.keys(ACTIONS)) {
        const [method, url] = route.split(' ') as [string, string];
        expect(app.hasRoute({ method: method as 'POST', url }), route).toBe(true);
      }
    });

    it('records a sign-in, a refused one by the login tried, and never the password', async () => {
      const ok = await newest('session.sign-in');
      expect(ok).toMatchObject({
        actor: { login: 'omar' },
        source: 'ui',
        result: 'ok',
        status: 200,
        object: { type: 'session' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { login: 'Dana', password: 'not the password' },
      });
      const refused = await newest('session.sign-in');
      expect(refused).toMatchObject({
        actor: null,
        source: 'api',
        result: 'refused',
        status: 401,
        detail: { login: 'dana', error: 'invalid_credentials' },
      });
      const all = JSON.stringify((await listAudit(db(), { limit: 1000 })).entries);
      expect(all).not.toContain(PASSWORD);
      expect(all).not.toContain('not the password');
    });

    it('records changes with what they changed (fields, not values) and names what was deleted', async () => {
      const made = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces',
        headers: { cookie: admin },
        payload: { key: 'net', name: 'Network' },
      });
      const id = made.json().id as string;
      expect(await newest('workspace.create')).toMatchObject({
        actor: { login: 'dana' },
        object: { type: 'workspace', id, name: 'net' },
        result: 'ok',
        status: 201,
      });
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/workspaces/${id}`,
        headers: { cookie: admin },
        payload: { description: 'Firewalls and routers' },
      });
      const change = await newest('workspace.change');
      expect(change?.detail).toEqual({ changed: ['description'] });
      expect(JSON.stringify(change)).not.toContain('Firewalls');

      // A member may not delete it: refused, and said so.
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/workspaces/${id}`,
        headers: { cookie: member },
      });
      expect(await newest('workspace.delete')).toMatchObject({
        actor: { login: 'omar' },
        result: 'refused',
        status: 403,
        object: { type: 'workspace', id, name: 'net' },
        detail: { error: 'forbidden' },
      });
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/workspaces/${id}`,
        headers: { cookie: admin },
      });
      // Gone from the database, still named in the log.
      expect(await newest('workspace.delete')).toMatchObject({
        actor: { login: 'dana' },
        result: 'ok',
        object: { name: 'net' },
      });
    });

    it('records a token made, and what is done with it as from the API, with the token', async () => {
      const made = await app.inject({
        method: 'POST',
        url: '/api/v1/tokens',
        headers: { cookie: admin },
        payload: { name: 'ci', expiresInDays: 30 },
      });
      const { id, token } = made.json() as { id: string; token: string };
      expect(await newest('token.create')).toMatchObject({
        object: { type: 'token', id, name: 'ci' },
        detail: { expiresInDays: 30 },
      });
      expect(JSON.stringify(await newest('token.create'))).not.toContain(token);
      await app.inject({
        method: 'POST',
        url: '/api/v1/groups',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'operators' },
      });
      expect(await newest('group.create')).toMatchObject({
        actor: { login: 'dana' },
        token: id,
        source: 'api',
        object: { type: 'group', name: 'operators' },
      });
    });

    it('a request with no credentials that is told to sign in leaves no entry', async () => {
      const before = (await listAudit(db(), { limit: 1000 })).entries.length;
      await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces',
        payload: { key: 'x', name: 'X' },
      });
      expect((await listAudit(db(), { limit: 1000 })).entries.length).toBe(before);
    });

    it('administrators read it, filtered and a page at a time; others may not', async () => {
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/audit', headers: { cookie: member } }))
          .statusCode,
      ).toBe(403);
      const page = await app.inject({
        method: 'GET',
        url: '/api/v1/audit?actor=dana&limit=2',
        headers: { cookie: admin },
      });
      const first = page.json() as { entries: AuditEntry[]; next: string };
      expect(first.entries).toHaveLength(2);
      expect(first.entries.every((e) => e.actor?.login === 'dana')).toBe(true);
      const second = (
        await app.inject({
          method: 'GET',
          url: `/api/v1/audit?actor=dana&limit=2&before=${encodeURIComponent(first.next)}`,
          headers: { cookie: admin },
        })
      ).json() as { entries: AuditEntry[] };
      expect((second.entries[0]?.at as string) <= (first.entries[1]?.at as string)).toBe(true);
      expect(second.entries.map((e) => e.id)).not.toContain(first.entries[1]?.id);

      const refused = (
        await app.inject({
          method: 'GET',
          url: '/api/v1/audit?result=refused&action=workspace',
          headers: { cookie: admin },
        })
      ).json() as { entries: AuditEntry[] };
      expect(refused.entries.map((e) => e.action)).toEqual(['workspace.delete']);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/audit?from=yesterday',
            headers: { cookie: admin },
          })
        ).statusCode,
      ).toBe(400);
    });

    it('exports as CSV and JSON, and the export is itself recorded', async () => {
      const csv = await app.inject({
        method: 'GET',
        url: '/api/v1/audit/export?format=csv&action=workspace',
        headers: { cookie: admin },
      });
      expect(csv.headers['content-type']).toMatch(/^text\/csv/);
      expect(csv.headers['content-disposition']).toMatch(/^attachment; filename="audit-.*\.csv"$/);
      const lines = csv.body.trimEnd().split('\r\n');
      expect(lines[0]).toBe(
        'at,actor,token,source,action,object_type,object_id,object_name,result,status,ip,request,detail',
      );
      expect(lines).toHaveLength(5);
      const json = await app.inject({
        method: 'GET',
        url: '/api/v1/audit/export?format=json&action=workspace.delete',
        headers: { cookie: admin },
      });
      expect((json.json() as AuditEntry[]).map((e) => e.result)).toEqual(['ok', 'refused']);
      expect(await newest('audit.export')).toMatchObject({
        actor: { login: 'dana' },
        detail: { format: 'json', entries: 2, action: 'workspace.delete' },
      });
    });

    it('keeps entries for the days it is told, or all of them', async () => {
      const old = await recordAudit(db(), {
        at: '2020-01-01T00:00:00.000Z',
        actor: null,
        source: 'server',
        action: 'test.old',
        object: { type: 'test' },
        result: 'ok',
      });
      expect(await pruneAudit(db(), 0)).toBe(0);
      expect(await pruneAudit(db(), 365)).toBe(1);
      expect((await listAudit(db(), { action: 'test' })).entries.map((e) => e.id)).not.toContain(
        old.id,
      );
    });

    it('records what the server commands changed, as done on the server', async () => {
      expect(changes('user', ['list'])).toBe(false);
      expect(changes('user', ['add', 'lena'])).toBe(true);
      const entry = await auditCommand(
        db(),
        'user',
        ['token', '--name', 'ci', 'lena', '--days', '1'],
        0,
        'operator',
      );
      expect(entry).toMatchObject({
        actor: null,
        source: 'cli',
        action: 'token.create',
        object: { type: 'token', name: 'ci' },
        result: 'ok',
        detail: { command: 'user token --name ci lena --days 1', osUser: 'operator', user: 'lena' },
      });
      expect(
        await auditCommand(db(), 'cert', ['install', 'cert.pem'], 1, 'operator'),
      ).toMatchObject({ action: 'certificate.install', result: 'failed' });
      // A command that was not understood did nothing.
      expect(await auditCommand(db(), 'user', ['add'], 2, 'operator')).toBeUndefined();
    });
  });
}

describe('CSV', () => {
  it('quotes what needs it and never lets a spreadsheet run a value', () => {
    const csv = auditCsv([
      {
        id: '1',
        at: '2026-11-13T10:00:00.000Z',
        actor: { id: 'u', login: 'dana' },
        source: 'api',
        action: 'workspace.create',
        object: { type: 'workspace', name: '=HYPERLINK("http://example.net")' },
        result: 'ok',
        detail: { note: 'a, b' },
      },
    ]);
    const row = csv.split('\r\n')[1] as string;
    expect(row).toContain(`"'=HYPERLINK(""http://example.net"")"`);
    expect(row).toContain('"{""note"":""a, b""}"');
  });
});
