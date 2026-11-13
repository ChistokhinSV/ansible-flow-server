// The server over HTTPS: its first certificate, a replacement served without a restart, the
// plain HTTP port that redirects, and plain HTTP behind a proxy.
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/server/config';
import { createLogger } from '../../src/server/log';
import {
  certificateStore,
  type RunningServer,
  selfSignedNames,
  startServer,
} from '../../src/server/serve';
import { selfSignedCertificate } from '../../src/server/tls/certificates';
import { testAuthority } from './helpers/ca';

const root = mkdtempSync(join(tmpdir(), 'afs-https-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
let running: RunningServer | undefined;
afterEach(async () => {
  await running?.stop('test');
  running = undefined;
});

function settings(extra: Partial<Config> = {}): { config: Config; lines: string[] } {
  const dataDir = join(root, `case-${++n}`);
  return {
    lines: [],
    config: {
      host: '127.0.0.1',
      port: 0,
      tls: 'on',
      trustedProxies: [],
      gitLocal: false,
      dataDir,
      database: { kind: 'sqlite', file: join(dataDir, 'afs.db') },
      log: { level: 'info', format: 'text' },
      ...extra,
    },
  };
}
const logTo = (lines: string[]) =>
  createLogger({ level: 'info', format: 'text', write: (line) => lines.push(line) });

/** GET over HTTPS, trusting only `ca`; resolves with the status and the body. */
function get(url: string, ca: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { ca, agent: false }, (reply) => {
      let body = '';
      reply.on('data', (chunk) => {
        body += chunk;
      });
      reply.on('end', () => resolve({ status: reply.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

/** GET over HTTPS without checking the certificate; for an answer's content only. */
function fetchInsecure(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { rejectUnauthorized: false, agent: false }, (reply) => {
      let body = '';
      reply.on('data', (chunk) => {
        body += chunk;
      });
      reply.on('end', () => resolve({ status: reply.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

/** The fingerprint of the certificate a new connection is given. */
function served(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(url);
    const socket = connect(
      { host: hostname, port: Number(port), rejectUnauthorized: false },
      () => {
        const fingerprint = socket.getPeerCertificate().fingerprint256;
        socket.end();
        resolve(fingerprint);
      },
    );
    socket.on('error', reject);
  });
}

/**
 * Some antivirus products answer TLS connections themselves, also on this machine's own
 * addresses, and show the client a certificate they made (Norton's Web/Mail Shield does). A
 * client then never sees the server's certificate. Where that happens, the tests check what can
 * still be seen: that what a client is given changes when the server's certificate does.
 */
let intercepted: boolean | undefined;
async function isIntercepted(url: string, ours: string | undefined): Promise<boolean> {
  intercepted ??= (await served(url)) !== ours;
  return intercepted;
}

describe('the server over HTTPS', () => {
  it('makes its own certificate at first start and answers with it', async () => {
    const { config, lines } = settings();
    running = await startServer(config, logTo(lines));
    expect(running.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    const info = running.certificate?.();
    expect(info?.selfSigned).toBe(true);
    expect(info?.names).toEqual(expect.arrayContaining(['127.0.0.1', 'localhost']));

    // A client that trusts exactly this certificate gets an answer; one that does not is refused.
    const stranger = await selfSignedCertificate(['127.0.0.1']);
    await expect(get(`${running.url}/readyz`, stranger.certificate)).rejects.toThrow();
    if (await isIntercepted(running.url, info?.fingerprint)) {
      // The answer itself, through whatever stands in between.
      const reply = await fetchInsecure(`${running.url}/readyz`);
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body)).toEqual({ status: 'ready', database: 'sqlite' });
    } else {
      const own = certificateStore(config).current()?.certificate ?? '';
      const reply = await get(`${running.url}/readyz`, own);
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body)).toEqual({ status: 'ready', database: 'sqlite' });
    }

    const text = lines.join('\n');
    expect(text).toContain('Server certificate subject="CN=127.0.0.1"');
    expect(text).toContain('source=self-signed');
    expect(text).not.toContain('PRIVATE KEY');
  });

  it('keeps its certificate over a restart', async () => {
    const { config, lines } = settings();
    running = await startServer(config, logTo(lines));
    const first = running.certificate?.().fingerprint;
    await running.stop('test');
    running = await startServer(config, logTo(lines));
    expect(running.certificate?.().fingerprint).toBe(first);
  });

  it('serves a replaced certificate to new connections without a restart, and goes back', async () => {
    const { config, lines } = settings({ publicUrl: 'https://127.0.0.1' });
    running = await startServer(config, logTo(lines));
    const before = await served(running.url);
    const direct = !(await isIntercepted(running.url, running.certificate?.().fingerprint));
    if (direct) expect(before).toBe(running.certificate?.().fingerprint);

    // An administrator has a request signed and installs the answer (the cert commands do this).
    const store = certificateStore(config);
    const authority = await testAuthority();
    const request = await store.request({ names: ['127.0.0.1'] }, { by: 'test' });
    const installed = store.install((await authority.sign(request)) + authority.certificate, {
      host: '127.0.0.1',
      by: 'test',
    });
    expect(running.reloadCertificate?.()).toBe(true);
    expect(running.certificate?.().fingerprint).toBe(installed.info.fingerprint);
    const after = await served(running.url);
    expect(after).not.toBe(before);
    if (direct) {
      expect(after).toBe(installed.info.fingerprint);
      // Now a client that trusts the authority gets an answer.
      expect((await get(`${running.url}/healthz`, authority.certificate)).status).toBe(200);
    }
    // Nothing new in the store: nothing to reload.
    expect(running.reloadCertificate?.()).toBe(false);

    const first = store.rollback({ by: 'test' });
    expect(running.reloadCertificate?.()).toBe(true);
    expect(running.certificate?.().fingerprint).toBe(first.info.fingerprint);
    const back = await served(running.url);
    expect(back).not.toBe(after);
    if (direct) expect(back).toBe(before);
    expect(lines.filter((l) => l.includes('Server certificate replaced'))).toHaveLength(2);
  });

  it('notices a change made in the store by another process', async () => {
    const { config, lines } = settings();
    running = await startServer(config, logTo(lines));
    const before = await served(running.url);
    await certificateStore(config).selfSigned(selfSignedNames(config), { by: 'test' });
    // The folder is watched: within a moment new connections get the new certificate.
    let now = before;
    for (let i = 0; i < 40 && now === before; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      now = await served(running.url);
    }
    expect(now).not.toBe(before);
  });

  it('warns about a certificate close to its end', async () => {
    const { config, lines } = settings();
    const store = certificateStore(config);
    const authority = await testAuthority();
    const request = await store.request({ names: ['127.0.0.1'] }, { by: 'test' });
    store.install(await authority.sign(request, { to: new Date(Date.now() + 5 * 864e5) }), {
      by: 'test',
    });
    running = await startServer(config, logTo(lines));
    expect(lines.join('\n')).toMatch(/WARN\s+The server certificate expires soon .*days=4/);
  });
});

describe('plain HTTP beside HTTPS', () => {
  const plain = (url: string, host?: string) =>
    new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
      const request = httpRequest(
        url,
        { agent: false, ...(host ? { headers: { host } } : {}) },
        (reply) => {
          let body = '';
          reply.on('data', (chunk) => {
            body += chunk;
          });
          reply.on('end', () =>
            resolve({ status: reply.statusCode ?? 0, location: reply.headers.location, body }),
          );
        },
      );
      request.on('error', reject);
      request.end();
    });

  it('redirects every request to HTTPS, at the address the settings name', async () => {
    const free = settings();
    // A port for the redirect: taken from the system by a server that is then stopped.
    const probe = await startServer({ ...free.config, tls: 'off' }, logTo([]));
    const httpPort = Number(new URL(probe.url).port);
    await probe.stop('test');

    const { config, lines } = settings({ httpPort, publicUrl: 'https://flows.example.net' });
    running = await startServer(config, logTo(lines));
    expect(running.redirectUrl).toBe(`http://127.0.0.1:${httpPort}`);
    const reply = await plain(`${running.redirectUrl}/api/v1/meta?x=1`);
    expect(reply.status).toBe(308);
    expect(reply.location).toBe('https://flows.example.net/api/v1/meta?x=1');
    // This machine may ask whether the process is up without a certificate to trust.
    const health = await plain(`${running.redirectUrl}/healthz`);
    expect(health.status).toBe(200);
  });

  it('without a public address, redirects to the host asked for, and never to a made-up one', async () => {
    const free = settings();
    const probe = await startServer({ ...free.config, tls: 'off' }, logTo([]));
    const httpPort = Number(new URL(probe.url).port);
    await probe.stop('test');

    const { config, lines } = settings({ httpPort });
    running = await startServer(config, logTo(lines));
    const httpsPort = new URL(running.url).port;
    const reply = await plain(`${running.redirectUrl}/x`, `flows.example.net:${httpPort}`);
    expect(reply.location).toBe(`https://flows.example.net:${httpsPort}/x`);
    const odd = await plain(`${running.redirectUrl}/x`, 'evil.example/path?');
    expect(odd.status).toBe(400);
    expect(odd.location).toBeUndefined();
  });
});

describe('plain HTTP behind a proxy (AFS_TLS=off)', () => {
  it('makes no certificate and answers over HTTP', async () => {
    const { config, lines } = settings({ tls: 'off', trustedProxies: ['127.0.0.1'] });
    running = await startServer(config, logTo(lines));
    expect(running.url).toMatch(/^http:\/\//);
    expect(running.certificate).toBeUndefined();
    expect(certificateStore(config).current()).toBeUndefined();
    expect((await fetch(`${running.url}/healthz`)).status).toBe(200);
  });

  it("takes a trusted proxy's word for who asked", async () => {
    const { config, lines } = settings({ tls: 'off', trustedProxies: ['127.0.0.1'] });
    running = await startServer(config, logTo(lines));
    await fetch(`${running.url}/healthz`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(lines.join('\n')).toContain('req.from=203.0.113.9');

    await running.stop('test');
    const alone = settings({ tls: 'off' });
    running = await startServer(alone.config, logTo(alone.lines));
    await fetch(`${running.url}/healthz`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(alone.lines.join('\n')).toContain('req.from=127.0.0.1');
    expect(alone.lines.join('\n')).not.toContain('203.0.113.9');
  });
});
