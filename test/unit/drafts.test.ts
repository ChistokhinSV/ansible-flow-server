// Editing a flow in the pages, together (AFS-76), against a real repository: two people edit one
// draft (different steps both apply, the same field: the later wins), the live stream tells each
// of the other's edits, undo takes back one's own edit and refuses when the other changed the same
// place, Save is one commit by the saver with the other as co-author, a Save after the branch
// moved merges first (conflicts refuse it unless forced), and someone with read access edits
// nothing.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildApp } from '../../src/server/app';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace, type Project } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { grant } from './helpers/grant';
import { type TestRepo, testRepo } from './helpers/repo';

const FILE = 'hello.flow.yaml';
const PING = '01M6GPM979RJPCDJ0XFF22GBSV';
const HELLO = '01M6GPM9B1D563X8PKD5041JHV';
const fixture = readFileSync(join(__dirname, '../fixtures/hello.flow.yaml'), 'utf8');
const root = mkdtempSync(join(tmpdir(), 'afs-drafts-'));

let database: Database;
let app: FastifyInstance;
let sync: ProjectSync;
let source: TestRepo;
let bare: string;
let project: Project;
/** JSON as the server answers it: the test reads the fields it checks. */
type Loose = ReturnType<typeof JSON.parse>;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  source = testRepo({ [FILE]: fixture });
  // The project's source is a bare repository, as a git host's is.
  bare = join(root, 'source.git');
  execFileSync('git', ['clone', '--quiet', '--bare', source.dir, bare]);
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
  const git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
  sync = new ProjectSync(database.db, git, log);
  app = buildApp({ log, database, instance: 'test', projects: { git, sync, allowLocal: true } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const workspace = await createWorkspace(database.db, { key: 'net', name: 'Network' });
  const made = await createProject(
    database.db,
    workspace.id,
    { key: 'core', name: 'Core', gitUrl: bare, pollSeconds: 0 },
    true,
  );
  project = (await sync.sync(made.id)) as Project;
  for (const [login, name, level] of [
    ['mia', 'Mia Ortega', 'rw'],
    ['omar', 'Omar Haddad', 'rw'],
    ['lena', 'Lena Park', 'ro'],
  ] as const) {
    const u = await createUser(database.db, { login, name, email: `${login}@example.net` });
    await grant(database.db, 'net', login, level);
    tokens[login] = (await createToken(database.db, u.id, { name: 't' })).token;
  }
});
afterAll(async () => {
  await sync.stop();
  await app.close();
  await database.close();
  source.remove();
  rmSync(root, { recursive: true, force: true });
});

const api = () => `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v1`;
const call = async (who: string, method: string, path: string, body?: unknown) => {
  const reply = await fetch(`${api()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: reply.status, json: (await reply.json().catch(() => undefined)) as Loose };
};
const titleIn = (text: string, id: string) =>
  (parse(text).nodes as { id: string; title: string }[]).find((n) => n.id === id)?.title;
const retitle = (id: string, title: string) => ({
  command: { kind: 'updateNode', id, patch: { title } },
});

describe('editing a flow together', () => {
  let draft = '';

  it('two people edit one draft; each sees the other; the same field: the later wins', async () => {
    const opened = await call('mia', 'POST', `/projects/${project.id}/drafts?path=${FILE}`);
    expect(opened.status).toBe(201);
    draft = opened.json.id;
    // Omar opens the same flow: the same draft.
    expect(
      (await call('omar', 'POST', `/projects/${project.id}/drafts?path=${FILE}`)).json.id,
    ).toBe(draft);

    // Omar watches the draft while Mia edits.
    const reply = await fetch(`${api()}/drafts/${draft}/events`, {
      headers: { authorization: `Bearer ${tokens.omar}` },
    });
    const reader = (reply.body as ReadableStream<Uint8Array>).getReader();
    const events: { event: string; data: Loose }[] = [];
    const read = async (until: () => boolean) => {
      let buffer = '';
      while (!until()) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      }
    };
    await read(() => events.some((e) => e.event === 'draft'));
    expect(
      (await call('mia', 'POST', `/drafts/${draft}/commands`, retitle(PING, 'Ping it'))).status,
    ).toBe(200);
    await read(() => events.some((e) => e.event === 'edit'));
    const edit = events.find((e) => e.event === 'edit')?.data;
    expect(edit).toMatchObject({
      revision: 1,
      by: { login: 'mia', name: 'Mia Ortega' },
      nodes: [PING],
    });
    expect(edit.snapshot.doc.nodes.find((n: { id: string }) => n.id === PING).title).toBe(
      'Ping it',
    );
    await reader.cancel();

    // Different steps both apply; the same field twice: the later one.
    await call('omar', 'POST', `/drafts/${draft}/commands`, retitle(HELLO, 'Greet'));
    await call('omar', 'POST', `/drafts/${draft}/commands`, retitle(PING, 'Check it answers'));
    const now = (await call('mia', 'GET', `/drafts/${draft}`)).json;
    expect(now.draft).toMatchObject({
      revision: 3,
      editors: [{ login: 'mia' }, { login: 'omar' }],
    });
    const titles = Object.fromEntries(
      now.snapshot.doc.nodes.map((n: { id: string; title: string }) => [n.id, n.title]),
    );
    expect(titles[HELLO]).toBe('Greet');
    expect(titles[PING]).toBe('Check it answers');
  });

  it("undo takes back one's own last edit, and refuses when the other changed it since", async () => {
    // Mia's last edit is the Ping title, which Omar changed after her: refused.
    const refused = await call('mia', 'POST', `/drafts/${draft}/undo`);
    expect(refused.status).toBe(422);
    expect(refused.json.message).toMatch(/Someone changed the same place since/);
    // Omar's own last edit goes back to Mia's title; his other edit stays.
    expect((await call('omar', 'POST', `/drafts/${draft}/undo`)).status).toBe(200);
    const doc = (await call('omar', 'GET', `/drafts/${draft}`)).json.snapshot.doc;
    const titleOf = (id: string) => doc.nodes.find((n: { id: string }) => n.id === id).title;
    expect(titleOf(PING)).toBe('Ping it');
    expect(titleOf(HELLO)).toBe('Greet');
  });

  it('someone with read access sees the draft and edits nothing', async () => {
    expect((await call('lena', 'GET', `/drafts/${draft}`)).status).toBe(200);
    expect(
      (await call('lena', 'POST', `/drafts/${draft}/commands`, retitle(PING, 'x'))).status,
    ).toBe(403);
    expect((await call('lena', 'POST', `/drafts/${draft}/save`, {})).status).toBe(403);
  });

  it('Save is one commit on the branch by the saver, with the other as co-author', async () => {
    const saved = await call('mia', 'POST', `/drafts/${draft}/save`, {
      message: 'Friendlier titles',
    });
    expect(saved.status).toBe(200);
    const commit = saved.json.commit as string;
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: bare, encoding: 'utf8' }).trim();
    expect(git('rev-parse', 'refs/heads/main')).toBe(commit);
    expect(git('log', '-1', '--format=%an <%ae>%n%B', commit)).toBe(
      'Mia Ortega <mia@example.net>\nFriendlier titles\n\nCo-authored-by: Omar Haddad <omar@example.net>',
    );
    const text = git('show', `${commit}:${FILE}`);
    expect(titleIn(text, PING)).toBe('Ping it');
    expect(titleIn(text, HELLO)).toBe('Greet');
    expect((await call('mia', 'GET', `/drafts/${draft}`)).status).toBe(404);
    expect((await call('mia', 'GET', `/projects/${project.id}`)).json.commit).toBe(commit);
  });

  it('a Save after the branch moved merges first; a conflict refuses it unless forced', async () => {
    const opened = (await call('mia', 'POST', `/projects/${project.id}/drafts?path=${FILE}`)).json
      .id;
    await call('mia', 'POST', `/drafts/${opened}/commands`, retitle(HELLO, 'Say hi'));
    // Someone pushes straight to the source: another step, and the same step differently.
    const clone = join(root, 'other');
    execFileSync('git', ['clone', '--quiet', bare, clone]);
    const g = (...args: string[]) => execFileSync('git', args, { cwd: clone, encoding: 'utf8' });
    const path = join(clone, FILE);
    const text = readFileSync(path, 'utf8');
    execFileSync(process.execPath, [
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(
        text
          .replace('title: Ping it', 'title: Ping each host')
          .replace('title: Greet', 'title: Hello there'),
      )})`,
    ]);
    g('-c', 'user.name=Dana', '-c', 'user.email=dana@example.net', 'commit', '-qam', 'Elsewhere');
    g('push', '--quiet', 'origin', 'HEAD:main');
    const refused = await call('mia', 'POST', `/drafts/${opened}/save`, {});
    expect(refused.status).toBe(409);
    expect(refused.json.conflicts.map((c: { label: string }) => c.label)).toEqual([
      'Say hi: title',
    ]);
    const forced = await call('mia', 'POST', `/drafts/${opened}/save`, { force: true });
    expect(forced.status).toBe(200);
    const saved = execFileSync('git', ['show', `${forced.json.commit}:${FILE}`], {
      cwd: bare,
      encoding: 'utf8',
    });
    // The branch's other change is kept; the draft's side of the conflict is taken.
    expect(titleIn(saved, PING)).toBe('Ping each host');
    expect(titleIn(saved, HELLO)).toBe('Say hi');
  });

  it('Discard drops a draft', async () => {
    const opened = (await call('omar', 'POST', `/projects/${project.id}/drafts?path=${FILE}`)).json
      .id;
    expect(
      (await call('omar', 'GET', `/projects/${project.id}/drafts`)).json.map(
        (d: { id: string }) => d.id,
      ),
    ).toEqual([opened]);
    expect((await call('omar', 'DELETE', `/drafts/${opened}`)).status).toBe(204);
    expect((await call('omar', 'GET', `/projects/${project.id}/drafts`)).json).toEqual([]);
  });
});
