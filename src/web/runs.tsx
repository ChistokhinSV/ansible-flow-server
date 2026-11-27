// The run pages: every run, newest first; and one run, live while it goes, in the debug workbench
// (AFS-64, AFS-265): its canvas, the side bar with the approval that waits, its hosts and what ran
// (and a debug run's views), its output and what went wrong in the panel below.

import type { RunView } from '@ansible-flow/core/protocol';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { atLeast, flowLevel, launchesAny, useMyAccess, useProjectAccess } from './access';
import { AnsiText } from './ansi';
import {
  api,
  type HostAt,
  type HostSets,
  type Project,
  type RelaunchBody,
  type Run,
  type RunsFilter,
  runCursor,
  type User,
  type Workspace,
} from './api';
import { APPROVALS_CHANGED, RunApprovals } from './approvals';
import { ask } from './confirm';
import { DebugKept } from './debugger';
import { environmentAddress } from './environments';
import { Missing } from './help';
import { decidedOutcomes, quietEndOrigins } from './outputText';
import { Link, navigate, useSearch } from './router';
import { RunAgainMenu, relaunchWords } from './runAgain';
import { useFrameFeed, useRunFeed } from './runFeed';
import { RunStepBar } from './stepBar';
import type { ThemeChoice } from './theme';
import {
  ago,
  Breadcrumb,
  formatTime,
  HelpButton,
  Icon,
  Loading,
  PageHead,
  span,
  Time,
  useLoad,
  WorkspaceFilter,
  WorkspaceName,
} from './ui';
import { stopQuestion } from './viewerRuns';
import { DebugWorkbench, useWorkbenchState } from './workbench';

export const ACTIVE = ['queued', 'running', 'waiting'];
/**
 * AFS-205: a run's state as the pages say it: a step-by-step run paused before a step is "paused"
 * (the API says `running`, with `pausedBefore`), not "running".
 */
export const shownState = (run: { state: string; pausedBefore?: string | undefined }): string =>
  run.state === 'running' && run.pausedBefore ? 'paused' : run.state;
/** AFS-143: a person as the pages show people: by name (the login on hover). */
export const personOf = (p: { login: string; name?: string | undefined }) => p.name || p.login;
/** How many runs the list asks for at once. */
const PAGE = 100;

const LABEL: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  waiting: 'waiting for a decision',
  // AFS-205: a step-by-step run that waits for Step or Continue.
  paused: 'paused',
  // AFS-143: the words of the lists (went well, stopped), on the badge too.
  succeeded: 'went well',
  failed: 'failed',
  cancelled: 'stopped',
  lost: 'lost',
};

/** AFS-146: a run that failed because its approval was decided against says so. */
const AGAINST: Record<string, string> = {
  rejected: 'rejected',
  'timed out': 'not decided in time',
};

export function StateBadge({ state, against }: { state: string; against?: string | undefined }) {
  if (state === 'failed' && against && AGAINST[against])
    return (
      <span className="badge bad">
        <StateGlyph state={state} against={against} />
        {AGAINST[against]}
      </span>
    );
  const tone =
    state === 'succeeded'
      ? 'ok'
      : ['failed', 'lost'].includes(state)
        ? 'bad'
        : state === 'waiting' || state === 'paused'
          ? 'warn'
          : ACTIVE.includes(state)
            ? 'busy'
            : '';
  return (
    <span className={`badge ${tone}`}>
      <StateGlyph state={state} />
      {LABEL[state] ?? state}
    </span>
  );
}

const CIRCLE = 'M8 2.25a5.75 5.75 0 1 0 0 11.5a5.75 5.75 0 1 0 0-11.5';
const DIAMOND = 'M8 1.75 14.25 8 8 14.25 1.75 8z';
/**
 * ADR-0039 §3: every state has a shape of its own, so it reads without its colour (a person who
 * does not tell red from green, a projector, a grey print). The word stays the accessible text.
 */
const SHAPES: Record<string, string> = {
  queued: CIRCLE,
  running: 'M8 2.25a5.75 5.75 0 0 1 5.75 5.75',
  paused: `${CIRCLE}M6.5 5.75v4.5M9.5 5.75v4.5`,
  // The approval's own shape on the canvas.
  waiting: `${DIAMOND}M8 5.5v3M8 10.6h.01`,
  ok: `${CIRCLE}M5.4 8.2l1.8 1.8 3.4-3.7`,
  failed: `${CIRCLE}M6 6l4 4M10 6l-4 4`,
  against: `${DIAMOND}M6.4 6.4l3.2 3.2M9.6 6.4l-3.2 3.2`,
  stopped: `${CIRCLE}M6.25 6.25h3.5v3.5h-3.5z`,
  lost: 'M8 2.25a5.75 5.75 0 0 1 5.75 5.75M8 13.75A5.75 5.75 0 0 1 2.25 8M8 5.5v3M8 10.6h.01',
};
const SHAPE_OF: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  paused: 'paused',
  waiting: 'waiting',
  succeeded: 'ok',
  failed: 'failed',
  cancelled: 'stopped',
  lost: 'lost',
};

/** The shape of a run's state: `against` when its approval was decided against it (AFS-146). */
export const shapeOf = (state: string, against?: string): string =>
  state === 'failed' && against && AGAINST[against] ? 'against' : (SHAPE_OF[state] ?? 'queued');

export function StateGlyph({ state, against }: { state: string; against?: string | undefined }) {
  const shape = shapeOf(state, against);
  return (
    <svg
      className={`state-glyph glyph-${shape}`}
      data-glyph={shape}
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
      {shape === 'running' && <path d={CIRCLE} opacity="0.3" />}
      <path d={SHAPES[shape]} {...(shape === 'queued' ? { strokeDasharray: '2.2 2' } : {})} />
    </svg>
  );
}

/**
 * ADR-0039 §4: a real run changes the hosts and a check run does not, so they look different
 * everywhere: a solid badge and a dashed one, not a word among the facts.
 */
export function ModeBadge({ mode, long = false }: { mode: string; long?: boolean }) {
  const real = mode === 'real';
  const word = real ? 'real' : 'check';
  return (
    <span
      className={`mode-badge ${word}`}
      data-mode={word}
      title={
        real
          ? 'A real run: it changes the hosts'
          : "A check run: Ansible's check mode (tasks with check_mode: false still run)"
      }
    >
      {real && (
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
          <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" />
        </svg>
      )}
      {long ? `${word} run` : word}
    </span>
  );
}

/**
 * Runs as rows (AFS-82): the flow and its run number, who started it and when, check or real,
 * from which configuration; where it stands in coloured words at the end.
 */
export function RunList({
  runs,
  me,
  showConfig = true,
  workspaceOf,
}: {
  runs: Run[];
  me?: User;
  showConfig?: boolean;
  /**
   * AFS-212, AFS-274: a list of several workspaces names each run's in a column of its own, the
   * first of the facts (on a phone, the first on the run's second line).
   */
  workspaceOf?: (run: Run) => string | undefined;
}) {
  // AFS-95: runs are read down a column (which failed, whose, when), so each fact has its own;
  // where there is no room for columns (a phone, a narrow pane) a run is two lines again.
  const kind = `list runs${workspaceOf ? ' with-workspace' : ''}${showConfig ? '' : ' no-config'}`;
  return (
    <div className="runs-box">
      <ul className={kind}>
        <li className="runs-head" aria-hidden="true">
          <span>State</span>
          <span>Run</span>
          {workspaceOf && <span>Workspace</span>}
          {showConfig && <span>Configuration</span>}
          <span>Mode</span>
          <span>By</span>
          <span>Started</span>
          <span>Commit</span>
        </li>
        {runs.map((run) => (
          <li key={run.id}>
            <Link to={`/runs/${run.id}`}>
              <span className="c-state">
                <RunWords state={shownState(run)} against={run.decidedAgainst} />
              </span>
              <span className="title">
                {run.flow.name} <span className="muted">#{run.number}</span>
                {/* AFS-205: a step-by-step run is marked in the lists, as on its page. */}
                {run.step && (
                  <>
                    {' '}
                    <span
                      className="badge"
                      title={
                        run.pausedBefore
                          ? `Paused at ${run.pausedBefore}: it goes on when someone says Step or Continue`
                          : run.step.debug
                            ? 'A debug run: pauses at its pause points and where a host fails'
                            : 'Pauses before its steps until someone says Step or Continue'
                      }
                      {...(run.step.debug ? { 'data-debug-badge': true } : {})}
                    >
                      {/* AFS-249: a debug run says so in the lists, as on its page. */}
                      {run.step.debug ? 'debug run' : 'step by step'}
                    </span>
                  </>
                )}
                {run.dev && (
                  <>
                    {' '}
                    <span className="badge" title="A check run of someone's unpushed work">
                      dev run
                    </span>
                  </>
                )}
                {run.schedule && (
                  <>
                    {' '}
                    <span className="badge" title="Launched by a schedule">
                      scheduled
                    </span>
                  </>
                )}
              </span>
              {/* The facts are cells of the row; with no room for columns they are one line
                  under the run. */}
              <span className="c-facts">
                {workspaceOf && <span className="c-fact">{workspaceOf(run) ?? ''}</span>}
                {showConfig && <span className="c-fact">{run.config?.name ?? ''}</span>}
                <span className="c-fact">
                  <ModeBadge mode={run.mode} />
                </span>
                <span className="c-fact" title={run.requestedBy.login}>
                  {personOf(run.requestedBy)}
                </span>
                <span className="c-fact">{ago(run.startedAt ?? run.createdAt)}</span>
                <span className="c-fact mono">{run.commit.slice(0, 8)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Filters a list of runs by state: a row of choices, one picked. */
function StateChoices({ value, onChange }: { value: string; onChange(state: string): void }) {
  const choices: [string, string][] = [
    ['', 'All'],
    // AFS-232: what Home counts as still going: queued, or running and not paused.
    ['going', 'Going'],
    ['running', 'Running'],
    ['waiting', 'Waiting'],
    // AFS-205: step-by-step runs paused before a step (Waiting has them too).
    ['paused', 'Paused'],
    ['failed', 'Failed'],
    // AFS-193: a run whose approval was rejected (or not decided in time) is not a failure.
    ['rejected', 'Rejected'],
    ['succeeded', 'Went well'],
    ['queued', 'Queued'],
    ['cancelled', 'Stopped'],
    ['lost', 'Lost'],
  ];
  return (
    <fieldset className="chips">
      <legend className="sr-only">State</legend>
      {choices.map(([state, label]) => (
        <label key={state || 'all'} className={value === state ? 'chip on' : 'chip'}>
          <input
            type="radio"
            name="run-state"
            value={state}
            checked={value === state}
            onChange={() => onChange(state)}
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

/** Every project the person can see, workspace by workspace. */
interface Place {
  workspace: Workspace;
  projects: Project[];
}
const places = async (): Promise<Place[]> =>
  Promise.all(
    (await api.workspaces()).map(async (workspace) => ({
      workspace,
      // A workspace that does not answer is left out, not the reason for an empty list.
      projects: await api.projects(workspace.key).catch(() => []),
    })),
  );

const STATES = [
  'going',
  'running',
  'waiting',
  'paused',
  'failed',
  'rejected',
  'succeeded',
  'queued',
  'cancelled',
  'lost',
];

/** The choices the address holds (AFS-86), so that a reload or a shared link shows the same list. */
interface Choices {
  state: string;
  /** AFS-274: a workspace's key: its runs only. */
  workspace: string;
  project: string;
  /** A launch configuration of the project chosen. */
  config: string;
  /** Only the runs the person asked for themself. */
  mine: boolean;
  /** AFS-147: words in the flow's or configuration's name, a login, or a run's number. */
  q: string;
}
function choicesInAddress(): Choices {
  const query = new URLSearchParams(window.location.search);
  const state = query.get('state') ?? '';
  const project = query.get('project') ?? '';
  return {
    state: STATES.includes(state) ? state : '',
    workspace: (query.get('workspace') ?? '').slice(0, 100),
    project,
    // A configuration is one of a project's: without its project it is not a choice.
    config: project ? (query.get('config') ?? '') : '',
    mine: query.get('mine') === '1',
    q: (query.get('q') ?? '').slice(0, 200),
  };
}

/**
 * The newest page read again, over what is shown: older runs loaded with "Older runs" stay
 * under it. When the newest page is not full there is nothing older, and it is the whole list.
 */
function merged(shown: Run[], newest: Run[]): Run[] {
  const last = newest.at(-1);
  if (!last || newest.length < PAGE) return newest;
  const ids = new Set(newest.map((r) => r.id));
  return [...newest, ...shown.filter((r) => !ids.has(r.id) && r.createdAt <= last.createdAt)];
}

/**
 * The runs a filter gives, a page at a time: the newest page, read again while runs go, and
 * older pages added under it when asked for. Rows carry the filter they answer: the list of the
 * last filter stays until the new one is there (`fresh` says which it is), and nothing read for
 * another filter is added to it.
 */
export function useRunPages(filter: RunsFilter) {
  const key = JSON.stringify(filter);
  const list = useLoad(
    async () => ({ key, runs: await api.runs({ ...filter, limit: PAGE }) }),
    [key],
  );
  const [shown, setShown] = useState<{ key: string; runs: Run[] }>();
  // Older runs: none left once a page comes back short. Said of one filter, like the rows.
  const [olderOf, setOlder] = useState<{
    key: string;
    busy?: boolean;
    end?: boolean;
    error?: string;
  }>();
  const older = olderOf?.key === key ? olderOf : undefined;
  const current = useRef(key);
  current.current = key;

  const newest = list.data;
  useEffect(() => {
    if (newest)
      setShown((before) => ({
        key: newest.key,
        runs: merged(before?.key === newest.key ? before.runs : [], newest.runs),
      }));
  }, [newest]);
  const rows = shown?.runs;
  const fresh = shown?.key === key;

  const going = rows?.some((r) => ACTIVE.includes(r.state));
  // While runs go, the list keeps up with them.
  useEffect(() => {
    if (!going) return;
    const timer = setInterval(list.reload, 5000);
    return () => clearInterval(timer);
  }, [going, list.reload]);

  const last = rows?.at(-1);
  const more = fresh && !!last && !older?.end && (newest?.runs.length ?? 0) >= PAGE;
  const loadOlder = async () => {
    if (!last || older?.busy) return;
    setOlder({ key, busy: true });
    try {
      // The next page starts after the last row: its time alone would skip the runs made in
      // the same moment, so the server is told which run it was.
      const page = await api.runs({ ...filter, limit: PAGE, before: runCursor(last) });
      if (current.current !== key) return;
      setShown((before) => {
        if (before?.key !== key) return before;
        const ids = new Set(before.runs.map((r) => r.id));
        return { key, runs: [...before.runs, ...page.filter((r) => !ids.has(r.id))] };
      });
      setOlder({ key, end: page.length < PAGE });
    } catch (e) {
      if (current.current === key) setOlder({ key, error: (e as Error).message });
    }
  };
  return {
    list,
    /** The rows shown; of the filter asked for when `fresh`. */
    rows,
    fresh,
    more,
    busy: !!older?.busy,
    end: !!older?.end,
    error: older?.error,
    loadOlder,
  };
}

/** Under a list of runs: the button for the next page, and what went wrong or that it ended. */
export function OlderRuns({ pages }: { pages: ReturnType<typeof useRunPages> }) {
  return (
    <>
      {pages.error && (
        <p className="notice error" role="alert">
          {pages.error}
        </p>
      )}
      {pages.more && (
        <p className="run-more">
          <button type="button" disabled={pages.busy} onClick={pages.loadOlder}>
            {pages.busy ? 'Loading…' : 'Older runs'}
          </button>
        </p>
      )}
      {pages.fresh && !!pages.rows?.length && pages.end && (
        <p className="run-more muted small">No older runs.</p>
      )}
    </>
  );
}

export function RunsPage({ me }: { me: User }) {
  const [{ state, workspace, project, config, mine, q }, setChoices] = useState(choicesInAddress);
  // AFS-152: where runs start is said only to who may start one.
  const myAccess = useMyAccess();
  // What is typed asks the server once typing pauses.
  const [typed, setTyped] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (typed.trim() !== q) setChoices((before) => ({ ...before, q: typed.trim() }));
    }, 300);
    return () => clearTimeout(timer);
  }, [typed, q]);
  const filter: RunsFilter = {
    ...(q ? { q } : {}),
    ...(state ? { state } : {}),
    ...(workspace ? { workspace } : {}),
    ...(project ? { project } : {}),
    ...(project && config ? { config } : {}),
    // "Mine" is the runs this person asked for: the server is asked for their login's.
    ...(mine ? { by: me.login } : {}),
  };
  const pages = useRunPages(filter);
  const { list, rows, fresh } = pages;
  const where = useLoad(places, []);
  // The configurations of the project chosen, to narrow its runs to one.
  const configs = useLoad(async () => (project ? api.launchConfigs(project) : []), [project]);

  const choose = (next: Partial<Choices>) =>
    setChoices((before) => ({
      ...before,
      ...next,
      // Another project has other configurations.
      ...(next.project !== undefined && next.project !== before.project ? { config: '' } : {}),
    }));
  // The router reads the path only, so the choices can live in the query.
  useEffect(() => {
    const query = new URLSearchParams({
      ...(state ? { state } : {}),
      ...(workspace ? { workspace } : {}),
      ...(project ? { project } : {}),
      ...(project && config ? { config } : {}),
      ...(mine ? { mine: '1' } : {}),
      ...(q ? { q } : {}),
    }).toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}`,
    );
  }, [state, workspace, project, config, mine, q]);
  // AFS-274: nor is a workspace the person cannot see; and a project is one of the workspace's.
  const space = where.data?.find((w) => w.workspace.key === workspace);
  useEffect(() => {
    if (workspace && where.data && !space) setChoices((before) => ({ ...before, workspace: '' }));
  }, [workspace, where.data, space]);
  // A project from the address that the person cannot see (or that is gone) is not a choice.
  const known = where.data?.some((w) => w.projects.some((p) => p.id === project));
  useEffect(() => {
    if (project && where.data && !known)
      setChoices((before) => ({ ...before, project: '', config: '' }));
  }, [project, where.data, known]);
  // Nor is a configuration the project does not have (any more).
  const knownConfig = configs.data?.some((c) => c.id === config);
  useEffect(() => {
    if (config && configs.data && !knownConfig) setChoices((before) => ({ ...before, config: '' }));
  }, [config, configs.data, knownConfig]);

  const groups = where.data?.filter((w) => w.projects.length) ?? [];
  // AFS-274: each run names its workspace; with one chosen, its projects are the choices.
  const workspaceOfProject = new Map(
    (where.data ?? []).flatMap((w) => w.projects.map((p) => [p.id, w.workspace.name] as const)),
  );
  const shownGroups = workspace ? groups.filter((w) => w.workspace.key === workspace) : groups;
  // AFS-194: someone who reaches no project sees no run: no choices to narrow nothing with.
  const nowhere = !me.admin && !!where.data && groups.length === 0;
  // AFS-207: someone who may only run actions finds their runs on Actions, not here.
  const actionRuns = useLoad(
    async () => (nowhere ? api.actions().catch(() => []) : []),
    [nowhere],
  ).data?.some((a) => a.lastRun);

  return (
    <>
      <PageHead help="runs.md" title="Runs" lead="Every run you may see, the newest first." />
      {nowhere && actionRuns && (
        <p className="empty">
          The runs you started of an action are on <Link to="/actions">Actions</Link>: each action's
          card opens your last run of it. This page lists the runs of projects shared with you, and
          none is yet.
        </p>
      )}
      {nowhere && !actionRuns && (
        <p className="empty">
          No project is shared with you yet, so there is no run to see. An administrator gives
          access on a workspace's Access tab.
        </p>
      )}
      <div className="run-filters" hidden={nowhere}>
        <label>
          Find
          <input
            type="search"
            className="run-find"
            value={typed}
            placeholder="flow, configuration, login or #number"
            onChange={(e) => setTyped(e.target.value)}
            spellCheck={false}
          />
        </label>
        <WorkspaceFilter
          workspaces={(where.data ?? []).map((w) => w.workspace)}
          chosen={workspace || undefined}
          onChange={(next) =>
            choose({
              workspace: next ?? '',
              // A project of another workspace is not one of this one's.
              ...(next &&
              project &&
              !where.data
                ?.find((w) => w.workspace.key === next)
                ?.projects.some((p) => p.id === project)
                ? { project: '' }
                : {}),
            })
          }
        />
        <StateChoices value={state} onChange={(next) => choose({ state: next })} />
        <div className="chips">
          <label className={mine ? 'chip on' : 'chip'}>
            <input
              type="checkbox"
              checked={mine}
              onChange={(e) => choose({ mine: e.target.checked })}
            />
            Mine
          </label>
        </div>
        <label>
          Project
          <select
            className="run-project"
            value={known ? project : ''}
            onChange={(e) => choose({ project: e.target.value })}
          >
            <option value="">all projects</option>
            {shownGroups.map((w) => (
              <optgroup key={w.workspace.id} label={w.workspace.name}>
                {w.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {known && project && (
          <label>
            Launch configuration
            <select
              className="run-project"
              value={knownConfig ? config : ''}
              onChange={(e) => choose({ config: e.target.value })}
            >
              <option value="">all configurations</option>
              {configs.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {(!fresh || list.error) && <Loading state={list} />}
      {fresh && rows?.length === 0 && !nowhere && (
        <p className="empty">
          {mine || config || q
            ? 'No run for these choices.'
            : state && project
              ? 'No run of this project in this state.'
              : state
                ? 'No run in this state.'
                : project
                  ? 'No run of this project yet.'
                  : launchesAny(myAccess.data)
                    ? 'No run yet. Runs start from a launch configuration of a project.'
                    : 'No run yet.'}
          {/* AFS-144: a way back from choices that leave nothing. */}
          {(state || workspace || project || mine || q) && (
            <>
              {' '}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setTyped('');
                  setChoices({
                    state: '',
                    workspace: '',
                    project: '',
                    config: '',
                    mine: false,
                    q: '',
                  });
                }}
              >
                Show all runs
              </button>
            </>
          )}
        </p>
      )}
      {!!rows?.length && (
        <RunList runs={rows} me={me} workspaceOf={(run) => workspaceOfProject.get(run.project)} />
      )}
      <OlderRuns pages={pages} />
    </>
  );
}

/** A run's state in a few words and a colour, for lists (AFS-64). */
export function RunWords({ state, against }: { state: string; against?: string | undefined }) {
  const [text, tone] =
    state === 'failed' && against && AGAINST[against]
      ? [AGAINST[against], 'bad-text']
      : (WORDS[state] ?? [state, 'muted']);
  return (
    <span className={`state ${tone}`} data-state={shapeOf(state, against)}>
      <StateGlyph state={state} against={against} />
      {text}
    </span>
  );
}
const WORDS: Record<string, [string, string]> = {
  queued: ['queued', 'muted'],
  running: ['running', 'busy-text'],
  waiting: ['waiting for a decision', 'warn-text'],
  // AFS-205
  paused: ['paused', 'warn-text'],
  succeeded: ['went well', 'ok-text'],
  failed: ['failed', 'bad-text'],
  cancelled: ['stopped', 'muted'],
  lost: ['lost', 'bad-text'],
};

/**
 * How long, after the state's badge: "running · for 6 min", "went well · in 2 min". AFS-143: the
 * badge says the state; this does not say it again.
 */
function standing(run: Run, pause?: { kind?: string }): string {
  const from = run.startedAt ?? run.createdAt;
  switch (run.state) {
    case 'running':
      // AFS-205: "paused · before Push baseline", not how long it has gone. AFS-249: a debug run
      // paused where a host failed is after the step, as its reason line says.
      return run.pausedBefore
        ? `${pause?.kind === 'failure' ? 'after' : 'before'} ${run.pausedBefore}`
        : `for ${span(from)}`;
    case 'succeeded':
      return `in ${span(from, run.endedAt)}`;
    case 'failed':
      return `after ${span(from, run.endedAt)}`;
    // AFS-147: a stopped run says how long it went too.
    case 'cancelled':
      return run.startedAt ? `after ${span(from, run.endedAt)}` : '';
    default:
      return '';
  }
}

/**
 * AFS-185: a stopped run says when, after who stopped it: "Stopped by Dana Whitfield at
 * 21.11.2026, 08:47:56 CET during Push baseline".
 */
export function stoppedWhen(text: string, endedAt?: string, locale?: string): string {
  if (!endedAt || !text.startsWith('Stopped')) return text;
  const at = ` at ${formatTime(endedAt, locale)}`;
  const by = /^Stopped by .+?(?= during | while | before |; |$)/.exec(text);
  if (by) return `${by[0]}${at}${text.slice(by[0].length)}`;
  return text.replace(/^Stopped( on request)?/, (m) => `${m}${at}`);
}

/** AFS-143: a port of a step as people say it. */
const PORT_WORDS: Record<string, string> = {
  failed_hosts: 'failed hosts',
  unreachable: 'unreachable hosts',
  timeout: 'hosts that timed out',
  rejected: 'rejected hosts',
  ok_hosts: 'hosts that went well',
};

/**
 * AFS-143: why a host stopped, in words: the generated playbook says "Stopped at [precheck]
 * Pre-checks: failed_hosts is not wired"; the page says "Stopped at Pre-checks: its failed hosts
 * have no next step in the flow". Step keys in brackets before a title go.
 */
export function plainWhy(text: string): string {
  return text
    .replace(
      /\[[\w.-]+\] (.+?): (\w+) is not wired/,
      (_, title: string, port: string) =>
        `${title}: its ${PORT_WORDS[port] ?? port} have no next step in the flow`,
    )
    .replace(
      /\[[\w.-]+\] (.+?): (\w+) open on purpose/,
      (_, title: string, port: string) =>
        `${title}: its ${PORT_WORDS[port] ?? port} end here on purpose`,
    )
    .replace(/\[[\w.-]+\] (?=\S)/g, '');
}

/**
 * AFS-193: Ansible's reason for a failed task, in words. A task its failed_when condition failed
 * has no message of its own: Ansible says "Unknown error"; the designer's callback says the
 * condition since 1.0.2 (older runs keep Ansible's words, explained).
 */
export function failureWords(msg: string): string {
  const said = plainWhy(msg);
  if (/^(Task failed: )?(Action failed: )?Unknown error\.?$/.test(said.trim()))
    return 'Ansible gave no reason. A failed_when condition that was true fails a task this way.';
  return said;
}

/** AFS-256: where a stopped host stopped, as a word before the step: after, at (an approval), before. */
const stoppedWord = (h: Pick<HostAt, 'after' | 'waiting'>) =>
  h.after ? 'after' : h.waiting ? 'at' : 'before';

interface HostLine {
  host: string;
  words: string;
  tone: string;
  /** What went wrong, when it did. */
  why?: { task: string; msg?: string };
}

/**
 * Each host of a run and how it fares, those with a problem first. AFS-256: once the run has
 * ended, its host sets (the server's) say which hosts could not be reached, and in a stopped run
 * which failed and where the others stopped; a run stopped before its first step lists the hosts
 * that waited there.
 */
export function hostLines(
  view: RunView,
  state: Run['state'],
  against?: string,
  sets?: HostSets,
): HostLine[] {
  const summary = view.summary;
  if (!summary && !sets?.total) return [];
  const problem = new Map<string, HostLine>();
  const why = (h: HostAt) =>
    h.task
      ? { why: { task: plainWhy(h.task), ...(h.msg ? { msg: failureWords(h.msg) } : {}) } }
      : {};
  for (const h of sets?.unreachable ?? [])
    problem.set(h.host, { host: h.host, words: 'not reachable', tone: 'bad-text', ...why(h) });
  for (const host of summary?.unreachable ?? [])
    if (!problem.has(host)) problem.set(host, { host, words: 'not reachable', tone: 'bad-text' });
  if (state === 'cancelled')
    for (const h of sets?.failed ?? [])
      problem.set(h.host, {
        host: h.host,
        words: h.title ? `failed at ${h.title}` : 'failed',
        tone: 'bad-text',
        ...why(h),
      });
  for (const f of summary?.failures ?? [])
    if (!problem.has(f.host))
      problem.set(f.host, {
        host: f.host,
        words: 'failed',
        tone: 'bad-text',
        why: { task: plainWhy(f.task), ...(f.msg ? { msg: failureWords(f.msg) } : {}) },
      });
  for (const [host, reason] of Object.entries(summary?.outcome ?? {}))
    if (!problem.has(host))
      problem.set(host, {
        host,
        // AFS-146: a host ended by a rejection ended there because of it, not because Ansible
        // failed: "Ended at Not approved (rejected)".
        words: against
          ? plainWhy(reason).replace(/\(outcome: failed\)$/, `(${AGAINST[against] ?? against})`)
          : plainWhy(reason),
        tone: 'bad-text',
      });
  // A problem a step rescued into a port: the host went on, but that is where it went wrong.
  for (const hosts of Object.values(summary?.problems ?? {}))
    for (const [host, p] of Object.entries(hosts)) {
      const line = problem.get(host);
      if (line && !line.why)
        line.why = { task: plainWhy(p.task), ...(p.msg ? { msg: failureWords(p.msg) } : {}) };
    }
  // AFS-131: the run's own state says whether it ended: a stopped run's view can still read as
  // running (it was stopped while it waited, or before its last view was written).
  const going = state === 'running' || state === 'queued' || state === 'waiting';
  const stopped = new Map((sets?.stopped ?? []).map((h) => [h.host, h]));
  const all = [
    ...new Set([
      ...(summary?.hosts ?? []),
      ...(sets?.notOk ?? []),
      ...(sets?.handled ?? []).map((h) => h.host),
    ]),
  ];
  const rest = all
    .filter((h) => !problem.has(h))
    .map(
      (host): HostLine =>
        state === 'cancelled'
          ? {
              host,
              words: stopped.get(host)?.title
                ? `stopped ${stoppedWord(stopped.get(host) as HostAt)} ${stopped.get(host)?.title}`
                : 'stopped',
              tone: 'muted',
            }
          : // AFS-146: a run held at an approval: its hosts wait for the decision, they are
            // not in progress.
            state === 'waiting'
            ? { host, words: 'waiting for a decision', tone: 'muted' }
            : // AFS-205: a host waiting at a step-by-step run's pause waits for Step or Continue.
              going && view.step?.paused?.hosts.includes(host)
              ? { host, words: 'waiting for Step or Continue', tone: 'muted' }
              : going && view.state === 'running'
                ? { host, words: 'in progress', tone: 'muted' }
                : going
                  ? { host, words: 'waiting', tone: 'muted' }
                  : { host, words: 'went well', tone: 'ok-text' },
    );
  return [...problem.values(), ...rest];
}

const SHOWN_HOSTS = 8;

/**
 * The hosts beside the canvas (AFS-86). When some have a problem, those are what the list is
 * read for: only they show until all are asked for. The canvas panel lists every host anyway.
 */
function Hosts({ run, lines }: { run: string; lines: HostLine[] }) {
  const [all, setAll] = useState(false);
  // AFS-170: a host's row opens what it did, step by step.
  const [open, setOpen] = useState<string>();
  if (!lines.length) return null;
  const problems = lines.filter((l) => l.tone === 'bad-text');
  const short = (problems.length ? problems : lines).slice(0, SHOWN_HOSTS);
  const shown = all ? lines : short;
  return (
    <section className="hosts" aria-labelledby="hosts">
      <div className="section-head">
        <h2 id="hosts">Hosts</h2>
        {short.length < lines.length && (
          <button
            type="button"
            className="link small"
            aria-expanded={all}
            onClick={() => setAll(!all)}
          >
            {all ? (problems.length ? 'Only with a problem' : 'Fewer') : `All ${lines.length}`}
          </button>
        )}
      </div>
      {!all && problems.length > 0 && short.length < lines.length && (
        <p className="muted small">
          {short.length < problems.length
            ? `The first ${short.length} of ${problems.length} with a problem.`
            : problems.length === 1
              ? 'The one with a problem.'
              : `The ${problems.length} with a problem.`}
        </p>
      )}
      <ul className="list">
        {shown.map((line) => (
          <li key={line.host}>
            <button
              type="button"
              className="item host-row"
              aria-expanded={open === line.host}
              title={`What ${line.host} did`}
              onClick={() => setOpen(open === line.host ? undefined : line.host)}
            >
              <span className="mono">{line.host}</span>
              <span className={`end ${line.tone}`}>{line.words}</span>
            </button>
            {open === line.host && (
              <HostOutput
                run={run}
                host={line.host}
                state={line.words}
                // AFS-193: where the host ended, at the end of what it did.
                {...(/^(Ended|Stopped) at /.test(line.words) ? { end: line.words } : {})}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** AFS-170: what one host did in the run: each step it ran in, and each task's result there. */
function HostOutput({
  run,
  host,
  state,
  end,
}: {
  run: string;
  host: string;
  state: string;
  end?: string;
}) {
  const [steps, setSteps] = useState<Awaited<ReturnType<typeof api.runHost>>['steps']>();
  const [error, setError] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the host's state changes
  useEffect(() => {
    let live = true;
    api.runHost(run, host).then(
      (r) => live && setSteps(r.steps),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [run, host, state]);
  if (error)
    return (
      <p className="notice error small" role="alert">
        {error}
      </p>
    );
  if (!steps) return <p className="muted small">Reading what {host} did…</p>;
  if (!steps.length) return <p className="muted small">No output for {host} yet.</p>;
  return (
    <section className="host-output" aria-label={`What ${host} did`}>
      {steps.map((s) => (
        <div key={s.node}>
          <h3>{s.step}</h3>
          <ul>
            {s.entries.map((e, i) => {
              const text = e.censored
                ? 'Not shown: the task hides its output'
                : [e.msg, e.out?.msg, e.out?.stdout, e.out?.stderr]
                    .filter((t, at, all) => t && all.indexOf(t) === at)
                    .join('\n');
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: a host's results, in order.
                <li key={i}>
                  <span className={`host-status ${STATUS_TONE[e.status] ?? 'muted'}`}>
                    {e.changed && e.status === 'ok' ? 'changed' : e.status}
                  </span>{' '}
                  {e.task}
                  {e.rc !== undefined && e.rc !== 0 && (
                    <span className="muted"> (code {e.rc})</span>
                  )}
                  {text && <pre className="output">{text}</pre>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {end && (
        <p className="bad-text" data-host-end>
          {end}
        </p>
      )}
    </section>
  );
}
const STATUS_TONE: Record<string, string> = {
  ok: 'ok-text',
  failed: 'bad-text',
  unreachable: 'bad-text',
  skipped: 'muted',
  // AFS-193: an approval the host waited at, and how it was decided.
  approved: 'ok-text',
  rejected: 'bad-text',
  'timed out': 'bad-text',
  waiting: 'warn-text',
  'run stopped': 'muted',
};

/**
 * AFS-117: what the run gave back (its flow's outputs), per host, as a flow that launched it gets
 * them (the Ansible collection's run and run_info).
 */
function Outputs({ summary }: { summary: NonNullable<RunView['summary']> }) {
  const hosts = Object.entries(summary.outputs ?? {});
  const text = (v: unknown) => {
    const t = typeof v === 'string' ? v : JSON.stringify(v);
    return t.length > 200 ? `${t.slice(0, 200)}…` : t;
  };
  return (
    <section className="outputs" aria-labelledby="outputs">
      <h2 id="outputs">Outputs</h2>
      {summary.outputsTooLarge ? (
        <p className="muted small">The outputs were too large to keep.</p>
      ) : hosts.length === 0 ? (
        <p className="muted small">No host gave a value.</p>
      ) : (
        <dl className="facts">
          {hosts.map(([host, values]) => (
            <div key={host}>
              <dt className="mono">{host}</dt>
              <dd>
                {Object.entries(values).map(([name, value]) => (
                  <div key={name}>
                    <span className="mono">{name}</span> ={' '}
                    <span
                      className="mono"
                      title={typeof value === 'string' ? value : JSON.stringify(value)}
                    >
                      {text(value)}
                    </span>
                  </div>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/** Where a run belongs, as far as the person may see it: what its pages are addressed by. */
interface Belongs {
  workspace: string;
  project: string;
  /** AFS-146: the project's name, as the breadcrumb says it. */
  projectName?: string;
  /** The flow's page, when the project has the flow now. */
  flow?: string;
  /** The launch configuration's page, when it is still there. */
  config?: string;
}

const part = encodeURIComponent;

/**
 * Finds a run's workspace and project (a run names its project by id; pages are addressed by
 * keys), and whether its flow and launch configuration can be linked to. What is not found is
 * left out: a dev run's flow may not be in the project, a configuration may be gone.
 */
async function belongs(project: string, file: string, config?: string): Promise<Belongs | null> {
  for (const { workspace, projects } of await places()) {
    const found = projects.find((p) => p.id === project);
    if (!found) continue;
    const base = `/w/${part(workspace.key)}/${part(found.key)}`;
    const [flows, configs] = await Promise.all([
      api.flows(found.id).then(
        (l) => l.flows.map((f) => f.file),
        () => [] as string[],
      ),
      config
        ? api.launchConfigs(found.id).then(
            (l) => l.map((c) => c.id),
            () => [] as string[],
          )
        : ([] as string[]),
    ]);
    return {
      workspace: workspace.key,
      project: found.key,
      ...(found.name ? { projectName: found.name } : {}),
      ...(flows.includes(file)
        ? { flow: `${base}/flow/${file.split('/').map(part).join('/')}` }
        : {}),
      ...(config && configs.includes(config) ? { config: `${base}/launch/${part(config)}` } : {}),
    };
  }
  return null;
}

/** AFS-147: an input's value in a line. */
const inputText = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

/**
 * AFS-147: what Run again does, in words: the button's title (mode and the inputs it reuses) and
 * the question asked first: for a real run (Launch's, with the inputs), and for one that reached
 * no host (AFS-191). AFS-251: a real run's question says its approvals are asked again, and a run
 * again of some hosts names them.
 */
export function againWords(
  run: Run,
  approvals: readonly string[] = [],
): { title: string; confirm?: string; yes: string } {
  const reuses = reusesWords(run);
  const only = limitWords(run);
  const where = only ? ` on ${only}` : run.limit ? ` limited to ${run.limit}` : '';
  const mode = run.mode === 'real' ? 'A real run' : 'A check run';
  // AFS-191: a run that reached no host would again (same commit, inputs and limit): asked first.
  const none = run.error?.startsWith('No host ran')
    ? ` ${run.error}. It would likely end the same way.`
    : '';
  const real = run.mode === 'real';
  return {
    title: `${mode} again, at the same commit${where}. ${reuses}`,
    ...(real
      ? {
          confirm: `Run ${run.flow.name} for real again${where}? It changes the hosts it reaches. ${reuses}${approvals.length ? ` Approvals are asked again (${approvals.slice(0, 3).join(', ')}${approvals.length > 3 ? ` and ${approvals.length - 3} more` : ''}).` : ''}${none}`,
        }
      : none
        ? { confirm: `Run ${run.flow.name} again as a check run?${none}` }
        : {}),
    yes: real ? 'Run for real' : 'Run again anyway',
  };
}

/** AFS-147: the inputs a run again reuses, in a sentence. */
export function reusesWords(run: Pick<Run, 'inputs'>): string {
  const inputs = Object.entries(run.inputs).map(([name, v]) => `${name} = ${inputText(v)}`);
  return inputs.length ? `It reuses the inputs ${inputs.join(', ')}.` : 'It takes no inputs.';
}

/**
 * AFS-251: the limit of a run again of some hosts (its own list of hosts, not a limit pattern):
 * "only sw-edge-02", "only 40 hosts: leaf-01, … and 20 more".
 */
export function limitWords(run: Pick<Run, 'hostLimit'>): string | undefined {
  const h = run.hostLimit;
  if (!h) return undefined;
  const more = h.count - h.hosts.length;
  const names = `${h.hosts.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
  return h.count === 1 ? `only ${names}` : `only ${h.count} hosts: ${names}`;
}

/** The items of an open menu, in order. */
const menuItems = (box: HTMLElement | null): HTMLElement[] => [
  ...(box?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
];

/** AFS-265: the run's page header's More menu: All runs, and the whole output as text. */
function RunMoreMenu({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    menuItems(box.current)[0]?.focus();
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (box.current?.contains(document.activeElement)) button.current?.focus();
      setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="more-menu" ref={box}>
      <button
        ref={button}
        type="button"
        className="icon-button"
        aria-label="More"
        title="More: all runs, the output as text"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div
          className="more-menu-list"
          role="menu"
          tabIndex={-1}
          onKeyDown={(e) => {
            const all = menuItems(box.current);
            const at = all.indexOf(document.activeElement as HTMLElement);
            const to =
              e.key === 'ArrowDown'
                ? (at + 1) % all.length
                : e.key === 'ArrowUp'
                  ? (at - 1 + all.length) % all.length
                  : undefined;
            if (to !== undefined) {
              e.preventDefault();
              all[to]?.focus();
            } else if (e.key === 'Tab') setOpen(false);
          }}
        >
          <Link to="/runs" role="menuitem" className="run-link" onClick={() => setOpen(false)}>
            All runs
          </Link>
          <a
            role="menuitem"
            href={`/api/v1/runs/${encodeURIComponent(id)}/output`}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
          >
            The output as text
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * One run (AFS-64), in the debug workbench (AFS-265): the canvas in the middle with the toolbar
 * over it, the side bar (Run and Debug for a debug run, Details: approvals, hosts, outputs, what
 * ran), the bottom panel (Debug Console, Terminal, Problems) and the status line.
 */
export function RunPage({ id, me, theme }: { id: string; me: User; theme: ThemeChoice }) {
  const fed = useRunFeed(id);
  const { output, missing, error, setError, setRun, setView } = fed;
  const run = fed.run?.id === id ? fed.run : undefined;
  const view = fed.view;
  /** AFS-177: a step-by-step run's state, from its live view (as the canvas hears it). */
  const step = fed.step;
  const access = useProjectAccess(run?.project).data;
  // AFS-212: Home's Run again comes here with `?again=1`: the menu opens with its choices.
  const againAsked = new URLSearchParams(useSearch()).get('again') === '1';
  // AFS-181: no generated-code excerpt under a failed end's error (the output file keeps it).
  // AFS-193: and a rejected host's end says rejected, not failed.
  const shown = useMemo(() => decidedOutcomes(quietEndOrigins(output)), [output]);
  const [busy, setBusy] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const below = useRef<HTMLElement>(null);
  const frameEl = useRef<HTMLIFrameElement>(null);
  const frame = useCallback(() => frameEl.current, []);
  // AFS-265: the canvas takes the run's events from this page's stream.
  useFrameFeed(frame, fed.feed);
  const projectId = run?.project;
  const flowFile = run?.flow.file;
  const configId = run?.config?.id;
  const where = useLoad(
    async () => (projectId && flowFile ? belongs(projectId, flowFile, configId) : null),
    [projectId, flowFile, configId],
  ).data;
  // AFS-214: once the run has ended, how its hosts went and what Run again offers.
  const over = !!run && !ACTIVE.includes(run.state);
  const offer = useLoad(
    async () => (over ? await api.relaunchOffer(id).catch(() => undefined) : undefined),
    [id, over, run?.state],
  ).data;
  const debugRun = !!run?.step?.debug;
  const wb = useWorkbenchState(debugRun);

  // AFS-193: a run that stops waiting (decided, stopped, timed out) changes the sidebar's count of
  // approvals: it looks again, not only on its timer.
  const state = run?.state;
  const wasWaiting = useRef(false);
  useEffect(() => {
    if (wasWaiting.current && state !== 'waiting')
      window.dispatchEvent(new Event(APPROVALS_CHANGED));
    wasWaiting.current = state === 'waiting';
  }, [state]);

  // AFS-193: the workbench fits the window under whatever is above it (a notice of why the run
  // ended, targets left out): the canvas's zoom controls and the status line stay in sight.
  const body = useRef<HTMLDivElement>(null);
  const notes = `${run?.error ?? ''}|${error ?? ''}|${run?.skippedTargets?.length ?? 0}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again when the notes change
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const place = () =>
      el.style.setProperty(
        '--run-flow-top',
        `${Math.round(el.getBoundingClientRect().top + window.scrollY) + 8}px`,
      );
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [notes, !!run]);

  // Its hosts, from how it went: read when it changes, and now and then while it goes.
  const going = run ? ACTIVE.includes(run.state) : false;
  // AFS-147: of this run: right after Run again the run shown is still the one before for a moment.
  const started = !!run?.startedAt;
  // AFS-258: a run that ended before it ran anything has no view: not asked for. A run stopped
  // before its first step has hosts to list (AFS-256): stopped runs are always asked.
  const viewless = !going && !!run?.error && !run?.hosts && run?.state !== 'cancelled';
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the run's state changes
  useEffect(() => {
    if (!started || viewless) return;
    let current = true;
    const read = () =>
      api.runView(id).then(
        (v) => current && setView(v),
        () => undefined,
      );
    void read();
    const timer = going ? setInterval(read, 5000) : undefined;
    return () => {
      current = false;
      if (timer) clearInterval(timer);
    };
  }, [id, started, going, run?.state]);

  // The output follows its end unless the reader scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the output grows
  useEffect(() => {
    const el = pre.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  // AFS-96: Show Terminal on the canvas of this page opens the panel's Terminal (the canvas asks,
  // in its frame); from elsewhere it opens this page at #output. The output is marked for a moment,
  // so it is plain where the eye should go.
  const [shownOutput, setShownOutput] = useState(0);
  const toOutput = () => {
    wb.setPanel('terminal');
    wb.setTab('panel');
    setShownOutput((n) => n + 1);
  };
  const toOutputRef = useRef(toOutput);
  toOutputRef.current = toOutput;
  useEffect(() => {
    const heard = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; run?: string } | undefined;
      if (data?.type === 'afs-show-output' && data.run === id) toOutputRef.current();
    };
    window.addEventListener('message', heard);
    return () => window.removeEventListener('message', heard);
  }, [id]);
  const loaded = !!run;
  useEffect(() => {
    if (loaded && window.location.hash === '#output') toOutputRef.current();
  }, [loaded]);
  useEffect(() => {
    if (!shownOutput) return;
    // Once the Terminal is shown (this effect runs after it is drawn).
    below.current?.scrollIntoView?.({ block: 'nearest' });
    below.current?.focus({ preventScroll: true });
    const timer = setTimeout(() => setShownOutput(0), 1600);
    return () => clearTimeout(timer);
  }, [shownOutput]);

  // AFS-139, AFS-143: a run is "flow #number", as the lists, the audit log and the mails name it.
  const title = run ? `${run.flow.name} #${run.number}` : 'Run';
  useEffect(() => {
    if (!run) document.title = `${title} · Ansible Flow Server`;
  }, [title, run]);

  // AFS-152: a run not there (or not shared) is the same page as a project not there.
  if (missing && !run)
    return (
      <div className="run-below">
        <Missing
          what={
            <>
              The run <code>{id}</code>
            </>
          }
          back={{ to: '/runs', label: 'Back to Runs' }}
          help="runs.md"
        />
      </div>
    );
  if (error && !run)
    return (
      <div className="run-below">
        <PageHead title="Run" />
        <p className="notice error" role="alert">
          {error}
        </p>
      </div>
    );
  if (!run)
    return (
      <div className="run-below">
        <Loading state={{ loading: true }} />
      </div>
    );
  // operator on the run's flow stops it and runs it again.
  const mayAct = me.admin || atLeast(flowLevel(access, run.flow.file), 'operator');
  const again = againWords(run, offer?.approvals);
  // AFS-214: Debug this failure looks into the run's variables: rw on the flow.
  const mayDebug = me.admin || atLeast(flowLevel(access, run.flow.file), 'rw');
  const relaunch = async (body?: RelaunchBody) => {
    setBusy(true);
    try {
      navigate(`/runs/${(await api.relaunchRun(run.id, body)).id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const act = async (what: 'cancel') => {
    // AFS-185: so does Stop of a real run: it cuts off what is in progress.
    if (
      what === 'cancel' &&
      run.mode === 'real' &&
      !(await ask(stopQuestion({ number: run.number, flowName: run.flow.name, state: run.state }), {
        yes: 'Stop the run',
        danger: true,
      }))
    )
      return;
    setBusy(true);
    try {
      setRun(await api.cancelRun(run.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const viewer = `/viewer.html?project=${encodeURIComponent(run.project)}&path=${encodeURIComponent(
    run.flow.file,
  )}&commit=${run.commit}&run=${run.id}&feed=1&theme=${theme === 'system' ? 'auto' : theme}`;
  const lines = view ? hostLines(view, run.state, run.decidedAgainst, offer?.sets) : [];
  const failed = lines.filter((l) => l.tone === 'bad-text').length;
  // AFS-258: a run paused before its first step counts the hosts waiting there.
  const hostCount = lines.length || ((step ?? view?.step)?.paused?.hosts.length ?? 0);
  const whys = lines.filter((l) => l.why);
  const by = personOf(run.requestedBy);
  // AFS-177: a step-by-step run going: paused where, and Step, Continue, Pause, Stop.
  const stepBar = !!run.step && going && run.state === 'running' && !!run.startedAt;
  // AFS-179: a debug run going has the debug toolbar and views; its launcher and administrators
  // drive it and see variables, others the reason line.
  const debugging = stepBar && debugRun;
  const debugDriver = me.admin || run.requestedBy.login === me.login;
  const restart =
    mayAct && !going && debugRun
      ? async () => {
          if (again.confirm && !(await ask(again.confirm, { yes: again.yes }))) return;
          void relaunch();
        }
      : undefined;

  const details = (
    <div className="run-side" data-run-details>
      <RunApprovals run={run.id} changed={`${run.state}|${run.attempts}|${run.endedAt ?? ''}`} />
      <Hosts run={run.id} lines={lines} />
      {view?.summary?.outputs || view?.summary?.outputsTooLarge ? (
        <Outputs summary={view.summary} />
      ) : null}
      <section aria-labelledby="facts">
        <h2 id="facts">What ran</h2>
        <dl className="facts">
          <dt>Flow</dt>
          <dd>
            {where?.flow ? <Link to={where.flow}>{run.flow.name}</Link> : run.flow.name}{' '}
            <span className="muted">
              ({run.flow.file}, version {run.flow.version})
            </span>
          </dd>
          <dt>Commit</dt>
          <dd>
            <code>{run.commit.slice(0, 12)}</code>
            {run.ref && <span className="muted"> · newest of {run.ref} at launch</span>}
          </dd>
          <dt>Launched</dt>
          <dd>
            by <span title={run.requestedBy.login}>{by}</span>
            {run.config && (
              <>
                {' '}
                from{' '}
                {where?.config ? (
                  <Link to={where.config}>{run.config.name}</Link>
                ) : (
                  <>“{run.config.name}”</>
                )}
              </>
            )}
            , <Time at={run.createdAt} />
          </dd>
          <dt>Started</dt>
          <dd>
            <Time at={run.startedAt} />
          </dd>
          <dt>Ended</dt>
          <dd>{going ? 'not yet' : <Time at={run.endedAt} />}</dd>
          <dt>Number</dt>
          <dd>{run.number}, counted over the project's runs</dd>
          <dt>Mode</dt>
          <dd>{run.mode === 'real' ? 'real' : 'check (nothing changed)'}</dd>
          <dt>Hosts</dt>
          <dd>
            {run.targets.join(', ') || 'none'}
            {!!run.skippedTargets?.length && (
              <span className="warn-text">
                {' '}
                (not in the inventory: {run.skippedTargets.join(', ')})
              </span>
            )}
          </dd>
          <dt>Limit</dt>
          <dd data-limit>{limitWords(run) ?? (run.limit ? <code>{run.limit}</code> : 'none')}</dd>
          <dt>Inventory</dt>
          <dd>{run.inventory ? <code>{run.inventory}</code> : 'what ansible.cfg names'}</dd>
          <dt>Environment</dt>
          <dd>
            {run.environment ? (
              where ? (
                <Link to={environmentAddress(where.workspace, run.environment.id)}>
                  {run.environment.name}
                </Link>
              ) : (
                run.environment.name
              )
            ) : (
              'none'
            )}
            {run.eeImage ? (
              <>
                {' '}
                · <code>{run.eeImage}</code>
                {/* AFS-163: the image came from the server's default, not the configuration. */}
                {run.serverDefault && <span className="muted"> (the server's default)</span>}
              </>
            ) : (
              <span className="muted"> · the server's default image</span>
            )}
          </dd>
          <dt>Credentials</dt>
          <dd>{(run.credentialNames ?? run.credentials).join(', ') || 'none'}</dd>
        </dl>
        {/* AFS-147: the inputs it ran with (secret ones as ***): what Run again reuses. */}
        <h3>Inputs</h3>
        {Object.keys(run.inputs).length ? (
          <dl className="facts" data-run-inputs>
            {Object.entries(run.inputs).map(([name, value]) => (
              <div key={name} className="fact">
                <dt className="mono">{name}</dt>
                <dd>
                  <code>{inputText(value)}</code>
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="muted small">The flow took no inputs.</p>
        )}
      </section>
    </div>
  );
  const problems = whys.length ? (
    <div className="wb-problems">
      {whys.map((why) => (
        <section key={why.host} className="why" aria-labelledby={`why-${why.host}`}>
          <h2 id={`why-${why.host}`}>
            Why {why.host} {why.words === 'not reachable' ? 'was not reached' : 'failed'}
          </h2>
          <p>At “{why.why?.task}”.</p>
          {why.why?.msg && <pre>{why.why.msg}</pre>}
        </section>
      ))}
    </div>
  ) : undefined;
  const terminal = (
    <section
      ref={below}
      tabIndex={-1}
      id="output"
      className={`run-output${shownOutput ? ' run-output-shown' : ''}`}
      aria-labelledby="output-head"
    >
      <div className="section-head">
        <h2 id="output-head" className="sr-only">
          Terminal output
        </h2>
      </div>
      {output ? (
        <pre
          ref={pre}
          className="output"
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
          }}
        >
          <AnsiText text={shown} />
        </pre>
      ) : (
        <p className="muted">{going ? 'Nothing yet.' : 'No output.'}</p>
      )}
    </section>
  );
  const standingNow = standing(run, (step ?? view?.step)?.paused);
  const toolbar =
    stepBar && !debugging ? (
      <RunStepBar
        run={run}
        step={step ?? view?.step}
        mayDrive={mayAct}
        launcher={by}
        mine={run.requestedBy.login === me.login}
        onRun={setRun}
        onError={setError}
      />
    ) : mayAct && going && !stepBar ? (
      <div className="wb-toolbar" role="toolbar" aria-label="Run">
        <button
          type="button"
          className="wb-tool danger"
          disabled={busy || run.cancelRequested}
          onClick={() => act('cancel')}
        >
          <Icon name="stop" />
          <span className="wb-tool-label">Stop</span>
        </button>
      </div>
    ) : undefined;

  return (
    <>
      {/* ADR-0039 §4: a real run's head carries a stripe along its top. */}
      <header className={run.mode === 'real' ? 'run-head real-run' : 'run-head'}>
        <div>
          <Breadcrumb>
            {where ? (
              <>
                <Link to="/workspaces">Workspaces</Link> /{' '}
                <Link to={`/w/${part(where.workspace)}`}>
                  <WorkspaceName workspace={where.workspace} />
                </Link>{' '}
                /{' '}
                <Link to={`/w/${part(where.workspace)}/${part(where.project)}`}>
                  {where.projectName ?? where.project}
                </Link>{' '}
                {where.config && run.config && (
                  <>
                    {' '}
                    / <Link to={where.config}>{run.config.name}</Link>
                  </>
                )}
              </>
            ) : (
              // Where it belongs is not known (yet, or not to this person): the list is the way back.
              <Link to="/runs">Runs</Link>
            )}
            {/* AFS-277: the run itself is the title right under the crumbs, said once. */}
          </Breadcrumb>
          {/* AFS-147: the number counts the project's runs, not the flow's. */}
          <h1 tabIndex={-1} title={`Run ${run.number} of the project's runs`}>
            {title}
          </h1>
          {/* AFS-277: where it stands is said by the status line under the canvas (and why it
              paused there only); here, the state and what kind of run it is. */}
          <p className="run-facts">
            <StateBadge state={shownState(run)} against={run.decidedAgainst} /> · started by {by} ·{' '}
            <ModeBadge mode={run.mode} long />
            {hostCount > 0 && (
              <>
                {' '}
                · {hostCount} {hostCount === 1 ? 'host' : 'hosts'}
                {failed > 0 && (
                  <span className="bad-text">
                    , {failed}{' '}
                    {run.decidedAgainst === 'rejected'
                      ? 'not approved'
                      : run.decidedAgainst
                        ? 'not decided in time'
                        : 'with a problem'}
                  </span>
                )}
              </>
            )}
            {/* AFS-147: targets Ansible dropped are said, also on a run that went well; named on
                hover and in Details. */}
            {!!run.skippedTargets?.length && (
              <span
                className="warn-text"
                title={`Not in the inventory${run.inventory ? ` ${run.inventory}` : ''}, so nothing ran there: ${run.skippedTargets.join(', ')}`}
                data-skipped-targets
              >
                {' '}
                · {run.skippedTargets.length}{' '}
                {run.skippedTargets.length === 1 ? 'target' : 'targets'} not in the inventory
              </span>
            )}
            {run.dev && (
              <>
                {' '}
                <span className="badge" title="Unpushed work sent from VS Code, run in check mode">
                  dev run
                </span>
              </>
            )}
            {run.schedule && (
              <>
                {' '}
                <span
                  className="badge"
                  title="Launched by a schedule of its launch configuration, as its owner"
                >
                  scheduled
                </span>
              </>
            )}
            {run.step && (
              <>
                {' '}
                <span
                  className="badge"
                  title={
                    run.step.debug
                      ? 'A debug run: pauses at its pause points and where a host fails, and shows the variables of each host there'
                      : run.step.every
                        ? 'Pauses before each step until someone says Step, Continue or Stop'
                        : 'Pauses at its pause points until someone says Step, Continue or Stop'
                  }
                  data-debug-badge={run.step.debug ? true : undefined}
                >
                  {run.step.debug ? 'debug run' : 'step by step'}
                </span>
              </>
            )}
            {run.cancelRequested && going && ' · asked to stop'}
            {/* AFS-214: a run of another run again: which, and which of its hosts. */}
            {run.relaunchOf && (
              <>
                {' · '}
                <Link
                  to={`/runs/${encodeURIComponent(run.relaunchOf.id)}`}
                  title={`It ran with the inputs of run #${run.relaunchOf.number}. ${reusesWords(run).replace('It reuses the inputs', 'They are')}`}
                  data-relaunch-of
                >
                  {relaunchWords(run.relaunchOf)}
                </Link>
              </>
            )}
          </p>
          {/* AFS-213: how the hosts went, in one line, once the run has ended. AFS-277: with why it
              ended or stopped, in the same line: no block of notes between the head and the canvas.
              The targets left out are counted above and named in Details. */}
          {(offer?.line || run.error) && (
            <p className="run-outcome" data-outcome>
              {offer?.line && (
                <span className={offer.sets?.notOk.length ? 'bad-text' : undefined}>
                  {offer.line}
                </span>
              )}
              {offer?.line && run.error ? ' · ' : null}
              {run.error && (
                <span
                  className={run.state === 'cancelled' ? undefined : 'bad-text'}
                  role="status"
                  data-run-error
                >
                  {run.state === 'cancelled'
                    ? stoppedWhen(plainWhy(run.error), run.endedAt)
                    : plainWhy(run.error)}
                </span>
              )}
            </p>
          )}
          {error && (
            <p className="notice error run-alert" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="actions">
          {/* AFS-214: Run again ▾: as it was, changed, only the hosts that did not go well, or
              Debug this failure. */}
          {mayAct && !going && (
            <RunAgainMenu
              run={run}
              {...(offer ? { offer } : {})}
              again={again}
              {...(where?.config
                ? { change: `${where.config}?from=${encodeURIComponent(run.id)}` }
                : {})}
              mayDebug={mayDebug}
              busy={busy}
              openAtStart={againAsked}
              onAgain={(b) => void relaunch(b)}
              onChange={navigate}
            />
          )}
          <HelpButton page="runs.md" about="a run's page" />
          <RunMoreMenu id={run.id} />
        </div>
      </header>
      <div className="run-workbench" ref={body}>
        <DebugWorkbench
          run={run}
          step={step ?? view?.step}
          debug={debugRun}
          going={going}
          mayDrive={debugDriver}
          mayStop={mayAct}
          launcher={by}
          state={wb}
          frame={frame}
          sizeKey="run"
          titleBase={`${title} · Ansible Flow Server`}
          canvas={
            run.startedAt ? (
              <iframe
                ref={frameEl}
                key={`${run.id}:${theme}`}
                className="flow-frame"
                src={viewer}
                title={`Run ${run.number} on the canvas`}
              />
            ) : (
              <p className="muted wb-empty">The canvas shows the run once it started.</p>
            )
          }
          details={details}
          kept={debugDriver ? <DebugKept run={run} logs={view?.step?.logs ?? []} /> : undefined}
          terminal={terminal}
          problems={problems}
          problemCount={whys.length}
          toolbar={toolbar}
          statusText={
            <>
              <strong>{LABEL[shownState(run)] ?? run.state}</strong>
              {standingNow && ` · ${standingNow}`}
              {hostCount > 0 && ` · ${hostCount} ${hostCount === 1 ? 'host' : 'hosts'}`}
            </>
          }
          onRestart={restart ? () => void restart() : undefined}
          onRun={setRun}
          onError={setError}
        />
      </div>
    </>
  );
}
