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
import { parse, stringify } from 'yaml';
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
const versionIn = (text: string) => Number(parse(text).flow.version);
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
    const undone = await call('omar', 'POST', `/drafts/${draft}/undo`);
    expect(undone.status).toBe(200);
    // AFS-136: it says what it took back.
    expect(undone.json.steps).toEqual(['Ping it']);
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
    // AFS-136: Omar is in the draft: he hears "saving" before the commit is made, so his page
    // sends what he is typing.
    await call('omar', 'POST', `/drafts/${draft}/here`, {});
    await call('mia', 'POST', `/drafts/${draft}/here`, {});
    const stream = await fetch(`${api()}/drafts/${draft}/events`, {
      headers: { authorization: `Bearer ${tokens.omar}` },
    });
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const heard: string[] = [];
    const listening = (async () => {
      let buffer = '';
      while (!heard.includes('saved')) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        const cut = buffer.lastIndexOf('\n\n');
        if (cut < 0) continue;
        for (const m of buffer.slice(0, cut).matchAll(/^event: (.*)$/gm))
          if (m[1]) heard.push(m[1]);
        buffer = buffer.slice(cut + 2);
      }
    })();
    const saved = await call('mia', 'POST', `/drafts/${draft}/save`, {
      message: 'Friendlier titles',
    });
    await Promise.race([listening, new Promise((r) => setTimeout(r, 3000))]);
    await reader.cancel().catch(() => undefined);
    expect(heard.indexOf('saving')).toBeGreaterThan(-1);
    expect(heard.indexOf('saving')).toBeLessThan(heard.indexOf('saved'));
    expect(saved.status).toBe(200);
    const commit = saved.json.commit as string;
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: bare, encoding: 'utf8' }).trim();
    expect(git('rev-parse', 'refs/heads/main')).toBe(commit);
    // AFS-136: listed with the pushes through this server, by the saver.
    const pushes = (await call('mia', 'GET', `/projects/${project.id}/pushes`)).json;
    expect(JSON.stringify(pushes)).toContain(commit);
    expect(JSON.stringify(pushes)).toContain('mia');
    expect(git('log', '-1', '--format=%an <%ae>%n%B', commit)).toBe(
      'Mia Ortega <mia@example.net>\nFriendlier titles\n\nCo-authored-by: Omar Haddad <omar@example.net>',
    );
    const text = git('show', `${commit}:${FILE}`);
    expect(titleIn(text, PING)).toBe('Ping it');
    expect(titleIn(text, HELLO)).toBe('Greet');
    // AFS-171: the flow changed: its version moves on once from the branch's.
    expect(versionIn(text)).toBe(versionIn(git('show', `${commit}~1:${FILE}`)) + 1);
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

/** AFS-149: a draft's stream, as a page (tab) follows it. */
function follow(who: string, draft: string, tab?: string) {
  const events: { event: string; data: Loose }[] = [];
  const controller = new AbortController();
  const waiters: (() => void)[] = [];
  const done = (async () => {
    const reply = await fetch(`${api()}/drafts/${draft}/events${tab ? `?tab=${tab}` : ''}`, {
      headers: { authorization: `Bearer ${tokens[who]}` },
      signal: controller.signal,
    });
    const reader = (reply.body as ReadableStream<Uint8Array>).getReader();
    let buffer = '';
    for (;;) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      buffer += new TextDecoder().decode(value);
      for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
        for (const w of waiters.splice(0)) w();
      }
    }
  })().catch(() => undefined);
  const until = async (seen: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!seen() && Date.now() < end)
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    return seen();
  };
  return {
    events,
    until,
    close: async () => {
      controller.abort();
      await done;
    },
  };
}

describe('saving a draft open in several tabs (AFS-149)', () => {
  it("asks the saver's other tab for its typing, saves it, and spares the saver's own tab", async () => {
    const draft = (await call('mia', 'POST', `/projects/${project.id}/drafts?path=${FILE}`)).json
      .id as string;
    await call('mia', 'POST', `/drafts/${draft}/commands`, retitle(HELLO, 'Hello from tab A'));
    // Mia has the draft open in two tabs; she is "here" once, with two pages.
    await call('mia', 'POST', `/drafts/${draft}/here`, { tab: 'tab-a' });
    const here = await call('mia', 'POST', `/drafts/${draft}/here`, { tab: 'tab-b' });
    expect(here.json.people).toEqual([expect.objectContaining({ login: 'mia', tabs: 2 })]);
    // AFS-171: a page that opens Save says so (the others are told); the frame's next "I am here"
    // keeps it; closing Save takes it back.
    await call('mia', 'POST', `/drafts/${draft}/here`, { tab: 'tab-a', saving: true });
    const still = await call('mia', 'POST', `/drafts/${draft}/here`, { tab: 'tab-a' });
    expect(still.json.people).toEqual([
      expect.objectContaining({ login: 'mia', tabs: 2, saving: true }),
    ]);
    const off = await call('mia', 'POST', `/drafts/${draft}/here`, { tab: 'tab-a', saving: false });
    expect(off.json.people[0].saving).toBeUndefined();
    const a = follow('mia', draft, 'tab-a');
    const b = follow('mia', draft, 'tab-b');
    await a.until(() => a.events.some((e) => e.event === 'draft'));
    await b.until(() => b.events.some((e) => e.event === 'draft'));
    // Tab B, told of the save, sends what it was typing, then says so.
    const typed = (async () => {
      await b.until(() => b.events.some((e) => e.event === 'saving'));
      const saving = b.events.find((e) => e.event === 'saving')?.data;
      expect(saving.by).toMatchObject({ login: 'mia', name: 'Mia Ortega' });
      await call('mia', 'POST', `/drafts/${draft}/commands`, retitle(PING, 'Typed in tab B'));
      expect(
        (
          await call('mia', 'POST', `/drafts/${draft}/flushed`, {
            flush: saving.flush,
            stream: saving.stream,
          })
        ).status,
      ).toBe(204);
    })();
    const started = Date.now();
    const saved = await call('mia', 'POST', `/drafts/${draft}/save`, { tab: 'tab-a' });
    await typed;
    expect(saved.status).toBe(200);
    // It did not wait for the longest a page may take (3 s): tab B said it was done.
    expect(Date.now() - started).toBeLessThan(2900);
    const text = execFileSync('git', ['show', `${saved.json.commit}:${FILE}`], {
      cwd: bare,
      encoding: 'utf8',
    });
    expect(titleIn(text, PING)).toBe('Typed in tab B');
    expect(titleIn(text, HELLO)).toBe('Hello from tab A');
    await a.until(() => a.events.some((e) => e.event === 'saved'));
    expect(a.events.some((e) => e.event === 'saving')).toBe(false);
    expect(a.events.find((e) => e.event === 'saved')?.data).toMatchObject({
      by: { login: 'mia' },
      coAuthors: [],
    });
    await a.close();
    await b.close();
  });

  it('says what each edit did: a step removed, the fields of a step changed', async () => {
    const draft = (await call('omar', 'POST', `/projects/${project.id}/drafts?path=${FILE}`)).json
      .id as string;
    const watch = follow('mia', draft);
    await watch.until(() => watch.events.some((e) => e.event === 'draft'));
    await call('omar', 'POST', `/drafts/${draft}/commands`, retitle(HELLO, 'Greet them'));
    await call('omar', 'POST', `/drafts/${draft}/commands`, {
      command: { kind: 'deleteNodes', ids: [PING] },
    });
    await watch.until(() => watch.events.filter((e) => e.event === 'edit').length >= 2);
    const [changed, removed] = watch.events.filter((e) => e.event === 'edit').map((e) => e.data);
    expect(changed.changes).toEqual([{ step: 'Greet them', kind: 'changed', fields: ['title'] }]);
    expect(removed.changes).toContainEqual(expect.objectContaining({ kind: 'removed' }));
    await watch.close();
    await call('omar', 'DELETE', `/drafts/${draft}`);
  });

  it('answers "nothing to undo" without a refusal', async () => {
    const draft = (await call('lena', 'GET', `/projects/${project.id}/drafts`)).json;
    expect(draft).toEqual([]);
    const opened = (await call('omar', 'POST', `/projects/${project.id}/drafts?path=${FILE}`)).json
      .id as string;
    const undo = await call('omar', 'POST', `/drafts/${opened}/undo`);
    expect(undo.status).toBe(200);
    expect(undo.json).toMatchObject({ nothing: true, steps: [] });
    await call('omar', 'DELETE', `/drafts/${opened}`);
  });

  it('redo brings back what undo took, in order; a new edit ends it; a clash refuses it (AFS-172)', async () => {
    const id = (await call('omar', 'POST', `/projects/${project.id}/drafts?path=${FILE}`)).json
      .id as string;
    const titles = async () => {
      const doc = (await call('omar', 'GET', `/drafts/${id}`)).json.snapshot.doc;
      const of = (n: string) => doc.nodes.find((x: { id: string }) => x.id === n).title;
      return [of(HELLO), of(PING)];
    };
    const [hello, ping] = await titles();
    expect((await call('omar', 'POST', `/drafts/${id}/redo`)).json).toMatchObject({
      nothing: true,
      steps: [],
    });
    await call('omar', 'POST', `/drafts/${id}/commands`, retitle(HELLO, 'Greet'));
    await call('omar', 'POST', `/drafts/${id}/commands`, retitle(PING, 'Ping it'));
    await call('omar', 'POST', `/drafts/${id}/undo`);
    await call('omar', 'POST', `/drafts/${id}/undo`);
    expect(await titles()).toEqual([hello, ping]);
    // Mia's redo is hers: she undid nothing.
    expect((await call('mia', 'POST', `/drafts/${id}/redo`)).json.nothing).toBe(true);
    const first = await call('omar', 'POST', `/drafts/${id}/redo`);
    expect(first.status).toBe(200);
    expect(first.json.steps).toEqual(['Greet']);
    expect(await titles()).toEqual(['Greet', ping]);
    expect((await call('omar', 'POST', `/drafts/${id}/redo`)).json.steps).toEqual(['Ping it']);
    expect(await titles()).toEqual(['Greet', 'Ping it']);
    expect((await call('omar', 'POST', `/drafts/${id}/redo`)).json.nothing).toBe(true);
    // A redo is an edit like the others: Ctrl+Z takes it back.
    expect((await call('omar', 'POST', `/drafts/${id}/undo`)).json.steps).toEqual([ping]);
    expect(await titles()).toEqual(['Greet', ping]);
    // Someone else changed the same place since the undo: the redo is refused.
    await call('mia', 'POST', `/drafts/${id}/commands`, retitle(PING, 'Mia ping'));
    const refused = await call('omar', 'POST', `/drafts/${id}/redo`);
    expect(refused.status).toBe(422);
    expect(refused.json.message).toMatch(/Someone changed the same place since/);
    // A new edit of one's own ends what there was to redo.
    await call('omar', 'POST', `/drafts/${id}/undo`);
    await call('omar', 'POST', `/drafts/${id}/commands`, retitle(HELLO, 'Hi'));
    expect((await call('omar', 'POST', `/drafts/${id}/redo`)).json.nothing).toBe(true);
    await call('omar', 'DELETE', `/drafts/${id}`);
  });

  it('shows both sides of a clash and keeps the side picked at each place; saves are listed as such', async () => {
    const opened = (await call('mia', 'POST', `/projects/${project.id}/drafts?path=${FILE}`)).json
      .id as string;
    await call('mia', 'POST', `/drafts/${opened}/commands`, retitle(HELLO, 'Draft hello'));
    await call('mia', 'POST', `/drafts/${opened}/commands`, retitle(PING, 'Draft ping'));
    const clone = join(root, 'other2');
    execFileSync('git', ['clone', '--quiet', bare, clone]);
    const path = join(clone, FILE);
    const doc = parse(readFileSync(path, 'utf8'));
    for (const n of doc.nodes as { id: string; title: string }[]) {
      if (n.id === HELLO) n.title = 'Branch hello';
      if (n.id === PING) n.title = 'Branch ping';
    }
    execFileSync(process.execPath, [
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(stringify(doc))})`,
    ]);
    const g = (...args: string[]) => execFileSync('git', args, { cwd: clone, encoding: 'utf8' });
    g('-c', 'user.name=Dana', '-c', 'user.email=dana@example.net', 'commit', '-qam', 'Both');
    g('push', '--quiet', 'origin', 'HEAD:main');
    // The pages ask for clashes as an answer: no 409.
    const asked = await call('mia', 'POST', `/drafts/${opened}/save`, { answerConflicts: true });
    expect(asked.status).toBe(200);
    expect(asked.json.saved).toBe(false);
    const clashes = asked.json.conflicts as {
      id: string;
      label: string;
      draft: string;
      branch: string;
    }[];
    expect(clashes.map((c) => [c.draft, c.branch]).sort()).toEqual([
      ['Draft hello', 'Branch hello'],
      ['Draft ping', 'Branch ping'],
    ]);
    // One place picked only: still refused (over the API, a 409).
    const hello = clashes.find((c) => c.draft === 'Draft hello')?.id as string;
    const ping = clashes.find((c) => c.draft === 'Draft ping')?.id as string;
    expect(
      (await call('mia', 'POST', `/drafts/${opened}/save`, { choices: { [hello]: 'branch' } }))
        .status,
    ).toBe(409);
    const saved = await call('mia', 'POST', `/drafts/${opened}/save`, {
      choices: { [hello]: 'branch', [ping]: 'draft' },
      message: 'Picked per place',
    });
    expect(saved.status).toBe(200);
    const text = execFileSync('git', ['show', `${saved.json.commit}:${FILE}`], {
      cwd: bare,
      encoding: 'utf8',
    });
    expect(titleIn(text, HELLO)).toBe('Branch hello');
    expect(titleIn(text, PING)).toBe('Draft ping');
    // The Pushes list: the saver's name, how it came, and the commit's message.
    const pushes = (await call('mia', 'GET', `/projects/${project.id}/pushes`)).json as Loose[];
    expect(pushes.find((p) => p.to === saved.json.commit)).toMatchObject({
      login: 'mia',
      name: 'Mia Ortega',
      kind: 'save',
      message: 'Picked per place',
    });
  });
});

describe("the module catalog of the flow's image", () => {
  it('says while it is first read, then answers search and docs', async () => {
    const { CatalogIndex } = await import('@ansible-flow/node/catalog/catalogIndex');
    const index = CatalogIndex.build(':memory:', [
      {
        format: 1,
        collection: 'ansible.builtin',
        version: '2.19.0',
        core: '2.19.0',
        plugins: [
          {
            type: 'module',
            fqcn: 'ansible.builtin.ping',
            collection: 'ansible.builtin',
            name: 'ping',
            short_description: 'Try to connect to host, verify a usable python and return pong',
            description: 'A trivial test module.',
          },
        ],
        routing: {},
        errors: [],
      },
    ]);
    let ready = false;
    const asked: (string | undefined)[] = [];
    const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
    const git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
    const app2 = buildApp({
      log,
      database,
      instance: 'test',
      projects: { git, sync, allowLocal: true },
      catalog: {
        get: (image) => {
          asked.push(image);
          return ready
            ? { state: 'ready', index, image: image ?? 'afd-ee:2.19' }
            : { state: 'loading', image: image ?? 'afd-ee:2.19' };
        },
        retry: () => undefined,
      },
    });
    await app2.listen({ port: 0, host: '127.0.0.1' });
    try {
      const url = `http://127.0.0.1:${(app2.server.address() as AddressInfo).port}/api/v1`;
      const post = async (path: string, body?: unknown) => {
        const reply = await fetch(`${url}${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${tokens.mia}`,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        return { status: reply.status, json: (await reply.json()) as Loose };
      };
      const draft = (await post(`/projects/${project.id}/drafts?path=${FILE}`)).json.id;
      const search = { request: { op: 'search', query: 'connect python' } };
      const loading = await post(`/drafts/${draft}/catalog`, search);
      expect(loading.status).toBe(202);
      expect(loading.json.status).toMatchObject({ state: 'loading', environment: 'afd-ee:2.19' });
      ready = true;
      const found = await post(`/drafts/${draft}/catalog`, search);
      expect(found.json.result.map((h: { fqcn: string }) => h.fqcn)).toEqual([
        'ansible.builtin.ping',
      ]);
      const doc = await post(`/drafts/${draft}/catalog`, {
        request: { op: 'doc', fqcn: 'ping' },
      });
      expect(doc.json.result).toMatchObject({
        fqcn: 'ansible.builtin.ping',
        collection_version: '2.19.0',
      });
      expect(
        (await post(`/drafts/${draft}/catalog`, { request: { op: 'status' } })).json.status,
      ).toMatchObject({
        state: 'ready',
        modules: 1,
      });
      // AFS-118: a flow shown (a run's page) reads the same docs, without a draft; no Rebuild.
      const shown = `/projects/${project.id}/flows/catalog?path=${FILE}`;
      expect(
        (await post(shown, { request: { op: 'doc', fqcn: 'ping' } })).json.result,
      ).toMatchObject({ fqcn: 'ansible.builtin.ping' });
      expect((await post(shown, { request: { op: 'rebuild' } })).status).toBe(403);
      // No launch configuration names an image: the server's default.
      expect(asked.every((a) => a === undefined)).toBe(true);
      await post(`/drafts/${draft}/save`, {});
    } finally {
      index.close();
      await app2.close();
    }
  });
});
