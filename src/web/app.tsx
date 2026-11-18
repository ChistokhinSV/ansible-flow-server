// The application: who is signed in, the frame around every page (a side menu, AFS-64), and
// which page an address is.

import { useCallback, useEffect, useRef, useState } from 'react';
import logo from '../../media/icons/svg/afs-icon-small.svg';
import { Account } from './account';
import { ApiError, api, setSignedOutHandler, type User } from './api';
import { ApiDocs } from './apidocs';
import { APPROVALS_CHANGED, ApprovalsPage } from './approvals';
import { AuditPage } from './audit';
import { CertificateBanner, CertificatePage } from './certificate';
import { Entry, Setup, SignIn } from './entry';
import { EnvironmentPage } from './environments';
import { FilesPage } from './files';
import { FlowPage } from './flow';
import { HelpPage } from './help';
import { Home } from './home';
import { LaunchConfigEdit, LaunchConfigPage } from './launch';
import { LibraryPage } from './library';
import { NotificationsPage } from './notifications';
import { AdminOnly, NotFound, ProjectPage, Workspace, Workspaces } from './pages';
import { GroupPage, PeoplePage, UserPage } from './people';
import { Link, match, navigate, usePath } from './router';
import { RunPage, RunsPage } from './runs';
import { SearchBox } from './search';
import { SignInPage } from './signin';
import { applyTheme, nextTheme, storedTheme, type ThemeChoice } from './theme';
import { BarSlot, useLoad } from './ui';

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
        return (
          <FlowPage me={me} workspace={workspace} project={project} file={file} theme={theme} />
        );
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
  // AFS-143: help, at the addresses people try.
  if (path === '/help' || path === '/guide' || path === '/docs') return <HelpPage />;
  if (path === '/approvals') return <ApprovalsPage />;
  if (path === '/library') return <LibraryPage />;
  // AFS-87: the side menu lists the administration's pages; its own address opens the first.
  if (path === '/admin') return me.admin ? <PeoplePage tab="people" /> : <AdminOnly />;
  if (path === '/admin/audit') return me.admin ? <AuditPage /> : <AdminOnly />;
  if (path === '/admin/notifications')
    return me.admin ? <NotificationsPage tab="log" /> : <AdminOnly />;
  if (path === '/admin/notifications/settings')
    return me.admin ? <NotificationsPage tab="settings" /> : <AdminOnly />;
  if (path === '/admin/certificate') return me.admin ? <CertificatePage /> : <AdminOnly />;
  if (path === '/admin/sign-in') return me.admin ? <SignInPage /> : <AdminOnly />;
  if (path === '/admin/people') return me.admin ? <PeoplePage tab="people" /> : <AdminOnly />;
  if (path === '/admin/groups') return me.admin ? <PeoplePage tab="groups" /> : <AdminOnly />;
  const person = match('/admin/people/:id', path);
  if (person?.id) return me.admin ? <UserPage id={person.id} me={me} /> : <AdminOnly />;
  const group = match('/admin/groups/:id', path);
  if (group?.id) return me.admin ? <GroupPage id={group.id} /> : <AdminOnly />;
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

/**
 * AFS-142: after a page change the focus goes to the new page's title, as a screen reader expects,
 * not to the page's body. The title may come once the page has loaded, so it is watched for a
 * while. Focus still on something in the page (a tab of the same page, a field) stays there.
 */
export function useFocusOnNewPage(path: string): void {
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the page changes
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const main = document.getElementById('main');
    if (!main) return;
    const here = document.activeElement;
    if (here && here !== document.body && main.contains(here)) return;
    const place = () => {
      const title = main.querySelector('h1');
      if (!title) return false;
      if (!title.hasAttribute('tabindex')) title.setAttribute('tabindex', '-1');
      title.focus({ preventScroll: true });
      return true;
    };
    if (place()) return;
    const watch = new MutationObserver(() => {
      if (place()) stop();
    });
    const stop = () => {
      watch.disconnect();
      clearTimeout(timer);
      document.removeEventListener('focusin', stop);
    };
    watch.observe(main, { childList: true, subtree: true });
    const timer = setTimeout(stop, 5000);
    // The person moved on before the title came: their focus wins.
    document.addEventListener('focusin', stop);
    return stop;
  }, [path]);
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
    // AFS-133: a decision made on any page counts at once.
    window.addEventListener(APPROVALS_CHANGED, approvals.reload);
    // AFS-146: and one made on a run's canvas (the designer's frame says so).
    const fromFrame = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if ((event.data as { type?: string } | null)?.type === APPROVALS_CHANGED) approvals.reload();
    };
    window.addEventListener('message', fromFrame);
    return () => {
      clearInterval(timer);
      window.removeEventListener(APPROVALS_CHANGED, approvals.reload);
      window.removeEventListener('message', fromFrame);
    };
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
  // AFS-142: Escape folds the phone menu and gives the focus back to its button.
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

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
          ref={toggle}
          type="button"
          className="menu-toggle"
          aria-expanded={open}
          aria-controls="side-menu"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Close menu' : 'Menu'}
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
        {/* AFS-152: no empty heading for who has no workspace yet (Home says whom to ask). */}
        {(me.admin || !!workspaces.data?.length) && (
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
        )}
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
          <Link to="/help" aria-current={at('/help')}>
            Help
          </Link>
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
      const user = await api.me();
      if (user) return setSession({ state: 'signed-in', user });
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401)
        return setSession({
          state: 'unreachable',
          message: e instanceof ApiError ? e.message : 'The page could not start.',
        });
    }
    // Nobody is signed in: a new server asks for its first administrator instead.
    const needed = await api.setupNeeded().then(
      (reply) => reply.needed,
      () => false,
    );
    setSession({ state: needed ? 'setup' : 'signed-out' });
  }, []);
  useEffect(() => {
    setSignedOutHandler(() => setSession({ state: 'signed-out' }));
    void load();
  }, [load]);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  // AFS-107: the top bar's place for a page's breadcrumbs.
  const [barSlot, setBarSlot] = useState<HTMLElement | null>(null);
  useFocusOnNewPage(path);

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

  // AFS-94: pages to work on (a project's files, an environment's spec) take the screen's width;
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
            // AFS-134: the next person starts at the start page, not this one's last page.
            window.history.replaceState(null, '', '/');
            setSession({ state: 'signed-out' });
          }}
        />
        <div className="main-col">
          {/* AFS-107: the bar is as wide as the page under it, and holds the page's breadcrumbs. */}
          <div className={`bar ${kind.replace('page', 'bar-of')}`}>
            <div className="bar-crumbs" ref={setBarSlot} />
            <SearchBox me={me} />
          </div>
          <main id="main" className={kind}>
            {me.admin && <CertificateBanner path={path} />}
            <BarSlot.Provider value={barSlot}>
              <Page path={path} me={me} theme={theme} />
            </BarSlot.Provider>
          </main>
        </div>
      </div>
    </>
  );
}
