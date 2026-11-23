// AFS-143: help in the pages (a Help page, Help beside page titles), pages not found that say
// what was looked for, clone help for an empty project, and failure words without step keys.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';
import { GUIDE } from '../../src/web/guide';
import { plainWhy } from '../../src/web/runs';

const dana = { id: 'u1', login: 'dana', name: 'Dana Whitfield', admin: true, groups: [] };
const lena = { id: 'u3', login: 'lena', name: 'Lena Berg', admin: false, groups: [] };
const network = { id: 'w1', key: 'network', name: 'Network team', projects: 1 };
const lab = {
  id: 'p2',
  workspace: 'w1',
  key: 'lab',
  name: 'Lab',
  hosted: true,
  gitPath: '/git/network/lab.git',
  gitRef: 'main',
  sync: { state: 'never' },
  pollSeconds: 0,
  hook: false,
};

let routes: Record<string, () => { status?: number; body?: unknown }>;
beforeEach(() => {
  window.localStorage.clear();
  window.scrollTo = () => undefined;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
    const answer = routes[key]?.() ?? {
      status: 404,
      body: { error: 'not_found', message: 'No such workspace' },
    };
    const status = answer.status ?? 200;
    return { ok: status < 300, status, json: async () => answer.body } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('help', () => {
  it('the side menu leads to Help, which lists the guide and the API reference', async () => {
    routes = { 'GET /session': () => ({ body: dana }), 'GET /workspaces': () => ({ body: [] }) };
    window.history.replaceState(null, '', '/guide');
    render(<App />);
    await screen.findByRole('heading', { name: 'Help' });
    const menu = within(
      screen.getByRole('navigation', { name: 'Main' }).parentElement as HTMLElement,
    );
    expect(menu.getByRole('link', { name: 'Help' }).getAttribute('href')).toBe('/help');
    expect(screen.getByRole('link', { name: 'The audit log' }).getAttribute('href')).toBe(
      `${GUIDE}audit.md`,
    );
    expect(screen.getByRole('link', { name: 'API reference' }).getAttribute('href')).toBe(
      '/docs/api',
    );
    // AFS-211: the pages that make flows are not listed under Running flows.
    const running = screen.getByRole('heading', { name: 'Running flows' }).closest('section');
    expect(
      within(running as HTMLElement).queryByRole('link', { name: 'Your first flow' }),
    ).toBeNull();
    expect(within(running as HTMLElement).getByRole('link', { name: 'Approvals' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Getting started' })).toBeTruthy();
  });

  it('a page links its part of the guide beside its title', async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /workspaces': () => ({ body: [] }),
      'GET /audit?limit=100': () => ({ body: { entries: [] } }),
    };
    window.history.replaceState(null, '', '/admin/audit');
    render(<App />);
    // The heading's name stays the title: the link is beside it.
    const heading = await screen.findByRole('heading', { name: 'Audit log' });
    const help = within(heading.parentElement as HTMLElement).getByRole('link', { name: 'Help' });
    expect(help.getAttribute('href')).toBe(`${GUIDE}audit.md`);
  });

  it('an address with no page says which, with the way home and help', async () => {
    routes = { 'GET /session': () => ({ body: dana }), 'GET /workspaces': () => ({ body: [] }) };
    window.history.replaceState(null, '', '/nowhere/at-all');
    render(<App />);
    await screen.findByRole('heading', { name: 'Nothing here' });
    expect(screen.getByText('/nowhere/at-all')).toBeTruthy();
  });

  it('a project not there or not shared names what was looked for, not the address', async () => {
    let asked = 0;
    routes = {
      'GET /session': () => ({ body: lena }),
      'GET /workspaces': () => ({ body: [] }),
      'GET /session/access': () => ({
        body: { admin: false, administrators: ['Dana Whitfield'], workspaces: [] },
      }),
      'GET /workspaces/network/projects': () => {
        asked++;
        return { status: 404, body: { error: 'not_found', message: 'No such workspace' } };
      },
    };
    window.history.replaceState(null, '', '/w/network/credentials');
    render(<App />);
    await screen.findByRole('heading', { name: 'Not found' });
    expect(screen.queryByRole('heading', { name: 'credentials' })).toBeNull();
    expect(document.querySelector('main')?.textContent).toContain(
      'The project credentials in network is not here, or is not shared with you.',
    );
    // AFS-152: the way back is a page she can open; the workspace she cannot is not linked, and
    // who gives access is named.
    expect(screen.getByRole('link', { name: 'Back to Workspaces' }).getAttribute('href')).toBe(
      '/workspaces',
    );
    expect(document.querySelector('a[href="/w/network"]')).toBeNull();
    expect(await screen.findByText(/An administrator gives access: Dana Whitfield/)).toBeTruthy();
    expect(asked).toBe(1);
  });

  it('a run, a flow or a launch configuration not there says what, with a way back', async () => {
    routes = {
      'GET /session': () => ({ body: lena }),
      'GET /workspaces': () => ({ body: [network] }),
      'GET /workspaces/network/projects': () => ({ body: [lab] }),
      'GET /projects/p2/flows': () => ({ body: { flows: [] } }),
      'GET /projects/p2/access': () => ({
        body: { admin: false, workspace: 'ro', approve: false, flows: {} },
      }),
    };
    const events: string[] = [];
    vi.stubGlobal(
      'EventSource',
      class {
        constructor(url: string) {
          events.push(url);
        }
        addEventListener() {}
        close() {}
      },
    );
    window.history.replaceState(null, '', '/runs/3b89f8dc');
    const { unmount } = render(<App />);
    await screen.findByRole('heading', { name: 'Not found' });
    expect(document.querySelector('main')?.textContent).toContain(
      'The run 3b89f8dc is not here, or is not shared with you.',
    );
    expect(screen.getByRole('link', { name: 'Back to Runs' }).getAttribute('href')).toBe('/runs');
    // No stream of a run that is not there.
    expect(events.filter((u) => u.includes('/runs/'))).toEqual([]);
    unmount();

    window.history.replaceState(null, '', '/w/network/lab/launch/00000000-0000');
    const second = render(<App />);
    await screen.findByRole('heading', { name: 'Not found' });
    expect(document.querySelector('main')?.textContent).toContain(
      'The launch configuration 00000000-0000 in Lab is not here, or is not shared with you.',
    );
    expect(screen.getByRole('link', { name: 'Back to Lab' }).getAttribute('href')).toBe(
      '/w/network/lab',
    );
    second.unmount();

    // A project with commits, where she could copy and delete flow files.
    routes['GET /workspaces/network/projects'] = () => ({
      body: [{ ...lab, commit: 'a'.repeat(40) }],
    });
    routes['GET /projects/p2/access'] = () => ({
      body: { admin: false, workspace: 'rw', approve: false, flows: {} },
    });
    window.history.replaceState(null, '', '/w/network/lab/flow/missing.flow.yaml');
    render(<App />);
    await waitFor(() =>
      expect(document.querySelector('main')?.textContent).toContain(
        'The flow missing.flow.yaml is not here, or is not shared with you.',
      ),
    );
    expect(screen.getByRole('link', { name: 'Back to Lab' }).getAttribute('href')).toBe(
      '/w/network/lab',
    );
    // No canvas and no file actions for a flow that is not there.
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Full screen' })).toBeNull();
  });

  it('an empty project shows how to clone it on its Overview', async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /workspaces': () => ({ body: [network] }),
      'GET /workspaces/network/projects': () => ({ body: [lab] }),
      'GET /projects/p2/branches': () => ({ body: { branches: [] } }),
      'GET /projects/p2/flows': () => ({ body: { flows: [] } }),
    };
    window.history.replaceState(null, '', '/w/network/lab');
    render(<App />);
    await screen.findByRole('heading', { name: 'Start this project' });
    expect(
      screen.getByText(`git clone ${window.location.origin}/git/network/lab.git`),
    ).toBeTruthy();
  });
});

describe('failure words', () => {
  it('say the step by its title, and a port in words', () => {
    expect(plainWhy('Stopped at [precheck] Pre-checks: failed_hosts is not wired')).toBe(
      'Stopped at Pre-checks: its failed hosts have no next step in the flow',
    );
    expect(plainWhy('Ended at [not-approved] Not approved (outcome: failed)')).toBe(
      'Ended at Not approved (outcome: failed)',
    );
    expect(plainWhy('ansible-playbook ended with 2')).toBe('ansible-playbook ended with 2');
  });
});
