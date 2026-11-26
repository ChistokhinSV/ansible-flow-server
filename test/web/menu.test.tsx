// The side menu (AFS-274, ADR-0039 §10) with the server played by the test: Work, Build and Govern;
// the workspace Build shows (the page's, else the one last picked, else the first); Govern's
// Access in that workspace; the Server page; and an action-only person's menu.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const dana = { id: 'u1', login: 'dana', name: 'Dana Whitfield', admin: true, groups: [] };
const omar = { id: 'u2', login: 'omar', name: 'Omar Haddad', admin: false, groups: [] };
const net = { id: 'w1', key: 'net', name: 'Network team', projects: 2 };
const lab = { id: 'w2', key: 'lab', name: 'Lab', projects: 1 };

let routes: Record<string, () => { status?: number; body?: unknown }>;
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  window.scrollTo = () => undefined;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '').replace(/\?since=[^&]*$/, '')}`;
    const answer = routes[key]?.() ?? {
      status: 404,
      body: { error: 'not_found', message: `Nothing at ${key}` },
    };
    const status = answer.status ?? 200;
    return { ok: status < 300, status, json: async () => answer.body } as Response;
  });
});
afterEach(() => {
  cleanup();
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

  it('is not there for someone who is not an administrator', async () => {
    routes = as(omar);
    window.history.replaceState(null, '', '/admin/server');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'For administrators' })).toBeTruthy();
  });
});
