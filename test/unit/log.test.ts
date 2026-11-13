import { describe, expect, it } from 'vitest';
import { createLogger, HIDDEN, stampOf } from '../../src/server/log';

function capture(format: 'text' | 'json', level: 'debug' | 'info' | 'warn' = 'info') {
  const lines: string[] = [];
  const log = createLogger({
    level,
    format,
    write: (line) => lines.push(line),
    // Local time, as the log shows it.
    now: () => new Date(2026, 10, 13, 9, 44, 37),
  });
  return { log, lines };
}

describe('the log, as text', () => {
  it('a line is [HH:MM:SS dd.mm.yyyy], the level, the message and its fields', () => {
    const { log, lines } = capture('text');
    log.info({ host: '127.0.0.1', port: 8080 }, 'Listening');
    expect(lines).toEqual(['[09:44:37 13.11.2026] INFO  Listening host=127.0.0.1 port=8080']);
  });

  it('pads the time and quotes a value with spaces', () => {
    expect(stampOf(new Date(2026, 0, 5, 7, 3, 9))).toBe('[07:03:09 05.01.2026]');
    const { log, lines } = capture('text');
    log.warn({ why: 'no route to host' }, 'Sync failed');
    expect(lines[0]).toBe('[09:44:37 13.11.2026] WARN  Sync failed why="no route to host"');
  });

  it('leaves out what is below its level', () => {
    const { log, lines } = capture('text', 'warn');
    log.info('quiet');
    log.debug('quieter');
    log.error('loud');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ERROR loud');
  });

  it('never writes a value whose name looks secret, at any depth', () => {
    const { log, lines } = capture('text');
    log.info(
      {
        user: 'dana',
        password: 'hunter2',
        api_token: 'tok-123',
        headers: { authorization: 'Bearer abc', cookie: 'sid=1', accept: 'text/html' },
      },
      'Sign-in',
    );
    const line = lines[0] ?? '';
    for (const secret of ['hunter2', 'tok-123', 'Bearer abc', 'sid=1']) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain('user=dana');
    expect(line).toContain(`password=${HIDDEN}`);
    expect(line).toContain('headers.accept=text/html');
  });

  it('a request is its method and path, a reply its status, an error its message', () => {
    const { log, lines } = capture('text');
    log.info(
      {
        req: {
          method: 'GET',
          url: '/api/v1/meta?token=abc',
          ip: '10.0.0.7',
          headers: { cookie: 'x' },
        },
        res: { statusCode: 200, raw: {} },
        responseTime: 1.5,
      },
      'request completed',
    );
    expect(lines[0]).toBe(
      '[09:44:37 13.11.2026] INFO  request completed req.method=GET req.url=/api/v1/meta req.from=10.0.0.7 res.status=200 responseTime=1.5',
    );
    log.error(new Error('connection refused'), 'The database does not answer');
    expect(lines[1]).toContain('The database does not answer err.message="connection refused"');
  });

  it('a child carries its fields on every line', () => {
    const { log, lines } = capture('text');
    const child = log.child({ reqId: 'req-7' });
    child.info('incoming request');
    expect(lines[0]).toBe('[09:44:37 13.11.2026] INFO  incoming request reqId=req-7');
  });
});

describe('the log, as JSON', () => {
  it('a line is one object with the time, the level, the message and the fields', () => {
    const { log, lines } = capture('json');
    log.info({ port: 8080, secret: 'x' }, 'Listening');
    const line = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'info', msg: 'Listening', port: 8080, secret: HIDDEN });
    expect(typeof line.time).toBe('string');
  });
});
