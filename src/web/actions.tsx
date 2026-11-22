// AFS-175: actions (ADR-0036): approved launches for people who do not read flows. The Actions
// page (cards), an action's short form (only what it asks, what will happen in words, Run), and
// the plain progress view of a run of it. No canvas, no YAML, no Ansible words. And the action's
// settings and grants, on its launch configuration's Settings tab.
import { type FormEvent, useEffect, useId, useState } from 'react';
import {
  type Action,
  type ActionCard,
  type ActionField,
  type ActionProgress,
  type ActionSettings,
  ApiError,
  api,
} from './api';
import { ask } from './confirm';
import { Link, navigate } from './router';
import { StateBadge } from './runs';
import { ago, Labelled, Loading, messageOf, PageHead, useLoad } from './ui';

/** Where an action's form and a run's progress are. */
export const actionAddress = (id: string) => `/actions/${encodeURIComponent(id)}`;
export const progressAddress = (run: string) => `/actions/runs/${encodeURIComponent(run)}`;

const names = (text: string) =>
  text
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
const toggle = (text: string, name: string) => {
  const have = names(text);
  return (have.includes(name) ? have.filter((n) => n !== name) : [...have, name]).join(', ');
};

/** The actions this person may run (empty for who has none). */
export const useActions = () => useLoad(() => api.actions().catch(() => [] as ActionCard[]), []);

export function ActionsPage({ home = false }: { home?: boolean }) {
  const actions = useLoad(api.actions, []);
  return (
    <>
      <PageHead
        title="Actions"
        lead={
          home
            ? 'What you may run here. Pick one, fill in what it asks, and Run.'
            : 'Approved things to run: pick one, fill in what it asks, and Run.'
        }
        help="actions.md"
      />
      <Loading state={actions} />
      {actions.data?.length === 0 && (
        <p className="empty">
          No actions for you yet. Someone who looks after a workspace can make one and let you run
          it.
        </p>
      )}
      {!!actions.data?.length && (
        <ul className="cards action-cards">
          {actions.data.map((a) => (
            <li key={a.id}>
              <Link to={actionAddress(a.id)} className="card">
                <strong>{a.title}</strong>
                <span>{a.summary}</span>
                <span className="muted">
                  {a.lastRun ? (
                    <>
                      You ran it {ago(a.lastRun.createdAt)}: {a.lastRun.words}
                    </>
                  ) : (
                    'You have not run it yet'
                  )}
                  {a.mode === 'check' ? ' · a check, changes nothing' : ''}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
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
  hosts?: { names: string[]; why?: string } | 'reading';
}) {
  const label = (
    <>
      {field.label}
      {!field.required && <span className="muted"> (optional)</span>}
    </>
  );
  const many = field.type === 'host_list';
  const picks = field.choices ?? (hosts && hosts !== 'reading' ? hosts.names : []);
  if (many && field.choices?.length)
    return (
      <fieldset className={`field pick${problem ? ' invalid' : ''}`} aria-describedby={undefined}>
        <legend>{label}</legend>
        <div className="name-chips">
          {field.choices.map((c) => {
            const on = names(value).includes(c);
            return (
              <button
                key={c}
                type="button"
                name={field.name}
                className={`chip${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => onChange(toggle(value, c))}
              >
                {c}
              </button>
            );
          })}
        </div>
        {field.help && <small className="muted">{field.help}</small>}
        {problem && <small className="bad-text">{problem}</small>}
      </fieldset>
    );
  return (
    <Labelled label={label} hint={field.help} problem={problem}>
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
                    <small className="muted">Pick:</small>
                    {picks.map((n) => {
                      const on = names(value).includes(n);
                      return (
                        <button
                          key={n}
                          type="button"
                          className={`chip${on ? ' on' : ''}`}
                          aria-pressed={on}
                          onClick={() => onChange(toggle(value, n))}
                        >
                          {n}
                        </button>
                      );
                    })}
                  </fieldset>
                ) : hosts?.why ? (
                  <small className="muted">{hosts.why}. Separate names with commas.</small>
                ) : null}
              </div>
            )}
          </>
        )
      }
    </Labelled>
  );
}

export function ActionPage({ id }: { id: string }) {
  const form = useLoad(() => api.action(id), [id]);
  const f = form.data;
  /** What was typed or picked; a field not touched has its start value. */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const needsHosts = !!f?.fields.some((x) => x.hosts);
  const hosts = useLoad(
    async () => (needsHosts ? api.actionHosts(id) : undefined),
    [id, needsHosts],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: another action starts empty
  useEffect(() => setTyped({}), [id]);
  if (!f) return <Loading state={form} />;
  const values = Object.fromEntries(f.fields.map((x) => [x.name, typed[x.name] ?? x.text]));

  const hostPicks = hosts.loading
    ? ('reading' as const)
    : hosts.data
      ? {
          names: [...hosts.data.groups, ...hosts.data.hosts],
          ...(hosts.data.why ? { why: hosts.data.why } : {}),
        }
      : { names: [], why: 'The names cannot be read now' };

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
    if (f.confirm) {
      const chosen = f.fields.map((x) => `${x.label}: ${values[x.name] || '(none)'}`).join('; ');
      if (
        !(await ask(`Run "${f.title}" now?${chosen ? ` ${chosen}.` : ''}`, {
          yes: 'Run',
          no: 'Not now',
        }))
      )
        return;
    }
    setBusy(true);
    try {
      const done = await api.runAction(id, values);
      navigate(progressAddress(done.id));
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
    <>
      <PageHead title={f.title} lead={f.summary} help="actions.md" />
      <section className="panel action-form" aria-label="Run this action">
        {f.blocked ? (
          <p className="notice warn" role="status">
            {f.blocked}. Ask {f.ask.join(' or ')}.
          </p>
        ) : (
          <form className="form" noValidate onSubmit={run}>
            {f.fields.length === 0 && <p className="muted">It asks nothing: Run is all.</p>}
            {f.fields.map((x) => (
              <ActionInput
                key={x.name}
                field={x}
                value={values[x.name] ?? ''}
                problem={problems[x.name]}
                onChange={(v) => {
                  setTyped({ ...typed, [x.name]: v });
                  if (problems[x.name]) setProblems({ ...problems, [x.name]: '' });
                }}
                {...(x.hosts ? { hosts: hostPicks } : {})}
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
              <Link to="/actions">Back to actions</Link>
            </div>
          </form>
        )}
        <p className="muted small">
          Questions about it: ask {f.ask.join(' or ')}.
          {f.configPage && (
            <>
              {' '}
              <Link to={f.configPage}>Its launch configuration</Link>
            </>
          )}
        </p>
      </section>
    </>
  );
}

const STEP_MARK: Record<ActionProgress['steps'][number]['state'], string> = {
  done: 'Done',
  running: 'Running',
  waiting: 'Waiting',
  failed: 'Failed',
  'not run': 'Not run',
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
            <p>Ask {p.ask.join(' or ')} what to do next.</p>
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
        {!p.failed && <p className="muted small">Questions about it: ask {p.ask.join(' or ')}.</p>}
      </section>
    </>
  );
}

// --- on a launch configuration's Settings tab

interface FlowInput {
  name: string;
  type?: string | undefined;
  secret: boolean;
  description?: string | undefined;
}

interface AskedRow {
  on: boolean;
  label: string;
  help: string;
  choices: string;
}

const NEW: ActionSettings = {
  title: '',
  summary: '',
  asked: [],
  mode: 'check',
  confirm: true,
  enabled: true,
};

/** The action of a configuration: make it one, change its words, and who may run it. */
export function ConfigActionSection({
  config,
  name,
  inputs,
}: {
  config: string;
  name: string;
  /** The flow's inputs (the launch form's fields). */
  inputs: FlowInput[];
}) {
  const id = useId();
  const state = useLoad(() => api.configAction(config), [config]);
  const action = state.data?.action ?? undefined;
  const manage = !!state.data?.mayManage;
  const [editing, setEditing] = useState(false);
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
          }
        : { ...NEW, title: name },
    );
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
    setBusy(true);
    setError(undefined);
    try {
      const asked = Object.entries(rows)
        .filter(([, r]) => r.on)
        .map(([n, r]) => ({
          name: n,
          label: r.label.trim(),
          ...(r.help.trim() ? { help: r.help.trim() } : {}),
          ...(names(r.choices).length ? { choices: names(r.choices) } : {}),
        }));
      await api.setConfigAction(config, { ...settings, asked });
      setSaved(action ? 'The action is changed.' : 'It is an action now.');
      setEditing(false);
      state.reload();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (!state.data) return <Loading state={state} />;
  if (!manage && !action) return null;
  return (
    <section className="panel" aria-labelledby={`${id}-action`}>
      <div className="panel-head">
        <h2 id={`${id}-action`}>Action</h2>
        {manage && !editing && (
          <button type="button" onClick={() => start(action)}>
            {action ? 'Change the action' : 'Make it an action'}
          </button>
        )}
      </div>
      <p className="muted">
        An action is a short form for people who run things but do not read flows: only what it
        asks, in their words, and Run. The rest runs with this configuration's values.{' '}
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
              {!action.enabled && <span className="badge warn"> off</span>}
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
          <div>
            <dt>Runs</dt>
            <dd>
              {action.mode === 'real' ? 'for real' : 'as a check'}
              {action.confirm ? ', asks to confirm' : ''}
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
              <a href={actionAddress(action.id)}>{actionAddress(action.id)}</a>
            </dd>
          </div>
        </dl>
      )}
      {editing && (
        <form className="form" onSubmit={save} noValidate>
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
              configuration's values and cannot be changed by a runner. Choices: names separated by
              commas (only those can be picked). Secret-looking inputs are never asked.
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
            <button type="button" onClick={() => setEditing(false)} disabled={busy}>
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
                    setEditing(false);
                    state.reload();
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
      {action && manage && (
        <ActionGrants
          config={config}
          title={action.title}
          onChange={state.reload}
          grants={state.data.grants ?? []}
        />
      )}
    </section>
  );
}

function ActionGrants({
  config,
  title,
  grants,
  onChange,
}: {
  config: string;
  title: string;
  grants: NonNullable<Awaited<ReturnType<typeof api.configAction>>['grants']>;
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
      <h3>Who may run it</h3>
      <p className="muted small">
        A grant here lets someone run this action and follow the runs they start, nothing else of
        the workspace. Operators of the flow and administrators may run it too.
      </p>
      {grants.length === 0 ? (
        <p className="muted">Nobody yet but operators and administrators.</p>
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
              onChange={(e) => setWho(e.target.value)}
            />
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

/** AFS-175: the workspace's Access tab: who may run its actions. */
export function WorkspaceActionGrants({ workspace }: { workspace: string }) {
  const grants = useLoad(() => api.workspaceActionGrants(workspace), [workspace]);
  if (!grants.data?.length) return null;
  return (
    <>
      <h3>Who may run actions</h3>
      <p className="muted small">
        Each gives one action and nothing else of the workspace; they are given and taken back on
        the action's launch configuration, Settings.
      </p>
      <ul className="list plain">
        {grants.data.map((g) => (
          <li key={g.id}>
            {g.principal.type === 'group' ? `group ${g.principal.name}` : g.principal.name}{' '}
            <span className="muted">may run</span>{' '}
            <Link to={`/w/${workspace}/${g.action.projectKey}/launch/${g.action.config}/settings`}>
              {g.action.title}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
