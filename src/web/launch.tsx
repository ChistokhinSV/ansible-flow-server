// Launch configurations on the pages: a project's list of them, one with its launch form, and
// the form that adds or changes one. A launch is asked about first ("what would run": the
// commit, the inputs as the flow reads them, the hosts), then started; what stands in the way is
// shown at the field it is about.
// AFS-85: a configuration's page is four tabs (Launch, Runs, Schedules, Settings), each with an
// address; the launch form comes first, and what is rarely typed is folded away.
import { readFields, realRunLines } from '@ansible-flow/core/run/launch';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import type { FactsReply } from '../server/launch/facts';
import { atLeast, flowLevel, useProjectAccess } from './access';
import {
  ApiError,
  api,
  type Credential,
  type LaunchConfig,
  type LaunchConfigInput,
  type LaunchForm,
  type LaunchRequest,
  type PreparedLaunch,
  type Problem,
  type Project,
  type User,
} from './api';
import { EnvironmentCheck, environmentAddress } from './environments';
import { Link, navigate } from './router';
import { OlderRuns, RunList, RunWords, useRunPages } from './runs';
import { SchedulesSection } from './schedules';
import { ago, Fold, Loading, messageOf, PageHead, Tabs, Time, useLoad } from './ui';

type LaunchField = LaunchForm['fields'][number];
/** The kinds of credential a run can be given (a git token is for a repository). */
const RUN_KINDS = ['ssh_key', 'login', 'become', 'vault', 'registry', 'env'];
const KIND_LABEL: Record<string, string> = {
  ssh_key: 'SSH key',
  login: 'login',
  become: 'become',
  vault: 'vault password',
  registry: 'registry',
  env: 'environment',
};

const base = (workspace: string, project: string) =>
  `/w/${encodeURIComponent(workspace)}/${encodeURIComponent(project)}`;
export const launchAddress = (workspace: string, project: string, id: string) =>
  `${base(workspace, project)}/launch/${encodeURIComponent(id)}`;
/** A flow's page (as the project page builds it: that page reads this file, so it is not read here). */
const flowAddress = (workspace: string, project: string, file: string) =>
  `${base(workspace, project)}/flow/${file.split('/').map(encodeURIComponent).join('/')}`;
export type LaunchTab = 'launch' | 'runs' | 'schedules' | 'settings';

/** What a configuration takes: its branch or its pinned commit. */
function Takes({ config, project }: { config: LaunchConfig; project?: Project }) {
  if (config.commit) return <code title="pinned">{config.commit.slice(0, 12)}</code>;
  return (
    <>
      newest of <code>{config.gitRef ?? project?.gitRef ?? 'the project branch'}</code>
    </>
  );
}

/** A field of a form, with its problem said under it and to a screen reader. */
/** The choice of the environment chooser that asks for an image's name instead. */
const IMAGE_BY_NAME = ':image';

function Labelled({
  label,
  hint,
  problem,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  problem?: string;
  children: (props: {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
  }) => ReactNode;
}) {
  const id = useId();
  const described = [hint && `${id}-hint`, problem && `${id}-problem`].filter(Boolean).join(' ');
  return (
    <div className={`field${problem ? ' invalid' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        ...(described ? { 'aria-describedby': described } : {}),
        ...(problem ? { 'aria-invalid': true } : {}),
      })}
      {hint && (
        <small id={`${id}-hint`} className="muted">
          {hint}
        </small>
      )}
      {problem && (
        <small id={`${id}-problem`} className="bad-text">
          {problem}
        </small>
      )}
    </div>
  );
}

/**
 * A project's launch configurations, on its page. Each row says how the configuration's newest
 * run went: the server says which that is (`lastRun`), among the runs this person may see.
 */
export function LaunchConfigsSection({
  me,
  workspace,
  project,
}: {
  me: User;
  workspace: string;
  project: Project;
}) {
  const list = useLoad(() => api.launchConfigs(project.id), [project.id]);
  const access = useProjectAccess(project.id).data;
  // Who has rw on the workspace, or on one of its flows, may add a configuration for it.
  const mayAdd =
    me.admin ||
    access?.workspace === 'rw' ||
    Object.values(access?.flows ?? {}).some((l) => l === 'rw');
  return (
    <section className="panel" aria-labelledby="launch-configs">
      <div className="panel-head">
        <h2 id="launch-configs">Launch configurations</h2>
        {mayAdd && (
          <Link to={`${base(workspace, project.key)}/launch/new`} className="button">
            Add a launch configuration
          </Link>
        )}
      </div>
      <Loading state={list} />
      {list.data?.length === 0 && (
        <p className="muted">
          None yet. A launch configuration is a flow with what it runs with: inventory, credentials,
          start values.
        </p>
      )}
      {!!list.data?.length && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Flow</th>
                <th scope="col">Last run</th>
                <th scope="col">
                  <span className="sr-only">Launch</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => {
                const last = c.lastRun;
                const mayLaunch = me.admin || atLeast(flowLevel(access, c.flowFile), 'operator');
                return (
                  <tr key={c.id}>
                    <td>
                      <Link to={launchAddress(workspace, project.key, c.id)}>{c.name}</Link>
                    </td>
                    <td>
                      <code>{c.flowFile}</code>
                      {/* The branch is said only when it is not the project's own. */}
                      {(c.commit || c.gitRef) && (
                        <span className="muted">
                          {' '}
                          · <Takes config={c} project={project} />
                        </span>
                      )}
                    </td>
                    <td>
                      {last ? (
                        <Link to={`/runs/${last.id}`}>
                          <RunWords state={last.state} />{' '}
                          <span className="muted">{ago(last.createdAt)}</span>
                        </Link>
                      ) : (
                        <span className="muted">none yet</span>
                      )}
                    </td>
                    <td>
                      {mayLaunch && (
                        <Link
                          to={launchAddress(workspace, project.key, c.id)}
                          className="button"
                          aria-label={`Launch ${c.name}`}
                        >
                          {/* AFS-96: it opens the launch form (inputs, mode), it does not start a run. */}
                          Launch…
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The project of an address, with the crumbs that lead to it. */
function useProject(workspace: string, key: string) {
  return useLoad(
    async () => (await api.projects(workspace)).find((p) => p.key === key),
    [workspace, key],
  );
}

function Crumbs({
  workspace,
  project,
  last,
  config,
}: {
  workspace: string;
  project: string;
  last: string;
  config?: { id: string; name: string };
}) {
  return (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link to="/workspaces">Workspaces</Link> / <Link to={`/w/${workspace}`}>{workspace}</Link> /{' '}
      <Link to={base(workspace, project)}>{project}</Link> /{' '}
      {config && (
        <>
          <Link to={launchAddress(workspace, project, config.id)}>{config.name}</Link> /{' '}
        </>
      )}
      <span aria-current="page">{last}</span>
    </nav>
  );
}

/** One input of the flow, as text, the way its type is typed. */
/**
 * AFS-97: suggestions for a comma-separated list being typed: what is already in it stays, and each
 * name not yet in it is offered after it, so the browser's list completes the last name.
 */
export function listSuggestions(typed: string, names: readonly string[]): string[] {
  if (typed.trimStart().startsWith('[')) return [];
  const parts = typed.split(',');
  const before = parts
    .slice(0, -1)
    .map((p) => p.trim())
    .filter(Boolean);
  const used = new Set(before);
  const head = before.length ? `${before.join(', ')}, ` : '';
  return names.filter((n) => !used.has(n)).map((n) => `${head}${n}`);
}

/** A datalist of these suggestions, for an input's `list`. */
function Suggestions({ id, values }: { id: string; values: string[] }) {
  return (
    <datalist id={id}>
      {values.map((v) => (
        <option key={v} value={v} />
      ))}
    </datalist>
  );
}

function InputField({
  field,
  value,
  problem,
  onChange,
  groups,
  onWantGroups,
}: {
  field: LaunchField;
  value: string;
  problem?: string;
  onChange: (text: string) => void;
  /** AFS-97: the inventory's groups, suggested for a host list (as the canvas's dialog does). */
  groups?: string[];
  /** The groups are read when a host list is first used: that starts a container. */
  onWantGroups?(): void;
}) {
  const listId = useId();
  const suggest = field.targets && groups?.length ? listSuggestions(value, groups) : [];
  const label = (
    <>
      {field.name}
      {field.required && <span className="muted"> (required)</span>}
      {field.type && <span className="muted"> · {field.type}</span>}
    </>
  );
  const sentence = (text?: string) => (text && !/[.!?]$/.test(text) ? `${text}.` : text);
  const hint = [
    sentence(field.description),
    field.targets ? 'The hosts or groups the flow starts on: comma-separated, or a JSON list.' : '',
    field.secret ? 'Secret: typed hidden, never kept.' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Labelled label={label} hint={hint || undefined} problem={problem}>
      {(props) =>
        field.type === 'boolean' ? (
          <select {...props} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">(not set)</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (field.type === 'dict' || field.type === 'list') && !field.targets ? (
          <textarea
            {...props}
            rows={3}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
          />
        ) : (
          <>
            <input
              {...props}
              type={field.secret ? 'password' : 'text'}
              autoComplete={field.secret ? 'new-password' : 'off'}
              spellCheck={false}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onFocus={field.targets ? onWantGroups : undefined}
              required={field.required}
              {...(suggest.length ? { list: listId } : {})}
            />
            {suggest.length > 0 && <Suggestions id={listId} values={suggest} />}
          </>
        )
      }
    </Labelled>
  );
}

/** AFS-67: the hosts as the inventory has them, read in the launch's image. */
function InventoryHosts({ hosts }: { hosts: HostsState }) {
  return (
    <>
      <h3>Hosts in the inventory</h3>
      {hosts === 'reading' ? (
        <p className="muted">Reading the inventory in the launch's image…</p>
      ) : 'error' in hosts ? (
        <p className="error-text">{hosts.error}</p>
      ) : hosts.facts ? (
        <ul className="plain" data-facts>
          {/* The first line says "not check mode": the mode is said above. */}
          {realRunLines(hosts.facts)
            .slice(1)
            .map((l) => (
              <li key={l}>{l}</li>
            ))}
        </ul>
      ) : (
        <p className="error-text">{hosts.factsError}</p>
      )}
    </>
  );
}

type HostsState = 'reading' | FactsReply | { error: string };

/** What a check said would run. */
function WouldRun({
  launch,
  form,
  hosts,
}: {
  launch: PreparedLaunch;
  form: LaunchForm;
  hosts?: HostsState;
}) {
  const shown = Object.entries(launch.inputs);
  return (
    <section className="panel ok-panel" aria-labelledby="would-run" aria-live="polite">
      <h2 id="would-run">What would run</h2>
      <dl className="facts">
        <dt>Flow</dt>
        <dd>
          {launch.flow.name} <span className="muted">version {launch.flow.version}</span>
        </dd>
        <dt>Commit</dt>
        <dd>
          <code>{launch.commit.slice(0, 12)}</code>
          {launch.ref && (
            <span className="muted">
              {' '}
              · newest of <code>{launch.ref}</code>
            </span>
          )}
        </dd>
        <dt>Mode</dt>
        <dd>{launch.mode === 'check' ? 'check (nothing is changed)' : 'real'}</dd>
        <dt>Starts on</dt>
        <dd>{launch.targets.length ? launch.targets.join(', ') : 'no hosts'}</dd>
        {launch.limit && (
          <>
            <dt>Limit</dt>
            <dd>
              <code>{launch.limit}</code>
            </dd>
          </>
        )}
        <dt>Inventory</dt>
        <dd>{form.inventory ? <code>{form.inventory}</code> : 'what ansible.cfg names'}</dd>
        <dt>Image</dt>
        <dd>{form.eeImage ? <code>{form.eeImage}</code> : "the server's default"}</dd>
        <dt>Credentials</dt>
        <dd>{launch.credentials.length}</dd>
      </dl>
      {hosts && <InventoryHosts hosts={hosts} />}
      {shown.length > 0 && (
        <>
          <h3>Inputs, as the flow gets them</h3>
          <dl className="facts">
            {shown.map(([name, value]) => (
              <div key={name} className="fact">
                <dt>{name}</dt>
                <dd>
                  <code>{typeof value === 'string' ? value : JSON.stringify(value)}</code>
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}

/** A configuration's settings, read: for who may not change them. */
function SettingsFacts({
  config: c,
  project,
  workspace,
}: {
  config: LaunchConfig;
  project: Project;
  workspace: string;
}) {
  return (
    <dl className="facts">
      <dt>Flow</dt>
      <dd>
        <code>{c.flowFile}</code>
      </dd>
      <dt>Runs</dt>
      <dd>
        <Takes config={c} project={project} />
      </dd>
      <dt>Mode</dt>
      <dd>{c.mode}</dd>
      <dt>Inventory</dt>
      <dd>{c.inventory ? <code>{c.inventory}</code> : 'what ansible.cfg names'}</dd>
      {c.environment && (
        <>
          <dt>Environment</dt>
          <dd>
            <Link to={environmentAddress(workspace, c.environment)}>its newest good build</Link>
          </dd>
        </>
      )}
      <dt>Image</dt>
      <dd>{c.eeImage ? <code>{c.eeImage}</code> : "the server's default"}</dd>
      {c.limit && (
        <>
          <dt>Limit</dt>
          <dd>
            <code>{c.limit}</code>
          </dd>
        </>
      )}
      <dt>Credentials</dt>
      <dd>{c.credentials.length || 'none'}</dd>
      <dt>Tells</dt>
      <dd>
        {c.notify
          ? `${c.notify.to.join(', ')}, ${c.notify.when === 'failed' ? 'when a run fails' : 'whenever a run ends'}`
          : 'nobody'}
      </dd>
      <dt>Changed</dt>
      <dd>
        <Time at={c.updatedAt} />
      </dd>
    </dl>
  );
}

/**
 * The runs of one configuration, newest first, a page at a time: the server is asked for the
 * configuration's own runs.
 */
function ConfigRuns({ config, me }: { config: LaunchConfig; me: User }) {
  const pages = useRunPages({ config: config.id });
  const { list, rows, fresh } = pages;
  return (
    <section className="panel" aria-label="Runs">
      {(!fresh || list.error) && <Loading state={list} />}
      {fresh && rows?.length === 0 && <p className="empty">No run of this configuration yet.</p>}
      {fresh && !!rows?.length && <RunList runs={rows} me={me} showConfig={false} />}
      <OlderRuns pages={pages} />
      {fresh && (
        <p className="muted small">
          <Link to="/runs">All runs</Link>
        </p>
      )}
    </section>
  );
}

/** Deleting a configuration: at the end of its settings, asked about first. */
function DeleteConfig({ config, to }: { config: LaunchConfig; to: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const remove = async () => {
    if (!window.confirm(`Delete the launch configuration "${config.name}"? Its runs stay.`)) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteLaunchConfig(config.id);
      navigate(to);
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };
  return (
    <section className="panel" aria-labelledby="delete-config">
      <h2 id="delete-config">Delete</h2>
      <p className="muted">Its runs stay.</p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="button" className="danger" onClick={() => void remove()} disabled={busy}>
          Delete this launch configuration
        </button>
      </div>
    </section>
  );
}

/**
 * One launch configuration, in tabs: the form that launches it, its runs, its schedules and its
 * settings. What is typed into the launch form stays while the other tabs are looked at.
 */
export function LaunchConfigPage({
  me,
  workspace,
  project: key,
  id,
  tab,
}: {
  me: User;
  workspace: string;
  project: string;
  id: string;
  tab: LaunchTab;
}) {
  const project = useProject(workspace, key);
  const config = useLoad(() => api.launchConfig(id), [id]);
  const access = useProjectAccess(project.data?.id).data;
  const branches = useLoad(
    async () => (project.data ? (await api.branches(project.data.id)).branches : []),
    [project.data?.id],
  );
  const [mode, setMode] = useState<'check' | 'real' | undefined>();
  const [ref, setRef] = useState('');
  const [commit, setCommit] = useState('');
  const [limit, setLimit] = useState<string | undefined>();
  /** The commit and branch the form was read at: what the inputs are of. */
  const [at, setAt] = useState({ ref: '', commit: '' });
  const form = useLoad(
    () =>
      api.launchForm(id, {
        ...(mode ? { mode } : {}),
        ...(at.ref ? { ref: at.ref } : {}),
        ...(at.commit ? { commit: at.commit } : {}),
      }),
    [id, mode, at.ref, at.commit],
  );
  const [texts, setTexts] = useState<Record<string, string>>({});
  // A newly read form starts from its own texts; what was typed into a field of the same name
  // stays.
  useEffect(() => {
    const fields = form.data?.fields;
    if (!fields) return;
    setTexts((typed) => Object.fromEntries(fields.map((f) => [f.name, typed[f.name] ?? f.text])));
  }, [form.data]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{ launch: PreparedLaunch; form: LaunchForm }>();
  const [hosts, setHosts] = useState<HostsState>();
  const [busy, setBusy] = useState<'check' | 'launch' | 'save'>();
  const [saved, setSaved] = useState<string>();
  /** The fold of rarely typed fields, once the person opened or closed it themselves. */
  const [folded, setFolded] = useState<boolean>();
  /** AFS-97: the inventory's groups for host lists: read once, when a host list is first used. */
  const [groups, setGroups] = useState<string[] | 'reading'>();

  const c = config.data;
  if (!c || !project.data)
    return (
      <>
        <Crumbs workspace={workspace} project={key} last="Launch configuration" />
        <PageHead title="Launch configuration" />
        <Loading state={config.error ? config : project} />
      </>
    );

  const fields = form.data?.fields ?? [];
  const level = me.admin ? 'rw' : flowLevel(access, c.flowFile);
  const mayLaunch = atLeast(level, 'operator');
  const mayManage = atLeast(level, 'rw');
  const request = () => ({
    ...(mode ? { mode } : {}),
    ...(ref.trim() ? { ref: ref.trim() } : {}),
    ...(commit.trim() ? { commit: commit.trim() } : {}),
    ...(limit !== undefined ? { limit: limit.trim() } : {}),
    inputs: Object.fromEntries(
      Object.entries(texts).filter(([name]) => fields.some((f) => f.name === name)),
    ),
  });
  const refused = (e: unknown) => {
    if (e instanceof ApiError && e.details.problems?.length) {
      setProblems(e.details.problems);
      const general = e.details.problems.filter((p) => !p.field || !isShown(p.field));
      setError(general.length ? general.map((p) => p.message).join(' ') : undefined);
    } else setError(messageOf(e));
  };
  const isShown = (field: string) =>
    ['ref', 'commit', 'limit', 'mode'].includes(field) || fields.some((f) => f.name === field);
  const problemOf = (field: string) => problems.find((p) => p.field === field)?.message;
  const start = (what: 'check' | 'launch' | 'save') => {
    setBusy(what);
    setProblems([]);
    setError(undefined);
    setSaved(undefined);
    if (what !== 'save') setResult(undefined);
  };

  const check = async () => {
    start('check');
    setHosts(undefined);
    try {
      const asked = request();
      setResult(await api.checkLaunch(c.id, asked));
      // Who may launch also sees the hosts: reading them starts a container in the image.
      if (mayLaunch) {
        setHosts('reading');
        api.launchFacts(c.id, asked).then(setHosts, (e) => setHosts({ error: messageOf(e) }));
      }
    } catch (e) {
      refused(e);
    } finally {
      setBusy(undefined);
    }
  };
  const launch = async () => {
    start('launch');
    try {
      const run = await api.launch(c.id, request());
      navigate(`/runs/${run.id}`);
    } catch (e) {
      refused(e);
      setBusy(undefined);
    }
  };
  /** The typed values of the inputs that are not secret become the configuration's. */
  const keep = async () => {
    start('save');
    const kept = fields.filter((f) => !f.secret && (texts[f.name] ?? '').trim() !== '');
    const read = readFields(kept, texts);
    if ('error' in read) {
      setProblems([{ field: read.field, message: read.error }]);
      setBusy(undefined);
      return;
    }
    try {
      const changed = await api.changeLaunchConfig(c.id, { inputs: read.inputs });
      config.reload();
      setSaved(
        `Start values kept: ${Object.keys(changed.inputs).join(', ') || 'none'}. Secret inputs are never kept.`,
      );
    } catch (e) {
      refused(e);
    } finally {
      setBusy(undefined);
    }
  };
  const reread = () => {
    if (ref.trim() !== at.ref || commit.trim() !== at.commit)
      setAt({ ref: ref.trim(), commit: commit.trim() });
  };
  const here = launchAddress(workspace, key, c.id);
  const limitText = limit ?? form.data?.limit ?? '';
  // The fold opens by itself when something in it has a value, and always when the server points
  // at one of its fields.
  const foldOpen =
    ['ref', 'commit', 'limit'].some((f) => problemOf(f)) ||
    (folded ?? !!(ref || commit || limitText));

  return (
    <>
      <Crumbs workspace={workspace} project={key} last={c.name} />
      <PageHead title={c.name} lead={c.description} />
      {/* What it runs with, in a line: all of it is on the Settings tab. */}
      <p className="statusline">
        <span>
          Flow{' '}
          <Link to={flowAddress(workspace, key, c.flowFile)}>
            <code>{c.flowFile}</code>
          </Link>
        </span>
        <span>
          {c.commit ? 'pinned to ' : ''}
          <Takes config={c} project={project.data} />
        </span>
        <span>inventory {c.inventory ? <code>{c.inventory}</code> : 'as ansible.cfg names'}</span>
        <span>
          image{' '}
          {c.environment ? (
            <Link to={environmentAddress(workspace, c.environment)}>
              its environment's newest good build
            </Link>
          ) : c.eeImage ? (
            <code>{c.eeImage}</code>
          ) : (
            "the server's default"
          )}
        </span>
        <span>
          {c.credentials.length
            ? `${c.credentials.length} ${c.credentials.length === 1 ? 'credential' : 'credentials'}`
            : 'no credentials'}
        </span>
      </p>
      <Tabs
        label="Launch configuration"
        base={here}
        tabs={[
          { key: '', label: 'Launch' },
          { key: 'runs', label: 'Runs' },
          { key: 'schedules', label: 'Schedules' },
          { key: 'settings', label: 'Settings' },
        ]}
        current={tab === 'runs' || tab === 'schedules' || tab === 'settings' ? tab : ''}
      />

      {tab === 'runs' ? (
        <ConfigRuns config={c} me={me} />
      ) : tab === 'schedules' ? (
        <SchedulesSection config={c.id} form={form.data} mayManage={mayManage} me={me} />
      ) : tab === 'settings' ? (
        mayManage ? (
          <>
            <section className="panel" aria-label="Settings">
              <ConfigForm
                key={c.id}
                workspace={workspace}
                project={project.data}
                existing={c}
                onSaved={() => {
                  // The launch form is of the settings: it is read again with them.
                  config.reload();
                  form.reload();
                }}
              />
            </section>
            <DeleteConfig config={c} to={base(workspace, key)} />
          </>
        ) : (
          <section className="panel" aria-label="Settings">
            <SettingsFacts config={c} project={project.data} workspace={workspace} />
            <p className="muted">Changing them needs rw on this flow.</p>
          </section>
        )
      ) : (
        <>
          <section className="panel" aria-label="Launch">
            {/* The server says what is missing or wrong, at each field: the browser does not stop
                the question first. */}
            <form
              className="form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void check();
              }}
              aria-describedby={error ? 'launch-error' : undefined}
            >
              <Loading state={form} />
              {fields.length === 0 && form.data && (
                <p className="muted">The flow takes no inputs.</p>
              )}
              {fields.map((f) => (
                <InputField
                  key={f.name}
                  field={f}
                  value={texts[f.name] ?? f.text}
                  problem={problemOf(f.name)}
                  onChange={(text) => setTexts((t) => ({ ...t, [f.name]: text }))}
                  groups={Array.isArray(groups) ? groups : undefined}
                  onWantGroups={() => {
                    // Reading the inventory starts a container in the launch's image: once, and
                    // only for who may launch (as the hosts after Check).
                    if (groups || !mayLaunch) return;
                    setGroups('reading');
                    api.launchFacts(c.id, { ...request(), groups: true } as LaunchRequest).then(
                      (r) => setGroups(r.groups ?? []),
                      () => setGroups([]),
                    );
                  }}
                />
              ))}
              <fieldset className="choices">
                <legend>Mode</legend>
                {(['check', 'real'] as const).map((m) => (
                  <label key={m} className="inline">
                    <input
                      type="radio"
                      name="mode"
                      value={m}
                      checked={(mode ?? form.data?.mode ?? c.mode) === m}
                      onChange={() => setMode(m)}
                    />
                    {m === 'check' ? 'Check: a skeleton run, nothing is changed' : 'Real'}
                  </label>
                ))}
              </fieldset>
              {error && (
                <p className="notice error" role="alert" id="launch-error">
                  {error}
                </p>
              )}
              {problems.some((p) => p.field && isShown(p.field)) && !error && (
                <p className="notice error" role="alert">
                  Some fields need a look: see the ones marked.
                </p>
              )}
              {saved && (
                <p className="notice" role="status">
                  {saved}
                </p>
              )}
              {/* AFS-96: Launch is first and the only filled button; Enter in a field still asks
                  what would run (the form's submit), which changes nothing. */}
              <div className="actions">
                {mayLaunch && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void launch()}
                    disabled={!!busy || !form.data}
                  >
                    {busy === 'launch' ? 'Launching…' : 'Launch'}
                  </button>
                )}
                <button type="submit" disabled={!!busy || !form.data}>
                  {busy === 'check' ? 'Looking…' : 'What would run'}
                </button>
                {mayManage && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => void keep()}
                    disabled={!!busy || !form.data}
                  >
                    Keep as start values
                  </button>
                )}
              </div>
              {form.data && (
                <p className="muted small">
                  The inputs of <strong>{form.data.flow.name}</strong> at{' '}
                  <code>{form.data.commit.slice(0, 12)}</code>
                  {form.data.ref && (
                    <>
                      , the newest of <code>{form.data.ref}</code>
                    </>
                  )}
                  .
                </p>
              )}
              {!mayLaunch && (
                <p className="muted">
                  You may see what would run; launching needs operator on this flow.
                </p>
              )}
              {/* Rarely typed, so under the buttons and folded: Launch stays near the top. */}
              <Fold
                summary="Another branch or commit, a limit"
                open={foldOpen}
                onToggle={setFolded}
              >
                <div className="pair">
                  <Labelled
                    label="Branch"
                    hint={`Empty: ${c.commit ? 'the pinned commit' : (c.gitRef ?? project.data.gitRef)}`}
                    problem={problemOf('ref')}
                  >
                    {(props) => (
                      <input
                        {...props}
                        list="branches"
                        value={ref}
                        onChange={(e) => setRef(e.target.value)}
                        onBlur={reread}
                        disabled={!mayManage}
                        spellCheck={false}
                      />
                    )}
                  </Labelled>
                  <datalist id="branches">
                    {branches.data?.map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                  <Labelled label="Or a commit" hint="40 hex digits" problem={problemOf('commit')}>
                    {(props) => (
                      <input
                        {...props}
                        value={commit}
                        onChange={(e) => setCommit(e.target.value)}
                        onBlur={reread}
                        disabled={!mayManage}
                        pattern="[0-9a-f]{40}"
                        spellCheck={false}
                      />
                    )}
                  </Labelled>
                </div>
                {mayLaunch && !mayManage && (
                  <p className="muted">
                    You launch what the configuration names: another branch or commit needs rw.
                  </p>
                )}
                <Labelled
                  label="Limit"
                  hint="Ansible's --limit: fewer hosts than the flow starts on."
                  problem={problemOf('limit')}
                >
                  {(props) => (
                    <input
                      {...props}
                      value={limitText}
                      onChange={(e) => setLimit(e.target.value)}
                      spellCheck={false}
                    />
                  )}
                </Labelled>
              </Fold>
            </form>
          </section>
          {result && <WouldRun launch={result.launch} form={result.form} hosts={hosts} />}
          <EnvironmentCheck config={c.id} workspace={workspace} mayManage={mayManage} />
        </>
      )}
    </>
  );
}

/**
 * The fields of a launch configuration: adding one to a project, or changing `existing`. Who shows
 * it says where to go once it is saved.
 */
function ConfigForm({
  workspace,
  project,
  existing,
  onSaved,
  onCancel,
}: {
  workspace: string;
  project: Project;
  existing?: LaunchConfig;
  onSaved(saved: LaunchConfig): void;
  onCancel?(): void;
}) {
  const pid = project.id;
  const flows = useLoad(async () => (await api.flows(pid)).flows, [pid]);
  const branches = useLoad(async () => (await api.branches(pid)).branches, [pid]);
  const credentials = useLoad(
    async () => (await api.credentials(workspace)).filter((k) => RUN_KINDS.includes(k.kind)),
    [workspace],
  );
  const environments = useLoad(() => api.environments(workspace), [workspace]);
  const [input, setInput] = useState<LaunchConfigInput>(() =>
    existing
      ? {
          name: existing.name,
          description: existing.description ?? '',
          flowFile: existing.flowFile,
          gitRef: existing.gitRef ?? '',
          commit: existing.commit ?? '',
          inventory: existing.inventory ?? '',
          eeImage: existing.eeImage ?? '',
          environment: existing.environment ?? '',
          mode: existing.mode,
          limit: existing.limit ?? '',
          credentials: existing.credentials,
        }
      : {
          name: '',
          // A flow's page asks for a configuration of that flow (`?flow=`).
          flowFile: new URLSearchParams(window.location.search).get('flow') ?? '',
          mode: 'check',
        },
  );
  // AFS-29: whom its runs tell, and when; typed as names separated by commas.
  const [tellWhen, setTellWhen] = useState<'' | 'failed' | 'ended'>(existing?.notify?.when ?? '');
  const [tellTo, setTellTo] = useState(existing?.notify?.to.join(', ') ?? '');
  // AFS-97: the server's people and groups, suggested while Whom is typed.
  const recipients = useLoad(() => api.recipients(workspace).catch(() => []), [workspace]);
  const whomId = useId();
  const whom = listSuggestions(
    tellTo,
    (recipients.data ?? []).map((r) => r.name),
  );
  const [problem, setProblem] = useState<{ field?: string; message: string }>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // AFS-96: the image is asked for only when "an image by name" is what runs get.
  const [byImage, setByImage] = useState(!existing?.environment && !!existing?.eeImage);
  const set = (key: keyof LaunchConfigInput, value: unknown) => {
    setSaved(false);
    setInput((i) => ({ ...i, [key]: value }));
  };
  const at = (field: string) => (problem?.field === field ? problem.message : undefined);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setSaved(false);
    setProblem(undefined);
    // Empty means "not set": the project's branch, no pin, the default image.
    const blank = (text: string | null | undefined) => (text?.trim() ? text.trim() : null);
    const body: LaunchConfigInput = {
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      flowFile: input.flowFile,
      gitRef: blank(input.gitRef),
      commit: blank(input.commit),
      inventory: blank(input.inventory),
      eeImage: blank(input.eeImage),
      environment: blank(input.environment),
      mode: input.mode ?? 'check',
      limit: blank(input.limit),
      credentials: input.credentials ?? [],
      notify: (() => {
        const to = tellTo
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean);
        return tellWhen && to.length ? { when: tellWhen, to } : null;
      })(),
    };
    try {
      const done = existing
        ? await api.changeLaunchConfig(existing.id, body)
        : await api.addLaunchConfig(pid, body);
      setBusy(false);
      setSaved(true);
      onSaved(done);
    } catch (e) {
      setProblem({
        ...(e instanceof ApiError && e.details.field ? { field: e.details.field } : {}),
        message: messageOf(e),
      });
      setBusy(false);
    }
  };
  const chosen = new Set(input.credentials ?? []);
  const general = problem && !problem.field ? problem.message : undefined;
  const fieldless =
    problem?.field &&
    ![
      'name',
      'flowFile',
      'gitRef',
      'commit',
      'inventory',
      'eeImage',
      'environment',
      'limit',
      'credentials',
      'notify',
    ].includes(problem.field)
      ? problem.message
      : undefined;

  return (
    <form className="form wide" onSubmit={save}>
      {/* AFS-96: fields that belong together share a row; what is chosen first comes first. */}
      <div className="pair">
        <Labelled label="Name" problem={at('name')}>
          {(props) => (
            <input
              {...props}
              value={input.name}
              onChange={(e) => set('name', e.target.value)}
              required
              maxLength={100}
            />
          )}
        </Labelled>
        <Labelled label="Flow" problem={at('flowFile')} hint="A flow of the project's branch.">
          {(props) => (
            <select
              {...props}
              value={input.flowFile}
              onChange={(e) => set('flowFile', e.target.value)}
              required
            >
              <option value="">(choose a flow)</option>
              {input.flowFile && !flows.data?.some((f) => f.file === input.flowFile) && (
                <option value={input.flowFile}>{input.flowFile}</option>
              )}
              {flows.data?.map((f) => (
                <option key={f.file} value={f.file}>
                  {f.name ? `${f.name} (${f.file})` : f.file}
                </option>
              ))}
            </select>
          )}
        </Labelled>
      </div>
      <Labelled label="Description">
        {(props) => (
          <input
            {...props}
            value={input.description ?? ''}
            onChange={(e) => set('description', e.target.value)}
            maxLength={1000}
          />
        )}
      </Labelled>
      <fieldset className="choices">
        <legend>Mode a launch starts with</legend>
        {(['check', 'real'] as const).map((m) => (
          <label key={m} className="inline">
            <input
              type="radio"
              name="config-mode"
              value={m}
              checked={input.mode === m}
              onChange={() => set('mode', m)}
            />
            {m === 'check' ? 'Check' : 'Real'}
          </label>
        ))}
      </fieldset>
      <div className="pair">
        <Labelled
          label="Branch"
          hint={`Empty: the project's branch (${project.gitRef}).`}
          problem={at('gitRef')}
        >
          {(props) => (
            <select
              {...props}
              value={input.gitRef ?? ''}
              onChange={(e) => set('gitRef', e.target.value)}
            >
              <option value="">the project's branch</option>
              {input.gitRef && !branches.data?.includes(input.gitRef) && (
                <option value={input.gitRef}>{input.gitRef}</option>
              )}
              {branches.data
                ?.filter((b) => b !== project.gitRef)
                .map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
            </select>
          )}
        </Labelled>
        <Labelled
          label="Pinned commit"
          hint="Always this commit; empty: the newest of the branch."
          problem={at('commit')}
        >
          {(props) => (
            <input
              {...props}
              value={input.commit ?? ''}
              onChange={(e) => set('commit', e.target.value)}
              pattern="[0-9a-f]{40}"
              spellCheck={false}
            />
          )}
        </Labelled>
      </div>
      <div className="pair">
        <Labelled
          label="Inventory"
          hint="A file or folder of the repository; empty: what its ansible.cfg names."
          problem={at('inventory')}
        >
          {(props) => (
            <input
              {...props}
              value={input.inventory ?? ''}
              onChange={(e) => set('inventory', e.target.value)}
              placeholder="inventory/hosts.yaml"
              spellCheck={false}
            />
          )}
        </Labelled>
        <Labelled label="Limit" hint="Ansible's --limit." problem={at('limit')}>
          {(props) => (
            <input
              {...props}
              value={input.limit ?? ''}
              onChange={(e) => set('limit', e.target.value)}
              spellCheck={false}
            />
          )}
        </Labelled>
      </div>
      <div className="pair">
        <Labelled
          label="Execution environment"
          hint="An environment gives each launch its newest good build's image."
          problem={at('environment')}
        >
          {(props) => (
            <select
              {...props}
              value={input.environment || (byImage ? IMAGE_BY_NAME : '')}
              onChange={(e) => {
                const picked = e.target.value;
                setByImage(picked === IMAGE_BY_NAME);
                set('environment', picked === IMAGE_BY_NAME ? '' : picked);
                // An image by name is kept only while that is what is chosen.
                if (picked !== IMAGE_BY_NAME) set('eeImage', '');
              }}
            >
              <option value="">the server's default image</option>
              {environments.data?.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                  {e.current ? '' : ' (not built yet)'}
                </option>
              ))}
              <option value={IMAGE_BY_NAME}>an image by name…</option>
            </select>
          )}
        </Labelled>
        {byImage && !input.environment && (
          <Labelled
            label="Image"
            hint="As the container engine pulls it: a registry, a name and a tag."
            problem={at('eeImage')}
          >
            {(props) => (
              <input
                {...props}
                value={input.eeImage ?? ''}
                onChange={(e) => set('eeImage', e.target.value)}
                placeholder="registry.example.net/ee/network:2.19"
                spellCheck={false}
                required
              />
            )}
          </Labelled>
        )}
      </div>
      <fieldset className="choices grid" aria-describedby="credentials-hint">
        <legend>Credentials the run gets</legend>
        <Loading state={credentials} />
        {credentials.data?.length === 0 && (
          <p className="muted">The workspace has no credential a run can use.</p>
        )}
        {credentials.data?.map((k: Credential) => (
          <label key={k.id} className="inline">
            <input
              type="checkbox"
              checked={chosen.has(k.id)}
              onChange={(e) =>
                set(
                  'credentials',
                  e.target.checked ? [...chosen, k.id] : [...chosen].filter((x) => x !== k.id),
                )
              }
            />
            {k.name} <span className="muted">· {KIND_LABEL[k.kind] ?? k.kind}</span>
          </label>
        ))}
        <small id="credentials-hint" className="muted">
          At most one SSH key, one login and one become credential.
        </small>
        {at('credentials') && <small className="bad-text">{at('credentials')}</small>}
      </fieldset>
      <div className="pair">
        <Labelled label="Tell">
          {(props) => (
            <select
              {...props}
              value={tellWhen}
              onChange={(e) => {
                setSaved(false);
                setTellWhen(e.target.value as '' | 'failed' | 'ended');
              }}
            >
              <option value="">nobody</option>
              <option value="failed">when a run fails</option>
              <option value="ended">whenever a run ends</option>
            </select>
          )}
        </Labelled>
        <Labelled
          label="Whom"
          hint="Logins and groups, separated by commas."
          problem={at('notify')}
        >
          {(props) => (
            <>
              <input
                {...props}
                value={tellTo}
                onChange={(e) => {
                  setSaved(false);
                  setTellTo(e.target.value);
                }}
                placeholder="network-oncall, dana"
                spellCheck={false}
                autoComplete="off"
                disabled={!tellWhen}
                {...(whom.length ? { list: whomId } : {})}
              />
              {whom.length > 0 && <Suggestions id={whomId} values={whom} />}
            </>
          )}
        </Labelled>
      </div>
      {(general || fieldless) && (
        <p className="notice error" role="alert">
          {general ?? fieldless}
        </p>
      )}
      {problem?.field && !fieldless && (
        <p className="notice error" role="alert">
          Not saved: see the field marked above.
        </p>
      )}
      {saved && (
        <p className="notice" role="status">
          Saved.
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…' : existing ? 'Save' : 'Add'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
      {existing && (
        <p className="muted">
          Start values of the flow's inputs are kept from the launch form ("Keep as start values").
        </p>
      )}
    </form>
  );
}

/**
 * Adds a launch configuration to a project, on a page of its own. With an `id` it changes that
 * one: the same form as the Settings tab of the configuration's page.
 */
export function LaunchConfigEdit({
  workspace,
  project: key,
  id,
}: {
  workspace: string;
  project: string;
  id?: string;
}) {
  const project = useProject(workspace, key);
  const existing = useLoad(async () => (id ? api.launchConfig(id) : undefined), [id]);
  const title = id
    ? `Change ${existing.data?.name ?? 'launch configuration'}`
    : 'Add a launch configuration';

  if (!project.data || (id && !existing.data))
    return (
      <>
        <Crumbs workspace={workspace} project={key} last={title} />
        <PageHead title={title} />
        <Loading state={existing.error ? existing : project} />
      </>
    );

  return (
    <>
      <Crumbs
        workspace={workspace}
        project={key}
        last={id ? 'Change' : 'Add a launch configuration'}
        {...(id && existing.data ? { config: { id, name: existing.data.name } } : {})}
      />
      <PageHead
        title={title}
        lead="Saved only if it could run now. Secret inputs are never kept: they are typed at launch."
      />
      <section className="panel">
        <ConfigForm
          key={id ?? 'new'}
          workspace={workspace}
          project={project.data}
          {...(existing.data ? { existing: existing.data } : {})}
          onSaved={(saved) => navigate(launchAddress(workspace, key, saved.id))}
          onCancel={() => navigate(id ? launchAddress(workspace, key, id) : base(workspace, key))}
        />
      </section>
    </>
  );
}
