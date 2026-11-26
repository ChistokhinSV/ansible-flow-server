// AFS-179: a debug run's debugger, in the views of the debug workbench (workbench.tsx, AFS-265):
// why it paused (the reason line), Continue, Step, Retry and Stop, the hosts the pause holds (the
// first failed or matching chosen), the chosen host's variables by scope (opened lazily, Facts on
// request), Watch with "compare across hosts", the pause points and failure filters, and the Debug
// Console (Evaluate, log point lines). The answers come from the run itself
// (POST /runs/:id/inspect), masked there: a masked value says why, never its size.
// Only who launched the run (and administrators) drive it and see values; others watching see the
// reason line and who it waits for, and an operator of the flow has Stop (AFS-253).
// AFS-250: watches are kept by the server for each person (not by the browser).
import { modelOf } from '@ansible-flow/core/flow/model';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import {
  type FailureFilters,
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
import {
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError, api, type Run } from './api';
import { ask } from './confirm';
import { type ShownStep, stepKey, stepLine, stepName, stopsIn } from './stepBar';
import { Icon, Time } from './ui';

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

/** AFS-265: the command a key gives a debug run: F5 (or F8) Continue or Pause, F10 Step, Shift+F5 Stop. */
export function debugKey(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  paused: boolean,
): StepCommand | undefined {
  if (e.key === 'F5' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) return 'stop';
  if (e.key === 'F5' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)
    return paused ? 'continue' : 'pause';
  return stepKey(e, paused);
}

/** What a paused run said to one Evaluate: the expression, the host and the answer. */
export interface Said {
  expr: string;
  host: string;
  answer: InspectAnswer;
}

/**
 * AFS-265: a debug run's state as its views share it (DebugWorkbench): the pause and its hosts,
 * the host chosen, its scopes, the watches and their answers, the Debug Console's lines, and the
 * commands. The answers come from the run itself (POST /runs/:id/inspect), masked there: a masked
 * value says why, never its size. Only who launched the run (and administrators) drive it and see
 * values; an operator of the flow has Stop (AFS-253). AFS-250: watches are kept by the server for
 * each person (not by the browser).
 */
export interface DebugSession {
  run: Run;
  step: ShownStep | undefined;
  pause: StepPause | undefined;
  /** The step the run is paused at, by its path. */
  title: string;
  now: number;
  mayDrive: boolean;
  mayStop: boolean;
  launcher: string;
  busy: boolean;
  /** The run answers questions at this pause. */
  debuggable: boolean;
  /** AFS-249: every host the pause holds (after a Retry the run names only the retried ones). */
  allHosts: string[];
  hosts: { host: string; note?: string }[];
  host: string | undefined;
  setHost(host: string): void;
  scopes: InspectAnswer['scopes'];
  scopeError: string | undefined;
  forHost: Ask;
  watches: string[];
  addWatch(text: string): void;
  dropWatch(expr: string): void;
  watched: InspectAnswer['results'];
  expr: string;
  setExpr(text: string): void;
  said: Said[];
  evaluate(): Promise<void>;
  /** The expressions evaluated at this pause, newest last (the console's history). */
  history: string[];
  logNames: ReadonlyMap<string, string>;
  /** The reason line: why it paused, or where it runs, or where it stopped. */
  reason: string;
  send(command: StepCommand): Promise<void>;
}

/** AFS-258: what was typed in Evaluate and its answers, per run and pause, for this page's life. */
interface ConsoleKept {
  expr: string;
  said: Said[];
}
const consoleKept = new Map<string, ConsoleKept>();
/** The Debug Console's lines kept per pause: the newest. */
const SAID_KEPT = 50;

export function useDebugSession({
  run,
  step,
  mayDrive,
  mayStop = false,
  launcher,
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
  onRun(run: Run): void;
  onError(message: string | undefined): void;
}): DebugSession {
  const pause = step?.paused;
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [host, setHost] = useState<string>();
  const [scopes, setScopes] = useState<InspectAnswer['scopes']>();
  const [scopeError, setScopeError] = useState<string>();
  const [watches, setWatches] = useState<string[]>([]);
  const [watched, setWatched] = useState<InspectAnswer['results']>();
  const pauseId = pause?.id;
  const keptKey = `${run.id}:${pauseId ?? ''}`;
  const [kept, setKept] = useState<ConsoleKept>(
    () => consoleKept.get(keptKey) ?? { expr: '', said: [] },
  );
  const keep = (next: ConsoleKept) => {
    consoleKept.set(keptKey, next);
    setKept(next);
  };
  const title = pause ? run.pausedBefore || stepName(pause.play) : '';
  // AFS-249: the hosts each step's pauses held: after a Retry the run names only the retried
  // hosts, but the others still wait there.
  const held = useRef(new Map<string, string[]>());
  const allHosts = useMemo(() => {
    if (!pause) return [];
    const before = held.current.get(pause.node) ?? [];
    const all = [
      ...new Set([...before, ...pause.hosts, ...(pause.failed ?? []).map((f) => f.host)]),
    ];
    held.current.set(pause.node, all);
    return all;
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
  // console kept for this pause stays: the views may have been drawn again, AFS-258).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per pause
  useEffect(() => {
    const had = consoleKept.get(keptKey);
    setHost(had?.said.at(-1)?.host ?? (pause ? firstHost(pause) : undefined));
    setScopes(undefined);
    setWatched(undefined);
    setKept(had ?? { expr: '', said: [] });
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
    if (!mayDrive && !(command === 'stop' && mayStop)) return;
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

  const evaluate = async () => {
    const text = bare(kept.expr);
    if (!text || !host) return;
    const answer = await forHost('eval', { expr: text });
    if (!answer) return;
    const now = consoleKept.get(keptKey) ?? kept;
    keep({ expr: '', said: [...now.said, { expr: text, host, answer }].slice(-SAID_KEPT) });
  };

  const hosts = useMemo(() => (pause ? hostOrder(pause, allHosts) : []), [pause, allHosts]);
  const reason = pause
    ? reasonLine(pause, title, now, { hosts: allHosts, ...(hits ? { hits } : {}) })
    : step?.stopped
      ? stoppedLine(
          step.stopped as StoppedAt,
          names.current.get(step.stopped.node) ?? run.pausedBefore ?? 'the step',
        )
      : stepLine(run, step, now);
  return {
    run,
    step,
    pause,
    title,
    now,
    mayDrive,
    mayStop,
    launcher,
    busy,
    debuggable,
    allHosts,
    hosts,
    host,
    setHost,
    scopes,
    scopeError,
    forHost,
    watches,
    addWatch: (text) => {
      const expr = bare(text);
      if (expr && !watches.includes(expr)) keepWatches([...watches, expr]);
    },
    dropWatch: (w) => keepWatches(watches.filter((x) => x !== w)),
    watched,
    expr: kept.expr,
    setExpr: (text) => keep({ ...(consoleKept.get(keptKey) ?? kept), expr: text }),
    said: kept.said,
    evaluate,
    history: kept.said.map((s) => s.expr),
    logNames,
    reason,
    send,
  };
}

/** AFS-265: the Variables view: the chosen host's scopes, read lazily (Facts on request). */
export function VariablesView({ s }: { s: DebugSession }) {
  if (!s.pause) return <p className="muted small wb-empty">The variables show at a pause.</p>;
  if (!s.debuggable)
    return <p className="warn-text small">{s.pause.why ?? 'This run cannot show variables'}</p>;
  const note = s.hosts.find((h) => h.host === s.host)?.note;
  return (
    <div className="debug-scopes" data-debug-scopes>
      <p className="wb-host-line small" data-debug-host-line>
        <span className="mono">{s.host}</span>
        {note && <span className={note === 'matched' ? 'muted' : 'bad-text'}> · {note}</span>}
      </p>
      {s.pause.kind === 'failure' &&
        s.pause.failed
          ?.filter((f) => f.host === s.host)
          .map((f) => (
            <p key={f.host} className="debug-failed small" data-debug-failed>
              At “{f.task}”: {f.msg}
            </p>
          ))}
      {s.scopeError && <p className="bad-text small">{s.scopeError}</p>}
      {!s.scopes && !s.scopeError && <p className="muted small">Reading the variables…</p>}
      {s.scopes?.map((scope) => (
        <Items
          key={`${s.host}:${scope.id}`}
          label={scope.name}
          summary={
            scope.expensive
              ? '(read on request)'
              : scope.vars
                ? plural(
                    scope.vars.filter((v) => !internalName(scope.id, v.name)).length,
                    'variable',
                  )
                : undefined
          }
          scope={scope.id}
          path={[]}
          inspect={s.forHost}
        />
      ))}
    </div>
  );
}

/**
 * AFS-265: the Watch view: each expression's value for the chosen host, with an inline "compare
 * across hosts" (the values grouped, each with its hosts) and a remove, and a box to add one.
 */
export function WatchView({ s }: { s: DebugSession }) {
  const [text, setText] = useState('');
  const [comparing, setComparing] = useState<string>();
  const pauseId = s.pause?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: closed at each pause
  useEffect(() => setComparing(undefined), [pauseId]);
  return (
    <div className="debug-watch" data-debug-watch>
      {s.watches.length === 0 && (
        <p className="muted small wb-empty">No watch yet: add an expression below.</p>
      )}
      <ul className="dbg-vars">
        {s.watches.map((w) => {
          const mine = s.watched?.find((r) => r.expr === w && r.host === s.host);
          const said = mine ? answerText(mine) : undefined;
          const all = (s.watched ?? []).filter((r) => r.expr === w);
          return (
            <li key={w} className="dbg-watch">
              <code className="dbg-name">{`{{ ${w} }}`}</code>
              <span className={said?.bad ? 'dbg-value bad-text' : 'dbg-value'}>
                {s.pause && s.debuggable ? (said?.text ?? '…') : 'shown at a pause'}
              </span>
              <span className="dbg-watch-actions">
                {s.pause && s.debuggable && (
                  <button
                    type="button"
                    className="icon-button wb-row-button"
                    aria-label={`Compare ${w} across hosts`}
                    title="Compare across hosts"
                    aria-pressed={comparing === w}
                    onClick={() => setComparing(comparing === w ? undefined : w)}
                  >
                    <Icon name="compare" />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button wb-row-button"
                  aria-label={`Remove the watch ${w}`}
                  title="Remove"
                  onClick={() => s.dropWatch(w)}
                >
                  <Icon name="close" />
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
          s.addWatch(text);
          setText('');
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="An expression, without {{ }}"
          aria-label="Expression to watch"
          data-debug-watch-input
        />
        <button type="submit">Add</button>
      </form>
    </div>
  );
}

/**
 * AFS-265: the Hosts view (VS Code's call stack): each host the pause holds, failed and matching
 * first, with its state and where it waits; choosing one sets the host of Variables, Watch and the
 * Debug Console, and marks it on the canvas.
 */
export function HostsView({ s, onHost }: { s: DebugSession; onHost?(host: string): void }) {
  if (!s.pause) return <p className="muted small wb-empty">The hosts show at a pause.</p>;
  const where = `${s.pause.kind === 'failure' ? 'after' : 'before'} ${s.title}`;
  return (
    <ul className="wb-hosts" aria-label="Hosts at the pause" data-debug-hosts>
      {s.hosts.map((h) => (
        <li key={h.host}>
          <button
            type="button"
            className="wb-host"
            aria-current={h.host === s.host ? 'true' : undefined}
            data-debug-host={h.host}
            onClick={() => {
              s.setHost(h.host);
              onHost?.(h.host);
            }}
          >
            <span className="mono">{h.host}</span>
            <span
              className={`small ${h.note === 'failed' || h.note === 'unreachable' ? 'bad-text' : 'muted'}`}
            >
              {h.note ?? 'waiting'} · {where}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * AFS-265: the Pause points view: "Pause on failure" and "Pause on unreachable" on top, then each
 * point with a box (cleared, it is taken off; a cleared one stays listed until the page is left, to
 * be put back with its settings) and its step, which shows the step on the canvas.
 */
export function PointsView({
  points,
  failures,
  names,
  disabled,
  onChange,
  onReveal,
  selected,
}: {
  points: readonly PointSpec[];
  failures: FailureFilters | undefined;
  names: ReadonlyMap<string, string>;
  /** Readers, and runs that are not debug runs (no failure filters). */
  disabled?: boolean;
  onChange(points: PointSpec[], failures?: FailureFilters): void;
  onReveal(node: string): void;
  /** The step chosen on the canvas. */
  selected?: string | undefined;
}) {
  const [off, setOff] = useState<PointSpec[]>([]);
  const on = new Set(points.map(pointNode));
  const listed = [...points, ...off.filter((p) => !on.has(pointNode(p)))];
  const failed = failures?.failed ?? true;
  const unreachable = failures?.unreachable ?? false;
  const settingsOf = (p: PointSpec) =>
    typeof p === 'string'
      ? ''
      : [
          p.condition ? `if ${p.condition}` : '',
          p.hits ? `after ${plural(p.hits, 'arrival')}` : '',
          p.log ? `logs “${p.log}”` : '',
        ]
          .filter(Boolean)
          .join(' · ');
  return (
    <div className="wb-points" data-debug-points>
      <fieldset className="wb-filters" disabled={disabled}>
        <legend className="sr-only">Which failures pause the run</legend>
        <label>
          <input
            type="checkbox"
            checked={failed}
            onChange={(e) => onChange([...points], { failed: e.target.checked, unreachable })}
          />{' '}
          Pause on failure
        </label>
        <label>
          <input
            type="checkbox"
            checked={unreachable}
            onChange={(e) => onChange([...points], { failed, unreachable: e.target.checked })}
          />{' '}
          Pause on unreachable
        </label>
      </fieldset>
      {listed.length === 0 && (
        <p className="muted small wb-empty">
          No pause point. Right-click a step on the canvas to add one.
        </p>
      )}
      <ul className="wb-point-list">
        {listed.map((p) => {
          const node = pointNode(p);
          const name = names.get(node) ?? 'A step';
          const settings = settingsOf(p);
          return (
            <li key={node} aria-current={selected === node ? 'true' : undefined}>
              <input
                type="checkbox"
                checked={on.has(node)}
                disabled={disabled}
                aria-label={`Pause at ${name}`}
                onChange={(e) => {
                  if (e.target.checked) {
                    setOff((was) => was.filter((x) => pointNode(x) !== node));
                    onChange([...points, p], failures);
                  } else {
                    setOff((was) => [...was.filter((x) => pointNode(x) !== node), p]);
                    onChange(
                      points.filter((x) => pointNode(x) !== node),
                      failures,
                    );
                  }
                }}
              />
              <button
                type="button"
                className="link wb-point-name"
                title="Show the step on the canvas"
                onClick={() => onReveal(node)}
              >
                {name}
              </button>
              {settings && <span className="muted small wb-point-settings">{settings}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * AFS-265: the Debug Console: the log points' lines, then each expression evaluated at this pause
 * and its answer, and the box for the next one (Enter evaluates, Shift+Enter is a new line,
 * the arrows up and down go through what was evaluated).
 */
export function ConsoleView({ s }: { s: DebugSession }) {
  const [back, setBack] = useState(-1);
  const end = useRef<HTMLDivElement>(null);
  const count = s.said.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the newest line in sight
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [count]);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      setBack(-1);
      void s.evaluate();
      return;
    }
    const single = !e.currentTarget.value.includes('\n');
    if (single && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && s.history.length) {
      e.preventDefault();
      const next =
        e.key === 'ArrowUp' ? Math.min(s.history.length - 1, back + 1) : Math.max(-1, back - 1);
      setBack(next);
      s.setExpr(next < 0 ? '' : (s.history[s.history.length - 1 - next] ?? ''));
    }
  };
  const ready = !!s.pause && s.debuggable;
  return (
    <div className="wb-console" data-debug-eval>
      <LogLines logs={s.step?.logs ?? []} names={s.logNames} />
      <ol className="wb-said" aria-label="Evaluated at this pause">
        {s.said.map((said, i) => {
          const a = answerText(said.answer);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines come in order and never move
            <li key={i}>
              <code className="wb-said-expr">
                <span className="muted">{said.host} ›</span> {said.expr}
              </code>
              <pre className={a.bad ? 'dbg-result bad-text' : 'dbg-result'} data-debug-result>
                {a.text}
              </pre>
            </li>
          );
        })}
      </ol>
      <div ref={end} />
      {ready ? (
        <div className="wb-prompt">
          <span className="wb-prompt-host mono muted" aria-hidden="true">
            {s.host} ›
          </span>
          <textarea
            rows={1}
            value={s.expr}
            onChange={(e) => s.setExpr(e.target.value)}
            onKeyDown={onKey}
            placeholder="A Jinja expression for this host: Enter evaluates"
            aria-label="Jinja expression to evaluate"
            aria-keyshortcuts="Enter Control+Enter"
            title="Read-only: lookups are refused, 2 s at most"
            data-debug-expr
          />
          <button type="button" onClick={() => void s.evaluate()} title="Enter">
            Evaluate
          </button>
        </div>
      ) : (
        <p className="muted small wb-empty">
          {s.pause ? (s.pause.why ?? 'This run cannot evaluate') : 'Evaluate works at a pause.'}
        </p>
      )}
    </div>
  );
}

/**
 * AFS-265: the one debug toolbar, over the canvas: Continue or Pause (F5), Step (F10), Retry (a
 * failure pause only), Stop (Shift+F5), and Restart (Run again, once the run has ended). Readers
 * have none of them; an operator of the flow has Stop (AFS-253).
 */
export function DebugToolbar({
  s,
  going,
  onRestart,
  continueRef,
}: {
  s: DebugSession;
  going: boolean;
  onRestart?: (() => void) | undefined;
  continueRef?: Ref<HTMLButtonElement>;
}) {
  const paused = !!s.pause;
  const button = (
    command: StepCommand,
    label: string,
    titleText: string,
    options: { primary?: boolean; key?: string; off?: string; ref?: Ref<HTMLButtonElement> } = {},
  ) => (
    <button
      type="button"
      ref={options.ref}
      className={`wb-tool${command === 'stop' ? ' danger' : options.primary ? ' primary' : ''}`}
      aria-disabled={s.busy || options.off ? true : undefined}
      title={`${options.off ?? titleText}${options.key ? ` (${options.key})` : ''}`}
      aria-keyshortcuts={options.key}
      data-step-command={command}
      onClick={() => {
        if (!options.off) void s.send(command);
      }}
    >
      <Icon name={command} />
      <span className="wb-tool-label">{label}</span>
    </button>
  );
  const retryOffered = s.pause?.kind === 'failure' && !s.pause.retryRefused;
  const failedHosts = (s.pause?.failed ?? []).map((f) => f.host);
  return (
    <div className="wb-toolbar" role="toolbar" aria-label="Debug" data-debugger>
      {going && s.mayDrive && (
        <>
          {paused
            ? button('continue', 'Continue', 'Run on; pause only at a pause point', {
                key: 'F5',
                primary: s.pause?.kind !== 'failure',
                ...(continueRef ? { ref: continueRef } : {}),
              })
            : button('pause', 'Pause', 'Pause before the next step', { key: 'F5' })}
          {button('step', 'Step', 'Run this step, then pause before the next one', {
            key: 'F10',
            ...(paused ? {} : { off: 'The run is going: Step answers its next pause' }),
          })}
          {s.pause?.kind === 'failure' &&
            button('retry', 'Retry', `Run ${s.title} again on the hosts that failed`, {
              primary: true,
              ...(s.pause.retryRefused ? { off: s.pause.retryRefused } : {}),
            })}
          {button('stop', 'Stop', 'End the run before its next step; what ran is kept', {
            key: 'Shift+F5',
          })}
        </>
      )}
      {going &&
        !s.mayDrive &&
        s.mayStop &&
        button('stop', 'Stop', `End ${s.launcher}'s run before its next step; what ran is kept`)}
      {!going && onRestart && (
        <button
          type="button"
          className="wb-tool"
          title="Run it again: the same commit, inputs and pause points"
          onClick={onRestart}
          data-restart
        >
          <Icon name="restart" />
          <span className="wb-tool-label">Restart</span>
        </button>
      )}
      {going && s.mayDrive && retryOffered && (
        <span className="debug-warn small wb-tool-note" data-retry-warning>
          Retry runs {s.title} again on {failedHosts.join(', ')}. Changes on hosts are not undone.
        </span>
      )}
      {going && s.mayDrive && s.pause?.kind === 'failure' && s.pause.retryRefused && (
        <span className="muted small wb-tool-note">{s.pause.retryRefused}</span>
      )}
    </div>
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
