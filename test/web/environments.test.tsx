// Execution environments on the pages (AFS-32), with the server played by the test: a workspace
// lists its environments and rw adds one; an environment's page shows the image runs get and what
// it holds, saves a spec, builds, and shows a build's log; ro only reads.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const rita = { id: 'u1', login: 'rita', name: 'Rita Okafor', admin: false, groups: [] };
const net = { id: 'w1', key: 'net', name: 'Network', projects: 0, selfApprove: false };
const IMAGE = 'afs-ee/net-net-tools:0123456789abcdef';
const env = {
  id: 'e1',
  workspace: 'w1',
  name: 'net-tools',
  kind: 'spec',
  keep: 3,
  spec: {
    baseImage: 'python:3.13-slim',
    ansibleCore: '2.19',
    collections: [{ name: 'cisco.ios', version: 'latest' }],
    python: [],
    system: [],
  },
  current: IMAGE,
  catalog: {
    ansibleCore: '2.19.4',
    collections: { 'cisco.ios': '11.7.0', 'ansible.netcommon': '8.7.1' },
  },
  latest: {
    id: 'b1',
    environment: 'e1',
    number: 1,
    state: 'done',
    image: IMAGE,
    pruned: false,
    by: 'rita',
    createdAt: '2026-11-14T08:00:00.000Z',
  },
  usedBy: 1,
  createdBy: 'rita',
  createdAt: '2026-11-14T08:00:00.000Z',
  updatedAt: '2026-11-14T08:00:00.000Z',
};

let asked: { key: string; body?: unknown }[];
let routes: Record<string, (body?: unknown) => { status?: number; body?: unknown; text?: string }>;
beforeEach(() => {
  asked = [];
  window.scrollTo = () => undefined;
  vi.stubGlobal('confirm', () => true);
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
      text: async () => answer.text ?? '',
    } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const sent = (key: string) => asked.filter((a) => a.key === key).map((a) => a.body);
const open = (path: string) => {
  window.history.replaceState(null, '', path);
  render(<App />);
};

describe('execution environments', () => {
  it('a workspace lists them, and rw adds one that then opens', async () => {
    routes = {
      'GET /session': () => ({ body: rita }),
      'GET /workspaces/net': () => ({ body: { ...net, level: 'rw' } }),
      'GET /workspaces/net/projects': () => ({ body: [] }),
      'GET /workspaces/net/environments': () => ({ body: [env] }),
      'POST /workspaces/net/environments': (body) => ({
        status: 201,
        body: { ...env, id: 'e2', ...(body as object) },
      }),
      'GET /environments/e2': () => ({ body: { ...env, id: 'e2', name: 'awx' } }),
      'GET /environments/e2/builds': () => ({ body: [] }),
    };
    open('/w/net');
    const section = (
      await screen.findByRole('heading', { name: 'Execution environments' })
    ).closest('section') as HTMLElement;
    expect(await within(section).findByText(IMAGE)).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Add environment' }));
    fireEvent.change(within(section).getByLabelText('Name'), { target: { value: 'awx' } });
    fireEvent.change(within(section).getByLabelText('Kind'), { target: { value: 'image' } });
    fireEvent.change(within(section).getByLabelText('Image'), {
      target: { value: 'quay.io/ansible/awx-ee:24.6.1' },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(window.location.pathname).toBe('/w/net/environments/e2'));
    expect(sent('POST /workspaces/net/environments')).toEqual([
      { name: 'awx', kind: 'image', image: 'quay.io/ansible/awx-ee:24.6.1' },
    ]);
  });

  it("an environment's page: what runs get, a saved spec, a build and its log", async () => {
    let builds = [env.latest];
    routes = {
      'GET /session': () => ({ body: rita }),
      'GET /workspaces/net': () => ({ body: { ...net, level: 'rw' } }),
      'GET /environments/e1': () => ({ body: env }),
      'GET /environments/e1/builds': () => ({ body: builds }),
      'PATCH /environments/e1': (body) => ({
        body: { ...env, ...(body as object), updatedAt: '2026-11-14T09:00:00.000Z' },
      }),
      'POST /environments/e1/builds': () => {
        builds = [
          { ...env.latest, id: 'b2', number: 2, state: 'queued', image: undefined } as never,
          ...builds,
        ];
        return { status: 201, body: builds[0] };
      },
      'GET /environments/e1/builds/b1/log': () => ({
        text: 'Settling collection versions…\n  cisco.ios latest -> 11.7.0\n',
      }),
    };
    open('/w/net/environments/e1');
    const now = (await screen.findByRole('heading', { name: 'What runs get now' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(now).getByText(IMAGE)).toBeTruthy();
    expect(within(now).getByText('2.19.4')).toBeTruthy();
    expect(within(now).getByText('ansible.netcommon')).toBeTruthy();

    const spec = screen.getByRole('heading', { name: 'Spec' }).closest('section') as HTMLElement;
    fireEvent.click(within(spec).getByRole('button', { name: 'Add a collection' }));
    fireEvent.change(within(spec).getByLabelText('Collection 2'), {
      target: { value: 'ansible.utils' },
    });
    fireEvent.change(within(spec).getByLabelText('Version 2'), { target: { value: '>=6.0.0,<7' } });
    fireEvent.change(within(spec).getByLabelText('Python packages'), {
      target: { value: 'netaddr>=1.3\n\njmespath' },
    });
    fireEvent.click(within(spec).getByRole('button', { name: 'Save the spec' }));
    await screen.findByText(/Saved\. Build to make an image/);
    expect(sent('PATCH /environments/e1')[0]).toMatchObject({
      keep: 3,
      spec: {
        collections: [
          { name: 'cisco.ios', version: 'latest' },
          { name: 'ansible.utils', version: '>=6.0.0,<7' },
        ],
        python: ['netaddr>=1.3', 'jmespath'],
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Log' }));
    expect(await screen.findByText(/cisco\.ios latest -> 11\.7\.0/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Build now' }));
    expect(await screen.findByRole('button', { name: 'Building…' })).toBeTruthy();
    expect(screen.getByText('waiting')).toBeTruthy();
  });

  it('ro reads and changes nothing', async () => {
    routes = {
      'GET /session': () => ({ body: rita }),
      'GET /workspaces/net': () => ({ body: { ...net, level: 'ro' } }),
      'GET /environments/e1': () => ({ body: env }),
      'GET /environments/e1/builds': () => ({ body: [env.latest] }),
    };
    open('/w/net/environments/e1');
    await screen.findByRole('heading', { name: 'Spec' });
    expect(screen.queryByRole('button', { name: 'Build now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save the spec' })).toBeNull();
    expect(screen.getByRole('link', { name: 'ansible-builder file' })).toBeTruthy();
  });
});
