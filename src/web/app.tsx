// The application: who is signed in, the frame around every page, and which page an address is.

import { useCallback, useEffect, useState } from 'react';
import logo from '../../media/icons/svg/afs-icon-small.svg';
import { ApiError, api, setSignedOutHandler, type User } from './api';
import { AdminPage, AuditPage } from './audit';
import { LaunchConfigEdit, LaunchConfigPage } from './launch';
import {
  Account,
  FlowPage,
  NotFound,
  ProjectPage,
  Setup,
  SignIn,
  Workspace,
  Workspaces,
} from './pages';
import { Link, match, usePath } from './router';
import { RunPage, RunsPage } from './runs';
import { applyTheme, nextTheme, storedTheme, type ThemeChoice } from './theme';

type Session =
  | { state: 'loading' }
  | { state: 'unreachable'; message: string }
  | { state: 'setup' }
  | { state: 'signed-out' }
  | { state: 'signed-in'; user: User };

const THEME_LABEL: Record<ThemeChoice, string> = {
  system: 'Theme: as the device',
  light: 'Theme: light',
  dark: 'Theme: dark',
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
  if (path === '/') return <Workspaces me={me} />;
  if (path === '/runs') return <RunsPage />;
  const one = match('/runs/:id', path);
  if (one?.id) return <RunPage id={one.id} me={me} theme={theme} />;
  if (path === '/account') return <Account me={me} />;
  if (path === '/admin') return me.admin ? <AdminPage /> : <NotFound />;
  if (path === '/admin/audit') return me.admin ? <AuditPage /> : <NotFound />;
  const config = match('/w/:workspace/:project/launch/:id', path);
  if (config?.workspace && config.project && config.id)
    return config.id === 'new' ? (
      me.admin ? (
        <LaunchConfigEdit workspace={config.workspace} project={config.project} />
      ) : (
        <NotFound />
      )
    ) : (
      <LaunchConfigPage
        me={me}
        workspace={config.workspace}
        project={config.project}
        id={config.id}
      />
    );
  const edit = match('/w/:workspace/:project/launch/:id/edit', path);
  if (edit?.workspace && edit.project && edit.id)
    return me.admin ? (
      <LaunchConfigEdit workspace={edit.workspace} project={edit.project} id={edit.id} />
    ) : (
      <NotFound />
    );
  const workspace = match('/w/:workspace', path);
  if (workspace?.workspace) return <Workspace me={me} workspace={workspace.workspace} />;
  const project = match('/w/:workspace/:project', path);
  if (project?.workspace && project.project)
    return <ProjectPage me={me} workspace={project.workspace} project={project.project} />;
  return <NotFound />;
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

  const signedIn = (user: User) => setSession({ state: 'signed-in', user });
  const me = session.state === 'signed-in' ? session.user : undefined;
  const at = (to: string) =>
    path === to ||
    (to === '/' && path.startsWith('/w/')) ||
    (to === '/runs' && path.startsWith('/runs/')) ||
    (to === '/admin' && path.startsWith('/admin/'))
      ? 'page'
      : undefined;

  return (
    <>
      <a href="#main" className="skip">
        Skip to the page
      </a>
      <header className="top">
        <Link to="/" className="brand">
          <img src={logo} alt="" width="28" height="28" />
          <span>Ansible Flow Server</span>
        </Link>
        {me && (
          <nav aria-label="Main">
            <Link to="/" aria-current={at('/')}>
              Workspaces
            </Link>
            <Link to="/runs" aria-current={at('/runs')}>
              Runs
            </Link>
            {me.admin && (
              <Link to="/admin" aria-current={at('/admin')}>
                Administration
              </Link>
            )}
          </nav>
        )}
        <div className="top-end">
          <button type="button" onClick={() => setTheme(nextTheme(theme))}>
            {THEME_LABEL[theme]}
          </button>
          {me && (
            <>
              <Link to="/account" aria-current={at('/account')}>
                {me.name}
              </Link>
              <button
                type="button"
                onClick={async () => {
                  await api.signOut().catch(() => undefined);
                  setSession({ state: 'signed-out' });
                }}
              >
                Sign out
              </button>
            </>
          )}
        </div>
      </header>
      {session.state === 'loading' && (
        <main className="narrow" id="main">
          <p className="muted" aria-live="polite">
            Loading…
          </p>
        </main>
      )}
      {session.state === 'unreachable' && (
        <main className="narrow" id="main">
          <p className="notice error" role="alert">
            {session.message}
          </p>
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </main>
      )}
      {session.state === 'setup' && <Setup onDone={signedIn} />}
      {session.state === 'signed-out' && <SignIn onDone={signedIn} />}
      {me && (
        <main id="main" className={/\/flow\//.test(path) ? 'page wide' : 'page'}>
          <Page path={path} me={me} theme={theme} />
        </main>
      )}
    </>
  );
}
