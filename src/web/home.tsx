// Home (AFS-64): who is here, what waits for them, the latest runs, and the workspaces. Plain
// sentences and short lists; the only tinted thing is the first approval that waits.
import { useEffect } from 'react';
import { api, type User } from './api';
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
