// AFS-176: links to actions on the pages, with the server played by the test. A link with every
// value is a confirm page (Run is the page's POST); with some missing, the short form asks only
// those; a name the action does not ask is said in words; an action set to run on open starts
// once and says so; sign-in keeps the link; and the Settings make the NetBox and Zabbix links.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkDefaults, linkTemplate, netboxValue } from '../../src/web/actionLinks';
import { ConfigActionSection } from '../../src/web/actions';
import { App } from '../../src/web/app';

const mia = { id: 'u9', login: 'mia', name: 'Mia Lund', admin: false, groups: [] };
const form = {
  id: 'c1',
  title: 'Provision the load balancer',
  summary: 'Provisions a load balancer from its NetBox record.',
  mode: 'check',
  confirm: true,
  fields: [
    { name: 'device', label: 'Device', type: 'string', required: true, text: '' },
    { name: 'ip', label: 'Address', type: 'string', required: true, text: '' },
  ],
  happens: ['It runs as a check: it shows what would change, and changes nothing.'],
  ask: ['Wanda Rossi (who set up this action)'],
  replies: 'netbox',
};
const link = (extra: object = {}) => ({
  form,
  values: { device: 'bigip-edge-01', ip: '192.0.2.10' },
  given: ['device', 'ip'],
  missing: [],
  problems: [],
  ready: true,
  reply: 'dcim.device:1',
  ...extra,
});
const progress = {
  action: { id: 'c1', title: form.title },
  run: {
    id: 'r1',
    number: 3,
    state: 'queued',
    createdAt: new Date().toISOString(),
    words: 'waiting to start',
    mode: 'check',
    startedBy: 'Mia Lund',
  },
  headline: 'Waiting to start.',
  steps: [],
  done: 0,
  total: 0,
  ask: form.ask,
  inputs: [{ label: 'Device', value: 'bigip-edge-01' }],
};

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

const QUERY = '?device=bigip-edge-01&ip=192.0.2.10&_reply=dcim.device:1';
const base = () => ({
  'GET /session': () => ({ body: mia }),
  'GET /workspaces': () => ({ body: [] }),
  'GET /actions': () => ({ body: [] }),
  'GET /approvals': () => ({ body: [] }),
  'POST /actions/c1/run': () => ({
    status: 201,
    body: { id: 'r1', number: 3, state: 'queued', progress: '/actions/runs/r1' },
  }),
  'GET /actions/runs/r1': () => ({ body: progress }),
});
const runs = () => asked.filter((a) => a.key === 'POST /actions/c1/run');

describe('a link to an action', () => {
  it('with every value: a confirm page; opening it runs nothing; Run posts with the reply', async () => {
    routes = { ...base(), [`GET /actions/c1/link${QUERY}`]: () => ({ body: link() }) };
    window.history.replaceState(null, '', `/a/c1${QUERY}`);
    render(<App />);
    expect(await screen.findByText(/The link gives everything it needs/)).toBeTruthy();
    expect(screen.getByText('bigip-edge-01')).toBeTruthy();
    expect(screen.getByText('192.0.2.10')).toBeTruthy();
    expect(screen.getByText(/NetBox gets a journal entry on the device 1/)).toBeTruthy();
    expect(runs()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(runs()[0]?.body).toEqual({
        inputs: { device: 'bigip-edge-01', ip: '192.0.2.10' },
        link: true,
        reply: 'dcim.device:1',
      }),
    );
    await waitFor(() => expect(window.location.pathname).toBe('/actions/runs/r1'));
    expect(screen.queryByText(/The link started/)).toBeNull();
  });

  it('with a value missing: the form asks only that one; the given ones are listed', async () => {
    vi.stubGlobal('confirm', () => true);
    routes = {
      ...base(),
      'GET /actions/c1/link?device=bigip-edge-01': () => ({
        body: link({
          values: { device: 'bigip-edge-01', ip: '' },
          given: ['device'],
          missing: ['ip'],
          ready: false,
          reply: undefined,
        }),
      }),
    };
    window.history.replaceState(null, '', '/a/c1?device=bigip-edge-01');
    render(<App />);
    expect(await screen.findByText(/fill in the rest, then Run/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'From the link' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /Device/ })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: /Address/ }), {
      target: { value: '192.0.2.11' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(runs()[0]?.body).toEqual({
        inputs: { device: 'bigip-edge-01', ip: '192.0.2.11' },
        link: true,
      }),
    );
  });

  it('a name the action does not ask: said in words, nothing to run', async () => {
    routes = {
      ...base(),
      'GET /actions/c1/link?retries=9': () => ({
        body: link({
          ready: false,
          refused:
            'This link gives a value for retries, which "Provision the load balancer" does not ask: it runs with its own value. Ask whoever made the link to fix it.',
        }),
      }),
    };
    window.history.replaceState(null, '', '/a/c1?retries=9');
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/value for retries/);
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
  });

  it('an action that runs on open: the page starts it once and the progress says so', async () => {
    routes = {
      ...base(),
      [`GET /actions/c1/link${QUERY}`]: () => ({
        body: link({ form: { ...form, runOnOpen: true } }),
      }),
    };
    window.history.replaceState(null, '', `/a/c1${QUERY}`);
    render(<App />);
    expect(await screen.findByText(/The link started Provision the load balancer/)).toBeTruthy();
    expect(window.location.pathname).toBe('/actions/runs/r1');
    expect(runs()).toHaveLength(1);
  });

  it('AFS-207: run on open takes the link page out of the history; opened again, it opens that run', async () => {
    routes = {
      ...base(),
      [`GET /actions/c1/link${QUERY}`]: () => ({
        body: link({ form: { ...form, runOnOpen: true } }),
      }),
    };
    window.history.replaceState(null, '', '/actions');
    window.history.pushState(null, '', `/a/c1${QUERY}`);
    const length = window.history.length;
    render(<App />);
    expect(await screen.findByText(/The link started/)).toBeTruthy();
    // Replaced, not pushed: Back goes where the person came from, not to the link.
    expect(window.history.length).toBe(length);
    cleanup();

    // Opened again (Back in another tab, the history): the server names the run of a moment ago.
    routes = {
      ...routes,
      'POST /actions/c1/run': () => ({
        status: 409,
        body: {
          error: 'duplicate',
          message:
            'You started "Provision the load balancer" with the same values 4 s ago (run #3)',
          run: { id: 'r1', number: 3, progress: '/actions/runs/r1' },
        },
      }),
    };
    window.history.replaceState(null, '', `/a/c1${QUERY}`);
    render(<App />);
    expect(await screen.findByText(/it did not start another run/)).toBeTruthy();
    expect(window.location.pathname).toBe('/actions/runs/r1');
  });

  it("AFS-207: an action that is off or not one's own says so, with the way back", async () => {
    routes = {
      ...base(),
      [`GET /actions/c1/link${QUERY}`]: () => ({
        status: 404,
        body: {
          error: 'not_found',
          message: '"Provision" is switched off for now: ask Wanda Rossi when it will be.',
        },
      }),
    };
    window.history.replaceState(null, '', `/a/c1${QUERY}`);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'This action cannot be run' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/switched off.*Wanda Rossi/);
    expect(screen.getByRole('link', { name: 'Back to actions' }).getAttribute('href')).toBe(
      '/actions',
    );
  });

  it('signed out: the sign-in page keeps the link, a provider comes back to it', async () => {
    routes = {
      'GET /session': () => ({ status: 204 }),
      'GET /setup': () => ({ body: { needed: false } }),
      'GET /auth/methods': () => ({
        body: { local: 'all', providers: [{ key: 'corp', name: 'Corp' }] },
      }),
    };
    window.history.replaceState(null, '', `/a/c1${QUERY}`);
    render(<App />);
    const provider = await screen.findByRole('link', { name: 'Sign in with Corp' });
    expect(decodeURIComponent(provider.getAttribute('href') ?? '')).toContain(
      `return=/a/c1${QUERY}`,
    );
    expect(window.location.search).toBe(QUERY);
  });
});

describe('Copy link for NetBox and Zabbix', () => {
  const action = {
    id: 'c1',
    title: 'Provision the load balancer',
    summary: 'x',
    asked: [
      { name: 'device', label: 'Device' },
      { name: 'ip', label: 'Address' },
    ],
    mode: 'check' as const,
    confirm: true,
    enabled: true,
    reply: { system: 'netbox' as const, credential: 'k1', when: 'ended' as const },
    updatedAt: '',
  };
  it("AFS-207: by default the object's name goes to the host list, its site to a site", () => {
    const asked = [
      { name: 'site', label: 'Site' },
      { name: 'devices', label: 'Switch' },
      { name: 'note', label: 'Why' },
    ];
    const types = { site: 'string', devices: 'host_list', note: 'string' };
    expect(linkDefaults(asked, types, 'netbox')).toEqual({
      site: 'object.site.name',
      devices: 'object.name',
      note: '',
    });
    expect(linkDefaults(asked, types, 'zabbix')).toEqual({
      site: '',
      devices: '{HOST.HOST}',
      note: '',
    });
  });

  it('makes the NetBox link with Jinja and the Zabbix script with macros', () => {
    expect(netboxValue('object.name')).toBe('{{ object.name|string|urlencode }}');
    expect(netboxValue('object.primary_ip4.address.ip')).toBe(
      "{{ object.primary_ip4.address.ip|string|urlencode if object.primary_ip4 else '' }}",
    );
    const nb = linkTemplate('https://afs.example.net', action, 'netbox', {
      device: 'object.name',
      ip: 'object.primary_ip4.address.ip',
    });
    expect(nb.url).toBe(
      "https://afs.example.net/a/c1?device={{ object.name|string|urlencode }}&ip={{ object.primary_ip4.address.ip|string|urlencode if object.primary_ip4 else '' }}&_reply=dcim.device:{{ object.id }}",
    );
    expect(nb.netbox).toMatchObject({ object_types: ['dcim.device'], link_url: nb.url });
    const zb = linkTemplate(
      'https://afs.example.net',
      { ...action, reply: { system: 'zabbix', credential: 'k2', when: 'ended' } },
      'zabbix',
      { device: '{HOST.HOST}', ip: '' },
      { scope: 'problem' },
    );
    expect(zb.url).toBe('https://afs.example.net/a/c1?device={HOST.HOST}&_reply=event:{EVENT.ID}');
    expect(zb.zabbix).toMatchObject({
      method: 'script.create',
      params: { type: 6, scope: 4, url: zb.url },
    });
  });

  it('the Settings show the link, make a signed link shown once, and revoke one', async () => {
    vi.stubGlobal('confirm', () => true);
    let tokens = [
      { id: 't0', name: 'old webhook', hint: 'abcd', createdAt: '', createdBy: 'wanda' },
    ];
    routes = {
      'GET /launch-configs/c1/action': () => ({
        body: { action, grants: [], tokens, mayManage: true },
      }),
      'GET /workspaces/net/credentials': () => ({ body: [] }),
      'POST /launch-configs/c1/action/tokens': () => {
        tokens = [
          ...tokens,
          { id: 't1', name: 'Zabbix action', hint: 'wxyz', createdAt: '', createdBy: 'wanda' },
        ];
        return { status: 201, body: { ...tokens[1], token: `afsl_${'x'.repeat(39)}wxyz` } };
      },
      'DELETE /launch-configs/c1/action/tokens/t0': () => ({ status: 204 }),
    };
    render(<ConfigActionSection config="c1" name="Provision" inputs={[]} workspace="net" />);
    expect(
      await screen.findByRole('heading', { name: 'Links from NetBox and Zabbix' }),
    ).toBeTruthy();
    expect(document.body.textContent).toContain('/a/c1?device={{ object.name|string|urlencode }}');
    expect(document.body.textContent).toContain('"object_types": [');
    fireEvent.click(screen.getByRole('radio', { name: 'Zabbix' }));
    expect(document.body.textContent).toContain('"method": "script.create"');
    expect(document.body.textContent).toContain('device={HOST.HOST}');
    fireEvent.change(screen.getByRole('textbox', { name: /Name/ }), {
      target: { value: 'Zabbix action' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Make a signed link' }));
    expect(await screen.findByText(/shown this once/)).toBeTruthy();
    expect(document.body.textContent).toContain(`afsl_${'x'.repeat(39)}wxyz`);
    expect(document.body.textContent).toContain('Authorization: Bearer afsl_');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke the signed link old webhook' }));
    await waitFor(() =>
      expect(asked.some((a) => a.key === 'DELETE /launch-configs/c1/action/tokens/t0')).toBe(true),
    );
  });

  it("AFS-232: Only hosts of group offers every group of the configuration's inventory, before the action is saved", async () => {
    routes = {
      'GET /launch-configs/c1/action': () => ({
        body: { action: null, grants: [], tokens: [], mayManage: true },
      }),
      'GET /workspaces/net/credentials': () => ({ body: [] }),
      'POST /launch-configs/c1/facts': () => ({
        body: {
          commit: 'a'.repeat(40),
          environment: 'ee',
          groups: ['all', 'core', 'edge', 'ungrouped'],
          groupHosts: {
            all: { count: 5, hosts: [] },
            core: { count: 1, hosts: ['core1'] },
            edge: { count: 4, hosts: ['e1', 'e2', 'e3', 'e4'] },
          },
        },
      }),
    };
    render(
      <ConfigActionSection
        config="c1"
        name="Provision"
        inputs={[{ name: 'device', type: 'host_list' } as never]}
        workspace="net"
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Make it an action' }));
    const ask = screen.getByRole('checkbox', { name: /Ask for/ }) as HTMLInputElement;
    if (!ask.checked) fireEvent.click(ask);
    const field = await screen.findByRole('combobox', { name: /Only hosts of group/ });
    const list = document.getElementById(field.getAttribute('list') ?? '');
    await waitFor(() =>
      expect(
        [...(list?.querySelectorAll('option') ?? [])].map((o) => [o.value, o.textContent]),
      ).toEqual([
        ['core', '1 host'],
        ['edge', '4 hosts'],
      ]),
    );
    // Asked for the groups with no values typed; not the saved action's (narrowed) hosts.
    expect(asked.filter((a) => a.key === 'POST /launch-configs/c1/facts')[0]?.body).toEqual({
      inputs: {},
      groups: true,
    });
    expect(asked.some((a) => a.key.includes('/hosts'))).toBe(false);
  });
});
