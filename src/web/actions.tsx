// AFS-175: actions (ADR-0036): approved launches for people who do not read flows. The Actions
// page (cards), an action's short form (only what it asks, what will happen in words, Run), and
// the plain progress view of a run of it. No canvas, no YAML, no Ansible words. And the action's
// settings, links and grants (AFS-201: on its own page, /actions/<id>/edit).
import { type FormEvent, useEffect, useId, useState } from 'react';
import { actionEditAddress } from '../server/actions/types';
import { ActionLinks, ValueLink } from './actionLinks';
import {
  type Action,
  type ActionCard,
  type ActionField,
  type ActionForm as ActionFormData,
  type ActionHosts,
  type ActionProgress,
  type ActionSettings,
  ApiError,
  api,
  type LaunchRequest,
} from './api';
import { ask } from './confirm';
import { midnight, runAddress } from './home';
import { holdUnsaved, Link, navigate, useSearch } from './router';
import { StateBadge } from './runs';
import {
  ago,
  Labelled,
  Loading,
  messageOf,
  PageHead,
  Scroll,
  useLoad,
  WorkspaceFilter,
} from './ui';

/** Where an action's form and a run's progress are. */
export const actionAddress = (id: string) => `/actions/${encodeURIComponent(id)}`;
export { actionEditAddress };

/**
 * AFS-201: the full link to an action with these values filled in (the empty ones left for the
 * person who opens it), to hand to someone. An action never asks a secret, so none is in it.
 */
export function linkWithValues(origin: string, id: string, values: Record<string, string>): string {
  const query = new URLSearchParams(
    Object.entries(values)
      .map(([name, value]) => [name, value.trim()] as [string, string])
      .filter(([, value]) => value),
  ).toString();
  return `${origin}/a/${encodeURIComponent(id)}${query ? `?${query}` : ''}`;
}
export const progressAddress = (run: string) => `/actions/runs/${encodeURIComponent(run)}`;

const names = (text: string) =>
  text
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
/** A chip pressed: in or out of the list; AFS-207: for a list of one host, it takes the place. */
export const toggle = (text: string, name: string, one = false) => {
  const have = names(text);
  if (have.includes(name)) return have.filter((n) => n !== name).join(', ');
  return one ? name : [...have, name].join(', ');
};

/** AFS-207: what a host list takes, in words: "one host", "up to 3 hosts". */
const takesWords = (max: number) => (max === 1 ? 'one host' : `up to ${max} hosts`);
/** AFS-254: a sentence typed without its full stop gets one, so the next does not run on. */
export const sentence = (text: string) => {
  const t = text.trim();
  return !t || /[.!?:;…]$/.test(t) ? t : `${t}.`;
};

/** AFS-207: a host list's value with how many hosts it names, when it is more than its names. */
export function valueWords(field: ActionField, value: string, count?: number): string {
  if (!value) return '(none)';
  if (field.type !== 'host_list' || count === undefined || count === names(value).length)
    return value;
  return `${value} (${count === 1 ? 'one host' : `${count} hosts`})`;
}

/** AFS-207: how many hosts a host list's value names, from the group sizes the form read. */
function countOf(value: string, hosts: ActionHosts | undefined): number | undefined {
  if (!hosts?.sizes || hosts.dynamic) return undefined;
  let n = 0;
  for (const name of names(value)) n += hosts.sizes[name] ?? 1;
  return n;
}

/** The actions this person may run (empty for who has none). */
export const useActions = () => useLoad(() => api.actions().catch(() => [] as ActionCard[]), []);

/**
 * AFS-212: as one's Home, the inbox of one's own runs: those that failed or wait for someone's
 * decision (an action-only person has no other inbox).
 */
function YourRuns() {
  const inbox = useLoad(() => api.inbox(midnight()), []);
  const items = inbox.data?.items.filter((i) => i.run) ?? [];
  if (!items.length) return null;
  return (
    <section aria-labelledby="your-runs" className="your-runs">
      <h2 id="your-runs">Your runs</h2>
      <ul className="list">
        {items.map((i) =>
          i.run ? (
            <li key={`${i.kind}:${i.run.id}`}>
              <Link to={runAddress(i.run)}>
                <span className="two">
                  <span className="title">{i.title}</span>
                  <span className="sub">
                    {[i.workspace?.name, i.failure?.error, ago(i.since)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </Link>
            </li>
          ) : null,
        )}
      </ul>
    </section>
  );
}

/** `home`: the page is one's Home (an action-only person's). */
export function ActionsPage({ home }: { home?: boolean }) {
  const actions = useLoad(api.actions, []);
  // AFS-274: every workspace's actions; `?workspace=<key>` narrows to one. The choices are the
  // actions' own workspaces: someone who only runs actions sees no workspace otherwise.
  const chosen = new URLSearchParams(useSearch()).get('workspace') ?? undefined;
  const workspaces = [
    ...new Map((actions.data ?? []).map((a) => [a.workspace.key, a.workspace])).values(),
  ];
  const shown = actions.data?.filter((a) => !chosen || a.workspace.key === chosen);
  return (
    <>
      <PageHead
        title="Actions"
        // AFS-206: one intro, whether Actions is one's Home or a page of the menu.
        lead="The actions you may run: pick one, fill in what it asks, and Run."
        help="actions.md"
      >
        <WorkspaceFilter workspaces={workspaces} chosen={chosen} />
      </PageHead>
      {home && <YourRuns />}
      <Loading state={actions} />
      {actions.data?.length === 0 && (
        <p className="empty">
          No actions for you yet. Someone who looks after a workspace can make one and let you run
          it.
        </p>
      )}
      {!!actions.data?.length && shown?.length === 0 && (
        <p className="empty">No action of yours in this workspace.</p>
      )}
      {!!shown?.length && (
        <ul className="cards action-cards">
          {shown.map((a) => (
            <li key={a.id}>
              <Link to={actionAddress(a.id)} className="card">
                <strong>{a.title}</strong>
                <span>{a.summary}</span>
                {/* AFS-260: switched off, it stays here, said so, with whom to ask. */}
                {a.off && <span className="notice warn small">{a.off}</span>}
                <span className="muted">
                  {/* AFS-274: each names its workspace, as every Work page's rows do. */}
                  {a.workspace.name} ·{' '}
                  {a.lastRun ? (
                    <>
                      You ran it {ago(a.lastRun.createdAt)}: {a.lastRun.words}
                    </>
                  ) : (
                    'You have not run it yet'
                  )}
                  {/* AFS-207: the one to flag is the one that changes things. */}
                  {a.mode === 'check' ? ' · a check, changes nothing' : ''}
                </span>
                {a.mode === 'real' && (
                  <span className="real-mark">For real: it changes the machines it runs on</span>
                )}
              </Link>
              {/* AFS-207: one's last run opens from its card. */}
              {a.lastRun && (
                <Link to={progressAddress(a.lastRun.id)} className="card-run small">
                  Your last run (#{a.lastRun.number})
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** AFS-207: the hosts a host list offers to pick: groups with their size, then hosts. */
interface Picks {
  names: string[];
  /** Hosts per group: a name with a size is a group. */
  sizes?: Record<string, number>;
  why?: string;
}

function ActionInput({
  field,
  value,
  onChange,
  problem,
  hosts,
}: {
  field: ActionField;
  value: string;
  onChange(value: string): void;
  problem?: string;
  hosts?: Picks | 'reading';
}) {
  const label = (
    <>
      {field.label}
      {!field.required && <span className="muted"> (optional)</span>}
    </>
  );
  const many = field.type === 'host_list';
  const one = field.max === 1;
  const picks = field.choices ?? (hosts && hosts !== 'reading' ? hosts.names : []);
  const sizes = hosts && hosts !== 'reading' ? hosts.sizes : undefined;
  // AFS-207: how many it takes, said with the help line.
  const hint = [
    field.help ? sentence(field.help) : undefined,
    field.max ? `It takes ${takesWords(field.max)}.` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  /** A chip: a group says it is one, and how many hosts it has. */
  const chip = (n: string, extra?: { name: string }) => {
    const on = names(value).includes(n);
    const size = sizes?.[n];
    return (
      <button
        key={n}
        type="button"
        {...extra}
        className={`chip${on ? ' on' : ''}${size !== undefined ? ' group' : ''}`}
        aria-pressed={on}
        {...(size !== undefined
          ? { 'aria-label': `${n}: group of ${size === 1 ? 'one host' : `${size} hosts`}` }
          : {})}
        onClick={() => onChange(toggle(value, n, one))}
      >
        {n}
        {size !== undefined && <span className="chip-size"> · group of {size}</span>}
      </button>
    );
  };
  if (many && field.choices?.length)
    return (
      <fieldset className={`field pick${problem ? ' invalid' : ''}`} aria-describedby={undefined}>
        <legend>{label}</legend>
        <div className="name-chips">{field.choices.map((c) => chip(c, { name: field.name }))}</div>
        {hint && <small className="muted">{hint}</small>}
        {problem && <small className="bad-text">{problem}</small>}
      </fieldset>
    );
  return (
    <Labelled label={label} hint={hint || undefined} problem={problem}>
      {(props) =>
        field.choices?.length ? (
          <select
            {...props}
            name={field.name}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">(choose)</option>
            {field.choices.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : field.type === 'boolean' ? (
          <select
            {...props}
            name={field.name}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">(choose)</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        ) : (
          <>
            <input
              {...props}
              name={field.name}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => onChange(e.target.value)}
            />
            {many && (
              <div className="group-slot">
                {hosts === 'reading' ? (
                  <small className="muted">Reading the names you can pick…</small>
                ) : picks.length ? (
                  <fieldset className="name-chips" aria-label={`Pick for ${field.label}`}>
                    <small className="muted">{one ? 'Pick one:' : 'Pick:'}</small>
                    {picks.map((n) => chip(n))}
                  </fieldset>
                ) : hosts?.why ? (
                  <small className="muted">
                    {hosts.why}. {one ? 'Type one name.' : 'Separate names with commas.'}
                  </small>
                ) : null}
              </div>
            )}
          </>
        )
      }
    </Labelled>
  );
}

/**
 * AFS-207: an action that cannot be opened, said with a title, why, and the way back: a bare
 * "No such action" left someone from a NetBox link stuck.
 */
export function ActionRefused({ message }: { message: string }) {
  const bare = /^No such action\.?$/.test(message);
  return (
    <>
      <PageHead title="This action cannot be run" help="actions.md" />
      <section className="panel action-form" aria-label="Why">
        <p className="notice warn" role="alert">
          {bare
            ? 'There is no such action for you: it was removed, or it is not yours to run. Whoever sent you here, or an administrator, can tell you which.'
            : message}
        </p>
        <div className="actions">
          <Link to="/actions" className="button">
            Back to actions
          </Link>
        </div>
      </section>
    </>
  );
}

/** AFS-207: the values a page's address gives an action's form ("Run it again"), by name. */
function valuesOfAddress(form: ActionFormData): Record<string, string> {
  const query = new URLSearchParams(window.location.search);
  return Object.fromEntries(
    form.fields.flatMap((f) => {
      const v = query.get(f.name);
      return v === null ? [] : [[f.name, v]];
    }),
  );
}

export function ActionPage({ id }: { id: string }) {
  const form = useLoad(() => api.action(id), [id]);
  if (form.error) return <ActionRefused message={form.error} />;
  if (!form.data) return <Loading state={form} />;
  return (
    <>
      <PageHead title={form.data.title} lead={form.data.summary} help="actions.md" />
      <ActionFormView key={id} id={id} form={form.data} start={valuesOfAddress(form.data)} />
    </>
  );
}

/** AFS-176: the host names a host list offers: its group's hosts when the action narrows it. */
function picksFor(
  field: ActionField,
  hosts: { loading?: boolean; data?: ActionHosts | undefined },
): Picks | 'reading' {
  if (hosts.loading) return 'reading';
  const data = hosts.data;
  if (!data) return { names: [], why: 'The names cannot be read now' };
  if (field.group) {
    const inGroup = data.inGroup?.[field.group];
    return inGroup?.length
      ? { names: inGroup }
      : { names: [], why: `The inventory names no hosts in ${field.group}` };
  }
  return {
    names: [...data.groups, ...data.hosts],
    ...(data.sizes ? { sizes: data.sizes } : {}),
    ...(data.why ? { why: data.why } : {}),
  };
}

/**
 * AFS-207: starts an action's run; when the same values ran a moment ago, asks whether to run
 * again or open that run. Resolves with the progress page to open; throws the other refusals.
 */
export async function startAction(
  id: string,
  values: Record<string, string>,
  from?: { link: true; reply?: string | undefined },
): Promise<string> {
  try {
    return progressAddress((await api.runAction(id, values, from)).id);
  } catch (e) {
    const twin = e instanceof ApiError && e.code === 'duplicate' ? e.details.run : undefined;
    if (!twin) throw e;
    if (!(await ask(`${messageOf(e)}. Run it again?`, { yes: 'Run again', no: 'Open that run' })))
      return progressAddress(twin.id);
    return progressAddress((await api.runAction(id, values, from, true)).id);
  }
}

/**
 * An action's short form: its asked inputs, what will happen, and Run. AFS-176: a link's page
 * gives it the link's values (`start`), shows only the fields still to fill (`only`; the others
 * are listed as given), and says the run came by a link (`from`).
 */
export function ActionFormView({
  id,
  form: f,
  start,
  only,
  problems: firstProblems,
  from,
}: {
  id: string;
  form: ActionFormData;
  start?: Record<string, string>;
  only?: string[];
  problems?: Record<string, string>;
  from?: { link: true; reply?: string | undefined };
}) {
  /** What was typed or picked; a field not touched has its start value. */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Record<string, string>>(firstProblems ?? {});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string>();
  const shown = only ? f.fields.filter((x) => only.includes(x.name)) : f.fields;
  const needsHosts = shown.some((x) => x.hosts);
  const hosts = useLoad(
    async () => (needsHosts ? api.actionHosts(id) : undefined),
    [id, needsHosts],
  );
  const values = Object.fromEntries(
    f.fields.map((x) => [x.name, typed[x.name] ?? start?.[x.name] ?? x.text]),
  );
  const given = only ? f.fields.filter((x) => !only.includes(x.name)) : [];

  const run = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(undefined);
    const empty = f.fields.filter((x) => x.required && !values[x.name]?.trim());
    if (empty.length) {
      setProblems(Object.fromEntries(empty.map((x) => [x.name, `${x.label} is needed`])));
      return;
    }
    setProblems({});
    setBusy(true);
    try {
      // AFS-207: the values are checked as the run would check them, before the confirm: a host
      // outside the group or the inventory, more hosts than it takes. And how many hosts a
      // group is, for the question.
      let counts: Record<string, number> | undefined;
      if (f.fields.some((x) => x.type === 'host_list')) {
        const query = new URLSearchParams(
          Object.entries(values).filter(([, v]) => v.trim()) as [string, string][],
        ).toString();
        const checked = await api.actionLink(id, query).catch(() => undefined);
        const wrong = Object.fromEntries(
          (checked?.problems ?? []).map((p) => [p.field, p.message]),
        );
        if (Object.keys(wrong).length) {
          setProblems(wrong);
          return;
        }
        counts =
          checked?.counts ??
          Object.fromEntries(
            f.fields.flatMap((x) => {
              const n =
                x.type === 'host_list' ? countOf(values[x.name] ?? '', hosts.data) : undefined;
              return n === undefined ? [] : [[x.name, n]];
            }),
          );
      }
      if (f.confirm) {
        const chosen = f.fields
          .map((x) => `${x.label}: ${valueWords(x, values[x.name] ?? '', counts?.[x.name])}`)
          .join('; ');
        // AFS-207: the question repeats whether it changes things.
        const how = f.mode === 'real' ? 'for real' : 'as a check';
        if (
          !(await ask(`Run "${f.title}" ${how} now?${chosen ? ` ${chosen}.` : ''}`, {
            yes: f.mode === 'real' ? 'Run for real' : 'Run the check',
            no: 'Not now',
          }))
        )
          return;
      }
      navigate(await startAction(id, values, from));
    } catch (e) {
      const field = e instanceof ApiError ? e.details.field : undefined;
      const each = e instanceof ApiError ? (e.details.problems ?? []) : [];
      const at = Object.fromEntries(
        [...each, ...(field ? [{ field, message: messageOf(e) }] : [])]
          .filter((p) => p.field && f.fields.some((x) => x.name === p.field))
          .map((p) => [p.field as string, p.message]),
      );
      setProblems(at);
      if (!Object.keys(at).length) setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel action-form" aria-label="Run this action">
      {f.blocked ? (
        <p className="notice warn" role="status">
          {f.blocked}.{f.ask.length ? ` Ask ${f.ask.join(' or ')}.` : ''}
        </p>
      ) : (
        <form className="form" noValidate onSubmit={run}>
          {given.length > 0 && (
            <>
              <h2>From the link</h2>
              <dl className="facts">
                {given.map((x) => (
                  <div key={x.name}>
                    <dt>{x.label}</dt>
                    <dd>{values[x.name] || <span className="muted">(none)</span>}</dd>
                  </div>
                ))}
              </dl>
              <h2>Still to fill in</h2>
            </>
          )}
          {f.fields.length === 0 && <p className="muted">It asks nothing: Run is all.</p>}
          {shown.map((x) => (
            <ActionInput
              key={x.name}
              field={x}
              value={values[x.name] ?? ''}
              problem={problems[x.name]}
              onChange={(v) => {
                setTyped({ ...typed, [x.name]: v });
                if (problems[x.name]) setProblems({ ...problems, [x.name]: '' });
              }}
              {...(x.hosts ? { hosts: picksFor(x, hosts) } : {})}
            />
          ))}
          <div className="happens">
            <h2>What will happen</h2>
            <ul>
              {f.happens.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          </div>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Starting…' : 'Run'}
            </button>
            {/* AFS-201: a person shares the action with what they filled in. */}
            {f.fields.length > 0 && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      linkWithValues(window.location.origin, id, values),
                    );
                    setCopied('Copied: the link opens this action with these values.');
                  } catch {
                    setCopied('The link could not be copied here.');
                  }
                }}
              >
                Copy a link with these values
              </button>
            )}
            <Link to="/actions">Back to actions</Link>
          </div>
          {copied && (
            <p className="muted small" role="status">
              {copied}
            </p>
          )}
        </form>
      )}
      <p className="muted small">
        {f.ask.length ? `Questions about it: ask ${f.ask.join(' or ')}.` : ''}
        {f.configPage && (
          <>
            {' '}
            <Link to={f.configPage}>Its launch configuration</Link>
          </>
        )}
        {f.editPage && (
          <>
            {' '}
            <Link to={f.editPage}>Change this action</Link>
          </>
        )}
      </p>
    </section>
  );
}

const STEP_MARK: Record<ActionProgress['steps'][number]['state'], string> = {
  done: 'Done',
  running: 'Running',
  waiting: 'Waiting',
  failed: 'Failed',
  // AFS-207: a step the run did not get to.
  'not run': 'Not reached',
  'to do': 'To do',
};

/** A run's progress, live: its stream says it again whenever it changes. */
function useProgress(run: string) {
  const first = useLoad(() => api.actionProgress(run), [run]);
  const [live, setLive] = useState<ActionProgress>();
  useEffect(() => {
    setLive(undefined);
    if (typeof EventSource === 'undefined') return;
    const events = new EventSource(`/api/v1/actions/runs/${encodeURIComponent(run)}/events`);
    events.addEventListener('progress', (e) => {
      try {
        setLive(JSON.parse((e as MessageEvent).data) as ActionProgress);
      } catch {}
    });
    events.addEventListener('end', () => events.close());
    return () => events.close();
  }, [run]);
  return { ...first, data: live ?? first.data };
}

export function ActionRunPage({ run }: { run: string }) {
  const progress = useProgress(run);
  const p = progress.data;
  if (!p) return <Loading state={progress} />;
  const ended = !['queued', 'running', 'waiting'].includes(p.run.state);
  return (
    <>
      <PageHead
        title={p.action.title}
        lead={`Run #${p.run.number}, started by ${p.run.startedBy} ${ago(p.run.createdAt)}`}
        help="actions.md"
      />
      <section className="panel progress" aria-label="How it goes">
        {/* AFS-176: an action that runs as its link opens says what the link started. */}
        {new URLSearchParams(window.location.search).get('started') === 'link' && (
          <p className="notice ok">
            The link started {p.action.title} (run #{p.run.number}) as it opened, with the values
            below.
          </p>
        )}
        {/* AFS-207: the link opened again a moment later (Back, a second tab) started nothing. */}
        {new URLSearchParams(window.location.search).get('started') === 'twin' && (
          <p className="notice info">
            The link was opened again with the same values: it did not start another run. This is
            run #{p.run.number}, which it started a moment ago. To run it again, use Run it again
            below.
          </p>
        )}
        <p className="progress-headline" role="status" aria-live="polite">
          <StateBadge state={p.run.state} />
          <span>{p.headline}</span>
        </p>
        {p.total > 0 && (
          <>
            <div
              className="progress-bar"
              role="progressbar"
              aria-label="Steps done"
              aria-valuemin={0}
              aria-valuemax={p.total}
              aria-valuenow={p.done}
            >
              <span style={{ width: `${Math.round((100 * p.done) / p.total)}%` }} />
            </div>
            <p className="muted">
              {p.done} of {p.total} {p.total === 1 ? 'step' : 'steps'} done
              {p.run.mode === 'check' ? ' · a check: nothing is changed' : ''}
            </p>
            <ol className="progress-steps">
              {p.steps.map((s) => (
                <li key={s.id} className={`step-${s.state.replace(' ', '-')}`}>
                  <span className="step-mark">{STEP_MARK[s.state]}</span>
                  <span>{s.title}</span>
                </li>
              ))}
            </ol>
          </>
        )}
        {p.waiting && (
          <p className="notice warn">
            Waiting since {ago(p.waiting.since)} for{' '}
            {p.waiting.by.length ? p.waiting.by.join(' or ') : 'someone who may approve'} to decide{' '}
            {p.waiting.step}. You do not need to stay on this page.
          </p>
        )}
        {p.failed && (
          <div className="notice error" role="alert">
            <p>{p.failed}.</p>
            {p.ask.length > 0 && <p>Ask {p.ask.join(' or ')} what to do next.</p>}
          </div>
        )}
        {p.inputs.length > 0 && (
          <>
            <h2>What it was asked</h2>
            <dl className="facts">
              {p.inputs.map((i) => (
                <div key={i.label}>
                  <dt>{i.label}</dt>
                  <dd>{i.value || <span className="muted">(none)</span>}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
        <div className="actions">
          {ended && p.again && (
            <Link to={p.again} className="button">
              Run it again
            </Link>
          )}
          <Link to="/actions">All actions</Link>
          {p.runPage && <Link to={p.runPage}>The full run page</Link>}
        </div>
        {!p.failed && p.ask.length > 0 && (
          <p className="muted small">Questions about it: ask {p.ask.join(' or ')}.</p>
        )}
      </section>
    </>
  );
}

// --- on the action's own page (AFS-201; it was on its launch configuration's Settings tab)

interface FlowInput {
  name: string;
  type?: string | undefined;
  secret: boolean;
  description?: string | undefined;
  /** AFS-201: the value it runs with now (the configuration's), as the launch form says it. */
  text?: string | undefined;
}

interface AskedRow {
  on: boolean;
  label: string;
  help: string;
  choices: string;
  /** AFS-176: a host list's inventory group. */
  group: string;
  /** AFS-207: a host list's start value (empty: the runner picks). */
  start: string;
  /** AFS-207: how many hosts it takes: '' any, '1' one, else up to that many. */
  max: string;
}

const NEW: ActionSettings = {
  title: '',
  summary: '',
  asked: [],
  mode: 'check',
  confirm: true,
  enabled: true,
  runOnOpen: false,
  reply: null,
};

const SYSTEM_WORDS = { netbox: 'NetBox', zabbix: 'Zabbix' } as const;

/**
 * AFS-232: the groups of a configuration's inventory and how many hosts each has (the groups
 * `all` and `ungrouped` left out); undefined when the inventory cannot be read.
 */
export async function inventoryGroupSizes(
  config: string,
): Promise<Record<string, number> | undefined> {
  try {
    const r = await api.launchFacts(config, { inputs: {}, groups: true } as LaunchRequest);
    return Object.fromEntries(
      (r.groups ?? [])
        .filter((g) => g !== 'all' && g !== 'ungrouped')
        .map((g) => [g, r.groupHosts?.[g]?.count ?? 0]),
    );
  } catch {
    return undefined;
  }
}

/** The action of a configuration: make it one, change its words, and who may run it. */
export function ConfigActionSection({
  config,
  name,
  inputs,
  workspace,
  onChange,
}: {
  config: string;
  name: string;
  /** The flow's inputs (the launch form's fields). */
  inputs: FlowInput[];
  /** AFS-176: the workspace's key, for its NetBox and Zabbix credentials. */
  workspace?: string;
  /** AFS-254: told when the action is saved or removed (the page's heading names it). */
  onChange?: () => void;
}) {
  const id = useId();
  // AFS-254: typing not saved yet is asked about before the page is left, as on other forms.
  const [self] = useState(() => ({}));
  useEffect(() => () => holdUnsaved(self, false), [self]);
  const close = () => {
    holdUnsaved(self, false);
    setEditing(false);
  };
  const state = useLoad(() => api.configAction(config), [config]);
  const action = state.data?.action ?? undefined;
  const manage = !!state.data?.mayManage;
  const [editing, setEditing] = useState(false);
  // AFS-232: every group of the configuration's inventory with its number of hosts, for "Only
  // hosts of group", read as the Launch tab reads them, once the settings open with a host list:
  // before the action is saved too, and not narrowed to the group chosen.
  const hostLists = inputs.some((i) => i.type === 'host_list' && !i.secret);
  const [askGroups, setAskGroups] = useState(false);
  if (editing && hostLists && !askGroups) setAskGroups(true);
  const inventory = useLoad(
    async () => (askGroups ? inventoryGroupSizes(config) : undefined),
    [config, askGroups],
  );
  const [settings, setSettings] = useState<ActionSettings>(NEW);
  const [rows, setRows] = useState<Record<string, AskedRow>>({});
  const [saved, setSaved] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const start = (a: Action | undefined) => {
    setSettings(
      a
        ? {
            title: a.title,
            summary: a.summary,
            asked: a.asked,
            mode: a.mode,
            confirm: a.confirm,
            enabled: a.enabled,
            runOnOpen: !!a.runOnOpen,
            reply: a.reply ?? null,
          }
        : { ...NEW, title: name },
    );
    setSaved(undefined);
    setRows(
      Object.fromEntries(
        inputs
          .filter((i) => !i.secret)
          .map((i) => {
            const asked = a?.asked.find((x) => x.name === i.name);
            return [
              i.name,
              {
                on: !!asked,
                label: asked?.label ?? i.name,
                help: asked?.help ?? i.description ?? '',
                choices: asked?.choices?.join(', ') ?? '',
                group: asked?.group ?? '',
                start: asked?.start ?? '',
                max: asked?.max ? String(asked.max) : '',
              },
            ];
          }),
      ),
    );
    setError(undefined);
    setEditing(true);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(undefined);
    setSaved(undefined);
    // AFS-232: an empty field by its label on the form, not by the API's name ("Summary").
    if (!settings.title.trim()) {
      setError('Title is needed: what the runners call it, in a few words.');
      return;
    }
    if (!settings.summary.trim()) {
      setError('What it does is needed: one sentence, as a runner would say it.');
      return;
    }
    // AFS-207: said here, in words, not as the server's "not the right kind of value".
    if (settings.reply && !settings.reply.credential) {
      setError(
        `Choose a ${SYSTEM_WORDS[settings.reply.system]} token credential under Result back, or Tell nobody.`,
      );
      return;
    }
    // AFS-254: a group and choices do not go together; neither is dropped without a word.
    const both = Object.values(rows).find((r) => r.on && r.group.trim() && names(r.choices).length);
    if (both) {
      setError(
        `${both.label.trim() || 'A host list'}: give Choices or Only hosts of group, not both. A group narrows the hosts to its own; choices name them.`,
      );
      return;
    }
    setBusy(true);
    try {
      const hostList = (n: string) => inputs.find((i) => i.name === n)?.type === 'host_list';
      const asked = Object.entries(rows)
        .filter(([, r]) => r.on)
        .map(([n, r]) => ({
          name: n,
          label: r.label.trim(),
          ...(r.help.trim() ? { help: r.help.trim() } : {}),
          ...(names(r.choices).length ? { choices: names(r.choices) } : {}),
          ...(r.group.trim() ? { group: r.group.trim() } : {}),
          ...(hostList(n) && r.start.trim() ? { start: names(r.start).join(', ') } : {}),
          ...(hostList(n) && Number(r.max) > 0 ? { max: Number(r.max) } : {}),
        }));
      await api.setConfigAction(config, { ...settings, asked });
      setSaved(action ? 'The action is changed.' : 'It is an action now.');
      close();
      state.reload();
      onChange?.();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (!state.data) return <Loading state={state} />;
  if (!manage && !action) return null;
  // AFS-201: the values the inputs it does not ask run with (the configuration's).
  const fixed = inputs.filter((i) => !action?.asked.some((a) => a.name === i.name));
  const hostList = (n: string) => inputs.find((i) => i.name === n)?.type === 'host_list';
  /** A host list's line under Hosts: what narrows it, or how many it takes, or its start. */
  const hostLine = (a: Action['asked'][number]) =>
    a.group || a.max || a.start || (a.choices?.length && hostList(a.name));
  return (
    <>
      <section className="panel" aria-labelledby={`${id}-action`}>
        <div className="panel-head">
          <h2 id={`${id}-action`}>Settings</h2>
          {manage && !editing && (
            <button type="button" onClick={() => start(action)}>
              {action ? 'Change the action' : 'Make it an action'}
            </button>
          )}
        </div>
        <p className="muted">
          An action is a short form for people who run things but do not read flows: only what it
          asks, in their words, and Run. The rest runs with its launch configuration's values.{' '}
          <a href="/help/guide/actions.md" target="_blank" rel="noopener">
            About actions
          </a>
        </p>
        {saved && (
          <p className="notice ok" role="status">
            {saved}
          </p>
        )}
        {action && !editing && (
          <dl className="facts">
            <div>
              <dt>Title</dt>
              <dd>
                {action.title}
                {!action.enabled && (
                  <>
                    {' '}
                    <span className="badge warn">off</span>
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt>What it does</dt>
              <dd>{action.summary}</dd>
            </div>
            <div>
              <dt>It asks</dt>
              <dd>
                {action.asked.length
                  ? action.asked.map((a) => `${a.label} (${a.name})`).join(', ')
                  : 'nothing'}
              </dd>
            </div>
            {fixed.length > 0 && (
              <div>
                <dt>Runs with</dt>
                <dd>
                  {fixed.map((i, n) => (
                    <span key={i.name}>
                      {n > 0 && ', '}
                      <code>{i.name}</code>{' '}
                      {i.secret ? (
                        <span className="muted">(secret, the configuration's)</span>
                      ) : i.text ? (
                        `= ${i.text.length > 60 ? `${i.text.slice(0, 60)}…` : i.text}`
                      ) : (
                        <span className="muted">(empty)</span>
                      )}
                    </span>
                  ))}
                </dd>
              </div>
            )}
            <div>
              <dt>Runs</dt>
              <dd>
                {action.mode === 'real' ? 'for real' : 'as a check'}
                {action.confirm ? ', asks to confirm' : ''}
                {action.runOnOpen ? '; a link with every value runs as it opens' : ''}
              </dd>
            </div>
            {action.asked.some((a) => hostLine(a)) && (
              <div>
                <dt>Hosts</dt>
                <dd>
                  {action.asked
                    .filter((a) => hostLine(a))
                    .map(
                      (a) =>
                        // AFS-254: its choices are said too.
                        `${a.label}: ${a.max ? takesWords(a.max) : 'any number of hosts'}${a.group ? ` of group ${a.group}` : ''}${a.choices?.length ? ` from ${a.choices.join(', ')}` : ''}, ${a.start ? `starts with ${a.start}` : 'starts empty'}`,
                    )
                    .join('; ')}
                </dd>
              </div>
            )}
            <div>
              <dt>Result back</dt>
              <dd>
                {action.reply
                  ? `to ${SYSTEM_WORDS[action.reply.system]}, ${action.reply.when === 'failed' ? 'when a run from its link did not go well' : 'when a run from its link ends'}`
                  : 'nowhere'}
              </dd>
            </div>
            {action.owner && (
              <div>
                <dt>Set up by</dt>
                <dd>{action.owner.name}</dd>
              </div>
            )}
            <div>
              <dt>Its page</dt>
              <dd>
                {/* AFS-207: a name, not the raw address. */}
                <Link to={actionAddress(action.id)}>Open the form its runners see</Link>
              </dd>
            </div>
          </dl>
        )}
        {editing && (
          <form
            className="form"
            onSubmit={save}
            onChange={() => holdUnsaved(self, true)}
            noValidate
          >
            <Labelled label="Title" hint="What the runners call it, in a few words.">
              {(props) => (
                <input
                  {...props}
                  name="title"
                  maxLength={100}
                  value={settings.title}
                  onChange={(e) => setSettings({ ...settings, title: e.target.value })}
                />
              )}
            </Labelled>
            <Labelled label="What it does" hint="One sentence, as a runner would say it.">
              {(props) => (
                <input
                  {...props}
                  name="summary"
                  maxLength={300}
                  value={settings.summary}
                  onChange={(e) => setSettings({ ...settings, summary: e.target.value })}
                />
              )}
            </Labelled>
            <fieldset className="choices">
              <legend>What it asks</legend>
              <p className="muted small">
                Ticked inputs are asked, with your label and help line; the others run with this
                configuration's values and cannot be changed by a runner. Choices: names separated
                by commas (only those can be picked). Secret-looking inputs are never asked.
              </p>
              {inputs.filter((i) => !i.secret).length === 0 && (
                <p className="muted">The flow takes no inputs.</p>
              )}
              {inputs
                .filter((i) => !i.secret)
                .map((i) => {
                  const r = rows[i.name];
                  if (!r) return null;
                  const set = (change: Partial<AskedRow>) =>
                    setRows({ ...rows, [i.name]: { ...r, ...change } });
                  return (
                    <div key={i.name} className="asked-row">
                      <label className="choice">
                        <input
                          type="checkbox"
                          checked={r.on}
                          onChange={(e) => set({ on: e.target.checked })}
                        />
                        Ask for <code>{i.name}</code>
                        {i.type ? <span className="muted"> · {i.type}</span> : null}
                      </label>
                      {r.on && (
                        <div className="pair">
                          <Labelled label="Label">
                            {(props) => (
                              <input
                                {...props}
                                maxLength={80}
                                value={r.label}
                                onChange={(e) => set({ label: e.target.value })}
                              />
                            )}
                          </Labelled>
                          <Labelled label="Help line">
                            {(props) => (
                              <input
                                {...props}
                                maxLength={200}
                                value={r.help}
                                onChange={(e) => set({ help: e.target.value })}
                              />
                            )}
                          </Labelled>
                          {i.type !== 'dict' && i.type !== 'list' && (
                            <Labelled
                              label="Choices"
                              hint={
                                i.type === 'host_list'
                                  ? 'Empty: any host or group of the inventory, picked by name.'
                                  : 'Empty: anything is typed.'
                              }
                            >
                              {(props) => (
                                <input
                                  {...props}
                                  value={r.choices}
                                  onChange={(e) => set({ choices: e.target.value })}
                                />
                              )}
                            </Labelled>
                          )}
                          {/* AFS-254: kept in sight while it holds a group, so it is not lost. */}
                          {i.type === 'host_list' && (!names(r.choices).length || !!r.group) && (
                            <Labelled
                              label="Only hosts of group"
                              hint="An inventory group: the form offers only its hosts, and takes no others. Empty: any."
                            >
                              {(props) => (
                                <>
                                  <input
                                    {...props}
                                    maxLength={200}
                                    spellCheck={false}
                                    list={`${id}-groups`}
                                    value={r.group}
                                    onChange={(e) => set({ group: e.target.value })}
                                  />
                                  {/* AFS-207: the inventory's groups, offered as one types. */}
                                  <datalist id={`${id}-groups`}>
                                    {Object.entries(inventory.data ?? {}).map(([g, n]) => (
                                      <option key={g} value={g}>
                                        {`${n} ${n === 1 ? 'host' : 'hosts'}`}
                                      </option>
                                    ))}
                                  </datalist>
                                </>
                              )}
                            </Labelled>
                          )}
                          {i.type === 'host_list' && (
                            <Labelled
                              label="How many hosts"
                              hint="A group counts by its hosts: with one host, a group of four is refused."
                            >
                              {(props) => (
                                <select
                                  {...props}
                                  value={r.max === '' || r.max === '1' ? r.max : 'n'}
                                  onChange={(e) =>
                                    set({ max: e.target.value === 'n' ? '5' : e.target.value })
                                  }
                                >
                                  <option value="">any number</option>
                                  <option value="1">one host</option>
                                  <option value="n">up to a number</option>
                                </select>
                              )}
                            </Labelled>
                          )}
                          {i.type === 'host_list' && r.max !== '' && r.max !== '1' && (
                            <Labelled label="Up to">
                              {(props) => (
                                <input
                                  {...props}
                                  type="number"
                                  min={2}
                                  max={1000}
                                  value={r.max}
                                  onChange={(e) => set({ max: e.target.value })}
                                />
                              )}
                            </Labelled>
                          )}
                          {i.type === 'host_list' && (
                            <Labelled
                              label="Starts with"
                              hint="Empty (best): the runner picks. Never the configuration's value."
                            >
                              {(props) => (
                                <input
                                  {...props}
                                  maxLength={2000}
                                  spellCheck={false}
                                  value={r.start}
                                  onChange={(e) => set({ start: e.target.value })}
                                />
                              )}
                            </Labelled>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
            </fieldset>
            <fieldset className="choices">
              <legend>It runs</legend>
              {(['check', 'real'] as const).map((m) => (
                <label key={m} className="inline">
                  <input
                    type="radio"
                    name={`${id}-mode`}
                    checked={settings.mode === m}
                    onChange={() => setSettings({ ...settings, mode: m })}
                  />
                  {m === 'check' ? 'as a check (changes nothing)' : 'for real'}
                </label>
              ))}
            </fieldset>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.confirm}
                onChange={(e) => setSettings({ ...settings, confirm: e.target.checked })}
              />
              Run asks to confirm first
            </label>
            <label className="choice">
              <input
                type="checkbox"
                checked={!!settings.runOnOpen}
                onChange={(e) => setSettings({ ...settings, runOnOpen: e.target.checked })}
              />
              A link that gives every value runs as it opens, without a confirm page (opening the
              link never runs it by itself: the page starts it, and says so)
            </label>
            <ReplyFields
              workspace={workspace}
              reply={settings.reply ?? null}
              onChange={(reply) => setSettings({ ...settings, reply })}
            />
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
              />
              On (off: nobody can run it; its words and who may run it are kept)
            </label>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <div className="actions">
              <button type="submit" className="primary" disabled={busy}>
                {busy ? 'Saving…' : action ? 'Save the action' : 'Make it an action'}
              </button>
              <button type="button" onClick={close} disabled={busy}>
                Cancel
              </button>
              {action && (
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      !(await ask(
                        `Stop "${action.title}" being an action? Its runners lose it, and who may run it is forgotten. The launch configuration stays.`,
                        { yes: 'Stop being an action', danger: true },
                      ))
                    )
                      return;
                    try {
                      await api.removeConfigAction(config);
                      setSaved('It is not an action any more.');
                      close();
                      state.reload();
                      onChange?.();
                    } catch (e) {
                      setError(messageOf(e));
                    }
                  }}
                >
                  Stop being an action
                </button>
              )}
            </div>
          </form>
        )}
      </section>
      {action && manage && (
        <section className="panel" aria-labelledby={`${id}-links`}>
          <h2 id={`${id}-links`}>Links</h2>
          {/* AFS-201: the full link with values, to hand to a person. */}
          <ValueLink action={action} />
          <ActionLinks
            config={config}
            action={action}
            types={Object.fromEntries(inputs.map((i) => [i.name, i.type]))}
            tokens={state.data.tokens ?? []}
            onChange={state.reload}
          />
        </section>
      )}
      {action && manage && (
        <section className="panel" aria-labelledby={`${id}-grants`}>
          <ActionGrants
            id={`${id}-grants`}
            config={config}
            title={action.title}
            onChange={state.reload}
            grants={state.data.grants ?? []}
            {...(state.data.people ? { people: state.data.people } : {})}
          />
        </section>
      )}
    </>
  );
}

/**
 * AFS-176: where a run started from a NetBox or Zabbix link tells how it ended: the system, a
 * credential of the workspace with its address and token, and when.
 */
function ReplyFields({
  workspace,
  reply,
  onChange,
}: {
  workspace?: string | undefined;
  reply: NonNullable<ActionSettings['reply']> | null;
  onChange(reply: NonNullable<ActionSettings['reply']> | null): void;
}) {
  const id = useId();
  const creds = useLoad(async () => (workspace ? api.credentials(workspace) : []), [workspace]);
  const system = reply?.system ?? '';
  const mine = (creds.data ?? []).filter((c) => c.kind === system);
  return (
    <fieldset className="choices">
      <legend>Result back</legend>
      <p className="muted small">
        A run started from a NetBox link writes a journal entry on the object; from a Zabbix
        problem's link, a message on the problem. The address and token are a credential of this
        workspace (kind NetBox token or Zabbix token).
      </p>
      <div className="pair">
        <div className="field">
          <label htmlFor={`${id}-system`}>Tell</label>
          <select
            id={`${id}-system`}
            value={system}
            onChange={(e) => {
              const to = e.target.value as '' | 'netbox' | 'zabbix';
              onChange(to ? { system: to, credential: '', when: reply?.when ?? 'ended' } : null);
            }}
          >
            <option value="">nobody</option>
            <option value="netbox">NetBox</option>
            <option value="zabbix">Zabbix</option>
          </select>
        </div>
        {reply && (
          <div className="field">
            <label htmlFor={`${id}-cred`}>With the credential</label>
            <select
              id={`${id}-cred`}
              value={reply.credential}
              onChange={(e) => onChange({ ...reply, credential: e.target.value })}
            >
              <option value="">(choose)</option>
              {mine.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {creds.data && !mine.length && (
              <small className="muted">
                The workspace has no {SYSTEM_WORDS[reply.system]} token yet: add one on its
                Credentials tab.
              </small>
            )}
          </div>
        )}
        {reply && (
          <div className="field">
            <label htmlFor={`${id}-when`}>When</label>
            <select
              id={`${id}-when`}
              value={reply.when}
              onChange={(e) => onChange({ ...reply, when: e.target.value as 'ended' | 'failed' })}
            >
              <option value="ended">every run that ends</option>
              <option value="failed">only when it did not go well</option>
            </select>
          </div>
        )}
      </div>
    </fieldset>
  );
}

function ActionGrants({
  id: headId,
  config,
  title,
  grants,
  people,
  onChange,
}: {
  /** AFS-201: its heading's id: it is a panel of the action's page. */
  id: string;
  config: string;
  title: string;
  grants: NonNullable<Awaited<ReturnType<typeof api.configAction>>['grants']>;
  /** AFS-206: the workspace's people and groups: whom it may be given to. */
  people?: Awaited<ReturnType<typeof api.configAction>>['people'];
  onChange(): void;
}) {
  const id = useId();
  const [who, setWho] = useState('');
  const [kind, setKind] = useState<'user' | 'group'>('user');
  const [note, setNote] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const give = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !who.trim()) return;
    setBusy(true);
    setNote(undefined);
    try {
      const g = await api.grantAction(
        config,
        kind === 'user' ? { user: who.trim() } : { group: who.trim() },
      );
      setNote({
        ok: true,
        text: `${g.principal.type === 'group' ? `Group ${g.principal.name}` : g.principal.name} may run ${title} now.`,
      });
      setWho('');
      onChange();
    } catch (e) {
      setNote({ ok: false, text: messageOf(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h2 id={headId}>Who may run it</h2>
      <p className="muted small">
        A grant here lets someone run this action and follow the runs they start, nothing else of
        the workspace. Whoever may operate or read and write the flow, and administrators, may run
        it too. It is given to people and groups with access to this workspace; an administrator
        gives it to anyone.
      </p>
      {grants.length === 0 ? (
        <p className="muted">Nobody yet but operators, read-and-write people and administrators.</p>
      ) : (
        <ul className="list plain">
          {grants.map((g) => {
            const name =
              g.principal.type === 'group' ? `group ${g.principal.name}` : g.principal.name;
            return (
              <li key={g.id} className="row-line">
                <span>{name}</span>
                <button
                  type="button"
                  className="danger"
                  aria-label={`Take back ${title} from ${name}`}
                  onClick={async () => {
                    if (
                      !(await ask(`Take back "${title}" from ${name}? It ends at once.`, {
                        yes: 'Take back',
                        danger: true,
                      }))
                    )
                      return;
                    try {
                      await api.ungrantAction(config, g.id);
                      setNote({ ok: true, text: `Took back ${title} from ${name}.` });
                    } catch (e) {
                      setNote({ ok: false, text: messageOf(e) });
                    }
                    onChange();
                  }}
                >
                  Take back
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form className="form" onSubmit={give}>
        <div className="pair">
          <div className="field">
            <label htmlFor={`${id}-kind`}>Give to</label>
            <select
              id={`${id}-kind`}
              value={kind}
              onChange={(e) => setKind(e.target.value as 'user' | 'group')}
            >
              <option value="user">a person (login)</option>
              <option value="group">a group (name)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-who`}>{kind === 'user' ? 'Login' : 'Group'}</label>
            <input
              id={`${id}-who`}
              value={who}
              autoComplete="off"
              spellCheck={false}
              list={`${id}-people`}
              onChange={(e) => setWho(e.target.value)}
            />
            {/* AFS-206: offered from the workspace's people, not the server's. */}
            <datalist id={`${id}-people`}>
              {kind === 'user'
                ? people?.users.map((u) => (
                    <option key={u.id} value={u.login}>
                      {u.name}
                    </option>
                  ))
                : people?.groups.map((g) => <option key={g.id} value={g.name} />)}
            </datalist>
          </div>
        </div>
        {note && (
          <p className={`notice ${note.ok ? 'ok' : 'error'}`} role={note.ok ? 'status' : 'alert'}>
            {note.text}
          </p>
        )}
        <div className="actions">
          <button type="submit" disabled={busy || !who.trim()}>
            {busy ? 'Giving…' : 'Let them run it'}
          </button>
        </div>
      </form>
    </>
  );
}

/**
 * AFS-175, AFS-206: the workspace's Access tab: every action of the workspace and who may run it,
 * those nobody was given yet too (operators of the flow and administrators may run every one).
 */
export function WorkspaceActions({ workspace }: { workspace: string }) {
  const actions = useLoad(() => api.workspaceActions(workspace), [workspace]);
  return (
    <>
      <h3>Actions</h3>
      <p className="muted small">
        Who may run each action of the workspace. Operators of its flow and administrators may run
        every one; a grant gives one action and nothing else of the workspace. Grants are given and
        taken back on the action's own page.
      </p>
      <Loading state={actions} />
      {actions.data?.length === 0 && <p className="muted">No action in this workspace yet.</p>}
      {!!actions.data?.length && (
        <Scroll>
          <table>
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Runs the flow</th>
                <th scope="col">Who may run it</th>
              </tr>
            </thead>
            <tbody>
              {actions.data.map((a) => (
                <tr key={a.config}>
                  <td>
                    <Link to={actionEditAddress(a.config)}>{a.title}</Link>
                    {!a.enabled && <span className="muted"> · off</span>}
                  </td>
                  <td>
                    {a.configName} <span className="muted">in {a.projectName}</span>
                  </td>
                  <td>
                    {a.grants.map((g) => (
                      <div key={g.id}>
                        {g.principal.type === 'group'
                          ? `group ${g.principal.name}`
                          : g.principal.name}
                      </div>
                    ))}
                    <div className="muted">operators of the flow, administrators</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
    </>
  );
}
