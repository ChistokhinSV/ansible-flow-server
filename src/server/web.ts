// Serves the web application: the files Vite built (dist/web), and the same page for every
// address that is a page of the application, so a link to a project opens the project. The
// files are few and small: they are read once, at start.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * What a page of the application may load and do: its own files and its own server, nothing
 * else; nobody may put it in a frame.
 */
const POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/** Addresses that are the server's own, never a page: an unknown one is a JSON 404. */
const NOT_PAGES = /^\/(api|git|healthz|readyz)(\/|$)/;

interface WebFile {
  body: Buffer;
  type: string;
  etag: string;
  /** Its name carries a hash of its content: it never changes, a browser may keep it. */
  immutable: boolean;
}

export type WebHandler = (request: FastifyRequest, reply: FastifyReply) => FastifyReply | undefined;

/**
 * Reads the built application from `dir`. Gives a handler that answers a request when it is for
 * a file or a page of the application and gives undefined when it is not; or undefined when
 * there is no built application (a server run from source without `just build`).
 */
export function webHandler(dir: string): WebHandler | undefined {
  if (!existsSync(join(dir, 'index.html'))) return undefined;
  const files = new Map<string, WebFile>();
  const walk = (folder: string, prefix: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(folder, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) {
        const body = readFileSync(join(folder, entry.name));
        files.set(`${prefix}${entry.name}`, {
          body,
          type: TYPES[extname(entry.name).toLowerCase()] ?? 'application/octet-stream',
          etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`,
          immutable: prefix === '/assets/',
        });
      }
    }
  };
  walk(dir, '/');
  const index = files.get('/index.html') as WebFile;

  return (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;
    const path = request.url.split('?')[0] ?? '/';
    if (NOT_PAGES.test(path)) return undefined;
    // Only what was read at start is served: an address cannot name a file outside the folder.
    let file = files.get(path);
    if (!file) {
      // Something that looks like a file and is not there is missing, not a page.
      if (/\.[A-Za-z0-9]{1,12}$/.test(path)) return undefined;
      file = index;
    }
    reply
      .header('content-type', file.type)
      .header('etag', file.etag)
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'same-origin')
      .header('cache-control', file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (file === index || file.type.startsWith('text/html'))
      reply.header('content-security-policy', POLICY).header('x-frame-options', 'DENY');
    if (request.headers['if-none-match'] === file.etag) return reply.code(304).send();
    return reply.send(file.body);
  };
}
