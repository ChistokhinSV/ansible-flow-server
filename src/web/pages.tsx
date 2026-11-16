// The pages. Each reads what it shows from the API when it opens; what only administrators may
// do is shown only to them (the server decides either way).

import { useEffect, useState } from 'react';
import { useProjectAccess, WorkspaceAccess } from './access';
import {
  api,
  type Branch,
  type FlowChanges,
  type FlowList,
  type FlowSummary,
  type Project,
  type User,
} from './api';
import { GitCredentialChoice, needsSignIn, WorkspaceCredentials } from './credentials';
import { WorkspaceEnvironments } from './environments';
import { NewFlowForm } from './flowFiles';
import { LaunchConfigsSection } from './launch';
import { Link, navigate } from './router';
import { RunList, RunWords } from './runs';
import {
  Breadcrumb,
  Copyable,
  Field,
  Form,
  Loading,
  messageOf,
  PageHead,
  Tabs,
  Time,
  useLoad,
} from './ui';

// --- workspaces

export function Workspaces({ me }: { me: User }) {
  const list = useLoad(api.workspaces, []);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState({ key: '', name: '' });
  return (
    <>
      <PageHead title="Workspaces" lead="A workspace is a team's space: its projects live in it.">
        {me.admin && !adding && (
          <button type="button" className="primary" onClick={() => setAdding(true)}>
            Add workspace
          </button>
        )}
      </PageHead>
      {adding && (
        <section className="panel sheet" aria-label="Add workspace">
          <Form
            submit="Add"
            onCancel={() => setAdding(false)}
            onSubmit={async () => {
              const made = await api.addWorkspace(input);
              navigate(`/w/${made.key}`);
            }}
          >
            <Field
              label="Name"
              value={input.name}
              onChange={(e) => setInput({ ...input, name: e.target.value })}
              required
              autoFocus
            />
            <Field
              label="Key"
              value={input.key}
              onChange={(e) => setInput({ ...input, key: e.target.value })}
              required
              pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
              hint="Used in addresses: lower-case letters, digits and dashes."
            />
          </Form>
        </section>
      )}
      <Loading state={list} />
      {list.data?.length === 0 && (
        <p className="empty">
          No workspace yet.{' '}
          {me.admin ? 'Add the first one.' : 'An administrator makes the first one.'}
        </p>
      )}
      <ul className="cards">
        {list.data?.map((w) => (
          <li key={w.id}>
            <Link to={`/w/${w.key}`} className="card">
              <strong>{w.name}</strong>
              <span className="muted">
                {w.key} · {w.projects} {w.projects === 1 ? 'project' : 'projects'}
              </span>
              {w.description && <span>{w.description}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

/** What a project's last look at its source found, in a word and a colour. */
function SyncBadge({ project }: { project: Project }) {
  const { state, error } = project.sync;
  if (state === 'ok') return <span className="badge ok">up to date</span>;
  if (state === 'error')
    return (
      <span className="badge bad" title={error}>
        cannot be read
      </span>
    );
  return <span className="badge">{project.hosted ? 'empty' : 'not read yet'}</span>;
}

/**
 * AFS-84: the project's state in one line; what it is set up with is on Settings. It is on every
 * tab of the project, Files too (AFS-94), so the tabs stay where they are.
 */
export function ProjectStatus({ project, me, base }: { project: Project; me: User; base: string }) {
  return (
    <p className="statusline">
      <SyncBadge project={project} />
      <span>
        runs <code>{project.gitRef}</code>
      </span>
      <span>
        {project.commit ? (
          <>
            at <code>{project.commit.slice(0, 12)}</code>
          </>
        ) : (
          'no commit yet'
        )}
      </span>
      {project.sync.at && (
        <span className="muted">
          looked at <Time at={project.sync.at} />
        </span>
      )}
      {project.library && <span className="badge">library</span>}
      {project.sync.error && (
        <span className="bad-text">
          {project.sync.error}
          {needsSignIn(project.sync.error) && (
            <>
              {' '}
              The repository asks for a sign-in
              {me.admin ? (
                <>
                  : <Link to={`${base}/settings`}>choose what the project signs in with</Link>.
                </>
              ) : (
                '.'
              )}
            </>
          )}
        </span>
      )}
    </p>
  );
}

/** AFS-58: why the archive a project was made with was refused, for its page to say. */
let startRefusal: string | undefined;

/** AFS-58: what an empty hosted project starts with: a sample, or an archive of files. */
function StartChoice({
  value,
  onChange,
  empty = true,
}: {
  /** Offer starting with nothing (when making a project). */
  empty?: boolean;
  value: { from: 'empty' | 'sample' | 'archive'; sample: string; archive?: File };
  onChange(v: { from: 'empty' | 'sample' | 'archive'; sample: string; archive?: File }): void;
}) {
  const samples = useLoad(() => api.samples(), []);
  const chosen = samples.data?.find((s) => s.key === value.sample);
  // The first sample is chosen until another is: also when the list comes after the choice.
  const first = samples.data?.[0]?.key;
  useEffect(() => {
    if (value.from === 'sample' && !value.sample && first) onChange({ ...value, sample: first });
  }, [value, first, onChange]);
  return (
    <fieldset>
      <legend>Start with</legend>
      {empty && (
        <label className="choice">
          <input
            type="radio"
            name="start"
            checked={value.from === 'empty'}
            onChange={() => onChange({ ...value, from: 'empty' })}
          />
          Nothing: the first push makes the branch
        </label>
      )}
      <label className="choice">
        <input
          type="radio"
          name="start"
          checked={value.from === 'sample'}
          onChange={() =>
            onChange({
              ...value,
              from: 'sample',
              sample: value.sample || samples.data?.[0]?.key || '',
            })
          }
        />
        A sample project
      </label>
      {value.from === 'sample' && (
        <div className="field">
          <label htmlFor="start-sample">Sample</label>
          <select
            id="start-sample"
            value={value.sample}
            onChange={(e) => onChange({ ...value, sample: e.target.value })}
          >
            {samples.data?.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>
          {chosen && <small className="muted">{chosen.description}</small>}
        </div>
      )}
      <label className="choice">
        <input
          type="radio"
          name="start"
          checked={value.from === 'archive'}
          onChange={() => onChange({ ...value, from: 'archive' })}
        />
        An archive of files (zip or tar.gz)
      </label>
      {value.from === 'archive' && (
        <div className="field">
          <label htmlFor="start-archive">Archive</label>
          <input
            id="start-archive"
            type="file"
            accept=".zip,.tar.gz,.tgz,application/zip,application/gzip"
            onChange={(e) => onChange({ ...value, archive: e.target.files?.[0] })}
          />
          <small className="muted">
            Committed as it is; one folder that holds everything is taken off.
          </small>
        </div>
      )}
    </fieldset>
  );
}

/** AFS-84: a workspace's tabs, by the end of their address. */
export type WorkspaceTab = '' | '-/environments' | '-/credentials' | '-/access';

export function Workspace({
  me,
  workspace,
  tab = '',
}: {
  me: User;
  workspace: string;
  tab?: WorkspaceTab;
}) {
  const space = useLoad(() => api.workspace(workspace), [workspace]);
  const projects = useLoad(() => api.projects(workspace), [workspace]);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState({
    key: '',
    name: '',
    gitUrl: '',
    hosted: true,
    gitCredential: '',
  });
  const [start, setStart] = useState<{
    from: 'empty' | 'sample' | 'archive';
    sample: string;
    archive?: File;
  }>({ from: 'empty', sample: '' });
  return (
    <>
      <Breadcrumb>
        <Link to="/workspaces">Workspaces</Link> / <span aria-current="page">{workspace}</span>
      </Breadcrumb>
      <PageHead title={space.data?.name ?? workspace} lead={space.data?.description}>
        {/* AFS-94: the head's action is the tab's own: the other tabs have theirs. */}
        {me.admin && space.data && !adding && tab === '' && (
          <button type="button" className="primary" onClick={() => setAdding(true)}>
            Add project
          </button>
        )}
      </PageHead>
      <Loading state={space.error ? space : projects} />
      {adding && tab === '' && (
        <section className="panel sheet" aria-label="Add project">
          <Form
            submit="Add"
            onCancel={() => setAdding(false)}
            onSubmit={async () => {
              const archive = input.hosted && start.from === 'archive' ? start.archive : undefined;
              if (input.hosted && start.from === 'archive' && !archive)
                throw new Error('Choose the archive to start with');
              const made = await api.addProject(workspace, {
                key: input.key,
                name: input.name,
                ...(input.hosted ? {} : { gitUrl: input.gitUrl }),
                ...(!input.hosted && signsIn(input.gitUrl) && input.gitCredential
                  ? { gitCredential: input.gitCredential }
                  : {}),
                ...(input.hosted && start.from === 'sample' && start.sample
                  ? { sample: start.sample }
                  : {}),
              });
              // The project is made either way; its page says if the archive was refused.
              if (archive)
                await api.startProject(made.id, archive).catch((e: Error) => {
                  startRefusal = e.message;
                });
              navigate(`/w/${workspace}/${made.key}`);
            }}
          >
            <Field
              label="Name"
              value={input.name}
              onChange={(e) => setInput({ ...input, name: e.target.value })}
              required
              autoFocus
            />
            <Field
              label="Key"
              value={input.key}
              onChange={(e) => setInput({ ...input, key: e.target.value })}
              required
              pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
              hint="Used in addresses: lower-case letters, digits and dashes."
            />
            <fieldset>
              <legend>Repository</legend>
              <label className="choice">
                <input
                  type="radio"
                  name="kind"
                  checked={input.hosted}
                  onChange={() => setInput({ ...input, hosted: true })}
                />
                Kept by this server
              </label>
              <label className="choice">
                <input
                  type="radio"
                  name="kind"
                  checked={!input.hosted}
                  onChange={() => setInput({ ...input, hosted: false })}
                />
                An existing repository
              </label>
            </fieldset>
            {input.hosted && <StartChoice value={start} onChange={setStart} />}
            {!input.hosted && (
              <Field
                label="Repository address"
                value={input.gitUrl}
                onChange={(e) => setInput({ ...input, gitUrl: e.target.value })}
                required
                placeholder="https://git.example.net/network/edge-flows.git"
                hint="https://, ssh:// or git@host:path. No password in the address."
              />
            )}
            {!input.hosted && signsIn(input.gitUrl) && (
              <GitCredentialChoice
                ssh={sshUrl(input.gitUrl)}
                workspace={workspace}
                value={input.gitCredential}
                onChange={(gitCredential) => setInput({ ...input, gitCredential })}
              />
            )}
          </Form>
        </section>
      )}
      {space.data && (
        <Tabs
          label="Workspace"
          base={`/w/${workspace}`}
          current={tab}
          tabs={[
            {
              key: '',
              label: 'Projects',
              ...(projects.data ? { count: projects.data.length } : {}),
            },
            { key: '-/environments', label: 'Execution environments' },
            { key: '-/credentials', label: 'Credentials' },
            // Grants are an administrator's: the others do not get the tab.
            ...(me.admin ? [{ key: '-/access', label: 'Access' }] : []),
          ]}
        />
      )}
      {tab === '' && (
        <>
          {projects.data?.length === 0 && (
            <p className="empty">No project in this workspace yet.</p>
          )}
          <ul className="cards">
            {projects.data?.map((p) => (
              <li key={p.id}>
                <Link to={`/w/${workspace}/${p.key}`} className="card">
                  <strong>{p.name}</strong>
                  <span className="muted">
                    {p.key} · {p.hosted ? 'kept by this server' : 'external repository'} ·{' '}
                    {p.gitRef}
                  </span>
                  <SyncBadge project={p} />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {space.data && tab === '-/environments' && (
        <WorkspaceEnvironments
          workspace={space.data.key}
          mayManage={space.data.level === 'admin' || space.data.level === 'rw'}
        />
      )}
      {space.data && tab === '-/credentials' && (
        <WorkspaceCredentials workspace={space.data.key} admin={me.admin} />
      )}
      {!me.admin && tab === '-/access' && (
        <p className="empty">
          Who can do what in this workspace is for administrators to see and change.
        </p>
      )}
      {me.admin && space.data && tab === '-/access' && (
        <>
          <WorkspaceAccess workspace={space.data.key} selfApprove={space.data.selfApprove} />
          <DeleteSection
            what="workspace"
            name={space.data.name}
            keyword={space.data.key}
            goes=" with its credentials and grants. A workspace that still has projects or execution environments is not deleted: delete them first"
            remove={() => api.deleteWorkspace(space.data?.id ?? workspace)}
            to="/workspaces"
          />
        </>
      )}
    </>
  );
}

/**
 * AFS-100: deleting something that takes more with it, for administrators. Says what goes, asks
 * for its key typed again, and shows the server's refusal as it words it.
 */
function DeleteSection({
  what,
  name,
  keyword,
  goes,
  remove,
  to,
}: {
  what: 'project' | 'workspace';
  name: string;
  keyword: string;
  goes: string;
  remove(): Promise<void>;
  to: string;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = `delete-${what}`;
  return (
    <section className="panel danger-zone" aria-labelledby={id}>
      <h2 id={id}>Delete the {what}</h2>
      <p>
        Deletes {what === 'project' ? 'the project' : 'the workspace'} <strong>{name}</strong>
        {goes}. It cannot be undone.
      </p>
      <form
        className="form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (typed.trim() !== keyword || busy) return;
          setBusy(true);
          setError(undefined);
          try {
            await remove();
            navigate(to);
          } catch (e) {
            setError(messageOf(e));
            setBusy(false);
          }
        }}
      >
        <Field
          label={`Type ${keyword} to confirm`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="submit" className="danger" disabled={typed.trim() !== keyword || busy}>
            {busy ? 'Deleting…' : `Delete the ${what}`}
          </button>
        </div>
      </form>
    </section>
  );
}

// --- a project

const https = (url?: string) => /^https:\/\//i.test(url?.trim() ?? '');
/** AFS-60: an ssh address (ssh:// or user@host:path). */
const sshUrl = (url?: string) =>
  /^ssh:\/\//i.test(url?.trim() ?? '') || /^[\w.-]+@[\w.-]+:[^/\\]/.test(url?.trim() ?? '');
/** A source that signs in: https with a token or login, ssh with a key. */
const signsIn = (url?: string) => https(url) || sshUrl(url);

/** AFS-60: the host key trusted for an ssh source; administrators accept a changed one. */
function HostKey({
  project,
  admin,
  onChanged,
}: {
  project: Project;
  admin: boolean;
  onChanged(): void;
}) {
  const key = useLoad(() => api.hostKey(project.id), [project.id, project.sync.at]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const changed = /SSH host key is not the one the server trusts/.test(project.sync.error ?? '');
  if (!key.data?.host) return null;
  return (
    <div className="field">
      <strong>SSH host key</strong> <code>{key.data.host}</code>
      {key.data.keys.length ? (
        <ul className="plain">
          {key.data.keys.map((k) => (
            <li key={k}>
              <code>{k}</code>
            </li>
          ))}
        </ul>
      ) : (
        <div className="muted">
          Not trusted yet: the next look at the source trusts the key it finds.
        </div>
      )}
      {changed && (
        <p className="notice error" role="alert">
          The host shows another key than the one trusted. That happens when the server was
          reinstalled, or when someone is in between.
          {admin
            ? ' Accept it only if you know why it changed.'
            : ' An administrator can accept it.'}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {admin && changed && (
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={async () => {
            if (
              !window.confirm(
                `Forget the trusted key of ${key.data?.host} and trust the key it shows now?`,
              )
            )
              return;
            setBusy(true);
            setError(undefined);
            try {
              await api.forgetHostKey(project.id);
              onChanged();
            } catch (e) {
              setError(messageOf(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Accept the new host key
        </button>
      )}
    </div>
  );
}

/** What an external project signs in to its https source with; saving looks at the source again. */
function SourceSignIn({
  project,
  workspace,
  onSaved,
}: {
  project: Project;
  workspace: string;
  onSaved(): void;
}) {
  const [value, setValue] = useState(project.gitCredential ?? '');
  const [saved, setSaved] = useState(false);
  return (
    <Form
      submit="Save and look at the source"
      onSubmit={async () => {
        setSaved(false);
        await api.changeProject(project.id, { gitCredential: value || null });
        setSaved(true);
        onSaved();
      }}
    >
      <GitCredentialChoice
        ssh={sshUrl(project.gitUrl)}
        workspace={workspace}
        value={value}
        onChange={(v) => {
          setValue(v);
          setSaved(false);
        }}
      />
      {saved && (
        <p className="notice ok" role="status">
          Saved.
        </p>
      )}
    </Form>
  );
}

const CHANGE_WORDS = { added: 'added', changed: 'changed', removed: 'removed' } as const;

/** AFS-75: the flows someone changed on the branch while the page was open. */
function FlowNews({ news, onDismiss }: { news: FlowChanges; onDismiss: () => void }) {
  return (
    <div className="notice" role="status">
      <p>Changed on the branch just now:</p>
      <ul>
        {news.flows.map((f) => (
          <li key={f.file}>
            <code>{f.file}</code> {CHANGE_WORDS[f.change]}
            {f.authors.length ? ` by ${f.authors.join(', ')}` : ''}
          </li>
        ))}
      </ul>
      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

/** AFS-58: an empty hosted project gets its first commit from a sample or an archive. */
function StartPanel({ project, onStarted }: { project: Project; onStarted(): void }) {
  const [start, setStart] = useState<{
    from: 'empty' | 'sample' | 'archive';
    sample: string;
    archive?: File;
  }>({ from: 'sample', sample: 'hello' });
  const [refused] = useState(() => {
    const said = startRefusal;
    startRefusal = undefined;
    return said;
  });
  return (
    <section className="panel" aria-labelledby="start">
      <h2 id="start">Start this project</h2>
      <p className="muted">
        The repository is empty. Give it a first commit from a sample or an archive of your files,
        or push one with git.
      </p>
      {refused && (
        <p className="notice error" role="alert">
          The archive was refused: {refused}
        </p>
      )}
      <Form
        submit="Start"
        onSubmit={async () => {
          if (start.from === 'archive') {
            if (!start.archive) throw new Error('Choose the archive to start with');
            await api.startProject(project.id, start.archive);
          } else if (start.from === 'sample')
            await api.startProject(project.id, { sample: start.sample });
          else return;
          onStarted();
        }}
      >
        <StartChoice value={start} onChange={setStart} empty={false} />
      </Form>
    </section>
  );
}

/**
 * AFS-59: the project's branches with their newest commit; who may push makes and deletes them,
 * administrators choose the one that runs.
 */
function BranchesPanel({
  project,
  branches,
  mayChange,
  admin,
  onChanged,
}: {
  project: Project;
  branches: Branch[];
  mayChange: boolean;
  admin: boolean;
  onChanged(): void;
}) {
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState({ name: '', from: project.gitRef });
  const [error, setError] = useState<string>();
  const remove = async (b: Branch) => {
    setError(undefined);
    const lost =
      b.ahead > 0
        ? ` It has ${b.ahead} commit${b.ahead === 1 ? '' : 's'} not on ${project.gitRef}${project.hosted ? ', which will be gone' : ''}.`
        : '';
    if (!window.confirm(`Delete the branch ${b.name}?${lost}`)) return;
    try {
      await api.deleteBranch(project.id, b.name, b.ahead > 0);
      onChanged();
    } catch (e) {
      setError(messageOf(e));
    }
  };
  const makeRun = async (b: Branch) => {
    setError(undefined);
    if (
      !window.confirm(
        `Make ${b.name} the project's branch? Launch configurations and schedules that follow the project's branch run its commits from now on.`,
      )
    )
      return;
    try {
      await api.changeProject(project.id, { gitRef: b.name });
      onChanged();
    } catch (e) {
      setError(messageOf(e));
    }
  };
  return (
    <section className="panel" aria-labelledby="branches">
      {/* AFS-102: the section's action at its head, as on the other pages. */}
      <div className="section-head">
        <h2 id="branches">Branches</h2>
        {mayChange && branches.length > 0 && !adding && (
          <button type="button" onClick={() => setAdding(true)}>
            New branch
          </button>
        )}
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {branches.length === 0 && <p className="muted">None yet.</p>}
      {branches.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Branch</th>
                <th scope="col">Newest commit</th>
                <th scope="col">Not on {project.gitRef}</th>
                {(mayChange || admin) && (
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {branches.map((b) => (
                <tr key={b.name}>
                  <td>
                    <code>{b.name}</code>
                    {b.project && (
                      <>
                        {' '}
                        <span className="badge ok">runs</span>
                      </>
                    )}
                    {b.configurations && (
                      <div className="muted">used by {b.configurations.join(', ')}</div>
                    )}
                  </td>
                  <td>
                    <code>{b.commit.slice(0, 8)}</code> {b.subject}
                    <div className="muted">
                      {b.author} · <Time at={b.at} />
                    </div>
                  </td>
                  <td>{b.project ? '' : b.ahead ? `${b.ahead}` : 'none'}</td>
                  {(mayChange || admin) && (
                    <td className="actions">
                      {admin && !b.project && (
                        <button type="button" onClick={() => void makeRun(b)}>
                          Make it the project's branch
                        </button>
                      )}
                      {mayChange && !b.project && !b.configurations && (
                        <button
                          type="button"
                          className="danger"
                          aria-label={`Delete ${b.name}`}
                          onClick={() => void remove(b)}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && (
        <Form
          submit="Make the branch"
          onCancel={() => setAdding(false)}
          onSubmit={async () => {
            await api.createBranch(project.id, {
              name: input.name.trim(),
              from: input.from.trim(),
            });
            setAdding(false);
            setInput({ name: '', from: project.gitRef });
            onChanged();
          }}
        >
          <Field
            label="Name"
            value={input.name}
            onChange={(e) => setInput({ ...input, name: e.target.value })}
            required
            autoFocus
            placeholder="feature/ntp-servers"
          />
          <Field
            label="From"
            value={input.from}
            onChange={(e) => setInput({ ...input, from: e.target.value })}
            required
            list="branch-names"
            hint="A branch, or a commit."
          />
          <datalist id="branch-names">
            {branches.map((b) => (
              <option key={b.name} value={b.name} />
            ))}
          </datalist>
        </Form>
      )}
    </section>
  );
}

/**
 * The push hook of a project with a source: the git host calls it when someone pushes, so the
 * server looks at the source at once. Its token is shown once; GitHub uses it as the hook's
 * secret and signs each call with it (AFS-61), GitLab and Gitea send it in a header.
 */
function PushHook({ project, onChanged }: { project: Project; onChanged(): void }) {
  const [made, setMade] = useState<{ token: string; url: string }>();
  const [error, setError] = useState<string>();
  const act = async (work: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await work();
      onChanged();
    } catch (e) {
      setError(messageOf(e));
    }
  };
  const address = made ? `${window.location.origin}${made.url}` : '';
  return (
    <section className="panel" aria-labelledby="push-hook">
      <h2 id="push-hook">Push hook</h2>
      <p className="muted">
        The git host calls it when someone pushes, and the server looks at the source at once
        instead of waiting for its timer.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!made && (
        <p>
          {project.hook
            ? project.hookSigned
              ? 'A hook is set up.'
              : 'A hook is set up, made before signed hooks: for GitHub, make a new one.'
            : 'No hook yet.'}
        </p>
      )}
      {made && (
        <div className="notice ok" role="status">
          <p>Set it up at the git host now: the token is not shown again.</p>
          <dl className="facts">
            <dt>Address</dt>
            <dd>
              <Copyable text={address} label="the hook's address" />
            </dd>
            <dt>Token</dt>
            <dd>
              <Copyable text={made.token} label="the hook's token" />
            </dd>
          </dl>
          <ul>
            <li>
              <strong>GitHub:</strong> Settings, Webhooks, Add webhook: the address as Payload URL,
              content type <code>application/json</code>, the token as Secret, just the push event.
            </li>
            <li>
              <strong>GitLab:</strong> Settings, Webhooks: the address as URL, the token as Secret
              token, Push events.
            </li>
            <li>
              <strong>Gitea, Forgejo, others:</strong> the address, and the token in an{' '}
              <code>Authorization: Bearer</code> or <code>X-AFS-Token</code> header.
            </li>
          </ul>
        </div>
      )}
      <div className="actions">
        <button
          type="button"
          onClick={() =>
            void act(async () => {
              if (
                project.hook &&
                !window.confirm('Make a new hook token? The git host must be given the new one.')
              )
                return;
              setMade(await api.makeHook(project.id));
            })
          }
        >
          {project.hook ? 'Make a new token' : 'Set up a hook'}
        </button>
        {project.hook && (
          <button
            type="button"
            className="danger"
            onClick={() =>
              void act(async () => {
                if (!window.confirm('Remove the push hook? Calls with its token are refused.'))
                  return;
                await api.removeHook(project.id);
                setMade(undefined);
              })
            }
          >
            Remove the hook
          </button>
        )}
      </div>
    </section>
  );
}

/** AFS-84: a project's tabs, by the end of their address (Files is a page of its own). */
export type ProjectTab = '' | 'runs' | 'branches' | 'settings';

/** How many runs a project's page asks for: its Runs tab lists them, Overview the newest few. */
const RUNS_SHOWN = 100;

export function ProjectPage({
  me,
  workspace,
  project: key,
  tab = '',
}: {
  me: User;
  workspace: string;
  project: string;
  tab?: ProjectTab;
}) {
  const found = useLoad(
    async () => (await api.projects(workspace)).find((p) => p.key === key),
    [workspace, key],
  );
  // AFS-109: the New flow form, open or not.
  const [newFlow, setNewFlow] = useState(false);
  const project = found.data;
  const id = project?.id;
  const access = useProjectAccess(id).data;
  const branchList = useLoad(async () => (id ? await api.branches(id) : undefined), [id]);
  const pushes = useLoad(async () => (id ? api.pushes(id) : []), [id]);
  const runs = useLoad(async () => (id ? api.runs({ project: id, limit: RUNS_SHOWN }) : []), [id]);
  const flows = useLoad(
    async () => (id ? api.flows(id) : ({ flows: [] } as FlowList)),
    [id, project?.commit],
  );
  const [news, setNews] = useState<FlowChanges>();
  // AFS-75: the branch moves while the page is open: the list follows, and says which flows
  // changed and who changed them.
  useEffect(() => {
    if (!id || typeof EventSource === 'undefined') return;
    const events = new EventSource(`/api/v1/projects/${encodeURIComponent(id)}/events`);
    events.addEventListener('moved', (event) => {
      const move = JSON.parse((event as MessageEvent).data) as { from?: string; to: string };
      found.reload();
      if (move.from)
        void api
          .changes(id, move.from, move.to)
          .then((c) => c.flows.length && setNews(c))
          .catch(() => undefined);
    });
    return () => events.close();
  }, [id, found.reload]);
  const [looking, setLooking] = useState(false);
  const look = async () => {
    if (!id) return;
    setLooking(true);
    await api.syncProject(id).catch(() => undefined);
    setLooking(false);
    found.reload();
    branchList.reload();
  };
  const crumbs = (
    <Breadcrumb>
      <Link to="/workspaces">Workspaces</Link> / <Link to={`/w/${workspace}`}>{workspace}</Link> /{' '}
      <span aria-current="page">{key}</span>
    </Breadcrumb>
  );
  if (!project)
    return (
      <>
        {crumbs}
        <PageHead title={key} />
        <Loading state={found} />
        {!found.loading && !found.error && <p className="empty">There is no such project.</p>}
      </>
    );
  const address = `${window.location.origin}${project.gitPath}`;
  const mayPush = me.admin || access?.workspace === 'rw';
  const base = `/w/${workspace}/${key}`;
  return (
    <>
      {crumbs}
      <PageHead
        title={project.name}
        lead={project.hosted ? 'Kept by this server' : `Mirror of ${project.gitUrl}`}
      >
        {mayPush && !project.hosted && (
          <button type="button" onClick={look} disabled={looking}>
            {looking ? 'Looking…' : 'Look at the source now'}
          </button>
        )}
      </PageHead>
      <ProjectStatus project={project} me={me} base={base} />
      <Tabs
        label="Project"
        base={base}
        current={tab}
        tabs={[
          { key: '', label: 'Overview' },
          { key: 'runs', label: 'Runs' },
          // Everything else in the repository (AFS-78) is a page of its own.
          ...(project.commit ? [{ key: 'files', label: 'Files' }] : []),
          {
            key: 'branches',
            label: 'Branches',
            ...(branchList.data?.details ? { count: branchList.data.details.length } : {}),
          },
          { key: 'settings', label: 'Settings' },
        ]}
      />

      {tab === '' && (
        <>
          {project.hosted && !project.commit && mayPush && (
            <StartPanel project={project} onStarted={found.reload} />
          )}

          <LaunchConfigsSection me={me} workspace={workspace} project={project} />

          <section className="panel" aria-labelledby="flows">
            {/* AFS-109: a flow made in the pages, one commit on the branch. */}
            <div className="section-head">
              <h2 id="flows">Flows</h2>
              {/* AFS-113: also the first flow of an empty hosted project (its first commit). */}
              {mayPush && (project.commit || project.hosted) && !newFlow && (
                <button type="button" onClick={() => setNewFlow(true)}>
                  New flow
                </button>
              )}
            </div>
            {newFlow && (
              <NewFlowForm
                workspace={workspace}
                project={project}
                onCancel={() => setNewFlow(false)}
              />
            )}
            {news && <FlowNews news={news} onDismiss={() => setNews(undefined)} />}
            <Loading state={flows} />
            {flows.data?.flows.length === 0 && (
              <p className="muted">
                {project.commit
                  ? 'No flow in this project: a flow is a file named *.flow.yaml.'
                  : project.hosted && mayPush
                    ? 'Nothing yet: the project has no commit. Start it from a sample or an archive, or make a New flow.'
                    : 'Nothing yet: the project has no commit.'}
              </p>
            )}
            <ul className="rows">
              {flows.data?.flows.map((flow) => (
                <li key={flow.file}>
                  <FlowRow flow={flow} to={flowAddress(workspace, key, flow.file)} />
                </li>
              ))}
            </ul>
            {flows.data?.more && <p className="muted">There are more flows than are listed.</p>}
          </section>

          <section className="panel" aria-labelledby="runs">
            <div className="panel-head">
              <h2 id="runs">Recent runs</h2>
              {!!runs.data?.length && <Link to={`${base}/runs`}>All runs of the project</Link>}
            </div>
            <Loading state={runs} />
            {runs.data?.length === 0 && <p className="muted">None yet.</p>}
            {!!runs.data?.length && <RunList runs={runs.data.slice(0, 5)} me={me} />}
          </section>
        </>
      )}

      {tab === 'runs' && (
        <section aria-label="Runs of the project">
          <Loading state={runs} />
          {runs.data?.length === 0 && (
            <p className="empty">No run yet. Runs start from a launch configuration.</p>
          )}
          {!!runs.data?.length && <RunList runs={runs.data} me={me} />}
          {runs.data?.length === RUNS_SHOWN && (
            <p className="muted">
              The newest {RUNS_SHOWN} are listed. <Link to="/runs">All runs</Link> has the rest.
            </p>
          )}
        </section>
      )}

      {tab === 'branches' && (
        <>
          <Loading state={branchList} />
          {branchList.data && (
            <BranchesPanel
              project={project}
              branches={branchList.data.details ?? []}
              mayChange={mayPush}
              admin={me.admin}
              onChanged={() => {
                branchList.reload();
                found.reload();
                pushes.reload();
              }}
            />
          )}

          <section className="panel" aria-labelledby="pushes">
            <h2 id="pushes">Pushes through this server</h2>
            <Loading state={pushes} />
            {pushes.data?.length === 0 && <p className="muted">None yet.</p>}
            {!!pushes.data?.length && (
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Who</th>
                      <th scope="col">Branch</th>
                      <th scope="col">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pushes.data.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <Time at={p.at} />
                        </td>
                        <td>{p.login}</td>
                        <td>
                          <code>{p.ref}</code>
                        </td>
                        <td>
                          <code>{p.from?.slice(0, 8) ?? 'new'}</code> →{' '}
                          <code>{p.to?.slice(0, 8) ?? 'deleted'}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {tab === 'settings' && (
        <>
          {/* The repository holds every flow: it is for who has a level on the workspace. */}
          {(me.admin || access?.workspace) && (
            <section className="panel" aria-labelledby="git">
              <h2 id="git">Work on it with git</h2>
              <p>
                <Copyable text={`git clone ${address}`} label="the clone command" />
              </p>
              <p className="muted">
                The password is an <Link to="/account/tokens">access token</Link>; any user name
                will do.
                {project.hosted &&
                  !project.commit &&
                  ` The repository is empty: push a first commit to ${project.gitRef}.`}
              </p>
            </section>
          )}

          {!project.hosted && (
            <section className="panel" aria-labelledby="source">
              <h2 id="source">Source</h2>
              <dl className="facts">
                <dt>Repository</dt>
                <dd>
                  <code>{project.gitUrl}</code>
                </dd>
                <dt>Last look</dt>
                <dd>
                  <SyncBadge project={project} /> {project.sync.at && <Time at={project.sync.at} />}
                </dd>
              </dl>
              {sshUrl(project.gitUrl) && (
                <HostKey project={project} admin={me.admin} onChanged={found.reload} />
              )}
              {me.admin && signsIn(project.gitUrl) && (
                <SourceSignIn project={project} workspace={workspace} onSaved={found.reload} />
              )}
            </section>
          )}

          {me.admin && !project.hosted && <PushHook project={project} onChanged={found.reload} />}

          <section className="panel" aria-labelledby="library">
            <h2 id="library">Library</h2>
            <p>
              {project.library
                ? "Its flows' subflows are offered to every project (the Library page)."
                : 'Not a library: its subflows are offered to no other project.'}
            </p>
            {me.admin && (
              <button
                type="button"
                onClick={() => void api.setLibrary(project.id, !project.library).then(found.reload)}
              >
                {project.library ? 'Stop offering' : 'Make it a library'}
              </button>
            )}
          </section>

          {me.admin && (
            <DeleteSection
              what="project"
              name={project.name}
              keyword={project.key}
              goes=" with its launch configurations, their schedules, its run history and the server's copy of its repository (an external source stays as it is). A project with a run going is not deleted: stop the run first"
              remove={() => api.deleteProject(project.id)}
              to={`/w/${workspace}`}
            />
          )}
        </>
      )}
    </>
  );
}

/** The address of a flow's page: its file's path, part by part. */
export const flowAddress = (workspace: string, project: string, file: string) =>
  `/w/${encodeURIComponent(workspace)}/${encodeURIComponent(project)}/flow/${file
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

function FlowRow({ flow, to }: { flow: FlowSummary; to: string }) {
  if (!flow.ok)
    return (
      <div className="row">
        <span>
          <strong>{flow.name ?? flow.file}</strong>
          <span className="muted"> · {flow.file}</span>
        </span>
        <span className="bad-text">{flow.problem}</span>
      </div>
    );
  // The row leads to the flow; how its last run went leads to that run, so the row is not one
  // link around everything.
  return (
    <div className="row">
      <Link to={to} className="row-main">
        <strong>{flow.name ?? flow.key ?? flow.file}</strong>
        <span className="muted">
          {' '}
          · {flow.file}
          {flow.version !== undefined && ` · version ${flow.version}`} · {flow.steps ?? 0}{' '}
          {flow.steps === 1 ? 'step' : 'steps'}
        </span>
      </Link>
      <span className="badges">
        {flow.lastRun && (
          <Link to={`/runs/${flow.lastRun.id}`} className="last-run">
            <span className="muted">last run</span> <RunWords state={flow.lastRun.state} />
          </Link>
        )}
        {flow.errors > 0 && (
          <span className="badge bad">
            {flow.errors} {flow.errors === 1 ? 'error' : 'errors'}
          </span>
        )}
        {flow.warnings > 0 && (
          <span className="badge">
            {flow.warnings} {flow.warnings === 1 ? 'warning' : 'warnings'}
          </span>
        )}
        {flow.errors === 0 && flow.warnings === 0 && <span className="badge ok">no findings</span>}
      </span>
    </div>
  );
}

// --- parts of the server that are not built yet

export function NotBuilt({ title, what }: { title: string; what: string }) {
  return (
    <>
      <PageHead title={title} />
      <p className="empty">{what} This part of the server is not built yet.</p>
    </>
  );
}

/** AFS-102: an administration page, asked for by someone who is not an administrator. */
export function AdminOnly() {
  return (
    <>
      <PageHead title="For administrators" />
      <p className="empty">
        This page is for administrators of the server. <Link to="/">Go home.</Link>
      </p>
    </>
  );
}

export function NotFound() {
  return (
    <>
      <PageHead title="Nothing here" />
      <p className="empty">
        There is no page at this address. <Link to="/">Go home.</Link>
      </p>
    </>
  );
}
