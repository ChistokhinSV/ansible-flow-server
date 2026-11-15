// AFS-59: a project's branches from the server: listed with their newest commit and what is not
// on the project's branch, made from a branch or a commit, deleted under the rules (never the
// project's branch, not one a launch configuration runs, unmerged work only when asked again); for
// a project with a source the change is made at the source first.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
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

const root = mkdtempSync(join(tmpdir(), 'afs-branches-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const PASSWORD = 'correct horse battery staple';
const AUTHOR = { name: 'Dana Reyes', email: 'dana@example.net' };

let database: Database;
let app: FastifyInstance;
let git: Git;
let dana: string;
let omar: string;
let lina: string;

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
});
afterAll(async () => {
  await app.close();
  await database.close();
});

function call(cookie: string, method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
}

/** A commit on top of `branch` in the project's mirror, moving the branch. */
async function commitOn(projectId: string, branch: string, path: string, text: string) {
  const old = await git.resolve(projectId, branch);
  const commit = await git.commitFile(projectId, {
    parent: old,
    path,
    text,
    author: AUTHOR,
    message: `Change ${path}`,
  });
  await git.publish(projectId, branch, old, commit);
  return commit;
}

async function launchConfig(projectId: string, name: string, gitRef: string) {
  const now = new Date().toISOString();
  await database.db
    .insertInto('launch_config')
    .values({
      id: `c-${name}`,
      project_id: projectId,
      name,
      description: null,
      flow_file: 'flows/hello/hello.flow.yaml',
      git_ref: gitRef,
      commit_id: null,
      inventory: null,
      ee_image: null,
      mode: 'check',
      run_limit: null,
      inputs_json: '{}',
      notify_json: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

describe('branches of a hosted project', () => {
  it('lists, makes, refuses and deletes, and writes each change down like a push', async () => {
    const project = (
      await call(dana, 'POST', '/api/v1/workspaces/net/projects', {
        key: 'flows',
        name: 'Flows',
        sample: 'hello',
      })
    ).json();
    const url = `/api/v1/projects/${project.id}/branches`;
    const main = project.commit as string;

    // ro may look, not change.
    expect((await call(lina, 'POST', url, { name: 'x', from: 'main' })).statusCode).toBe(403);
    const made = await call(omar, 'POST', url, { name: 'try/idea', from: 'main' });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toEqual({ name: 'try/idea', commit: main });
    // From a commit, abbreviated.
    expect(
      (await call(omar, 'POST', url, { name: 'release', from: main.slice(0, 10) })).json(),
    ).toEqual({ name: 'release', commit: main });
    expect((await call(omar, 'POST', url, { name: 'release', from: 'main' })).json()).toMatchObject(
      { error: 'exists' },
    );
    expect((await call(omar, 'POST', url, { name: 'x', from: 'nothing' })).statusCode).toBe(404);
    expect((await call(omar, 'POST', url, { name: 'bad..name', from: 'main' })).statusCode).toBe(
      400,
    );

    const ahead = await commitOn(project.id, 'try/idea', 'notes.md', 'An idea\n');
    await launchConfig(project.id, 'Release check', 'release');
    const listed = (await call(lina, 'GET', url)).json();
    expect(listed.branches).toEqual(['main', 'release', 'try/idea']);
    const by = Object.fromEntries(
      listed.details.map((b: { name: string }) => [b.name, b]),
    ) as Record<string, Record<string, unknown>>;
    expect(by.main).toMatchObject({ project: true, ahead: 0, commit: main });
    expect(by['try/idea']).toMatchObject({
      commit: ahead,
      ahead: 1,
      author: 'Dana Reyes',
      subject: 'Change notes.md',
    });
    expect(by.release).toMatchObject({ ahead: 0, configurations: ['Release check'] });

    const del = (name: string, force = false) =>
      call(omar, 'DELETE', `${url}?name=${encodeURIComponent(name)}${force ? '&force=true' : ''}`);
    expect((await del('main')).json()).toMatchObject({ error: 'project_branch' });
    expect((await del('release')).json()).toMatchObject({
      error: 'in_use',
      configurations: ['Release check'],
    });
    const unmerged = await del('try/idea');
    expect(unmerged.statusCode).toBe(409);
    expect(unmerged.json()).toMatchObject({
      error: 'unmerged',
      ahead: 1,
      message: 'try/idea has 1 commit not on main: deleting it loses them',
    });
    expect((await del('try/idea', true)).json()).toEqual({ name: 'try/idea', commit: ahead });
    expect((await del('nothing')).statusCode).toBe(404);
    expect(await git.branches(project.id)).toEqual(['main', 'release']);

    expect(
      (await listPushes(database.db, project.id)).map((p) => [p.login, p.ref, p.from, p.to]),
    ).toEqual([
      ['omar', 'try/idea', ahead, undefined],
      ['omar', 'release', undefined, main],
      ['omar', 'try/idea', undefined, main],
      ['dana', 'main', undefined, main],
    ]);
    const audit = (await listAudit(database.db, { action: 'project.branch-delete' })).entries;
    expect(audit.find((a) => a.result === 'ok')).toMatchObject({
      detail: { branch: 'try/idea', force: true },
    });
  });
});

describe('branches of a project with a source', () => {
  it('are made and deleted at the source first; the mirror follows', async () => {
    const source = join(root, 'source.git');
    const work = join(root, 'work');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', source]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    writeFileSync(join(work, 'README.md'), 'Flows\n');
    const g = (...args: string[]) =>
      execFileSync(
        'git',
        ['-C', work, '-c', 'user.name=T', '-c', 'user.email=t@example.net', ...args],
        {
          encoding: 'utf8',
        },
      ).trim();
    g('add', '.');
    g('commit', '-q', '-m', 'First');
    g('push', '-q', source, 'main');
    const project = (
      await call(dana, 'POST', '/api/v1/workspaces/net/projects', {
        key: 'ext',
        name: 'Ext',
        gitUrl: source,
      })
    ).json();
    const url = `/api/v1/projects/${project.id}/branches`;
    const atSource = () =>
      execFileSync('git', ['--git-dir', source, 'for-each-ref', '--format=%(refname:short)'], {
        encoding: 'utf8',
      })
        .trim()
        .split('\n');
    expect((await call(omar, 'POST', url, { name: 'hotfix', from: 'main' })).statusCode).toBe(201);
    expect(atSource()).toEqual(['hotfix', 'main']);
    expect(await git.branches(project.id)).toEqual(['hotfix', 'main']);
    expect((await call(omar, 'DELETE', `${url}?name=hotfix`)).statusCode).toBe(200);
    expect(atSource()).toEqual(['main']);
    expect(await git.branches(project.id)).toEqual(['main']);
  });
});
