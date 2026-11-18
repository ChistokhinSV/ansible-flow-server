// AFS-143: help in the pages (a Help page, Help beside page titles), pages not found that say
// what was looked for, clone help for an empty project, and failure words without step keys.
import { cleanup, render, screen, within } from '@testing-library/react';
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
    routes = {
      'GET /session': () => ({ body: lena }),
      'GET /workspaces': () => ({ body: [] }),
    };
    window.history.replaceState(null, '', '/w/network/credentials');
    render(<App />);
    await screen.findByRole('heading', { name: 'Not found' });
    expect(screen.queryByRole('heading', { name: 'credentials' })).toBeNull();
    expect(document.querySelector('main')?.textContent).toContain(
      'The project credentials in network is not here, or is not shared with you.',
    );
    expect(screen.getByRole('link', { name: 'Back to network' }).getAttribute('href')).toBe(
      '/w/network',
    );
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
