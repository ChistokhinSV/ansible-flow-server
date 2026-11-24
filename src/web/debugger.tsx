// AFS-179 (ADR-0038 §1): the Debugger panel of a debug run on its page. While the run is paused it
// shows why (the reason line), Retry at a failure pause (with its warning), Continue, Step and Stop
// (F10 Step, F8 Continue or Pause), a host picker that starts at the first failed or matching host,
// the host's variables by scope (opened lazily, Facts on request), Watch with "compare across
// hosts", and an Evaluate box (Ctrl+Enter). The answers come from the run itself
// (POST /runs/:id/inspect), masked there: a masked value says why, never its size.
// Only who launched the run (and administrators) drive it and see values; others watching see the
// reason line and who it waits for, and an operator of the flow has Stop (AFS-253).
// AFS-250: watches are kept by the server for each person (not by the browser).
import { modelOf } from '@ansible-flow/core/flow/model';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import {
  type InspectAnswer,
  type InspectArgs,
  type InspectOp,
  type MaskKind,
  type PointLog,
  type PointSpec,
  pointNode,
  type StepCommand,
  type StepPause,
  stepPath,
  type VarEntry,
  type VarScope,
} from '@ansible-flow/core/run/step';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, type Run } from './api';
import { ask } from './confirm';
import { type ShownStep, stepKey, stepLine, stepName, stopsIn } from './stepBar';
import { Time } from './ui';

/** A masked value's reason in words (never its size). */
export const MASK_WORDS: Record<MaskKind, string> = {
  vault: 'vault',
  no_log: 'no_log',
  credential: 'credential',
  external: 'external secret',
  name: 'secret-looking name',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "a, b, c and 2 more": hosts named in a line, the first few. */
export function someHosts(hosts: readonly string[], shown = 3): string {
  if (hosts.length <= shown + 1) return hosts.join(', ');
  return `${hosts.slice(0, shown).join(', ')} and ${hosts.length - shown} more`;
}

/** What the reason line knows besides the pause: all the hosts the pause holds, the point's hits. */
export interface ReasonContext {
  /** AFS-249: every host the pause holds (after a Retry the run names only the retried ones). */
  hosts?: readonly string[];
  /** AFS-249: the pause point's "after N arrivals". */
  hits?: number;
}

/**
 * The reason line: the step, the count of hosts and why it paused (pause point, step, condition,
 * failure, unreachable), and when it stops by itself. AFS-249: a condition names the hosts it held
 * on; a point that only counts arrivals says so (not "condition held on 0 hosts").
 */
export function reasonLine(
  pause: StepPause,
  title: string,
  nowMs: number,
  context: ReasonContext = {},
): string {
  const all = Math.max(pause.hosts.length, context.hosts?.length ?? 0);
  const point = context.hits
    ? `pause point, after ${plural(context.hits, 'arrival')}`
    : 'pause point';
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
  } else if (pause.kind === 'condition' && pause.matched?.length)
    why = `condition held on ${someHosts(pause.matched)} (${pause.matched.length} of ${plural(all, 'host')})`;
  else if (pause.kind === 'point' || pause.kind === 'condition')
    why = `${point} · ${plural(all, 'host')}`;
  else why = `step · ${plural(all, 'host')}`;
  // The engine's words at a failure pause: "Paused after X: 1 of 4 hosts failed (attempt 2)".
  const where =
    pause.kind === 'failure' ? `Paused after ${title}: ${why}` : `Paused before ${title} · ${why}`;
  return `${where} · stops by itself in ${stopsIn(pause, nowMs)}`;
}

/**
 * What the engine says of a run stopped at a step boundary. At a failure pause (`after`) it names
 * the hosts that failed the step and the others, which stopped after it (typed loosely: older
 * engines send only the node, the hosts and the reason).
 */
export type StoppedAt = {
  node: string;
  hosts: string[];
  reason: 'driver' | 'timeout';
  after?: boolean;
  failed?: (string | { host: string })[];
};

/** "Stopped after Push baseline · 1 host failed, 3 stopped after it" (or "before X · 4 hosts"). */
export function stoppedLine(stopped: StoppedAt, title: string): string {
  const failed = (stopped.failed ?? []).map((f) => (typeof f === 'string' ? f : f.host));
  const by = stopped.reason === 'timeout' ? ' (nobody answered the pause)' : '';
  if (stopped.after) {
    const rest = stopped.hosts.filter((h) => !failed.includes(h));
    const parts = [
      ...(failed.length ? [`${plural(failed.length, 'host')} failed`] : []),
      ...(rest.length ? [`${rest.length} stopped after it`] : []),
    ];
    return `Stopped after ${title}${parts.length ? ` · ${parts.join(', ')}` : ''}${by}`;
  }
  return `Stopped before ${title} · ${plural(stopped.hosts.length, 'host')}${by}`;
}

/** The host the picker starts at: the first failed, else the first matching, else the first. */
export function firstHost(pause: StepPause): string | undefined {
  return pause.failed?.[0]?.host ?? pause.matched?.[0] ?? pause.hosts[0];
}

/** The hosts a pause names, failed and matched first (`held`: all it holds, AFS-249). */
export function hostOrder(
  pause: StepPause,
  held: readonly string[] = [],
): { host: string; note?: string }[] {
  const failed = new Map((pause.failed ?? []).map((f) => [f.host, f]));
  const matched = new Set(pause.matched ?? []);
  const rank = (h: string) => (failed.has(h) ? 0 : matched.has(h) ? 1 : 2);
  const all = [...new Set([...(pause.failed ?? []).map((f) => f.host), ...pause.hosts, ...held])];
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

/**
 * An expression as the run takes it: without the {{ }} around it. AFS-249: braces typed on one
 * side only ("{{ foo(") go too, so the run answers about the expression, not the braces.
 */
export function bare(expr: string): string {
  let e = expr.trim();
  const opens = e.startsWith('{{');
  const closes = e.endsWith('}}');
  if (opens) e = e.slice(2);
  if (closes && (opens || !e.includes('{{'))) e = e.slice(0, -2);
  return e.trim();
}

/** AFS-249: a template's text, as the run sends it ({__afd__: 'template', text}) or plain. */
const templateText = (v: unknown): string =>
  v && typeof v === 'object' && 'text' in v
    ? String((v as { text?: unknown }).text ?? '')
    : String(v ?? '');

/** "64 KB", "168.9 KB", "900 bytes". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return plural(bytes, 'byte');
  const kb = bytes / 1024;
  if (kb < 1024) return `${Number.isInteger(kb) ? kb : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/** A value as the panel shows it: masked parts say why, other markers say what they are. */
export function shownValue(value: unknown): string {
  const marker = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(marker);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.__afd__ === 'masked') return `masked: ${MASK_WORDS[o.masked as MaskKind] ?? o.masked}`;
      if (o.__afd__ === 'template') return `${String(o.text ?? '')} (template, not rendered)`;
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
    return `${templateText(e.value)} (template, not rendered)`;
  if ((e.type === 'dict' || e.type === 'list') && e.value === undefined)
    return `${e.type === 'dict' ? '{…}' : '[…]'} ${plural(e.count ?? 0, 'item')}`;
  // A scope's list names and sizes its variables without their values.
  if (e.value === undefined && e.type && e.type !== 'null')
    return e.size !== undefined ? `${e.type}, ${e.size} bytes` : e.type;
  const text = shownValue(e.value);
  // AFS-249: `cut` is the whole value's size; what is shown is its start.
  if (!e.cut) return text;
  const shown = new TextEncoder().encode(
    typeof e.value === 'string' ? e.value : (JSON.stringify(e.value) ?? ''),
  ).length;
  return `${text}… (cut at ${sizeWords(shown)} of ${sizeWords(e.cut)})`;
}

const NOT_CLOSED = 'Not a complete expression: a bracket or a quote is not closed';

/**
 * AFS-249: the run's refusal and error words as Evaluate says them: "lookups are not allowed in
 * Evaluate"; an expression left open is said so, not by the closing braces the run added.
 */
export function evalWords(error: string): string {
  const said = error.trim();
  if (
    /^(lookup|query|q)(\(\))? is not allowed\b/i.test(said) ||
    /\blookups? (are|is) not allowed/i.test(said)
  )
    return 'lookups are not allowed in Evaluate';
  if (/^Write an expression without/i.test(said))
    return 'Evaluate takes an expression: {% %} statements are not allowed';
  const open = /^Not a Jinja expression: ([\s\S]*)$/.exec(said);
  if (open) {
    const why = open[1] ?? '';
    if (/unexpected '\}'|unexpected (the )?end\b|end of template|expected token/i.test(why))
      return NOT_CLOSED;
    return `Not a Jinja expression: ${why}`;
  }
  if (/^an? (bracket|quote|brace) \(.{1,3}\) is not closed/i.test(said)) return NOT_CLOSED;
  return said.replace(/ while debugging(: it can read or run things)?/, ' in Evaluate');
}

/**
 * AFS-258: an expression that cannot be read (a bracket or a quote left open, not Jinja) is a
 * mistake in it, not a refusal: said without "Refused:".
 */
export const syntaxError = (error: string): boolean =>
  /^(Not a Jinja expression|Not a complete expression)\b/.test(evalWords(error));

/** An evaluate's or a watch's answer in words: refused, timed out, an error, or the value. */
export function answerText(a: InspectAnswer): { text: string; bad?: boolean } {
  if (a.error && syntaxError(a.error)) return { text: evalWords(a.error), bad: true };
  if (a.refused)
    return {
      text: `Refused: ${a.error ? evalWords(a.error) : 'not allowed in Evaluate'}`,
      bad: true,
    };
  if (a.timeout) return { text: 'Took longer than 2 s: stopped', bad: true };
  if (a.error) return { text: `Error: ${evalWords(a.error)}`, bad: true };
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
/**
 * AFS-249: the engine's own variables (afd_repo_root and the like) are not the step's inputs or
 * the flow's data: not listed there. AFS-258: nor the host's variables (afd_inputs).
 */
export const internalName = (scope: VarScope | undefined, name: string | number) =>
  (scope === 'inputs' || scope === 'flow' || scope === 'host') &&
  typeof name === 'string' &&
  /^afd_/.test(name);

/** AFS-258: a scope's name, where a kept answer has only its id. */
export const SCOPE_NAMES: Record<VarScope, string> = {
  inputs: 'Step inputs',
  host: 'Host variables',
  flow: 'Flow data',
  facts: 'Facts',
};
/** The variables of a scope or container as the panel lists them. */
const listed = (scope: VarScope, path: readonly unknown[], items: VarEntry[]) =>
  path.length ? items : items.filter((e) => !internalName(scope, e.name));

type Ask = (op: InspectOp, args: InspectArgs) => Promise<InspectAnswer | undefined>;

/** AFS-258: what was typed in Evaluate and its answer, per run and pause, for this page's life. */
interface EvalKept {
  expr: string;
  evaluated?: { expr: string; answer: InspectAnswer; host: string };
}
const evalKept = new Map<string, EvalKept>();

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
          {listed(scope, path, items).length === 0 && (
            <li className="muted small">
              {scope === 'facts' && !path.length
                ? 'No facts for this host yet: a step that gathers facts reads them'
                : 'Nothing here'}
            </li>
          )}
          {listed(scope, path, items).map((e) => (
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

/**
 * AFS-250: 1.2.0-rc.1 kept watches in the browser, where the next person signed in found them and
 * ran them in their own name. The server keeps them per person now; the browser's copy goes.
 */
const OLD_WATCH_KEY = (run: Run) => `afs.watch.${run.project}.${run.flow.file}`;
function forgetBrowserWatches(run: Run) {
  try {
    window.localStorage.removeItem(OLD_WATCH_KEY(run));
  } catch {
    // Nothing kept there.
  }
}

/** AFS-249: the settings of the pause point at a step (its hits), when the run has one. */
function pointAt(points: readonly PointSpec[] | undefined, node: string) {
  const p = points?.find((x) => pointNode(x) === node);
  return p && typeof p !== 'string' ? p : undefined;
}

/**
 * AFS-258: the titles of a run's steps by node id ("Pre-checks › Read device status" inside a
 * subflow), from the flow at the run's commit, read once there are log lines to name. Someone who
 * may not read the flow gets none: the lines then say "Log point".
 */
export function useStepNames(
  run: Pick<Run, 'project' | 'flow' | 'commit'>,
  wanted: boolean,
): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const { project, commit } = run;
  const file = run.flow.file;
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    api.flowView(project, file, commit).then(
      (v) => {
        if (!live || !v.snapshot.doc) return;
        const model = modelOf(v.snapshot.doc as unknown as FlowDocument);
        setNames(new Map([...model.nodes.keys()].map((id) => [id, stepPath(model, id)])));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [wanted, project, file, commit]);
  return names;
}

/** The log points' lines, newest last: the step, the host, the message or why it failed. */
export function LogLines({
  logs,
  names,
}: {
  logs: readonly PointLog[];
  names?: ReadonlyMap<string, string>;
}) {
  if (!logs.length) return null;
  return (
    <div className="debug-logs" data-debug-logs>
      <h3>Log points</h3>
      <ul className="dbg-vars">
        {logs.map((l, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: lines come in order and never move
            key={i}
            className="dbg-var"
          >
            <span className="dbg-name">
              {names?.get(l.node) ?? 'Log point'}
              {l.host ? ` · ${l.host}` : ''}
            </span>
            <span className={l.error ? 'dbg-value bad-text' : 'dbg-value'}>
              {l.error
                ? `${l.source === 'condition' ? 'The condition' : 'The message'} failed: ${l.error}`
                : l.message}
              {l.masked?.length ? (
                <span className="muted"> (masked: {l.masked.join(', ')})</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DebugPanel({
  run,
  step,
  mayDrive,
  mayStop = false,
  launcher,
  hidden,
  onRun,
  onError,
}: {
  run: Run;
  step: ShownStep | undefined;
  /** Who launched it, or an administrator: drives it and sees values. */
  mayDrive: boolean;
  /** AFS-253: an operator of the flow, who may Stop the run though not drive it. */
  mayStop?: boolean;
  launcher: string;
  /** AFS-250: on a phone, another tab is shown (the panel keeps its state). */
  hidden?: boolean;
  onRun(run: Run): void;
  onError(message: string | undefined): void;
}) {
  const pause = step?.paused;
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [host, setHost] = useState<string>();
  const [scopes, setScopes] = useState<InspectAnswer['scopes']>();
  const [scopeError, setScopeError] = useState<string>();
  const [watches, setWatches] = useState<string[]>([]);
  const [watchText, setWatchText] = useState('');
  const [watched, setWatched] = useState<InspectAnswer['results']>();
  const [comparing, setComparing] = useState<string>();
  const pauseId = pause?.id;
  const keptKey = `${run.id}:${pauseId ?? ''}`;
  const [expr, setExprState] = useState(() => evalKept.get(keptKey)?.expr ?? '');
  const [evaluated, setEvaluatedState] = useState(() => evalKept.get(keptKey)?.evaluated);
  const setExpr = (text: string) => {
    setExprState(text);
    evalKept.set(keptKey, { ...evalKept.get(keptKey), expr: text });
  };
  const setEvaluated = (said: EvalKept['evaluated']) => {
    setEvaluatedState(said);
    evalKept.set(keptKey, { expr: evalKept.get(keptKey)?.expr ?? '', evaluated: said });
  };
  const title = pause ? run.pausedBefore || stepName(pause.play) : '';
  // AFS-249: the hosts each step's pauses held: after a Retry the run names only the retried
  // hosts, but the others still wait there.
  const held = useRef(new Map<string, string[]>());
  const allHosts = useMemo(() => {
    if (!pause) return [];
    const before = held.current.get(pause.node) ?? [];
    const now = [
      ...new Set([...before, ...pause.hosts, ...(pause.failed ?? []).map((f) => f.host)]),
    ];
    held.current.set(pause.node, now);
    return now;
  }, [pause]);
  const hits = pause ? pointAt(run.step?.points, pause.node)?.hits : undefined;
  // The names of the steps the run paused at, for its log points' lines; AFS-258: and of every
  // step of the flow, so a log point where the run did not pause names its step too.
  const names = useRef(new Map<string, string>());
  if (pause) names.current.set(pause.node, title);
  const titles = useStepNames(run, mayDrive && !!step?.logs?.length);
  // biome-ignore lint/correctness/useExhaustiveDependencies: names grows with each pause
  const logNames = useMemo(() => new Map([...titles, ...names.current]), [titles, pauseId]);

  // AFS-250: this person's watches on the flow, from the server.
  const project = run.project;
  const flowFile = run.flow.file;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per flow
  useEffect(() => {
    if (!mayDrive) return;
    let live = true;
    forgetBrowserWatches(run);
    api.watches(project, flowFile).then(
      (w) => live && setWatches(w.exprs),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [mayDrive, project, flowFile]);
  const keepWatches = (list: string[]) => {
    setWatches(list);
    api.setWatches(project, flowFile, list).catch((e) => onError((e as Error).message));
  };

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

  // A new pause starts at its first failed or matching host, and forgets the old answers (the
  // Evaluate answer kept for this pause stays: the panel may have been drawn again, AFS-258).
  const firstPause = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per pause
  useEffect(() => {
    const kept = evalKept.get(keptKey);
    setHost(kept?.evaluated?.host ?? (pause ? firstHost(pause) : undefined));
    setScopes(undefined);
    setWatched(undefined);
    if (!firstPause.current || !kept) setEvaluatedState(kept?.evaluated);
    firstPause.current = false;
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
    // AFS-253: an operator stopping someone else's debug run is asked first, naming whose.
    if (
      command === 'stop' &&
      !mayDrive &&
      !(await ask(
        `Stop ${launcher}'s debug run #${run.number}? ${pause ? `It is paused ${pause.kind === 'failure' ? 'after' : 'before'} ${title}: its hosts stop there` : 'It stops before its next step'} and it cannot go on.`,
        { yes: 'Stop the run', danger: true },
      ))
    )
      return;
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
      if (e.defaultPrevented) return;
      // AFS-249: F10 and F8 type nothing: they drive the run from the Evaluate box too.
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
    if (answer) setEvaluated({ expr: text, answer, host });
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
    keepWatches([...watches, text]);
    setWatchText('');
  };
  const dropWatch = (w: string) => keepWatches(watches.filter((x) => x !== w));

  const hosts = useMemo(() => (pause ? hostOrder(pause, allHosts) : []), [pause, allHosts]);
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
    <section
      className={`debugger${pause ? ' paused' : ''}`}
      aria-label="Debugger"
      data-debugger
      id="run-debugger"
      hidden={hidden}
    >
      {/* The reason and the buttons stay in sight while the panel scrolls. */}
      <div className="debug-head">
        <div className="debug-reason" role="status" aria-live="polite" data-debug-reason>
          <strong>
            {pause
              ? reasonLine(pause, title, now, { hosts: allHosts, ...(hits ? { hits } : {}) })
              : step?.stopped
                ? stoppedLine(
                    step.stopped as StoppedAt,
                    names.current.get(step.stopped.node) ?? run.pausedBefore ?? 'the step',
                  )
                : stepLine(run, step, now)}
          </strong>
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
        {/* AFS-253: an operator of the flow may still Stop it (the server lets them). */}
        {!mayDrive && mayStop && (
          <div className="debug-actions">
            <span className="step-actions">
              {button(
                'stop',
                'Stop',
                `End ${launcher}'s run before its next step; what ran is kept`,
              )}
            </span>
          </div>
        )}
        {mayDrive && (
          <div className="debug-actions">
            <span className="step-actions">
              {pause?.kind === 'failure' &&
                button('retry', 'Retry', `Run ${title} again on the hosts that failed`, {
                  primary: true,
                  ...(pause.retryRefused ? { off: pause.retryRefused } : {}),
                })}
              {button('step', 'Step', 'Run this step, then pause before the next one', {
                primary: pause?.kind !== 'failure',
                key: 'F10',
                ...(paused ? {} : { off: 'The run is going: Step answers its next pause' }),
              })}
              {paused
                ? button('continue', 'Continue', 'Run on; pause only at a pause point', {
                    key: 'F8',
                  })
                : button('pause', 'Pause', 'Pause before the next step', { key: 'F8' })}
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
                      ? plural(s.vars.filter((v) => !internalName(s.id, v.name)).length, 'variable')
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
                placeholder="An expression, without {{ }}"
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
              placeholder="A Jinja expression for this host"
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
          <LogLines logs={step?.logs ?? []} names={logNames} />
        </div>
      )}
      {/* Log points of a run going on (no pause now): their lines so far. */}
      {mayDrive && !pause && <LogLines logs={step?.logs ?? []} names={logNames} />}
    </section>
  );
}

type KeptPause = Awaited<ReturnType<typeof api.runDebug>>['pauses'][number];
type KeptEntry = KeptPause['entries'][number];

/**
 * AFS-249: one host's part of a kept pause: each scope with the values it showed when it was
 * opened (else its variables' names and how many), and each watch once, as last answered.
 */
export function keptHosts(pause: KeptPause): {
  host: string;
  scopes: { id: VarScope; name: string; vars: VarEntry[]; opened: boolean }[];
  watches: { expr: string; answer: InspectAnswer }[];
}[] {
  const hosts = new Map<
    string,
    {
      scopes: Map<VarScope, { id: VarScope; name: string; vars: VarEntry[]; opened: boolean }>;
      watches: Map<string, InspectAnswer>;
    }
  >();
  const of = (host: string) => {
    let h = hosts.get(host);
    if (!h) {
      h = { scopes: new Map(), watches: new Map() };
      hosts.set(host, h);
    }
    return h;
  };
  const byTime = [...pause.entries].sort((a, b) => a.at.localeCompare(b.at));
  for (const e of byTime as KeptEntry[]) {
    if (e.op === 'scopes' && e.host)
      for (const s of e.answer.scopes ?? []) {
        const h = of(e.host);
        const had = h.scopes.get(s.id);
        if (!had?.opened)
          h.scopes.set(s.id, {
            id: s.id,
            name: s.name,
            vars: (s.vars ?? []).filter((v) => !internalName(s.id, v.name)),
            opened: false,
          });
      }
    else if (e.op === 'vars' && e.host && e.scope) {
      const h = of(e.host);
      const scope = e.scope;
      h.scopes.set(scope, {
        id: scope,
        name: h.scopes.get(scope)?.name ?? SCOPE_NAMES[scope] ?? scope,
        vars: (e.answer.children ?? []).filter((v) => !internalName(scope, v.name)),
        opened: true,
      });
    } else if (e.op === 'watch')
      // A later answer to the same watch (the list grew) replaces the earlier one.
      for (const r of e.answer.results ?? []) of(r.host).watches.set(r.expr, r);
  }
  return [...hosts].map(([host, h]) => ({
    host,
    scopes: [...h.scopes.values()],
    watches: [...h.watches].map(([expr, answer]) => ({ expr, answer })),
  }));
}

/**
 * AFS-179: what a debug run's pauses showed, kept with the run: read on its page after it ended.
 * AFS-249: values where a scope was opened, each watch once, and pauses at one step told apart.
 */
export function DebugKept({ run, logs }: { run: Run; logs?: readonly PointLog[] }) {
  const [pauses, setPauses] = useState<KeptPause[]>();
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
  const titles = useStepNames(run, !!logs?.length);
  const names = useMemo(
    () =>
      new Map([
        ...titles,
        ...(pauses ?? []).map((p) => [p.node, p.play ? stepName(p.play) : p.node] as const),
      ]),
    [pauses, titles],
  );
  if (!pauses?.length && !logs?.length) return null;
  const atStep = (p: KeptPause) => (pauses ?? []).filter((q) => q.node === p.node);
  return (
    <section aria-labelledby="debug-kept" data-debug-kept>
      <h2 id="debug-kept">What the pauses showed</h2>
      {(pauses ?? []).map((p) => {
        const same = atStep(p);
        const first = [...p.entries].sort((a, b) => a.at.localeCompare(b.at))[0]?.at;
        return (
          <details key={p.pause}>
            <summary>
              {p.play ? stepName(p.play) : p.node}
              {same.length > 1 && (
                <span className="muted">
                  {' '}
                  · pause {same.indexOf(p) + 1} of {same.length} here
                </span>
              )}
              {first && (
                <span className="muted small debug-kept-time">
                  {' '}
                  · <Time at={first} />
                </span>
              )}
            </summary>
            {keptHosts(p).map((h) => (
              <div key={h.host} className="small debug-kept-host">
                <strong>{h.host}</strong>
                {h.scopes.map((s) => (
                  <div key={s.id}>
                    <span className="muted">
                      {s.name}
                      {s.opened ? '' : `: not opened (${plural(s.vars.length, 'variable')})`}
                    </span>
                    {s.opened && (
                      <ul className="dbg-vars">
                        {s.vars.length === 0 && <li className="muted">Nothing here</li>}
                        {s.vars.map((v) => (
                          <li key={String(v.name)} className="dbg-var">
                            <span className="dbg-name">{String(v.name)}</span>
                            <span className={v.masked ? 'dbg-value dbg-masked' : 'dbg-value'}>
                              {entryText(v)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
                {h.watches.length > 0 && (
                  <ul className="dbg-vars">
                    {h.watches.map((w) => (
                      <li key={w.expr} className="dbg-var">
                        <span className="dbg-name">{`{{ ${w.expr} }}`}</span>
                        <span className="dbg-value">{answerText(w.answer).text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </details>
        );
      })}
      <LogLines logs={logs ?? []} names={names} />
    </section>
  );
}

/** AFS-250: whether a media query holds now (the page follows the window as it changes). */
export function useNarrow(query: string): boolean {
  const holdsNow = () =>
    typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [holds, setHolds] = useState(holdsNow);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per query
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const changed = () => setHolds(list.matches);
    changed();
    list.addEventListener?.('change', changed);
    return () => list.removeEventListener?.('change', changed);
  }, [query]);
  return holds;
}
