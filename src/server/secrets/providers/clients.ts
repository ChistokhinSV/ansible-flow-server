// The four kinds of secret provider (AFS-242), each a few REST calls with no SDK:
// - HashiCorp Vault, KV version 2: AppRole (role id, secret id) or a token;
// - CyberArk Conjur: a host's API key for a short-lived token, then the variable;
// - CyberArk Central Credential Provider: AppID and a client certificate;
// - AWS Secrets Manager: an access key, requests signed with our own SigV4.
// The words of every error name the provider and the status, never the path: a provider's own
// text (which names it) is kept in the error's `detail`, for the server's log.
import { createHash, createHmac } from 'node:crypto';
import { type Answer, type CallOptions, call, detailOf, jsonOf, SecretReadError } from './http';
import {
  PROVIDER_KIND_NAME,
  type ProviderKind,
  type ProviderSettings,
  type SecretRef,
} from './types';

/** A provider with its secret part opened: for the server's own use. */
export interface Connection {
  key: string;
  name: string;
  kind: ProviderKind;
  settings: ProviderSettings;
  secret: Record<string, string>;
}

export interface Client {
  /** The value a reference points at. Signs in first when the kind needs it (once). */
  read(ref: SecretRef): Promise<string>;
  /** Signs in (or reaches the provider) without reading a secret; says what it found. */
  test(): Promise<string>;
  /** Gives back what the client signed in with (a Vault token from AppRole is revoked). */
  close(): Promise<void>;
}

export type Caller = (url: string, options: CallOptions) => Promise<Answer>;

const base = (address = '') => address.trim().replace(/\/+$/, '');
const timeoutOf = (s: ProviderSettings) => Math.min(Math.max(s.timeoutS ?? 10, 1), 120) * 1000;

/** Makes the client of a provider; `caller` is replaced in tests. */
export function clientOf(conn: Connection, caller: Caller = call): Client {
  switch (conn.kind) {
    case 'vault':
      return vault(conn, caller);
    case 'conjur':
      return conjur(conn, caller);
    case 'ccp':
      return ccp(conn, caller);
    case 'aws':
      return aws(conn, caller);
  }
}

/** The standard words of a refusal: a 401, 403 or 404 in its kind's terms. */
function refused(conn: Connection, answer: Answer, thing: string): SecretReadError {
  const kind = PROVIDER_KIND_NAME[conn.kind];
  const detail = detailOf(answer);
  switch (answer.status) {
    case 401:
      return new SecretReadError(
        'auth',
        `${kind} did not accept the sign-in of "${conn.name}" (401)`,
        401,
        detail,
      );
    case 403:
      return new SecretReadError(
        'denied',
        `${kind} refused the read (403): "${conn.name}" may not read this ${thing}`,
        403,
        detail,
      );
    case 404:
      return new SecretReadError('not_found', `${kind} has no such ${thing} (404)`, 404, detail);
    default:
      return new SecretReadError(
        'bad_answer',
        `${kind} answered ${answer.status}`,
        answer.status,
        detail,
      );
  }
}

/** A value as text: a field that holds a map or a list is given as its JSON. */
const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

// --- HashiCorp Vault (KV version 2)

function vault(conn: Connection, caller: Caller): Client {
  const s = conn.settings;
  const who = `HashiCorp Vault "${conn.name}"`;
  const opts = (extra: Partial<CallOptions> = {}): CallOptions => ({
    who,
    timeoutMs: timeoutOf(s),
    tls: { ...(s.ca ? { ca: s.ca } : {}) },
    ...extra,
    headers: {
      ...(s.namespace ? { 'X-Vault-Namespace': s.namespace } : {}),
      ...(extra.headers ?? {}),
    },
  });
  let token: Promise<string> | undefined;
  /** Whether the token is one this client got (AppRole), to be revoked at the end. */
  let own = false;
  const signIn = async (): Promise<string> => {
    if (s.auth === 'token') {
      if (!conn.secret.token)
        throw new SecretReadError('auth', `HashiCorp Vault "${conn.name}" has no token kept`);
      return conn.secret.token;
    }
    const answer = await caller(
      `${base(s.address)}/v1/auth/${encodeURIComponent(s.authMount || 'approle')}/login`,
      opts({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role_id: conn.secret.roleId, secret_id: conn.secret.secretId }),
      }),
    );
    // A wrong role id or secret id is a 400 ("invalid role or secret ID").
    if ([400, 401, 403].includes(answer.status))
      throw new SecretReadError(
        'auth',
        `HashiCorp Vault did not accept the AppRole sign-in of "${conn.name}" (${answer.status})`,
        answer.status,
        detailOf(answer),
      );
    if (answer.status !== 200) throw refused(conn, answer, 'secret');
    const t = jsonOf<{ auth?: { client_token?: string } }>(who, answer).auth?.client_token;
    if (!t) throw new SecretReadError('bad_answer', `${who} gave no token for the AppRole sign-in`);
    own = true;
    return t;
  };
  const tokenOf = () => {
    token ??= signIn();
    // A failed sign-in is not kept: the next read tries again.
    token.catch(() => (token = undefined));
    return token;
  };
  /** Vault answers a bad or expired token with 403 too: the body tells them apart. */
  const denied = (answer: Answer) =>
    answer.status === 403 && /invalid token|token is expired|bad token/i.test(answer.text)
      ? new SecretReadError(
          'auth',
          `HashiCorp Vault did not accept the token of "${conn.name}" (403)`,
          403,
          detailOf(answer),
        )
      : refused(conn, answer, 'secret');
  return {
    async read(ref) {
      const t = await tokenOf();
      const mount = (ref.mount || s.kvMount || 'secret').replace(/^\/+|\/+$/g, '');
      const path = (ref.path ?? '')
        .replace(/^\/+|\/+$/g, '')
        .split('/')
        .map(encodeURIComponent)
        .join('/');
      const version = ref.version ? `?version=${encodeURIComponent(ref.version)}` : '';
      const answer = await caller(
        `${base(s.address)}/v1/${mount.split('/').map(encodeURIComponent).join('/')}/data/${path}${version}`,
        opts({ headers: { 'X-Vault-Token': t } }),
      );
      if (answer.status !== 200) throw denied(answer);
      const data = jsonOf<{ data?: { data?: Record<string, unknown> | null } }>(who, answer).data
        ?.data;
      if (!data)
        throw new SecretReadError('not_found', 'HashiCorp Vault has no such secret (deleted)', 200);
      if (!ref.field || !(ref.field in data))
        throw new SecretReadError(
          'not_found',
          'HashiCorp Vault has the secret but not the field asked for',
          200,
        );
      return asText(data[ref.field]);
    },
    async test() {
      const t = await tokenOf();
      const answer = await caller(
        `${base(s.address)}/v1/auth/token/lookup-self`,
        opts({ headers: { 'X-Vault-Token': t } }),
      );
      if (answer.status !== 200) throw denied(answer);
      return s.auth === 'token' ? 'Signed in with the token' : 'Signed in with AppRole';
    },
    async close() {
      if (!token || !own) return;
      const t = await token.catch(() => undefined);
      token = undefined;
      if (!t) return;
      // The run's token is not left to its TTL: revoked as the run ends.
      await caller(
        `${base(s.address)}/v1/auth/token/revoke-self`,
        opts({ method: 'POST', headers: { 'X-Vault-Token': t } }),
      ).catch(() => undefined);
    },
  };
}

// --- CyberArk Conjur (authn with a host's API key)

function conjur(conn: Connection, caller: Caller): Client {
  const s = conn.settings;
  const who = `CyberArk Conjur "${conn.name}"`;
  const opts = (extra: Partial<CallOptions>): CallOptions => ({
    who,
    timeoutMs: timeoutOf(s),
    tls: { ...(s.ca ? { ca: s.ca } : {}) },
    ...extra,
  });
  const account = encodeURIComponent(s.account ?? '');
  let token: Promise<string> | undefined;
  const signIn = async () => {
    const answer = await caller(
      `${base(s.address)}/authn/${account}/${encodeURIComponent(s.login ?? '')}/authenticate`,
      opts({
        method: 'POST',
        headers: { 'Accept-Encoding': 'base64', 'content-type': 'text/plain' },
        body: conn.secret.apiKey ?? '',
      }),
    );
    if (answer.status !== 200) throw refused(conn, answer, 'variable');
    // A base64 access token, good for about 8 minutes.
    return answer.text.trim();
  };
  const tokenOf = () => {
    token ??= signIn();
    token.catch(() => (token = undefined));
    return token;
  };
  return {
    async read(ref) {
      const t = await tokenOf();
      const answer = await caller(
        `${base(s.address)}/secrets/${account}/variable/${encodeURIComponent(ref.variable ?? '')}`,
        opts({ headers: { Authorization: `Token token="${t}"` } }),
      );
      // Conjur answers 404 both for a variable that is not there and one it may not read.
      if (answer.status === 404)
        throw new SecretReadError(
          'not_found',
          `CyberArk Conjur has no such variable, or "${conn.name}" may not read it (404)`,
          404,
          detailOf(answer),
        );
      if (answer.status !== 200) throw refused(conn, answer, 'variable');
      return answer.text;
    },
    async test() {
      await tokenOf();
      return `Signed in as ${s.login}`;
    },
    async close() {
      // The token is dropped; it lasts minutes and Conjur has no call to end it.
      token = undefined;
    },
  };
}

// --- CyberArk Central Credential Provider

/** A CCP error code (APPAP004E) is safe to show; its message names the safe and object. */
const ccpCode = (answer: Answer) => {
  try {
    const code = String((JSON.parse(answer.text) as { ErrorCode?: unknown }).ErrorCode ?? '');
    return /^[A-Z]{4,6}\d{3}[A-Z]$/.test(code) ? ` [${code}]` : '';
  } catch {
    return '';
  }
};

function ccp(conn: Connection, caller: Caller): Client {
  const s = conn.settings;
  const who = `CyberArk CCP "${conn.name}"`;
  const opts: CallOptions = {
    who,
    timeoutMs: timeoutOf(s),
    tls: {
      ...(s.ca ? { ca: s.ca } : {}),
      ...(s.clientCert && conn.secret.clientKey
        ? { cert: s.clientCert, key: conn.secret.clientKey }
        : {}),
    },
  };
  const ask = (query: Record<string, string>) =>
    caller(
      `${base(s.address)}/AIMWebService/api/Accounts?${new URLSearchParams({ AppID: s.appId ?? '', ...query })}`,
      opts,
    );
  const refusal = (answer: Answer) => {
    const code = ccpCode(answer);
    if (answer.status === 403)
      return new SecretReadError(
        'denied',
        `CyberArk CCP refused the request (403): check the client certificate and AppID of "${conn.name}"${code}`,
        403,
        detailOf(answer),
      );
    if (answer.status === 404)
      return new SecretReadError(
        'not_found',
        `CyberArk CCP has no such account (404)${code}`,
        404,
        detailOf(answer),
      );
    const e = refused(conn, answer, 'account');
    return new SecretReadError(e.code, `${e.message}${code}`, e.status, e.detail);
  };
  return {
    async read(ref) {
      const answer = await ask({
        Safe: ref.safe ?? '',
        ...(ref.folder ? { Folder: ref.folder } : {}),
        Object: ref.object ?? '',
      });
      if (answer.status !== 200) throw refusal(answer);
      const account = jsonOf<Record<string, unknown>>(who, answer);
      const field = ref.field || 'Content';
      if (account[field] === undefined || account[field] === null)
        throw new SecretReadError(
          'not_found',
          'CyberArk CCP has the account but not the field asked for',
          200,
        );
      return asText(account[field]);
    },
    async test() {
      // No account named: the provider answers 400 or 404 when it accepts the client, 403 when not.
      const answer = await ask({});
      if (answer.status === 403 || answer.status === 401) throw refusal(answer);
      return 'Reached, and the client certificate was accepted; a read needs a reference';
    },
    async close() {},
  };
}

// --- AWS Secrets Manager (SigV4)

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key: string | Buffer, s: string) =>
  createHmac('sha256', key).update(s, 'utf8').digest();
/** RFC 3986 encoding, as SigV4 asks for. */
const enc = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export interface SigV4Request {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now?: Date;
}

/** The headers of a request signed with AWS Signature Version 4 (the request's own, signed). */
export function sigv4(r: SigV4Request): Record<string, string> {
  const u = new URL(r.url);
  const amzDate = (r.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers))
    h[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  h.host = u.host;
  h['x-amz-date'] = amzDate;
  if (r.sessionToken) h['x-amz-security-token'] = r.sessionToken;
  const names = Object.keys(h).sort();
  const query = [...u.searchParams]
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [
    r.method,
    u.pathname || '/',
    query,
    names.map((n) => `${n}:${h[n]}\n`).join(''),
    names.join(';'),
    sha256(r.body),
  ].join('\n');
  const scope = `${day}/${r.region}/${r.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${r.secretAccessKey}`, day), r.region), r.service),
    'aws4_request',
  );
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  return {
    ...h,
    authorization: `AWS4-HMAC-SHA256 Credential=${r.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

const AWS_ERRORS: Record<string, [SecretReadError['code'], (name: string) => string]> = {
  ResourceNotFoundException: ['not_found', () => 'AWS Secrets Manager has no such secret'],
  AccessDeniedException: [
    'denied',
    (n) => `AWS Secrets Manager refused the read: "${n}" may not read this secret`,
  ],
  UnrecognizedClientException: [
    'auth',
    (n) => `AWS Secrets Manager did not accept the access key of "${n}"`,
  ],
  InvalidClientTokenId: ['auth', (n) => `AWS did not accept the access key of "${n}"`],
  InvalidSignatureException: [
    'auth',
    (n) => `AWS Secrets Manager did not accept the access key of "${n}" (signature)`,
  ],
  SignatureDoesNotMatch: ['auth', (n) => `AWS did not accept the access key of "${n}" (signature)`],
  ExpiredTokenException: ['auth', (n) => `The AWS session token of "${n}" has expired`],
  ExpiredToken: ['auth', (n) => `The AWS session token of "${n}" has expired`],
  DecryptionFailure: ['denied', () => 'AWS Secrets Manager could not decrypt the secret'],
};

function aws(conn: Connection, caller: Caller): Client {
  const s = conn.settings;
  const who = `AWS Secrets Manager "${conn.name}"`;
  const region = s.region ?? '';
  const signed = async (
    service: string,
    url: string,
    headers: Record<string, string>,
    body: string,
  ) => {
    const all = sigv4({
      method: 'POST',
      url,
      headers,
      body,
      region,
      service,
      accessKeyId: conn.secret.accessKeyId ?? '',
      secretAccessKey: conn.secret.secretAccessKey ?? '',
      ...(conn.secret.sessionToken ? { sessionToken: conn.secret.sessionToken } : {}),
    });
    return caller(url, {
      who,
      method: 'POST',
      headers: all,
      body,
      timeoutMs: timeoutOf(s),
      tls: { ...(s.ca ? { ca: s.ca } : {}) },
    });
  };
  const failure = (answer: Answer, type: string) => {
    const known = AWS_ERRORS[type];
    if (known)
      return new SecretReadError(
        known[0],
        `${known[1](conn.name)} (${type})`,
        answer.status,
        detailOf(answer),
      );
    return new SecretReadError(
      'bad_answer',
      `AWS answered ${answer.status}${type ? ` (${type})` : ''}`,
      answer.status,
      detailOf(answer),
    );
  };
  return {
    async read(ref) {
      const url = s.address
        ? `${base(s.address)}/`
        : `https://secretsmanager.${region}.amazonaws.com/`;
      const body = JSON.stringify({
        SecretId: ref.secretId,
        ...(ref.versionStage ? { VersionStage: ref.versionStage } : {}),
      });
      const answer = await signed(
        'secretsmanager',
        url,
        {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': 'secretsmanager.GetSecretValue',
        },
        body,
      );
      if (answer.status !== 200) {
        let type = '';
        try {
          type = String((JSON.parse(answer.text) as { __type?: unknown }).__type ?? '')
            .split('#')
            .pop() as string;
        } catch {
          type = '';
        }
        throw failure(answer, type);
      }
      const out = jsonOf<{ SecretString?: string; SecretBinary?: string }>(who, answer);
      const text =
        out.SecretString ?? Buffer.from(out.SecretBinary ?? '', 'base64').toString('utf8');
      if (!ref.jsonKey) return text;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new SecretReadError(
          'not_found',
          'The AWS secret is not JSON, so it has no key to take',
          200,
        );
      }
      if (!parsed || typeof parsed !== 'object' || !(ref.jsonKey in parsed))
        throw new SecretReadError('not_found', 'The AWS secret has no such key', 200);
      return asText((parsed as Record<string, unknown>)[ref.jsonKey]);
    },
    async test() {
      // STS GetCallerIdentity needs no permission: it proves the key only.
      const url = s.address ? `${base(s.address)}/` : `https://sts.${region}.amazonaws.com/`;
      const answer = await signed(
        'sts',
        url,
        { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        'Action=GetCallerIdentity&Version=2011-06-15',
      );
      if (answer.status !== 200)
        throw failure(answer, /<Code>([A-Za-z]+)<\/Code>/.exec(answer.text)?.[1] ?? '');
      const account = /<Account>(\d+)<\/Account>/.exec(answer.text)?.[1];
      return `Signed in${account ? ` to account ${account}` : ''}`;
    },
    async close() {},
  };
}
