// Launch configurations on the pages: a project's list of them, one with its launch form, and
// the form that adds or changes one. A launch is asked about first ("what would run": the
// commit, the inputs as the flow reads them, the hosts), then started; what stands in the way is
// shown at the field it is about.
// AFS-85: a configuration's page is four tabs (Launch, Runs, Schedules, Settings), each with an
// address; the launch form comes first, and what is rarely typed is folded away.
import { readFields, realRunLines } from '@ansible-flow/core/run/launch';
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { errorsLead, type FlowError } from '../server/flowErrors';
import type { FactsReply } from '../server/launch/facts';
import { type CredentialKind, KIND_NAME as KIND_LABEL } from '../server/secrets/kinds';
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
import { ask } from './confirm';
import { EnvironmentCheck, environmentAddress } from './environments';
import { Missing, MissingProject } from './help';
import { Link, navigate, useUnsaved } from './router';
import { OlderRuns, RunList, RunWords, useRunPages } from './runs';
import { SchedulesSection } from './schedules';
import {
  ago,
  Breadcrumb,
  COMMIT_PATTERN,
  COMMIT_TITLE,
  Fold,
  Labelled,
  Loading,
  limitNote,
  messageOf,
  PageHead,
  ProjectName,
  reveal,
  Scroll,
  Tabs,
  Time,
  useLoad,
  useReveal,
  WorkspaceName,
} from './ui';

type LaunchField = LaunchForm['fields'][number];
/** The kinds of credential a run can be given (a git token is for a repository). */
const RUN_KINDS = ['ssh_key', 'login', 'become', 'vault', 'registry', 'env'];

const base = (workspace: string, project: string) =>
  `/w/${encodeURIComponent(workspace)}/${encodeURIComponent(project)}`;
/** AFS-149: a flow's page, where the canvas's Run asked for a new configuration. */
const flowPage = (workspace: string, project: string, file: string) =>
  `/w/${encodeURIComponent(workspace)}/${encodeURIComponent(project)}/flow/${file.split('/').map(encodeURIComponent).join('/')}`;
/** AFS-149: the flow whose canvas asked for a new configuration (`?flow=…&back=flow`). */
const canvasFlow = () => {
  const q = new URLSearchParams(window.location.search);
  return q.get('back') === 'flow' ? (q.get('flow') ?? undefined) : undefined;
};
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

/** The choice of the environment chooser that asks for an image's name instead. */
const IMAGE_BY_NAME = ':image';

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
  const flowNames = useFlowNames(project.id);
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
        <Scroll>
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Flow</th>
                <th scope="col">Last run</th>
                <th scope="col" className="act">
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
                      <FlowLabel file={c.flowFile} names={flowNames} />
                      {/* AFS-147: a flow deleted from the branch: its configuration cannot run. */}
                      {c.flowGone && (
                        <span className="warn-text" title={c.flowGone}>
                          {' '}
                          · the flow is gone
                        </span>
                      )}
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
                    <td className="act">
                      {mayLaunch && !c.flowGone && (
                        <Link
                          to={launchAddress(workspace, project.key, c.id)}
                          className="button"
                          aria-label={`Launch ${c.name}`}
                        >
                          {/* AFS-94: it opens the launch form (inputs, mode), it does not start a run. */}
                          Launch…
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Scroll>
      )}
    </section>
  );
}

/**
 * AFS-152: a launch configuration not there, or not shared (the server answers both the same
 * way), in a project the person can open.
 */
function MissingConfig({
  workspace,
  project,
  id,
}: {
  workspace: string;
  project: Project;
  id: string;
}) {
  return (
    <>
      <Crumbs workspace={workspace} project={project.key} last="Launch configuration" />
      <Missing
        what={
          <>
            The launch configuration <code>{id}</code> in {project.name}
          </>
        }
        back={{ to: base(workspace, project.key), label: `Back to ${project.name}` }}
        help="launch-configurations.md"
      />
    </>
  );
}

/** The project of an address, with the crumbs that lead to it. */
function useProject(workspace: string, key: string) {
  return useLoad(
    async () => (await api.projects(workspace)).find((p) => p.key === key),
    [workspace, key],
  );
}

/** AFS-153: a project's flows by their names, for what names a flow by its file. */
function useFlowNames(projectId: string | undefined): Map<string, string> {
  const flows = useLoad(
    async () => (projectId ? (await api.flows(projectId)).flows : []),
    [projectId],
  );
  return useMemo(
    () => new Map((flows.data ?? []).flatMap((f) => (f.name ? [[f.file, f.name]] : []))),
    [flows.data],
  );
}

/** A flow by its name, its file on hover; by its file while the name is not known. */
function FlowLabel({ file, names }: { file: string; names: Map<string, string> }) {
  const name = names.get(file);
  return name ? <span title={file}>{name}</span> : <code>{file}</code>;
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
    <Breadcrumb>
      <Link to="/workspaces">Workspaces</Link> /{' '}
      <Link to={`/w/${workspace}`}>
        <WorkspaceName workspace={workspace} />
      </Link>{' '}
      /{' '}
      <Link to={base(workspace, project)}>
        <ProjectName workspace={workspace} project={project} />
      </Link>{' '}
      /{' '}
      {config && (
        <>
          <Link to={launchAddress(workspace, project, config.id)}>{config.name}</Link> /{' '}
        </>
      )}
      <span aria-current="page">{last}</span>
    </Breadcrumb>
  );
}

/** One input of the flow, as text, the way its type is typed. */
/** The names of a comma-separated list as typed; a JSON list is not split here. */
export const listNames = (typed: string): string[] =>
  typed.trimStart().startsWith('[')
    ? []
    : typed
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);

/**
 * AFS-97, AFS-99: suggestions for a comma-separated list being typed, for a datalist. A browser
 * shows only options that contain what is typed, so every option starts with the whole text: the
 * last name completed (`web-01, d` → `web-01, db`), and, when the last name is whole, each name not
 * in the list yet added after it (`olga` → `olga, change-board`).
 */
export function listSuggestions(typed: string, names: readonly string[]): string[] {
  if (typed.trimStart().startsWith('[')) return [];
  const parts = typed.split(',');
  const before = parts
    .slice(0, -1)
    .map((p) => p.trim())
    .filter(Boolean);
  const last = (parts.at(-1) ?? '').trim();
  const used = new Set([...before, last]);
  const head = before.length ? `${before.join(', ')}, ` : '';
  const free = names.filter((n) => !used.has(n));
  if (!last) return free.map((n) => `${head}${n}`);
  const out = names
    .filter((n) => n !== last && n.toLowerCase().includes(last.toLowerCase()))
    .filter((n) => !before.includes(n))
    .map((n) => `${head}${n}`);
  if (names.includes(last) || !out.length) out.push(...free.map((n) => `${head}${last}, ${n}`));
  return [...new Set(out)];
}

/** AFS-99: a name added to or taken out of a comma-separated list. */
export function toggleName(typed: string, name: string): string {
  const names = listNames(typed);
  return (names.includes(name) ? names.filter((n) => n !== name) : [...names, name]).join(', ');
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
  counts,
  warning,
}: {
  field: LaunchField;
  value: string;
  problem?: string;
  onChange: (text: string) => void;
  /** AFS-147: how many hosts each group holds, for its chip. */
  counts?: Record<string, { count: number }>;
  /** AFS-147: what the inventory says of the typed targets, before Launch. */
  warning?: ReactNode;
  /**
   * AFS-97/99: the inventory's groups for a host list, as the canvas's dialog offers them: a button
   * each under the field (adds or takes out the group) and suggestions while typing.
   */
  groups?: string[] | 'reading';
}) {
  const listId = useId();
  const known = field.targets && Array.isArray(groups) ? groups : [];
  const suggest = known.length ? listSuggestions(value, known) : [];
  const chosen = new Set(listNames(value));
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
              required={field.required}
              {...(suggest.length ? { list: listId } : {})}
            />
            {suggest.length > 0 && <Suggestions id={listId} values={suggest} />}
            {/* AFS-138: the groups come a moment after the form: their row keeps its height from
                the start, so Launch does not move under the pointer. */}
            {field.targets && groups !== undefined && (
              <div className="group-slot">
                {groups === 'reading' ? (
                  <small className="muted">Reading the inventory's groups…</small>
                ) : known.length > 0 ? (
                  <fieldset className="name-chips" aria-label={`Groups for ${field.name}`}>
                    {/* AFS-147: what the chips are, and how many hosts each adds. */}
                    <small className="muted">Groups in the inventory:</small>
                    {known.map((g) => {
                      const count = counts?.[g]?.count;
                      return (
                        <button
                          key={g}
                          type="button"
                          className={`chip${chosen.has(g) ? ' on' : ''}`}
                          aria-pressed={chosen.has(g)}
                          title={
                            count === undefined
                              ? undefined
                              : `${chosen.has(g) ? 'Take out' : 'Add'} the group ${g}: ${count} ${count === 1 ? 'host' : 'hosts'}`
                          }
                          onClick={() => onChange(toggleName(value, g))}
                        >
                          {g}
                          {count !== undefined && <span className="muted"> · {count}</span>}
                        </button>
                      );
                    })}
                  </fieldset>
                ) : (
                  <small className="muted">No groups to pick from the inventory.</small>
                )}
              </div>
            )}
            {warning}
          </>
        )
      }
    </Labelled>
  );
}

/** AFS-147: the key of the targets and the limit as typed: what a reading of the inventory is of. */
function targetsKey(
  fields: readonly LaunchField[],
  texts: Record<string, string>,
  limit: string,
): string {
  return JSON.stringify([
    fields.filter((f) => f.targets).map((f) => (texts[f.name] ?? f.text).trim()),
    limit.trim(),
  ]);
}

/**
 * AFS-147: what the inventory says of the targets typed, at their field: those it does not have,
 * or that they match no host at all.
 */
function TargetsWarning({ reply }: { reply: FactsReply }) {
  const facts = reply.facts;
  if (facts?.unknown.length)
    return (
      <small className="warn-text" data-unknown-hosts role="status">
        Not in the inventory{reply.inventory ? ` ${reply.inventory}` : ''}, so nothing runs there:{' '}
        {facts.unknown.join(', ')}
        {facts.count === 0 ? '. No host would run.' : ''}
      </small>
    );
  if (facts && facts.count === 0)
    return (
      <small className="warn-text" data-unknown-hosts role="status">
        These targets match no host in the inventory{reply.inventory ? ` ${reply.inventory}` : ''}:
        no host would run.
      </small>
    );
  if (!facts && reply.factsError && !reply.field)
    return (
      <small className="warn-text" data-unknown-hosts role="status">
        {reply.factsError}
      </small>
    );
  return null;
}

/** AFS-147: what the limit leaves of the targets' hosts, at the Limit field. */
function LimitWarning({ limited }: { limited: NonNullable<FactsReply['limited']> }) {
  return limited.count === 0 ? (
    <p className="error-text small" data-limit-hosts role="status">
      The limit <code>{limited.pattern}</code> leaves none of the targets' hosts: the run would stop
      at once.
    </p>
  ) : (
    <p className="muted small" data-limit-hosts>
      The limit leaves {limited.count} {limited.count === 1 ? 'host' : 'hosts'}:{' '}
      {limited.hosts.slice(0, 10).join(', ')}
      {limited.count > 10 ? ', …' : ''}
    </p>
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
        <>
          <ul className="plain" data-facts>
            {/* The first line says "not check mode": the mode is said above. */}
            {realRunLines(hosts.facts)
              .slice(1)
              .map((l) => (
                <li key={l}>{l}</li>
              ))}
          </ul>
          {hosts.facts.unknown.length > 0 && (
            <p className="warn-text" data-unknown-hosts>
              Not in the inventory, so nothing runs there: {hosts.facts.unknown.join(', ')}
            </p>
          )}
          {hosts.limited &&
            (hosts.limited.count === 0 ? (
              <p className="error-text" data-limit-hosts>
                The limit <code>{hosts.limited.pattern}</code> leaves none of these hosts: the run
                would stop at once.
              </p>
            ) : (
              <p data-limit-hosts>
                The limit <code>{hosts.limited.pattern}</code> leaves {hosts.limited.count} of them:{' '}
                {hosts.limited.hosts.slice(0, 10).join(', ')}
                {hosts.limited.count > 10 ? ', …' : ''}
              </p>
            ))}
        </>
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
  names,
}: {
  launch: PreparedLaunch;
  form: LaunchForm;
  hosts?: HostsState;
  /** AFS-147: the credentials by name. */
  names?: string[];
}) {
  const shown = Object.entries(launch.inputs);
  // AFS-140: the answer comes below the form: it is brought into view.
  const place = useReveal<HTMLElement>(launch, false);
  return (
    <section ref={place} className="panel ok-panel" aria-labelledby="would-run" aria-live="polite">
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
        <dd>{launch.credentials.length ? (names ?? launch.credentials).join(', ') : 'none'}</dd>
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

/**
 * AFS-147: a configuration's environment by name, and what a launch gets from it now: its image,
 * or why there is none.
 */
function EnvironmentWords({ config: c, workspace }: { config: LaunchConfig; workspace: string }) {
  if (!c.environment) return null;
  const info = c.environmentInfo;
  return (
    <>
      <Link to={environmentAddress(workspace, c.environment)}>
        {info ? `environment ${info.name}` : 'its environment'}
      </Link>
      {info?.why ? (
        <span className="bad-text"> · {info.why}</span>
      ) : info?.image ? (
        <>
          {' '}
          · <code>{info.image}</code>
        </>
      ) : null}
    </>
  );
}

/** Whom a configuration's runs tell, and when. */
const notifyWords = (notify: NonNullable<LaunchConfig['notify']>) =>
  `${notify.to.join(', ')}, ${notify.when === 'failed' ? 'when a run fails' : 'whenever a run ends'}`;

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
  const flowNames = useFlowNames(project.id);
  return (
    <dl className="facts">
      <dt>Flow</dt>
      <dd>
        <FlowLabel file={c.flowFile} names={flowNames} />
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
            <EnvironmentWords config={c} workspace={workspace} />
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
      <dd>{(c.credentialNames ?? c.credentials).join(', ') || 'none'}</dd>
      <dt>Tells</dt>
      <dd>{c.notify ? notifyWords(c.notify) : 'nobody'}</dd>
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
    if (
      !(await ask(`Delete the launch configuration "${config.name}"? Its runs stay.`, {
        danger: true,
      }))
    )
      return;
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
    <section className="panel danger-zone" aria-labelledby="delete-config">
      <h2 id="delete-config">Delete the launch configuration</h2>
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
  const flowNames = useFlowNames(project.data?.id);
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
  // AFS-152: asked for once the configuration is there, so one not there is asked for once.
  const form = useLoad(
    async () =>
      config.data
        ? api.launchForm(id, {
            ...(mode ? { mode } : {}),
            ...(at.ref ? { ref: at.ref } : {}),
            ...(at.commit ? { commit: at.commit } : {}),
          })
        : undefined,
    [id, mode, at.ref, at.commit, !!config.data],
  );
  const [texts, setTexts] = useState<Record<string, string>>({});
  /** AFS-150: the inputs typed into (not a text the form changed by itself, on a new mode). */
  const [typed, setTyped] = useState<ReadonlySet<string>>(new Set());
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
  /**
   * AFS-97/99: the inventory's groups for host lists, read once when the Launch tab shows a host
   * list, as the canvas's dialog reads them when it opens. Reading starts a container in the
   * launch's image, so only for who may launch.
   */
  const [groups, setGroups] = useState<string[] | 'reading'>();
  const [groupCounts, setGroupCounts] = useState<Record<string, { count: number }>>();
  /**
   * AFS-147: what the inventory says of the targets and the limit as typed now (read again a moment
   * after they change), so a target it does not have is said at its field before Launch.
   */
  const [live, setLive] = useState<{ key: string; reply: FactsReply }>();
  const configId = config.data?.id;
  const flowFile = config.data?.flowFile;
  const formFields = form.data?.fields;
  const formLimit = form.data?.limit ?? '';
  const mayRead =
    !!flowFile && (me.admin || (!!access && atLeast(flowLevel(access, flowFile), 'operator')));
  useEffect(() => {
    if (
      (tab && tab !== 'launch') ||
      groups ||
      !configId ||
      !mayRead ||
      !formFields?.some((f) => f.targets)
    )
      return;
    setGroups('reading');
    const start = Object.fromEntries(
      formFields.filter((f) => !f.secret).map((f) => [f.name, f.text]),
    );
    api
      .launchFacts(configId, {
        ...(mode ? { mode } : {}),
        inputs: start,
        groups: true,
      } as LaunchRequest)
      .then(
        (r) => {
          setGroups(r.groups ?? []);
          if (r.groupHosts) setGroupCounts(r.groupHosts);
          // The start values' targets and the configuration's limit: what the form shows first.
          setLive({ key: targetsKey(formFields, start, formLimit), reply: r });
        },
        () => setGroups([]),
      );
  }, [tab, groups, configId, mayRead, formFields, mode, formLimit]);
  const typedLimit = limit ?? formLimit;
  const typedKey = formFields ? targetsKey(formFields, texts, typedLimit) : '';
  const hasTargets = !!formFields?.some((f) => f.targets);
  const liveKey = live?.key;
  useEffect(() => {
    if ((tab && tab !== 'launch') || !configId || !mayRead || !hasTargets || !formFields) return;
    if (groups === 'reading' || typedKey === liveKey) return;
    const timer = setTimeout(() => {
      const inputs = Object.fromEntries(
        formFields.filter((f) => !f.secret).map((f) => [f.name, texts[f.name] ?? f.text]),
      );
      api
        .launchFacts(configId, {
          ...(mode ? { mode } : {}),
          inputs,
          ...(limit !== undefined ? { limit: limit.trim() } : {}),
        })
        .then(
          (reply) => setLive({ key: typedKey, reply }),
          () => undefined,
        );
    }, 700);
    return () => clearTimeout(timer);
  }, [
    tab,
    configId,
    mayRead,
    hasTargets,
    formFields,
    groups,
    typedKey,
    liveKey,
    texts,
    limit,
    mode,
  ]);
  // AFS-150: typing not launched or kept (an input, a branch, a commit, a limit) asks before the
  // page is left; the other tabs of the configuration keep it, so going to them does not ask.
  const release = useUnsaved(
    !!formFields?.some((f) => typed.has(f.name) && (texts[f.name] ?? f.text) !== f.text) ||
      ref.trim() !== '' ||
      commit.trim() !== '' ||
      (limit !== undefined && limit.trim() !== formLimit),
    launchAddress(workspace, key, id),
  );

  const c = config.data;
  // AFS-152: a project or a configuration not there (or not shared): what was looked for, with a
  // way back to a page the person can open.
  if (!project.loading && !project.data)
    return <MissingProject workspace={workspace} project={key} error={project.error} />;
  if (config.error && project.data)
    return <MissingConfig workspace={workspace} project={project.data} id={id} />;
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
  const formErrors =
    form.failure instanceof ApiError
      ? form.failure.details.problems?.find((p) => p.errors?.length)?.errors
      : undefined;
  const flowErrors = problems.find((p) => p.errors?.length)?.errors;
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
  // AFS-140: a problem goes once the field it is about is changed.
  const settle = (field: string) =>
    setProblems((before) =>
      before.some((p) => p.field === field) ? before.filter((p) => p.field !== field) : before,
    );
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
    // AFS-134: a real run changes the hosts: asked first, with what it runs and where.
    const real = (mode ?? form.data?.mode ?? c.mode) === 'real';
    const unknown = liveNow?.facts?.unknown ?? [];
    const skipped = unknown.length
      ? ` Not in the inventory, so nothing runs there: ${unknown.join(', ')}.`
      : '';
    if (real) {
      const where = limitText.trim() ? ` limited to ${limitText.trim()}` : '';
      if (
        !(await ask(
          `Run ${form.data?.flow.name ?? c.name} for real${where}? It changes the hosts it reaches.${skipped}`,
          { yes: 'Run for real' },
        ))
      )
        return;
    } else if (skipped && !(await ask(`Launch the check run?${skipped}`, { yes: 'Launch' })))
      return;
    start('launch');
    try {
      const run = await api.launch(c.id, request());
      release();
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
      // The kept values are the form's start values now: no longer unsaved.
      form.reload();
      setTyped(
        (names) => new Set([...names].filter((n) => fields.some((f) => f.name === n && f.secret))),
      );
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
  // AFS-147: only what the inventory said of the targets as they are typed now.
  const liveNow = live && live.key === typedKey ? live.reply : undefined;
  // The fold opens by itself when something in it has a value, and always when the server points
  // at one of its fields.
  const foldOpen =
    ['ref', 'commit', 'limit'].some((f) => problemOf(f)) ||
    liveNow?.limited?.count === 0 ||
    (folded ?? !!(ref || commit || limitText));

  return (
    <>
      <Crumbs workspace={workspace} project={key} last={c.name} />
      <PageHead help="launch-configurations.md" title={c.name} lead={c.description} />
      {/* What it runs with, in a line: all of it is on the Settings tab. */}
      <p className="statusline">
        <span>
          Flow{' '}
          <Link to={flowAddress(workspace, key, c.flowFile)}>
            <FlowLabel file={c.flowFile} names={flowNames} />
          </Link>
        </span>
        <span>
          {c.commit ? 'pinned to ' : ''}
          <Takes config={c} project={project.data} />
        </span>
        <span>inventory {c.inventory ? <code>{c.inventory}</code> : 'as ansible.cfg names'}</span>
        <span>
          {c.environment ? (
            <EnvironmentWords config={c} workspace={workspace} />
          ) : c.eeImage ? (
            <>
              image <code>{c.eeImage}</code>
            </>
          ) : (
            "the server's default image"
          )}
        </span>
        {/* AFS-147: the limit and the credentials by name, as What ran says them. */}
        {c.limit && (
          <span>
            limit <code>{c.limit}</code>
          </span>
        )}
        <span>
          {!c.credentials.length
            ? 'no credentials'
            : c.credentialNames?.length
              ? `${c.credentials.length === 1 ? 'credential' : 'credentials'} ${c.credentialNames.join(', ')}`
              : `${c.credentials.length} ${c.credentials.length === 1 ? 'credential' : 'credentials'}`}
        </span>
        {/* AFS-169: whom its runs tell, as the Settings tab says it. */}
        {c.notify && <span>tells {notifyWords(c.notify)}</span>}
      </p>
      {c.flowGone && (
        <p className="notice warn" role="status">
          {c.flowGone}: it cannot be launched until the flow is back, or the configuration is
          pointed at another flow.
        </p>
      )}
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
        <SchedulesSection
          config={c.id}
          form={form.data}
          takes={{
            ...(c.commit ? { pinned: c.commit } : {}),
            branch: c.gitRef ?? project.data.gitRef,
          }}
          mayManage={mayManage}
          me={me}
          flowTo={flowAddress(workspace, key, c.flowFile)}
        />
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
              {/* AFS-164: a flow with errors: which, each a link to its step. */}
              {formErrors ? (
                <FlowErrorsNote
                  errors={formErrors}
                  to={flowAddress(workspace, key, c.flowFile)}
                  edit={mayManage}
                />
              ) : (
                <Loading state={form} />
              )}
              {fields.length === 0 && form.data && (
                <p className="muted">The flow takes no inputs.</p>
              )}
              {fields.map((f) => (
                <InputField
                  key={f.name}
                  field={f}
                  value={texts[f.name] ?? f.text}
                  problem={problemOf(f.name)}
                  onChange={(text) => {
                    setTexts((t) => ({ ...t, [f.name]: text }));
                    setTyped((names) => (names.has(f.name) ? names : new Set([...names, f.name])));
                    settle(f.name);
                  }}
                  groups={groups}
                  {...(groupCounts ? { counts: groupCounts } : {})}
                  {...(f.targets && liveNow ? { warning: <TargetsWarning reply={liveNow} /> } : {})}
                />
              ))}
              {/* Rarely typed, so folded; AFS-138: above Mode and the buttons, so a limit is seen before
                  Launch. */}
              <Fold
                summary="Another branch or commit, a limit"
                open={foldOpen}
                onToggle={setFolded}
              >
                <div className="pair">
                  <Labelled
                    label="Branch"
                    // AFS-152: a field that cannot be typed in says why.
                    hint={
                      mayManage
                        ? `Empty: ${c.commit ? 'the pinned commit' : (c.gitRef ?? project.data.gitRef)}`
                        : `${c.commit ? 'The pinned commit' : (c.gitRef ?? project.data.gitRef)}: another branch needs read and write access to this flow`
                    }
                    problem={problemOf('ref')}
                  >
                    {(props) => (
                      <input
                        {...props}
                        list="branches"
                        value={ref}
                        onChange={(e) => {
                          setRef(e.target.value);
                          settle('ref');
                        }}
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
                  <Labelled
                    label="Or a commit"
                    hint={
                      mayManage
                        ? 'As shown here (12 digits) or in full'
                        : 'Another commit needs read and write access to this flow'
                    }
                    problem={problemOf('commit')}
                  >
                    {(props) => (
                      <input
                        {...props}
                        value={commit}
                        onChange={(e) => {
                          setCommit(e.target.value);
                          settle('commit');
                        }}
                        onBlur={reread}
                        disabled={!mayManage}
                        pattern={COMMIT_PATTERN}
                        title={COMMIT_TITLE}
                        spellCheck={false}
                      />
                    )}
                  </Labelled>
                </div>
                {mayLaunch && !mayManage && (
                  <p className="muted">
                    You launch what the configuration names: another branch or commit needs read and
                    write access.
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
                      onChange={(e) => {
                        setLimit(e.target.value);
                        settle('limit');
                      }}
                      spellCheck={false}
                    />
                  )}
                </Labelled>
                {liveNow?.limited && <LimitWarning limited={liveNow.limited} />}
              </Fold>
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
                    {/* AFS-143: one name, "check run", and both modes said in a few words. */}
                    {m === 'check'
                      ? 'Check: nothing is changed, approvals pass by themselves'
                      : 'Real: the hosts are changed, approvals wait for a decision'}
                  </label>
                ))}
              </fieldset>
              {error &&
                (flowErrors ? (
                  <FlowErrorsNote
                    id="launch-error"
                    errors={flowErrors}
                    to={flowAddress(workspace, key, c.flowFile)}
                    edit={mayManage}
                  />
                ) : (
                  <p className="notice error" role="alert" id="launch-error">
                    {error}
                  </p>
                ))}
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
              {/* AFS-94: Launch is first and the only filled button; Enter in a field still asks
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
                  // AFS-102: it changes the configuration: a button, not a link.
                  <button type="button" onClick={() => void keep()} disabled={!!busy || !form.data}>
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
            </form>
          </section>
          {result && (
            <WouldRun
              launch={result.launch}
              form={result.form}
              hosts={hosts}
              {...(c.credentialNames ? { names: c.credentialNames } : {})}
            />
          )}
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
  const [problem, setProblem] = useState<{
    field?: string;
    message: string;
    errors?: FlowError[];
  }>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // AFS-150: what the form holds now against what was saved (or first shown): leaving with a
  // difference asks first, on the Settings tab of a configuration as on a new one.
  const holds = JSON.stringify([input, tellWhen, tellTo]);
  const [kept, setKept] = useState(holds);
  const release = useUnsaved(holds !== kept);
  // AFS-94: the image is asked for only when "an image by name" is what runs get.
  const [byImage, setByImage] = useState(!existing?.environment && !!existing?.eeImage);
  const set = (key: keyof LaunchConfigInput, value: unknown) => {
    setSaved(false);
    setInput((i) => ({ ...i, [key]: value }));
    // AFS-140: a refusal goes once what it is about is changed.
    setProblem((p) => (p && (!p.field || p.field === key) ? undefined : p));
  };
  const at = (field: string) => (problem?.field === field ? problem.message : undefined);
  // AFS-140: a refusal is brought into view: the field it is about, or its notice.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!problem) return;
    const shown = formRef.current?.querySelector<HTMLElement>('.field.invalid, .notice.error');
    reveal(shown, shown?.querySelector<HTMLElement>('input, select, textarea'));
  }, [problem]);

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
      setKept(holds);
      release();
      onSaved(done);
    } catch (e) {
      setProblem({
        ...(e instanceof ApiError && e.details.field ? { field: e.details.field } : {}),
        ...(e instanceof ApiError && e.details.errors?.length ? { errors: e.details.errors } : {}),
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

  // AFS-140: a configuration runs a flow: with none to choose, the form says why instead.
  if (!existing && flows.data?.length === 0 && !input.flowFile)
    return (
      <div className="notice" role="status">
        <p>
          {project.sync.state === 'error'
            ? `The project's source cannot be read, so there is no flow to choose: ${project.sync.error ?? ''}`
            : project.commit
              ? 'The project has no flow yet: a launch configuration runs a flow (a file named *.flow.yaml).'
              : 'The project has no commit yet, so no flow to run.'}
        </p>
        <p>
          <Link to={base(workspace, project.key)}>
            {project.sync.state === 'error'
              ? 'Back to the project'
              : 'Make a flow on the project page'}
          </Link>
          {project.sync.state === 'error' && (
            <>
              {' · '}
              <Link to={`${base(workspace, project.key)}/settings`}>
                Check its source in Settings
              </Link>
            </>
          )}
        </p>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    );
  return (
    <form className="form wide" onSubmit={save} ref={formRef}>
      {/* AFS-94: fields that belong together share a row; what is chosen first comes first. */}
      <div className="pair">
        <Labelled label="Name" problem={at('name')} hint={limitNote(input.name, 100)}>
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
      {/* AFS-164: the flow's errors, each a link to its step, opened for editing. */}
      {problem?.field === 'flowFile' && problem.errors?.length ? (
        <FlowErrorsNote
          errors={problem.errors}
          to={flowAddress(workspace, project.key, input.flowFile)}
          edit
          quiet
        />
      ) : null}
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
          hint="Always this commit, as shown here (12 digits) or in full; empty: the newest of the branch."
          problem={at('commit')}
        >
          {(props) => (
            <input
              {...props}
              value={input.commit ?? ''}
              onChange={(e) => set('commit', e.target.value)}
              pattern={COMMIT_PATTERN}
              title={COMMIT_TITLE}
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
                  {/* AFS-153: an image is pulled, a definition is built. */}
                  {e.current ? '' : e.kind === 'spec' ? ' (not built yet)' : ' (not pulled yet)'}
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
            {/* AFS-154: the name and its kind wrap as one text beside the box. */}
            <span>
              {k.name}{' '}
              <span className="muted">· {KIND_LABEL[k.kind as CredentialKind] ?? k.kind}</span>
            </span>
          </label>
        ))}
        <small id="credentials-hint" className="muted">
          At most one SSH key, one login and password, and one become password.
        </small>
        {at('credentials') && <small className="bad-text">{at('credentials')}</small>}
      </fieldset>
      <div className="pair">
        <Labelled label="Notify when">
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
          label="Recipients"
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
  const access = useProjectAccess(project.data?.id);
  const fromCanvas = canvasFlow();
  const title = id
    ? `Change ${existing.data?.name ?? 'launch configuration'}`
    : 'Add a launch configuration';

  if (!project.loading && !project.data)
    return <MissingProject workspace={workspace} project={key} error={project.error} />;
  if (id && existing.error && project.data)
    return <MissingConfig workspace={workspace} project={project.data} id={id} />;
  if (!project.data || (id && !existing.data) || (!access.data && !access.error))
    return (
      <>
        <Crumbs workspace={workspace} project={key} last={title} />
        <PageHead title={title} />
        <Loading state={existing.error ? existing : project} />
      </>
    );

  // AFS-150: a configuration is added or changed with rw on its flow. Who has rw on none of the
  // project's flows (or not on this one) is told so, not given a form refused only at Add.
  // Access that cannot be read leaves it to the server, which refuses what it must.
  const a = access.data;
  const mayManage =
    !a ||
    (existing.data
      ? atLeast(flowLevel(a, existing.data.flowFile), 'rw')
      : a.admin ||
        atLeast(a.workspace, 'rw') ||
        Object.values(a.flows).some((level) => atLeast(level, 'rw')));
  if (!mayManage)
    return (
      <>
        <Crumbs workspace={workspace} project={key} last={title} />
        <PageHead help="launch-configurations.md" title={title} />
        <section className="panel">
          <p className="notice" role="status">
            {existing.data
              ? 'Changing this launch configuration needs rw on its flow.'
              : "Adding a launch configuration needs rw on the flow it runs, and you have rw on none of this project's flows."}
          </p>
          <p>
            <Link to={id ? launchAddress(workspace, key, id) : base(workspace, key)}>
              {id ? 'Back to the launch configuration' : 'Back to the project'}
            </Link>
          </p>
        </section>
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
        help="launch-configurations.md"
        title={title}
        // AFS-147: what saving checks, as it is: the hosts and an environment still building are
        // checked at launch, where the form says what stands in the way.
        lead="Saved when its flow, inventory and credentials are there. The hosts it reaches and its environment's image are checked at launch. Secret inputs are never kept: they are typed at launch."
      />
      <section className="panel">
        <ConfigForm
          key={id ?? 'new'}
          workspace={workspace}
          project={project.data}
          {...(existing.data ? { existing: existing.data } : {})}
          // AFS-149: opened from the canvas's Run (`back=flow`): back to the flow, where Run now
          // offers the new configuration with its inputs.
          onSaved={(saved) =>
            navigate(
              fromCanvas && !id
                ? flowPage(workspace, key, fromCanvas)
                : launchAddress(workspace, key, saved.id),
            )
          }
          onCancel={() =>
            navigate(
              fromCanvas && !id
                ? flowPage(workspace, key, fromCanvas)
                : id
                  ? launchAddress(workspace, key, id)
                  : base(workspace, key),
            )
          }
        />
      </section>
    </>
  );
}

/** How many of a flow's errors are listed before "and N more" (AFS-164). */
const LISTED = 5;

/**
 * AFS-164: the errors that stop a flow from running, each a link to its step on the flow's page:
 * opened for editing for who may edit it, else shown. `quiet`: the list only (the field above it
 * says how many there are).
 */
export function FlowErrorsNote({
  id,
  errors,
  to,
  edit,
  quiet,
}: {
  id?: string;
  errors: FlowError[];
  to: string;
  edit: boolean;
  quiet?: boolean;
}) {
  const at = (node?: string) => {
    const query = new URLSearchParams();
    if (node) query.set('step', node);
    if (edit) query.set('edit', '1');
    const text = query.toString();
    return text ? `${to}?${text}` : to;
  };
  const shown = errors.slice(0, LISTED);
  const list = (
    <ul className="plain flow-errors">
      {shown.map((e, i) => (
        // Two errors may be alike (same step, same words): the place in the list tells them apart.
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, read once
        <li key={i}>
          <Link to={at(e.node)}>{e.step ?? 'The flow'}</Link>: {e.message}
        </li>
      ))}
      {errors.length > shown.length && (
        <li>
          <Link to={at()}>and {errors.length - shown.length} more</Link>
        </li>
      )}
    </ul>
  );
  if (quiet) return list;
  return (
    <div className="notice error flow-errors-note" role="alert" id={id}>
      <p>{errorsLead(errors.length)}:</p>
      {list}
    </div>
  );
}
