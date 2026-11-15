// The pages. Each reads what it shows from the API when it opens; what only administrators may
// do is shown only to them (the server decides either way).

import { useEffect, useRef, useState } from 'react';
import { useProjectAccess, WorkspaceAccess } from './access';
import {
  ApiError,
  api,
  type Branch,
  type Draft,
  type FlowChanges,
  type FlowList,
  type FlowSummary,
  type Project,
  type User,
} from './api';
import { GitCredentialChoice, needsSignIn, WorkspaceCredentials } from './credentials';
import { WorkspaceEnvironments } from './environments';
import { LaunchConfigsSection } from './launch';
import { Link, navigate } from './router';
import { RunTable } from './runs';
import { ProviderButtons } from './signin';
import type { ThemeChoice } from './theme';
import { TokensPanel } from './tokens';
import { Copyable, Field, Form, Loading, messageOf, PageHead, Time, useLoad } from './ui';

// --- before anyone is signed in

export function Setup({ onDone }: { onDone: (user: User) => void }) {
  const [input, setInput] = useState({ code: '', login: '', name: '', password: '' });
  const set = (key: keyof typeof input) => (e: { target: { value: string } }) =>
    setInput((before) => ({ ...before, [key]: e.target.value }));
  return (
    <main className="narrow" id="main">
      <h1>Set up Ansible Flow Server</h1>
      <p className="muted">
        This server has no user yet. Make its first administrator. The setup code is in the server's
        log, written when it started.
      </p>
      <Form submit="Make the administrator" onSubmit={async () => onDone(await api.setup(input))}>
        <Field label="Setup code" value={input.code} onChange={set('code')} required autoFocus />
        <Field
          label="Login"
          value={input.login}
          onChange={set('login')}
          required
          autoComplete="username"
        />
        <Field
          label="Name"
          value={input.name}
          onChange={set('name')}
          required
          autoComplete="name"
        />
        <Field
          label="Password"
          type="password"
          value={input.password}
          onChange={set('password')}
          required
          minLength={12}
          autoComplete="new-password"
          hint="At least 12 characters. A few words work well."
        />
      </Form>
    </main>
  );
}

export function SignIn({ onDone }: { onDone: (user: User) => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  return (
    <main className="narrow" id="main">
      <h1>Sign in</h1>
      {/* AFS-30: the organisation's sign-in first, when there is one. */}
      <ProviderButtons />
      <Form submit="Sign in" onSubmit={async () => onDone(await api.signIn(login, password))}>
        <Field
          label="Login"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          required
          autoFocus
          autoComplete="username"
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
        />
      </Form>
    </main>
  );
}

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
        <section className="panel" aria-label="Add workspace">
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

export function Workspace({ me, workspace }: { me: User; workspace: string }) {
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
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link to="/">Workspaces</Link> / <span aria-current="page">{workspace}</span>
      </nav>
      <PageHead title={space.data?.name ?? workspace} lead={space.data?.description}>
        {me.admin && space.data && !adding && (
          <button type="button" className="primary" onClick={() => setAdding(true)}>
            Add project
          </button>
        )}
      </PageHead>
      <Loading state={space.error ? space : projects} />
      {adding && (
        <section className="panel" aria-label="Add project">
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
      {projects.data?.length === 0 && <p className="empty">No project in this workspace yet.</p>}
      <ul className="cards">
        {projects.data?.map((p) => (
          <li key={p.id}>
            <Link to={`/w/${workspace}/${p.key}`} className="card">
              <strong>{p.name}</strong>
              <span className="muted">
                {p.key} · {p.hosted ? 'kept by this server' : 'external repository'} · {p.gitRef}
              </span>
              <SyncBadge project={p} />
            </Link>
          </li>
        ))}
      </ul>
      {space.data && (
        <WorkspaceEnvironments
          workspace={space.data.key}
          mayManage={space.data.level === 'admin' || space.data.level === 'rw'}
        />
      )}
      {space.data && <WorkspaceCredentials workspace={space.data.key} admin={me.admin} />}
      {me.admin && space.data && (
        <WorkspaceAccess workspace={space.data.key} selfApprove={space.data.selfApprove} />
      )}
    </>
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
      <h2 id="branches">Branches</h2>
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
      {mayChange && branches.length > 0 && !adding && (
        <button type="button" onClick={() => setAdding(true)}>
          New branch
        </button>
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

export function ProjectPage({
  me,
  workspace,
  project: key,
}: {
  me: User;
  workspace: string;
  project: string;
}) {
  const found = useLoad(
    async () => (await api.projects(workspace)).find((p) => p.key === key),
    [workspace, key],
  );
  const project = found.data;
  const id = project?.id;
  const access = useProjectAccess(id).data;
  const branchList = useLoad(async () => (id ? await api.branches(id) : undefined), [id]);
  const pushes = useLoad(async () => (id ? api.pushes(id) : []), [id]);
  const runs = useLoad(async () => (id ? api.runs({ project: id, limit: 10 }) : []), [id]);
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
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link to="/">Workspaces</Link> / <Link to={`/w/${workspace}`}>{workspace}</Link> /{' '}
      <span aria-current="page">{key}</span>
    </nav>
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
  return (
    <>
      {crumbs}
      <PageHead
        title={project.name}
        lead={project.hosted ? 'Kept by this server' : `Mirror of ${project.gitUrl}`}
      >
        {(me.admin || access?.workspace === 'rw') && !project.hosted && (
          <button type="button" onClick={look} disabled={looking}>
            {looking ? 'Looking…' : 'Look at the source now'}
          </button>
        )}
      </PageHead>

      <section className="panel" aria-labelledby="state">
        <h2 id="state">State</h2>
        <dl className="facts">
          <dt>Source</dt>
          <dd>
            <SyncBadge project={project} />{' '}
            {project.sync.error && <span className="bad-text">{project.sync.error}</span>}
            {needsSignIn(project.sync.error) && (
              <div className="muted">
                The repository asks for a sign-in
                {me.admin ? ': choose what the project signs in with below.' : '.'}
              </div>
            )}
          </dd>
          <dt>Branch that runs</dt>
          <dd>
            <code>{project.gitRef}</code>
          </dd>
          <dt>Commit</dt>
          <dd>
            {project.commit ? <code>{project.commit.slice(0, 12)}</code> : 'none yet'}
            {project.sync.at && (
              <span className="muted">
                {' '}
                · looked at <Time at={project.sync.at} />
              </span>
            )}
          </dd>
        </dl>
        {!project.hosted && sshUrl(project.gitUrl) && (
          <HostKey project={project} admin={me.admin} onChanged={found.reload} />
        )}
        {me.admin && !project.hosted && signsIn(project.gitUrl) && (
          <SourceSignIn project={project} workspace={workspace} onSaved={found.reload} />
        )}
      </section>

      {me.admin && !project.hosted && <PushHook project={project} onChanged={found.reload} />}

      {project.hosted && !project.commit && (me.admin || access?.workspace === 'rw') && (
        <StartPanel project={project} onStarted={found.reload} />
      )}

      {/* The repository holds every flow: it is for who has a level on the workspace. */}
      {(me.admin || access?.workspace) && (
        <section className="panel" aria-labelledby="git">
          <h2 id="git">Work on it with git</h2>
          <p>
            <Copyable text={`git clone ${address}`} label="the clone command" />
          </p>
          <p className="muted">
            The password is an <Link to="/account">access token</Link>; any user name will do.
            {project.hosted &&
              !project.commit &&
              ` The repository is empty: push a first commit to ${project.gitRef}.`}
          </p>
        </section>
      )}

      <section className="panel" aria-labelledby="flows">
        <div className="panel-head">
          <h2 id="flows">Flows</h2>
          {project.commit && (
            // AFS-78: everything else in the repository.
            <Link to={`/w/${workspace}/${key}/files`}>Files of the project</Link>
          )}
        </div>
        {news && <FlowNews news={news} onDismiss={() => setNews(undefined)} />}
        <Loading state={flows} />
        {flows.data?.flows.length === 0 && (
          <p className="muted">
            {project.commit
              ? 'No flow in this project: a flow is a file named *.flow.yaml.'
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

      <LaunchConfigsSection me={me} workspace={workspace} project={project} />

      <section className="panel" aria-labelledby="runs">
        <h2 id="runs">Recent runs</h2>
        <Loading state={runs} />
        {runs.data?.length === 0 && <p className="muted">None yet.</p>}
        {!!runs.data?.length && <RunTable runs={runs.data} showProject={false} />}
      </section>

      {branchList.data && (
        <BranchesPanel
          project={project}
          branches={branchList.data.details ?? []}
          mayChange={me.admin || access?.workspace === 'rw'}
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
  return (
    <Link to={to} className="row">
      <span>
        <strong>{flow.name ?? flow.key ?? flow.file}</strong>
        <span className="muted">
          {' '}
          · {flow.file}
          {flow.version !== undefined && ` · version ${flow.version}`} · {flow.steps ?? 0}{' '}
          {flow.steps === 1 ? 'step' : 'steps'}
        </span>
      </span>
      <span className="badges">
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
    </Link>
  );
}

// --- a flow

/**
 * One flow on the designer's canvas, read-only. The designer is a page of its own
 * (viewer.html), shown here in a frame under the application's bar.
 */
export function FlowPage({
  workspace,
  project: key,
  file,
  theme,
}: {
  workspace: string;
  project: string;
  file: string;
  theme: ThemeChoice;
}) {
  const found = useLoad(
    async () => (await api.projects(workspace)).find((p) => p.key === key),
    [workspace, key],
  );
  const project = found.data;
  const flows = useLoad(
    async () => (project ? api.flows(project.id) : ({ flows: [] } as FlowList)),
    [project?.id, project?.commit],
  );
  const flow = flows.data?.flows.find((f) => f.file === file);
  const title = flow?.name ?? file.split('/').at(-1) ?? file;
  // AFS-76: editing the flow's draft (rw on the flow), and the drafts there are.
  const access = useProjectAccess(project?.id).data;
  const mayEdit = !!access && (access.admin || access.flows?.[file] === 'rw');
  const drafts = useLoad(
    async () => (project ? api.drafts(project.id) : ([] as Draft[])),
    [project?.id, project?.commit],
  );
  const waiting = drafts.data?.find((d) => d.file === file);
  const [editing, setEditing] = useState<Draft>();
  const [people, setPeople] = useState<{ login: string; name: string }[]>([]);
  const [edits, setEdits] = useState<{ by: string; steps: string[]; at: string }[]>([]);
  const [said, setSaid] = useState<string>();
  const reloadAll = useRef<() => void>(() => undefined);
  reloadAll.current = () => {
    found.reload();
    drafts.reload();
  };
  const stopEditing = (words?: string) => {
    setEditing(undefined);
    setPeople([]);
    setEdits([]);
    setSaid(words);
    reloadAll.current();
  };
  const stop = useRef(stopEditing);
  stop.current = stopEditing;
  // AFS-75: the designer's frame says which commit it shows after an Update.
  const [shown, setShown] = useState<string>();
  useEffect(() => {
    const heard = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        type?: string;
        commit?: string;
        by?: string;
        people?: { login: string; name: string }[];
        steps?: string[];
      } | null;
      if (data?.type === 'afs-flow-shown' && data.commit) setShown(data.commit);
      if (data?.type === 'afs-draft-people') setPeople(data.people ?? []);
      if (data?.type === 'afs-draft-edit' && data.by) {
        const by = data.by;
        const steps = data.steps ?? [];
        setEdits((e) => [{ by, steps, at: new Date().toISOString() }, ...e].slice(0, 5));
      }
      if (data?.type === 'afs-draft-saved')
        stop.current(
          `${data.by ?? 'Someone'} saved the draft${data.commit ? ` as ${data.commit.slice(0, 12)}` : ''}.`,
        );
      if (data?.type === 'afs-draft-gone')
        stop.current(`${data.by ?? 'Someone'} discarded the draft.`);
    };
    window.addEventListener('message', heard);
    return () => window.removeEventListener('message', heard);
  }, []);
  const commit = shown ?? project?.commit;
  const viewer =
    project &&
    `/viewer.html?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(file)}${
      editing ? `&draft=${encodeURIComponent(editing.id)}` : ''
    }&theme=${theme === 'system' ? 'auto' : theme}`;
  const edit = async () => {
    if (!project) return;
    setSaid(undefined);
    try {
      setEditing(await api.openDraft(project.id, file));
    } catch (e) {
      setSaid(messageOf(e));
    }
  };
  return (
    <div className="flow-page">
      <div className="flow-head">
        <nav aria-label="Breadcrumb" className="crumbs">
          <Link to="/">Workspaces</Link> / <Link to={`/w/${workspace}`}>{workspace}</Link> /{' '}
          <Link to={`/w/${workspace}/${key}`}>{key}</Link> / <span aria-current="page">{file}</span>
        </nav>
        <PageHead
          title={title}
          lead={
            project && editing
              ? `Editing a draft of ${project.gitRef} at ${editing.baseCommit.slice(0, 12)} · Save makes one commit`
              : project && commit
                ? `${project.gitRef} at ${commit.slice(0, 12)} · shown, not changed`
                : undefined
          }
        >
          {mayEdit && !editing && project?.commit ? (
            <button type="button" onClick={() => void edit()}>
              {waiting ? 'Open the draft' : 'Edit'}
            </button>
          ) : null}
          {viewer && !editing && (
            <a href={viewer} target="_blank" rel="noreferrer">
              Open on its own page
            </a>
          )}
        </PageHead>
        {said ? (
          <p className="notice" role="status">
            {said}
          </p>
        ) : null}
        {!editing && waiting ? (
          <p className="notice" role="status">
            Unsaved edits in the pages by{' '}
            {waiting.editors.length ? waiting.editors.map((e) => e.name).join(', ') : 'nobody yet'}{' '}
            (a draft since <Time at={waiting.createdAt} />
            ).
          </p>
        ) : null}
        {editing ? (
          <DraftBar draft={editing} people={people} edits={edits} onDone={stopEditing} />
        ) : null}
        <Loading state={found} />
        {!found.loading && !found.error && !project && (
          <p className="empty">There is no such project.</p>
        )}
      </div>
      {viewer && project?.commit && (
        <iframe
          // A new commit, theme or draft is a new page for the designer.
          key={`${project.commit}:${theme}:${editing?.id ?? ''}`}
          className="flow-frame"
          src={viewer}
          title={`The flow ${title} on the designer's canvas`}
        />
      )}
    </div>
  );
}

/**
 * AFS-76: while a flow's draft is being edited: who is here, what the others changed lately,
 * Save (one commit, with a message) and Discard. A Save the branch's changes stand in the way of
 * lists the conflicts and offers to save with the draft's side.
 */
function DraftBar({
  draft,
  people,
  edits,
  onDone,
}: {
  draft: Draft;
  people: { login: string; name: string }[];
  edits: { by: string; steps: string[]; at: string }[];
  onDone(words?: string): void;
}) {
  const [message, setMessage] = useState('');
  const [conflicts, setConflicts] = useState<{ id: string; label: string }[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async (force = false) => {
    setBusy(true);
    setError(undefined);
    try {
      const done = await api.saveDraft(draft.id, {
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(force ? { force } : {}),
      });
      onDone(
        done.unchanged
          ? 'Nothing to save: the flow is as the branch has it.'
          : `Saved as ${done.commit.slice(0, 12)}.`,
      );
    } catch (e) {
      if (e instanceof ApiError && e.details.conflicts) setConflicts(e.details.conflicts);
      else setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    if (!window.confirm("Discard the draft? Everyone's unsaved edits go.")) return;
    try {
      await api.discardDraft(draft.id);
      onDone('The draft is discarded.');
    } catch (e) {
      setError(messageOf(e));
    }
  };
  return (
    <section className="panel draft-bar" aria-label="Editing">
      <p>
        <strong>Editing</strong> · here now:{' '}
        {people.length ? people.map((p) => p.name).join(', ') : 'only you'}. Edits are shared at
        once; Ctrl+Z takes back your own last one.
      </p>
      {edits.length ? (
        <ul className="muted draft-edits">
          {edits.map((e) => (
            <li key={`${e.at}${e.by}`}>
              {e.by} changed {e.steps.length ? e.steps.join(', ') : 'the flow'} (<Time at={e.at} />)
            </li>
          ))}
        </ul>
      ) : null}
      {conflicts ? (
        <div className="notice error" role="alert">
          <p>The branch changed the same places since this draft began:</p>
          <ul>
            {conflicts.map((c) => (
              <li key={c.id}>{c.label}</li>
            ))}
          </ul>
          <button type="button" disabled={busy} onClick={() => void save(true)}>
            Save with the draft's side
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="draft-actions">
        <input
          aria-label="What changed (the commit's message)"
          placeholder={`Edit ${draft.file}`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          Save
        </button>
        <button type="button" disabled={busy} onClick={() => onDone()}>
          Stop editing
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => void discard()}>
          Discard
        </button>
      </div>
    </section>
  );
}

// --- my account

/** A webhook's address as a page shows it to someone who may not change it: its host only. */
const hookHost = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return 'set';
  }
};

/**
 * Name and email address, which anyone changes for themself; the webhook, which only an
 * administrator sets (the server calls the address it is given). AFS-29.
 */
function Profile({ me }: { me: User }) {
  const [name, setName] = useState(me.name);
  const [email, setEmail] = useState(me.email ?? '');
  const [webhook, setWebhook] = useState(me.webhookUrl ?? '');
  const [saved, setSaved] = useState(false);
  return (
    <section className="panel" aria-labelledby="profile">
      <h2 id="profile">Profile</h2>
      <p className="muted">
        Notifications for you (approvals that wait for you, how your runs' approvals were decided)
        go to your email address{me.admin ? ' and your webhook' : ''}.
      </p>
      <Form
        submit="Save"
        onSubmit={async () => {
          setSaved(false);
          const changed = await api.changeMe({
            name: name.trim(),
            email: email.trim() || null,
            ...(me.admin ? { webhookUrl: webhook.trim() || null } : {}),
          });
          setName(changed.name);
          setEmail(changed.email ?? '');
          setWebhook(changed.webhookUrl ?? '');
          setSaved(true);
        }}
      >
        <Field
          label="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Field
          label="Email address"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {me.admin ? (
          <Field
            label="Webhook"
            type="url"
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
            hint="The event as JSON, with a text line chat tools show."
          />
        ) : (
          <p>
            <span className="muted">Webhook:</span>{' '}
            {me.webhookUrl ? hookHost(me.webhookUrl) : 'none'}{' '}
            <span className="muted">(set by an administrator)</span>
          </p>
        )}
        {saved && (
          <p className="notice ok" role="status">
            Saved.
          </p>
        )}
      </Form>
    </section>
  );
}

export function Account({ me }: { me: User }) {
  return (
    <>
      <PageHead title="My account" lead={`${me.name} (${me.login})`} />
      <Profile me={me} />
      <TokensPanel
        load={api.tokens}
        add={api.addToken}
        revoke={api.revokeToken}
        none="You have no token."
        intro={
          <p className="muted">
            A program signs in with a token instead of your password: git, the VS Code extension, a
            script. A token acts as you. What a program can ask is in the{' '}
            <Link to="/docs/api">API reference</Link>.
          </p>
        }
      />
    </>
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

export function NotFound() {
  return (
    <>
      <PageHead title="Nothing here" />
      <p className="empty">
        There is no page at this address. <Link to="/">Go to the workspaces.</Link>
      </p>
    </>
  );
}
