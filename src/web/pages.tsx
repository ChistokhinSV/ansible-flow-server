// The pages. Each reads what it shows from the API when it opens; what only administrators may
// do is shown only to them (the server decides either way).

import { useEffect, useRef, useState } from 'react';
import { refProblem } from '../server/projects/refName';
import {
  atLeast,
  launchesInProject,
  ProjectYourAccess,
  useProjectAccess,
  WorkspaceAccess,
  YourAccess,
} from './access';
import {
  api,
  type Branch,
  type FlowChanges,
  type FlowList,
  type FlowSummary,
  type Project,
  type User,
} from './api';
import { ask } from './confirm';
import { GitCredentialChoice, needsSignIn, WorkspaceCredentials } from './credentials';
import { WorkspaceEnvironments } from './environments';
import { followKey, NewFlowForm } from './flowFiles';
import { guide } from './guide';
import { Missing, MissingProject } from './help';
import { ProjectHistory } from './history';
import { LaunchConfigsSection } from './launch';
import { Link, navigate } from './router';
import { RunList, RunWords } from './runs';
import {
  Breadcrumb,
  Copyable,
  Field,
  Form,
  Labelled,
  Loading,
  messageOf,
  PageHead,
  refuse,
  Scroll,
  Tabs,
  Time,
  useLoad,
  WorkspaceName,
} from './ui';

// --- workspaces

export function Workspaces({ me }: { me: User }) {
  const list = useLoad(api.workspaces, []);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState({ key: '', name: '' });
  return (
    <>
      <PageHead
        help="workspaces-and-projects.md"
        title="Workspaces"
        lead="A workspace is a team's space: its projects live in it."
      >
        {me.admin && !adding && (
          <button type="button" className="primary" onClick={() => setAdding(true)}>
            Add workspace
          </button>
        )}
      </PageHead>
      {adding && (
        <section className="panel sheet" aria-label="Add workspace">
          <Form
            open
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
              onChange={(e) =>
                setInput({
                  name: e.target.value,
                  key: followKey(e.target.value, input.name, input.key),
                })
              }
              required
            />
            <Field
              label="Key"
              name="key"
              maxLength={63}
              value={input.key}
              onChange={(e) => setInput({ ...input, key: e.target.value })}
              required
              pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
              title="Lower-case letters, digits and dashes, not starting or ending with a dash"
              hint="Used in addresses: lower-case letters, digits and dashes. Made from the name until you change it."
            />
          </Form>
        </section>
      )}
      <Loading state={list} />
      {list.data?.length === 0 && (
        <p className="empty">
          {me.admin
            ? 'No workspace yet. Add the first one.'
            : 'You have no access to a workspace yet: ask an administrator for it.'}
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
/** AFS-171: what each state of a project means, for its badge and the guide's words. */
const SYNC_MEANS = {
  ok: 'up to date: the server has the newest commit of the branch',
  error:
    'cannot be read: the server could not fetch the repository; runs use the last commit it had',
  never: 'not read yet: the server has not fetched the repository yet',
  empty: 'empty: the project has no commit yet',
} as const;

function SyncBadge({ project }: { project: Project }) {
  const { state, error } = project.sync;
  if (state === 'ok')
    return (
      <span className="badge ok" title={SYNC_MEANS.ok}>
        up to date
      </span>
    );
  if (state === 'error')
    return (
      <span
        className="badge bad"
        title={error ? `${SYNC_MEANS.error}. ${error}` : SYNC_MEANS.error}
      >
        cannot be read
      </span>
    );
  return (
    <span className="badge" title={project.hosted ? SYNC_MEANS.empty : SYNC_MEANS.never}>
      {project.hosted ? 'empty' : 'not read yet'}
    </span>
  );
}

/**
 * AFS-84: the project's state in one line; what it is set up with is on Settings. It is on every
 * tab of the project, Files too (AFS-94), so the tabs stay where they are.
 */
export function ProjectStatus({
  project,
  me,
  base,
  quiet,
}: {
  project: Project;
  me: User;
  base: string;
  /** AFS-150: the source's error is said elsewhere on the page (Settings, under Source). */
  quiet?: boolean;
}) {
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
      {project.sync.error && (!quiet || needsSignIn(project.sync.error)) && (
        <span className="bad-text">
          {quiet ? '' : project.sync.error}
          {/* AFS-171: what "cannot be read" means and what to do, beside git's reason. */}
          {!quiet && !needsSignIn(project.sync.error) && (
            <>
              {/[.!?]$/.test(project.sync.error) ? ' ' : '. '}
              The server cannot fetch the repository
              {project.commit ? '; runs use the last commit it had' : ''}. Check the address
              {me.admin ? (
                <>
                  {' '}
                  on <Link to={`${base}/settings`}>Settings</Link>
                </>
              ) : (
                ''
              )}
              , then look at the source again.
            </>
          )}
          {needsSignIn(project.sync.error) && (
            <>
              {quiet ? '' : ' '}
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
/** AFS-140: why a new project's source could not be read, for its Settings to say. */
let sourceRefusal: string | undefined;

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
            name="archive"
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

/** AFS-143: the guide page about each tab of a workspace. */
const WORKSPACE_HELP: Record<WorkspaceTab, string> = {
  '': 'workspaces-and-projects.md',
  '-/environments': 'environments.md',
  '-/credentials': 'credentials.md',
  '-/access': 'people-and-sign-in.md#access-levels',
};

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
  // AFS-152: read once the workspace is there: a workspace not there (or not shared) is asked for once.
  const projects = useLoad(
    async () => (space.data ? api.projects(workspace) : undefined),
    [workspace, !!space.data],
  );
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
  // AFS-171: the address (with its credential) read and found unreadable: Add anyway adds it.
  const [unread, setUnread] = useState<string>();
  const anyway = useRef(false);
  /** The address and credential as the check reads them. */
  const source = {
    gitUrl: input.gitUrl,
    ...(signsIn(input.gitUrl) && input.gitCredential ? { gitCredential: input.gitCredential } : {}),
  };
  const asked = `${source.gitUrl} ${source.gitCredential ?? ''}`;
  const crumbs = (
    <Breadcrumb>
      <Link to="/workspaces">Workspaces</Link> /{' '}
      <span aria-current="page">{space.data?.name ?? workspace}</span>
    </Breadcrumb>
  );
  // AFS-143: a workspace not there (or not shared) is named, with the way back.
  if (space.error && !space.loading)
    return (
      <>
        {crumbs}
        <Missing
          what={
            <>
              The workspace <code>{workspace}</code>
            </>
          }
          back={{ to: '/workspaces', label: 'Back to Workspaces' }}
          error={/^No such/.test(space.error) ? undefined : space.error}
        />
      </>
    );
  return (
    <>
      {crumbs}
      <PageHead
        help={WORKSPACE_HELP[tab]}
        title={space.data?.name ?? workspace}
        lead={
          space.data && (
            <>
              {space.data.description && <>{space.data.description} · </>}
              <YourAccess level={me.admin ? 'admin' : space.data.level} />
            </>
          )
        }
      >
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
            open
            submit="Add"
            onCancel={() => {
              setAdding(false);
              setUnread(undefined);
            }}
            more={
              !input.hosted && unread === asked ? (
                <button type="submit" onClick={() => (anyway.current = true)}>
                  Add anyway
                </button>
              ) : null
            }
            onSubmit={async () => {
              const skip = anyway.current;
              anyway.current = false;
              // AFS-171: an existing repository is read first; one that cannot be read is said at
              // its address, with Add anyway (it is added and looked at again later).
              if (!input.hosted && !(skip && unread === asked)) {
                const read = await api.checkSource(workspace, source);
                if (!read.ok) {
                  setUnread(asked);
                  refuse(
                    'gitUrl',
                    `The repository cannot be read: ${(read.message ?? 'no answer').replace(/[.\s]+$/, '')}. Check the address${signsIn(input.gitUrl) ? ' and the credential' : ''}, or Add anyway and fix it on the project's Settings.`,
                  );
                }
              }
              const archive = input.hosted && start.from === 'archive' ? start.archive : undefined;
              if (input.hosted && start.from === 'archive' && !archive)
                refuse('archive', 'Choose the archive to start with.');
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
              // AFS-140: a source that does not answer is said at once, where it can be fixed.
              if (made.sync.state === 'error') sourceRefusal = made.sync.error;
              navigate(
                `/w/${workspace}/${made.key}${made.sync.state === 'error' ? '/settings' : ''}`,
              );
            }}
          >
            <Field
              label="Name"
              name="name"
              maxLength={200}
              value={input.name}
              onChange={(e) =>
                setInput({
                  ...input,
                  name: e.target.value,
                  key: followKey(e.target.value, input.name, input.key),
                })
              }
              required
            />
            <Field
              label="Key"
              name="key"
              maxLength={63}
              value={input.key}
              onChange={(e) => setInput({ ...input, key: e.target.value })}
              required
              pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
              title="Lower-case letters, digits and dashes, not starting or ending with a dash"
              hint="Used in addresses: lower-case letters, digits and dashes. Made from the name until you change it."
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
                name="gitUrl"
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
          {/* AFS-192: who has no Add project learns who adds one. */}
          {!me.admin && space.data && (
            <p className="muted">
              Projects are added by administrators of the server: ask one for a new project.
            </p>
          )}
        </>
      )}
      {space.data && tab === '-/environments' && (
        <WorkspaceEnvironments
          workspace={space.data.key}
          mayManage={space.data.level === 'admin' || space.data.level === 'rw'}
          admin={me.admin}
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
          <WorkspaceAccess
            workspace={space.data.key}
            selfApprove={space.data.selfApprove}
            operatorsDebug={space.data.operatorsDebug}
          />
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
              !(await ask(
                `Forget the trusted key of ${key.data?.host} and trust the key it shows now?`,
                { yes: 'Trust the new key', danger: true },
              ))
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

/**
 * AFS-143: how to clone a project, with what git needs to trust a self-signed certificate (git
 * refuses it, on Windows with SEC_E_UNTRUSTED_ROOT).
 */
export function CloneHelp({ project }: { project: Project }) {
  const address = `${window.location.origin}${project.gitPath}`;
  return (
    <>
      <p>
        <Copyable text={`git clone ${address}`} label="the clone command" />
      </p>
      <p className="muted">
        The password is an <Link to="/account/tokens">access token</Link>; any user name will do.
      </p>
      {window.location.protocol === 'https:' && (
        <details className="clone-trust">
          <summary>git says the certificate is not trusted?</summary>
          <p className="muted">
            While the server uses a self-signed certificate, git does not trust it. Save{' '}
            <a href="/api/v1/certificate.pem" download>
              the server's certificate
            </a>{' '}
            and clone with it; git keeps the setting for the clone. On Windows, add{' '}
            {/* AFS-210: an option is not broken across lines. */}
            <code className="nowrap">-c http.sslBackend=openssl</code> after <code>clone</code>.
          </p>
          <p>
            <Copyable
              text={`git clone -c http.sslCAInfo=<path to server-certificate.pem> ${address}`}
              label="the clone command that trusts the certificate"
            />
          </p>
          <p className="muted">
            <a href={guide('certificates.md')} target="_blank" rel="noreferrer">
              More about the certificate
            </a>
          </p>
        </details>
      )}
    </>
  );
}

/** AFS-140: what a project's first commit holds, for the page to say once it switches. */
let startedNote: string | undefined;

/** AFS-140: the files of a first commit in words, and what to do with its playbooks. */
async function startedWords(project: Project): Promise<string> {
  const files = project.commit
    ? (await api.files(project.id, project.gitRef).catch(() => undefined))?.files.map((f) => f.path)
    : undefined;
  if (!files) return 'The project has started.';
  const flows = files.filter((f) => f.endsWith('.flow.yaml')).length;
  const playbooks = files.filter(
    (f) => /\.ya?ml$/.test(f) && !f.endsWith('.flow.yaml') && /(^|\/)playbooks?\/|^[^/]+$/.test(f),
  ).length;
  const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  // AFS-192: a sample brings launch configurations: named, so they are found under the note.
  const configs = (await api.launchConfigs(project.id).catch(() => [])).map((c) => c.name);
  return [
    `The project has started: ${counted(files.length, 'file')}, ${counted(flows, 'flow')}${
      configs.length
        ? `, and the launch configuration${configs.length === 1 ? '' : 's'} ${configs.join(', ')}`
        : ''
    }.`,
    playbooks && !flows
      ? `${counted(playbooks, 'YAML file')} may be playbooks: make a New flow and start it from one.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** AFS-140: the note of a project that has just started, said once on its page. */
function StartedNote() {
  const [note] = useState(() => {
    const said = startedNote;
    startedNote = undefined;
    return said;
  });
  return note ? (
    <p className="notice" role="status">
      {note}
    </p>
  ) : null;
}

/** AFS-140: why a project's source could not be read when it was added, said once. */
function SourceRefusal() {
  const [said] = useState(() => {
    const why = sourceRefusal;
    sourceRefusal = undefined;
    return why;
  });
  return said ? (
    // AFS-150: why is said once, under Last look.
    <p className="notice error" role="alert">
      The project was added, but its source cannot be read. Check the address and what it signs in
      with below.
    </p>
  ) : null;
}

/** AFS-140: the address of an external project's source, changed by administrators. */
function SourceAddress({ project, onSaved }: { project: Project; onSaved(): void }) {
  const [url, setUrl] = useState(project.gitUrl ?? '');
  return (
    <Form
      quiet
      submit="Change the address and look"
      onSubmit={async () => {
        if (url.trim() === project.gitUrl) refuse('gitUrl', 'This is the address already.');
        await api.changeProject(project.id, { gitUrl: url.trim() });
        onSaved();
      }}
    >
      <Field
        label="Repository address"
        name="gitUrl"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        required
        spellCheck={false}
        hint="https://, ssh:// or git@host:path. The project's commit is read again from it."
      />
    </Form>
  );
}

/**
 * AFS-150: a project's name, description and branch, changed by administrators. A new branch is
 * what its flows and runs are of from then on.
 */
export function ProjectDetails({
  project,
  branches,
  onSaved,
}: {
  project: Project;
  branches: string[];
  onSaved(): void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [branch, setBranch] = useState(project.gitRef);
  const [saved, setSaved] = useState(false);
  return (
    <Form
      quiet
      submit="Save"
      onSubmit={async () => {
        setSaved(false);
        if (!name.trim()) refuse('name', 'A name is needed.');
        const change = {
          ...(name.trim() !== project.name ? { name: name.trim() } : {}),
          ...(description.trim() !== (project.description ?? '')
            ? { description: description.trim() || null }
            : {}),
          ...(branch !== project.gitRef ? { gitRef: branch } : {}),
        };
        if (Object.keys(change).length === 0) refuse('name', 'Nothing is changed.');
        if (
          change.gitRef &&
          !(await ask(
            `Run ${change.gitRef} instead of ${project.gitRef}? Flows, launches and schedules that name no branch take ${change.gitRef} from now on.`,
            { yes: `Run ${change.gitRef}` },
          ))
        )
          return;
        await api.changeProject(project.id, change);
        setSaved(true);
        onSaved();
      }}
    >
      <Field
        label="Name"
        name="name"
        value={name}
        onChange={(e) => {
          setSaved(false);
          setName(e.target.value);
        }}
        maxLength={200}
      />
      <Field
        label="Description"
        name="description"
        value={description}
        onChange={(e) => {
          setSaved(false);
          setDescription(e.target.value);
        }}
        maxLength={1000}
        hint="What the project is for, in a line."
      />
      <Labelled
        label="Branch"
        name="gitRef"
        hint="The branch whose commits run: flows, launch configurations and schedules that name no other."
      >
        {(props) => (
          <select
            {...props}
            name="gitRef"
            value={branch}
            onChange={(e) => {
              setSaved(false);
              setBranch(e.target.value);
            }}
          >
            {!branches.includes(project.gitRef) && (
              <option value={project.gitRef}>{project.gitRef}</option>
            )}
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        )}
      </Labelled>
      {saved && (
        <p className="notice ok" role="status">
          Saved.
        </p>
      )}
    </Form>
  );
}

/** AFS-58: an empty hosted project gets its first commit from a sample or an archive. */
function StartPanel({
  project,
  files,
  onStarted,
}: {
  project: Project;
  /** AFS-159: the project's Files tab, where playbooks are added before the first flow. */
  files: string;
  onStarted(): void;
}) {
  const [start, setStart] = useState<{
    from: 'empty' | 'sample' | 'archive';
    sample: string;
    archive?: File;
  }>({ from: 'sample', sample: 'hello' });
  const [refused, setRefused] = useState(() => {
    const said = startRefusal;
    startRefusal = undefined;
    return said;
  });
  return (
    <section className="panel" aria-labelledby="start">
      <h2 id="start">Start this project</h2>
      <p className="muted">
        The repository is empty. Give it a first commit from a sample or an archive of your files,
        or push one to {project.gitRef} with git:
      </p>
      <CloneHelp project={project} />
      <p className="muted" data-own-playbooks>
        Your own playbooks? Add them in <Link to={files}>Files</Link> (upload them, or a zip of the
        folder), then make a New flow and start it from one.
      </p>
      {refused && (
        <p className="notice error" role="alert">
          The archive was refused: {refused}
        </p>
      )}
      <Form
        submit="Start"
        onSubmit={async () => {
          let started: Project;
          if (start.from === 'archive') {
            if (!start.archive) return refuse('archive', 'Choose the archive to start with.');
            started = await api.startProject(project.id, start.archive);
          } else if (start.from === 'sample')
            started = await api.startProject(project.id, { sample: start.sample });
          else return;
          startedNote = await startedWords(started);
          onStarted();
        }}
      >
        <StartChoice
          value={start}
          onChange={(v) => {
            // AFS-140: the refusal of the archive before goes once another is chosen.
            setRefused(undefined);
            setStart(v);
          }}
          empty={false}
        />
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
    if (!(await ask(`Delete the branch ${b.name}?${lost}`, { yes: 'Delete', danger: true })))
      return;
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
      !(await ask(
        `Make ${b.name} the project's branch? Launch configurations and schedules that follow the project's branch run its commits from now on.`,
        { yes: 'Make it the branch' },
      ))
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
        <Scroll>
          <table>
            <thead>
              <tr>
                <th scope="col">Branch</th>
                <th scope="col">Newest commit</th>
                <th scope="col">Not on {project.gitRef}</th>
                {(mayChange || admin) && (
                  <th scope="col" className="act">
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
                    <td className="act">
                      {/* AFS-144: the buttons in a box of their own: the cell stays a cell. */}
                      <div className="actions">
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
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
      {adding && (
        <Form
          submit="Make the branch"
          onCancel={() => setAdding(false)}
          onSubmit={async () => {
            // AFS-192: a name git refuses, or one taken, is said here without asking the server.
            const name = input.name.trim();
            const why = refProblem(name);
            if (why) refuse('name', why);
            if (branches.some((b) => b.name === name))
              refuse('name', `There is a branch ${name} already`);
            await api.createBranch(project.id, {
              name,
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
                !(await ask('Make a new hook token? The git host must be given the new one.', {
                  yes: 'Make a new token',
                  danger: true,
                }))
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
                if (
                  !(await ask('Remove the push hook? Calls with its token are refused.', {
                    yes: 'Remove',
                    danger: true,
                  }))
                )
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
export type ProjectTab = '' | 'runs' | 'history' | 'branches' | 'settings';

/** AFS-206: a workspace's tabs, as a mistyped address may name them. */
const WORKSPACE_TAB_KEYS = ['access', 'environments', 'credentials'];

/** AFS-206: the lead of a project's page for who sees some of its flows only. */
const seeFlows = (n: number) => `You see ${n} flow${n === 1 ? '' : 's'} of this project`;

/** How many runs a project's page asks for: its Runs tab lists them, Overview the newest few. */
const RUNS_SHOWN = 100;
/** AFS-149: how a push came, in the Pushes list. */
const PUSH_KIND: Record<string, string> = {
  push: 'git push',
  save: 'draft saved',
  files: 'files changed',
  branch: 'branch',
  start: 'project started',
};

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
  // AFS-206: a workspace's tab typed without its `-` (/w/network/access) goes to the tab, when no
  // project has that key.
  const gone = !found.loading && !found.error && !project;
  useEffect(() => {
    if (gone && !tab && WORKSPACE_TAB_KEYS.includes(key))
      navigate(`/w/${workspace}/-/${key}`, { replace: true });
  }, [gone, tab, key, workspace]);
  const id = project?.id;
  const accessState = useProjectAccess(id);
  const access = accessState.data;
  // AFS-206: grants on some flows only: those flows and their runs are all the page shows; the
  // repository's tabs are not offered (the server refuses or narrows what they read). What they
  // read is asked once the access is known, so it is not asked for such a person at all.
  const flowOnly = !me.admin && !!access?.flowOnly;
  const repository = !!id && (access ? !flowOnly : !!accessState.error);
  // AFS-139: read again when the project's commit moves (a start from a sample or an archive, a
  // push, a branch made elsewhere): the Branches tab and its count follow without a reload.
  const branchList = useLoad(
    async () => (id && repository ? await api.branches(id) : undefined),
    [id, project?.commit, repository],
  );
  const pushes = useLoad(
    async () => (id && repository ? api.pushes(id) : []),
    [id, project?.commit, repository],
  );
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
  // AFS-140: what the look found, said beside the button (not only a new time).
  const [looked, setLooked] = useState<{ ok: boolean; text: string }>();
  const look = async () => {
    if (!id) return;
    setLooking(true);
    setLooked(undefined);
    const after = await api.syncProject(id).catch((e) => messageOf(e));
    setLooked(
      typeof after === 'string'
        ? { ok: false, text: after }
        : after.sync.state === 'error'
          ? { ok: false, text: `The source cannot be read: ${after.sync.error ?? 'no answer'}` }
          : {
              ok: true,
              text: after.commit
                ? `The source answered: ${after.gitRef} is at ${after.commit.slice(0, 12)}.`
                : 'The source answered.',
            },
    );
    setLooking(false);
    found.reload();
    branchList.reload();
  };
  const crumbs = (
    <Breadcrumb>
      <Link to="/workspaces">Workspaces</Link> /{' '}
      <Link to={`/w/${workspace}`}>
        <WorkspaceName workspace={workspace} />
      </Link>{' '}
      / {/* AFS-152: the page reads its project already; the crumb does not ask again. */}
      <span aria-current="page" className="crumb-name" title={project?.name ?? key}>
        {project?.name ?? key}
      </span>
    </Breadcrumb>
  );
  if (!project)
    return found.loading ? (
      <>
        {crumbs}
        <PageHead title={key} />
        <Loading state={found} />
      </>
    ) : (
      // AFS-143, AFS-152: what was looked for, with a way back to a page the person can open.
      <MissingProject workspace={workspace} project={key} error={found.error} />
    );
  const address = `${window.location.origin}${project.gitPath}`;
  const mayPush = me.admin || access?.workspace === 'rw';
  const mayReadFiles = me.admin || atLeast(access?.workspace ?? null, 'ro');
  const base = `/w/${workspace}/${key}`;
  const repositoryTabs = [
    // Everything else in the repository (AFS-78) is a page of its own.
    // AFS-159: an empty project the server hosts takes files before its first flow too.
    ...(project.commit || (project.hosted && mayPush) ? [{ key: 'files', label: 'Files' }] : []),
    // AFS-123: the commits of the project, for who may read its files.
    ...(project.commit && mayReadFiles ? [{ key: 'history', label: 'History' }] : []),
    {
      key: 'branches',
      label: 'Branches',
      ...(branchList.data?.details ? { count: branchList.data.details.length } : {}),
    },
    { key: 'settings', label: 'Settings' },
  ];
  // AFS-192: a mirror whose source cannot be read (or has no commit yet) shows Source first:
  // the problem and the address to fix come before the rest of the settings.
  const sourceFirst = !project.hosted && (project.sync.state === 'error' || !project.commit);
  const source = !project.hosted && (
    <section className="panel" aria-labelledby="source">
      <h2 id="source">Source</h2>
      <SourceRefusal />
      <dl className="facts">
        <dt>Repository</dt>
        <dd>
          <code>{project.gitUrl}</code>
        </dd>
        <dt>Last look</dt>
        <dd>
          <SyncBadge project={project} /> {project.sync.at && <Time at={project.sync.at} />}
          {project.sync.error && <div className="bad-text">{project.sync.error}</div>}
        </dd>
      </dl>
      {me.admin && <SourceAddress project={project} onSaved={found.reload} />}
      {sshUrl(project.gitUrl) && (
        <HostKey project={project} admin={me.admin} onChanged={found.reload} />
      )}
      {me.admin && signsIn(project.gitUrl) && (
        <SourceSignIn project={project} workspace={workspace} onSaved={found.reload} />
      )}
    </section>
  );
  return (
    <>
      {crumbs}
      <PageHead
        help="workspaces-and-projects.md"
        title={project.name}
        lead={
          <>
            {project.description && <>{project.description} · </>}
            {flowOnly
              ? seeFlows(Object.keys(access?.flows ?? {}).length)
              : project.hosted
                ? 'Kept by this server'
                : `Mirror of ${project.gitUrl}`}
            {access && (
              <>
                {' · '}
                <ProjectYourAccess access={access} flows={flows.data?.flows} />
              </>
            )}
          </>
        }
      >
        {mayPush && !project.hosted && (
          <button type="button" onClick={look} disabled={looking}>
            {looking ? 'Looking…' : 'Look at the source now'}
          </button>
        )}
      </PageHead>
      <ProjectStatus
        project={project}
        me={me}
        base={base}
        quiet={tab === 'settings' && !project.hosted}
      />
      {looked && (
        <p className={looked.ok ? 'notice' : 'notice error'} role="status">
          {/* AFS-150: on Settings the reason is under Last look: said there only. */}
          {!looked.ok && tab === 'settings'
            ? 'Looked again: the source still cannot be read (see Last look under Source).'
            : looked.text}
        </p>
      )}
      <Tabs
        label="Project"
        base={base}
        current={tab}
        tabs={[
          { key: '', label: 'Overview' },
          { key: 'runs', label: 'Runs' },
          // AFS-206: nothing of the repository for who sees some of its flows only.
          ...(flowOnly ? [] : repositoryTabs),
        ]}
      />
      {flowOnly && tab !== '' && tab !== 'runs' && (
        <p className="empty">
          You see only the flows you were given here and their runs. The project's files, history,
          branches and settings are for who has access to the whole workspace: ask an administrator
          for it.
        </p>
      )}

      {tab === '' && (
        <>
          {project.hosted && !project.commit && mayPush && (
            <StartPanel project={project} files={`${base}/files`} onStarted={found.reload} />
          )}
          {/* AFS-171: a mirror with no commit has no Files tab and no New flow: why, and what to do. */}
          {!project.hosted && !project.commit && (
            <p className="notice" role="status">
              <strong>No files or flows yet.</strong> This project mirrors{' '}
              <code>{project.gitUrl}</code>: its files come from there and are added there, not
              here.{' '}
              {project.sync.state === 'error'
                ? 'The server cannot read it yet (the reason is above).'
                : 'The server has no commit of it yet.'}{' '}
              If the repository is empty, push a first commit to <code>{project.gitRef}</code> with
              git; the server looks again by itself
              {mayPush ? (
                <>
                  , or use <strong>Look at the source now</strong>
                </>
              ) : null}
              . The Files tab and New flow come with the first commit.
            </p>
          )}
          {project.commit && <StartedNote />}

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
                  ? mayPush
                    ? 'No flow yet: make a New flow and start it from a playbook of the project, a sample or an AWX template.'
                    : 'No flow in this project: a flow is a file named *.flow.yaml.'
                  : project.hosted && mayPush
                    ? 'Nothing yet: the project has no commit. Add your playbooks in Files, then make a New flow and start it from one; or start the project from a sample or an archive.'
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
            <p className="empty">
              {/* AFS-152: where runs start, only to who may start one. */}
              {launchesInProject(access)
                ? 'No run yet. Runs start from a launch configuration.'
                : 'No run yet.'}
            </p>
          )}
          {!!runs.data?.length && <RunList runs={runs.data} me={me} />}
          {runs.data?.length === RUNS_SHOWN && (
            <p className="muted">
              The newest {RUNS_SHOWN} are listed. <Link to="/runs">All runs</Link> has the rest.
            </p>
          )}
        </section>
      )}

      {tab === 'history' &&
        !flowOnly &&
        (project.commit && mayReadFiles ? (
          <ProjectHistory workspace={workspace} project={project} />
        ) : access ? (
          <p className="empty">
            {project.commit
              ? 'The history is for who may read the project’s files.'
              : 'No commits yet.'}
          </p>
        ) : null)}

      {tab === 'branches' && !flowOnly && (
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
              <Scroll>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Who</th>
                      <th scope="col">How</th>
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
                        {/* AFS-149: names, as the commits have them; the login says who exactly. */}
                        <td title={p.login}>{p.name ?? p.login}</td>
                        <td>{PUSH_KIND[p.kind ?? ''] ?? 'push'}</td>
                        <td>
                          <code>{p.ref}</code>
                        </td>
                        <td>
                          <code>{p.from?.slice(0, 8) ?? 'new'}</code> →{' '}
                          <code>{p.to?.slice(0, 8) ?? 'deleted'}</code>
                          {p.message ? <span className="muted"> {p.message}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
          </section>
        </>
      )}

      {tab === 'settings' && !flowOnly && (
        <>
          {sourceFirst && source}
          {me.admin && (
            <section className="panel" aria-labelledby="details">
              <h2 id="details">Name and branch</h2>
              <ProjectDetails
                project={project}
                branches={(branchList.data?.details ?? []).map((b) => b.name)}
                onSaved={() => {
                  found.reload();
                  branchList.reload();
                }}
              />
            </section>
          )}
          {/* The repository holds every flow: it is for who has a level on the workspace. */}
          {/* AFS-192: a mirror with no commit has nothing to clone yet. */}
          {(me.admin || access?.workspace) && (project.hosted || project.commit) && (
            <section className="panel" aria-labelledby="git">
              <h2 id="git">Work on it with git</h2>
              <CloneHelp project={project} />
              {/* AFS-194: said before a push is refused. */}
              {!me.admin && access?.workspace !== 'rw' && (
                <p className="muted">
                  You may clone and pull. Pushing needs read and write on the workspace.
                </p>
              )}
              {project.hosted && !project.commit && (
                <p className="muted">
                  The repository is empty: push a first commit to {project.gitRef}.
                </p>
              )}
            </section>
          )}

          {!sourceFirst && source}

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
        {/* AFS-153: a flow with no step is not healthy, it is not started. */}
        {flow.errors === 0 && flow.warnings === 0 && flow.steps === 0 && (
          <span className="badge" title="Open it and choose Edit to add steps">
            no steps yet
          </span>
        )}
        {flow.errors === 0 && flow.warnings === 0 && flow.steps !== 0 && (
          <span className="badge ok">no findings</span>
        )}
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
  // AFS-143: says the address looked for, the way home and where help is.
  return (
    <>
      <PageHead title="Nothing here" />
      <p className="empty">
        There is no page at <code>{window.location.pathname}</code>. <Link to="/">Go home</Link> or
        see <Link to="/help">Help</Link>.
      </p>
    </>
  );
}
