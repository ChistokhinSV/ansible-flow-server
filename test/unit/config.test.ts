import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, publicHost, withoutPassword } from '../../src/server/config';

describe('loadConfig', () => {
  it('with nothing set: this machine only, HTTPS on port 8443, SQLite in the data folder', () => {
    const config = loadConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8443);
    expect(config.tls).toBe('on');
    expect(config.trustedProxies).toEqual([]);
    expect(isAbsolute(config.dataDir)).toBe(true);
    expect(config.database).toEqual({ kind: 'sqlite', file: join(config.dataDir, 'afs.db') });
    expect(config.log).toEqual({ level: 'info', format: 'text' });
  });

  it('reads the address, the data folder, the database and the log settings', () => {
    const config = loadConfig({
      AFS_HOST: '0.0.0.0',
      AFS_PORT: '9443',
      AFS_DATA_DIR: 'var/flows',
      AFS_DATABASE_URL: 'postgres://flows:s3cret@db.example.net:5432/flows',
      AFS_LOG_LEVEL: 'DEBUG',
      AFS_LOG_FORMAT: 'json',
    });
    expect(config).toMatchObject({
      host: '0.0.0.0',
      port: 9443,
      dataDir: resolve('var/flows'),
      database: { kind: 'postgres', url: 'postgres://flows:s3cret@db.example.net:5432/flows' },
      log: { level: 'debug', format: 'json' },
    });
  });

  it('a SQLite file is taken as given, or inside the data folder', () => {
    const inside = loadConfig({ AFS_DATA_DIR: 'var', AFS_DATABASE_URL: 'sqlite:flows.db' });
    expect(inside.database).toEqual({ kind: 'sqlite', file: resolve('var', 'flows.db') });
    const given = loadConfig({ AFS_DATABASE_URL: `sqlite:${resolve('elsewhere', 'a.db')}` });
    expect(given.database).toEqual({ kind: 'sqlite', file: resolve('elsewhere', 'a.db') });
  });

  it('names every problem at once, and never the database password', () => {
    let error: unknown;
    try {
      loadConfig({
        AFS_PORT: '80a',
        AFS_DATABASE_URL: 'mysql://flows:s3cret@db.example.net/flows',
        AFS_LOG_LEVEL: 'loud',
        AFS_LOG_FORMAT: 'xml',
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const { problems, message } = error as ConfigError;
    expect(problems).toHaveLength(4);
    expect(message).toContain('AFS_PORT');
    expect(message).toContain('AFS_LOG_LEVEL');
    expect(message).toContain('AFS_LOG_FORMAT');
    expect(message).toContain('AFS_DATABASE_URL');
    expect(message).not.toContain('s3cret');
  });

  it('a port out of range is a problem', () => {
    expect(() => loadConfig({ AFS_PORT: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ AFS_PORT: '70000' })).toThrow(ConfigError);
  });
});

describe('the HTTPS settings', () => {
  it('HTTPS is on unless turned off; the default port follows', () => {
    expect(loadConfig({})).toMatchObject({ tls: 'on', port: 8443 });
    expect(loadConfig({ AFS_TLS: 'off' })).toMatchObject({ tls: 'off', port: 8080 });
    expect(loadConfig({ AFS_TLS: 'off', AFS_PORT: '9000' }).port).toBe(9000);
  });

  it('reads the public address, the redirect port and the authorities file', () => {
    const config = loadConfig({
      AFS_PUBLIC_URL: 'https://flows.example.net/',
      AFS_HTTP_PORT: '8080',
      AFS_CA_FILE: 'certs/internal-ca.pem',
    });
    expect(config.publicUrl).toBe('https://flows.example.net');
    expect(publicHost(config)).toBe('flows.example.net');
    expect(config.httpPort).toBe(8080);
    expect(config.caFile).toBe(resolve('certs/internal-ca.pem'));
    expect(publicHost(loadConfig({}))).toBeUndefined();
  });

  it('a repository on this machine is allowed only when asked', () => {
    expect(loadConfig({}).gitLocal).toBe(false);
    expect(loadConfig({ AFS_GIT_LOCAL: 'on' }).gitLocal).toBe(true);
    expect(() => loadConfig({ AFS_GIT_LOCAL: 'yes' })).toThrow(ConfigError);
  });

  it('behind a proxy: the proxies whose word is taken', () => {
    const config = loadConfig({ AFS_TLS: 'off', AFS_TRUSTED_PROXIES: '127.0.0.1, 10.0.0.0/8' });
    expect(config.trustedProxies).toEqual(['127.0.0.1', '10.0.0.0/8']);
  });

  it('names what does not fit together', () => {
    const problems = (env: Record<string, string>) => {
      try {
        loadConfig(env);
        return [];
      } catch (e) {
        return (e as ConfigError).problems;
      }
    };
    expect(problems({ AFS_TLS: 'maybe' })).toHaveLength(1);
    expect(problems({ AFS_PUBLIC_URL: 'http://flows.example.net' }).join(' ')).toMatch(
      /speaks HTTPS/,
    );
    expect(problems({ AFS_PUBLIC_URL: 'flows.example.net' }).join(' ')).toMatch(/AFS_PUBLIC_URL/);
    expect(problems({ AFS_PUBLIC_URL: 'https://user:pw@flows.example.net' })).toHaveLength(1);
    expect(problems({ AFS_TLS: 'off', AFS_HTTP_PORT: '8081' }).join(' ')).toMatch(
      /no use with AFS_TLS=off/,
    );
    expect(problems({ AFS_PORT: '8443', AFS_HTTP_PORT: '8443' }).join(' ')).toMatch(/same port/);
    expect(problems({ AFS_TRUSTED_PROXIES: '10.0.0.1' }).join(' ')).toMatch(/AFS_TLS=off/);
    expect(
      problems({ AFS_TLS: 'off', AFS_TRUSTED_PROXIES: 'proxy.example.net' }).join(' '),
    ).toMatch(/addresses or networks/);
  });
});

describe('withoutPassword', () => {
  it('keeps the address and hides the password', () => {
    expect(withoutPassword('postgres://flows:s3cret@db.example.net:5432/flows')).toBe(
      'postgres://flows:***@db.example.net:5432/flows',
    );
    expect(withoutPassword('postgres://flows@db.example.net/flows')).toBe(
      'postgres://flows@db.example.net/flows',
    );
    expect(withoutPassword('not a url')).not.toContain('not a url');
  });
});
