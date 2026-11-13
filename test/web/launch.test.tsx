// The launch pages with the server played by the test: a project's configurations, the launch
// form (secret inputs hidden, what would run, problems at their fields, Launch, start values),
// and adding one.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const dana = { id: 'u1', login: 'dana', name: 'Dana Whitfield', admin: true, groups: [] };
const omar = { id: 'u2', login: 'omar', name: 'Omar Haddad', admin: false, groups: [] };
const COMMIT = '9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b';
const project = {
  id: 'p1',
  workspace: 'w1',
  key: 'core',
  name: 'Core',
  hosted: true,
  gitPath: '/git/net/core.git',
  gitRef: 'main',
  commit: COMMIT,
  pollSeconds: 0,
  sync: { state: 'ok', at: '2026-11-13T12:00:00.000Z' },
};
const config = {
  id: 'c1',
  project: 'p1',
  name: 'Nightly check',
  flowFile: 'flows/upgrade.flow.yaml',
  mode: 'check',
  inventory: 'inventory/hosts.yaml',
  inputs: { devices: ['fw-edge-01'] },
  credentials: ['k1'],
  createdAt: '2026-11-13T10:00:00.000Z',
  updatedAt: '2026-11-13T10:00:00.000Z',
};
const flow = {
  file: 'flows/upgrade.flow.yaml',
  key: 'upgrade',
  name: 'Firewall upgrade',
  version: 3,
};
const form = {
  commit: COMMIT,
  ref: 'main',
  flow,
  mode: 'check',
  inventory: 'inventory/hosts.yaml',
  fields: [
    {
      name: 'devices',
      type: 'host_list',
      required: true,
      secret: false,
      text: 'fw-edge-01',
      targets: true,
    },
    { name: 'api_password', type: 'string', required: true, secret: true, text: '' },
    { name: 'retries', type: 'integer', required: false, secret: false, text: '3' },
  ],
};

let asked: { key: string; body?: unknown }[];
let routes: Record<string, (body?: unknown) => { status?: number; body?: unknown }>;
beforeEach(() => {
  asked = [];
  window.localStorage.clear();
  window.scrollTo = () => undefined;
  // Launch opens the run's page, which follows the run's stream: here it says nothing.
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

const common = (me: object) => ({
  'GET /session': () => ({ body: me }),
  'GET /workspaces/net/projects': () => ({ body: [project] }),
  'GET /projects/p1/branches': () => ({ body: { branches: ['main', 'try/idea'] } }),
  'GET /launch-configs/c1': () => ({ body: config }),
  'GET /launch-configs/c1/form?': () => ({ body: form }),
  'GET /launch-configs/c1/form?mode=real': () => ({ body: { ...form, mode: 'real' } }),
});

describe("a project's launch configurations", () => {
  it('are listed on the project page, and an administrator can add one', async () => {
    routes = {
      ...common(dana),
      'GET /projects/p1/flows': () => ({ body: { flows: [] } }),
      'GET /projects/p1/pushes?limit=20': () => ({ body: [] }),
      'GET /runs?project=p1&limit=10': () => ({ body: [] }),
      'GET /projects/p1/launch-configs': () => ({ body: [config] }),
    };
    window.history.replaceState(null, '', '/w/net/core');
    render(<App />);
    const link = await screen.findByRole('link', { name: 'Nightly check' });
    expect(link.getAttribute('href')).toBe('/w/net/core/launch/c1');
    expect(
      screen.getByRole('link', { name: 'Add a launch configuration' }).getAttribute('href'),
    ).toBe('/w/net/core/launch/new');
  });
});

describe('the launch form', () => {
  it('hides secret inputs, says what would run, and shows a problem at its field', async () => {
    let refuse = true;
    routes = {
      ...common(omar),
      'POST /launch-configs/c1/check': () =>
        refuse
          ? {
              status: 422,
              body: {
                error: 'not_ready',
                message: 'api_password is required',
                problems: [{ field: 'api_password', message: 'api_password is required' }],
              },
            }
          : {
              body: {
                launch: {
                  config: 'c1',
                  project: 'p1',
                  commit: COMMIT,
                  ref: 'main',
                  flow,
                  mode: 'check',
                  inputs: { devices: ['fw-edge-01'], api_password: '***', retries: 3 },
                  targets: ['fw-edge-01'],
                  credentials: ['k1'],
                },
                form,
              },
            },
    };
    window.history.replaceState(null, '', '/w/net/core/launch/c1');
    render(<App />);
    const secret = (await screen.findByLabelText(/api_password/)) as HTMLInputElement;
    expect(secret.type).toBe('password');
    expect((screen.getByLabelText(/^devices/) as HTMLInputElement).value).toBe('fw-edge-01');
    // Someone who is not an administrator asks, and does not launch.
    expect(screen.queryByRole('button', { name: 'Launch' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'What would run' }));
    await waitFor(() => expect(secret.getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByText('api_password is required')).toBeTruthy();

    refuse = false;
    fireEvent.change(secret, { target: { value: 's3cret-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'What would run' }));
    await screen.findByRole('heading', { name: 'What would run' });
    expect(secret.getAttribute('aria-invalid')).toBeNull();
    expect(screen.getByText('***')).toBeTruthy();
    const sent = asked.filter((a) => a.key === 'POST /launch-configs/c1/check').at(-1);
    expect(sent?.body).toEqual({
      inputs: { devices: 'fw-edge-01', api_password: 's3cret-value', retries: '3' },
    });
  });

  it('an administrator launches (and goes to the run), and keeps start values without secrets', async () => {
    routes = {
      ...common(dana),
      'POST /launch-configs/c1/launch': () => ({
        status: 201,
        body: { id: 'r9', number: 9, state: 'queued' },
      }),
      'PATCH /launch-configs/c1': (body) => ({
        body: { ...config, inputs: (body as { inputs: object }).inputs },
      }),
      'GET /runs/r9': () => ({ status: 404, body: { error: 'not_found', message: 'gone' } }),
    };
    window.history.replaceState(null, '', '/w/net/core/launch/c1');
    render(<App />);
    const secret = await screen.findByLabelText(/api_password/);
    fireEvent.change(secret, { target: { value: 's3cret-value' } });
    fireEvent.change(screen.getByLabelText(/^retries/), { target: { value: '5' } });
    fireEvent.click(screen.getByLabelText('Real'));

    fireEvent.click(screen.getByRole('button', { name: 'Keep as start values' }));
    await screen.findByText(/Start values kept: devices, retries/);
    const patch = asked.find((a) => a.key === 'PATCH /launch-configs/c1');
    expect(patch?.body).toEqual({ inputs: { devices: ['fw-edge-01'], retries: 5 } });

    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(window.location.pathname).toBe('/runs/r9'));
    const launched = asked.find((a) => a.key === 'POST /launch-configs/c1/launch');
    expect(launched?.body).toMatchObject({
      inputs: { api_password: 's3cret-value', retries: '5' },
    });
  });
});

describe('what a level shows', () => {
  it('an operator on the flow launches as configured: no other branch, no start values, no change', async () => {
    routes = {
      ...common(omar),
      'GET /projects/p1/access': () => ({
        body: { admin: false, workspace: 'ro', approve: false, flows: { [flow.file]: 'operator' } },
      }),
    };
    window.history.replaceState(null, '', '/w/net/core/launch/c1');
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Launch' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep as start values' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Change' })).toBeNull();
    expect((screen.getByLabelText(/^Branch/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/another branch or commit needs rw/)).toBeTruthy();
  });
});

describe('adding a launch configuration', () => {
  it('offers the flows, branches and run credentials, and shows a refusal at its field', async () => {
    routes = {
      ...common(dana),
      'GET /projects/p1/flows': () => ({
        body: { flows: [{ ...flow, file: 'flows/upgrade.flow.yaml', problems: [] }] },
      }),
      'GET /workspaces/net/credentials': () => ({
        body: [
          { id: 'k1', name: 'lab key', kind: 'ssh_key' },
          { id: 'k2', name: 'github', kind: 'git_token' },
        ],
      }),
      'POST /projects/p1/launch-configs': () => ({
        status: 400,
        body: { error: 'invalid', message: 'No inventory/prod at main', field: 'inventory' },
      }),
    };
    window.history.replaceState(null, '', '/w/net/core/launch/new');
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Upgrade' } });
    fireEvent.change(screen.getByLabelText(/^Flow/), {
      target: { value: 'flows/upgrade.flow.yaml' },
    });
    expect(screen.getByRole('option', { name: 'try/idea' })).toBeTruthy();
    // A git token is for a repository, not a run.
    expect(screen.queryByText('github')).toBeNull();
    fireEvent.click(await screen.findByRole('checkbox', { name: /lab key/ }));
    fireEvent.change(screen.getByLabelText(/^Inventory/), { target: { value: 'inventory/prod' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(screen.getByLabelText(/^Inventory/).getAttribute('aria-invalid')).toBe('true'),
    );
    expect(asked.find((a) => a.key === 'POST /projects/p1/launch-configs')?.body).toMatchObject({
      name: 'Upgrade',
      flowFile: 'flows/upgrade.flow.yaml',
      inventory: 'inventory/prod',
      gitRef: null,
      credentials: ['k1'],
      mode: 'check',
    });
  });
});
