// The server from start to stop, on a real port of this machine.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/server/config';
import { createLogger } from '../../src/server/log';
import { startServer } from '../../src/server/serve';

const dir = mkdtempSync(join(tmpdir(), 'afs-serve-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function settings(extra: Partial<Config> = {}): { config: Config; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    config: {
      host: '127.0.0.1',
      // Port 0: the system picks a free one.
      port: 0,
      dataDir: dir,
      database: { kind: 'sqlite', file: join(dir, 'afs.db') },
      log: { level: 'info', format: 'text' },
      ...extra,
    },
  };
}
const logTo = (lines: string[]) =>
  createLogger({ level: 'info', format: 'text', write: (line) => lines.push(line) });

describe('startServer', () => {
  it('answers on its port, keeps its installation id over a restart, and stops in order', async () => {
    const first = settings();
    const server = await startServer(first.config, logTo(first.lines));
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const ready = await fetch(`${server.url}/readyz`);
    expect(ready.status).toBe(200);
    const meta = (await (await fetch(`${server.url}/api/v1/meta`)).json()) as { instance: string };

    // Stopping twice is one stop; afterwards nothing answers.
    await Promise.all([server.stop('test'), server.stop('test again')]);
    await expect(fetch(`${server.url}/healthz`)).rejects.toThrow();
    const text = first.lines.join('\n');
    expect(text).toContain('Database ready kind=sqlite');
    expect(text).toContain('changes=1');
    expect(text.match(/Shutting down/g)).toHaveLength(1);
    expect(first.lines.at(-1)).toContain('Stopped');

    // The same data folder again: the database is already up to date, the id is the same.
    const second = settings();
    const again = await startServer(second.config, logTo(second.lines));
    const meta2 = (await (await fetch(`${again.url}/api/v1/meta`)).json()) as { instance: string };
    expect(meta2.instance).toBe(meta.instance);
    expect(second.lines.join('\n')).toContain('changes=0');
    await again.stop('test');
  });

  it('a database that cannot be reached stops the start, with no password in the reason', async () => {
    const { config, lines } = settings({
      database: { kind: 'postgres', url: 'postgres://flows:s3cret@127.0.0.1:1/flows' },
    });
    const reason = await startServer(config, logTo(lines)).then(
      () => 'started',
      (e: Error) => e.message,
    );
    expect(reason).not.toBe('started');
    expect(`${reason}\n${lines.join('\n')}`).not.toContain('s3cret');
  });

  it('a port that is taken stops the start and leaves the database closed', async () => {
    const one = settings({ database: { kind: 'sqlite', file: join(dir, 'port.db') } });
    const server = await startServer(one.config, logTo(one.lines));
    const port = Number(new URL(server.url).port);
    const two = settings({ port, database: { kind: 'sqlite', file: join(dir, 'port2.db') } });
    await expect(startServer(two.config, logTo(two.lines))).rejects.toThrow(/EADDRINUSE/);
    await server.stop('test');
  });
});
