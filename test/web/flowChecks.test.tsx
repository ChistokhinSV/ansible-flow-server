// What a flow needs, on the pages (AFS-33), with the server played by the test: the launch
// configuration page lists each collection with where the need comes from and what the image has,
// says how many are not as needed, and makes an environment for the flow; the spec form finds a
// collection on the collection server and adds it, and says when the server is out of reach.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const rita = { id: 'u1', login: 'rita', name: 'Rita Okafor', admin: true, groups: [] };
const COMMIT = '9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b';
const project = {
  id: 'p1',
  workspace: 'w1',
  key: 'core',
  name: 'Core',
  hosted: true,
  gitRef: 'main',
  commit: COMMIT,
  sync: { state: 'ok' },
};
const config = {
  id: 'c1',
  project: 'p1',
  name: 'Nightly check',
  flowFile: 'flows/upgrade.flow.yaml',
  mode: 'check',
  environment: 'e1',
  inputs: {},
  credentials: [],
  createdAt: '2026-11-13T10:00:00.000Z',
  updatedAt: '2026-11-13T10:00:00.000Z',
};
const form = {
  commit: COMMIT,
  ref: 'main',
  flow: { file: 'flows/upgrade.flow.yaml', key: 'upgrade', name: 'Upgrade', version: 1 },
  mode: 'check',
  fields: [],
};
const check = {
  flow: { file: 'flows/upgrade.flow.yaml', name: 'Upgrade' },
  commit: COMMIT,
  requirementsFile: true,
  environment: { id: 'e1', name: 'ios', image: 'afs-ee/net-ios:0123', ansibleCore: '2.19.4' },
  lines: [
    {
      name: 'ansible.utils',
      wants: '>=6.0.0',
      from: 'requirements',
      nodes: [],
      ok: false,
      why: 'Not in the image',
    },
    {
      name: 'cisco.ios',
      wants: '>=11.6.0',
      from: 'flow',
      nodes: ['facts'],
      has: '11.7.0',
      ok: true,
    },
  ],
  ok: false,
};

let asked: { key: string; body?: unknown }[];
let routes: Record<string, (body?: unknown) => { status?: number; body?: unknown }>;
beforeEach(() => {
  asked = [];
  window.scrollTo = () => undefined;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    asked.push({ key, body });
    const answer = routes[key]?.(body) ?? {
      status: 404,
      body: { error: 'not_found', message: key },
    };
    const status = answer.status ?? 200;
    return {
      ok: status < 300,
      status,
      json: async () => answer.body,
      text: async () => '',
    } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const sent = (key: string) => asked.filter((a) => a.key === key).map((a) => a.body);

describe('what a flow needs', () => {
  it('shows each collection against the image, and makes an environment for the flow', async () => {
    routes = {
      'GET /session': () => ({ body: rita }),
      'GET /workspaces/net/projects': () => ({ body: [project] }),
      'GET /projects/p1/branches': () => ({ body: { branches: ['main'] } }),
      'GET /launch-configs/c1': () => ({ body: config }),
      'GET /launch-configs/c1/form?': () => ({ body: form }),
      'GET /launch-configs/c1/schedules': () => ({ body: [] }),
      'GET /launch-configs/c1/environment-check': () => ({ body: check }),
      'POST /launch-configs/c1/environment': (body) => ({
        status: 201,
        body: { id: 'e9', ...(body as object) },
      }),
      'GET /workspaces/net': () => ({
        body: { id: 'w1', key: 'net', name: 'Network', level: 'admin' },
      }),
      'GET /environments/e9': () => ({
        body: {
          id: 'e9',
          name: 'upgrade-ee',
          kind: 'spec',
          keep: 3,
          usedBy: 0,
          spec: { baseImage: 'b', ansibleCore: '2.19', collections: [], python: [], system: [] },
        },
      }),
      'GET /environments/e9/builds': () => ({ body: [] }),
    };
    window.history.replaceState(null, '', '/w/net/core/launch/c1');
    render(<App />);
    const needs = (await screen.findByRole('heading', { name: 'What the flow needs' })).closest(
      'section',
    ) as HTMLElement;
    await within(needs).findByText('cisco.ios');
    expect(within(needs).getByText('missing')).toBeTruthy();
    expect(within(needs).getByText('Not in the image')).toBeTruthy();
    expect(within(needs).getByText('11.7.0')).toBeTruthy();
    expect(within(needs).getByRole('status').textContent).toMatch(/1 of 2 not as needed/);

    fireEvent.change(within(needs).getByLabelText('Make an environment for this flow'), {
      target: { value: 'upgrade-ee' },
    });
    fireEvent.click(within(needs).getByRole('button', { name: 'Make and build it' }));
    await waitFor(() => expect(window.location.pathname).toBe('/w/net/environments/e9'));
    expect(sent('POST /launch-configs/c1/environment')).toEqual([{ name: 'upgrade-ee' }]);
  });

  it('the spec form finds a collection and adds it; out of reach, it says so', async () => {
    let reachable = true;
    routes = {
      'GET /session': () => ({ body: rita }),
      'GET /workspaces/net': () => ({
        body: { id: 'w1', key: 'net', name: 'Network', level: 'rw' },
      }),
      'GET /environments/e1': () => ({
        body: {
          id: 'e1',
          name: 'ios',
          kind: 'spec',
          keep: 3,
          usedBy: 0,
          spec: { baseImage: 'b', ansibleCore: '2.19', collections: [], python: [], system: [] },
          updatedAt: 'x',
        },
      }),
      'GET /environments/e1/builds': () => ({ body: [] }),
      'GET /galaxy/search?q=ios': () =>
        reachable
          ? { body: [{ name: 'cisco.ios', version: '11.7.0', description: 'Cisco IOS' }] }
          : {
              status: 503,
              body: {
                error: 'unavailable',
                message: "Galaxy cannot be reached. Type the collection's name and version instead",
              },
            },
    };
    window.history.replaceState(null, '', '/w/net/environments/e1');
    render(<App />);
    const spec = (await screen.findByRole('heading', { name: 'Spec' })).closest(
      'section',
    ) as HTMLElement;
    fireEvent.change(within(spec).getByLabelText('Find a collection'), {
      target: { value: 'ios' },
    });
    fireEvent.click(within(spec).getByRole('button', { name: 'Search' }));
    fireEvent.click(await within(spec).findByRole('button', { name: 'Add cisco.ios' }));
    expect((within(spec).getByLabelText('Collection 1') as HTMLInputElement).value).toBe(
      'cisco.ios',
    );
    expect((within(spec).getByLabelText('Version 1') as HTMLInputElement).value).toBe('latest');

    reachable = false;
    fireEvent.click(within(spec).getByRole('button', { name: 'Search' }));
    expect(
      await within(spec).findByText(/Type the collection's name and version instead/),
    ).toBeTruthy();
  });
});
