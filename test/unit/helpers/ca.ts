// A certificate authority for tests: signs the server's requests as a real one would.
import 'reflect-metadata';
import type { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const DAY = 24 * 60 * 60 * 1000;

export interface TestAuthority {
  /** The authority's own certificate, PEM. */
  certificate: string;
  /** Signs a request (PEM) and gives the certificate (PEM). */
  sign(request: string, options?: { from?: Date; to?: Date }): Promise<string>;
  /** An authority under this one, signed by it. */
  intermediate(name: string): Promise<TestAuthority>;
}

async function authority(
  name: string,
  parent?: { subject: string; key: webcrypto.CryptoKey },
): Promise<TestAuthority> {
  const keys = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const extensions = [
    new x509.BasicConstraintsExtension(true, undefined, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
  ];
  const span = {
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 30 * DAY),
  };
  const serialNumber = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex');
  const own = parent
    ? await x509.X509CertificateGenerator.create({
        serialNumber,
        subject: `CN=${name}`,
        issuer: parent.subject,
        ...span,
        signingAlgorithm: ALGORITHM,
        publicKey: keys.publicKey,
        signingKey: parent.key,
        extensions,
      })
    : await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber,
        name: `CN=${name}`,
        ...span,
        signingAlgorithm: ALGORITHM,
        keys,
        extensions,
      });
  return {
    certificate: `${own.toString('pem')}\n`,
    async sign(request, options = {}) {
      const asked = new x509.Pkcs10CertificateRequest(request);
      const issued = await x509.X509CertificateGenerator.create({
        serialNumber: Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex'),
        subject: asked.subject,
        issuer: own.subject,
        notBefore: options.from ?? new Date(Date.now() - 60_000),
        notAfter: options.to ?? new Date(Date.now() + 90 * DAY),
        signingAlgorithm: ALGORITHM,
        publicKey: asked.publicKey,
        signingKey: keys.privateKey,
        extensions: asked.extensions,
      });
      return `${issued.toString('pem')}\n`;
    },
    intermediate: (child) => authority(child, { subject: own.subject, key: keys.privateKey }),
  };
}

export const testAuthority = (name = 'Test Root CA') => authority(name);
