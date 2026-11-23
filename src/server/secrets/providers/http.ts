// One HTTP(S) call to a secret provider. node:https takes a certificate authority and a client
// certificate per request, so each provider trusts its own CA (beside the server's, AFS_CA_FILE
// included) and CCP shows its client certificate, without changing anything process-wide.
// One timeout covers the connection and the answer.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import tls from 'node:tls';

/**
 * Why a read or a sign-in failed. `message` is what the run's output and the pages may say: the
 * provider, the connection, the status and the kind of error, never a path. `detail` is the
 * provider's own text, which may name the path: for the server's log only.
 */
export class SecretReadError extends Error {
  constructor(
    readonly code:
      | 'denied'
      | 'not_found'
      | 'auth'
      | 'timeout'
      | 'unreachable'
      | 'tls'
      | 'bad_answer'
      | 'not_allowed',
    message: string,
    readonly status = 0,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'SecretReadError';
  }
}

export interface CallTls {
  /** PEM of a CA trusted for this call, beside the server's own. */
  ca?: string;
  /** PEM of a client certificate and its key. */
  cert?: string;
  key?: string;
}

export interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  tls?: CallTls;
  timeoutMs?: number;
  /** The provider in words for the errors: HashiCorp Vault "corp-vault". */
  who: string;
}

export interface Answer {
  status: number;
  text: string;
}

const TLS_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED',
  'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE',
  'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
]);
/** The longest answer kept: a secret is small, and a provider that sends more is not one. */
const MAX_ANSWER = 1024 * 1024;

/** The server's CAs (with AFS_CA_FILE) and this provider's own. */
function trusted(ca?: string): string[] | undefined {
  if (!ca?.trim()) return undefined;
  return [...tls.getCACertificates('default'), ca];
}

export function call(url: string, options: CallOptions): Promise<Answer> {
  const u = new URL(url);
  const https = u.protocol === 'https:';
  const timeoutMs = options.timeoutMs ?? 10_000;
  const seconds = Math.round(timeoutMs / 100) / 10;
  const { who } = options;
  return new Promise((resolve, reject) => {
    let connected = false;
    let settled = false;
    const done = (f: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      f();
    };
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.body !== undefined)
      headers['content-length'] = String(Buffer.byteLength(options.body));
    const ca = trusted(options.tls?.ca);
    const req = (https ? httpsRequest : httpRequest)(
      u,
      {
        method: options.method ?? 'GET',
        headers,
        // A socket of its own: the CA and client certificate are this connection's.
        agent: false,
        ...(https
          ? {
              ...(ca ? { ca } : {}),
              ...(options.tls?.cert ? { cert: options.tls.cert } : {}),
              ...(options.tls?.key ? { key: options.tls.key } : {}),
            }
          : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_ANSWER) {
            req.destroy();
            done(() =>
              reject(new SecretReadError('bad_answer', `${who} sent an answer too long for a secret`)),
            );
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          done(() =>
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
          ),
        );
        res.on('error', (e) =>
          done(() => reject(new SecretReadError('unreachable', `${who} broke off its answer`, 0, e.message))),
        );
      },
    );
    req.on('socket', (s) => {
      if (!s.connecting) connected = true;
      else s.once(https ? 'secureConnect' : 'connect', () => (connected = true));
    });
    const timer = setTimeout(() => {
      done(() =>
        reject(
          new SecretReadError(
            'timeout',
            connected
              ? `${who} did not answer within ${seconds} s`
              : `${who} could not be reached within ${seconds} s`,
          ),
        ),
      );
      req.destroy();
    }, timeoutMs);
    req.on('error', (e: NodeJS.ErrnoException) =>
      done(() => {
        const code = e.code ?? '';
        if (code === 'ERR_TLS_CERT_ALTNAME_INVALID')
          reject(
            new SecretReadError(
              'tls',
              `${who}: the certificate is not for this address: use a name the certificate gives`,
              0,
              e.message,
            ),
          );
        else if (TLS_CODES.has(code) || /certificate|ssl|tls alert/i.test(e.message))
          reject(
            new SecretReadError(
              'tls',
              `${who}: the certificate is not trusted (${code || 'TLS'}): add its authority to the provider`,
              0,
              e.message,
            ),
          );
        else
          reject(
            new SecretReadError(
              'unreachable',
              `${who} could not be reached (${code || 'no connection'})`,
              0,
              e.message,
            ),
          );
      }),
    );
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** The provider's text, cut, for the server's log. */
export const detailOf = (answer: Answer) => answer.text.slice(0, 300);

/** An answer's JSON, or a bad_answer error. */
export function jsonOf<T>(who: string, answer: Answer): T {
  try {
    return JSON.parse(answer.text) as T;
  } catch {
    throw new SecretReadError(
      'bad_answer',
      `${who} gave an answer that is not JSON (${answer.status})`,
      answer.status,
      detailOf(answer),
    );
  }
}
