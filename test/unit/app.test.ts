import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { instanceId } from '../../src/server/db/settings';
import { createLogger } from '../../src/server/log';

let database: Database;
let app: FastifyInstance;
let lines: string[];

beforeEach(async () => {
  lines = [];
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  app = buildApp({
    log: createLogger({ level: 'info', format: 'json', write: (line) => lines.push(line) }),
    database,
    instance: await instanceId(database.db),
  });
});
afterEach(async () => {
  await app.close();
  await database.close().catch(() => undefined);
});

describe('the HTTP server', () => {
  it('/healthz says the process is up', async () => {
    const reply = await app.inject({ method: 'GET', url: '/healthz' });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ status: 'ok' });
  });

  it('/readyz says the database answers, and 503 when it does not', async () => {
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready', database: 'sqlite' });

    await database.close();
    const down = await app.inject({ method: 'GET', url: '/readyz' });
    expect(down.statusCode).toBe(503);
    // The reason is in the log, not in the answer.
    expect(down.json()).toEqual({ status: 'unavailable', database: 'sqlite' });
    expect(lines.some((line) => line.includes('The database does not answer'))).toBe(true);
  });

  it('/api/v1/meta names the server, its versions and this installation', async () => {
    const reply = await app.inject({ method: 'GET', url: '/api/v1/meta' });
    expect(reply.statusCode).toBe(200);
    const meta = reply.json() as Record<string, unknown>;
    expect(meta).toMatchObject({ name: 'Ansible Flow Server', api: 'v1' });
    expect(meta.instance).toMatch(/^[0-9a-f-]{36}$/);
    expect(meta.designer).toMatchObject({ format: 2 });
  });

  it('an address with nothing at it is a 404 in JSON, without the query', async () => {
    const reply = await app.inject({ method: 'GET', url: '/nothing/here?token=abc' });
    expect(reply.statusCode).toBe(404);
    expect(reply.json()).toEqual({ error: 'not_found', message: 'Nothing at /nothing/here' });
  });

  it('a failure inside is a 500 that says nothing of what failed', async () => {
    app.get('/boom', async () => {
      throw new Error('secret detail: /var/lib/flows/afs.db is locked');
    });
    const reply = await app.inject({ method: 'GET', url: '/boom' });
    expect(reply.statusCode).toBe(500);
    const body = reply.json() as Record<string, unknown>;
    expect(body).toMatchObject({ error: 'internal', message: 'The server could not do this' });
    expect(JSON.stringify(body)).not.toContain('afs.db');
    // The log has it, with the request it belongs to.
    expect(lines.some((line) => line.includes('afs.db is locked'))).toBe(true);
    expect(typeof body.request).toBe('string');
  });

  it('a request that is wrong is a 4xx with its reason', async () => {
    app.post('/echo', async (request) => request.body);
    const reply = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.json()).toHaveProperty('message');
  });

  it('logs each request with its method, path and status, and no query or headers', async () => {
    await app.inject({
      method: 'GET',
      url: '/healthz?token=abc',
      headers: { authorization: 'Bearer abc' },
    });
    const done = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.res);
    expect(done).toMatchObject({ res: { status: 200 } });
    const all = lines.join('\n');
    expect(all).toContain('"/healthz"');
    expect(all).not.toContain('token=abc');
    expect(all).not.toContain('Bearer abc');
  });

  it('a request in flight finishes before the server closes', async () => {
    let entered: () => void = () => undefined;
    const inHandler = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish: () => void = () => undefined;
    app.get('/slow', async () => {
      entered();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { done: true };
    });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const pending = fetch(`${url}/slow`);
    await inHandler;
    // The server is asked to close while the request is being answered.
    const closed = app.close();
    let isClosed = false;
    void closed.then(() => {
      isClosed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isClosed).toBe(false);
    finish();
    const reply = await pending;
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ done: true });
    await closed;
    expect(isClosed).toBe(true);
  });
});
