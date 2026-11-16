// The application: who is signed in, the frame around every page (a side menu, AFS-64), and
// which page an address is.

import { useCallback, useEffect, useState } from 'react';
import logo from '../../media/icons/svg/afs-icon-small.svg';
import { Account } from './account';
import { ApiError, api, setSignedOutHandler, type User } from './api';
import { ApiDocs } from './apidocs';
import { ApprovalsPage } from './approvals';
import { AuditPage } from './audit';
import { CertificateBanner, CertificatePage } from './certificate';
import { Entry, Setup, SignIn } from './entry';
import { EnvironmentPage } from './environments';
import { FilesPage } from './files';
import { FlowPage } from './flow';
import { Home } from './home';
import { LaunchConfigEdit, LaunchConfigPage } from './launch';
import { LibraryPage } from './library';
import { NotificationsPage } from './notifications';
import { NotFound, ProjectPage, Workspace, Workspaces } from './pages';
import { GroupPage, PeoplePage, UserPage } from './people';
import { Link, match, navigate, usePath } from './router';
import { RunPage, RunsPage } from './runs';
import { SearchBox } from './search';
import { SignInPage } from './signin';
import { applyTheme, nextTheme, storedTheme, type ThemeChoice } from './theme';
import { useLoad } from './ui';

type Session =
  | { state: 'loading' }
  | { state: 'unreachable'; message: string }
  | { state: 'setup' }
  | { state: 'signed-out' }
  | { state: 'signed-in'; user: User };

const THEME_LABEL: Record<ThemeChoice, string> = {
  dark: 'Theme: dark',
  light: 'Theme: light',
  system: 'Theme: as the device',
};

/** The page an address is. */
function Page({ path, me, theme }: { path: string; me: User; theme: ThemeChoice }) {
  // A flow's address ends with its file's path, which has slashes of its own.
  const flow = /^\/w\/([^/]+)\/([^/]+)\/flow\/(.+)$/.exec(path);
  if (flow) {
    try {
      const [workspace, project, file] = flow.slice(1).map(decodeURIComponent);
      if (workspace && project && file)
        return <FlowPage workspace={workspace} project={project} file={file} theme={theme} />;
    } catch {
      return <NotFound />;
    }
  }
  if (path === '/') return <Home me={me} />;
  if (path === '/workspaces') return <Workspaces me={me} />;
  if (path === '/runs') return <RunsPage me={me} />;
  const one = match('/runs/:id', path);
  if (one?.id) return <RunPage id={one.id} me={me} theme={theme} />;
  if (path === '/account') return <Account me={me} tab="profile" />;
  if (path === '/account/tokens') return <Account me={me} tab="tokens" />;
  if (path === '/docs/api') return <ApiDocs />;
  if (path === '/approvals') return <ApprovalsPage />;
  if (path === '/library') return <LibraryPage />;
  // AFS-87: the side menu lists the administration's pages; its own address opens the first.
  if (path === '/admin') return me.admin ? <PeoplePage tab="people" /> : <NotFound />;
  if (path === '/admin/audit') return me.admin ? <AuditPage /> : <NotFound />;
  if (path === '/admin/notifications')
    return me.admin ? <NotificationsPage tab="log" /> : <NotFound />;
  if (path === '/admin/notifications/settings')
    return me.admin ? <NotificationsPage tab="settings" /> : <NotFound />;
  if (path === '/admin/certificate') return me.admin ? <CertificatePage /> : <NotFound />;
  if (path === '/admin/sign-in') return me.admin ? <SignInPage /> : <NotFound />;
  if (path === '/admin/people') return me.admin ? <PeoplePage tab="people" /> : <NotFound />;
  if (path === '/admin/groups') return me.admin ? <PeoplePage tab="groups" /> : <NotFound />;
  const person = match('/admin/people/:id', path);
  if (person?.id) return me.admin ? <UserPage id={person.id} me={me} /> : <NotFound />;
  const group = match('/admin/groups/:id', path);
  if (group?.id) return me.admin ? <GroupPage id={group.id} /> : <NotFound />;
  const environment = match('/w/:workspace/environments/:id', path);
  if (environment?.workspace && environment.id)
    return <EnvironmentPage workspace={environment.workspace} id={environment.id} />;
  const config = match('/w/:workspace/:project/launch/:id', path);
  if (config?.workspace && config.project && config.id)
    return config.id === 'new' ? (
      <LaunchConfigEdit workspace={config.workspace} project={config.project} />
    ) : (
      <LaunchConfigPage
        me={me}
        workspace={config.workspace}
        project={config.project}
        id={config.id}
        tab="launch"
      />
    );
  // AFS-85: a launch configuration's tabs; `edit` is the old address of its settings.
  const part = match('/w/:workspace/:project/launch/:id/:tab', path);
  if (part?.workspace && part.project && part.id && part.tab) {
    const tab = part.tab === 'edit' ? 'settings' : part.tab;
    if (tab === 'runs' || tab === 'schedules' || tab === 'settings')
      return (
        <LaunchConfigPage
          me={me}
          workspace={part.workspace}
          project={part.project}
          id={part.id}
          tab={tab}
        />
      );
  }
  const files = match('/w/:workspace/:project/files', path);
  if (files?.workspace && files.project)
    return <FilesPage me={me} workspace={files.workspace} project={files.project} theme={theme} />;
  const workspace = match('/w/:workspace', path);
  if (workspace?.workspace) return <Workspace me={me} workspace={workspace.workspace} />;
  // AFS-84: a workspace's tabs sit under `-`, which no project's key can be.
  const inSpace = match('/w/:workspace/-/:tab', path);
  if (
    inSpace?.workspace &&
    (inSpace.tab === 'environments' || inSpace.tab === 'credentials' || inSpace.tab === 'access')
  )
    return <Workspace me={me} workspace={inSpace.workspace} tab={`-/${inSpace.tab}`} />;
  const project = match('/w/:workspace/:project', path);
  if (project?.workspace && project.project)
    return <ProjectPage me={me} workspace={project.workspace} project={project.project} />;
  const inProject = match('/w/:workspace/:project/:tab', path);
  if (
    inProject?.workspace &&
    inProject.project &&
    (inProject.tab === 'runs' || inProject.tab === 'branches' || inProject.tab === 'settings')
  )
    return (
      <ProjectPage
        me={me}
        workspace={inProject.workspace}
        project={inProject.project}
        tab={inProject.tab}
      />
    );
  return <NotFound />;
}

/** The side menu: the places, the workspaces, and the person's own things at the end. */
function Side({
  me,
  path,
  theme,
  onTheme,
  onSignOut,
}: {
  me: User;
  path: string;
  theme: ThemeChoice;
  onTheme(): void;
  onSignOut(): void;
}) {
  const [open, setOpen] = useState(false);
  const workspaces = useLoad(api.workspaces, []);
  const approvals = useLoad(api.approvals, []);
  // Approvals arrive while pages are open: the count looks again now and then.
  useEffect(() => {
    const timer = setInterval(approvals.reload, 30_000);
    return () => clearInterval(timer);
  }, [approvals.reload]);
  // A workspace made or renamed since: the list reads again when one it lacks is opened.
  const here = /^\/w\/([^/]+)/.exec(path)?.[1];
  const known = workspaces.data?.some((w) => w.key === here);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads again only for a new workspace
  useEffect(() => {
    if (here && workspaces.data && !known) workspaces.reload();
  }, [here]);
  // The menu folds away on a phone once a page is picked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on every new page
  useEffect(() => setOpen(false), [path]);

  const waiting = approvals.data?.filter((a) => a.mayDecide).length ?? 0;
  const at = (to: string) =>
    path === to ||
    (to === '/runs' && path.startsWith('/runs/')) ||
    // People and groups are one place of the administration, at several addresses.
    (to === '/admin/people' && (path === '/admin' || path.startsWith('/admin/groups'))) ||
    (to.startsWith('/admin/') && path.startsWith(`${to}/`)) ||
    (to !== '/' && to.startsWith('/w/') && path.startsWith(`${to}/`))
      ? 'page'
      : undefined;

  return (
    <div className={open ? 'side open' : 'side'}>
      <div className="side-head">
        <Link to="/" className="brand">
          <img src={logo} alt="" width="28" height="28" />
          <span>Ansible Flow Server</span>
        </Link>
        <button
          type="button"
          className="menu-toggle"
          aria-expanded={open}
          aria-controls="side-menu"
          onClick={() => setOpen(!open)}
        >
          Menu
        </button>
      </div>
      <div className="side-body" id="side-menu">
        <nav aria-label="Main" className="side-nav">
          <Link to="/" aria-current={at('/')}>
            Home
          </Link>
          <Link to="/runs" aria-current={at('/runs')}>
            Runs
          </Link>
          <Link to="/approvals" aria-current={at('/approvals')}>
            Approvals
            {waiting > 0 && (
              <span className="count" title={`${waiting} waiting for you`}>
                {waiting}
              </span>
            )}
          </Link>
          <Link to="/library" aria-current={at('/library')}>
            Library
          </Link>
        </nav>
        <nav aria-label="Workspaces" className="side-nav">
          <span className="side-label">
            <Link to="/workspaces" aria-current={at('/workspaces')}>
              Workspaces
            </Link>
          </span>
          {workspaces.data?.map((w) => (
            <Link key={w.id} to={`/w/${w.key}`} aria-current={at(`/w/${w.key}`)}>
              {w.name}
            </Link>
          ))}
        </nav>
        {me.admin && (
          // AFS-87: the administration's pages are in the menu, not behind an index page.
          <nav aria-label="Administration" className="side-nav">
            <span className="side-label">Administration</span>
            <Link to="/admin/people" aria-current={at('/admin/people')}>
              People and groups
            </Link>
            <Link to="/admin/sign-in" aria-current={at('/admin/sign-in')}>
              Sign-in
            </Link>
            <Link to="/admin/certificate" aria-current={at('/admin/certificate')}>
              Server certificate
            </Link>
            <Link to="/admin/notifications" aria-current={at('/admin/notifications')}>
              Notifications
            </Link>
            <Link to="/admin/audit" aria-current={at('/admin/audit')}>
              Audit log
            </Link>
          </nav>
        )}
        <div className="side-end">
          <Link to="/account" aria-current={at('/account')}>
            {me.name}
          </Link>
          <button type="button" onClick={onTheme}>
            {THEME_LABEL[theme]}
          </button>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const [theme, setTheme] = useState<ThemeChoice>(storedTheme);
  const path = usePath();

  const load = useCallback(async () => {
    try {
      setSession({ state: 'signed-in', user: await api.me() });
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401)
        return setSession({
          state: 'unreachable',
          message: e instanceof ApiError ? e.message : 'The page could not start.',
        });
      // Nobody is signed in: a new server asks for its first administrator instead.
      const needed = await api.setupNeeded().then(
        (reply) => reply.needed,
        () => false,
      );
      setSession({ state: needed ? 'setup' : 'signed-out' });
    }
  }, []);
  useEffect(() => {
    setSignedOutHandler(() => setSession({ state: 'signed-out' }));
    void load();
  }, [load]);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const signedIn = (user: User) => {
    // /signin is only the page a refused provider sign-in comes back to: nothing is there once in.
    if (window.location.pathname === '/signin') navigate('/', { replace: true });
    setSession({ state: 'signed-in', user });
  };
  const me = session.state === 'signed-in' ? session.user : undefined;
  const skip = (
    <a href="#main" className="skip">
      Skip to the page
    </a>
  );

  if (!me)
    return (
      <>
        {skip}
        {session.state === 'loading' && (
          <Entry>
            <p className="muted" aria-live="polite">
              Loading…
            </p>
          </Entry>
        )}
        {session.state === 'unreachable' && (
          <Entry title="Ansible Flow Server">
            <p className="notice error" role="alert">
              {session.message}
            </p>
            <button type="button" className="primary" onClick={() => void load()}>
              Try again
            </button>
          </Entry>
        )}
        {session.state === 'setup' && <Setup onDone={signedIn} />}
        {session.state === 'signed-out' && <SignIn onDone={signedIn} />}
      </>
    );

  // AFS-96: pages to work on (a project's files, an environment's spec) take the screen's width;
  // pages to read (lists, forms) keep to a column.
  const kind = /\/flow\//.test(path)
    ? 'page wide'
    : match('/runs/:id', path)
      ? 'page run'
      : match('/w/:workspace/:project/files', path)
        ? 'page full'
        : match('/w/:workspace/environments/:id', path)
          ? 'page broad'
          : 'page';
  return (
    <>
      {skip}
      <div className="shell">
        <Side
          me={me}
          path={path}
          theme={theme}
          onTheme={() => setTheme(nextTheme(theme))}
          onSignOut={async () => {
            await api.signOut().catch(() => undefined);
            setSession({ state: 'signed-out' });
          }}
        />
        <div className="main-col">
          <div className="bar">
            <SearchBox me={me} />
          </div>
          <main id="main" className={kind}>
            {me.admin && <CertificateBanner path={path} />}
            <Page path={path} me={me} theme={theme} />
          </main>
        </div>
      </div>
    </>
  );
}
