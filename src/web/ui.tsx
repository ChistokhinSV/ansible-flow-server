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
}: {
  onSubmit: () => Promise<void>;
  submit: string;
  children: ReactNode;
  onCancel?: () => void;
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
    <form onSubmit={send} className="form">
      {children}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
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
