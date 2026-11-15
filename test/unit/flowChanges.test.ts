// Who changed which flow (AFS-75): a project's event stream says when its branch moves, and the
// changes between two commits name the flows added, changed or removed and who changed them,
// narrowed to the flows the person may see. The repository is a real one in a folder.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace, type Project } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { ProjectWatch } from '../../src/server/projects/watch';
import { grant } from './helpers/grant';
import { type TestRepo, testRepo } from './helpers/repo';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name), 'utf8');
const root = mkdtempSync(join(tmpdir(), 'afs-changes-'));
const MIA = 'Mia Ortega <mia@example.net>';

let database: Database;
let app: FastifyInstance;
let sync: ProjectSync;
let source: TestRepo;
let project: Project;
let first: string;
let base: string;
let omar: string;
let lena: string;

beforeAll(async () => {
  source = testRepo({
    'hello.flow.yaml': fixture('hello.flow.yaml'),
    'flows/firewall-upgrade.flow.yaml': fixture('firewall-upgrade.flow.yaml'),
    'README.md': 'Flows of the network team\n',
  });
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
  const git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
  sync = new ProjectSync(database.db, git, log);
  app = buildApp({
    log,
    database,
    instance: 'test',
    projects: { git, sync, allowLocal: true, watch: new ProjectWatch(database.db, log, 50) },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const workspace = await createWorkspace(database.db, { key: 'net', name: 'Network' });
  const made = await createProject(
    database.db,
    workspace.id,
    { key: 'core', name: 'Core', gitUrl: source.dir, pollSeconds: 0 },
    true,
  );
  project = (await sync.sync(made.id)) as Project;
  first = project.commit as string;
  const o = await createUser(database.db, { login: 'omar', name: 'Omar' });
  const l = await createUser(database.db, { login: 'lena', name: 'Lena' });
  await grant(database.db, 'net', 'omar');
  await grant(database.db, 'net', 'lena', 'ro', { project: project.id, file: 'hello.flow.yaml' });
  omar = (await createToken(database.db, o.id, { name: 't' })).token;
  lena = (await createToken(database.db, l.id, { name: 't' })).token;
});
afterAll(async () => {
  await sync.stop();
  await app.close();
  await database.close();
  source.remove();
  rmSync(root, { recursive: true, force: true });
});

interface Changes {
  from: string;
  to: string;
  flows: { file: string; change: string; authors: string[] }[];
}
type History = { commit: string; author: string; subject: string }[];
const json = async <T>(reply: Response | Promise<Response>) => (await (await reply).json()) as T;

const get = (path: string, token = omar) =>
  fetch(`${base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });

/** Reads a server-sent event stream until `until` says enough. */
async function watch(
  path: string,
  until: (events: { event: string; data: unknown }[]) => boolean,
  meanwhile: () => Promise<void>,
) {
  const reply = await get(path);
  expect(reply.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  const reader = (reply.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: unknown }[] = [];
  let buffer = '';
  let started = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at = buffer.indexOf('\n\n');
    while (at >= 0) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) events.push({ event, data: JSON.parse(data) });
      at = buffer.indexOf('\n\n');
    }
    if (!started && events.length) {
      started = true;
      await meanwhile();
    }
    if (until(events)) {
      await reader.cancel();
      break;
    }
  }
  return events;
}

describe('who changed which flow', () => {
  let second: string;

  it('the event stream says where the branch is, then that it moved', async () => {
    const events = await watch(
      `/projects/${project.id}/events`,
      (e) => e.some((x) => x.event === 'moved'),
      async () => {
        second = source.commit(
          {
            'hello.flow.yaml': `${fixture('hello.flow.yaml')}# a note\n`,
            'flows/firewall-upgrade.flow.yaml': null,
            'README.md': 'Flows of the network team, and more\n',
          },
          'Hello gets a note; the firewall flow goes',
          MIA,
        );
        await sync.sync(project.id);
      },
    );
    expect(events[0]).toEqual({ event: 'commit', data: { commit: first } });
    expect(events.at(-1)).toEqual({ event: 'moved', data: { from: first, to: second } });
  });

  it('the changes name the flows, what happened to them and who did it', async () => {
    const changes = await json<Changes>(get(`/projects/${project.id}/changes?from=${first}`));
    expect(changes).toMatchObject({ from: first, to: second });
    expect(changes.flows).toEqual([
      {
        file: 'flows/firewall-upgrade.flow.yaml',
        change: 'removed',
        authors: ['Mia Ortega'],
        at: expect.any(String),
        commit: second,
      },
      {
        file: 'hello.flow.yaml',
        change: 'changed',
        authors: ['Mia Ortega'],
        at: expect.any(String),
        commit: second,
      },
    ]);
    // Someone with a grant on one flow hears of that flow only.
    const hers = await json<Changes>(get(`/projects/${project.id}/changes?from=${first}`, lena));
    expect(hers.flows.map((f: { file: string }) => f.file)).toEqual(['hello.flow.yaml']);
    // A commit the server does not have (not pushed) is said so.
    const unknown = await get(`/projects/${project.id}/changes?from=${'a'.repeat(40)}`);
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toMatchObject({ error: 'unknown_commit' });
  });

  it("a flow's history lists the commits that changed it, newest first", async () => {
    const history = await json<History>(
      get(`/projects/${project.id}/flows/history?path=hello.flow.yaml`),
    );
    expect(history.map((h) => [h.commit, h.author])).toEqual([
      [second, 'Mia Ortega'],
      [first, 'Dana Whitfield'],
    ]);
    expect(history[0]?.subject).toBe('Hello gets a note; the firewall flow goes');
    // Lena may not see the firewall flow, nor its history.
    const not = await get(
      `/projects/${project.id}/flows/history?path=flows/firewall-upgrade.flow.yaml&commit=${first}`,
      lena,
    );
    expect(not.status).toBe(403);
  });
});
