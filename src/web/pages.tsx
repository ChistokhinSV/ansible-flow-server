// The pages. Each reads what it shows from the API when it opens; what only administrators may
// do is shown only to them (the server decides either way).

import { useState } from 'react';
import { useProjectAccess, WorkspaceAccess } from './access';
import { api, type FlowList, type FlowSummary, type Project, type User } from './api';
import { GitCredentialChoice, needsSignIn, WorkspaceCredentials } from './credentials';
import { LaunchConfigsSection } from './launch';
import { Link, navigate } from './router';
import { RunTable } from './runs';
import type { ThemeChoice } from './theme';
import { TokensPanel } from './tokens';
import { Copyable, Field, Form, Loading, PageHead, Time, useLoad } from './ui';

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
              const made = await api.addProject(workspace, {
                key: input.key,
                name: input.name,
                ...(input.hosted ? {} : { gitUrl: input.gitUrl }),
                ...(!input.hosted && https(input.gitUrl) && input.gitCredential
                  ? { gitCredential: input.gitCredential }
                  : {}),
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
                Kept by this server (starts empty)
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
            {!input.hosted && https(input.gitUrl) && (
              <GitCredentialChoice
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
      {space.data && <WorkspaceCredentials workspace={space.data.key} admin={me.admin} />}
      {me.admin && space.data && (
        <WorkspaceAccess workspace={space.data.key} selfApprove={space.data.selfApprove} />
      )}
    </>
  );
}

// --- a project

const https = (url?: string) => /^https:\/\//i.test(url?.trim() ?? '');

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
  const branches = useLoad(async () => (id ? (await api.branches(id)).branches : []), [id]);
  const pushes = useLoad(async () => (id ? api.pushes(id) : []), [id]);
  const runs = useLoad(async () => (id ? api.runs({ project: id, limit: 10 }) : []), [id]);
  const flows = useLoad(
    async () => (id ? api.flows(id) : ({ flows: [] } as FlowList)),
    [id, project?.commit],
  );
  const [looking, setLooking] = useState(false);
  const look = async () => {
    if (!id) return;
    setLooking(true);
    await api.syncProject(id).catch(() => undefined);
    setLooking(false);
    found.reload();
    branches.reload();
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
          <dt>Branches</dt>
          <dd>{branches.data?.length ? branches.data.join(', ') : 'none yet'}</dd>
        </dl>
        {me.admin && !project.hosted && https(project.gitUrl) && (
          <SourceSignIn project={project} workspace={workspace} onSaved={found.reload} />
        )}
      </section>

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
        <h2 id="flows">Flows</h2>
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
  const viewer =
    project &&
    `/viewer.html?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(file)}&theme=${
      theme === 'system' ? 'auto' : theme
    }`;
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
            project?.commit
              ? `${project.gitRef} at ${project.commit.slice(0, 12)} · shown, not changed`
              : undefined
          }
        >
          {viewer && (
            <a href={viewer} target="_blank" rel="noreferrer">
              Open on its own page
            </a>
          )}
        </PageHead>
        <Loading state={found} />
        {!found.loading && !found.error && !project && (
          <p className="empty">There is no such project.</p>
        )}
      </div>
      {viewer && project?.commit && (
        <iframe
          // A new commit or theme is a new page for the designer.
          key={`${project.commit}:${theme}`}
          className="flow-frame"
          src={viewer}
          title={`The flow ${title} on the designer's canvas`}
        />
      )}
    </div>
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
