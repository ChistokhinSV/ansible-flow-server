// The run pages: every run, newest first; and one run, live while it goes: its canvas, and beside
// it the approval that waits, its hosts, what went wrong and what ran; its output below (AFS-64).

import type { RunView } from '@ansible-flow/core/protocol';
import { useEffect, useRef, useState } from 'react';
import { atLeast, flowLevel, launchesAny, useMyAccess, useProjectAccess } from './access';
import { AnsiText } from './ansi';
import {
  ApiError,
  api,
  type Project,
  type Run,
  type RunsFilter,
  runCursor,
  type User,
  type Workspace,
} from './api';
import { RunApprovals } from './approvals';
import { environmentAddress } from './environments';
import { Missing } from './help';
import { Link, navigate } from './router';
import type { ThemeChoice } from './theme';
import {
  ago,
  Breadcrumb,
  HelpLink,
  Loading,
  PageHead,
  span,
  Time,
  useLoad,
  WorkspaceName,
} from './ui';

export const ACTIVE = ['queued', 'running', 'waiting'];
/** AFS-143: a person as the pages show people: by name (the login on hover). */
export const personOf = (p: { login: string; name?: string | undefined }) => p.name || p.login;
/** How many runs the list asks for at once. */
const PAGE = 100;
/** The output a page keeps; the rest is in the run's output file. */
const KEEP_OUTPUT = 2 * 1024 * 1024;

const LABEL: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  waiting: 'waiting for a decision',
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
    return <span className="badge bad">{AGAINST[against]}</span>;
  const tone =
    state === 'succeeded'
      ? 'ok'
      : ['failed', 'lost'].includes(state)
        ? 'bad'
        : state === 'waiting'
          ? 'warn'
          : ACTIVE.includes(state)
            ? 'busy'
            : '';
  return <span className={`badge ${tone}`}>{LABEL[state] ?? state}</span>;
}

/**
 * Runs as rows (AFS-82): the flow and its run number, who started it and when, check or real,
 * from which configuration; where it stands in coloured words at the end.
 */
export function RunList({
  runs,
  me,
  showConfig = true,
}: {
  runs: Run[];
  me?: User;
  showConfig?: boolean;
}) {
  // AFS-95: runs are read down a column (which failed, whose, when), so each fact has its own;
  // where there is no room for columns (a phone, a narrow pane) a run is two lines again.
  return (
    <div className="runs-box">
      <ul className={showConfig ? 'list runs' : 'list runs no-config'}>
        <li className="runs-head" aria-hidden="true">
          <span>State</span>
          <span>Run</span>
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
                <RunWords state={run.state} against={run.decidedAgainst} />
              </span>
              <span className="title">
                {run.flow.name} <span className="muted">#{run.number}</span>
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
                {showConfig && <span className="c-fact">{run.config?.name ?? ''}</span>}
                <span className="c-fact">{run.mode === 'real' ? 'real' : 'check'}</span>
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
    ['running', 'Running'],
    ['waiting', 'Waiting'],
    ['failed', 'Failed'],
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

const STATES = ['running', 'waiting', 'failed', 'succeeded', 'queued', 'cancelled', 'lost'];

/** The choices the address holds (AFS-86), so that a reload or a shared link shows the same list. */
interface Choices {
  state: string;
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
  const [{ state, project, config, mine, q }, setChoices] = useState(choicesInAddress);
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
  }, [state, project, config, mine, q]);
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

  return (
    <>
      <PageHead help="runs.md" title="Runs" lead="Every run you may see, the newest first." />
      <div className="run-filters">
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
            {groups.map((w) => (
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
      {fresh && rows?.length === 0 && (
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
          {(state || project || mine || q) && (
            <>
              {' '}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setTyped('');
                  setChoices({ state: '', project: '', config: '', mine: false, q: '' });
                }}
              >
                Show all runs
              </button>
            </>
          )}
        </p>
      )}
      {!!rows?.length && <RunList runs={rows} me={me} />}
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
  return <span className={tone}>{text}</span>;
}
const WORDS: Record<string, [string, string]> = {
  queued: ['queued', 'muted'],
  running: ['running', 'busy-text'],
  waiting: ['waiting for a decision', 'warn-text'],
  succeeded: ['went well', 'ok-text'],
  failed: ['failed', 'bad-text'],
  cancelled: ['stopped', 'muted'],
  lost: ['lost', 'bad-text'],
};

/**
 * How long, after the state's badge: "running · for 6 min", "went well · in 2 min". AFS-143: the
 * badge says the state; this does not say it again.
 */
function standing(run: Run): string {
  const from = run.startedAt ?? run.createdAt;
  switch (run.state) {
    case 'running':
      return `for ${span(from)}`;
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

interface HostLine {
  host: string;
  words: string;
  tone: string;
  /** What went wrong, when it did. */
  why?: { task: string; msg?: string };
}

/** Each host of a run and how it fares, those with a problem first. */
function hostLines(view: RunView, state: Run['state'], against?: string): HostLine[] {
  const summary = view.summary;
  if (!summary) return [];
  const problem = new Map<string, HostLine>();
  for (const host of summary.unreachable)
    problem.set(host, { host, words: 'not reachable', tone: 'bad-text' });
  for (const f of summary.failures)
    if (!problem.has(f.host))
      problem.set(f.host, {
        host: f.host,
        words: 'failed',
        tone: 'bad-text',
        why: { task: f.task, ...(f.msg ? { msg: plainWhy(f.msg) } : {}) },
      });
  for (const [host, reason] of Object.entries(summary.outcome))
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
  for (const hosts of Object.values(summary.problems ?? {}))
    for (const [host, p] of Object.entries(hosts)) {
      const line = problem.get(host);
      if (line && !line.why) line.why = { task: p.task, ...(p.msg ? { msg: p.msg } : {}) };
    }
  // AFS-131: the run's own state says whether it ended: a stopped run's view can still read as
  // running (it was stopped while it waited, or before its last view was written).
  const going = state === 'running' || state === 'queued' || state === 'waiting';
  const rest = summary.hosts
    .filter((h) => !problem.has(h))
    .map(
      (host): HostLine =>
        state === 'cancelled'
          ? { host, words: 'stopped', tone: 'muted' }
          : // AFS-146: a run held at an approval: its hosts wait for the decision, they are
            // not in progress.
            state === 'waiting'
            ? { host, words: 'waiting for a decision', tone: 'muted' }
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
function Hosts({ lines }: { lines: HostLine[] }) {
  const [all, setAll] = useState(false);
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
            <span className="item">
              <span className="mono" title={line.host}>
                {line.host}
              </span>
              <span className={`end ${line.tone}`}>{line.words}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

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
 * AFS-147: what Run again does, in words: the button's title (mode and the inputs it reuses) and,
 * for a real run, the question asked first (Launch's, with the inputs).
 */
export function againWords(run: Run): { title: string; confirm: string } {
  const inputs = Object.entries(run.inputs).map(([name, v]) => `${name} = ${inputText(v)}`);
  const reuses = inputs.length
    ? `It reuses the inputs ${inputs.join(', ')}.`
    : 'It takes no inputs.';
  const where = run.limit ? ` limited to ${run.limit}` : '';
  const mode = run.mode === 'real' ? 'A real run' : 'A check run';
  return {
    title: `${mode} again, at the same commit${where}. ${reuses}`,
    confirm: `Run ${run.flow.name} for real again${where}? It changes the hosts it reaches. ${reuses}`,
  };
}

export function RunPage({ id, me, theme }: { id: string; me: User; theme: ThemeChoice }) {
  const [run, setRun] = useState<Run>();
  const [view, setView] = useState<RunView>();
  const access = useProjectAccess(run?.project).data;
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string>();
  /** AFS-152: the run is not there, or not shared with this person. */
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const below = useRef<HTMLElement>(null);
  const projectId = run?.project;
  const flowFile = run?.flow.file;
  const configId = run?.config?.id;
  const where = useLoad(
    async () => (projectId && flowFile ? belongs(projectId, flowFile, configId) : null),
    [projectId, flowFile, configId],
  ).data;

  useEffect(() => {
    setRun(undefined);
    setView(undefined);
    setOutput('');
    setError(undefined);
    setMissing(false);
    let live = true;
    let stream: EventSource | undefined;
    // AFS-152: the run's events are asked for once the run is there: not after a 404.
    api.run(id).then(
      (found) => {
        if (!live) return;
        setRun(found);
        // Everything after: the run's record, its output, as they change.
        const events = new EventSource(`/api/v1/runs/${encodeURIComponent(id)}/events`);
        stream = events;
        events.addEventListener('run', (event) => setRun(JSON.parse((event as MessageEvent).data)));
        events.addEventListener('output', (event) => {
          const { text } = JSON.parse((event as MessageEvent).data) as { text: string };
          setOutput((before) => {
            const all = before + text;
            if (all.length <= KEEP_OUTPUT) return all;
            // Cut at a line's start, so no colour code is cut in two.
            const cut = all.indexOf(String.fromCharCode(10), all.length - KEEP_OUTPUT);
            return cut < 0 ? all.slice(all.length - KEEP_OUTPUT) : all.slice(cut + 1);
          });
        });
        events.addEventListener('end', () => events.close());
      },
      (e: Error) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) setMissing(true);
        else setError(e.message);
      },
    );
    return () => {
      live = false;
      stream?.close();
    };
  }, [id]);

  // Its hosts, from how it went: read when it changes, and now and then while it goes.
  const going = run ? ACTIVE.includes(run.state) : false;
  // AFS-147: of this run: right after Run again the run shown is still the one before for a moment
  // (its start time would ask for the new run's view before it has one).
  const started = !!run?.startedAt && run.id === id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the run's state changes
  useEffect(() => {
    if (!started) return;
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

  // AFS-96: Show Terminal on the canvas of this page scrolls to the output (the canvas asks, in its
  // frame); from elsewhere it opens this page at #output. The output is marked for a moment, so it
  // is plain where the eye should go.
  const [shownOutput, setShownOutput] = useState(0);
  const toOutput = () => {
    below.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    below.current?.focus({ preventScroll: true });
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
    const timer = setTimeout(() => setShownOutput(0), 1600);
    return () => clearTimeout(timer);
  }, [shownOutput]);

  // AFS-139, AFS-143: a run is "flow #number", as the lists, the audit log and the mails name it.
  const title = run ? `${run.flow.name} #${run.number}` : 'Run';
  useEffect(() => {
    document.title = `${title} · Ansible Flow Server`;
  }, [title]);

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
  if (!run || run.id !== id)
    return (
      <div className="run-below">
        <Loading state={{ loading: true }} />
      </div>
    );
  // operator on the run's flow stops it and runs it again.
  const mayAct = me.admin || atLeast(flowLevel(access, run.flow.file), 'operator');
  const again = againWords(run);
  const act = async (what: 'cancel' | 'relaunch') => {
    // AFS-147: a real run again changes the hosts again: asked first, as Launch asks, with the
    // inputs it reuses.
    if (what === 'relaunch' && run.mode === 'real' && !window.confirm(again.confirm)) return;
    setBusy(true);
    try {
      if (what === 'cancel') setRun(await api.cancelRun(run.id));
      else navigate(`/runs/${(await api.relaunchRun(run.id)).id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const viewer = `/viewer.html?project=${encodeURIComponent(run.project)}&path=${encodeURIComponent(
    run.flow.file,
  )}&commit=${run.commit}&run=${run.id}&theme=${theme === 'system' ? 'auto' : theme}`;
  const lines = view ? hostLines(view, run.state, run.decidedAgainst) : [];
  const failed = lines.filter((l) => l.tone === 'bad-text').length;
  const why = lines.find((l) => l.why);
  const by = personOf(run.requestedBy);

  return (
    <>
      <header className="run-head">
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
                /{' '}
                {where.config && run.config && (
                  <>
                    <Link to={where.config}>{run.config.name}</Link> /{' '}
                  </>
                )}
              </>
            ) : (
              // Where it belongs is not known (yet, or not to this person): the list is the way back.
              <>
                <Link to="/runs">Runs</Link> /{' '}
              </>
            )}
            <span aria-current="page">#{run.number}</span>
          </Breadcrumb>
          <div className="title-line">
            {/* AFS-147: the number counts the project's runs, not the flow's. */}
            <h1 tabIndex={-1} title={`Run ${run.number} of the project's runs`}>
              {title}
            </h1>
            <HelpLink page="runs.md" />
          </div>
          <p>
            <StateBadge state={run.state} against={run.decidedAgainst} />
            {standing(run) && ` ${standing(run)}`} · started by {by} ·{' '}
            {run.mode === 'real' ? 'real run' : 'check run'}
            {lines.length > 0 && (
              <>
                {' '}
                · {lines.length} {lines.length === 1 ? 'host' : 'hosts'}
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
            {!!run.skippedTargets?.length && (
              <span className="warn-text">
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
            {run.cancelRequested && going && ' · asked to stop'}
          </p>
        </div>
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              // The output is the last thing on a long page: go there, and read on from there.
              toOutput();
            }}
          >
            To the output
          </button>
          <Link to="/runs" className="run-link">
            All runs
          </Link>
          {mayAct && going && (
            <button
              type="button"
              className="danger"
              disabled={busy || run.cancelRequested}
              onClick={() => act('cancel')}
            >
              Stop
            </button>
          )}
          {mayAct && !going && (
            <button
              type="button"
              disabled={busy}
              title={again.title}
              onClick={() => act('relaunch')}
            >
              Run again
            </button>
          )}
        </div>
      </header>
      {(run.error || error || !!run.skippedTargets?.length) && (
        <div className="run-below run-notes">
          {run.error && (
            <p className={`notice ${run.state === 'cancelled' ? '' : 'error'}`} role="status">
              {plainWhy(run.error)}
            </p>
          )}
          {/* AFS-147: targets Ansible dropped are said, also on a run that went well. */}
          {!!run.skippedTargets?.length && (
            <p className="notice warn" role="status" data-skipped-targets>
              Not in the inventory{run.inventory ? ` ${run.inventory}` : ''}, so nothing ran there:{' '}
              {run.skippedTargets.join(', ')}
            </p>
          )}
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      <div className="run-body">
        <section className="run-flow" aria-label="The run on the flow's canvas">
          {run.startedAt ? (
            <iframe
              key={`${run.id}:${theme}`}
              className="flow-frame"
              src={viewer}
              title={`Run ${run.number} on the canvas`}
            />
          ) : (
            <p className="muted">The canvas shows the run once it started.</p>
          )}
        </section>
        <aside className="run-side" aria-label="Run details">
          <RunApprovals
            run={run.id}
            changed={`${run.state}|${run.attempts}|${run.endedAt ?? ''}`}
          />
          <Hosts lines={lines} />
          {view?.summary?.outputs || view?.summary?.outputsTooLarge ? (
            <Outputs summary={view.summary} />
          ) : null}
          {why?.why && (
            <section className="why" aria-labelledby="why">
              <h2 id="why">
                Why {why.host} {why.words === 'not reachable' ? 'was not reached' : 'failed'}
              </h2>
              <p>At “{why.why.task}”.</p>
              {why.why.msg && <pre>{why.why.msg}</pre>}
            </section>
          )}
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
              <dd>{run.limit ? <code>{run.limit}</code> : 'none'}</dd>
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
        </aside>
      </div>
      <section
        ref={below}
        tabIndex={-1}
        id="output"
        className={`run-below run-output${shownOutput ? ' run-output-shown' : ''}`}
        aria-labelledby="output-head"
      >
        <div className="section-head">
          <h2 id="output-head">Terminal output</h2>
          <a href={`/api/v1/runs/${run.id}/output`} target="_blank" rel="noreferrer">
            All of it as text
          </a>
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
            <AnsiText text={output} />
          </pre>
        ) : (
          <p className="muted">{going ? 'Nothing yet.' : 'No output.'}</p>
        )}
      </section>
    </>
  );
}
