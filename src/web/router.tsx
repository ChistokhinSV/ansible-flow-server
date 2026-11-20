// A small router: the address bar is the state. Pages are plain paths, so a link can be
// shared and the back button works; the server answers every such path with the same page.
import {
  type AnchorHTMLAttributes,
  type MouseEvent,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { ask } from './confirm';

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
};

/**
 * AFS-140: forms with typing not sent yet. Leaving the page (a link, a tab, Back, closing the tab)
 * asks first, so what was typed is not lost without a word.
 */
const unsaved = new Map<object, string | undefined>();
const LEAVE = 'Leave this page? What you typed is not saved.';
let shownPath = typeof window === 'undefined' ? '/' : window.location.pathname;

/** The unsaved forms that are in the way of going to `to`. */
const inTheWay = (to?: string) =>
  [...unsaved].filter(
    ([, within]) => !(to && within && (to === within || to.startsWith(`${within}/`))),
  );

/**
 * True when nothing unsaved is in the way of going to `to`, or the person chose to leave it.
 * AFS-150: typing held `within` a path is not in the way of the paths under it (the tabs of a page
 * that keeps it). AFS-171: asked on the page, so the answer comes later.
 */
export async function mayLeave(to?: string): Promise<boolean> {
  const lost = inTheWay(to);
  if (lost.length === 0) return true;
  if (!(await ask(LEAVE, { yes: 'Leave', no: 'Stay', danger: true }))) return false;
  for (const [form] of lost) unsaved.delete(form);
  return true;
}

/**
 * Marks a form (any object standing for it) as holding unsaved typing, or not; `within`: a path
 * under which the typing stays.
 */
export function holdUnsaved(form: object, holding: boolean, within?: string): void {
  if (holding) unsaved.set(form, within);
  else unsaved.delete(form);
}

/**
 * AFS-150: holds the page while `holding` (a form whose values differ from what is saved), so
 * leaving asks first; let go when the form unmounts. Gives a function that lets go at once, for a
 * save that moves on to another page before the form shows it saved.
 */
export function useUnsaved(holding: boolean, within?: string): () => void {
  const [self] = useState(() => ({}));
  useEffect(() => {
    holdUnsaved(self, holding, within);
  }, [self, holding, within]);
  useEffect(() => () => holdUnsaved(self, false), [self]);
  return useCallback(() => holdUnsaved(self, false), [self]);
}

if (typeof window !== 'undefined') {
  // Registered before any page listens, so a Back the person takes back stops here.
  window.addEventListener('popstate', (event) => {
    if (window.location.pathname === shownPath) return;
    const to = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (inTheWay(window.location.pathname).length === 0) {
      shownPath = window.location.pathname;
      return;
    }
    // AFS-171: the page stays where it was while the person is asked; leaving goes on after.
    event.stopImmediatePropagation();
    window.history.pushState(null, '', shownPath);
    void mayLeave(to.split(/[?#]/)[0]).then((leave) => {
      if (leave) navigate(to);
    });
  });
  window.addEventListener('beforeunload', (event) => {
    if (unsaved.size === 0) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

/**
 * Goes to a path of this application. AFS-153: `note` is what the page there says first (what
 * was just done, such as "Deleted a1-nora."): kept with that history entry, read by noteHere.
 */
export function navigate(path: string, options: { replace?: boolean; note?: string } = {}): void {
  // AFS-123: the same page with another query (a commit, a filter) is another place.
  if (path === `${window.location.pathname}${window.location.search}`) return;
  const to = path.split(/[?#]/)[0] ?? path;
  // AFS-171: asked on the page when typing would be lost; the move is made once it is answered.
  if (inTheWay(to).length) {
    void mayLeave(to).then((leave) => {
      if (leave) go(path, options);
    });
    return;
  }
  go(path, options);
}

function go(path: string, options: { replace?: boolean; note?: string }): void {
  shownPath = path.split(/[?#]/)[0] ?? path;
  const state = options.note ? { note: options.note } : null;
  if (options.replace) window.history.replaceState(state, '', path);
  else window.history.pushState(state, '', path);
  for (const listener of listeners) listener();
  window.scrollTo?.(0, 0);
}

/** AFS-153: the note navigate left for this page, if any. */
export const noteHere = (): string | undefined => {
  const note = (window.history.state as { note?: unknown } | null)?.note;
  return typeof note === 'string' ? note : undefined;
};

/** The path the address bar shows. */
export const usePath = () => useSyncExternalStore(subscribe, () => window.location.pathname);

/** AFS-123: the query the address bar shows (`?commit=…`), for a page that follows it. */
export const useSearch = () => useSyncExternalStore(subscribe, () => window.location.search);

/**
 * Matches a path against a pattern like `/w/:workspace/:project`. Gives the named parts, or
 * undefined when the path is another page. A part never spans a slash.
 */
export function match(pattern: string, path: string): Record<string, string> | undefined {
  const want = pattern.split('/').filter(Boolean);
  const have = path.split('/').filter(Boolean);
  if (want.length !== have.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, part] of want.entries()) {
    const value = have[i] ?? '';
    if (part.startsWith(':')) {
      try {
        params[part.slice(1)] = decodeURIComponent(value);
      } catch {
        return undefined;
      }
    } else if (part !== value) return undefined;
  }
  return params;
}

/** A link inside the application: no page load, and still a real link (open in a new tab). */
export function Link({
  to,
  children,
  ...rest
}: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const onClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(to);
    },
    [to],
  );
  return (
    <a href={to} onClick={onClick} {...rest}>
      {children}
    </a>
  );
}
