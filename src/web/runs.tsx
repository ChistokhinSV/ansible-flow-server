// The run pages: every run, newest first; and one run, live while it goes: its canvas, and beside
// it the approval that waits, its hosts, what went wrong and what ran; its output below (AFS-64).

import type { RunView } from '@ansible-flow/core/protocol';
import { useEffect, useRef, useState } from 'react';
import { atLeast, flowLevel, useProjectAccess } from './access';
import { api, type Run, type User } from './api';
import { RunApprovals } from './approvals';
import { Link, navigate } from './router';
import type { ThemeChoice } from './theme';
import { Loading, PageHead, span, Time, useLoad } from './ui';

const ACTIVE = ['queued', 'running', 'waiting'];
/** The output a page keeps; the rest is in the run's output file. */
const KEEP_OUTPUT = 2 * 1024 * 1024;

const LABEL: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  waiting: 'waiting for a decision',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  lost: 'lost',
};

export function StateBadge({ state }: { state: string }) {
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

/** A table of runs; `project` adds the project column's absence (a project page). */
export function RunTable({ runs, showProject = true }: { runs: Run[]; showProject?: boolean }) {
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Run</th>
            <th scope="col">Flow</th>
            <th scope="col">State</th>
            <th scope="col">Mode</th>
            <th scope="col">Commit</th>
            <th scope="col">By</th>
            <th scope="col">Started</th>
            {showProject && <th scope="col">Configuration</th>}
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>
                <Link to={`/runs/${run.id}`}>#{run.number}</Link>
              </td>
              <td>{run.flow.name}</td>
              <td>
                <StateBadge state={run.state} />
              </td>
              <td>
                {run.mode}
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
              </td>
              <td>
                <code>{run.commit.slice(0, 8)}</code>
              </td>
              <td>{run.requestedBy.login}</td>
              <td>
                <Time at={run.startedAt ?? run.createdAt} />
              </td>
              {showProject && <td>{run.config?.name ?? ''}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RunsPage() {
  const [state, setState] = useState('');
  const list = useLoad(() => api.runs({ ...(state ? { state } : {}), limit: 100 }), [state]);
  const going = list.data?.some((r) => ACTIVE.includes(r.state));
  // While runs go, the list keeps up with them.
  useEffect(() => {
    if (!going) return;
    const timer = setInterval(list.reload, 5000);
    return () => clearInterval(timer);
  }, [going, list.reload]);
  return (
    <>
      <PageHead title="Runs" lead="Every run on this server, the newest first.">
        <label className="inline">
          State{' '}
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">all</option>
            {Object.keys(LABEL).map((s) => (
              <option key={s} value={s}>
                {LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </PageHead>
      <Loading state={list} />
      {list.data?.length === 0 && (
        <p className="empty">No run yet. Runs start from a launch configuration of a project.</p>
      )}
      {!!list.data?.length && <RunTable runs={list.data} />}
    </>
  );
}

/** A run's state in a few words and a colour, for lists (AFS-64). */
export function RunWords({ state }: { state: string }) {
  const [text, tone] = WORDS[state] ?? [state, 'muted'];
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

/** Where a run stands, as a sentence: "Running for 6 min", "Went well in 2 min". */
function standing(run: Run): string {
  const from = run.startedAt ?? run.createdAt;
  switch (run.state) {
    case 'queued':
      return 'Queued';
    case 'running':
      return `Running for ${span(from)}`;
    case 'waiting':
      return 'Waiting for a decision';
    case 'succeeded':
      return `Went well in ${span(from, run.endedAt)}`;
    case 'failed':
      return `Failed after ${span(from, run.endedAt)}`;
    case 'cancelled':
      return 'Stopped';
    case 'lost':
      return 'Lost';
    default:
      return run.state;
  }
}

interface HostLine {
  host: string;
  words: string;
  tone: string;
  /** What went wrong, when it did. */
  why?: { task: string; msg?: string };
}

/** Each host of a run and how it fares, those with a problem first. */
function hostLines(view: RunView): HostLine[] {
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
        why: { task: f.task, ...(f.msg ? { msg: f.msg } : {}) },
      });
  for (const [host, reason] of Object.entries(summary.outcome))
    if (!problem.has(host)) problem.set(host, { host, words: reason, tone: 'bad-text' });
  // A problem a step rescued into a port: the host went on, but that is where it went wrong.
  for (const hosts of Object.values(summary.problems ?? {}))
    for (const [host, p] of Object.entries(hosts)) {
      const line = problem.get(host);
      if (line && !line.why) line.why = { task: p.task, ...(p.msg ? { msg: p.msg } : {}) };
    }
  const done = view.state !== 'running';
  const rest = summary.hosts
    .filter((h) => !problem.has(h))
    .map(
      (host): HostLine =>
        done
          ? { host, words: 'went well', tone: 'ok-text' }
          : { host, words: 'in progress', tone: 'muted' },
    );
  return [...problem.values(), ...rest];
}

const SHOWN_HOSTS = 8;

function Hosts({ lines }: { lines: HostLine[] }) {
  const [all, setAll] = useState(false);
  if (!lines.length) return null;
  const shown = all ? lines : lines.slice(0, SHOWN_HOSTS);
  return (
    <section className="hosts" aria-labelledby="hosts">
      <div className="section-head">
        <h2 id="hosts">Hosts</h2>
        {lines.length > SHOWN_HOSTS && (
          <button type="button" className="link small" onClick={() => setAll(!all)}>
            {all ? 'Fewer' : `All ${lines.length}`}
          </button>
        )}
      </div>
      <ul className="list">
        {shown.map((line) => (
          <li key={line.host}>
            <span className="item">
              <span className="mono">{line.host}</span>
              <span className={`end ${line.tone}`}>{line.words}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RunPage({ id, me, theme }: { id: string; me: User; theme: ThemeChoice }) {
  const [run, setRun] = useState<Run>();
  const [view, setView] = useState<RunView>();
  const access = useProjectAccess(run?.project).data;
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    setRun(undefined);
    setView(undefined);
    setOutput('');
    setError(undefined);
    api.run(id).then(setRun, (e: Error) => setError(e.message));
    // Everything after: the run's record, its output, as they change.
    const stream = new EventSource(`/api/v1/runs/${encodeURIComponent(id)}/events`);
    stream.addEventListener('run', (event) => setRun(JSON.parse((event as MessageEvent).data)));
    stream.addEventListener('output', (event) => {
      const { text } = JSON.parse((event as MessageEvent).data) as { text: string };
      setOutput((before) => {
        const all = before + text;
        return all.length > KEEP_OUTPUT ? all.slice(all.length - KEEP_OUTPUT) : all;
      });
    });
    stream.addEventListener('end', () => stream.close());
    return () => stream.close();
  }, [id]);

  // Its hosts, from how it went: read when it changes, and now and then while it goes.
  const going = run ? ACTIVE.includes(run.state) : false;
  const started = !!run?.startedAt;
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

  const title = run ? `${run.flow.name} · run ${run.number}` : 'Run';
  useEffect(() => {
    document.title = `${title} · Ansible Flow Server`;
  }, [title]);

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
  const act = async (what: 'cancel' | 'relaunch') => {
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
  const lines = view ? hostLines(view) : [];
  const failed = lines.filter((l) => l.tone === 'bad-text').length;
  const why = lines.find((l) => l.why);
  const by = run.requestedBy.login === me.login ? 'you' : run.requestedBy.login;

  return (
    <>
      <header className="run-head">
        <div>
          <nav aria-label="Breadcrumb" className="crumbs">
            <Link to="/runs">Runs</Link> / <span aria-current="page">#{run.number}</span>
          </nav>
          <h1>{title}</h1>
          <p>
            <StateBadge state={run.state} /> {standing(run)} · started by {by} ·{' '}
            {run.mode === 'real' ? 'real run' : 'check run'}
            {lines.length > 0 && (
              <>
                {' '}
                · {lines.length} {lines.length === 1 ? 'host' : 'hosts'}
                {failed > 0 && <span className="bad-text">, {failed} with a problem</span>}
              </>
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
            <button type="button" disabled={busy} onClick={() => act('relaunch')}>
              Run again
            </button>
          )}
        </div>
      </header>
      {(run.error || error) && (
        <div className="run-below run-notes">
          {run.error && (
            <p className={`notice ${run.state === 'cancelled' ? '' : 'error'}`} role="status">
              {run.error}
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
                {run.flow.name}{' '}
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
                by {run.requestedBy.login}
                {run.config && <> from “{run.config.name}”</>}, <Time at={run.createdAt} />
              </dd>
              <dt>Started</dt>
              <dd>
                <Time at={run.startedAt} />
              </dd>
              <dt>Ended</dt>
              <dd>{going ? 'not yet' : <Time at={run.endedAt} />}</dd>
              <dt>Hosts</dt>
              <dd>{run.targets.join(', ') || 'none'}</dd>
              {run.limit && (
                <>
                  <dt>Limit</dt>
                  <dd>
                    <code>{run.limit}</code>
                  </dd>
                </>
              )}
            </dl>
          </section>
        </aside>
      </div>
      <section className="run-below" aria-labelledby="output">
        <div className="section-head">
          <h2 id="output">Output</h2>
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
            {output}
          </pre>
        ) : (
          <p className="muted">{going ? 'Nothing yet.' : 'No output.'}</p>
        )}
      </section>
    </>
  );
}
