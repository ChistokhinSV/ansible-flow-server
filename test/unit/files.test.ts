// AFS-78: a project's files in the pages: the tree of a branch, a file's bytes and history, and
// Save, one commit with a change set (write, upload, unpack, move, delete), refused only when the
// branch changed the same files since the change set began; recorded like a push and audited.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { listAudit } from '../../src/server/audit/store';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { listPushes } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { grant } from './helpers/grant';

const root = mkdtempSync(join(tmpdir(), 'afs-files-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const PASSWORD = 'correct horse battery staple';

let database: Database;
let app: FastifyInstance;
let git: Git;
let dana: string;
let omar: string;
let lina: string;
let project: { id: string; commit: string };

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
  lina = await signIn('lina', false);
  await call(dana, 'POST', '/api/v1/workspaces', { key: 'net', name: 'Network' });
  await grant(database.db, 'net', 'omar', 'rw');
  await grant(database.db, 'net', 'lina', 'ro');
  project = (
    await call(dana, 'POST', '/api/v1/workspaces/net/projects', {
      key: 'flows',
      name: 'Flows',
      sample: 'hello',
    })
  ).json();
});
afterAll(async () => {
  await app.close();
  await database.close();
});

function call(cookie: string, method: 'GET' | 'POST', url: string, body?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
}

const files = (branch?: string) =>
  call(lina, 'GET', `/api/v1/projects/${project.id}/files${branch ? `?branch=${branch}` : ''}`);
const save = (who: string, body: unknown) =>
  call(who, 'POST', `/api/v1/projects/${project.id}/files`, body);
const content = (commit: string, path: string, download = false) =>
  call(
    lina,
    'GET',
    `/api/v1/projects/${project.id}/files/content?commit=${commit}&path=${encodeURIComponent(path)}${download ? '&download=true' : ''}`,
  );

describe('the files of a project', () => {
  it('lists the branch, saves a change set as one commit by the person, and records it', async () => {
    const before = (await files()).json();
    expect(before.branch).toBe('main');
    expect(before.commit).toBe(project.commit);
    expect(before.files.length).toBeGreaterThan(0);
    const flow = before.files.find((f: { path: string }) => f.path.endsWith('.flow.yaml'));
    expect(flow.size).toBeGreaterThan(0);

    // ro may look, not save.
    expect(
      (await save(lina, { changes: [{ op: 'write', path: 'x.txt', text: 'x' }] })).statusCode,
    ).toBe(403);

    const zip = Buffer.from(
      zipSync({
        'web/tasks/main.yml': strToU8('- ansible.builtin.ping:\n'),
        'web/defaults/main.yml': strToU8('web_port: 8080\n'),
      }),
    ).toString('base64');
    const saved = await save(omar, {
      base: project.commit,
      message: 'Add the web role and its template',
      changes: [
        { op: 'write', path: 'templates/web.conf.j2', text: 'listen {{ web_port }};\n' },
        {
          op: 'write',
          path: 'files/run.sh',
          base64: Buffer.from('#!/bin/sh\n').toString('base64'),
          executable: true,
        },
        {
          op: 'write',
          path: 'files/blob.bin',
          base64: Buffer.from([0, 1, 2, 255]).toString('base64'),
        },
        { op: 'unpack', path: 'roles', base64: zip },
        { op: 'move', from: 'templates', to: 'roles/web/templates' },
      ],
    });
    expect(saved.statusCode).toBe(201);
    const { commit, files: touched } = saved.json();
    expect(touched).toEqual([
      'files/blob.bin',
      'files/run.sh',
      'roles/web/defaults/main.yml',
      'roles/web/tasks/main.yml',
      'roles/web/templates/web.conf.j2',
    ]);
    const after = (await files()).json();
    expect(after.commit).toBe(commit);
    const paths = after.files.map((f: { path: string }) => f.path);
    expect(paths).not.toContain('templates/web.conf.j2');
    expect(after.files.find((f: { path: string }) => f.path === 'files/run.sh').executable).toBe(
      true,
    );
    const info = await git.commitInfo(project.id, commit);
    expect(info).toMatchObject({ subject: 'Add the web role and its template' });

    // Text reads as text; anything else, or a download, as an attachment that is never a page.
    const text = await content(commit, 'roles/web/templates/web.conf.j2');
    expect(text.headers['content-type']).toMatch(/^text\/plain/);
    expect(text.body).toBe('listen {{ web_port }};\n');
    const blob = await content(commit, 'files/blob.bin');
    expect(blob.headers['content-disposition']).toMatch(/^attachment; filename="blob.bin"/);
    expect(blob.rawPayload).toEqual(Buffer.from([0, 1, 2, 255]));
    expect((await content(commit, '../etc/passwd')).statusCode).toBe(422);
    const history = (
      await call(
        lina,
        'GET',
        `/api/v1/projects/${project.id}/files/history?commit=${commit}&path=roles/web`,
      )
    ).json();
    expect(history[0]).toMatchObject({ commit, author: 'omar' });

    const pushes = await listPushes(database.db, project.id);
    expect(pushes[0]).toMatchObject({
      ref: 'main',
      from: project.commit,
      to: commit,
      login: 'omar',
    });
    const audit = await listAudit(database.db, { action: 'project.files-save' });
    expect(audit.entries[0]).toMatchObject({
      actor: { login: 'omar' },
      detail: { branch: 'main' },
    });
    project.commit = commit;
  });

  it('goes on top of a branch that moved, and refuses where the branch changed the same files', async () => {
    const base = project.commit;
    // Someone else changes the template meanwhile.
    const moved = await git.commitFile(project.id, {
      parent: base,
      path: 'roles/web/templates/web.conf.j2',
      text: 'listen 80;\n',
      author: { name: 'Lina', email: 'lina@example.net' },
      message: 'Port 80',
    });
    await git.publish(project.id, 'main', base, moved);

    const clash = await save(omar, {
      base,
      changes: [{ op: 'write', path: 'roles/web/templates/web.conf.j2', text: 'listen 443;\n' }],
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({
      error: 'conflict',
      files: ['roles/web/templates/web.conf.j2'],
    });
    // A folder move over a file the branch changed clashes too.
    expect(
      (await save(omar, { base, changes: [{ op: 'move', from: 'roles/web', to: 'roles/www' }] }))
        .statusCode,
    ).toBe(409);

    const ok = await save(omar, {
      base,
      changes: [{ op: 'write', path: 'roles/web/defaults/main.yml', text: 'web_port: 9090\n' }],
    });
    expect(ok.statusCode).toBe(201);
    const commit = ok.json().commit;
    // On top of the moved branch: the template's last change is the other person's.
    const last = await git.fileHistory(project.id, commit, 'roles/web/templates/web.conf.j2', {
      limit: 1,
    });
    expect(last[0]?.commit).toBe(moved);
    expect((await content(commit, 'roles/web/templates/web.conf.j2')).body).toBe('listen 80;\n');
    project.commit = commit;
  });

  it('refuses paths outside the project, .git, a file over a folder, and nothing to save', async () => {
    const refused = async (changes: unknown[]) => {
      const r = await save(omar, { changes });
      return [r.statusCode, r.json().message];
    };
    expect((await refused([{ op: 'write', path: '../x', text: '' }]))[0]).toBe(422);
    expect((await refused([{ op: 'write', path: 'a/.git/config', text: '' }]))[0]).toBe(422);
    expect((await refused([{ op: 'write', path: 'roles/web', text: '' }]))[1]).toMatch(
      /a file and a folder/,
    );
    expect((await refused([{ op: 'delete', path: 'nothing/here' }]))[0]).toBe(404);
    expect((await refused([{ op: 'move', from: 'roles', to: 'roles/inner' }]))[1]).toMatch(
      /into itself/,
    );
    // A change that changes nothing makes no commit.
    const same = await save(omar, {
      changes: [{ op: 'write', path: 'roles/web/defaults/main.yml', text: 'web_port: 9090\n' }],
    });
    expect(same.json()).toMatchObject({ unchanged: true, commit: project.commit });
  });

  it('saves on another branch, and deletes folders', async () => {
    await call(omar, 'POST', `/api/v1/projects/${project.id}/branches`, {
      name: 'try/files',
      from: 'main',
    });
    const r = await save(omar, {
      branch: 'try/files',
      changes: [{ op: 'delete', path: 'roles' }],
    });
    expect(r.statusCode, r.body).toBe(201);
    const there = (await files('try/files')).json();
    expect(there.files.some((f: { path: string }) => f.path.startsWith('roles/'))).toBe(false);
    // main is as it was.
    expect((await files()).json().commit).toBe(project.commit);
    expect((await files('nope')).statusCode).toBe(404);
  });

  it('AFS-150: an archive replaces a file that is there only when the save says it may', async () => {
    const hosted = (
      await call(dana, 'POST', '/api/v1/workspaces/net/projects', { key: 'zips', name: 'Zips' })
    ).json();
    const at = (body: unknown) => call(omar, 'POST', `/api/v1/projects/${hosted.id}/files`, body);
    expect(
      (await at({ changes: [{ op: 'write', path: 'README.md', text: '# Zips\n' }] })).statusCode,
    ).toBe(201);
    const zipOf = (files: Record<string, string>) =>
      Buffer.from(
        zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))),
      ).toString('base64');
    // The same bytes, or a new file, replace nothing: saved at once.
    const same = await at({
      changes: [
        { op: 'unpack', path: '', base64: zipOf({ 'README.md': '# Zips\n', 'a.txt': 'a' }) },
      ],
    });
    expect(same.statusCode, same.body).toBe(201);
    expect(same.json().files).toEqual(['a.txt']);
    // Other bytes for README.md: refused with the files named, nothing saved.
    const other = { op: 'unpack', path: '', base64: zipOf({ 'README.md': 'other', 'b.txt': 'b' }) };
    const refused = await at({ changes: [other] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'replaces', files: ['README.md'] });
    const before = (await call(lina, 'GET', `/api/v1/projects/${hosted.id}/files`)).json();
    expect(before.files.map((f: { path: string }) => f.path)).not.toContain('b.txt');
    // Said it may: saved.
    const replaced = await at({ changes: [{ ...other, replace: true }] });
    expect(replaced.statusCode, replaced.body).toBe(201);
    expect(replaced.json().files).toEqual(['README.md', 'b.txt']);
  });

  it('makes the first commit of an empty hosted project (AFS-113)', async () => {
    const empty = (
      await call(dana, 'POST', '/api/v1/workspaces/net/projects', { key: 'empty', name: 'Empty' })
    ).json();
    expect(empty.commit ?? null).toBeNull();
    const r = await call(omar, 'POST', `/api/v1/projects/${empty.id}/files`, {
      branch: 'main',
      message: 'Add the flow First',
      changes: [{ op: 'write', path: 'flows/first.flow.yaml', text: 'flow: {}\n' }],
    });
    expect(r.statusCode, r.body).toBe(201);
    const saved = r.json();
    expect(saved.files).toEqual(['flows/first.flow.yaml']);
    const there = (await call(lina, 'GET', `/api/v1/projects/${empty.id}/files`)).json();
    expect(there.commit).toBe(saved.commit);
    expect(there.files.map((f: { path: string }) => f.path)).toEqual(['flows/first.flow.yaml']);
    const pushes = await listPushes(database.db, empty.id);
    expect(pushes[0]).toMatchObject({ ref: 'main', to: saved.commit });
    // From then on it is an ordinary save on top.
    const next = await call(omar, 'POST', `/api/v1/projects/${empty.id}/files`, {
      changes: [{ op: 'write', path: 'README.md', text: '# Empty\n' }],
    });
    expect(next.statusCode, next.body).toBe(201);
  });
});
