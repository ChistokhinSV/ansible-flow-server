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

/**
 * True when nothing unsaved is in the way of going to `to`, or the person chose to leave it.
 * AFS-150: typing held `within` a path is not in the way of the paths under it (the tabs of a page
 * that keeps it).
 */
export function mayLeave(to?: string): boolean {
  const lost = [...unsaved].filter(
    ([, within]) => !(to && within && (to === within || to.startsWith(`${within}/`))),
  );
  if (lost.length === 0) return true;
  if (!window.confirm(LEAVE)) return false;
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
    if (mayLeave(window.location.pathname)) {
      shownPath = window.location.pathname;
      return;
    }
    event.stopImmediatePropagation();
    window.history.pushState(null, '', shownPath);
  });
  window.addEventListener('beforeunload', (event) => {
    if (unsaved.size === 0) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

/** Goes to a path of this application. */
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path === window.location.pathname) return;
  if (!mayLeave(path.split(/[?#]/)[0] ?? path)) return;
  shownPath = path.split(/[?#]/)[0] ?? path;
  if (options.replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  for (const listener of listeners) listener();
  window.scrollTo?.(0, 0);
}

/** The path the address bar shows. */
export const usePath = () => useSyncExternalStore(subscribe, () => window.location.pathname);

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
