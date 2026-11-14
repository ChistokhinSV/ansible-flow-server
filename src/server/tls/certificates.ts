// Certificates as the server needs them: make a self-signed one, make a request for a certificate
// authority to sign, read what a certificate says, and check one before it is used. No files here
// (store.ts keeps them); everything is PEM text in and out.
import 'reflect-metadata';
import { createPrivateKey, type webcrypto, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { createSecureContext } from 'node:tls';
import * as x509 from '@peculiar/x509';
import type { CertificateInfo } from './types';

/** Keys are ECDSA P-256: accepted everywhere a browser or an Ansible host connects from. */
const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const DAY = 24 * 60 * 60 * 1000;
/** A self-signed certificate lasts a year; it is meant to be replaced long before. */
export const SELF_SIGNED_DAYS = 365;

export type { CertificateInfo } from './types';

export interface KeyAndCertificate {
  /** The certificate, followed by its chain if it has one. */
  certificate: string;
  key: string;
}

const pemBlock = (label: string, der: ArrayBuffer): string =>
  `-----BEGIN ${label}-----\n${Buffer.from(der)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd()}\n-----END ${label}-----\n`;

/** The certificates of a PEM text, in the order they are written. */
export function certificatesOf(pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

const altNames = (names: string[]) =>
  new x509.SubjectAlternativeNameExtension(
    names.map((name) => ({ type: isIP(name) ? ('ip' as const) : ('dns' as const), value: name })),
  );

/** Node writes a subject one part a line; people read it on one. */
const oneLine = (name: string) => name.split('\n').filter(Boolean).join(', ');

function namesOf(certificate: X509Certificate): string[] {
  return (certificate.subjectAltName ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^(DNS|IP Address):/.test(part))
    .map((part) => part.replace(/^(DNS|IP Address):/, ''));
}

function isSelfSigned(certificate: X509Certificate): boolean {
  return certificate.subject === certificate.issuer && certificate.verify(certificate.publicKey);
}

/** What a certificate (the first of `pem`) says. Throws when `pem` holds no certificate. */
export function describeCertificate(pem: string, now = new Date()): CertificateInfo {
  const all = certificatesOf(pem);
  if (all.length === 0) throw new Error('No certificate in the text (a PEM block is expected)');
  const certificate = new X509Certificate(all[0] as string);
  return {
    subject: oneLine(certificate.subject),
    issuer: oneLine(certificate.issuer),
    names: namesOf(certificate),
    notBefore: certificate.validFromDate.toISOString(),
    notAfter: certificate.validToDate.toISOString(),
    daysLeft: Math.floor((certificate.validToDate.getTime() - now.getTime()) / DAY),
    selfSigned: isSelfSigned(certificate),
    fingerprint: certificate.fingerprint256,
    chain: all.length - 1,
  };
}

async function newKeys(): Promise<{ keys: webcrypto.CryptoKeyPair; key: string }> {
  const keys = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const key = pemBlock('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  return { keys, key };
}

/**
 * A certificate signed by its own key, for `names` (the first is its common name). Browsers warn
 * about it; it lets the server speak HTTPS from its first start until a real one is installed.
 */
export async function selfSignedCertificate(
  names: string[],
  now = new Date(),
): Promise<KeyAndCertificate> {
  if (names.length === 0) throw new Error('A certificate needs at least one name');
  const { keys, key } = await newKeys();
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Buffer.from(crypto.getRandomValues(new Uint8Array(9))).toString('hex'),
    name: `CN=${names[0]}`,
    // A minute back: a clock that is slightly behind still accepts it.
    notBefore: new Date(now.getTime() - 60_000),
    notAfter: new Date(now.getTime() + SELF_SIGNED_DAYS * DAY),
    signingAlgorithm: ALGORITHM,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([SERVER_AUTH]),
      altNames(names),
    ],
  });
  return { certificate: `${certificate.toString('pem')}\n`, key };
}

export interface RequestSubject {
  /** The names the certificate is asked for; the first is its common name. */
  names: string[];
  organization?: string;
}

/** Escapes what has a meaning in a distinguished name. */
const dnValue = (text: string) => text.replace(/[\\,+"<>;=]/g, (c) => `\\${c}`);

/**
 * A new key and a request for a certificate authority to sign. The key stays with the server; the
 * request is what leaves it.
 */
export async function certificateRequest(
  subject: RequestSubject,
): Promise<{ request: string; key: string }> {
  if (subject.names.length === 0) throw new Error('A request needs at least one name');
  const { keys, key } = await newKeys();
  const name = [
    `CN=${dnValue(subject.names[0] as string)}`,
    ...(subject.organization ? [`O=${dnValue(subject.organization)}`] : []),
  ].join(', ');
  const request = await x509.Pkcs10CertificateRequestGenerator.create({
    name,
    keys,
    signingAlgorithm: ALGORITHM,
    extensions: [
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([SERVER_AUTH]),
      altNames(subject.names),
    ],
  });
  return { request: `${request.toString('pem')}\n`, key };
}

/** True when the certificate is good for `host` (a DNS name or an IP address). */
function covers(certificate: X509Certificate, host: string): boolean {
  return isIP(host)
    ? certificate.checkIP(host) !== undefined
    : certificate.checkHost(host) !== undefined;
}

export interface CheckOptions {
  /** The host people use for the server; the certificate must be good for it. */
  host?: string;
  now?: Date;
}

/**
 * Why this certificate and key cannot serve, as sentences for the person who supplied them; empty
 * when they can. Checked before anything is replaced: a server with a certificate that does not
 * load answers nobody.
 */
export function certificateProblems(pair: KeyAndCertificate, options: CheckOptions = {}): string[] {
  const now = options.now ?? new Date();
  const all = certificatesOf(pair.certificate);
  if (all.length === 0) return ['The certificate is not PEM text: no BEGIN CERTIFICATE block'];
  let chain: X509Certificate[];
  try {
    chain = all.map((pem) => new X509Certificate(pem));
  } catch (e) {
    return [`The certificate cannot be read: ${(e as Error).message}`];
  }
  const leaf = chain[0] as X509Certificate;
  const problems: string[] = [];

  let key: ReturnType<typeof createPrivateKey> | undefined;
  try {
    key = createPrivateKey(pair.key);
  } catch {
    problems.push('The private key cannot be read (unencrypted PEM is expected)');
  }
  if (key) {
    if (!leaf.checkPrivateKey(key))
      problems.push('The private key does not belong to this certificate');
    const size = key.asymmetricKeyDetails?.modulusLength;
    if (key.asymmetricKeyType === 'rsa' && size !== undefined && size < 2048)
      problems.push(`The RSA key has ${size} bits: at least 2048 are needed`);
  }

  if (leaf.validFromDate.getTime() > now.getTime())
    problems.push(`The certificate is not valid before ${leaf.validFromDate.toISOString()}`);
  if (leaf.validToDate.getTime() <= now.getTime())
    problems.push(`The certificate expired on ${leaf.validToDate.toISOString()}`);
  if (leaf.ca) problems.push('This is the certificate of an authority, not of a server');

  // The file is the server's certificate first, then who signed it, then who signed that.
  for (let i = 0; i + 1 < chain.length; i++) {
    const signer = chain[i + 1] as X509Certificate;
    if (!(chain[i] as X509Certificate).verify(signer.publicKey)) {
      problems.push(
        `The chain is out of order or incomplete: certificate ${i + 2} of the file did not sign certificate ${i + 1}`,
      );
      break;
    }
  }

  if (options.host && !covers(leaf, options.host)) {
    const names = namesOf(leaf);
    problems.push(
      `The certificate is not for ${options.host}: it is for ${names.length ? names.join(', ') : 'no name'}`,
    );
  }

  if (problems.length === 0) {
    // Last: what TLS itself says. A pair that passes the checks above and fails here is rare.
    try {
      createSecureContext({ cert: pair.certificate, key: pair.key });
    } catch (e) {
      problems.push(`TLS does not accept the pair: ${(e as Error).message}`);
    }
  }
  return problems;
}
