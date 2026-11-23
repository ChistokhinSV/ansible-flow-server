// AFS-199: what the API reference page (apidocs.ts) does around Scalar, kept apart so the tests
// can run it without Scalar: which theme the page shows, and how "Try it" sends a request.

export type Kind = 'light' | 'dark';

/** The page's theme: `light` or `dark` as the application asks, else (`auto`) the device's. */
export function kindOf(asked: string | null | undefined, deviceLight: boolean): Kind {
  if (asked === 'light' || asked === 'dark') return asked;
  return deviceLight ? 'light' : 'dark';
}

/** The application's message to the frame when its theme changes (app.tsx sends it). */
export const THEME_MESSAGE = 'afs-api-theme';

/** Methods that only read: sent without asking. */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A bearer header with nothing in it, or Scalar's placeholder: no token was pasted. */
const emptyBearer = (value: string) => /^bearer\s*$/i.test(value.trim());

export interface TryDeps {
  fetch: typeof fetch;
  /** Asks the person on the page; true when they say yes. */
  ask: (question: string) => Promise<boolean>;
  /** The page's own origin: requests go nowhere else. */
  origin: string;
}

/** Said when the person chose not to send a request. */
export class NotSent extends Error {
  constructor(method: string, path: string) {
    super(`Not sent: you chose not to send ${method} ${path}`);
    this.name = 'NotSent';
  }
}

/**
 * The fetch "Try it" uses. It sends to this server only; it asks before a request that may
 * change something; and a request with a pasted token goes without the session cookie, since
 * the server reads the session first and would answer as the person signed in, not as the token.
 */
export function tryFetch(deps: TryDeps): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url, deps.origin);
    if (url.origin !== deps.origin)
      throw new Error(`Try it sends to this server only, not to ${url.origin}`);
    const headers = new Headers(request.headers);
    const auth = headers.get('authorization');
    if (auth !== null && emptyBearer(auth)) headers.delete('authorization');
    const method = request.method.toUpperCase();
    if (!READS.has(method)) {
      const said = await deps.ask(
        `Send ${method} ${url.pathname}? It is a real request to this server${
          headers.has('authorization') ? ', as the pasted token' : ', as you'
        }: it may change or delete something.`,
      );
      if (!said) throw new NotSent(method, url.pathname);
    }
    return deps.fetch(
      new Request(request, {
        headers,
        credentials: headers.has('authorization') ? 'omit' : 'same-origin',
      }),
    );
  };
}
