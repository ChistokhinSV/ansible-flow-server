// Home (AFS-64) with the server played by the test: the greeting and the day in a sentence, the
// approvals that wait for this person, the latest runs and the workspaces; and the side menu.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const dana = { id: 'u1', login: 'dana', name: 'Dana Whitfield', admin: false, groups: [] };
const now = new Date();
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000).toISOString();
const run = (n: number, state: string, by = 'dana') => ({
  id: `r${n}`,
  number: n,
  project: 'p1',
  commit: '9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b',
  flow: { file: 'flows/fw.flow.yaml', key: 'fw', name: 'Firewall firmware upgrade', version: 4 },
  mode: 'real',
  inputs: {},
  targets: [],
  credentials: [],
  state,
  requestedBy: { id: 'u9', login: by },
  createdAt: minutesAgo(3),
  attempts: 1,
  cancelRequested: false,
});
const gate = (id: string, title: string, mayDecide: boolean) => ({
  run: {
    id: 'r3',
    number: 3,
    project: 'p1',
    flow: { file: 'f', name: 'Firewall firmware upgrade' },
  },
  requestedBy: 'omar',
  gate: {
    id,
    run: 'r3',
    node: { id: 'n1', key: 'approve', title },
    segment: 's1',
    status: 'waiting',
    approvers: [],
    notify: [],
    createdAt: minutesAgo(22),
  },
  mayDecide,
});

let routes: Record<string, () => { status?: number; body?: unknown }>;
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  window.scrollTo = () => undefined;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
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
});

describe('home', () => {
  it('greets, says how the day went, and lists what waits, the latest runs and the workspaces', async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /runs?limit=100': () => ({
        body: [run(3, 'waiting', 'omar'), run(2, 'succeeded'), run(1, 'failed')],
      }),
      'GET /approvals': () => ({
        body: [gate('g1', 'Change approval', true), gate('g2', 'Security sign-off', false)],
      }),
      'GET /workspaces': () => ({
        body: [{ id: 'w1', key: 'network', name: 'Network', projects: 3 }],
      }),
    };
    render(<App />);
    await screen.findByRole('heading', { name: /, Dana$/ });
    await screen.findByText('3 runs today, 1 went well. 1 approval is waiting for you.');
    // Only what this person may decide waits for them.
    const waiting = screen
      .getByRole('heading', { name: 'Waiting for you' })
      .closest('section') as HTMLElement;
    expect(within(waiting).getAllByRole('link')).toHaveLength(1);
    expect(within(waiting).getByRole('link').getAttribute('href')).toBe('/runs/r3');
    expect(waiting.textContent).toContain('Change approval');
    expect(waiting.textContent).toContain('waiting since 22 min ago');
    const recent = screen
      .getByRole('heading', { name: 'Latest runs' })
      .closest('section') as HTMLElement;
    expect([...recent.querySelectorAll('.end > :first-child')].map((e) => e.textContent)).toEqual([
      'waiting for a decision',
      'went well',
      'failed',
    ]);
    const rows = [...recent.querySelectorAll('li')].map((li) => li.textContent);
    expect(rows[0]).toContain('omar · 3 min ago · real');
    expect(rows[1]).toContain('you · 3 min ago');
    // The side menu: the count of approvals for this person, and the workspaces.
    const menu = screen.getByRole('navigation', { name: 'Main' });
    expect(within(menu).getByRole('link', { name: /^Approvals/ }).textContent).toBe('Approvals1');
    expect(
      within(screen.getByRole('navigation', { name: 'Workspaces' }))
        .getByRole('link', { name: 'Network' })
        .getAttribute('href'),
    ).toBe('/w/network');
    expect(within(menu).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('a quiet day says so', async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /runs?limit=100': () => ({ body: [] }),
      'GET /approvals': () => ({ body: [] }),
      'GET /workspaces': () => ({ body: [] }),
    };
    render(<App />);
    await screen.findByText('No run yet today. Nothing waits for you.');
    expect(screen.queryByRole('heading', { name: 'Waiting for you' })).toBeNull();
    expect(screen.getByText(/An administrator makes the first one/)).toBeTruthy();
  });
});

describe('the sign-in page', () => {
  it('shows a picture with no words in it, and the card', async () => {
    routes = {
      'GET /session': () => ({ status: 401, body: { error: 'unauthorized', message: 'Sign in' } }),
      'GET /setup': () => ({ body: { needed: false } }),
      'GET /auth/methods': () => ({ body: { providers: [], local: 'all' } }),
    };
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in to Ansible Flow Server' });
    const picture = document.querySelector('.entry-picture') as SVGElement;
    expect(picture.getAttribute('aria-hidden')).toBe('true');
    // The page is public: the picture says nothing about this server.
    expect(picture.textContent).toBe('');
    expect(picture.querySelector('text')).toBeNull();
    expect(screen.getByText('No account yet? Ask your administrator.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' }).className).toBe('primary');
  });
});
