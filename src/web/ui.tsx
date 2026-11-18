// The few parts every page is made of.
import {
  createContext,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from './api';
import { guide } from './guide';
import { Link } from './router';

/** Words fit to show for anything that went wrong. */
export const messageOf = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'Something went wrong. Try again.';

/**
 * Loads something when the page opens and when `reload` is called. `data` stays while a
 * reload is going, so a page does not flash empty.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({
    loading: true,
  });
  const [turn, setTurn] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller names what a load depends on
  useEffect(() => {
    let current = true;
    setState((before) => ({ ...before, loading: true, error: undefined }));
    load().then(
      (data) => current && setState({ data, loading: false }),
      (error) => current && setState({ error: messageOf(error), loading: false }),
    );
    return () => {
      current = false;
    };
  }, [...deps, turn]);
  const reload = useCallback(() => setTurn((n) => n + 1), []);
  return { ...state, reload };
}

/** What a page shows while it has nothing yet, or instead of it when loading failed. */
export function Loading({ state }: { state: { loading: boolean; error?: string } }) {
  if (state.error)
    return (
      <p className="notice error" role="alert">
        {state.error}
      </p>
    );
  return state.loading ? (
    <p className="muted" aria-live="polite">
      Loading…
    </p>
  ) : null;
}

export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      {hint && (
        <small id={`${id}-hint`} className="muted">
          {hint}
        </small>
      )}
    </div>
  );
}

/**
 * A form that sends once, shows why it was refused, and says so to a screen reader. `onSubmit`
 * rejects with the reason.
 */
export function Form({
  onSubmit,
  submit,
  children,
  onCancel,
  quiet,
  wide,
  more,
}: {
  onSubmit: () => Promise<void>;
  submit: string;
  children: ReactNode;
  onCancel?: () => void;
  /** AFS-94: a form of many fields, laid out in rows of several: it is not kept to one column. */
  wide?: boolean;
  /** The submit button is not the page's main action (another way is offered first). */
  quiet?: boolean;
  /** AFS-101: other buttons in the same row as the submit button. */
  more?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={send} className={wide ? 'form wide' : 'form'}>
      {children}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className={quiet ? undefined : 'primary'} disabled={busy}>
          {busy ? 'Working…' : submit}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        {more}
      </div>
    </form>
  );
}

/** Text someone will paste elsewhere, with a button that copies it. */
export function Copyable({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<'copied' | 'select' | undefined>();
  const shown = useRef<HTMLElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('copied');
    } catch {
      // No clipboard here (plain HTTP, an untrusted certificate, an old browser). AFS-143: the
      // text is selected, and the button says to copy it by hand.
      const code = shown.current;
      const range = code && document.createRange?.();
      if (code && range) {
        range.selectNodeContents(code);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }
      setCopied('select');
    }
    setTimeout(() => setCopied(undefined), 4000);
  };
  return (
    <span className="copyable">
      <code ref={shown}>{text}</code>
      <button type="button" onClick={copy} aria-label={`Copy ${label}`}>
        {copied === 'copied' ? 'Copied' : copied === 'select' ? 'Selected: press Ctrl+C' : 'Copy'}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied === 'copied'
          ? 'Copied'
          : copied === 'select'
            ? 'Selected: press Ctrl+C to copy'
            : ''}
      </span>
    </span>
  );
}

/** A time as people read it, with the exact time on hover. */
export function Time({ at }: { at?: string }) {
  if (!at) return <span className="muted">never</span>;
  const date = new Date(at);
  return (
    <time dateTime={at} title={date.toISOString()}>
      {date.toLocaleString()}
    </time>
  );
}

/** How long ago, in words: "just now", "5 min ago", "3 h ago", "yesterday", or the date. */
export function ago(at: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(at)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  const day = new Date(at);
  const today = new Date(now);
  if (hours < 24 && day.getDate() === today.getDate()) return `${hours} h ago`;
  const yesterday = new Date(now - 86_400_000);
  if (day.toDateString() === yesterday.toDateString()) return 'yesterday';
  return day.toLocaleDateString();
}

/** How long something has gone on, in words: "6 min", "2 h 5 min". */
export function span(from: string, to?: string, now = Date.now()): string {
  const minutes = Math.max(
    0,
    Math.round(((to ? Date.parse(to) : now) - Date.parse(from)) / 60_000),
  );
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`;
}

/** A page's heading, with what can be done on the page beside it. */
export function PageHead({
  title,
  lead,
  help,
  children,
}: {
  title: string;
  lead?: ReactNode;
  /** AFS-143: the guide page about this page (`runs.md`), linked beside the title. */
  help?: string;
  children?: ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} · Ansible Flow Server`;
  }, [title]);
  return (
    <header className="page-head">
      <div>
        {help ? (
          // The link sits beside the heading, not in it: the heading's name stays the title.
          <div className="title-line">
            <h1>{title}</h1>
            <HelpLink page={help} />
          </div>
        ) : (
          <h1>{title}</h1>
        )}
        {lead && <p className="muted">{lead}</p>}
      </div>
      {children && <div className="actions">{children}</div>}
    </header>
  );
}

/** AFS-143: a link to the guide page about where it is, opened beside the app. */
export function HelpLink({ page }: { page: string }) {
  return (
    <a className="help-link" href={guide(page)} target="_blank" rel="noreferrer">
      Help
    </a>
  );
}

export interface Tab {
  /** The last part of the tab's address; empty for the first tab, which is the page itself. */
  key: string;
  label: string;
  /** How many things the tab holds, when that helps choosing it. */
  count?: number;
  /** Something on the tab needs a look (a failure, a thing waiting). */
  alert?: boolean;
}

/**
 * AFS-84: the parts of a page as tabs. Each tab is an address (`base` for the first one, `base/key`
 * for the others), so a tab can be linked to and the back button goes through them.
 */
export function Tabs({
  label,
  base,
  tabs,
  current,
}: {
  label: string;
  base: string;
  tabs: Tab[];
  current: string;
}) {
  return (
    <nav aria-label={label} className="tabs">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          to={tab.key ? `${base}/${tab.key}` : base}
          aria-current={tab.key === current ? 'page' : undefined}
        >
          {tab.label}
          {tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
          {tab.alert && <span className="tab-alert" role="img" aria-label="needs a look" />}
        </Link>
      ))}
    </nav>
  );
}

/**
 * AFS-84: something on a page that is opened when needed (an add form, rarely used fields). `open`
 * and `onToggle` let the page close it, for example after a form in it was sent.
 */
export function Fold({
  summary,
  children,
  open,
  onToggle,
}: {
  summary: string;
  children: ReactNode;
  open?: boolean;
  onToggle?(open: boolean): void;
}) {
  return (
    <details
      className="fold"
      open={open}
      onToggle={onToggle ? (e) => onToggle((e.target as HTMLDetailsElement).open) : undefined}
    >
      <summary>{summary}</summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

/**
 * AFS-107: where the shell's top bar takes a page's breadcrumbs. Undefined outside the shell (a
 * page drawn alone, as in tests): the breadcrumbs stay in the page; null: the bar is not drawn yet.
 */
export const BarSlot = createContext<HTMLElement | null | undefined>(undefined);

/** A page's breadcrumbs: in the top bar beside the search box, so the page starts with its title. */
export function Breadcrumb({ children }: { children: ReactNode }) {
  const slot = useContext(BarSlot);
  const nav = (
    <nav aria-label="Breadcrumb" className="crumbs">
      {children}
    </nav>
  );
  if (slot === undefined) return nav;
  return slot ? createPortal(nav, slot) : null;
}

/** AFS-107: small line icons for icon buttons (their name is the button's label). */
export function Icon({ name }: { name: 'external' | 'fullscreen' | 'more' }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === 'external' ? (
        <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H7" />
      ) : name === 'more' ? (
        <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.5" />
      ) : (
        <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
      )}
    </svg>
  );
}
