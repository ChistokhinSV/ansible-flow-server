// The server's certificate on disk, in <data folder>/tls:
//   certificate.pem, key.sealed          the pair in use
//   previous-certificate.pem, -key.sealed the pair before it, to go back to
//   request.pem, request-key.sealed      a request waiting for its signed certificate, and its key
//   state.json                          where the pair in use came from; written last, so a
//                                       running server that watches it sees a finished change
//   history.jsonl                       every change: when, what, by whom, which certificate
// Private keys are written for the server's account only and never leave this folder. AFS-62: with
// the master key they are sealed with it (`<name>.sealed`), so a copy of the data folder without
// the master key does not give them away; a plain `<name>.pem` key (an older server, or a store
// without a key) is read too, and sealed by `sealKeys` at start.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { open, SealError, seal } from '../secrets/crypto';
import type { MasterKey } from '../secrets/masterKey';
import {
  type CertificateInfo,
  certificateProblems,
  certificateRequest,
  describeCertificate,
  type KeyAndCertificate,
  type RequestSubject,
  selfSignedCertificate,
} from './certificates';

import type { CertificateSource } from './types';

export type { CertificateSource } from './types';

export interface StoredCertificate extends KeyAndCertificate {
  source: CertificateSource;
  info: CertificateInfo;
}

/** A certificate that was refused, with every reason. */
export class CertificateRefused extends Error {
  constructor(readonly problems: string[]) {
    super(`The certificate was not installed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'CertificateRefused';
  }
}

export interface ChangeBy {
  /** Who made the change: `cli`, later a user's login. */
  by: string;
}

/** The private keys the store keeps, by name. */
const KEYS = ['key', 'previous-key', 'request-key'] as const;
type KeyName = (typeof KEYS)[number];

export class CertificateStore {
  constructor(
    private readonly dir: string,
    /** AFS-62: seals the private keys at rest; without it they are plain files (tests, tools). */
    private readonly masterKey?: MasterKey,
  ) {}

  /** A private key, opened; undefined when there is none. */
  private readKey(name: KeyName): string | undefined {
    const sealed = this.read(`${name}.sealed`);
    if (sealed !== undefined) {
      if (!this.masterKey)
        throw new SealError(
          'other_key',
          "The certificate's private key is sealed: it needs the server's master key",
        );
      try {
        return open(this.masterKey, sealed.trim(), `tls:${name}`);
      } catch (e) {
        throw new SealError(
          (e as SealError).code ?? 'damaged',
          `The certificate's private key (${name}) cannot be opened: ${(e as Error).message}`,
        );
      }
    }
    return this.read(`${name}.pem`);
  }

  /** Keeps a private key: sealed with the master key when there is one. */
  private writeKey(name: KeyName, pem: string, key = this.masterKey): void {
    if (key) {
      this.write(`${name}.sealed`, `${seal(key, pem, `tls:${name}`)}\n`, true);
      rmSync(this.path(`${name}.pem`), { force: true });
    } else {
      this.write(`${name}.pem`, pem, true);
      rmSync(this.path(`${name}.sealed`), { force: true });
    }
  }

  private removeKey(name: KeyName): void {
    rmSync(this.path(`${name}.pem`), { force: true });
    rmSync(this.path(`${name}.sealed`), { force: true });
  }

  /**
   * AFS-62: seals the private keys still kept plain (written by an older server). Resolves with
   * how many; none without a master key.
   */
  sealKeys(): number {
    if (!this.masterKey) return 0;
    let sealed = 0;
    for (const name of KEYS) {
      const plain = this.read(`${name}.pem`);
      if (plain === undefined || this.read(`${name}.sealed`) !== undefined) continue;
      this.writeKey(name, plain);
      sealed += 1;
    }
    return sealed;
  }

  /** AFS-62: the private keys sealed again with another master key (`secrets rotate`). */
  reseal(to: MasterKey): number {
    let sealed = 0;
    for (const name of KEYS) {
      const pem = this.readKey(name);
      if (pem === undefined) continue;
      this.writeKey(name, pem, to);
      sealed += 1;
    }
    return sealed;
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  /** The file a running server watches for a finished change. */
  get stateFile(): string {
    return this.path('state.json');
  }

  private read(name: string): string | undefined {
    try {
      return readFileSync(this.path(name), 'utf8');
    } catch {
      return undefined;
    }
  }

  private write(name: string, text: string, secret = false): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // Written beside and renamed: a reader never sees half a file.
    const temp = this.path(`${name}.new`);
    writeFileSync(temp, text, { mode: secret ? 0o600 : 0o644 });
    renameSync(temp, this.path(name));
  }

  private record(action: string, by: ChangeBy, info?: CertificateInfo): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(
      this.path('history.jsonl'),
      `${JSON.stringify({
        at: new Date().toISOString(),
        action,
        by: by.by,
        ...(info
          ? { subject: info.subject, fingerprint: info.fingerprint, notAfter: info.notAfter }
          : {}),
      })}\n`,
    );
  }

  /** The pair in use; undefined before the first one exists. */
  current(): StoredCertificate | undefined {
    const certificate = this.read('certificate.pem');
    const key = this.readKey('key');
    if (!certificate || !key) return undefined;
    let source: CertificateSource = 'installed';
    try {
      source =
        (JSON.parse(this.read('state.json') ?? '{}') as { source?: CertificateSource }).source ??
        'installed';
    } catch {}
    return { certificate, key, source, info: describeCertificate(certificate) };
  }

  /** AFS-143: the certificate in use alone (public: every TLS client is shown it). */
  certificatePem(): string | undefined {
    return this.read('certificate.pem');
  }

  /** The pair that was in use before the current one, if it is kept. */
  previous(): CertificateInfo | undefined {
    const certificate = this.read('previous-certificate.pem');
    return certificate && this.hasKey('previous-key')
      ? describeCertificate(certificate)
      : undefined;
  }

  /** A request that waits for its signed certificate. */
  pendingRequest(): string | undefined {
    return this.hasKey('request-key') ? this.read('request.pem') : undefined;
  }

  /** A key is kept, sealed or not (without opening it). */
  private hasKey(name: KeyName): boolean {
    return existsSync(this.path(`${name}.sealed`)) || existsSync(this.path(`${name}.pem`));
  }

  /** Puts a pair in use; the one in use becomes the previous one. */
  private use(pair: KeyAndCertificate, source: CertificateSource): StoredCertificate {
    const before = this.current();
    if (before) {
      this.write('previous-certificate.pem', before.certificate);
      this.writeKey('previous-key', before.key);
      writeFileSync(this.path('previous-state.json'), JSON.stringify({ source: before.source }));
    }
    this.writeKey('key', pair.key);
    this.write('certificate.pem', pair.certificate);
    this.write('state.json', JSON.stringify({ source, at: new Date().toISOString() }));
    return { ...pair, source, info: describeCertificate(pair.certificate) };
  }

  /** The pair in use, made self-signed for `names` when the server has none yet. */
  async ensure(names: string[], by: ChangeBy): Promise<StoredCertificate> {
    return this.current() ?? this.selfSigned(names, by);
  }

  /** Replaces the pair in use with a new self-signed one. */
  async selfSigned(names: string[], by: ChangeBy): Promise<StoredCertificate> {
    const stored = this.use(await selfSignedCertificate(names), 'self-signed');
    this.record('self-signed', by, stored.info);
    return stored;
  }

  /**
   * Makes a key and a request for a certificate authority. The key waits here for the signed
   * certificate; a request made before is replaced, and its key with it.
   */
  async request(subject: RequestSubject, by: ChangeBy): Promise<string> {
    const made = await certificateRequest(subject);
    this.writeKey('request-key', made.key);
    this.write('request.pem', made.request);
    this.record('request', by);
    return made.request;
  }

  /**
   * Installs a certificate. Its key is the one given, else the key of the waiting request, else
   * the key in use (a renewal for the same key). Nothing changes unless every check passes.
   */
  install(
    certificate: string,
    options: { key?: string; host?: string } & ChangeBy,
  ): StoredCertificate {
    const candidates: [string, string | undefined][] = options.key
      ? [['the key given', options.key]]
      : [
          ['the key of the waiting request', this.readKey('request-key')],
          ['the key in use', this.readKey('key')],
        ];
    const keys = candidates.filter((c): c is [string, string] => !!c[1]);
    if (keys.length === 0)
      throw new CertificateRefused(['No private key: give the key with the certificate']);
    let problems: string[] = [];
    for (const [, key] of keys) {
      problems = certificateProblems({ certificate, key }, { host: options.host });
      if (problems.length === 0) {
        const fromRequest = key === this.readKey('request-key');
        const stored = this.use({ certificate, key }, 'installed');
        if (fromRequest) {
          // The request is answered: its key is now the key in use.
          this.removeKey('request-key');
          rmSync(this.path('request.pem'), { force: true });
        }
        this.record('install', options, stored.info);
        return stored;
      }
    }
    // With no key given, "does not belong" means: to neither the request's key nor the one in use.
    if (!options.key)
      problems = problems.map((p) =>
        p === 'The private key does not belong to this certificate'
          ? 'The certificate is for neither the waiting request nor the key in use: give its key'
          : p,
      );
    throw new CertificateRefused(problems);
  }

  /** Goes back to the pair that was in use before; the current one becomes the previous. */
  rollback(by: ChangeBy): StoredCertificate {
    const certificate = this.read('previous-certificate.pem');
    const key = this.readKey('previous-key');
    if (!certificate || !key)
      throw new CertificateRefused(['There is no earlier certificate to go back to']);
    let source: CertificateSource = 'installed';
    try {
      source =
        (JSON.parse(this.read('previous-state.json') ?? '{}') as { source?: CertificateSource })
          .source ?? 'installed';
    } catch {}
    const problems = certificateProblems({ certificate, key });
    if (problems.length) throw new CertificateRefused(problems);
    const stored = this.use({ certificate, key }, source);
    this.record('rollback', by, stored.info);
    return stored;
  }

  /** Every change made to the certificate, oldest first. */
  history(): Record<string, unknown>[] {
    if (!existsSync(this.path('history.jsonl'))) return [];
    return (this.read('history.jsonl') ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}
