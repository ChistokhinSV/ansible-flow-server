// The few parts every page is made of.
import {
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useState,
} from 'react';
import { ApiError } from './api';
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
}: {
  onSubmit: () => Promise<void>;
  submit: string;
  children: ReactNode;
  onCancel?: () => void;
  /** AFS-94: a form of many fields, laid out in rows of several: it is not kept to one column. */
  wide?: boolean;
  /** The submit button is not the page's main action (another way is offered first). */
  quiet?: boolean;
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
      </div>
    </form>
  );
}

/** Text someone will paste elsewhere, with a button that copies it. */
export function Copyable({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard here (plain HTTP, an old browser): the text is selectable.
    }
  };
  return (
    <span className="copyable">
      <code>{text}</code>
      <button type="button" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? 'Copied' : 'Copy'}
      </button>
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
  children,
}: {
  title: string;
  lead?: ReactNode;
  children?: ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} · Ansible Flow Server`;
  }, [title]);
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {lead && <p className="muted">{lead}</p>}
      </div>
      {children && <div className="actions">{children}</div>}
    </header>
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
