// A server certificate from a PFX (PKCS#12) file: modern (AES-256), legacy (RC2 and 3DES) and EC
// files are read into the certificate, its chain and its key; a wrong passphrase, a file with no key
// or not a PFX at all are refused. The fixtures (test/fixtures/tls) were made with openssl for
// flows.example.net under "Fixture Root CA"; their passphrase is "fixture-only".
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import { isPfx, pfxToPem } from '../../src/server/tls/pfx';
import { CertificateRefused } from '../../src/server/tls/store';

const FIXTURES = join(__dirname, '..', 'fixtures', 'tls');
const PASS = 'fixture-only';
const fixture = (name: string) => readFileSync(join(FIXTURES, name));

/** An RSA certificate for flows.example.net under its own authority, as a forge PFX. */
function rsaPfx(options: { algorithm: 'aes256' | '3des'; withKey?: boolean }): Buffer {
  const make = (cn: string, keys: forge.pki.rsa.KeyPair, issuer?: forge.pki.Certificate) => {
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = `0${Math.floor(Math.random() * 1e9).toString(16)}`;
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + 90 * 24 * 3600_000);
    cert.setSubject([{ name: 'commonName', value: cn }]);
    cert.setIssuer((issuer ?? cert).subject.attributes);
    cert.setExtensions(
      issuer
        ? [{ name: 'subjectAltName', altNames: [{ type: 2, value: cn }] }]
        : [{ name: 'basicConstraints', cA: true, critical: true }],
    );
    return cert;
  };
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const ca = make('Forge Root CA', caKeys);
  ca.sign(caKeys.privateKey, forge.md.sha256.create());
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const leaf = make('flows.example.net', keys, ca);
  leaf.sign(caKeys.privateKey, forge.md.sha256.create());
  // The authority first, as some tools write them: the order is not trusted.
  const asn1 = forge.pkcs12.toPkcs12Asn1(
    options.withKey === false ? null : keys.privateKey,
    [ca, leaf],
    PASS,
    { algorithm: options.algorithm },
  );
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

const refusal = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof CertificateRefused) return e.problems.join('; ');
    throw e;
  }
  throw new Error('not refused');
};

describe('PFX files', () => {
  it('reads modern, legacy and EC files: the certificate first, its chain after, the key', () => {
    for (const [name, bytes] of [
      ['aes256', rsaPfx({ algorithm: 'aes256' })],
      ['3des', rsaPfx({ algorithm: '3des' })],
      ['rc2 (openssl -legacy)', fixture('legacy.pfx')],
      ['ec', fixture('ec.pfx')],
    ] as const) {
      expect(isPfx(bytes), name).toBe(true);
      const pair = pfxToPem(bytes, PASS);
      const certs = pair.certificate.match(
        /-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g,
      );
      expect(certs?.length, name).toBe(2);
      const [leaf, ca] = (certs ?? []).map((c) => new X509Certificate(c));
      expect(leaf?.subject, name).toBe('CN=flows.example.net');
      expect(leaf?.checkIssued(ca as X509Certificate), name).toBe(true);
      expect(pair.key, name).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    }
  }, 60_000);

  it('refuses a wrong passphrase, a PFX without a key, and a file that is not one', () => {
    expect(refusal(() => pfxToPem(fixture('ec.pfx'), 'wrong'))).toContain(
      'The PFX passphrase is wrong',
    );
    expect(refusal(() => pfxToPem(rsaPfx({ algorithm: 'aes256', withKey: false }), PASS))).toBe(
      'The PFX holds no private key',
    );
    expect(refusal(() => pfxToPem(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]), PASS))).toContain(
      'not a PFX',
    );
    expect(isPfx(Buffer.from('-----BEGIN CERTIFICATE-----\n'))).toBe(false);
  }, 60_000);
});
