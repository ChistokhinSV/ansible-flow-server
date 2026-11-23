// Home (AFS-64): who is here, what waits for them, the latest runs, and the workspaces. Plain
// sentences and short lists; the only tinted thing is the first approval that waits.
// AFS-85: and what this person launched lately, one step from launching it again.
import { Fragment, type ReactNode, useEffect } from 'react';
import { launchesAny, useMyAccess } from './access';
import { api, type Run, type User, type Workspace } from './api';
import { launchAddress } from './launch';
import { Link } from './router';
import { RunList } from './runs';
import { ago, Loading, PageHead, span, useLoad } from './ui';

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
  const configs = new Map<string, Promise<{ id: string; name: string; flowGone?: string }[]>>();
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
      // AFS-187: a configuration whose flow is gone cannot be launched again.
      if (!config || config.flowGone) return undefined;
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
  const myAccess = useMyAccess();
  // Runs end and approvals arrive while the page is open: it looks again now and then.
  useEffect(() => {
    const timer = setInterval(() => {
      runs.reload();
      approvals.reload();
    }, 15_000);
    return () => clearInterval(timer);
  }, [runs.reload, approvals.reload]);

  const mine = approvals.data?.filter((a) => a.mayDecide) ?? [];
  const yours = [
    ...new Set(
      (approvals.data ?? [])
        .filter((a) => !a.mayDecide && a.requestedBy === me.login)
        .map((a) => a.run.id),
    ),
  ];
  const today = new Date().toDateString();
  const todays = (runs.data ?? []).filter((r) => new Date(r.createdAt).toDateString() === today);
  const well = todays.filter((r) => r.state === 'succeeded').length;
  // AFS-102: what did not go well is said too, not only what did.
  // AFS-193: a run decided against at its approval is counted as rejected, not failed.
  const failed = todays.filter(
    (r) => (r.state === 'failed' && !r.decidedAgainst) || r.state === 'lost',
  ).length;
  const rejected = todays.filter((r) => r.state === 'failed' && r.decidedAgainst).length;
  const waiting = todays.filter((r) => r.state === 'waiting').length;
  // AFS-147: every run of the day is counted somewhere: stopped and still going too.
  const stopped = todays.filter((r) => r.state === 'cancelled').length;
  // AFS-205: a step-by-step run paused before a step waits for someone, it does not go.
  const paused = todays.filter((r) => r.state === 'running' && r.pausedBefore).length;
  const going = todays.filter(
    (r) => (r.state === 'running' && !r.pausedBefore) || r.state === 'queued',
  ).length;
  // AFS-205: your own paused runs (of any day): they wait for you.
  const yourPaused = (runs.data ?? []).filter(
    (r) => r.state === 'running' && r.pausedBefore && r.requestedBy.login === me.login,
  );
  // AFS-208: each count is a link to those runs, as the runs that wait are.
  const counts: [string, ReactNode][] = [
    ['well', <Link key="well" to="/runs?state=succeeded">{`${well} went well`}</Link>],
    ...(failed
      ? [
          ['failed', <Link key="failed" to="/runs?state=failed">{`${failed} failed`}</Link>] as [
            string,
            ReactNode,
          ],
        ]
      : []),
    ...(rejected
      ? [
          [
            'rejected',
            <Link key="rejected" to="/runs?state=rejected">{`${rejected} rejected`}</Link>,
          ] as [string, ReactNode],
        ]
      : []),
    ...(stopped
      ? [
          [
            'stopped',
            <Link key="stopped" to="/runs?state=cancelled">{`${stopped} stopped`}</Link>,
          ] as [string, ReactNode],
        ]
      : []),
    ...(going
      ? [['going', `${going} still ${going === 1 ? 'goes' : 'go'}`] as [string, ReactNode]]
      : []),
  ];
  // AFS-146: whose decision your own held run waits for, when it is one run.
  const heldFor =
    yours.length === 1
      ? approvals.data?.find((a) => a.run.id === yours[0])?.gate.deciders
      : undefined;
  const summary = (
    <>
      {todays.length ? (
        <>
          {/* AFS-208: everyone's runs you may see, not only yours. */}
          {plural(todays.length, 'run', 'runs')} today, by everyone:{' '}
          {counts.map(([k, c], i) => (
            <Fragment key={k}>
              {i ? ', ' : ''}
              {c}
            </Fragment>
          ))}
          {waiting ? (
            <>
              {', '}
              {/* AFS-147: the runs that wait are a link to them. */}
              <Link to="/runs?state=waiting">
                {waiting} {waiting === 1 ? 'waits' : 'wait'} for a decision
              </Link>
            </>
          ) : null}
          {paused ? (
            <>
              {', '}
              <Link to="/runs?state=paused">{paused} paused step by step</Link>
            </>
          ) : null}
          .
        </>
      ) : (
        'No run yet today.'
      )}{' '}
      {mine.length
        ? `${plural(mine.length, 'approval is', 'approvals are')} waiting for you.`
        : yourPaused.length
          ? null
          : 'Nothing waits for you.'}
      {/* AFS-205: your run paused step by step waits for your Step or Continue. */}
      {yourPaused.length > 0 && (
        <>
          {mine.length ? ' ' : ''}
          <Link
            to={
              yourPaused.length === 1 ? `/runs/${yourPaused[0]?.id}` : '/runs?state=paused&mine=1'
            }
          >
            {yourPaused.length === 1
              ? `Your run #${yourPaused[0]?.number} of ${yourPaused[0]?.flow.name} is paused before ${yourPaused[0]?.pausedBefore}`
              : `${yourPaused.length} runs of yours are paused step by step`}
          </Link>
          : Step or Continue goes on.
        </>
      )}
      {/* AFS-144: your own runs held at a gate for someone else are said too. */}
      {yours.length > 0 && (
        <>
          {' '}
          <Link to={yours.length === 1 ? `/runs/${yours[0]}` : '/runs?state=waiting&mine=1'}>
            {heldFor?.length
              ? `1 run of yours waits for a decision by ${heldFor.length === 1 ? heldFor[0] : `${heldFor.slice(0, -1).join(', ')} or ${heldFor.at(-1)}`}`
              : `${plural(yours.length, 'run', 'runs')} of yours ${yours.length === 1 ? 'waits' : 'wait'} for someone else's decision`}
          </Link>
          .
        </>
      )}
    </>
  );
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
        help="web-pages.md"
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
                        · {a.run.flow.name} #{a.run.number}
                      </span>
                    </span>
                  </span>
                  <span className="since">waiting for {span(a.gate.createdAt)}</span>
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
              {/* AFS-152: where runs start, only to who may start one. */}
              {launchesAny(myAccess.data)
                ? 'No run yet. Runs start from a launch configuration of a project.'
                : 'No run yet.'}
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
              {me.admin ? (
                <>
                  No workspace yet. <Link to="/workspaces">Add the first one.</Link>
                </>
              ) : (
                // AFS-135: the server may have workspaces this person has no access to yet.
                // AFS-152: who to ask.
                `You have no access to a workspace yet: ask an administrator for it${
                  myAccess.data?.administrators.length
                    ? ` (${myAccess.data.administrators.slice(0, 3).join(', ')})`
                    : ''
                }.`
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
