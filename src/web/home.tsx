// Home (AFS-64), an inbox since AFS-212 (ADR-0039 §9, §10): the day in one sentence and four
// numbers, what needs this person with what they may do about it, what runs now, what they may
// launch again and the latest runs. It spans every workspace they may see (it does not follow the
// menu's workspace); `?workspace=<key>` narrows it to one.
// AFS-85: and what this person launched lately, one step from launching it again.
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import { launchesAny, useMyAccess } from './access';
import { api, type InboxItem, type InboxVerb, type Run, type User, type Workspace } from './api';
import { launchAddress } from './launch';
import { Link, useSearch } from './router';
import { ModeBadge, RunList, StateGlyph } from './runs';
import { ago, Loading, PageHead, span, useLoad, WorkspaceFilter } from './ui';

const greeting = (hour: number) =>
  hour < 5
    ? 'Good evening'
    : hour < 12
      ? 'Good morning'
      : hour < 18
        ? 'Good afternoon'
        : 'Good evening';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How many configurations "Launch again" offers, and runs "Running now" lists. */
const AGAIN = 5;
const RUNNING = 5;

/** The start of this person's day, by their clock: the day's numbers count from it. */
export const midnight = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

interface ProjectAt {
  id: string;
  key: string;
  name: string;
  workspace: { key: string; name: string };
}

/** Every project of the workspaces this person sees, with its workspace: runs name only ids. */
async function projectsOf(workspaces: Workspace[]): Promise<ProjectAt[]> {
  return (
    await Promise.all(
      workspaces.map((w) =>
        api.projects(w.key).then(
          (list) =>
            list.map((p) => ({
              id: p.id,
              key: p.key,
              name: p.name,
              workspace: { key: w.key, name: w.name },
            })),
          () => [],
        ),
      ),
    )
  ).flat();
}

interface Again {
  to: string;
  name: string;
  flow: string;
  workspace: string;
  mode: string;
  at: string;
}

/**
 * The launch configurations of these runs, with their addresses. A configuration that is gone
 * since, or whose project this person no longer sees, is left out.
 */
async function launchAgain(runs: Run[], projects: ProjectAt[]): Promise<Again[]> {
  if (!runs.length) return [];
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
        to: launchAddress(project.workspace.key, project.key, config.id),
        name: config.name,
        flow: run.flow.name,
        workspace: project.workspace.name,
        mode: run.mode,
        at: run.startedAt ?? run.createdAt,
      };
    }),
  );
  return rows.filter((r): r is Again => !!r).slice(0, AGAIN);
}

/** "12 min": how long until `at`, never less than nothing. */
const until = (at: string) => {
  const minutes = Math.max(0, Math.round((Date.parse(at) - Date.now()) / 60_000));
  return minutes >= 120 ? `${Math.round(minutes / 60)} h` : `${minutes} min`;
};

/** Where an item's run opens: its page, or an action's progress for who only runs the action. */
export const runAddress = (run: NonNullable<InboxItem['run']>) =>
  run.asRunner
    ? `/actions/runs/${encodeURIComponent(run.id)}`
    : `/runs/${encodeURIComponent(run.id)}`;

const draftAddress = (item: InboxItem) =>
  item.workspace && item.project && item.draft
    ? `/w/${item.workspace.key}/${item.project.key}/flow/${item.draft.file}?edit=1`
    : '/';

/** The item's shape: a run's state where it is about a run. */
function KindGlyph({ item }: { item: InboxItem }) {
  if (item.kind === 'approval' || item.kind === 'request') return <StateGlyph state="waiting" />;
  if (item.kind === 'paused') return <StateGlyph state="paused" />;
  if (item.kind === 'failed') return <StateGlyph state={item.failure?.lost ? 'lost' : 'failed'} />;
  // A draft: a pen; the certificate: a padlock.
  return (
    <svg
      className="state-glyph"
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
      {item.kind === 'draft' ? (
        <path d="M3 13l1-3.5 6.5-6.5 2.5 2.5-6.5 6.5zM9.5 4l2.5 2.5" />
      ) : (
        <path d="M4.5 7.5h7v6h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2" />
      )}
    </svg>
  );
}

/** What the item is, in a line, and the facts under it (its workspace first). */
function itemWords(item: InboxItem): { what: ReactNode; facts: string[] } {
  const run = item.run;
  const named = run ? `${run.flow.name} #${run.number}` : '';
  const place = item.workspace?.name ?? 'This server';
  switch (item.kind) {
    case 'approval':
      return {
        what: (
          <>
            <strong>{item.approval?.step}</strong> · {named}
          </>
        ),
        facts: [
          place,
          `launched by ${item.approval?.requestedBy}`,
          `${run?.mode === 'check' ? 'check' : 'real'} run`,
          `waiting ${span(item.since)}`,
        ],
      };
    case 'request':
      return {
        what: (
          <>
            <strong>{named}</strong> waits for a decision
          </>
        ),
        facts: [
          place,
          item.approval?.deciders?.length
            ? `by ${item.approval.deciders.join(' or ')}`
            : `at ${item.approval?.step || 'its approval'}`,
          `for ${span(item.since)}`,
        ],
      };
    case 'paused':
      return {
        what: (
          <>
            <strong>{named}</strong> is paused before {item.pause?.before}
          </>
        ),
        facts: [
          place,
          run?.debug ? 'debug run' : 'step by step',
          ...(item.pause?.stopsAt ? [`stops by itself in ${until(item.pause.stopsAt)}`] : []),
        ],
      };
    case 'failed':
      return {
        what: (
          <>
            <strong>{named}</strong> {item.failure?.lost ? 'was lost' : 'failed'}
          </>
        ),
        facts: [
          place,
          ...(item.failure?.hosts?.failed
            ? [`${plural(item.failure.hosts.failed, 'host', 'hosts')} failed`]
            : []),
          ...(item.failure?.error ? [item.failure.error] : []),
          ago(item.since),
        ],
      };
    case 'draft':
      return {
        what: (
          <>
            <strong>Your draft of {item.draft?.flow}</strong> is not saved
          </>
        ),
        facts: [
          place,
          ...(item.draft?.behind ? ['the flow changed since it began'] : []),
          ...(item.draft?.others.length ? [`${item.draft.others.join(', ')} edited it too`] : []),
          `last changed ${ago(item.since)}`,
        ],
      };
    default:
      return {
        what: <strong>{item.title}</strong>,
        facts: [place, ...(item.certificate?.names.slice(0, 1) ?? [])],
      };
  }
}

const VERB_WORDS: Record<InboxVerb, string> = {
  review: 'Review',
  open: 'Open',
  step: 'Step',
  continue: 'Continue',
  runAgain: 'Run again',
  openDraft: 'Open draft',
  replace: 'Replace',
};

function InboxRow({ item, onDone }: { item: InboxItem; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { what, facts } = itemWords(item);
  const run = item.run;
  // The visible word first, then what it is about: a list of "Open" buttons says which is which.
  const about = run ? `${run.flow.name} #${run.number}` : (item.draft?.flow ?? item.title);
  const step = async (command: 'step' | 'continue') => {
    if (!run) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.stepRun(run.id, { command });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const verb = (v: InboxVerb, main: boolean) => {
    const label = `${VERB_WORDS[v]}: ${about}`;
    const className = main ? 'button primary' : 'button';
    if (v === 'step' || v === 'continue')
      return (
        <button
          key={v}
          type="button"
          className={main ? 'primary' : undefined}
          disabled={busy}
          aria-label={label}
          onClick={() => void step(v)}
        >
          {VERB_WORDS[v]}
        </button>
      );
    const to =
      v === 'openDraft'
        ? draftAddress(item)
        : v === 'replace'
          ? '/admin/certificate'
          : run
            ? // Run again opens the run's own Run again menu: its choices and questions live there.
              `${runAddress(run)}${v === 'runAgain' ? '?again=1' : ''}`
            : '/';
    return (
      <Link key={v} to={to} className={className} aria-label={label}>
        {VERB_WORDS[v]}
      </Link>
    );
  };
  // An approval's Review is the main thing to do; one's own run waiting for others is only said.
  const verbs =
    item.kind === 'paused'
      ? (['continue', 'step', 'open'] as InboxVerb[]).filter((v) => item.verbs.includes(v))
      : item.verbs;
  return (
    <li data-kind={item.kind}>
      <span className="inbox-glyph" data-kind={item.kind}>
        <KindGlyph item={item} />
      </span>
      <span className="inbox-what">
        <span className="inbox-title">{what}</span>
        <span className="inbox-facts">{facts.join(' · ')}</span>
        {error && (
          <span className="bad-text" role="alert">
            {error}
          </span>
        )}
      </span>
      <span className="inbox-verbs">
        {verbs.map((v, i) => verb(v, i === 0 && item.kind !== 'request'))}
      </span>
    </li>
  );
}

export function Home({ me }: { me: User }) {
  const chosen = new URLSearchParams(useSearch()).get('workspace') ?? undefined;
  const inbox = useLoad(() => api.inbox(midnight(), chosen), [chosen]);
  const runs = useLoad(() => api.runs({ limit: 100 }), []);
  const workspaces = useLoad(api.workspaces, []);
  const projects = useLoad(() => projectsOf(workspaces.data ?? []), [workspaces.data]);
  const myAccess = useMyAccess();
  // Runs end and approvals arrive while the page is open: it looks again now and then.
  useEffect(() => {
    const timer = setInterval(() => {
      inbox.reload();
      runs.reload();
    }, 15_000);
    return () => clearInterval(timer);
  }, [inbox.reload, runs.reload]);

  const at = new Map((projects.data ?? []).map((p) => [p.id, p]));
  // The runs of the workspace asked for; all of them otherwise. Until the projects are read, a
  // run's workspace is not known: none is left out for that.
  const here = (runs.data ?? []).filter(
    (r) => !chosen || !projects.data || at.get(r.project)?.workspace.key === chosen,
  );
  const shownWorkspace = workspaces.data?.find((w) => w.key === chosen);

  const box = inbox.data;
  const today = box?.today;
  const needs = box?.items.filter((i) => i.kind !== 'request') ?? [];
  const requests = box?.items.filter((i) => i.kind === 'request') ?? [];
  // AFS-249: debug runs are said as debug runs, not "step by step".
  const pausedWords = !today
    ? ''
    : today.pausedDebug === 0
      ? `${today.paused} paused step by step`
      : today.pausedDebug === today.paused
        ? `${plural(today.paused, 'debug run', 'debug runs')} paused`
        : `${today.paused} paused`;
  // AFS-208: each count is a link to those runs.
  const counts: [string, ReactNode][] = today
    ? [
        [
          'well',
          <Link key="well" to="/runs?state=succeeded">{`${today.succeeded} went well`}</Link>,
        ],
        ...(today.failed
          ? [
              [
                'failed',
                <Link key="failed" to="/runs?state=failed">{`${today.failed} failed`}</Link>,
              ] as [string, ReactNode],
            ]
          : []),
        ...(today.rejected
          ? [
              [
                'rejected',
                <Link
                  key="rejected"
                  to="/runs?state=rejected"
                >{`${today.rejected} rejected`}</Link>,
              ] as [string, ReactNode],
            ]
          : []),
        ...(today.cancelled
          ? [
              [
                'stopped',
                <Link
                  key="stopped"
                  to="/runs?state=cancelled"
                >{`${today.cancelled} stopped`}</Link>,
              ] as [string, ReactNode],
            ]
          : []),
        ...(today.going
          ? [
              [
                'going',
                <Link
                  key="going"
                  to="/runs?state=going"
                >{`${today.going} still ${today.going === 1 ? 'goes' : 'go'}`}</Link>,
              ] as [string, ReactNode],
            ]
          : []),
        ...(today.waiting
          ? [
              [
                'waiting',
                <Link
                  key="waiting"
                  to="/runs?state=waiting"
                >{`${today.waiting} ${today.waiting === 1 ? 'waits' : 'wait'} for a decision`}</Link>,
              ] as [string, ReactNode],
            ]
          : []),
        ...(today.paused
          ? [
              [
                'paused',
                <Link key="paused" to="/runs?state=paused">
                  {pausedWords}
                </Link>,
              ] as [string, ReactNode],
            ]
          : []),
      ]
    : [];
  const summary = box && today && (
    <>
      {today.runs ? (
        <>
          {/* AFS-208: everyone's runs you may see, not only yours. */}
          {plural(today.runs, 'run', 'runs')} today
          {shownWorkspace ? ` in ${shownWorkspace.name}` : ''}, by everyone:{' '}
          {counts.map(([k, c], i) => (
            <Fragment key={k}>
              {i ? ', ' : ''}
              {c}
            </Fragment>
          ))}
          .
        </>
      ) : (
        'No run yet today.'
      )}{' '}
      {box.count ? `${plural(box.count, 'thing needs', 'things need')} you.` : 'Nothing needs you.'}
    </>
  );
  // How long a run has waited for this person: a draft or the certificate does not wait so.
  const oldest = needs
    .filter((i) => i.kind === 'approval' || i.kind === 'paused' || i.kind === 'failed')
    .reduce<string | undefined>((o, i) => (!o || i.since < o ? i.since : o), undefined);
  const week = box?.week;
  const runners = box?.runners;
  const first = me.name.split(/\s+/)[0] || me.name;
  // AFS-85: the newest run of each configuration this person launched themselves (a schedule's
  // runs are its owner's, and not launched by hand). A few more than are shown, for the ones
  // that are gone since.
  const started: Run[] = [];
  for (const run of here) {
    if (!run.config || run.schedule || run.requestedBy.login !== me.login) continue;
    if (started.some((r) => r.config?.id === run.config?.id)) continue;
    if (started.push(run) >= AGAIN + 3) break;
  }
  const again = useLoad(
    () => launchAgain(started, projects.data ?? []),
    [started.map((r) => `${r.config?.id}@${r.id}`).join(' '), projects.data],
  );
  const going = here.filter(
    (r) => r.state === 'queued' || (r.state === 'running' && !r.pausedBefore),
  );
  const workspaceOf = (run: Run) => at.get(run.project)?.workspace.name;

  return (
    <div className="home inbox">
      <PageHead
        help="web-pages.md"
        title={`${greeting(new Date().getHours())}, ${first}`}
        lead={summary || undefined}
      >
        {/* AFS-212: the inbox spans workspaces; this narrows it to one, kept in the address. */}
        <WorkspaceFilter workspaces={workspaces.data ?? []} chosen={chosen} />
      </PageHead>
      <Loading state={inbox} />
      {box && today && week && runners && (
        <ul className="inbox-numbers" aria-label="The day in numbers">
          <li>
            <span className="label">Runs today</span>
            <span className="number">{today.runs}</span>
            <span className="sub">
              {today.real} real · {today.check} check
            </span>
          </li>
          <li>
            <span className="label">Went well, 7 days</span>
            <span className="number">
              {week.ended ? `${Math.round((100 * week.succeeded) / week.ended)}%` : '–'}
            </span>
            <span className="sub">
              {week.ended
                ? `${week.succeeded} of ${plural(week.ended, 'run', 'runs')}`
                : 'no run ended'}
            </span>
          </li>
          <li>
            <span className="label">Needs you</span>
            <span className={box.count ? 'number warn-text' : 'number'}>{box.count}</span>
            <span className="sub">{oldest ? `oldest ${span(oldest)}` : 'nothing waits'}</span>
          </li>
          <li>
            <span className="label">Runners</span>
            <span className="number">
              {runners.busy} of {runners.slots}
            </span>
            <span className="sub">
              busy · {runners.queued ? `${runners.queued} queued` : 'nothing queued'}
            </span>
          </li>
        </ul>
      )}
      <div className="home-split">
        <div className="inbox-main">
          <section aria-labelledby="needs">
            <div className="section-head">
              <h2 id="needs">Needs you {box && <span className="count">{box.count}</span>}</h2>
              {needs.some((i) => i.kind === 'approval') && (
                <Link to="/approvals">All approvals</Link>
              )}
            </div>
            {workspaces.data?.length === 0 ? (
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
            ) : box && !needs.length ? (
              <p className="empty">Nothing needs you.</p>
            ) : (
              <ul className="inbox-items">
                {needs.map((item) => (
                  <InboxRow
                    key={`${item.kind}:${item.run?.id ?? item.draft?.id ?? item.title}`}
                    item={item}
                    onDone={inbox.reload}
                  />
                ))}
              </ul>
            )}
            {/* AFS-144: your own runs held at a gate for someone else are said too. */}
            {requests.length > 0 && (
              <>
                <h3 className="inbox-sub">Waiting for others</h3>
                <ul className="inbox-items quiet">
                  {requests.map((item) => (
                    <InboxRow key={`request:${item.run?.id}`} item={item} onDone={inbox.reload} />
                  ))}
                </ul>
              </>
            )}
          </section>
          <section aria-labelledby="recent">
            <div className="section-head">
              <h2 id="recent">Latest runs</h2>
              <Link to="/runs">All runs</Link>
            </div>
            <Loading state={runs} />
            {runs.data && here.length === 0 && (
              <p className="empty">
                {/* AFS-152: where runs start, only to who may start one. */}
                {launchesAny(myAccess.data)
                  ? 'No run yet. Runs start from a launch configuration of a project.'
                  : 'No run yet.'}
              </p>
            )}
            {here.length > 0 && (
              <RunList
                runs={here.slice(0, 8)}
                me={me}
                workspaceOf={workspaceOf}
                showConfig={false}
              />
            )}
          </section>
        </div>
        <div className="inbox-side">
          <section aria-labelledby="running">
            <div className="section-head">
              <h2 id="running">Running now</h2>
              {going.length > 0 && <Link to="/runs?state=going">{going.length}</Link>}
            </div>
            {runs.data && going.length === 0 && <p className="empty">Nothing runs now.</p>}
            {going.length > 0 && (
              <ul className="list">
                {going.slice(0, RUNNING).map((r) => (
                  <li key={r.id}>
                    <Link to={`/runs/${r.id}`}>
                      <span className="two">
                        <span className="title">
                          <StateGlyph state={r.state} /> {r.flow.name}{' '}
                          <span className="muted">#{r.number}</span>
                        </span>
                        <span className="sub">
                          {[
                            workspaceOf(r),
                            r.state === 'queued'
                              ? 'queued'
                              : `started ${ago(r.startedAt ?? r.createdAt)}`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
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
                          <ModeBadge mode={a.mode} /> {a.flow} · {a.workspace}
                        </span>
                      </span>
                      <span className="end">last run {ago(a.at)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
