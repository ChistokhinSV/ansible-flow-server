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

/** AFS-255: the frame's message to the application when the operation shown changes. */
export const HASH_MESSAGE = 'afs-api-hash';

/** AFS-255: the part of an address after # that names a place in the reference, else ''. */
export function placeOf(hash: string): string {
  return /^#[A-Za-z0-9/_{}.:-]{1,300}$/.test(hash) ? hash : '';
}

/**
 * AFS-255: what Scalar says in the console that is not news here. Its "Cookie header" warning
 * comes with every request that uses the session: the browser sends the session cookie itself
 * (the header Scalar adds is dropped). And a request the person chose not to send is not an error.
 */
export function quiet(args: readonly unknown[]): boolean {
  const first = args[0];
  if (typeof first === 'string' && first.startsWith("We're trying to add a Cookie header"))
    return true;
  return args.some((a) => a instanceof NotSent || (a instanceof Error && a.name === 'NotSent'));
}

/** Leaves out of the console what `quiet` says is not news. */
export function quietConsole(target: Pick<Console, 'warn' | 'error'>): void {
  for (const level of ['warn', 'error'] as const) {
    const said = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      if (!quiet(args)) said(...args);
    };
  }
}

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
  /**
   * AFS-258: holds the page's clock while the question is open (Scalar times a request around
   * this fetch): the time shown is the request's, not the time it took to answer the question.
   * Gives back what lets it go on.
   */
  hold?: () => () => void;
}

/**
 * AFS-258: a clock (performance) that can be held: while held it stands still, and after it goes on
 * from there, so a time measured across a hold leaves the hold out. It never goes back.
 */
export function holdableClock(clock: { now(): number }): { hold(): () => void } {
  const real = clock.now.bind(clock);
  let away = 0;
  let heldAt: number | undefined;
  clock.now = () => heldAt ?? real() - away;
  return {
    hold() {
      if (heldAt !== undefined) return () => undefined;
      const start = real();
      heldAt = start - away;
      return () => {
        away += real() - start;
        heldAt = undefined;
      };
    },
  };
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
      const release = deps.hold?.();
      const said = await deps
        .ask(
          `Send ${method} ${url.pathname}? It is a real request to this server${
            headers.has('authorization') ? ', as the pasted token' : ', as you'
          }: it may change or delete something.`,
        )
        .finally(() => release?.());
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
