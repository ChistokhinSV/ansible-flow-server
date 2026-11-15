// AFS-58: a hosted project starts from a sample project or an uploaded archive (zip, tar.gz): the
// archive is unpacked in memory with every path checked and every byte counted, then committed as
// the project's first commit by the person who sent it, with a row in the record of pushes.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { zipSync } from 'fflate';
import { pack } from 'tar-stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { listAudit } from '../../src/server/audit/store';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import {
  archiveFiles,
  listSamples,
  type StartFiles,
  StartRefused,
  sampleFiles,
} from '../../src/server/projects/start';
import { listPushes } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { grant } from './helpers/grant';

const root = mkdtempSync(join(tmpdir(), 'afs-start-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const LIMITS = { maxBytes: 1024 * 1024, maxFiles: 50 };

const zip = (files: Record<string, string | Uint8Array>) =>
  Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([k, v]) => [
          k,
          typeof v === 'string' ? new TextEncoder().encode(v) : v,
        ]),
      ),
    ),
  );

type TarEntry = { name: string; text?: string; mode?: number; type?: 'symlink'; linkname?: string };
async function tarGz(entries: TarEntry[]): Promise<Buffer> {
  const p = pack();
  const chunks: Buffer[] = [];
  p.on('data', (c: unknown) => chunks.push(c as Buffer));
  const ended = new Promise<void>((resolve) => p.on('end', () => resolve()));
  for (const e of entries)
    if (e.type === 'symlink')
      p.entry({ name: e.name, type: 'symlink', linkname: e.linkname ?? 'x' });
    else p.entry({ name: e.name, mode: e.mode ?? 0o644 }, e.text ?? '');
  p.finalize();
  await ended;
  return gzipSync(Buffer.concat(chunks));
}

const text = (files: StartFiles, path: string) => files.get(path)?.bytes.toString('utf8');
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'taken',
    (e) => (e instanceof StartRefused ? e.message : `other: ${(e as Error).message}`),
  );

describe('archives', () => {
  it('takes a zip and a tar.gz, without the one folder that holds everything', async () => {
    const fromZip = await archiveFiles(
      zip({ 'site/flows/a.flow.yaml': 'a', 'site/inventory.ini': 'i', 'site/empty/': '' }),
      LIMITS,
    );
    expect([...fromZip.keys()].sort()).toEqual(['flows/a.flow.yaml', 'inventory.ini']);
    const fromTar = await archiveFiles(
      await tarGz([
        { name: './flows/a.flow.yaml', text: 'a' },
        { name: './scripts/check.sh', text: '#!/bin/sh', mode: 0o755 },
        { name: 'README.md', text: 'hi' },
      ]),
      LIMITS,
    );
    expect([...fromTar.keys()].sort()).toEqual([
      'README.md',
      'flows/a.flow.yaml',
      'scripts/check.sh',
    ]);
    expect(fromTar.get('scripts/check.sh')?.executable).toBe(true);
    expect(fromTar.get('README.md')?.executable).toBeUndefined();
    expect(text(fromTar, 'flows/a.flow.yaml')).toBe('a');
  });

  it('refuses paths that leave the project, a .git folder, links, and what is not an archive', async () => {
    expect(await refusal(archiveFiles(zip({ '../evil.yml': 'x' }), LIMITS))).toMatch(
      /outside the project: "..\/evil.yml"/,
    );
    expect(await refusal(archiveFiles(zip({ 'a/../../evil': 'x' }), LIMITS))).toMatch(
      /outside the project/,
    );
    expect(await refusal(archiveFiles(await tarGz([{ name: '/etc/cron.d/x' }]), LIMITS))).toMatch(
      /outside the project/,
    );
    expect(await refusal(archiveFiles(zip({ 'C:/x': 'x' }), LIMITS))).toMatch(/outside/);
    expect(await refusal(archiveFiles(zip({ 'p/.git/config': 'x' }), LIMITS))).toMatch(
      /\.git folder/,
    );
    expect(
      await refusal(
        archiveFiles(await tarGz([{ name: 'link', type: 'symlink', linkname: '/etc' }]), LIMITS),
      ),
    ).toMatch(/symlink entry \(link\)/);
    expect(await refusal(archiveFiles(Buffer.from('plain text'), LIMITS))).toBe(
      'Not a zip or tar.gz archive',
    );
    expect(await refusal(archiveFiles(Buffer.from([0x1f, 0x8b, 1, 2, 3]), LIMITS))).toMatch(
      /damaged/,
    );
    expect(await refusal(archiveFiles(zip({ 'empty/': '' }), LIMITS))).toBe(
      'The archive has no files',
    );
  });

  it('counts what is unpacked: a small file that unpacks too large, and too many files', async () => {
    const zeros = new Uint8Array(3 * 1024 * 1024);
    const bomb = zip({ 'big.bin': zeros });
    expect(bomb.length).toBeLessThan(LIMITS.maxBytes);
    expect(await refusal(archiveFiles(bomb, LIMITS))).toBe('The archive unpacks to more than 1 MB');
    const bigTar = await tarGz([{ name: 'big.bin', text: '0'.repeat(3 * 1024 * 1024) }]);
    expect(await refusal(archiveFiles(bigTar, LIMITS))).toBe(
      'The archive unpacks to more than 1 MB',
    );
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}.txt`, 'x']));
    expect(await refusal(archiveFiles(zip(many), LIMITS))).toBe(
      'The archive has more than 50 files',
    );
  });
});

describe('samples', () => {
  it('offers the designer sample projects, laid out as projects', () => {
    expect(listSamples().map((s) => s.key)).toEqual(['hello', 'edge-baseline', 'firewall-upgrade']);
    const hello = sampleFiles('hello');
    expect([...hello.keys()].sort()).toEqual([
      'flows/hello/hello.flow.yaml',
      'flows/hello/hello.scenarios.yaml',
      'inventory.ini',
    ]);
    const edge = sampleFiles('edge-baseline');
    expect(edge.has('site.yml')).toBe(true);
    expect(edge.has('roles/push_baseline/tasks/main.yml')).toBe(true);
    expect(() => sampleFiles('nope')).toThrow('No sample "nope"');
  });
});

describe('starting a hosted project over the API', () => {
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
    app = buildApp({
      log,
      database,
      instance: 'test',
      projects: { git, sync, allowLocal: true, archiveMaxBytes: LIMITS.maxBytes },
    });
    const signIn = async (login: string, admin: boolean) => {
      await createUser(database.db, {
        login,
        name: { dana: 'Dana Reyes', omar: 'Omar Haddad' }[login] ?? 'Lina Park',
        password: 'correct horse battery staple',
        admin,
      });
      const reply = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { login, password: 'correct horse battery staple' },
      });
      return /afs_session=[^;]*/.exec([reply.headers['set-cookie']].flat().join(';'))?.[0] ?? '';
    };
    dana = await signIn('dana', true);
    omar = await signIn('omar', false);
    lina = await signIn('lina', false);
    await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { cookie: dana },
      payload: { key: 'net', name: 'Network' },
    });
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });

  const call = (
    cookie: string,
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    type = 'application/json',
  ) =>
    app.inject({
      method,
      url,
      headers: { cookie, ...(body !== undefined ? { 'content-type': type } : {}) },
      ...(body !== undefined
        ? { payload: Buffer.isBuffer(body) ? body : JSON.stringify(body) }
        : {}),
    });
  const tree = (projectId: string, commit: string) =>
    execFileSync('git', ['--git-dir', git.mirror(projectId), 'ls-tree', '-r', commit], {
      encoding: 'utf8',
    });

  it('makes a project from a sample: one commit by its maker, its flows listed, a push recorded', async () => {
    expect((await call(omar, 'GET', '/api/v1/samples')).json()[0]).toMatchObject({
      key: 'hello',
      name: 'Hello, Ansible',
    });
    const wrong = await call(dana, 'POST', '/api/v1/workspaces/net/projects', {
      key: 'nope',
      name: 'Nope',
      sample: 'nope',
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().message).toBe('No sample "nope"');
    // A wrong sample made nothing.
    expect((await call(dana, 'GET', '/api/v1/workspaces/net/projects')).json()).toEqual([]);

    const made = await call(dana, 'POST', '/api/v1/workspaces/net/projects', {
      key: 'hello',
      name: 'Hello',
      sample: 'hello',
    });
    expect(made.statusCode).toBe(201);
    const project = made.json();
    expect(project).toMatchObject({ hosted: true, sync: { state: 'ok' } });
    expect(project.commit).toMatch(/^[0-9a-f]{40}$/);
    const flows = await call(dana, 'GET', `/api/v1/projects/${project.id}/flows`);
    expect(flows.json().flows.map((f: { file: string }) => f.file)).toEqual([
      'flows/hello/hello.flow.yaml',
    ]);
    const author = execFileSync(
      'git',
      ['--git-dir', git.mirror(project.id), 'log', '-1', '--format=%an <%ae>|%s', project.commit],
      { encoding: 'utf8' },
    ).trim();
    expect(author).toBe(
      'Dana Reyes <dana@users.ansible-flow-server>|Start hello from the hello sample',
    );
    expect((await listPushes(database.db, project.id)).map((p) => [p.login, p.ref, p.to])).toEqual([
      ['dana', 'main', project.commit],
    ]);

    // Only while empty.
    const again = await call(dana, 'POST', `/api/v1/projects/${project.id}/start`, {
      sample: 'hello',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toMatch(/commits already/);
  });

  it('starts an empty project from an archive, by someone with rw on the workspace', async () => {
    const project = (
      await call(dana, 'POST', '/api/v1/workspaces/net/projects', { key: 'ops', name: 'Ops' })
    ).json();
    const archive = await tarGz([
      { name: 'ops/flows/hello/hello.flow.yaml', text: sampleText('hello') },
      { name: 'ops/scripts/check.sh', text: '#!/bin/sh\necho ok\n', mode: 0o755 },
      { name: 'ops/.gitignore', text: '*.retry\n' },
      { name: 'ops/site.retry', text: 'ignored by .gitignore, still sent' },
    ]);
    const url = `/api/v1/projects/${project.id}/start`;
    await grant(database.db, 'net', 'lina', 'ro');
    expect((await call(lina, 'POST', url, archive, 'application/gzip')).statusCode).toBe(403);
    await grant(database.db, 'net', 'omar', 'rw');
    const refused = await call(omar, 'POST', url, zip({ '../x': 'x' }), 'application/zip');
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toMatch(/outside the project/);
    const started = await call(omar, 'POST', url, archive, 'application/gzip');
    expect(started.statusCode).toBe(201);
    const commit = started.json().commit;
    const listed = tree(project.id, commit);
    expect(listed).toMatch(/^100755 blob \w+\tscripts\/check\.sh$/m);
    expect(listed).toMatch(/\tsite\.retry$/m);
    expect(listed).toMatch(/\tflows\/hello\/hello\.flow\.yaml$/m);
    const audit = (await listAudit(database.db, { action: 'project.start' })).entries;
    // With the refused second start of the sample project before.
    expect(audit.map((a) => `${a.actor?.login ?? ''} ${a.result} ${a.status}`).sort()).toEqual([
      'dana failed 409',
      'lina refused 403',
      'omar failed 400',
      'omar ok 201',
    ]);
  });

  it('refuses a project with a source, and a body that is neither', async () => {
    const source = join(root, 'source.git');
    execFileSync('git', ['init', '--bare', '-q', source]);
    const external = (
      await call(dana, 'POST', '/api/v1/workspaces/net/projects', {
        key: 'ext',
        name: 'Ext',
        gitUrl: source,
      })
    ).json();
    const refused = await call(dana, 'POST', `/api/v1/projects/${external.id}/start`, {
      sample: 'hello',
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toMatch(/source of its own/);
    const bothAsked = await call(dana, 'POST', '/api/v1/workspaces/net/projects', {
      key: 'both',
      name: 'Both',
      gitUrl: source,
      sample: 'hello',
    });
    expect(bothAsked.statusCode).toBe(400);
    const empty = (
      await call(dana, 'POST', '/api/v1/workspaces/net/projects', { key: 'e', name: 'E' })
    ).json();
    expect((await call(dana, 'POST', `/api/v1/projects/${empty.id}/start`, {})).statusCode).toBe(
      400,
    );
  });
});

function sampleText(key: string): string {
  return text(sampleFiles(key), `flows/${key}/${key}.flow.yaml`) ?? '';
}
