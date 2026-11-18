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
      'GET /environments/e2': () => ({
        body: { ...env, id: 'e2', name: 'awx', kind: 'image', current: undefined },
      }),
      'GET /environments/e2/builds': () => ({ body: [] }),
    };
    open('/w/net/-/environments');
    const section = (
      await screen.findByRole('heading', { name: 'Execution environments' })
    ).closest('section') as HTMLElement;
    expect(await within(section).findByText(IMAGE)).toBeTruthy();
    // AFS-153: Used by in words in every row.
    expect(within(section).getByText('1 launch configuration')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Add environment' }));
    fireEvent.change(within(section).getByLabelText('Name'), { target: { value: 'awx' } });
    fireEvent.change(within(section).getByLabelText('Kind'), { target: { value: 'image' } });
    fireEvent.change(within(section).getByLabelText('Image'), {
      target: { value: 'quay.io/ansible/awx-ee:24.6.1' },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(window.location.pathname).toBe('/w/net/environments/e2'));
    // AFS-153: an image is pulled, not built.
    expect(await screen.findByText(/none yet: pull it/)).toBeTruthy();
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
    // The newest build's outcome is said at the top, not only in the history.
    const status = screen
      .getAllByRole('status')
      .find((e) => /Built: build 1/.test(e.textContent ?? ''));
    expect(status?.textContent).toMatch(
      /is the image runs get now.*newest versions the spec allows/,
    );

    const spec = screen.getByRole('heading', { name: 'Spec' }).closest('section') as HTMLElement;
    fireEvent.click(within(spec).getByRole('button', { name: 'Add an empty row' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Build again' }));
    expect(await screen.findByRole('button', { name: 'Building…' })).toBeTruthy();
    expect(screen.getByText('waiting')).toBeTruthy();
    expect(
      screen.getByText(/Build 2 is waiting to start. Runs get the previous image/),
    ).toBeTruthy();
  });

  it('a build with spec changes not saved says so, and Save and build saves them first', async () => {
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
    };
    open('/w/net/environments/e1');
    const spec = (await screen.findByRole('heading', { name: 'Spec' })).closest(
      'section',
    ) as HTMLElement;
    expect(screen.getByRole('button', { name: 'Build again' })).toBeTruthy();
    fireEvent.change(within(spec).getByLabelText('Collection 1'), {
      target: { value: 'fortinet.fortios' },
    });
    expect(await screen.findByText(/changes that are not saved/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save and build' }));
    expect(await screen.findByRole('button', { name: 'Building…' })).toBeTruthy();
    const order = asked.map((a) => a.key).filter((k) => /^(PATCH|POST) /.test(k));
    expect(order).toEqual(['PATCH /environments/e1', 'POST /environments/e1/builds']);
    expect(sent('PATCH /environments/e1')[0]).toMatchObject({
      spec: { collections: [{ name: 'fortinet.fortios', version: 'latest' }] },
    });
    expect(screen.queryByText(/changes that are not saved/)).toBeNull();
  });

  it('the ansible-builder file with spec changes not saved saves them first', async () => {
    routes = {
      'GET /session': () => ({ body: rita }),
      'GET /workspaces/net': () => ({ body: { ...net, level: 'rw' } }),
      'GET /environments/e1': () => ({ body: env }),
      'GET /environments/e1/builds': () => ({ body: [env.latest] }),
      'PATCH /environments/e1': (body) => ({
        body: { ...env, ...(body as object), updatedAt: '2026-11-14T09:00:00.000Z' },
      }),
    };
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.getAttribute('href') ?? '');
    });
    open('/w/net/environments/e1');
    const spec = (await screen.findByRole('heading', { name: 'Spec' })).closest(
      'section',
    ) as HTMLElement;
    fireEvent.change(within(spec).getByLabelText('Collection 1'), {
      target: { value: 'fortinet.fortios' },
    });
    fireEvent.click(await screen.findByRole('link', { name: 'Save and get ansible-builder file' }));
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(new URL(clicked[0] ?? '', 'http://x').pathname).toBe(
      '/api/v1/environments/e1/execution-environment.yml',
    );
    expect(sent('PATCH /environments/e1')).toHaveLength(1);
    expect(await screen.findByRole('link', { name: 'ansible-builder file' })).toBeTruthy();
    vi.restoreAllMocks();
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
    expect(screen.queryByRole('button', { name: /^Build/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save the spec' })).toBeNull();
    expect(await screen.findByRole('link', { name: 'ansible-builder file' })).toBeTruthy();
  });

  it('AFS-161: a collection added leaves the search results and comes back when removed', async () => {
    routes = {
      'GET /session': () => ({ body: rita }),
      'GET /workspaces/net': () => ({ body: { ...net, level: 'rw' } }),
      'GET /environments/e1': () => ({ body: env }),
      'GET /environments/e1/builds': () => ({ body: [env.latest] }),
      'GET /galaxy/search?q=ios': () => ({
        body: [
          { name: 'cisco.ios', version: '11.7.0' },
          { name: 'cisco.iosxr', version: '12.1.0' },
        ],
      }),
    };
    open('/w/net/environments/e1');
    const spec = (await screen.findByRole('heading', { name: 'Spec' })).closest(
      'section',
    ) as HTMLElement;
    fireEvent.change(within(spec).getByLabelText('Add a collection'), { target: { value: 'ios' } });
    fireEvent.click(within(spec).getByRole('button', { name: 'Search' }));
    const found = await within(spec).findByRole('list', { name: 'Collections found' });
    // cisco.ios is in the spec already: only cisco.iosxr is offered.
    expect(within(found).queryByRole('button', { name: 'Add cisco.ios' })).toBeNull();
    fireEvent.click(within(found).getByRole('button', { name: 'Add cisco.iosxr' }));
    expect((within(spec).getByLabelText('Collection 2') as HTMLInputElement).value).toBe(
      'cisco.iosxr',
    );
    expect(within(spec).queryByRole('list', { name: 'Collections found' })).toBeNull();
    expect(within(spec).getByText(/Every collection found is in the spec already/)).toBeTruthy();
    fireEvent.click(within(spec).getByRole('button', { name: 'Remove collection 1' }));
    const again = within(spec).getByRole('list', { name: 'Collections found' });
    expect(within(again).getByRole('button', { name: 'Add cisco.ios' })).toBeTruthy();
    expect(within(again).queryByRole('button', { name: 'Add cisco.iosxr' })).toBeNull();
  });

  it('AFS-161: Save and build sit together in the spec form, and build saves first', async () => {
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
    };
    open('/w/net/environments/e1');
    const spec = (await screen.findByRole('heading', { name: 'Spec' })).closest(
      'section',
    ) as HTMLElement;
    const bar = within(spec).getByRole('button', { name: 'Save the spec' }).parentElement;
    expect(bar?.className).toBe('actions');
    expect(within(bar as HTMLElement).getByRole('button', { name: 'Build again' })).toBeTruthy();
    // Nothing changed: building does not save.
    fireEvent.click(within(spec).getByRole('button', { name: 'Build again' }));
    expect(await screen.findByRole('button', { name: 'Building…' })).toBeTruthy();
    expect(sent('PATCH /environments/e1')).toHaveLength(0);
    expect(sent('POST /environments/e1/builds')).toHaveLength(1);
  });

  it('AFS-163: the server default image is shown, and an administrator picks an environment', async () => {
    let picked: string | null = null;
    const now = () =>
      picked
        ? {
            image: IMAGE,
            configured: 'ghcr.io/ansible/community-ansible-dev-tools:latest',
            environment: { id: 'e1', name: 'net-tools', workspace: 'w1', workspaceKey: 'net' },
          }
        : {
            image: 'ghcr.io/ansible/community-ansible-dev-tools:latest',
            configured: 'ghcr.io/ansible/community-ansible-dev-tools:latest',
          };
    routes = {
      'GET /session': () => ({ body: { ...rita, admin: true } }),
      'GET /workspaces/net': () => ({ body: { ...net, level: 'admin' } }),
      'GET /environments/e1': () => ({ body: env }),
      'GET /environments/e1/builds': () => ({ body: [env.latest] }),
      'GET /default-environment': () => ({ body: now() }),
      'PUT /default-environment': (body) => {
        picked = (body as { environment: string | null }).environment;
        return { body: now() };
      },
    };
    open('/w/net/environments/e1');
    const fact = await screen.findByText(/no: they get/);
    expect(fact.closest('dd')?.textContent).toMatch(/community-ansible-dev-tools/);
    fireEvent.click(screen.getByRole('button', { name: "Make it the server's default" }));
    expect(
      await screen.findByText(/yes: launch configurations without an environment/),
    ).toBeTruthy();
    expect(sent('PUT /default-environment')).toEqual([{ environment: 'e1' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Go back to AFS_EE_IMAGE' }));
    expect(await screen.findByText(/no: they get/)).toBeTruthy();
    expect(sent('PUT /default-environment')[1]).toEqual({ environment: null });
  });

  it('AFS-163: the list says which image is the default; others cannot pick', async () => {
    routes = {
      'GET /session': () => ({ body: rita }),
      'GET /workspaces/net': () => ({ body: { ...net, level: 'rw' } }),
      'GET /workspaces/net/projects': () => ({ body: [] }),
      'GET /workspaces/net/environments': () => ({ body: [env] }),
      'GET /default-environment': () => ({
        body: {
          image: IMAGE,
          configured: 'ghcr.io/ansible/community-ansible-dev-tools:latest',
          environment: { id: 'e1', name: 'net-tools', workspace: 'w1', workspaceKey: 'net' },
        },
      }),
      'GET /environments/e1': () => ({ body: env }),
      'GET /environments/e1/builds': () => ({ body: [env.latest] }),
    };
    open('/w/net/-/environments');
    expect(await screen.findByText("server's default")).toBeTruthy();
    const line = document.querySelector('[data-server-default]') as HTMLElement;
    expect(line.textContent).toMatch(/from the environment net-tools/);
    cleanup();
    open('/w/net/environments/e1');
    expect(
      await screen.findByText(/yes: launch configurations without an environment/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /server's default|AFS_EE_IMAGE/ })).toBeNull();
  });
});
