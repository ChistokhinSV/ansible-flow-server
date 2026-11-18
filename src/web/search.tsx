// The search field in the top bar (AFS-69): results as you type, from the server
// (GET /api/v1/search) and from the pages themselves (the settings and other fixed pages).
// `/` or Ctrl+K (Cmd+K) puts the cursor in it; arrows move, Enter opens, Esc empties it. A combobox
// with a list of options, as a screen reader expects one.
import { useEffect, useId, useRef, useState } from 'react';
import { api, type SearchHit, type User } from './api';
import { navigate, usePath } from './router';
import { formatTime } from './ui';

/** The pages that are always there, found by their words. */
const PAGES: { title: string; words: string; to: string; admin?: boolean }[] = [
  { title: 'Home', words: 'home start waiting recent', to: '/' },
  { title: 'Workspaces', words: 'workspaces projects', to: '/workspaces' },
  { title: 'Library', words: 'library shared subflows', to: '/library' },
  { title: 'Runs', words: 'runs history', to: '/runs' },
  { title: 'Approvals', words: 'approvals waiting decide', to: '/approvals' },
  {
    title: 'My account',
    words: 'my account profile email password tokens settings',
    to: '/account',
  },
  { title: 'API reference', words: 'api reference openapi docs', to: '/docs/api' },
  {
    title: 'People and groups',
    words: 'people users groups accounts service',
    to: '/admin/people',
    admin: true,
  },
  {
    title: 'Server certificate',
    words: 'server certificate tls https settings',
    to: '/admin/certificate',
    admin: true,
  },
  {
    title: 'Sign-in',
    words:
      'sign-in oidc sso keycloak entra google provider login password ldap active directory ad',
    to: '/admin/sign-in',
    admin: true,
  },
  { title: 'Audit log', words: 'audit log history who did what', to: '/admin/audit', admin: true },
  {
    title: 'Notifications',
    words: 'notifications email smtp webhook settings',
    to: '/admin/notifications',
    admin: true,
  },
];

const KIND_LABEL: Record<string, string> = {
  page: 'page',
  workspace: 'workspace',
  project: 'project',
  flow: 'flow',
  'launch-config': 'launch configuration',
  run: 'run',
  environment: 'environment',
  user: 'person',
  group: 'group',
};

/** AFS-142: the message the designer's frame sends when / or Ctrl+K is pressed in it. */
export const SEARCH_KEY = 'afs-search-key';

type Hit = SearchHit | { kind: 'page'; title: string; detail: string; to: string };

/** The fixed pages whose words have every word of the question. */
export function pagesFor(question: string, admin: boolean): Hit[] {
  const ws = question.toLowerCase().split(/\s+/).filter(Boolean);
  if (!ws.length) return [];
  return PAGES.filter(
    (p) =>
      (admin || !p.admin) && ws.every((w) => `${p.title} ${p.words}`.toLowerCase().includes(w)),
  ).map((p) => ({ kind: 'page' as const, title: p.title, detail: 'page', to: p.to }));
}

export function SearchBox({ me }: { me: User }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // AFS-102: another page, by the menu or a link: the box is empty again.
  const path = usePath();
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the page changes
  useEffect(() => {
    setQ('');
    setOpen(false);
  }, [path]);
  /** The list closes a moment after the field loses focus; coming back keeps it. */
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const list = useId();
  const optionId = (i: number) => `${list}-${i}`;

  // `/` or Ctrl+K anywhere but in a field puts the cursor here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '') ||
        (e.target as HTMLElement)?.isContentEditable;
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    // AFS-142: the designer's frame takes its own keys; it sends these two here (viewer.ts).
    const fromFrame = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.data?.type !== SEARCH_KEY) return;
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('message', fromFrame);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('message', fromFrame);
    };
  }, []);

  // Asked a moment after the last key; an older answer never replaces a newer one.
  useEffect(() => {
    const question = q.trim();
    if (question.length < 2) {
      setHits([]);
      setBusy(false);
      return;
    }
    let current = true;
    setBusy(true);
    const timer = setTimeout(() => {
      api.search(question).then(
        (found) => {
          if (!current) return;
          setHits([...pagesFor(question, me.admin), ...found]);
          setActive(-1);
          setBusy(false);
        },
        () => {
          if (!current) return;
          setHits(pagesFor(question, me.admin));
          setBusy(false);
        },
      );
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [q, me.admin]);

  const go = (hit: Hit) => {
    setOpen(false);
    setQ('');
    input.current?.blur();
    navigate(hit.to);
  };
  const shown = open && q.trim().length >= 2;

  return (
    <div className="search">
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-label="Search"
        aria-expanded={shown}
        aria-controls={list}
        aria-autocomplete="list"
        {...(active >= 0 && shown ? { 'aria-activedescendant': optionId(active) } : {})}
        placeholder="Search  /"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          clearTimeout(closing.current);
          setOpen(true);
        }}
        // A click on a result lands before the list goes.
        onBlur={() => {
          closing.current = setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, hits.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            const hit = hits[Math.max(active, 0)];
            if (hit) {
              e.preventDefault();
              go(hit);
            }
          } else if (e.key === 'Escape') {
            // AFS-142: the list closes and the words go; the cursor stays in the field.
            e.preventDefault();
            setOpen(false);
            setQ('');
            setActive(-1);
          }
        }}
      />
      {shown && (
        <div id={list} role="listbox" aria-label="Search results" className="search-results">
          {hits.map((h, i) => (
            <div
              key={`${h.kind}:${h.to}`}
              id={optionId(i)}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              className={i === active ? 'search-hit active' : 'search-hit'}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => go(h)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') go(h);
              }}
            >
              <span className="search-kind">{KIND_LABEL[h.kind] ?? h.kind}</span>
              <span className="search-title">{h.title}</span>
              {h.kind !== 'page' && (
                <span className="search-detail muted">
                  {h.detail}
                  {'at' in h && h.at && <> · {formatTime(h.at)}</>}
                </span>
              )}
            </div>
          ))}
          {!hits.length && (
            <div className="search-hit muted">{busy ? 'Looking…' : 'Nothing found'}</div>
          )}
        </div>
      )}
    </div>
  );
}
