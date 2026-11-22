// AFS-175: actions on the pages, with the server played by the test: a person whose only access is
// actions lands on them (menu, home), the short form asks only what the action asks and confirms,
// a refusal is said at its field, and the progress view says how it goes in words.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const mia = { id: 'u9', login: 'mia', name: 'Mia Lund', admin: false, groups: [] };
const card = {
  id: 'c1',
  title: 'Restart the edge switch',
  summary: 'Restarts one edge switch and checks it answers again.',
  mode: 'real',
  workspace: { key: 'net', name: 'Network' },
};
const form = {
  id: 'c1',
  title: card.title,
  summary: card.summary,
  mode: 'real',
  confirm: true,
  fields: [
    {
      name: 'devices',
      label: 'Switch',
      help: 'The switch to restart.',
      type: 'host_list',
      required: true,
      choices: ['sw-edge-01', 'sw-edge-02'],
      text: '',
    },
  ],
  happens: [
    'It runs for real: it changes the machines it runs on.',
    'It goes through 2 steps: Restart, Check it answers.',
  ],
  ask: ['Wanda Rossi (who set up this action)', 'the administrator Dana Whitfield'],
};
const progress = (extra: object = {}) => ({
  action: { id: 'c1', title: card.title },
  run: {
    id: 'r1',
    number: 12,
    state: 'running',
    createdAt: new Date().toISOString(),
    words: 'running',
    mode: 'real',
    startedBy: 'Mia Lund',
  },
  headline: 'Running step 2 of 2: Check it answers.',
  steps: [
    { id: 'n1', title: 'Restart', state: 'done' },
    { id: 'n2', title: 'Check it answers', state: 'running' },
  ],
  done: 1,
  total: 2,
  ask: form.ask,
  inputs: [{ label: 'Switch', value: 'sw-edge-02' }],
  ...extra,
});

let asked: { key: string; body?: unknown }[];
let routes: Record<string, (body?: unknown) => { status?: number; body?: unknown }>;
beforeEach(() => {
  asked = [];
  window.scrollTo = () => undefined;
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener() {}
      close() {}
    },
  );
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    asked.push({ key, body });
    const answer = routes[key]?.(body) ?? {
      status: 404,
      body: { error: 'not_found', message: key },
    };
    const status = answer.status ?? 200;
    return { ok: status < 300, status, json: async () => answer.body } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const actionOnly = () => ({
  'GET /session': () => ({ body: mia }),
  'GET /workspaces': () => ({ body: [] }),
  'GET /actions': () => ({
    body: [
      {
        ...card,
        lastRun: {
          id: 'r0',
          number: 11,
          state: 'succeeded',
          createdAt: new Date().toISOString(),
          words: 'went well',
        },
      },
    ],
  }),
  'GET /approvals': () => ({ body: [] }),
});

describe('actions', () => {
  it('who has only actions lands on them: Actions is home and the whole menu', async () => {
    routes = actionOnly();
    window.history.replaceState(null, '', '/');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Actions' })).toBeTruthy();
    const link = await screen.findByRole('link', { name: /Restart the edge switch/ });
    expect(link.getAttribute('href')).toBe('/actions/c1');
    expect(link.textContent).toMatch(/You ran it just now: went well/);
    const menu = screen.getByRole('navigation', { name: 'Main' });
    expect(
      within(menu)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Actions']);
    expect(screen.queryByRole('navigation', { name: 'Workspaces' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Runs' })).toBeNull();
  });

  it('who has more sees Home, with Actions in the menu', async () => {
    routes = {
      ...actionOnly(),
      'GET /workspaces': () => ({ body: [{ id: 'w1', key: 'net', name: 'Network' }] }),
      'GET /runs?limit=100': () => ({ body: [] }),
      'GET /session/access': () => ({ body: { admin: false, workspaces: [], administrators: [] } }),
    };
    window.history.replaceState(null, '', '/');
    render(<App />);
    const menu = await screen.findByRole('navigation', { name: 'Main' });
    await waitFor(() =>
      expect(
        within(menu)
          .getAllByRole('link')
          .map((l) => l.textContent),
      ).toContain('Actions'),
    );
    expect(
      within(menu)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toContain('Runs');
  });

  it('the form asks only what the action asks, confirms, and goes to the progress', async () => {
    const confirm = vi.fn((_question: string) => true);
    vi.stubGlobal('confirm', confirm);
    routes = {
      ...actionOnly(),
      'GET /actions/c1': () => ({ body: form }),
      'POST /actions/c1/run': () => ({
        status: 201,
        body: { id: 'r1', number: 12, state: 'queued', progress: '/actions/runs/r1' },
      }),
      'GET /actions/runs/r1': () => ({ body: progress() }),
    };
    window.history.replaceState(null, '', '/actions/c1');
    render(<App />);
    expect(await screen.findByRole('heading', { name: card.title })).toBeTruthy();
    expect(screen.getByText('It goes through 2 steps: Restart, Check it answers.')).toBeTruthy();
    // Nothing of the flow: no YAML, no commit, no inventory.
    expect(document.body.textContent).not.toMatch(/commit|inventory|yaml|devices/i);
    // Empty and required: said at the field, nothing sent.
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('Switch is needed')).toBeTruthy();
    expect(asked.some((a) => a.key === 'POST /actions/c1/run')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'sw-edge-02' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0]?.[0]).toMatch(
      /Run "Restart the edge switch" now\? Switch: sw-edge-02/,
    );
    await waitFor(() =>
      expect(asked.find((a) => a.key === 'POST /actions/c1/run')?.body).toEqual({
        inputs: { devices: 'sw-edge-02' },
      }),
    );
    expect(await screen.findByText('Running step 2 of 2: Check it answers.')).toBeTruthy();
    expect(window.location.pathname).toBe('/actions/runs/r1');
  });

  it('a refusal about a field is said at it', async () => {
    vi.stubGlobal('confirm', () => true);
    routes = {
      ...actionOnly(),
      'GET /actions/c1': () => ({
        body: { ...form, confirm: false, fields: [{ ...form.fields[0], text: 'sw-edge-01' }] },
      }),
      'POST /actions/c1/run': () => ({
        status: 400,
        body: {
          error: 'invalid',
          message: 'Switch: sw-core-01 is not one of the choices',
          field: 'devices',
        },
      }),
    };
    window.history.replaceState(null, '', '/actions/c1');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run' }));
    expect(await screen.findByText('Switch: sw-core-01 is not one of the choices')).toBeTruthy();
  });

  it('the progress view: steps in words, waiting for whom, failed and whom to ask', async () => {
    let now = progress();
    routes = { ...actionOnly(), 'GET /actions/runs/r1': () => ({ body: now }) };
    window.history.replaceState(null, '', '/actions/runs/r1');
    const { unmount } = render(<App />);
    expect(await screen.findByText('Running step 2 of 2: Check it answers.')).toBeTruthy();
    expect(screen.getByText('1 of 2 steps done')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
    expect(screen.getByText('sw-edge-02')).toBeTruthy();
    // No link to the run page for who may not see it.
    expect(screen.queryByRole('link', { name: 'The full run page' })).toBeNull();
    unmount();

    now = progress({
      run: { ...progress().run, state: 'failed', words: 'failed' },
      headline: 'Failed: 1 of 1 host failed at Check it answers.',
      failed: '1 of 1 host failed at Check it answers',
      again: '/actions/c1',
      runPage: '/runs/r1',
    });
    render(<App />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(
      /failed at Check it answers\..*Ask Wanda Rossi \(who set up this action\) or the administrator Dana Whitfield/,
    );
    expect(screen.getByRole('link', { name: 'Run it again' }).getAttribute('href')).toBe(
      '/actions/c1',
    );
    expect(screen.getByRole('link', { name: 'The full run page' }).getAttribute('href')).toBe(
      '/runs/r1',
    );
  });
});
