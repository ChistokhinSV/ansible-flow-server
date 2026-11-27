// Home (AFS-64), an inbox since AFS-212, with the server played by the test: the greeting, the day
// in a sentence and four numbers, what needs this person with what they may do about it (from
// every workspace, each named), what runs now, what they may launch again and the latest runs;
// the workspace filter kept in the address; and the side menu.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const dana = { id: 'u1', login: 'dana', name: 'Dana Whitfield', admin: false, groups: [] };
const now = new Date();
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000).toISOString();
const run = (n: number, state: string, by = 'dana', project = 'p1') => ({
  id: `r${n}`,
  number: n,
  project,
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
const net = { id: 'w1', key: 'net', name: 'Network team' };
const lab = { id: 'w2', key: 'lab', name: 'Lab' };
const flow = { file: 'flows/fw.flow.yaml', name: 'Firewall firmware upgrade' };
const day = (more: object = {}) => ({
  runs: 0,
  real: 0,
  check: 0,
  succeeded: 0,
  failed: 0,
  rejected: 0,
  cancelled: 0,
  going: 0,
  waiting: 0,
  paused: 0,
  pausedDebug: 0,
  ...more,
});
const inbox = (items: object[], more: object = {}) => ({
  count: items.filter((i) => (i as { kind: string }).kind !== 'request').length,
  items,
  today: day(),
  week: { ended: 0, succeeded: 0 },
  runners: { busy: 0, slots: 4, queued: 0 },
  ...more,
});
const ITEMS = [
  {
    kind: 'approval',
    workspace: net,
    project: { id: 'p1', key: 'edge', name: 'Edge' },
    title: 'Change approval: Firewall firmware upgrade #3 waits for your decision',
    since: minutesAgo(22),
    verbs: ['review'],
    run: { id: 'r3', number: 3, flow, mode: 'real' },
    approval: { gate: 'g1', step: 'Change approval', requestedBy: 'Omar Haddad' },
  },
  {
    kind: 'paused',
    workspace: lab,
    project: { id: 'p2', key: 'core', name: 'Core' },
    title: 'Your run Firewall firmware upgrade #5 is paused before Push baseline',
    since: minutesAgo(10),
    verbs: ['open', 'step', 'continue'],
    run: { id: 'r5', number: 5, flow, mode: 'check' },
    pause: {
      before: 'Push baseline',
      stopsAt: new Date(now.getTime() + 59 * 60_000).toISOString(),
    },
  },
  {
    kind: 'failed',
    workspace: lab,
    project: { id: 'p2', key: 'core', name: 'Core' },
    title: 'Your run Firewall firmware upgrade #7 failed',
    since: minutesAgo(25),
    verbs: ['open', 'runAgain'],
    run: { id: 'r7', number: 7, flow, mode: 'real' },
    failure: { error: 'sw-edge-01: connection timed out', hosts: { total: 2, failed: 1 } },
  },
  {
    kind: 'certificate',
    title: 'The server certificate ends in 12 days',
    since: minutesAgo(60),
    verbs: ['replace'],
    certificate: { notAfter: minutesAgo(-12 * 1440), daysLeft: 12, names: ['flows.example.com'] },
  },
  {
    kind: 'draft',
    workspace: lab,
    project: { id: 'p2', key: 'core', name: 'Core' },
    title: 'Your draft of Firewall firmware upgrade is not saved',
    since: minutesAgo(60),
    verbs: ['openDraft'],
    draft: {
      id: 'd1',
      file: 'flows/fw.flow.yaml',
      flow: 'Firewall firmware upgrade',
      others: ['Mia Ortega'],
      behind: true,
    },
  },
  {
    kind: 'request',
    workspace: net,
    project: { id: 'p1', key: 'edge', name: 'Edge' },
    title: 'Your run Firewall firmware upgrade #8 waits for a decision by omar',
    since: minutesAgo(5),
    verbs: ['open'],
    run: { id: 'r8', number: 8, flow, mode: 'real' },
    approval: { gate: 'g2', step: 'Change approval', requestedBy: 'dana', deciders: ['omar'] },
  },
];
const PROJECTS = {
  'GET /workspaces': () => ({
    body: [
      { ...net, projects: 1 },
      { ...lab, projects: 1 },
    ],
  }),
  'GET /workspaces/net/projects': () => ({
    body: [{ id: 'p1', workspace: 'w1', key: 'edge', name: 'Edge' }],
  }),
  'GET /workspaces/lab/projects': () => ({
    body: [{ id: 'p2', workspace: 'w2', key: 'core', name: 'Core' }],
  }),
};

let routes: Record<string, (body?: unknown) => { status?: number; body?: unknown }>;
let asked: string[];
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  window.scrollTo = () => undefined;
  asked = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    // The inbox is asked from the start of the browser's day, a time the test does not fix.
    const path = url
      .replace('/api/v1', '')
      .replace(/([?&])since=[^&]*&?/, '$1')
      .replace(/[?&]$/, '');
    const key = `${init.method ?? 'GET'} ${path}`;
    asked.push(key);
    const answer = routes[key]?.(init.body ? JSON.parse(String(init.body)) : undefined) ?? {
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

describe('home, the inbox', () => {
  it('greets, says the day in a sentence and four numbers, and lists what needs you with what you may do', async () => {
    const stepped: unknown[] = [];
    routes = {
      ...PROJECTS,
      'GET /session': () => ({ body: dana }),
      'GET /runs?limit=100': () => ({
        body: [run(3, 'waiting', 'omar'), run(2, 'succeeded', 'dana', 'p2'), run(1, 'running')],
      }),
      'GET /approvals': () => ({ body: [] }),
      'GET /inbox': () => ({
        body: inbox(ITEMS, {
          today: day({
            runs: 5,
            real: 3,
            check: 2,
            succeeded: 2,
            failed: 1,
            waiting: 1,
            paused: 1,
          }),
          week: { ended: 50, succeeded: 47 },
          runners: { busy: 1, slots: 4, queued: 0 },
        }),
      }),
      'POST /runs/r5/step': (body) => {
        stepped.push(body);
        return { body: run(5, 'running') };
      },
    };
    render(<App />);
    await screen.findByRole('heading', { name: /, Dana$/ });
    const lead = await screen.findByText(
      (_, el) => el?.tagName === 'P' && !!el.textContent?.startsWith('5 runs today'),
    );
    expect(lead.textContent).toBe(
      '5 runs today, by everyone: 2 went well, 1 failed, 1 waits for a decision, 1 paused step by step. 5 things need you.',
    );
    // AFS-208: each count is a link to those runs.
    expect(within(lead).getByRole('link', { name: '1 failed' }).getAttribute('href')).toBe(
      '/runs?state=failed',
    );
    const numbers = screen.getByRole('list', { name: 'The day in numbers' });
    expect([...numbers.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Runs today53 real · 2 check',
      'Went well, 7 days94%47 of 50 runs',
      'Needs you5oldest 25 min',
      'Runners1 of 4busy · nothing queued',
    ]);
    const needs = screen
      .getByRole('heading', { name: /^Needs you/ })
      .closest('section') as HTMLElement;
    const rows = [...needs.querySelectorAll('.inbox-items:not(.quiet) > li')];
    // A decision first, then one's own runs, then the rest.
    expect(rows.map((li) => li.getAttribute('data-kind'))).toEqual([
      'approval',
      'paused',
      'failed',
      'certificate',
      'draft',
    ]);
    // Each names its workspace (the certificate is the server's), and what may be done there.
    expect(
      rows.map((li) => li.querySelector('.inbox-facts')?.textContent?.split(' · ')[0]),
    ).toEqual(['Network team', 'Lab', 'Lab', 'This server', 'Lab']);
    const link = (name: RegExp) => within(needs).getByRole('link', { name }).getAttribute('href');
    expect(link(/^Review: Firewall firmware upgrade #3/)).toBe('/runs/r3');
    // Run again opens the run's own Run again menu, with its choices and questions.
    expect(link(/^Run again: Firewall firmware upgrade #7/)).toBe('/runs/r7?again=1');
    expect(link(/^Open draft/)).toBe('/w/lab/core/flow/flows/fw.flow.yaml?edit=1');
    expect(link(/^Replace/)).toBe('/admin/certificate');
    expect(rows[2]?.textContent).toContain('sw-edge-01: connection timed out');
    expect(rows[4]?.textContent).toContain('the flow changed since it began');
    expect(rows[4]?.textContent).toContain('Mia Ortega edited it too');
    expect(rows[1]?.textContent).toContain('stops by itself in 59 min');
    // A paused run goes on from here: Continue first.
    const paused = rows[1] as HTMLElement;
    expect(
      within(paused)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Continue', 'Step']);
    fireEvent.click(within(paused).getByRole('button', { name: /^Step:/ }));
    await vi.waitFor(() => expect(stepped).toEqual([{ command: 'step' }]));
    // One's own run waiting for someone else's decision is said, apart, and not counted.
    const others = within(needs).getByRole('heading', { name: 'Waiting for others' });
    expect(others.nextElementSibling?.textContent).toContain('by omar');
    // The latest runs name their workspace.
    const recent = screen
      .getByRole('heading', { name: 'Latest runs' })
      .closest('section') as HTMLElement;
    await vi.waitFor(() =>
      expect(
        [...recent.querySelectorAll('li:not(.runs-head)')].map(
          (li) => li.querySelector('.c-fact')?.textContent,
        ),
      ).toEqual(['Network team', 'Lab', 'Network team']),
    );
    expect(recent.querySelector('.runs-head')?.textContent).toContain('Workspace');
    // What runs now, beside.
    const running = screen
      .getByRole('heading', { name: 'Running now' })
      .closest('section') as HTMLElement;
    expect(within(running).getByRole('link', { name: /#1/ }).textContent).toContain('Network team');
    // AFS-274: the menu's Inbox is current here, with the inbox's count; Build's switcher shows
    // the first workspace, and its Projects.
    const work = screen.getByRole('navigation', { name: 'Work' });
    const inboxLink = within(work).getByRole('link', { name: /^Inbox/ });
    expect(inboxLink.getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(inboxLink.textContent).toBe('Inbox5'));
    const build = screen.getByRole('navigation', { name: 'Build' });
    expect(
      within(build).getByRole('button', { name: 'Workspace: Network team, change' }),
    ).toBeTruthy();
    expect(within(build).getByRole('link', { name: 'Projects' }).getAttribute('href')).toBe(
      '/w/net',
    );
  });

  it('narrows to one workspace, kept in the address', async () => {
    routes = {
      ...PROJECTS,
      'GET /session': () => ({ body: dana }),
      'GET /runs?limit=100': () => ({
        body: [run(3, 'succeeded'), run(2, 'succeeded', 'dana', 'p2')],
      }),
      'GET /approvals': () => ({ body: [] }),
      'GET /inbox': () => ({ body: inbox(ITEMS) }),
      'GET /inbox?workspace=lab': () => ({
        body: inbox(
          ITEMS.filter((i) => i.workspace === lab),
          { today: day({ runs: 1, succeeded: 1 }) },
        ),
      }),
    };
    render(<App />);
    const filter = (await screen.findByRole('combobox', {
      name: 'Workspace',
    })) as HTMLSelectElement;
    expect(filter.value).toBe('');
    await screen.findByText(
      (_, el) => el?.tagName === 'P' && !!el.textContent?.includes('5 things need you'),
    );
    fireEvent.change(filter, { target: { value: 'lab' } });
    expect(window.location.pathname + window.location.search).toBe('/?workspace=lab');
    await screen.findByText(
      (_, el) =>
        el?.tagName === 'P' &&
        el.textContent === '1 run today in Lab, by everyone: 1 went well. 3 things need you.',
    );
    expect(asked).toContain('GET /inbox?workspace=lab');
    const recent = screen
      .getByRole('heading', { name: 'Latest runs' })
      .closest('section') as HTMLElement;
    await vi.waitFor(() =>
      expect(
        [...recent.querySelectorAll('li:not(.runs-head) .title')].map((t) => t.textContent),
      ).toEqual(['Firewall firmware upgrade #2']),
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
      'GET /approvals': () => ({ body: [] }),
      'GET /inbox': () => ({ body: inbox([ITEMS[0] as object]) }),
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
    // The configuration as it is named now, whether it is real, its flow and workspace, when.
    expect(links[0]?.textContent).toContain('Nightly check');
    expect(links[0]?.textContent).toContain('Firewall firmware upgrade · Network');
    expect(links[0]?.querySelector('.mode-badge')?.textContent).toContain('real');
    expect(links[0]?.textContent).toContain('last run 40 min ago');
    // Beside what needs you.
    const precedes = (a: Element, b: Element) =>
      !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(precedes(screen.getByRole('heading', { name: /^Needs you/ }), again)).toBe(true);
  });

  it('a quiet day says so', async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /runs?limit=100': () => ({ body: [] }),
      'GET /approvals': () => ({ body: [] }),
      'GET /inbox': () => ({ body: inbox([]) }),
      'GET /workspaces': () => ({ body: [] }),
    };
    render(<App />);
    await screen.findByText('No run yet today. Nothing needs you.');
    expect(screen.queryByRole('heading', { name: 'Launch again' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Workspace' })).toBeNull();
    // AFS-135: workspaces may exist that this person has no access to.
    expect(
      screen.getByText(/You have no access to a workspace yet: ask an administrator/),
    ).toBeTruthy();
  });

  it('counts paused runs as paused, not as going (AFS-205), and debug runs as debug runs (AFS-249)', async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /runs?limit=100': () => ({ body: [] }),
      'GET /approvals': () => ({ body: [] }),
      'GET /inbox': () => ({
        body: inbox([], { today: day({ runs: 3, going: 1, paused: 2, pausedDebug: 2 }) }),
      }),
      'GET /workspaces': () => ({ body: [] }),
    };
    render(<App />);
    const line = await screen.findByText(
      (_, el) => el?.tagName === 'P' && !!el.textContent?.includes('debug runs paused'),
    );
    expect(line.textContent).toBe(
      '3 runs today, by everyone: 0 went well, 1 still goes, 2 debug runs paused. Nothing needs you.',
    );
    // AFS-232: "still goes" is a link too, to the runs going (not the paused ones).
    expect(within(line).getByRole('link', { name: '1 still goes' }).getAttribute('href')).toBe(
      '/runs?state=going',
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
