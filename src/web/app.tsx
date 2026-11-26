// The application: who is signed in, the frame around every page (a side menu, AFS-64), and
// which page an address is.

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import logo from '../../media/icons/svg/afs-icon-small.svg';
import { Account } from './account';
import { ActionEditPage } from './actionEdit';
import { ActionLinkPage } from './actionLinks';
import { ActionPage, ActionRunPage, ActionsPage } from './actions';
import { ApiError, api, setSignedOutHandler, type User } from './api';
import { ApiDocs } from './apiPage';
import { APPROVALS_CHANGED, ApprovalsPage } from './approvals';
import { AuditPage } from './audit';
import { CertificateBanner, CertificatePage } from './certificate';
import { useNarrow } from './debugger';
import { Entry, Setup, SignIn } from './entry';
import { EnvironmentPage } from './environments';
import { FilesPage } from './files';
import { FlowPage } from './flow';
import { GuidePage } from './guidePage';
import { HelpPage } from './help';
import { Home, midnight } from './home';
import { LaunchConfigEdit, LaunchConfigPage } from './launch';
import { LibraryPage } from './library';
import { NotificationsPage } from './notifications';
import { AdminOnly, NotFound, ProjectPage, Workspace, Workspaces } from './pages';
import { GroupPage, PeoplePage, UserPage } from './people';
import { Link, match, navigate, usePath } from './router';
import { RunPage, RunsPage } from './runs';
import { listenForSaveKey } from './saveKey';
import { SearchBox } from './search';
import { SecretProvidersPage } from './secretProviders';
import { ServerPage } from './serverPage';
import { SignInPage } from './signin';
import { StreamsPage } from './streams';
import { applyTheme, nextTheme, storedTheme, type ThemeChoice } from './theme';
import { BarSlot, Icon, type IconName, keepFold, keptFold, useLoad } from './ui';

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

/**
 * AFS-175: what the person reaches: whether they have actions, and whether actions are all they
 * have (no workspace, not an administrator): then Actions is their home and their menu.
 */
interface Reach {
  actions: number;
  actionOnly: boolean;
}

/** The page an address is. */
function Page({
  path,
  me,
  theme,
  reach,
}: {
  path: string;
  me: User;
  theme: ThemeChoice;
  reach?: Reach | undefined;
}) {
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
  if (path === '/') return reach?.actionOnly ? <ActionsPage home /> : <Home me={me} />;
  // AFS-175: actions, an action's form, and the progress of a run of one.
  if (path === '/actions') return <ActionsPage />;
  const actionRun = match('/actions/runs/:id', path);
  if (actionRun?.id) return <ActionRunPage run={actionRun.id} />;
  // AFS-201: an action's settings, on its own page.
  const actionEdit = match('/actions/:id/edit', path);
  if (actionEdit?.id) return <ActionEditPage id={actionEdit.id} />;
  const action = match('/actions/:id', path);
  if (action?.id) return <ActionPage id={action.id} />;
  // AFS-176: a link to an action from another system (NetBox, Zabbix), with values in its query.
  const linked = match('/a/:id', path);
  if (linked?.id) return <ActionLinkPage id={linked.id} />;
  if (path === '/workspaces') return <Workspaces me={me} />;
  if (path === '/runs') return <RunsPage me={me} />;
  const one = match('/runs/:id', path);
  if (one?.id) return <RunPage id={one.id} me={me} theme={theme} />;
  if (path === '/account') return <Account me={me} tab="profile" />;
  if (path === '/account/tokens') return <Account me={me} tab="tokens" />;
  if (path === '/docs/api') return <ApiDocs theme={theme} />;
  // AFS-143: help, at the addresses people try.
  if (path === '/help' || path === '/guide' || path === '/docs') return <HelpPage />;
  // AFS-155: the guide of this server's version, served by the server itself.
  if (path === '/help/guide' || path === '/help/guide/') return <GuidePage page="README.md" />;
  const guidePage = match('/help/guide/:page', path);
  if (guidePage?.page) return <GuidePage page={guidePage.page} />;
  if (path === '/approvals') return <ApprovalsPage />;
  if (path === '/library') return <LibraryPage admin={me.admin} />;
  // AFS-87: the side menu lists the administration's pages; its own address opens the first.
  if (path === '/admin') return me.admin ? <PeoplePage tab="people" /> : <AdminOnly />;
  if (path === '/admin/audit') return me.admin ? <AuditPage /> : <AdminOnly />;
  if (path === '/admin/notifications')
    return me.admin ? <NotificationsPage tab="log" /> : <AdminOnly />;
  if (path === '/admin/notifications/settings')
    return me.admin ? <NotificationsPage tab="settings" /> : <AdminOnly />;
  if (path === '/admin/certificate') return me.admin ? <CertificatePage /> : <AdminOnly />;
  // AFS-241: where credentials may read their secrets from.
  if (path === '/admin/secret-providers') return me.admin ? <SecretProvidersPage /> : <AdminOnly />;
  if (path === '/admin/streams') return me.admin ? <StreamsPage /> : <AdminOnly />;
  // AFS-274: Govern's Server: the server's parts, each with how it stands and its page.
  if (path === '/admin/server') return me.admin ? <ServerPage /> : <AdminOnly />;
  if (path === '/admin/sign-in') return me.admin ? <SignInPage /> : <AdminOnly />;
  if (path === '/admin/people') return me.admin ? <PeoplePage tab="people" /> : <AdminOnly />;
  if (path === '/admin/groups') return me.admin ? <PeoplePage tab="groups" /> : <AdminOnly />;
  const person = match('/admin/people/:id', path);
  if (person?.id) return me.admin ? <UserPage id={person.id} me={me} /> : <AdminOnly />;
  const group = match('/admin/groups/:id', path);
  if (group?.id) return me.admin ? <GroupPage id={group.id} /> : <AdminOnly />;
  const environment = match('/w/:workspace/environments/:id', path);
  if (environment?.workspace && environment.id)
    return (
      <EnvironmentPage workspace={environment.workspace} id={environment.id} admin={me.admin} />
    );
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
    (inProject.tab === 'runs' ||
      inProject.tab === 'history' ||
      inProject.tab === 'branches' ||
      inProject.tab === 'settings')
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

/** AFS-266: where this browser keeps the app menu folded to its icon rail. */
export const MENU_FOLDED = 'afs.menu.folded';
/** Up to this width the menu is the phone's (a Menu button over the page); it never folds there. */
const PHONE_MENU = '(max-width: 860px)';

/** The items of an open menu, in order. */
const menuItems = (box: HTMLElement | null): HTMLElement[] => [
  ...(box?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ?? []),
];

/** AFS-274: an item of a menu opened from a button: a page to go to, or a thing to do. */
interface PopItem {
  /**
   * Who the item is, kept while its words change: the theme's item says its new value, and two
   * workspaces may have one name. A new key would make a new element and drop the focus.
   */
  id: string;
  label: string;
  to?: string;
  current?: 'page' | undefined;
  onSelect?: () => void;
  /** One choice among several (a workspace): said as chosen or not. */
  checked?: boolean;
  /** Doing it leaves the menu open: the theme, whose item then says its new value. */
  stays?: boolean;
}

/**
 * AFS-266, AFS-274: a button that opens a menu: the rail's (beside the rail), the workspace
 * switcher (under its button) and the account (over its button). Held to the window, so the
 * menu's own scroller does not cut it off. The arrows, Home and End go through it; Escape closes
 * it and gives the focus back to its button (and leaves the phone menu open); a click outside, a
 * page picked or Tab closes it.
 */
function PopMenu({
  label,
  title,
  className,
  children,
  items,
  path,
  place,
}: {
  label: string;
  title: string;
  className: string;
  children: ReactNode;
  items: PopItem[];
  path: string;
  place: 'beside' | 'below' | 'above';
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<CSSProperties>({});
  // A page picked closes it (Link's own click navigates: one of the menu's would replace it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on every new page
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    (
      menuItems(box.current).find((i) => i.getAttribute('aria-checked') === 'true') ??
      menuItems(box.current)[0]
    )?.focus();
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  // Beside the rail's button, or under or over the menu's, kept inside the window when long.
  useLayoutEffect(() => {
    if (!open) return;
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const tall = list.current?.offsetHeight ?? 0;
    const room = window.innerHeight - tall - 8;
    setAt(
      place === 'beside'
        ? { top: Math.max(8, Math.min(r.top, room)) }
        : place === 'below'
          ? { top: Math.max(8, Math.min(r.bottom + 4, room)), left: r.left, minWidth: r.width }
          : { top: Math.max(8, r.top - tall - 4), left: r.left, minWidth: r.width },
    );
  }, [open, place]);
  const here = items.some((i) => i.current);
  // Escape is heard on the whole menu, not only its list: the focus may be on its button, or
  // anywhere in it a click left it, while it is open.
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open || e.key !== 'Escape') return;
    // The menu, not the phone menu around it.
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    button.current?.focus();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape for the menu inside it; its button and items are the controls
    <div className="pop-menu" ref={box} onKeyDown={onKey}>
      <button
        ref={button}
        type="button"
        className={`${className}${here ? ' here' : ''}`}
        aria-label={label}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {children}
      </button>
      {open && (
        <div
          ref={list}
          className={place === 'beside' ? 'rail-menu-list' : 'rail-menu-list pop-menu-list'}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          style={at}
          onKeyDown={(e) => {
            const all = menuItems(box.current);
            const now = all.indexOf(document.activeElement as HTMLElement);
            const to =
              e.key === 'ArrowDown'
                ? (now + 1) % all.length
                : e.key === 'ArrowUp'
                  ? (now - 1 + all.length) % all.length
                  : e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? all.length - 1
                      : undefined;
            if (to !== undefined) {
              e.preventDefault();
              all[to]?.focus();
            } else if (e.key === 'Tab') setOpen(false);
          }}
        >
          {items.map((i) =>
            i.to ? (
              <Link key={i.id} to={i.to} role="menuitem" aria-current={i.current}>
                {i.label}
              </Link>
            ) : (
              <button
                key={i.id}
                type="button"
                role={i.checked === undefined ? 'menuitem' : 'menuitemradio'}
                {...(i.checked === undefined ? {} : { 'aria-checked': i.checked })}
                onClick={() => {
                  i.onSelect?.();
                  if (!i.stays) setOpen(false);
                }}
              >
                {i.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** AFS-274: where this browser keeps the workspace the Build group was last on. */
export const KEPT_WORKSPACE = 'afs.workspace';
const keptWorkspace = (): string | undefined => {
  try {
    return window.localStorage.getItem(KEPT_WORKSPACE) ?? undefined;
  } catch {
    return undefined;
  }
};
const keepWorkspace = (key: string) => {
  try {
    window.localStorage.setItem(KEPT_WORKSPACE, key);
  } catch {
    // Storage closed (a private window): kept for this page's life only.
  }
};

/** A name's initials: the rail's mark for a workspace, and the account's. */
const initials = (name: string) =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || '?';

/** The Build tab a workspace's page is on (environments, credentials, access), to stay on it. */
const buildTab = (path: string) => {
  const m = /^\/w\/[^/]+\/(?:-\/(environments|credentials|access)\b|(environments)\/)/.exec(path);
  return m?.[1] ?? m?.[2];
};

/** The Server page's parts: the menu's Server is where any of them is. */
const SERVER_PAGES = [
  '/admin/server',
  '/admin/sign-in',
  '/admin/secret-providers',
  '/admin/certificate',
  '/admin/notifications',
  '/admin/streams',
];

/** A link of the menu: where it goes, its icon, and a count where there is one. */
interface MenuLink {
  to: string;
  icon: IconName;
  label: string;
  current: boolean;
  count?: number;
  /** What the count is, in words ("2 waiting for you"). */
  counted?: string;
}

/**
 * The side menu (AFS-274, ADR-0039 §10): Work (across every workspace you may see), Build (in the
 * workspace its switcher shows), Govern (administrators), and your account at its end. The same
 * groups folded to an icon rail, and on a phone behind Menu.
 */
function Side({
  me,
  path,
  theme,
  reach,
  onTheme,
  onSignOut,
}: {
  me: User;
  path: string;
  theme: ThemeChoice;
  reach?: Reach | undefined;
  onTheme(): void;
  onSignOut(): void;
}) {
  const [open, setOpen] = useState(false);
  // AFS-266: on a wide screen the menu folds to an icon rail, as this browser last left it.
  const phone = useNarrow(PHONE_MENU);
  const [folded, setFolded] = useState(() => keptFold(MENU_FOLDED));
  const fold = (to: boolean) => {
    setFolded(to);
    keepFold(MENU_FOLDED, to);
  };
  const workspaces = useLoad(api.workspaces, []);
  const approvals = useLoad(api.approvals, []);
  // AFS-274: the inbox's count, of every workspace (an action-only person has no inbox).
  const actionOnly = !!reach?.actionOnly;
  const inbox = useLoad(
    async () => (actionOnly ? undefined : api.inbox(midnight()).catch(() => undefined)),
    [actionOnly],
  );
  // The counts are read again on a page change, a decision and the canvas's word, which come in
  // bursts (a decision, then the page it leads to): at most once a second, at once when nothing
  // was read in the last second, else once at its end. Reading at start counts as a read.
  const lastRead = useRef(Date.now());
  const planned = useRef<ReturnType<typeof setTimeout>>(undefined);
  const soon = useCallback(() => {
    const read = () => {
      planned.current = undefined;
      lastRead.current = Date.now();
      approvals.reload();
      inbox.reload();
    };
    if (planned.current) return;
    const wait = lastRead.current + 1000 - Date.now();
    if (wait <= 0) read();
    else planned.current = setTimeout(read, wait);
  }, [approvals.reload, inbox.reload]);
  useEffect(() => () => clearTimeout(planned.current), []);
  // Approvals arrive while pages are open: the counts look again now and then.
  useEffect(() => {
    const timer = setInterval(soon, 30_000);
    // AFS-133: a decision made on any page counts at once.
    window.addEventListener(APPROVALS_CHANGED, soon);
    // AFS-146: and one made on a run's canvas (the designer's frame says so).
    const fromFrame = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if ((event.data as { type?: string } | null)?.type === APPROVALS_CHANGED) soon();
    };
    window.addEventListener('message', fromFrame);
    return () => {
      clearInterval(timer);
      window.removeEventListener(APPROVALS_CHANGED, soon);
      window.removeEventListener('message', fromFrame);
    };
  }, [soon]);
  // AFS-193: and on every page opened: a run stopped or decided elsewhere drops out of the count.
  const firstPath = useRef(path);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads again when the page changes
  useEffect(() => {
    if (firstPath.current === path) return;
    firstPath.current = '';
    soon();
  }, [path]);
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

  // AFS-274: the workspace Build shows: the page's, else the one last picked, else the first.
  const list = workspaces.data ?? [];
  const [kept, setKept] = useState(keptWorkspace);
  const onPage = list.find((w) => w.key === here);
  useEffect(() => {
    if (!onPage) return;
    keepWorkspace(onPage.key);
    setKept(onPage.key);
  }, [onPage]);
  const current = onPage ?? list.find((w) => w.key === kept) ?? list[0];
  const pick = (key: string) => {
    keepWorkspace(key);
    setKept(key);
    // The same Build page, in the workspace picked; from anything else, its projects.
    const tab = buildTab(path);
    navigate(`/w/${encodeURIComponent(key)}${tab ? `/-/${tab}` : ''}`);
  };

  const waiting = approvals.data?.filter((a) => a.mayDecide).length ?? 0;
  const needs = inbox.data?.count ?? 0;
  const ws = current ? `/w/${current.key}` : '';
  const works: MenuLink[] = actionOnly
    ? [
        {
          to: '/actions',
          icon: 'actions',
          label: 'Actions',
          current: path === '/' || path.startsWith('/actions'),
        },
      ]
    : [
        {
          to: '/',
          icon: 'inbox',
          label: 'Inbox',
          current: path === '/',
          count: needs,
          counted: `${needs} ${needs === 1 ? 'needs' : 'need'} you`,
        },
        { to: '/runs', icon: 'runs', label: 'Runs', current: /^\/runs(\/|$)/.test(path) },
        {
          to: '/approvals',
          icon: 'approvals',
          label: 'Approvals',
          current: path === '/approvals',
          count: waiting,
          counted: `${waiting} waiting for you`,
        },
        ...(reach?.actions
          ? [
              {
                to: '/actions',
                icon: 'actions' as const,
                label: 'Actions',
                current: path.startsWith('/actions'),
              },
            ]
          : []),
      ];
  const builds: MenuLink[] = [
    ...(current
      ? [
          {
            to: ws,
            icon: 'projects' as const,
            label: 'Projects',
            current:
              path === ws ||
              (path.startsWith(`${ws}/`) &&
                !path.startsWith(`${ws}/-/`) &&
                !path.startsWith(`${ws}/environments/`)),
          },
        ]
      : []),
    // Libraries are offered to every project: the switcher does not narrow Library.
    { to: '/library', icon: 'library', label: 'Library', current: path === '/library' },
    ...(current
      ? [
          {
            to: `${ws}/-/environments`,
            icon: 'environments' as const,
            label: 'Environments',
            current: path === `${ws}/-/environments` || path.startsWith(`${ws}/environments/`),
          },
          {
            to: `${ws}/-/credentials`,
            icon: 'credentials' as const,
            label: 'Credentials',
            current: path === `${ws}/-/credentials`,
          },
        ]
      : []),
  ];
  const governs: MenuLink[] = me.admin
    ? [
        // Access is a workspace's: the switcher's (AFS-274 plan, decision 1).
        ...(current
          ? [
              {
                to: `${ws}/-/access`,
                icon: 'access' as const,
                label: 'Access',
                current: path === `${ws}/-/access`,
              },
            ]
          : []),
        {
          to: '/admin/audit',
          icon: 'audit',
          label: 'Audit log',
          current: path.startsWith('/admin/audit'),
        },
        {
          to: '/admin/people',
          icon: 'people',
          label: 'People',
          current:
            path === '/admin' ||
            path.startsWith('/admin/people') ||
            path.startsWith('/admin/groups'),
        },
        {
          to: '/admin/server',
          icon: 'server',
          label: 'Server',
          current: SERVER_PAGES.some((p) => path === p || path.startsWith(`${p}/`)),
        },
      ]
    : [];
  const switchItems: PopItem[] = [
    ...list.map((w) => ({
      id: `ws:${w.key}`,
      label: w.name,
      checked: w.key === current?.key,
      onSelect: () => pick(w.key),
    })),
    {
      id: '/workspaces',
      to: '/workspaces',
      label: 'All workspaces',
      current: path === '/workspaces' ? ('page' as const) : undefined,
    },
  ];
  const accountItems: PopItem[] = [
    {
      id: '/account',
      to: '/account',
      label: 'Profile',
      current: path === '/account' ? 'page' : undefined,
    },
    {
      id: '/account/tokens',
      to: '/account/tokens',
      label: 'Access tokens',
      current: path === '/account/tokens' ? 'page' : undefined,
    },
    { id: 'theme', label: THEME_LABEL[theme], onSelect: onTheme, stays: true },
    // The help pages, at their other addresses too (/guide, /docs).
    {
      id: '/help',
      to: '/help',
      label: 'Help',
      current: /^\/(help|guide)(\/|$)/.test(path) || path === '/docs' ? 'page' : undefined,
    },
    { id: 'sign-out', label: 'Sign out', onSelect: onSignOut },
  ];
  const switcherWords = current
    ? {
        label: `Workspace: ${current.name}, change`,
        title: `Workspace: ${current.name}. Projects, Environments and Credentials are of this one`,
      }
    : undefined;
  const accountWords = {
    label: `Account: ${me.name}`,
    title: `${me.name}: profile, access tokens, theme, help, sign out`,
  };
  const page = (current: boolean): 'page' | undefined => (current ? 'page' : undefined);

  if (folded && !phone) {
    const item = (i: MenuLink) => (
      <Link
        key={i.to}
        to={i.to}
        className="rail-item"
        aria-label={i.count ? `${i.label}, ${i.counted}` : i.label}
        title={i.count ? `${i.label}: ${i.counted}` : i.label}
        aria-current={page(i.current)}
      >
        <Icon name={i.icon} />
        {!!i.count && (
          <span className="count rail-count" aria-hidden="true" data-count={i.icon}>
            {i.count}
          </span>
        )}
      </Link>
    );
    return (
      <div className="side rail">
        <Link
          to="/"
          className="rail-brand"
          aria-label="Ansible Flow Server"
          title="Ansible Flow Server"
        >
          <img src={logo} alt="" width="28" height="28" />
        </Link>
        <nav aria-label="Work" className="rail-nav">
          {works.map(item)}
        </nav>
        {!actionOnly && (
          <nav aria-label="Build" className="rail-nav rail-group">
            {current && switcherWords && (
              <PopMenu
                place="beside"
                className="rail-item"
                label={switcherWords.label}
                title={switcherWords.title}
                items={switchItems}
                path={path}
              >
                <span className="menu-mark" aria-hidden="true">
                  {initials(current.name)}
                </span>
              </PopMenu>
            )}
            {/* As the unfolded menu's "No workspace yet": an administrator may add one. */}
            {!current &&
              workspaces.data &&
              me.admin &&
              item({
                to: '/workspaces',
                icon: 'workspaces',
                label: 'Add a workspace',
                current: path === '/workspaces',
              })}
            {builds.map(item)}
          </nav>
        )}
        {governs.length > 0 && (
          <nav aria-label="Govern" className="rail-nav rail-group">
            {governs.map(item)}
          </nav>
        )}
        <div className="rail-end">
          <PopMenu
            place="beside"
            className="rail-item"
            label={accountWords.label}
            title={accountWords.title}
            items={accountItems}
            path={path}
          >
            <span className="menu-mark account-mark" aria-hidden="true">
              {initials(me.name)}
            </span>
          </PopMenu>
          <button
            type="button"
            className="rail-item"
            aria-label="Unfold the menu"
            title="Unfold the menu"
            aria-expanded={false}
            onClick={() => fold(false)}
          >
            <Icon name="unfold" />
          </button>
        </div>
      </div>
    );
  }

  const link = (i: MenuLink) => (
    <Link key={i.to} to={i.to} aria-current={page(i.current)}>
      <Icon name={i.icon} />
      <span className="side-text">{i.label}</span>
      {!!i.count && (
        <span className="count" title={i.counted} data-count={i.icon}>
          {i.count}
        </span>
      )}
    </Link>
  );
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
        <nav aria-label="Work" className="side-nav">
          {/* AFS-175: who has only actions has nothing else to go to. */}
          {!actionOnly && (
            <span className="side-label" aria-hidden="true">
              Work
            </span>
          )}
          {works.map(link)}
        </nav>
        {!actionOnly && (
          <nav aria-label="Build" className="side-nav">
            <span className="side-label" aria-hidden="true">
              Build
            </span>
            {current && switcherWords ? (
              <PopMenu
                place="below"
                className="switcher"
                label={switcherWords.label}
                title={switcherWords.title}
                items={switchItems}
                path={path}
              >
                <span className="menu-mark" aria-hidden="true">
                  {initials(current.name)}
                </span>
                <span className="menu-words">
                  <span className="menu-name">{current.name}</span>
                  <span className="menu-sub">
                    {current.projects} {current.projects === 1 ? 'project' : 'projects'}
                  </span>
                </span>
                <Icon name="chevron-down" />
              </PopMenu>
            ) : (
              // AFS-152: who has no workspace yet is told so (Home says whom to ask).
              workspaces.data && (
                <p className="side-note">
                  No workspace yet
                  {me.admin && (
                    <>
                      {' · '}
                      <Link to="/workspaces">Add a workspace</Link>
                    </>
                  )}
                </p>
              )
            )}
            {builds.map(link)}
          </nav>
        )}
        {governs.length > 0 && (
          <nav aria-label="Govern" className="side-nav">
            <span className="side-label" aria-hidden="true">
              Govern
            </span>
            {governs.map(link)}
          </nav>
        )}
        <div className="side-end">
          <PopMenu
            place="above"
            className="account-button"
            label={accountWords.label}
            title={accountWords.title}
            items={accountItems}
            path={path}
          >
            <span className="menu-mark account-mark" aria-hidden="true">
              {initials(me.name)}
            </span>
            <span className="menu-words">
              <span className="menu-name">{me.name}</span>
              <span className="menu-sub">{me.admin ? 'Administrator' : me.login}</span>
            </span>
            <Icon name="chevron-up" />
          </PopMenu>
          <button
            type="button"
            className="menu-fold icon-button"
            aria-label="Fold the menu"
            title="Fold the menu to icons"
            aria-expanded
            onClick={() => fold(true)}
          >
            <Icon name="fold" />
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
  // AFS-166: Ctrl+S saves on every page, and never opens the browser's Save page dialog.
  useEffect(() => listenForSaveKey(), []);
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
  // AFS-175: whether this person has actions, and whether they are all they have.
  const signedInId = session.state === 'signed-in' ? session.user.id : undefined;
  const reached = useLoad(async (): Promise<Reach | undefined> => {
    if (session.state !== 'signed-in') return undefined;
    const user = session.user;
    const [actions, workspaces] = await Promise.all([
      api.actions().catch(() => []),
      user.admin ? Promise.resolve([{}]) : api.workspaces().catch(() => [{}]),
    ]);
    return {
      actions: actions.length,
      actionOnly: !user.admin && workspaces.length === 0 && actions.length > 0,
    };
  }, [signedInId]);
  const reach = reached.data;

  const signedIn = (user: User) => {
    // /signin is only the page a refused provider sign-in comes back to: nothing is there once in.
    // The same for /setup, the address the setup code is written with (AFS-158).
    if (/^\/(signin|setup)$/.test(window.location.pathname)) navigate('/', { replace: true });
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
  const kind =
    /\/flow\//.test(path) || path === '/docs/api'
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
          reach={reach}
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
            {/* AFS-254: action-only people search too: it finds the actions they may run. */}
            <SearchBox me={me} />
          </div>
          <main id="main" className={kind}>
            {me.admin && <CertificateBanner path={path} />}
            <BarSlot.Provider value={barSlot}>
              {/* AFS-175: Home waits to know whether actions are all this person has. */}
              {path === '/' && reached.loading && !reach ? null : (
                <Page path={path} me={me} theme={theme} reach={reach} />
              )}
            </BarSlot.Provider>
          </main>
        </div>
      </div>
    </>
  );
}
