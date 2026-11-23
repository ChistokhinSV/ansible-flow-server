// AFS-179 (ADR-0038 §1): the Debugger panel of a debug run on its page. While the run is paused it
// shows why (the reason line), Retry at a failure pause (with its warning), Continue, Step and Stop
// (F10 Step, F8 Continue or Pause), a host picker that starts at the first failed or matching host,
// the host's variables by scope (opened lazily, Facts on request), Watch with "compare across
// hosts", and an Evaluate box (Ctrl+Enter). The answers come from the run itself
// (POST /runs/:id/inspect), masked there: a masked value says why, never its size.
// Only who launched the run (and administrators) drive it and see values; others watching see the
// reason line and who it waits for.
import type {
  InspectAnswer,
  InspectArgs,
  InspectOp,
  MaskKind,
  StepCommand,
  StepPause,
  VarEntry,
  VarScope,
} from '@ansible-flow/core/run/step';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, type Run } from './api';
import { ask } from './confirm';
import { type ShownStep, stepKey, stepLine, stepName, stopsIn } from './stepBar';
import { typingInField } from './typing';

/** A masked value's reason in words (never its size). */
export const MASK_WORDS: Record<MaskKind, string> = {
  vault: 'vault',
  no_log: 'no_log',
  credential: 'credential',
  external: 'external secret',
  name: 'secret-looking name',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The reason line: the step, the count of hosts and why it paused (pause point, step, condition,
 * failure, unreachable), and when it stops by itself.
 */
export function reasonLine(pause: StepPause, title: string, nowMs: number): string {
  const all = pause.hosts.length;
  let why: string;
  if (pause.kind === 'failure') {
    const failed = pause.failed ?? [];
    const unreachable = failed.filter((f) => f.unreachable).length;
    const words =
      unreachable === failed.length && unreachable > 0
        ? `${unreachable} of ${plural(all, 'host')} unreachable`
        : unreachable
          ? `${failed.length - unreachable} of ${plural(all, 'host')} failed, ${unreachable} unreachable`
          : `${failed.length} of ${plural(all, 'host')} failed`;
    why = `${words} (attempt ${pause.attempt ?? 1})`;
  } else if (pause.kind === 'condition')
    why = `condition held on ${pause.matched?.length ?? 0} of ${plural(all, 'host')}`;
  else if (pause.kind === 'point') why = `pause point · ${plural(all, 'host')}`;
  else why = `step · ${plural(all, 'host')}`;
  return `Paused ${pause.kind === 'failure' ? 'after' : 'before'} ${title} · ${why} · stops by itself in ${stopsIn(pause, nowMs)}`;
}

/** The host the picker starts at: the first failed, else the first matching, else the first. */
export function firstHost(pause: StepPause): string | undefined {
  return pause.failed?.[0]?.host ?? pause.matched?.[0] ?? pause.hosts[0];
}

/** The hosts a pause names, failed and matched first. */
export function hostOrder(pause: StepPause): { host: string; note?: string }[] {
  const failed = new Map((pause.failed ?? []).map((f) => [f.host, f]));
  const matched = new Set(pause.matched ?? []);
  const rank = (h: string) => (failed.has(h) ? 0 : matched.has(h) ? 1 : 2);
  const all = [...new Set([...(pause.failed ?? []).map((f) => f.host), ...pause.hosts])];
  return all
    .sort((a, b) => rank(a) - rank(b))
    .map((host) => {
      const f = failed.get(host);
      const note = f
        ? f.unreachable
          ? 'unreachable'
          : 'failed'
        : matched.has(host)
          ? 'matched'
          : undefined;
      return note ? { host, note } : { host };
    });
}

/** An expression as the run takes it: without the {{ }} around it. */
export const bare = (expr: string) =>
  expr
    .trim()
    .replace(/^\{\{\s*([\s\S]*?)\s*\}\}$/, '$1')
    .trim();

/** A value as the panel shows it: masked parts say why, other markers say what they are. */
export function shownValue(value: unknown): string {
  const marker = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(marker);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.__afd__ === 'masked') return `masked: ${MASK_WORDS[o.masked as MaskKind] ?? o.masked}`;
      if (o.__afd__ === 'template') return `${String(o.text ?? '')} (template)`;
      if (typeof o.__afd__ === 'string') return `(${o.__afd__})`;
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, marker(x)]));
    }
    return v;
  };
  const shown = marker(value);
  return typeof shown === 'string' ? JSON.stringify(shown) : (JSON.stringify(shown) ?? 'null');
}

/** One variable's value in words: masked, cut, a container's count, or the value. */
export function entryText(e: VarEntry | InspectAnswer): string {
  if (e.masked) return `masked: ${MASK_WORDS[e.masked] ?? e.masked}`;
  if ('type' in e && e.type === 'template')
    return `${String(e.value ?? '')} (template, not rendered)`;
  if ((e.type === 'dict' || e.type === 'list') && e.value === undefined)
    return `${e.type === 'dict' ? '{…}' : '[…]'} ${plural(e.count ?? 0, 'item')}`;
  // A scope's list names and sizes its variables without their values.
  if (e.value === undefined && e.type && e.type !== 'null')
    return e.size !== undefined ? `${e.type}, ${e.size} bytes` : e.type;
  const text = shownValue(e.value);
  return e.cut ? `${text}… (cut at ${e.cut} bytes)` : text;
}

/** An evaluate's or a watch's answer in words: refused, timed out, an error, or the value. */
export function answerText(a: InspectAnswer): { text: string; bad?: boolean } {
  if (a.refused) return { text: `Refused: ${a.error ?? 'not allowed in Evaluate'}`, bad: true };
  if (a.timeout) return { text: 'Took longer than 2 s: stopped', bad: true };
  if (a.error) return { text: `Error: ${a.error}`, bad: true };
  return { text: entryText(a) };
}

/** A watch's answers grouped by value: "compare across hosts". */
export function compareHosts(
  results: readonly (InspectAnswer & { host: string })[],
): { value: string; hosts: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const r of results) {
    const value = answerText(r).text;
    groups.set(value, [...(groups.get(value) ?? []), r.host]);
  }
  return [...groups].map(([value, hosts]) => ({ value, hosts }));
}

const isContainer = (e: VarEntry) => e.type === 'dict' || e.type === 'list';
const PAGE = 100;

type Ask = (op: InspectOp, args: InspectArgs) => Promise<InspectAnswer | undefined>;

/** One variable, its items read when it is opened. */
function VarRow({
  entry,
  scope,
  path,
  inspect,
}: {
  entry: VarEntry;
  scope: VarScope;
  path: (string | number)[];
  inspect: Ask;
}) {
  if (!isContainer(entry) || entry.masked || !entry.count)
    return (
      <li className="dbg-var">
        <span className="dbg-name">{String(entry.name)}</span>
        <span className={entry.masked ? 'dbg-value dbg-masked' : 'dbg-value'}>
          {entryText(entry)}
        </span>
      </li>
    );
  return (
    <li className="dbg-var">
      <Items
        label={String(entry.name)}
        summary={entryText(entry)}
        scope={scope}
        path={[...path, entry.name]}
        inspect={inspect}
      />
    </li>
  );
}

/** A scope or a container: its items, a page at a time, read the first time it opens. */
function Items({
  label,
  summary,
  scope,
  path,
  inspect,
  first,
}: {
  label: string;
  summary?: string;
  scope: VarScope;
  path: (string | number)[];
  inspect: Ask;
  first?: VarEntry[];
}) {
  const [items, setItems] = useState<VarEntry[] | undefined>(first);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string>();
  const read = async (start: number) => {
    const a = await inspect('vars', { scope, path, start, count: PAGE });
    if (!a) return;
    if (a.error) return setError(a.error);
    setItems((had) => [...(start ? (had ?? []) : []), ...(a.children ?? [])]);
    setMore(!!a.more);
  };
  return (
    <details
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && !items) void read(0);
      }}
    >
      <summary>
        <span className="dbg-name">{label}</span>
        {summary && <span className="dbg-value muted"> {summary}</span>}
      </summary>
      {error && <p className="bad-text small">{error}</p>}
      {items && (
        <ul className="dbg-vars">
          {items.length === 0 && <li className="muted small">Nothing here</li>}
          {items.map((e) => (
            <VarRow key={String(e.name)} entry={e} scope={scope} path={path} inspect={inspect} />
          ))}
        </ul>
      )}
      {more && (
        <button type="button" className="link" onClick={() => void read(items?.length ?? 0)}>
          Show more
        </button>
      )}
    </details>
  );
}

const WATCH_KEY = (run: Run) => `afs.watch.${run.project}.${run.flow.file}`;
function readWatches(run: Run): string[] {
  try {
    const kept = JSON.parse(window.localStorage.getItem(WATCH_KEY(run)) ?? '[]') as unknown;
    return Array.isArray(kept) ? kept.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function keepWatches(run: Run, list: string[]) {
  try {
    window.localStorage.setItem(WATCH_KEY(run), JSON.stringify(list));
  } catch {
    // Not kept: the list is for this page only.
  }
}

export function DebugPanel({
  run,
  step,
  mayDrive,
  launcher,
  onRun,
  onError,
}: {
  run: Run;
  step: ShownStep | undefined;
  /** Who launched it, or an administrator: drives it and sees values. */
  mayDrive: boolean;
  launcher: string;
  onRun(run: Run): void;
  onError(message: string | undefined): void;
}) {
  const pause = step?.paused;
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [host, setHost] = useState<string>();
  const [scopes, setScopes] = useState<InspectAnswer['scopes']>();
  const [scopeError, setScopeError] = useState<string>();
  const [watches, setWatches] = useState<string[]>(() => readWatches(run));
  const [watchText, setWatchText] = useState('');
  const [watched, setWatched] = useState<InspectAnswer['results']>();
  const [comparing, setComparing] = useState<string>();
  const [expr, setExpr] = useState('');
  const [evaluated, setEvaluated] = useState<{ expr: string; answer: InspectAnswer }>();
  const pauseId = pause?.id;
  const title = pause ? run.pausedBefore || stepName(pause.play) : '';

  useEffect(() => {
    if (!pause) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [pause]);

  /** A question to the run; undefined when the pause is over (said once, not as an error). */
  const inspect = useCallback<Ask>(
    async (op, args) => {
      try {
        return await api.inspectRun(run.id, { op, ...args });
      } catch (e) {
        if (e instanceof ApiError && e.status === 410) return undefined;
        return { error: (e as Error).message };
      }
    },
    [run.id],
  );
  const forHost = useCallback<Ask>(
    (op, args) => inspect(op, { ...args, ...(host ? { host } : {}) }),
    [inspect, host],
  );

  // A new pause starts at its first failed or matching host, and forgets the old answers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per pause
  useEffect(() => {
    setHost(pause ? firstHost(pause) : undefined);
    setScopes(undefined);
    setWatched(undefined);
    setEvaluated(undefined);
    setComparing(undefined);
  }, [pauseId]);

  const debuggable = !!pause && pause.debug !== false;
  // The host's scopes (names, types, sizes; no values until opened), again at each pause.
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again at each pause
  useEffect(() => {
    if (!mayDrive || !debuggable || !host) return;
    let live = true;
    setScopes(undefined);
    setScopeError(undefined);
    void inspect('scopes', { host }).then((a) => {
      if (!live || !a) return;
      if (a.error) setScopeError(a.error);
      else setScopes(a.scopes ?? []);
    });
    return () => {
      live = false;
    };
  }, [mayDrive, debuggable, host, pauseId, inspect]);

  // Watches: all the expressions for all paused hosts, in one question per pause and change.
  const watchKey = watches.join('\u0000');
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again when the list changes
  useEffect(() => {
    if (!mayDrive || !debuggable || watches.length === 0) {
      setWatched(undefined);
      return;
    }
    let live = true;
    void inspect('watch', { exprs: watches.map(bare) }).then((a) => {
      if (live && a) setWatched(a.results ?? (a.error ? [] : undefined));
    });
    return () => {
      live = false;
    };
  }, [mayDrive, debuggable, pauseId, watchKey, inspect]);

  const send = async (command: StepCommand) => {
    if (busy) return;
    if (
      command === 'retry' &&
      !(await ask(
        `Retry ${title} on ${(pause?.failed ?? []).map((f) => f.host).join(', ')}? The step runs again on those hosts. Changes it made on them are not undone.`,
        { yes: 'Retry' },
      ))
    )
      return;
    setBusy(true);
    try {
      onRun(await api.stepRun(run.id, { command }));
      onError(undefined);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;
  const paused = !!pause;
  useEffect(() => {
    if (!mayDrive) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || typingInField(e)) return;
      const command = stepKey(e, paused);
      if (!command) return;
      e.preventDefault();
      if (!e.repeat) void sendRef.current(command);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mayDrive, paused]);

  const evaluate = async () => {
    const text = bare(expr);
    if (!text || !host) return;
    const answer = await forHost('eval', { expr: text });
    if (answer) setEvaluated({ expr: text, answer });
  };
  const onEvalKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void evaluate();
    }
  };
  const addWatch = () => {
    const text = bare(watchText);
    if (!text || watches.includes(text)) return setWatchText('');
    const next = [...watches, text];
    setWatches(next);
    keepWatches(run, next);
    setWatchText('');
  };
  const dropWatch = (w: string) => {
    const next = watches.filter((x) => x !== w);
    setWatches(next);
    keepWatches(run, next);
  };

  const hosts = useMemo(() => (pause ? hostOrder(pause) : []), [pause]);
  const failedHosts = (pause?.failed ?? []).map((f) => f.host);
  const retryOffered = pause?.kind === 'failure' && !pause.retryRefused;
  const button = (
    command: StepCommand,
    label: string,
    titleText: string,
    options: { primary?: boolean; key?: string; off?: string } = {},
  ) => (
    <button
      type="button"
      className={command === 'stop' ? 'danger' : options.primary ? 'primary' : undefined}
      aria-disabled={busy || options.off ? true : undefined}
      title={`${options.off ?? titleText}${options.key ? ` (${options.key})` : ''}`}
      aria-keyshortcuts={options.key}
      data-step-command={command}
      onClick={() => {
        if (!options.off) void send(command);
      }}
    >
      {label}
    </button>
  );

  return (
    <section className={`debugger${pause ? ' paused' : ''}`} aria-label="Debugger" data-debugger>
      {/* The reason and the buttons stay in sight while the panel scrolls. */}
      <div className="debug-head">
        <div className="debug-reason" role="status" aria-live="polite" data-debug-reason>
          <strong>{pause ? reasonLine(pause, title, now) : stepLine(run, step, now)}</strong>
          {!mayDrive && (
            <span className="muted">
              {' '}
              · {pause ? `Paused by ${launcher}` : `Debugged by ${launcher}`}: only {launcher} or an
              administrator drives it and sees its variables
            </span>
          )}
          {pause?.debug === false && (
            <span className="warn-text"> · {pause.why ?? 'This run cannot show variables'}</span>
          )}
        </div>
        {mayDrive && (
          <div className="debug-actions">
            <span className="step-actions">
              {pause?.kind === 'failure' &&
                button('retry', 'Retry', `Run ${title} again on the hosts that failed`, {
                  primary: true,
                  ...(pause.retryRefused ? { off: pause.retryRefused } : {}),
                })}
              {paused
                ? button('continue', 'Continue', 'Run on; pause only at a pause point', {
                    key: 'F8',
                  })
                : button('pause', 'Pause', 'Pause before the next step', { key: 'F8' })}
              {button('step', 'Step', 'Run this step, then pause before the next one', {
                primary: pause?.kind !== 'failure',
                key: 'F10',
                ...(paused ? {} : { off: 'The run is going: Step answers its next pause' }),
              })}
              {button('stop', 'Stop', 'End the run before its next step; what ran is kept')}
            </span>
            {retryOffered && (
              <span className="debug-warn small" data-retry-warning>
                Retry runs {title} again on {failedHosts.join(', ')}. Changes on hosts are not
                undone.
              </span>
            )}
            {pause?.kind === 'failure' && pause.retryRefused && (
              <span className="muted small">{pause.retryRefused}</span>
            )}
          </div>
        )}
      </div>
      {mayDrive && pause && debuggable && (
        <div className="debug-body">
          <label className="debug-host">
            Host{' '}
            <select value={host ?? ''} onChange={(e) => setHost(e.target.value)} data-debug-host>
              {hosts.map((h) => (
                <option key={h.host} value={h.host}>
                  {h.note ? `${h.host} · ${h.note}` : h.host}
                </option>
              ))}
            </select>
          </label>
          {pause.kind === 'failure' &&
            pause.failed
              ?.filter((f) => f.host === host)
              .map((f) => (
                <p key={f.host} className="debug-failed small" data-debug-failed>
                  At “{f.task}”: {f.msg}
                </p>
              ))}
          <div className="debug-scopes" data-debug-scopes>
            {scopeError && <p className="bad-text small">{scopeError}</p>}
            {!scopes && !scopeError && <p className="muted small">Reading the variables…</p>}
            {scopes?.map((s) => (
              <Items
                key={`${host}:${s.id}`}
                label={s.name}
                summary={
                  s.expensive
                    ? '(read on request)'
                    : s.vars
                      ? plural(s.vars.length, 'variable')
                      : undefined
                }
                scope={s.id}
                path={[]}
                inspect={forHost}
              />
            ))}
          </div>

          <div className="debug-watch" data-debug-watch>
            <h3>Watch</h3>
            <ul className="dbg-vars">
              {watches.map((w) => {
                const mine = watched?.find((r) => r.expr === w && r.host === host);
                const said = mine ? answerText(mine) : undefined;
                const all = (watched ?? []).filter((r) => r.expr === w);
                return (
                  <li key={w} className="dbg-watch">
                    <code className="dbg-name">{`{{ ${w} }}`}</code>
                    <span className={said?.bad ? 'dbg-value bad-text' : 'dbg-value'}>
                      {said?.text ?? '…'}
                    </span>
                    <span className="dbg-watch-actions">
                      <button
                        type="button"
                        className="link"
                        aria-pressed={comparing === w}
                        onClick={() => setComparing(comparing === w ? undefined : w)}
                      >
                        Compare across hosts
                      </button>
                      <button
                        type="button"
                        className="link"
                        aria-label={`Remove the watch ${w}`}
                        onClick={() => dropWatch(w)}
                      >
                        Remove
                      </button>
                    </span>
                    {comparing === w && (
                      <table className="dbg-compare" data-debug-compare>
                        <tbody>
                          {compareHosts(all).map((g) => (
                            <tr key={g.value}>
                              <td className="mono">{g.value}</td>
                              <td>{g.hosts.join(', ')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </li>
                );
              })}
            </ul>
            <form
              className="debug-add"
              onSubmit={(e) => {
                e.preventDefault();
                addWatch();
              }}
            >
              <input
                value={watchText}
                onChange={(e) => setWatchText(e.target.value)}
                placeholder="vlan_id"
                aria-label="Expression to watch"
                data-debug-watch-input
              />
              <button type="submit">Add</button>
            </form>
          </div>

          <div className="debug-eval" data-debug-eval>
            <h3>Evaluate{host ? ` (${host})` : ''}</h3>
            <textarea
              rows={2}
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              onKeyDown={onEvalKey}
              placeholder="interfaces | selectattr('vlan', '==', vlan_id) | list | length"
              aria-label="Jinja expression to evaluate"
              aria-keyshortcuts="Control+Enter"
              data-debug-expr
            />
            <div className="debug-eval-row">
              <button type="button" onClick={() => void evaluate()} title="Ctrl+Enter">
                Evaluate
              </button>
              <span className="muted small">Read-only: lookups are refused, 2 s at most.</span>
            </div>
            {evaluated && (
              <pre
                className={answerText(evaluated.answer).bad ? 'dbg-result bad-text' : 'dbg-result'}
                data-debug-result
              >
                {answerText(evaluated.answer).text}
              </pre>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** AFS-179: what a debug run's pauses showed, kept with the run: read on its page after it ended. */
export function DebugKept({ run }: { run: Run }) {
  const [pauses, setPauses] = useState<Awaited<ReturnType<typeof api.runDebug>>['pauses']>();
  useEffect(() => {
    let live = true;
    api.runDebug(run.id).then(
      (r) => live && setPauses(r.pauses),
      () => live && setPauses([]),
    );
    return () => {
      live = false;
    };
  }, [run.id]);
  if (!pauses?.length) return null;
  return (
    <section aria-labelledby="debug-kept" data-debug-kept>
      <h2 id="debug-kept">What the pauses showed</h2>
      {pauses.map((p) => (
        <details key={p.pause}>
          <summary>{p.play ? stepName(p.play) : p.node}</summary>
          {p.entries.map((e) =>
            e.op === 'scopes' ? (
              <div key={`${e.op}:${e.host}`} className="small">
                <strong>{e.host}</strong>
                <ul className="dbg-vars">
                  {(e.answer.scopes ?? []).flatMap((s) =>
                    (s.vars ?? []).map((v) => (
                      <li key={`${s.id}:${String(v.name)}`} className="dbg-var">
                        <span className="dbg-name">{String(v.name)}</span>
                        <span className="dbg-value">{entryText(v)}</span>
                      </li>
                    )),
                  )}
                </ul>
              </div>
            ) : (
              <ul key={`${e.op}:${(e.exprs ?? []).join('|')}`} className="dbg-vars small">
                {(e.answer.results ?? []).map((r) => (
                  <li key={`${r.host}:${r.expr}`} className="dbg-var">
                    <span className="dbg-name">
                      {r.host}: {`{{ ${r.expr} }}`}
                    </span>
                    <span className="dbg-value">{answerText(r).text}</span>
                  </li>
                ))}
              </ul>
            ),
          )}
        </details>
      ))}
    </section>
  );
}
