// The run pages: every run, newest first; and one run, live while it goes: its canvas, its
// output, and what can be done with it.
import { useEffect, useRef, useState } from 'react';
import { atLeast, flowLevel, useProjectAccess } from './access';
import { api, type Run, type User } from './api';
import { RunApprovals } from './approvals';
import { Link, navigate } from './router';
import type { ThemeChoice } from './theme';
import { Loading, PageHead, Time, useLoad } from './ui';

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

export function RunPage({ id, me, theme }: { id: string; me: User; theme: ThemeChoice }) {
  const [run, setRun] = useState<Run>();
  const access = useProjectAccess(run?.project).data;
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    setRun(undefined);
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

  // The output follows its end unless the reader scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the output grows
  useEffect(() => {
    const el = pre.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  if (error)
    return (
      <>
        <PageHead title="Run" />
        <p className="notice error" role="alert">
          {error}
        </p>
      </>
    );
  if (!run) return <Loading state={{ loading: true }} />;
  const going = ACTIVE.includes(run.state);
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

  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link to="/runs">Runs</Link> / <span aria-current="page">#{run.number}</span>
      </nav>
      <PageHead
        title={`${run.flow.name} · run ${run.number}`}
        lead={
          <>
            <StateBadge state={run.state} /> {run.mode === 'real' ? 'real run' : 'skeleton run'}
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
          </>
        }
      >
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
      </PageHead>
      {run.error && (
        <p className={`notice ${run.state === 'cancelled' ? '' : 'error'}`} role="status">
          {run.error}
        </p>
      )}
      <RunApprovals run={run.id} changed={`${run.state}|${run.attempts}|${run.endedAt ?? ''}`} />
      <section className="panel" aria-labelledby="facts">
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
      <section className="panel run-canvas" aria-label="The run on the flow's canvas">
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
      <section className="panel" aria-labelledby="output">
        <h2 id="output">Output</h2>
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
        <p className="muted">
          <a href={`/api/v1/runs/${run.id}/output`} target="_blank" rel="noreferrer">
            All of it as text
          </a>
        </p>
      </section>
    </>
  );
}
