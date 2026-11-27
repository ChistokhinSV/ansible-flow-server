// The side menu (AFS-274, ADR-0039 §10) with the server played by the test: Work, Build and Govern;
// the workspace Build shows (the page's, else the one last picked, else the first); Govern's
// Access in that workspace; the Server page; and an action-only person's menu.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';
import { APPROVALS_CHANGED } from '../../src/web/approvals';
import { navigate } from '../../src/web/router';

const dana = { id: 'u1', login: 'dana', name: 'Dana Whitfield', admin: true, groups: [] };
const omar = { id: 'u2', login: 'omar', name: 'Omar Haddad', admin: false, groups: [] };
const net = { id: 'w1', key: 'net', name: 'Network team', projects: 2 };
const lab = { id: 'w2', key: 'lab', name: 'Lab', projects: 1 };

type Answer = { status?: number; body?: unknown };
// An answer may be a promise, one that never settles for a call still on its way.
let routes: Record<string, () => Answer | Promise<Answer>>;
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  window.scrollTo = () => undefined;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '').replace(/\?since=[^&]*$/, '')}`;
    const answer = (await routes[key]?.()) ?? {
      status: 404,
      body: { error: 'not_found', message: `Nothing at ${key}` },
    };
    const status = answer.status ?? 200;
    return { ok: status < 300, status, json: async () => answer.body } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const as = (user: typeof dana) => ({
  'GET /session': () => ({ body: user }),
  'GET /workspaces': () => ({ body: [net, lab] }),
  'GET /approvals': () => ({ body: [] }),
  'GET /actions': () => ({ body: [] }),
  'GET /library/subflows': () => ({ body: [] }),
});
const links = (nav: string) =>
  within(screen.getByRole('navigation', { name: nav }))
    .getAllByRole('link')
    .map((l) => [l.textContent, l.getAttribute('href')]);

describe('the side menu', () => {
  it('has Work, Build headed by its workspace, and Govern for administrators', async () => {
    routes = as(dana);
    window.history.replaceState(null, '', '/library');
    render(<App />);
    await screen.findByRole('button', { name: 'Workspace: Network team, change' });
    expect(links('Work')).toEqual([
      ['Inbox', '/'],
      ['Runs', '/runs'],
      ['Approvals', '/approvals'],
    ]);
    // Build is of the workspace its switcher shows; Library is every project's.
    expect(links('Build')).toEqual([
      ['Projects', '/w/net'],
      ['Library', '/library'],
      ['Environments', '/w/net/-/environments'],
      ['Credentials', '/w/net/-/credentials'],
    ]);
    expect(
      within(screen.getByRole('navigation', { name: 'Build' }))
        .getByRole('link', { name: 'Library' })
        .getAttribute('aria-current'),
    ).toBe('page');
    // Access is a workspace's: the switcher's.
    expect(links('Govern')).toEqual([
      ['Access', '/w/net/-/access'],
      ['Audit log', '/admin/audit'],
      ['People', '/admin/people'],
      ['Server', '/admin/server'],
    ]);
  });

  it('Build shows the workspace last picked off its pages, and the first when storage is closed', async () => {
    routes = as(omar);
    window.localStorage.setItem('afs.workspace', 'lab');
    window.history.replaceState(null, '', '/runs');
    routes['GET /runs?limit=100'] = () => ({ body: [] });
    const first = render(<App />);
    await screen.findByRole('button', { name: 'Workspace: Lab, change' });
    expect(links('Build')[0]).toEqual(['Projects', '/w/lab']);
    // Not an administrator: no Govern.
    expect(screen.queryByRole('navigation', { name: 'Govern' })).toBeNull();
    first.unmount();

    // A browser that keeps nothing: the first workspace, and nothing breaks.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage closed');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage closed');
    });
    render(<App />);
    expect(
      await screen.findByRole('button', { name: 'Workspace: Network team, change' }),
    ).toBeTruthy();
  });

  it('a workspace page sets the switcher, and Govern’s Access follows it', async () => {
    routes = {
      ...as(dana),
      'GET /workspaces/lab': () => ({ body: { ...lab, level: 'rw' } }),
      'GET /workspaces/lab/projects': () => ({ body: [] }),
    };
    window.history.replaceState(null, '', '/w/lab');
    render(<App />);
    await screen.findByRole('button', { name: 'Workspace: Lab, change' });
    await waitFor(() => expect(window.localStorage.getItem('afs.workspace')).toBe('lab'));
    expect(
      within(screen.getByRole('navigation', { name: 'Govern' }))
        .getByRole('link', { name: 'Access' })
        .getAttribute('href'),
    ).toBe('/w/lab/-/access');
    expect(
      within(screen.getByRole('navigation', { name: 'Build' }))
        .getByRole('link', { name: 'Projects' })
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it('who has no workspace yet is told so in Build; an administrator may add one', async () => {
    routes = { ...as(dana), 'GET /workspaces': () => ({ body: [] }) };
    render(<App />);
    const build = await screen.findByRole('navigation', { name: 'Build' });
    await waitFor(() => expect(build.textContent).toContain('No workspace yet'));
    expect(within(build).getByRole('link', { name: 'Add a workspace' }).getAttribute('href')).toBe(
      '/workspaces',
    );
    expect(links('Govern').map(([label]) => label)).toEqual(['Audit log', 'People', 'Server']);
  });

  it('folded to a rail with no workspace yet, an administrator’s Build still offers to add one', async () => {
    let read = false;
    const none = () => {
      read = true;
      return { body: [] };
    };
    window.localStorage.setItem('afs.menu.folded', '1');
    window.history.replaceState(null, '', '/library');
    routes = { ...as(dana), 'GET /workspaces': none };
    const first = render(<App />);
    const build = await screen.findByRole('navigation', { name: 'Build' });
    const add = await within(build).findByRole('link', { name: 'Add a workspace' });
    expect(add.getAttribute('href')).toBe('/workspaces');
    expect(add.getAttribute('title')).toBe('Add a workspace');
    first.unmount();

    read = false;
    routes = { ...as(omar), 'GET /workspaces': none };
    render(<App />);
    const theirs = await screen.findByRole('navigation', { name: 'Build' });
    await waitFor(() => expect(read).toBe(true));
    await act(async () => undefined);
    expect(within(theirs).queryByRole('link', { name: 'Add a workspace' })).toBeNull();
  });

  it('two workspaces of one name are two choices in the switcher, each going to its own', async () => {
    const twin = { id: 'w3', key: 'lab-2', name: 'Lab', projects: 0 };
    routes = {
      ...as(dana),
      'GET /workspaces': () => ({ body: [net, lab, twin] }),
      'GET /workspaces/lab-2': () => ({ body: { ...twin, level: 'rw' } }),
      'GET /workspaces/lab-2/projects': () => ({ body: [] }),
    };
    const said = vi.spyOn(console, 'error');
    window.history.replaceState(null, '', '/library');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace: Network team, change' }));
    const labs = within(await screen.findByRole('menu')).getAllByRole('menuitemradio', {
      name: 'Lab',
    });
    expect(labs).toHaveLength(2);
    // React says so when two items share a key: they would be one element to it.
    expect(said.mock.calls.flat().join(' ')).not.toMatch(/same key/);
    fireEvent.click(labs[1] as HTMLElement);
    await waitFor(() => expect(window.location.pathname).toBe('/w/lab-2'));
  });
});

describe('the menu’s counts', () => {
  it('a burst of page changes and decisions reads them at most twice, and the count follows', async () => {
    const reads = { approvals: 0, inbox: 0 };
    let waiting: unknown[] = [];
    routes = {
      ...as(dana),
      'GET /approvals': () => {
        reads.approvals++;
        return { body: waiting };
      },
      'GET /inbox': () => {
        reads.inbox++;
        return { body: { count: 0 } };
      },
    };
    window.history.replaceState(null, '', '/library');
    render(<App />);
    const work = await screen.findByRole('navigation', { name: 'Work' });
    await waitFor(() => expect(reads).toEqual({ approvals: 1, inbox: 1 }));

    // Decided elsewhere: one now waits for Dana. Five pages and three decisions in 240 ms, on a
    // clock the test moves (only while nothing of the testing library's waits on it).
    waiting = [{ gate: { id: 'g1' }, run: { id: 'r1' }, mayDecide: true }];
    reads.approvals = 0;
    reads.inbox = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.now() });
    for (const to of ['/workspaces', '/library', '/workspaces', '/library', '/workspaces'])
      await act(async () => {
        navigate(to);
        vi.advanceTimersByTime(30);
      });
    for (let i = 0; i < 3; i++)
      await act(async () => {
        window.dispatchEvent(new Event(APPROVALS_CHANGED));
        vi.advanceTimersByTime(30);
      });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    vi.useRealTimers();
    expect(reads.approvals).toBeGreaterThanOrEqual(1);
    expect(reads.approvals).toBeLessThanOrEqual(2);
    expect(reads.inbox).toBeLessThanOrEqual(2);
    await waitFor(() =>
      expect(within(work).getByRole('link', { name: /^Approvals/ }).textContent).toBe('Approvals1'),
    );
  });
});

describe('the Server page', () => {
  it('says how each part of the server stands, with its page; for administrators only', async () => {
    routes = {
      ...as(dana),
      'GET /admin/oidc-providers': () => ({ body: [{ id: 'o1' }] }),
      'GET /admin/ldap-directories': () => ({ body: [] }),
      'GET /admin/secret-providers': () => ({ body: [{ id: 's1' }, { id: 's2' }] }),
      'GET /admin/certificate': () => ({
        body: {
          tls: 'on',
          defaultNames: [],
          current: { source: 'uploaded', info: { daysLeft: 12 } },
        },
      }),
      'GET /notifications/settings': () => ({ body: { webhookKey: true, smtp: { host: 'x' } } }),
      'GET /admin/streams': () => ({ body: [] }),
      'GET /default-environment': () => ({
        body: {
          image: 'registry.example.com/ee:1',
          configured: 'registry.example.com/ee:0',
          environment: { id: 'e1', name: 'net-tools', workspace: 'w1', workspaceKey: 'net' },
        },
      }),
    };
    window.history.replaceState(null, '', '/admin/certificate');
    const first = render(<App />);
    // The certificate's page is one of the Server's: the menu's Server is current there.
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: 'Govern' }))
          .getByRole('link', { name: 'Server' })
          .getAttribute('aria-current'),
      ).toBe('page'),
    );
    first.unmount();

    window.history.replaceState(null, '', '/admin/server');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Server' });
    const table = screen.getByRole('table');
    await waitFor(() => expect(table.textContent).toContain('ends in 12 days'));
    const rows = [...table.querySelectorAll('tbody tr')].map((r) => [
      r.querySelector('td')?.textContent,
      r.querySelector('a')?.getAttribute('href'),
      r.querySelectorAll('td')[2]?.textContent,
    ]);
    expect(rows).toEqual([
      ['Sign-in', '/admin/sign-in', '1 single sign-on provider, no directories'],
      ['Secret providers', '/admin/secret-providers', '2 providers'],
      ['Server certificate', '/admin/certificate', 'ends in 12 days'],
      ['Notifications', '/admin/notifications', 'email on, webhooks signed'],
      ['Event streaming', '/admin/streams', 'no streams'],
      ['Default image', '/w/net/environments/e1', 'net-tools: registry.example.com/ee:1'],
    ]);
  });

  it('tells a part still read from one whose call failed', async () => {
    routes = {
      ...as(dana),
      'GET /admin/oidc-providers': () => ({ body: [] }),
      'GET /admin/ldap-directories': () => ({ body: [] }),
      'GET /admin/secret-providers': () => ({
        status: 500,
        body: { error: 'internal', message: 'The secret store did not answer' },
      }),
      // Still on its way.
      'GET /admin/certificate': () => new Promise<Answer>(() => undefined),
    };
    window.history.replaceState(null, '', '/admin/server');
    render(<App />);
    const table = await screen.findByRole('table');
    const now = (part: string) =>
      [...table.querySelectorAll('tbody tr')]
        .find((r) => r.querySelector('td')?.textContent === part)
        ?.querySelectorAll('td')[2]?.textContent;
    await waitFor(() => expect(now('Secret providers')).toBe('could not read'));
    expect(now('Sign-in')).toBe('no single sign-on providers, no directories');
    expect(now('Server certificate')).toBe('…');
  });

  it('is not there for someone who is not an administrator', async () => {
    routes = as(omar);
    window.history.replaceState(null, '', '/admin/server');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'For administrators' })).toBeTruthy();
  });
});

describe('Event streaming form fold', () => {
  it('opens More options when a save fails on a field inside it', async () => {
    routes = {
      ...as(dana),
      'GET /admin/streams': () => ({ body: [] }),
      'POST /admin/streams': () => ({
        status: 422,
        body: {
          error: 'invalid',
          message: 'Most rows waiting must be at least 100',
          field: 'maxBacklog',
        },
      }),
    };
    window.history.replaceState(null, '', '/admin/streams');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a destination' }));
    const backlog = screen.getByLabelText('Most rows waiting');
    const fold = backlog.closest('details') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'SIEM' } });
    fireEvent.change(screen.getByLabelText('Receiver'), {
      target: { value: 'siem.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add the destination' }));
    expect(await screen.findByText('Most rows waiting must be at least 100')).toBeTruthy();
    expect(fold.open).toBe(true);
    // Editing the field clears the refusal without closing the fold.
    fireEvent.change(backlog, { target: { value: '500' } });
    expect(fold.open).toBe(true);
  });
});
