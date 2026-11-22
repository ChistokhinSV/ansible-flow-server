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
    await screen.findByText(
      (_, el) =>
        el?.tagName === 'P' &&
        el.textContent ===
          '3 runs today: 1 went well, 1 failed, 1 waits for a decision. 1 approval is waiting for you.',
    );
    // AFS-147: the runs that wait are a link to them.
    expect(screen.getByRole('link', { name: '1 waits for a decision' }).getAttribute('href')).toBe(
      '/runs?state=waiting',
    );
    // Only what this person may decide waits for them.
    const waiting = screen
      .getByRole('heading', { name: 'Waiting for you' })
      .closest('section') as HTMLElement;
    expect(within(waiting).getAllByRole('link')).toHaveLength(1);
    expect(within(waiting).getByRole('link').getAttribute('href')).toBe('/runs/r3');
    expect(waiting.textContent).toContain('Change approval');
    expect(waiting.textContent).toContain('waiting for 22 min');
    const recent = screen
      .getByRole('heading', { name: 'Latest runs' })
      .closest('section') as HTMLElement;
    expect([...recent.querySelectorAll('.c-state')].map((e) => e.textContent)).toEqual([
      'waiting for a decision',
      'went well',
      'failed',
    ]);
    // Each fact of a run is a column of its own (AFS-95): mode, who, when.
    const rows = [...recent.querySelectorAll('li:not(.runs-head)')].map((li) =>
      [...li.querySelectorAll('.c-fact')].map((c) => c.textContent),
    );
    expect(rows[0]).toEqual(expect.arrayContaining(['real', 'omar', '3 min ago']));
    // AFS-143: people by name, yours too (the login when the run has no name).
    expect(rows[1]).toEqual(expect.arrayContaining(['dana', '3 min ago']));
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

  it('offers to launch again what this person launched, newest first (AFS-85)', async () => {
    const of = (n: number, id: string, more: object = {}) => ({
      ...run(n, 'succeeded'),
      config: { id, name: `Configuration ${id}` },
      ...more,
    });
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /runs?limit=100': () => ({
        body: [
          // Someone else's, a schedule's, and one whose configuration is gone: not offered.
          of(9, 'c3', { requestedBy: { id: 'u2', login: 'omar' } }),
          of(8, 'c4', { schedule: 's1' }),
          of(7, 'c2'),
          of(6, 'c1', { createdAt: minutesAgo(40) }),
          of(5, 'c1', { createdAt: minutesAgo(90) }),
          of(4, 'c5', { project: 'p7' }),
          run(3, 'succeeded'),
        ],
      }),
      'GET /approvals': () => ({ body: [gate('g1', 'Change approval', true)] }),
      'GET /workspaces': () => ({
        body: [{ id: 'w1', key: 'network', name: 'Network', projects: 1 }],
      }),
      'GET /workspaces/network/projects': () => ({
        body: [{ id: 'p1', workspace: 'w1', key: 'core', name: 'Core' }],
      }),
      'GET /projects/p1/launch-configs': () => ({
        body: [
          { id: 'c1', project: 'p1', name: 'Nightly check' },
          { id: 'c3', project: 'p1', name: 'Weekly real' },
          { id: 'c4', project: 'p1', name: 'By the clock' },
          // AFS-187: its flow is gone: it cannot be launched again.
          { id: 'c2', project: 'p1', name: 'Gone', flowGone: 'There is no flow x.flow.yaml' },
        ],
      }),
    };
    render(<App />);
    const again = (await screen.findByRole('heading', { name: 'Launch again' })).closest(
      'section',
    ) as HTMLElement;
    const links = within(again).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/w/network/core/launch/c1']);
    // The configuration as it is named now, its flow, and when it last ran.
    expect(links[0]?.textContent).toContain('Nightly check');
    expect(links[0]?.textContent).toContain('Firewall firmware upgrade · Core');
    expect(links[0]?.textContent).toContain('last run 40 min ago');
    // Between what waits and the latest runs.
    const precedes = (a: Element, b: Element) =>
      !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(precedes(screen.getByRole('heading', { name: 'Waiting for you' }), again)).toBe(true);
    expect(precedes(again, screen.getByRole('heading', { name: 'Latest runs' }))).toBe(true);
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
    expect(screen.queryByRole('heading', { name: 'Launch again' })).toBeNull();
    // AFS-135: workspaces may exist that this person has no access to.
    expect(
      screen.getByText(/You have no access to a workspace yet: ask an administrator/),
    ).toBeTruthy();
  });
});

describe('home, your own runs at a gate (AFS-144)', () => {
  it('says that a run of yours waits for someone else to decide', async () => {
    const omar = { ...dana, id: 'u2', login: 'omar', name: 'Omar Haddad', admin: false };
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /runs?limit=100': () => ({ body: [] }),
      // Two gates of the same run: one run waits.
      'GET /approvals': () => ({
        body: [gate('g1', 'Change approval', false), gate('g2', 'Security sign-off', false)],
      }),
      'GET /workspaces': () => ({ body: [] }),
    };
    render(<App />);
    await screen.findByText(
      (_, el) =>
        el?.tagName === 'P' &&
        el.textContent ===
          "No run yet today. Nothing waits for you. 1 run of yours waits for someone else's decision.",
    );
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
