// A small client of the server's REST API for the end-to-end suites (AFS-38): a session cookie or
// a bearer token, JSON in and out. The server's certificate is self-signed and a local antivirus may
// re-sign loopback TLS, so certificates are not checked: these suites test the server, not TLS.
// undici's own fetch: Node's built-in one carries an older undici that refuses this Agent.
import { Agent, fetch } from 'undici';

/** JSON the server answers, as the tests read it. */
// biome-ignore lint/suspicious/noExplicitAny: answers are checked by the assertions, not by types
export type Json = any;

export const insecure = new Agent({ connect: { rejectUnauthorized: false } });

export interface Answer<T = unknown> {
  status: number;
  body: T;
  headers: { get(name: string): string | null };
}

export class Api {
  cookie?: string;
  constructor(
    readonly base: string,
    readonly token?: string,
  ) {}

  async call<T = Json>(method: string, path: string, body?: unknown): Promise<Answer<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    else if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      dispatcher: insecure,
    });
    const set = res.headers.get('set-cookie');
    if (set?.startsWith('afs_session=')) this.cookie = set.split(';')[0];
    const text = await res.text();
    let parsed: unknown = text;
    if ((res.headers.get('content-type') ?? '').includes('json') && text) parsed = JSON.parse(text);
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  /** The call must answer with this status (default: any 2xx); its body comes back. */
  async ok<T = Json>(method: string, path: string, body?: unknown, status?: number): Promise<T> {
    const answer = await this.call<T>(method, path, body);
    const good = status ? answer.status === status : answer.status >= 200 && answer.status < 300;
    if (!good)
      throw new Error(
        `${method} ${path} answered ${answer.status}: ${JSON.stringify(answer.body).slice(0, 400)}`,
      );
    return answer.body;
  }

  get = <T = Json>(path: string) => this.ok<T>('GET', path);
  post = <T = Json>(path: string, body?: unknown) => this.ok<T>('POST', path, body ?? {});
  put = <T = Json>(path: string, body?: unknown) => this.ok<T>('PUT', path, body ?? {});
  patch = <T = Json>(path: string, body?: unknown) => this.ok<T>('PATCH', path, body ?? {});

  static async signIn(base: string, login: string, password: string): Promise<Api> {
    const api = new Api(base);
    await api.ok('POST', '/api/v1/session', { login, password });
    return api;
  }
}

/** Polls until check gives something truthy; fails with what it last saw after the limit. */
export async function until<T>(
  what: string,
  check: () => Promise<T | undefined | null | false>,
  limitMs = 120_000,
  everyMs = 2_000,
): Promise<T> {
  const end = Date.now() + limitMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > end)
      throw new Error(`Waited ${limitMs / 1000} s for ${what}; last: ${String(last)}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
