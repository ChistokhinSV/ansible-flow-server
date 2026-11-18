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
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { ApiError, api } from './api';
import { guide } from './guide';
import { holdUnsaved, Link } from './router';

/** AFS-140: a commit as the pages show it (12 digits), or more, or all 40. */
export const COMMIT_PATTERN = '[0-9a-fA-F]{7,40}';
export const COMMIT_TITLE = 'A commit id: 7 to 40 hex digits, like c300821e56a6';

/** Words fit to show for anything that went wrong. */
export const messageOf = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'Something went wrong. Try again.';

/**
 * Loads something when the page opens and when `reload` is called. `data` stays while a
 * reload is going, so a page does not flash empty.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  // `failure`: what the error was, for a page that shows more of it than its words (AFS-164).
  const [state, setState] = useState<{
    data?: T;
    error?: string;
    failure?: unknown;
    loading: boolean;
  }>({
    loading: true,
  });
  const [turn, setTurn] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller names what a load depends on
  useEffect(() => {
    let current = true;
    setState((before) => ({ ...before, loading: true, error: undefined, failure: undefined }));
    load().then(
      (data) => current && setState({ data, loading: false }),
      (error) => current && setState({ error: messageOf(error), failure: error, loading: false }),
    );
    return () => {
      current = false;
    };
  }, [...deps, turn]);
  const reload = useCallback(() => setTurn((n) => n + 1), []);
  return { ...state, reload };
}

/** What a page shows while it has nothing yet, or instead of it when loading failed. */
export function Loading({
  state,
}: {
  state: { loading: boolean; error?: string; data?: unknown };
}) {
  if (state.error)
    return (
      <p className="notice error" role="alert">
        {state.error}
      </p>
    );
  // AFS-139: a list read again (a refresh after an action, or on a timer) keeps what it shows.
  return state.loading && state.data === undefined ? (
    <p className="muted" aria-live="polite">
      Loading…
    </p>
  ) : null;
}

/**
 * AFS-140: a refusal that is about one field. A page throws it from a form's `onSubmit` when it
 * finds a problem before asking the server; the server's refusals carry their field the same way.
 */
export const refuse = (field: string, message: string): never => {
  throw new ApiError(0, 'invalid', message, { field });
};

/** AFS-140: the field a form's refusal is about, and what the form's fields say they are. */
const FormProblems = createContext<{
  problem?: { field?: string; message: string };
  claim(field: string): () => void;
}>({ claim: () => () => undefined });

/**
 * AFS-140: the problem of a form's refusal when it is about the field `name` (the field shows it,
 * not the bottom of the form). `own` is a problem the page found itself; it comes first.
 */
export function useFieldProblem(name?: string, own?: string): string | undefined {
  const { problem, claim } = useContext(FormProblems);
  useEffect(() => (name ? claim(name) : undefined), [name, claim]);
  return own || (name && problem?.field === name ? problem.message : undefined);
}

/** AFS-140: scrolls something into view (smoothly where the browser can) and focuses it. */
export function reveal(element: Element | null | undefined, focus?: HTMLElement | null): void {
  if (!element) return;
  element.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  (focus ?? (element as HTMLElement)).focus?.({ preventScroll: true });
}

/** AFS-140: the first field of a form or panel that takes typing, to put the cursor in. */
export const firstField = (root: Element | null | undefined): HTMLElement | null =>
  root?.querySelector<HTMLElement>(
    'input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])',
  ) ?? null;

/**
 * AFS-140: something opened by a click (a form, a result) is scrolled into view, and the cursor goes
 * to its first field. Give the returned ref to the thing opened.
 */
export function useReveal<T extends HTMLElement>(when: unknown = true, focus = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (when) reveal(ref.current, focus ? firstField(ref.current) : undefined);
  }, [when, focus]);
  return ref;
}

/**
 * A field of a form, with its hint and its problem said under it and to a screen reader. The
 * problem is the page's own (`problem`) or that of the form's refusal about the field `name`.
 */
export function Labelled({
  label,
  hint,
  problem,
  name,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  problem?: string;
  name?: string;
  children: (props: {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
  }) => ReactNode;
}) {
  const id = useId();
  const shown = useFieldProblem(name, problem);
  const described = [hint && `${id}-hint`, shown && `${id}-problem`].filter(Boolean).join(' ');
  return (
    <div className={`field${shown ? ' invalid' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        ...(described ? { 'aria-describedby': described } : {}),
        ...(shown ? { 'aria-invalid': true } : {}),
      })}
      {hint && (
        <small id={`${id}-hint`} className="muted">
          {hint}
        </small>
      )}
      {shown && (
        <small id={`${id}-problem`} className="bad-text">
          {shown}
        </small>
      )}
    </div>
  );
}

/**
 * AFS-154: what a field says once its text is as long as it may be: a longer paste was cut there
 * by the browser without a word.
 */
export function limitNote(value: unknown, max: number | undefined): string | undefined {
  return typeof value === 'string' && max !== undefined && max > 0 && value.length >= max
    ? `At most ${max} characters: anything after that is left out.`
    : undefined;
}

/** A field's hint, and the note of `limitNote` after it. */
export function withLimit(hint: ReactNode, value: unknown, max: number | undefined): ReactNode {
  const note = limitNote(value, max);
  if (!note) return hint;
  return hint ? (
    <>
      {hint} {note}
    </>
  ) : (
    note
  );
}

export function Field({
  label,
  hint,
  problem,
  ...input
}: { label: string; hint?: ReactNode; problem?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Labelled
      label={label}
      hint={withLimit(hint, input.value, input.maxLength)}
      problem={problem}
      name={input.name}
    >
      {(props) => <input {...props} {...input} />}
    </Labelled>
  );
}

/**
 * A form that sends once, shows why it was refused, and says so to a screen reader. `onSubmit`
 * rejects with the reason. AFS-140: a reason about one of its fields is shown at that field, which
 * is scrolled to and focused; it goes when that field is changed. Typing not sent yet is asked
 * about before the page is left.
 */
export function Form({
  onSubmit,
  submit,
  children,
  onCancel,
  quiet,
  wide,
  more,
  open,
  keeps = true,
  noValidate,
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
  /** AFS-140: the form was opened by a click: it is scrolled into view, its first field focused. */
  open?: boolean;
  /**
   * AFS-150: false for a form that saves nothing (a test message, a search): leaving it with typing
   * in it does not ask.
   */
  keeps?: boolean;
  /** AFS-150: the page checks every field itself and says it at the field (no browser tooltip). */
  noValidate?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ field?: string; message: string }>();
  const form = useRef<HTMLFormElement>(null);
  const notice = useRef<HTMLParagraphElement>(null);
  const claimed = useRef(new Map<string, number>());
  const claim = useCallback((field: string) => {
    claimed.current.set(field, (claimed.current.get(field) ?? 0) + 1);
    return () => {
      const n = (claimed.current.get(field) ?? 1) - 1;
      if (n > 0) claimed.current.set(field, n);
      else claimed.current.delete(field);
    };
  }, []);
  // The form stands for itself among the forms holding unsaved typing.
  const [self] = useState(() => ({}));
  useEffect(() => () => holdUnsaved(self, false), [self]);
  useEffect(() => {
    if (open) reveal(form.current, firstField(form.current));
  }, [open]);
  useEffect(() => {
    if (!problem) return;
    const named = problem.field ? form.current?.elements.namedItem(problem.field) : null;
    const at = named instanceof HTMLElement ? named : null;
    // A field folded away is unfolded, so its problem can be seen.
    at?.closest('details')?.setAttribute('open', '');
    if (at) reveal(at.closest('.field') ?? at, at);
    else reveal(notice.current);
  }, [problem]);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    // What is being sent is not lost: a page that moves on after it does not ask.
    holdUnsaved(self, false);
    try {
      await onSubmit();
    } catch (e) {
      const field = e instanceof ApiError ? e.details.field : undefined;
      setProblem({
        message: messageOf(e),
        ...(field && claimed.current.has(field) ? { field } : {}),
      });
      if (keeps && form.current?.isConnected) holdUnsaved(self, true);
    } finally {
      setBusy(false);
    }
  };
  // Typing marks the form unsaved, and a refusal goes once what it is about is changed.
  const changed = (event: FormEvent<HTMLFormElement>) => {
    if (keeps) holdUnsaved(self, true);
    const name = (event.target as HTMLInputElement).name;
    if (problem && (!problem.field || problem.field === name)) setProblem(undefined);
  };
  const context = useMemo(() => ({ problem, claim }), [problem, claim]);
  return (
    <form
      ref={form}
      onSubmit={send}
      onChange={changed}
      className={wide ? 'form wide' : 'form'}
      noValidate={noValidate}
    >
      <FormProblems.Provider value={context}>{children}</FormProblems.Provider>
      {problem && !problem.field && (
        <p className="notice error" role="alert" ref={notice} tabIndex={-1}>
          {problem.message}
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

/** This browser's time zone, as Intl names it (Europe/Berlin), or UTC. */
export const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/**
 * AFS-139: a time as people read it, in this browser's time zone and naming it ("18/11/2026,
 * 01:44:21 CET"): every page shows times in that one zone, said, never a bare UTC or local time.
 */
export function formatTime(at: string | Date, locale?: string): string {
  const date = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(date.getTime())) return String(at);
  return date.toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
}

/** A time as people read it (formatTime), with the exact time in UTC on hover. */
export function Time({ at }: { at?: string }) {
  if (!at) return <span className="muted">never</span>;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return <span>{at}</span>;
  return (
    <time dateTime={at} title={`${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`}>
      {formatTime(date)}
    </time>
  );
}

/**
 * AFS-139: reads a list again when the person comes back to the page (its tab or window shown
 * again) and, with `everyMs`, on a timer while it is shown: what changed elsewhere (a token used,
 * a schedule fired) shows without a reload.
 */
export function useRefresh(reload: () => void, everyMs?: number): void {
  useEffect(() => {
    const back = () => {
      if (document.visibilityState !== 'hidden') reload();
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    const timer = everyMs
      ? setInterval(() => {
          if (document.visibilityState !== 'hidden') reload();
        }, everyMs)
      : undefined;
    return () => {
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
      clearInterval(timer);
    };
  }, [reload, everyMs]);
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
        {/* AFS-142: the focus lands on the title after a page change (app.tsx). AFS-143: the
            help link sits beside the heading, not in it, so the heading's name stays the title. */}
        {help ? (
          <div className="title-line">
            <h1 tabIndex={-1}>{title}</h1>
            <HelpLink page={help} />
          </div>
        ) : (
          <h1 tabIndex={-1}>{title}</h1>
        )}
        {lead && <p className="muted">{lead}</p>}
      </div>
      {children && <div className="actions">{children}</div>}
    </header>
  );
}

/**
 * AFS-143: a link to the guide page about where it is, opened beside the app. AFS-155: the guide
 * this server serves.
 */
export function HelpLink({ page }: { page: string }) {
  return (
    <a className="help-link" href={guide(page)} target="_blank" rel="noopener">
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
          {/* AFS-144: as wide as in bold, so a tab keeps its width when it is the open one. */}
          <span className="tab-label" data-label={tab.label}>
            {tab.label}
          </span>
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

/** The workspaces' names by key, read once for the breadcrumbs; read again for a key it lacks. */
let spaceNames: Promise<Map<string, string>> | undefined;

/** AFS-144: a workspace in a breadcrumb by its name ("Network team"), not its key ("network"). */
export function WorkspaceName({ workspace }: { workspace: string }) {
  const [name, setName] = useState<string>();
  useEffect(() => {
    let live = true;
    spaceNames ??= api.workspaces().then(
      (list) => new Map(list.map((w) => [w.key, w.name])),
      () => new Map(),
    );
    const asked = spaceNames;
    void asked.then((names) => {
      const found = names.get(workspace);
      if (!found && spaceNames === asked) spaceNames = undefined;
      if (live) setName(found);
    });
    return () => {
      live = false;
    };
  }, [workspace]);
  return <>{name ?? workspace}</>;
}

/** The projects' names by workspace and key, read once per workspace for the breadcrumbs. */
const projectNames = new Map<string, Promise<Map<string, string>>>();

/** AFS-154: a project in a breadcrumb by its name ("Edge switches"), not its key ("edge"). */
export function ProjectName({ workspace, project }: { workspace: string; project: string }) {
  const [name, setName] = useState<string>();
  useEffect(() => {
    let live = true;
    let asked = projectNames.get(workspace);
    if (!asked) {
      asked = api.projects(workspace).then(
        (list) => new Map(list.map((p) => [p.key, p.name])),
        () => new Map(),
      );
      projectNames.set(workspace, asked);
    }
    const names = asked;
    void names.then((known) => {
      const found = known.get(project);
      // A project made since is read again next time.
      if (!found && projectNames.get(workspace) === names) projectNames.delete(workspace);
      if (live) setName(found);
    });
    return () => {
      live = false;
    };
  }, [workspace, project]);
  return (
    <span className="crumb-name" title={name ?? project}>
      {name ?? project}
    </span>
  );
}

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
export function Icon({ name }: { name: 'external' | 'fullscreen' | 'more' | 'info' }) {
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
      ) : name === 'info' ? (
        // AFS-165: "i" in a circle.
        <path d="M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 1 0 0-12.5M8 7.25v4M8 4.75h.01" />
      ) : (
        <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
      )}
    </svg>
  );
}

/**
 * AFS-154: each cell of the tables in `box` carries the name of its column (`data-label`), which
 * a phone shows beside the value when the table's rows stack into cards. A column whose heading
 * is only for screen readers (a row's buttons) gets none.
 */
export function labelCells(box: HTMLElement): void {
  for (const table of box.querySelectorAll('table')) {
    const heads = [...(table.tHead?.rows[0]?.cells ?? [])].map((th) =>
      th.classList.contains('sr-only') || th.querySelector(':scope > .sr-only:only-child')
        ? ''
        : (th.textContent ?? '').trim(),
    );
    for (const body of table.tBodies)
      for (const row of body.rows) {
        let column = 0;
        for (const cell of row.cells) {
          const label = cell.colSpan === 1 ? (heads[column] ?? '') : '';
          if (label) {
            if (cell.dataset.label !== label) cell.dataset.label = label;
          } else if (cell.dataset.label !== undefined) delete cell.dataset.label;
          column += cell.colSpan;
        }
      }
  }
}

/**
 * A box for a table that may be wider than the page: it scrolls sideways with a shade at the side
 * that has more. AFS-154: on a phone its rows stack instead (styles.css), each value named by its
 * column.
 */
export function Scroll({ children, className }: { children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const at = box.current;
    if (!at) return;
    labelCells(at);
    // Rows come and go with what is loaded; setting the labels is not a change watched here.
    const watch = new MutationObserver(() => labelCells(at));
    watch.observe(at, { childList: true, subtree: true, characterData: true });
    return () => watch.disconnect();
  }, []);
  return (
    <div ref={box} className={className ? `scroll ${className}` : 'scroll'}>
      {children}
    </div>
  );
}
