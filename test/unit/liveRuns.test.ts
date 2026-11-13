// Watching runs: the live stream of a run (its record, the designer's view, its output), what
// one host did in one step, running a run again, and how long ended runs are kept.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import type { PreparedLaunch } from '../../src/server/launch/prepare';
import { createLogger } from '../../src/server/log';
import { createProject, createWorkspace } from '../../src/server/projects/store';
import { RunHub } from '../../src/server/runs/hub';
import { RunQueue } from '../../src/server/runs/queue';
import { pruneRuns } from '../../src/server/runs/retention';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { grant } from './helpers/grant';

const PASSWORD = 'correct horse battery staple';
const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const root = mkdtempSync(join(tmpdir(), 'afs-live-'));
const NODE = '01M6GPM979RJPCDJ0XFF22GBSV';

let database: Database;
let app: FastifyInstance;
let queue: RunQueue;
let hub: RunHub;
let base: string;
let admin: string;
let member: string;
let project: string;
const outputFile = (id: string) => join(root, 'output', `${id}.log`);

const launchOf = (
  flow = 'flows/hello.flow.yaml',
  inputs: Record<string, unknown> = {},
): PreparedLaunch => ({
  config: 'c-1',
  project,
  commit: 'a'.repeat(40),
  ref: 'main',
  flow: { file: flow, key: 'hello', name: 'Hello', version: 1 },
  mode: 'check',
  inputs,
  targets: ['fw-edge-01'],
  credentials: [],
});

beforeAll(async () => {
  mkdirSync(join(root, 'output'), { recursive: true });
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  queue = new RunQueue(database.db, 'sqlite', key);
  hub = new RunHub();
  app = buildApp({
    log: createLogger({ level: 'error', format: 'json', write: () => undefined }),
    database,
    instance: 'test',
    runs: queue,
    runOutput: outputFile,
    hub,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const workspace = (await createWorkspace(database.db, { key: 'net', name: 'Network' })).id;
  project = (await createProject(database.db, workspace, { key: 'edge', name: 'Edge' }, false)).id;
  const dana = await createUser(database.db, {
    login: 'dana',
    name: 'Dana',
    password: PASSWORD,
    admin: true,
  });
  const omar = await createUser(database.db, { login: 'omar', name: 'Omar', password: PASSWORD });
  admin = (await createToken(database.db, dana.id, { name: 'a' })).token;
  member = (await createToken(database.db, omar.id, { name: 'm' })).token;
  await grant(database.db, 'net', 'omar');
});
afterAll(async () => {
  await app.close();
  await database.close();
  rmSync(root, { recursive: true, force: true });
});

const call = (method: 'GET' | 'POST', path: string, token = member) =>
  fetch(`${base}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}` } });

/** Reads a server-sent event stream until `until` says enough, or it ends. */
async function watch(path: string, until: (events: { event: string; data: unknown }[]) => boolean) {
  const reply = await call('GET', path);
  expect(reply.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  const reader = (reply.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: unknown }[] = [];
  let buffer = '';
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
    if (until(events)) {
      await reader.cancel();
      break;
    }
  }
  return events;
}
const kinds = (events: { event: string }[]) => events.map((e) => e.event);

describe('the live stream of a run', () => {
  it('sends the record, the view and the output as they come, and ends with the run', async () => {
    const run = await queue.enqueue(launchOf(), {}, { id: 'u', login: 'dana' });
    const job = await queue.claim('w1');
    const dir = join(root, 'runs', run.id);
    mkdirSync(dir, { recursive: true });
    await queue.start(run.id, job?.token as string, new Date(), dir);
    writeFileSync(outputFile(run.id), 'PLAY [hello]\n');

    const watching = watch(`/runs/${run.id}/events`, (events) => kinds(events).includes('end'));
    await new Promise((r) => setTimeout(r, 200));
    // The worker says what happens: a view, more output, and the end.
    hub.publish(run.id, {
      kind: 'view',
      view: { id: 'x', mode: 'check', state: 'running', startedAt: 't' },
    });
    writeFileSync(outputFile(run.id), 'PLAY [hello]\nok: [fw-edge-01]\n');
    hub.publish(run.id, { kind: 'output', text: 'ok: [fw-edge-01]\n' });
    await new Promise((r) => setTimeout(r, 100));
    await queue.finish(run.id, job?.token as string, 'succeeded', undefined, new Date(), {
      id: 'x',
      mode: 'check',
      state: 'done',
      rc: 0,
      startedAt: 't',
    });
    hub.ended(run.id);
    const events = await watching;

    expect(events[0]).toMatchObject({ event: 'run', data: { id: run.id, state: 'running' } });
    const output = events
      .filter((e) => e.event === 'output')
      .map((e) => (e.data as { text: string }).text)
      .join('');
    expect(output).toBe('PLAY [hello]\nok: [fw-edge-01]\n');
    expect(
      events.filter((e) => e.event === 'view').map((e) => (e.data as { state: string }).state),
    ).toEqual(expect.arrayContaining(['running', 'done']));
    expect(
      events.some((e) => e.event === 'run' && (e.data as { state: string }).state === 'succeeded'),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({ event: 'end', data: { state: 'succeeded' } });

    // An ended run: all of it at once, then the end. From an offset, only what follows it.
    const again = await watch(`/runs/${run.id}/events`, () => false);
    expect(kinds(again)).toEqual(['run', 'view', 'output', 'view', 'end']);
    const from = await watch(`/runs/${run.id}/events?from=13`, () => false);
    expect(
      from
        .filter((e) => e.event === 'output')
        .map((e) => (e.data as { text: string }).text)
        .join(''),
    ).toBe('ok: [fw-edge-01]\n');
  });

  it('a long output starts with its end, and says so', async () => {
    const run = await queue.enqueue(launchOf(), {}, { id: 'u', login: 'dana' });
    await queue.cancel(run.id, 'dana');
    writeFileSync(outputFile(run.id), `${'x'.repeat(1024 * 1024 + 10)}\nlast line\n`);
    const events = await watch(`/runs/${run.id}/events`, () => false);
    const output = events
      .filter((e) => e.event === 'output')
      .map((e) => (e.data as { text: string }).text);
    expect(output[0]).toMatch(/^… \d+ bytes of earlier output are not shown here/);
    expect(output.join('').endsWith('last line\n')).toBe(true);
  });

  it('a cancel is heard by watchers', async () => {
    const run = await queue.enqueue(launchOf(), {}, { id: 'u', login: 'dana' });
    const watching = watch(`/runs/${run.id}/events`, (events) => kinds(events).includes('end'));
    await new Promise((r) => setTimeout(r, 200));
    expect((await call('POST', `/runs/${run.id}/cancel`, admin)).status).toBe(202);
    const events = await watching;
    expect(events.at(-1)).toMatchObject({ event: 'end', data: { state: 'cancelled' } });
  });

  it('needs a sign-in, and a run that is there', async () => {
    expect((await fetch(`${base}/api/v1/runs/x/events`)).status).toBe(401);
    expect((await call('GET', '/runs/nothing/events')).status).toBe(404);
  });
});

describe("a step's host output, running again, and the flow filter", () => {
  it("reads what one host did in one step from the run's events", async () => {
    const run = await queue.enqueue(launchOf(), {}, { id: 'u', login: 'dana' });
    const job = await queue.claim('w1');
    const dir = join(root, 'runs', `${run.id}-host`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'events.jsonl'),
      `${[
        { event: 'play', name: '[ping] Check', node: NODE, ts: 1 },
        {
          event: 'result',
          status: 'ok',
          host: 'fw-edge-01',
          task: '[ping] Check the host answers',
          action: 'ansible.builtin.ping',
          node: NODE,
          changed: false,
          ts: 2,
        },
        {
          event: 'result',
          status: 'failed',
          host: 'fw-edge-02',
          task: '[ping] Check the host answers',
          action: 'ansible.builtin.ping',
          node: NODE,
          msg: 'timed out',
          ts: 3,
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n')}\n`,
    );
    await queue.start(run.id, job?.token as string, new Date(), dir);
    const ok = (await (await call('GET', `/runs/${run.id}/hosts/${NODE}/fw-edge-01`)).json()) as {
      entries: { status: string; task: string; msg?: string }[];
    };
    expect(ok.entries).toEqual([
      expect.objectContaining({ task: '[ping] Check the host answers', status: 'ok' }),
    ]);
    const failed = (await (
      await call('GET', `/runs/${run.id}/hosts/${NODE}/fw-edge-02`)
    ).json()) as { entries: { status: string; task: string; msg?: string }[] };
    expect(failed.entries[0]).toMatchObject({ status: 'failed', msg: 'timed out' });
    expect(
      (
        (await (await call('GET', `/runs/${run.id}/hosts/${NODE}/nobody`)).json()) as {
          entries: unknown[];
        }
      ).entries,
    ).toEqual([]);
    await queue.finish(run.id, job?.token as string, 'failed', 'x');
  });

  it('runs a run again: same commit and inputs, a new number, by whoever asks', async () => {
    const run = await queue.enqueue(
      launchOf('flows/hello.flow.yaml', { devices: ['fw-edge-01'], api_password: 'S3CR3T' }),
      { devices: ['fw-edge-01'], api_password: '***' },
      { id: 'u', login: 'omar' },
    );
    await queue.cancel(run.id, 'dana');
    expect((await call('POST', `/runs/${run.id}/relaunch`)).status).toBe(403);
    const reply = await call('POST', `/runs/${run.id}/relaunch`, admin);
    expect(reply.status).toBe(201);
    const again = (await reply.json()) as { id: string };
    expect(again).toMatchObject({
      state: 'queued',
      commit: run.commit,
      flow: run.flow,
      inputs: { api_password: '***' },
      requestedBy: { login: 'dana' },
      number: run.number + 1,
    });
    expect(again.id).not.toBe(run.id);
    await queue.cancel(again.id, 'dana');
    // The worker gets the secret in full, sealed to the new run.
    const other = await queue.enqueue(launchOf(), {}, { id: 'u', login: 'dana' });
    await queue.cancel(other.id, 'dana');
    const relaunched = await queue.relaunch(run.id, { id: 'u', login: 'dana' });
    let job = await queue.claim('w2');
    while (job && job.run.id !== relaunched?.id) {
      await queue.finish(job.run.id, job.token, 'failed');
      job = await queue.claim('w2');
    }
    expect(job?.inputs).toEqual({ devices: ['fw-edge-01'], api_password: 'S3CR3T' });
    await queue.finish(job?.run.id as string, job?.token as string, 'failed');
    expect((await call('POST', '/runs/nothing/relaunch', admin)).status).toBe(404);
  });

  it('lists the runs of one flow', async () => {
    const other = await queue.enqueue(
      launchOf('flows/other.flow.yaml'),
      {},
      { id: 'u', login: 'dana' },
    );
    await queue.cancel(other.id, 'dana');
    const list = (await (
      await call(
        'GET',
        `/runs?project=${project}&flow=${encodeURIComponent('flows/other.flow.yaml')}`,
      )
    ).json()) as { id: string }[];
    expect(list.map((r: { id: string }) => r.id)).toEqual([other.id]);
  });
});

describe('keeping runs', () => {
  it('removes ended runs past their days, and beyond the newest of each flow; never one going', async () => {
    const db = database.db;
    await db.deleteFrom('run').execute();
    const now = new Date('2026-11-13T12:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    const make = async (flow: string, daysAgo: number, end = true) => {
      const run = await queue.enqueue(
        launchOf(flow),
        {},
        { id: 'u', login: 'dana' },
        undefined,
        new Date(now.getTime() - daysAgo * day),
      );
      if (end) await queue.cancel(run.id, 'dana');
      const dir = join(root, 'keep', run.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(outputFile(run.id), 'x');
      await db.updateTable('run').set({ run_dir: dir }).where('id', '=', run.id).execute();
      return run;
    };
    const old = await make('a.flow.yaml', 100);
    const going = await make('a.flow.yaml', 200, false);
    const a = [
      await make('a.flow.yaml', 3),
      await make('a.flow.yaml', 2),
      await make('a.flow.yaml', 1),
    ];
    const b = await make('b.flow.yaml', 1);

    expect(await pruneRuns(db, { days: 90, perFlow: 2 }, outputFile, now)).toBe(2);
    const left = (await queue.list({ limit: 200 })).map((r) => r.id).sort();
    expect(left).toEqual([going.id, a[1]?.id, a[2]?.id, b.id].sort());
    for (const gone of [old, a[0]]) {
      expect(existsSync(outputFile(gone?.id as string))).toBe(false);
      expect(existsSync(join(root, 'keep', gone?.id as string))).toBe(false);
    }
    expect(existsSync(outputFile(b.id))).toBe(true);
    expect(await pruneRuns(db, { days: 90, perFlow: 2 }, outputFile, now)).toBe(0);
  });
});
