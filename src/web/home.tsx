// Home (AFS-64): who is here, what waits for them, the latest runs, and the workspaces. Plain
// sentences and short lists; the only tinted thing is the first approval that waits.
// AFS-85: and what this person launched lately, one step from launching it again.
import { useEffect } from 'react';
import { api, type Run, type User, type Workspace } from './api';
import { launchAddress } from './launch';
import { Link } from './router';
import { RunList } from './runs';
import { ago, Loading, PageHead, useLoad } from './ui';

const greeting = (hour: number) =>
  hour < 5
    ? 'Good evening'
    : hour < 12
      ? 'Good morning'
      : hour < 18
        ? 'Good afternoon'
        : 'Good evening';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How many configurations "Launch again" offers. */
const AGAIN = 5;

interface Again {
  to: string;
  name: string;
  flow: string;
  project: string;
  at: string;
}

/**
 * The launch configurations of these runs, with their addresses. A run names its project and its
 * configuration by id: the keys an address is made of are read from the workspaces' projects, and
 * a configuration that is gone since, or whose project this person no longer sees, is left out.
 */
async function launchAgain(runs: Run[], workspaces: Workspace[]): Promise<Again[]> {
  if (!runs.length) return [];
  const projects = (
    await Promise.all(
      workspaces.map((w) =>
        api.projects(w.key).then(
          (list) => list.map((p) => ({ id: p.id, key: p.key, name: p.name, workspace: w.key })),
          () => [],
        ),
      ),
    )
  ).flat();
  const configs = new Map<string, Promise<{ id: string; name: string }[]>>();
  const configsOf = (project: string) => {
    let asked = configs.get(project);
    if (!asked) {
      asked = api.launchConfigs(project).catch(() => []);
      configs.set(project, asked);
    }
    return asked;
  };
  const rows = await Promise.all(
    runs.map(async (run): Promise<Again | undefined> => {
      const project = projects.find((p) => p.id === run.project);
      if (!project || !run.config) return undefined;
      const config = (await configsOf(project.id)).find((c) => c.id === run.config?.id);
      if (!config) return undefined;
      return {
        to: launchAddress(project.workspace, project.key, config.id),
        name: config.name,
        flow: run.flow.name,
        project: project.name,
        at: run.startedAt ?? run.createdAt,
      };
    }),
  );
  return rows.filter((r): r is Again => !!r).slice(0, AGAIN);
}

export function Home({ me }: { me: User }) {
  const runs = useLoad(() => api.runs({ limit: 100 }), []);
  const approvals = useLoad(() => api.approvals(), []);
  const workspaces = useLoad(api.workspaces, []);
  // Runs end and approvals arrive while the page is open: it looks again now and then.
  useEffect(() => {
    const timer = setInterval(() => {
      runs.reload();
      approvals.reload();
    }, 15_000);
    return () => clearInterval(timer);
  }, [runs.reload, approvals.reload]);

  const mine = approvals.data?.filter((a) => a.mayDecide) ?? [];
  const today = new Date().toDateString();
  const todays = (runs.data ?? []).filter((r) => new Date(r.createdAt).toDateString() === today);
  const well = todays.filter((r) => r.state === 'succeeded').length;
  const summary = [
    todays.length
      ? `${plural(todays.length, 'run', 'runs')} today, ${well} went well.`
      : 'No run yet today.',
    mine.length
      ? `${plural(mine.length, 'approval is', 'approvals are')} waiting for you.`
      : 'Nothing waits for you.',
  ].join(' ');
  const first = me.name.split(/\s+/)[0] || me.name;
  // AFS-85: the newest run of each configuration this person launched themselves (a schedule's
  // runs are its owner's, and not launched by hand). A few more than are shown, for the ones
  // that are gone since.
  const started: Run[] = [];
  for (const run of runs.data ?? []) {
    if (!run.config || run.schedule || run.requestedBy.login !== me.login) continue;
    if (started.some((r) => r.config?.id === run.config?.id)) continue;
    if (started.push(run) >= AGAIN + 3) break;
  }
  const again = useLoad(
    () => launchAgain(started, workspaces.data ?? []),
    [started.map((r) => `${r.config?.id}@${r.id}`).join(' '), workspaces.data],
  );

  return (
    <div className="home">
      <PageHead
        title={`${greeting(new Date().getHours())}, ${first}`}
        lead={runs.data && approvals.data ? summary : undefined}
      />
      {mine.length > 0 && (
        <section aria-labelledby="waiting">
          <h2 id="waiting">Waiting for you</h2>
          <ul className="waiting">
            {mine.slice(0, 5).map((a) => (
              <li key={a.gate.id}>
                <Link to={`/runs/${a.run.id}`}>
                  <span className="what">
                    <span>
                      <strong>{a.gate.node.title}</strong>{' '}
                      <span className="muted">
                        · {a.run.flow.name}, run {a.run.number}
                      </span>
                    </span>
                  </span>
                  <span className="since">waiting since {ago(a.gate.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
          {mine.length > 5 && (
            <p className="small">
              <Link to="/approvals">All {mine.length} approvals</Link>
            </p>
          )}
        </section>
      )}
      {!!again.data?.length && (
        <section aria-labelledby="again">
          <h2 id="again">Launch again</h2>
          <ul className="list">
            {again.data.map((a) => (
              <li key={a.to}>
                <Link to={a.to}>
                  <span className="two">
                    <span className="title">{a.name}</span>
                    <span className="sub">
                      {a.flow} · {a.project}
                    </span>
                  </span>
                  <span className="end">last run {ago(a.at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="home-split">
        <section aria-labelledby="recent">
          <div className="section-head">
            <h2 id="recent">Latest runs</h2>
            <Link to="/runs">All runs</Link>
          </div>
          <Loading state={runs} />
          {runs.data?.length === 0 && (
            <p className="empty">
              No run yet. Runs start from a launch configuration of a project.
            </p>
          )}
          {!!runs.data?.length && <RunList runs={runs.data.slice(0, 8)} me={me} />}
        </section>
        <section aria-labelledby="spaces">
          <div className="section-head">
            <h2 id="spaces">Workspaces</h2>
            <Link to="/workspaces">All workspaces</Link>
          </div>
          <Loading state={workspaces} />
          {workspaces.data?.length === 0 && (
            <p className="empty">
              No workspace yet.{' '}
              {me.admin ? (
                <Link to="/workspaces">Add the first one.</Link>
              ) : (
                'An administrator makes the first one.'
              )}
            </p>
          )}
          {!!workspaces.data?.length && (
            <ul className="list">
              {workspaces.data.map((w) => (
                <li key={w.id}>
                  <Link to={`/w/${w.key}`}>
                    <span className="two">
                      <span className="title">{w.name}</span>
                      {w.description && <span className="sub">{w.description}</span>}
                    </span>
                    <span className="end">{plural(w.projects, 'project', 'projects')}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
