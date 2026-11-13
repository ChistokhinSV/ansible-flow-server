// The server's certificate: made, requested, checked, installed, taken back.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/server/config';
import {
  certificateProblems,
  certificateRequest,
  describeCertificate,
  selfSignedCertificate,
} from '../../src/server/tls/certificates';
import { certCommand } from '../../src/server/tls/cli';
import { CertificateRefused, CertificateStore } from '../../src/server/tls/store';
import { testAuthority } from './helpers/ca';

const root = mkdtempSync(join(tmpdir(), 'afs-tls-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dir: string;
let n = 0;
beforeEach(() => {
  dir = join(root, `case-${++n}`);
});
const BY = { by: 'test' };

describe('a self-signed certificate', () => {
  it('is for the names given, lasts a year, and loads with its key', async () => {
    const pair = await selfSignedCertificate(['flows.example.net', '10.0.0.7', 'localhost']);
    const info = describeCertificate(pair.certificate);
    expect(info.subject).toBe('CN=flows.example.net');
    expect(info.names).toEqual(['flows.example.net', '10.0.0.7', 'localhost']);
    expect(info.selfSigned).toBe(true);
    expect(info.daysLeft).toBeGreaterThanOrEqual(364);
    expect(info.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(certificateProblems(pair)).toEqual([]);
    expect(certificateProblems(pair, { host: 'flows.example.net' })).toEqual([]);
    expect(certificateProblems(pair, { host: '10.0.0.7' })).toEqual([]);
  });
});

describe('the checks before a certificate is used', () => {
  it("a key that is not the certificate's", async () => {
    const one = await selfSignedCertificate(['a.example.net']);
    const other = await selfSignedCertificate(['a.example.net']);
    expect(certificateProblems({ certificate: one.certificate, key: other.key })).toEqual([
      'The private key does not belong to this certificate',
    ]);
  });

  it('a certificate that expired, or is not valid yet', async () => {
    const authority = await testAuthority();
    const { request, key } = await certificateRequest({ names: ['flows.example.net'] });
    const expired = await authority.sign(request, {
      from: new Date(Date.now() - 20 * 864e5),
      to: new Date(Date.now() - 864e5),
    });
    expect(certificateProblems({ certificate: expired, key }).join(' ')).toMatch(/expired on/);
    const early = await authority.sign(request, { from: new Date(Date.now() + 864e5) });
    expect(certificateProblems({ certificate: early, key }).join(' ')).toMatch(/not valid before/);
  });

  it('a certificate for another name than the one people use', async () => {
    const pair = await selfSignedCertificate(['old.example.net']);
    expect(certificateProblems(pair, { host: 'flows.example.net' })).toEqual([
      'The certificate is not for flows.example.net: it is for old.example.net',
    ]);
  });

  it('a chain in the wrong order, and one in the right order', async () => {
    const rootCa = await testAuthority();
    const issuing = await rootCa.intermediate('Test Issuing CA');
    const other = await testAuthority('Another CA');
    const { request, key } = await certificateRequest({ names: ['flows.example.net'] });
    const leaf = await issuing.sign(request);
    expect(
      certificateProblems({ certificate: leaf + issuing.certificate + rootCa.certificate, key }),
    ).toEqual([]);
    expect(describeCertificate(leaf + issuing.certificate + rootCa.certificate).chain).toBe(2);
    const wrong = certificateProblems({
      certificate: leaf + rootCa.certificate + issuing.certificate,
      key,
    });
    expect(wrong.join(' ')).toMatch(/chain is out of order or incomplete: certificate 2/);
    expect(certificateProblems({ certificate: leaf + other.certificate, key }).join(' ')).toMatch(
      /chain is out of order/,
    );
  });

  it("an authority's certificate, text that is no certificate, a key that is no key", async () => {
    const authority = await testAuthority();
    const pair = await selfSignedCertificate(['a.example.net']);
    expect(
      certificateProblems({ certificate: authority.certificate, key: pair.key }).join(' '),
    ).toMatch(/certificate of an authority/);
    expect(certificateProblems({ certificate: 'hello', key: pair.key })).toEqual([
      'The certificate is not PEM text: no BEGIN CERTIFICATE block',
    ]);
    expect(certificateProblems({ certificate: pair.certificate, key: 'hello' }).join(' ')).toMatch(
      /private key cannot be read/,
    );
  });
});

describe('the certificate store', () => {
  it('makes a self-signed certificate once and keeps it', async () => {
    const store = new CertificateStore(dir);
    expect(store.current()).toBeUndefined();
    const first = await store.ensure(['localhost'], BY);
    expect(first.source).toBe('self-signed');
    const again = await store.ensure(['other.example.net'], BY);
    expect(again.info.fingerprint).toBe(first.info.fingerprint);
    expect(store.history().map((h) => h.action)).toEqual(['self-signed']);
  });

  it('a request is answered by the signed certificate; the key never left the folder', async () => {
    const store = new CertificateStore(dir);
    const start = await store.ensure(['localhost'], BY);
    const request = await store.request(
      { names: ['flows.example.net', 'flows'], organization: 'Example, Inc.' },
      BY,
    );
    expect(request).toContain('BEGIN CERTIFICATE REQUEST');
    expect(request).not.toContain('PRIVATE KEY');
    expect(store.pendingRequest()).toBe(request);
    // Until it is answered, the certificate in use stays.
    expect(store.current()?.info.fingerprint).toBe(start.info.fingerprint);

    const authority = await testAuthority();
    const signed = await authority.sign(request);
    const installed = store.install(signed + authority.certificate, {
      host: 'flows.example.net',
      ...BY,
    });
    expect(installed.source).toBe('installed');
    expect(installed.info.subject).toBe('CN=flows.example.net, O=Example\\, Inc.');
    expect(installed.info.names).toEqual(['flows.example.net', 'flows']);
    expect(installed.info.selfSigned).toBe(false);
    expect(installed.info.issuer).toBe('CN=Test Root CA');
    expect(installed.info.chain).toBe(1);
    expect(store.pendingRequest()).toBeUndefined();
    expect(store.previous()?.fingerprint).toBe(start.info.fingerprint);
    expect(store.current()?.info.fingerprint).toBe(installed.info.fingerprint);
  });

  it('a renewal for the key in use needs no key and no request', async () => {
    const store = new CertificateStore(dir);
    const request = await store.request({ names: ['flows.example.net'] }, BY);
    const authority = await testAuthority();
    const first = store.install(await authority.sign(request), BY);
    const renewed = store.install(await authority.sign(request), BY);
    expect(renewed.info.fingerprint).not.toBe(first.info.fingerprint);
    expect(renewed.key).toBe(first.key);
  });

  it('a certificate and its key given together replace the pair', async () => {
    const store = new CertificateStore(dir);
    await store.ensure(['localhost'], BY);
    const pair = await selfSignedCertificate(['flows.example.net']);
    const installed = store.install(pair.certificate, { key: pair.key, ...BY });
    expect(installed.info.subject).toBe('CN=flows.example.net');
  });

  it('refuses with every reason and changes nothing', async () => {
    const store = new CertificateStore(dir);
    const start = await store.ensure(['localhost'], BY);
    const stranger = await selfSignedCertificate(['old.example.net']);
    let refused: CertificateRefused | undefined;
    try {
      store.install(stranger.certificate, { host: 'flows.example.net', ...BY });
    } catch (e) {
      refused = e as CertificateRefused;
    }
    expect(refused).toBeInstanceOf(CertificateRefused);
    expect(refused?.problems).toEqual([
      'The certificate is for neither the waiting request nor the key in use: give its key',
      'The certificate is not for flows.example.net: it is for old.example.net',
    ]);
    expect(store.current()?.info.fingerprint).toBe(start.info.fingerprint);
    expect(store.previous()).toBeUndefined();
    expect(store.history().map((h) => h.action)).toEqual(['self-signed']);
  });

  it('goes back to the certificate before, and forward again', async () => {
    const store = new CertificateStore(dir);
    const first = await store.ensure(['localhost'], BY);
    const second = await store.selfSigned(['flows.example.net'], BY);
    const back = store.rollback(BY);
    expect(back.info.fingerprint).toBe(first.info.fingerprint);
    expect(back.source).toBe('self-signed');
    expect(store.rollback(BY).info.fingerprint).toBe(second.info.fingerprint);
    expect(store.history().map((h) => h.action)).toEqual([
      'self-signed',
      'self-signed',
      'rollback',
      'rollback',
    ]);
  });

  it('with nothing before, there is nothing to go back to', async () => {
    const store = new CertificateStore(dir);
    await store.ensure(['localhost'], BY);
    expect(() => store.rollback(BY)).toThrow(/no earlier certificate/);
  });

  it('keeps keys in files of their own, and no key in the history', async () => {
    const store = new CertificateStore(dir);
    await store.ensure(['localhost'], BY);
    await store.request({ names: ['flows.example.net'] }, BY);
    expect(readFileSync(join(dir, 'key.pem'), 'utf8')).toContain('BEGIN PRIVATE KEY');
    for (const name of ['certificate.pem', 'request.pem', 'state.json', 'history.jsonl'])
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toContain('PRIVATE KEY');
    // Where the system has file modes, a key is the owner's alone.
    if (process.platform !== 'win32') expect(statSync(join(dir, 'key.pem')).mode & 0o077).toBe(0);
  });
});

describe('the cert commands', () => {
  const config = (extra: Partial<Config> = {}): Config => ({
    host: '127.0.0.1',
    port: 8443,
    tls: 'on',
    trustedProxies: [],
    gitLocal: false,
    dataDir: dir,
    database: { kind: 'sqlite', file: ':memory:' },
    log: { level: 'info', format: 'text' },
    ...extra,
  });
  const run = async (c: Config, ...args: string[]) => {
    const out: string[] = [];
    const code = await certCommand(c, args, (line) => out.push(line));
    return { code, text: out.join('\n') };
  };

  it('request, install and show, as an administrator would', async () => {
    const c = config({ publicUrl: 'https://flows.example.net' });
    expect((await run(c, 'show')).text).toContain('No certificate yet');

    const made = await run(c, 'self-signed');
    expect(made.code).toBe(0);
    // The public address's host is the certificate's first name.
    expect(made.text).toContain('Subject      CN=flows.example.net');

    const file = join(dir, 'flows.csr');
    const asked = await run(c, 'request', 'flows.example.net', '--org', 'Example', '--out', file);
    expect(asked.code).toBe(0);
    expect(existsSync(file)).toBe(true);
    expect(asked.text).not.toContain('PRIVATE KEY');

    const authority = await testAuthority();
    const signed = join(dir, 'flows.pem');
    writeFileSync(
      signed,
      (await authority.sign(readFileSync(file, 'utf8'))) + authority.certificate,
    );
    const installed = await run(c, 'install', signed);
    expect(installed.code).toBe(0);
    expect(installed.text).toContain('Issuer       CN=Test Root CA');

    const shown = await run(c, 'show');
    expect(shown.text).toContain('Certificate in use');
    expect(shown.text).toContain('Source       installed');
    expect(shown.text).toContain('Before it (cert rollback)');
    expect(shown.text).toMatch(/\(\d+ days left\)/);

    const history = await run(c, 'history');
    expect(history.text.split('\n').map((l) => l.split('  ')[1])).toEqual([
      'self-signed',
      'request',
      'install',
    ]);
    expect(history.text).toContain('by cli');
  });

  it('a refused certificate exits 1 with its reasons; a wrong command exits 2', async () => {
    const c = config({ publicUrl: 'https://flows.example.net' });
    await run(c, 'self-signed');
    const stranger = await selfSignedCertificate(['old.example.net']);
    const file = join(dir, 'old.pem');
    const keyFile = join(dir, 'old.key');
    writeFileSync(file, stranger.certificate);
    writeFileSync(keyFile, stranger.key);
    const refused = await run(c, 'install', file, '--key', keyFile);
    expect(refused.code).toBe(1);
    expect(refused.text).toContain('The certificate is not for flows.example.net');
    expect((await run(c, 'install')).code).toBe(2);
    expect((await run(c, 'request')).code).toBe(2);
    expect((await run(c, 'frobnicate')).code).toBe(2);
    expect((await run(c, 'install', join(dir, 'missing.pem'))).code).toBe(1);
  });
});
