// Serving the web application: its files, the one page behind every address of the
// application, and what stays the server's own.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';

const root = mkdtempSync(join(tmpdir(), 'afs-web-'));
const web = join(root, 'web');
let database: Database;
let app: FastifyInstance;
let bare: FastifyInstance;
const lines: string[] = [];

beforeAll(async () => {
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Ansible Flow Server</title>');
  writeFileSync(join(web, 'assets', 'index-AbC123.js'), 'console.log("app")');
  writeFileSync(join(web, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(web, 'viewer.html'), '<!doctype html><title>Flow</title>');
  // A file beside the folder: nothing may reach it.
  writeFileSync(join(root, 'secret.txt'), 'not for anyone');
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  const log = createLogger({ level: 'warn', format: 'json', write: (l) => lines.push(l) });
  app = buildApp({ log, database, instance: 'test', webDir: web });
  bare = buildApp({ log, database, instance: 'test', webDir: join(root, 'not-built') });
});
afterAll(async () => {
  await app.close();
  await bare.close();
  await database.close();
  rmSync(root, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });

describe('the web application', () => {
  it('is the page at every address of the application, never kept by a browser', async () => {
    for (const url of [
      '/',
      '/w/network',
      '/w/network/edge?tab=runs',
      '/account',
      '/no/such/page',
      // A flow's page is named by its file: it ends like a file and is a page all the same.
      '/w/network/edge/flow/flows/os-upgrade.flow.yaml',
    ]) {
      const reply = await get(url);
      expect(reply.statusCode, url).toBe(200);
      expect(reply.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(reply.headers['cache-control']).toBe('no-cache');
      expect(reply.body).toContain('<title>Ansible Flow Server</title>');
    }
    expect((await app.inject({ method: 'HEAD', url: '/' })).statusCode).toBe(200);
  });

  it("may load and do only what is its own, and is in nobody else's frame", async () => {
    const reply = await get('/');
    const policy = String(reply.headers['content-security-policy']);
    for (const rule of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ])
      expect(policy).toContain(rule);
    expect(policy).not.toContain('unsafe');
    expect(reply.headers['x-frame-options']).toBe('DENY');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
  });

  it("the designer's page may be framed by this server's pages, and by nobody else", async () => {
    const reply = await get('/viewer.html?project=p1&path=hello.flow.yaml');
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toContain('<title>Flow</title>');
    const policy = String(reply.headers['content-security-policy']);
    expect(policy).toContain("frame-ancestors 'self'");
    expect(policy).toContain("font-src 'self' data:");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain('unsafe');
    expect(reply.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(reply.headers['cache-control']).toBe('no-cache');
  });

  it('serves its files with their types; those named by their content are kept for good', async () => {
    const script = await get('/assets/index-AbC123.js');
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const icon = await get('/favicon.svg');
    expect(icon.headers['content-type']).toBe('image/svg+xml');
    expect(icon.headers['cache-control']).toBe('no-cache');
    // Asked again with what it has, a browser is told it is still good.
    const again = await get('/favicon.svg', { 'if-none-match': String(icon.headers.etag) });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  });

  it('a file that is not there is missing, not the page; nothing outside the folder is reached', async () => {
    for (const url of [
      '/assets/missing.js',
      '/secret.txt',
      '/../secret.txt',
      '/assets/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
    ]) {
      const reply = await get(url);
      expect(reply.body, url).not.toContain('not for anyone');
      expect([200, 400, 404], url).toContain(reply.statusCode);
      if (reply.statusCode === 200) expect(reply.body, url).toContain('<title>');
    }
    expect((await get('/assets/missing.js')).statusCode).toBe(404);
  });

  it("leaves the server's own addresses alone", async () => {
    for (const url of ['/api/v1/nothing', '/api', '/git/network/edge.git/HEAD', '/healthz/x']) {
      const reply = await get(url);
      expect(reply.statusCode, url).toBe(404);
      expect(reply.json().error, url).toBe('not_found');
    }
    expect((await get('/healthz')).json()).toEqual({ status: 'ok' });
    expect((await get('/api/v1/meta')).statusCode).toBe(200);
    // Only reading gets the page: anything else at a page's address is nothing.
    const post = await app.inject({ method: 'POST', url: '/w/network' });
    expect(post.statusCode).toBe(404);
    expect(post.json().error).toBe('not_found');
  });

  it('a server without the built application says so once and has no pages', async () => {
    const reply = await bare.inject({ method: 'GET', url: '/' });
    expect(reply.statusCode).toBe(404);
    expect(reply.json().error).toBe('not_found');
    expect(lines.filter((l) => l.includes('No built web application'))).toHaveLength(1);
  });
});
