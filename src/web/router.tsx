// A small router: the address bar is the state. Pages are plain paths, so a link can be
// shared and the back button works; the server answers every such path with the same page.
import {
  type AnchorHTMLAttributes,
  type MouseEvent,
  useCallback,
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

/** Goes to a path of this application. */
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path === window.location.pathname) return;
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
