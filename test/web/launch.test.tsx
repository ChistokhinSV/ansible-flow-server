// The launch pages with the server played by the test: a project's configurations, the launch
// form (secret inputs hidden, what would run, problems at their fields, Launch, start values),
// and adding one. AFS-85: the configuration's page in tabs (Launch, Runs, Schedules, Settings).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Run, User } from '../../src/web/api';
import { App } from '../../src/web/app';
import {
  LaunchConfigPage,
  LaunchConfigsSection,
  type LaunchTab,
  listSuggestions,
  toggleName,
} from '../../src/web/launch';

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
  notify: { to: ['ops'], when: 'failed' },
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

/** A run of the flow, as the server lists it. */
const run = (n: number, state: string, of?: string, at = '2026-11-13T12:00:00.000Z') =>
  ({
    id: `r${n}`,
    number: n,
    project: 'p1',
    ...(of ? { config: { id: of, name: of === 'c1' ? 'Nightly check' : 'Another' } } : {}),
    commit: COMMIT,
    flow,
    mode: 'check',
    inputs: {},
    targets: [],
    credentials: [],
    state,
    requestedBy: { id: 'u1', login: 'dana' },
    createdAt: at,
    attempts: 1,
    cancelRequested: false,
  }) as Run;

let asked: { key: string; body?: unknown }[];
let routes: Record<string, (body?: unknown) => { status?: number; body?: unknown }>;
beforeEach(() => {
  asked = [];
  window.localStorage.clear();
  window.scrollTo = () => undefined;
  // AFS-134: a real launch asks first; the tests say yes.
  window.confirm = () => true;
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
    // AFS-85: launching is one step from the project's page.
    const launch = screen.getByRole('link', { name: 'Launch Nightly check' });
    expect(launch.getAttribute('href')).toBe('/w/net/core/launch/c1');
    expect(launch.className).toBe('button');
  });

  it('say how the newest run of each went, and offer Launch to who may launch (AFS-85)', async () => {
    const other = { ...config, id: 'c2', name: 'Weekly real', flowFile: 'flows/other.flow.yaml' };
    // The server says each configuration's newest run; one that never ran has none.
    const lastRun = {
      id: 'r8',
      number: 8,
      state: 'succeeded',
      createdAt: '2026-11-13T12:00:00.000Z',
      endedAt: '2026-11-13T12:02:00.000Z',
    };
    routes = {
      'GET /projects/p1/launch-configs': () => ({ body: [{ ...config, lastRun }, other] }),
      'GET /projects/p1/access': () => ({
        body: { admin: false, workspace: 'ro', approve: false, flows: { [flow.file]: 'operator' } },
      }),
    };
    render(
      <LaunchConfigsSection
        me={omar as unknown as User}
        workspace="net"
        project={project as unknown as Project}
      />,
    );
    const row = (await screen.findByRole('link', { name: 'Nightly check' })).closest(
      'tr',
    ) as HTMLElement;
    const last = within(row).getByRole('link', { name: /went well/ });
    expect(last.getAttribute('href')).toBe('/runs/r8');
    expect(await within(row).findByRole('link', { name: 'Launch Nightly check' })).toBeTruthy();
    // ro on the other flow: its page still opens, there is no Launch.
    const quiet = screen.getByRole('link', { name: 'Weekly real' }).closest('tr') as HTMLElement;
    expect(within(quiet).getByText('none yet')).toBeTruthy();
    expect(within(quiet).queryByRole('link', { name: /^Launch/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add a launch configuration' })).toBeNull();
  });
});

describe("a launch configuration's tabs (AFS-85)", () => {
  const page = (tab: LaunchTab, me = dana) =>
    render(
      <LaunchConfigPage
        me={me as unknown as User}
        workspace="net"
        project="core"
        id="c1"
        tab={tab}
      />,
    );
  const RUNS = 'GET /runs?config=c1&limit=100';

  it('Launch: the form first, the rare fields folded, the settings in one line', async () => {
    routes = common(dana);
    page('launch');
    const launch = await screen.findByRole('button', { name: 'Launch' });
    // AFS-152: the form is read once the configuration is there.
    await screen.findByLabelText(/^devices/);
    // The inputs come before the button; AFS-138: the branch and limit too, folded, before the
    // mode, so a limit is seen before Launch.
    const precedes = (a: Element, b: Element) =>
      !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(precedes(screen.getByLabelText(/^devices/), launch)).toBe(true);
    expect(precedes(screen.getByLabelText(/^Real/), launch)).toBe(true);
    const fold = screen.getByLabelText(/^Branch/).closest('details') as HTMLDetailsElement;
    expect(precedes(screen.getByLabelText(/^devices/), fold)).toBe(true);
    expect(precedes(fold, screen.getByLabelText(/^Real/))).toBe(true);
    expect(fold.open).toBe(false);
    expect(fold.contains(screen.getByLabelText('Limit'))).toBe(true);
    // No settings section over the form: one line, with the flow as a link to its page.
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
    const line = document.querySelector('.statusline') as HTMLElement;
    expect(within(line).getByRole('link', { name: flow.file }).getAttribute('href')).toBe(
      '/w/net/core/flow/flows/upgrade.flow.yaml',
    );
    expect(line.textContent).toContain('newest of main');
    expect(line.textContent).toContain('inventory inventory/hosts.yaml');
    expect(line.textContent).toContain("the server's default image");
    expect(line.textContent).toContain('1 credential');
    // AFS-169: whom its runs tell too.
    expect(line.textContent).toContain('tells ops, when a run fails');
    // The tabs are addresses; Change is one of them now.
    const tabs = screen.getByRole('navigation', { name: 'Launch configuration' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')]),
    ).toEqual([
      ['Launch', '/w/net/core/launch/c1', 'page'],
      ['Runs', '/w/net/core/launch/c1/runs', null],
      ['Schedules', '/w/net/core/launch/c1/schedules', null],
      ['Settings', '/w/net/core/launch/c1/settings', null],
    ]);
    expect(screen.queryByRole('link', { name: 'Change' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
    expect(screen.getByRole('heading', { name: 'What the flow needs' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Schedules' })).toBeNull();
    expect(asked.some((a) => a.key.startsWith('GET /runs'))).toBe(false);
  });

  it('Launch: each input says where it goes, under its hint (AFS-183)', async () => {
    const said =
      'Read by Upgrade (as target); wins over group_vars of edge (inventory/group_vars/edge.yml:3).';
    routes = {
      ...common(dana),
      'GET /launch-configs/c1/form?': () => ({ body: { ...form, origins: { retries: said } } }),
    };
    page('launch');
    const retries = await screen.findByLabelText(/^retries/);
    const hint = document.getElementById(retries.getAttribute('aria-describedby') ?? '');
    expect(hint?.querySelector('[data-origin="retries"]')?.textContent).toBe(said);
    // An input without one says nothing more.
    expect(document.querySelector('[data-origin="devices"]')).toBeNull();
  });

  it('Launch: a flow with errors names them, each a link to its step (AFS-164)', async () => {
    const errors = [
      { node: 'n1', step: 'Ping', message: 'No module is bound' },
      { node: 'n2', step: 'Backup', message: 'The fail port is not handled' },
      { message: 'The flow has no title' },
      ...['n4', 'n5', 'n6'].map((n) => ({ node: n, step: n, message: 'Wrong' })),
    ];
    routes = {
      ...common(dana),
      'GET /launch-configs/c1/form?': () => ({
        status: 422,
        body: {
          error: 'not_ready',
          message: 'The flow has 6 errors, so it cannot run until they are fixed: …',
          problems: [{ field: 'flowFile', message: 'The flow has 6 errors…', errors }],
        },
      }),
    };
    page('launch');
    const note = (await screen.findAllByRole('alert')).find((a) =>
      a.textContent?.startsWith('The flow has'),
    ) as HTMLElement;
    expect(note.textContent).toContain(
      'The flow has 6 errors, so it cannot run until they are fixed:',
    );
    const links = within(note).getAllByRole('link');
    // Five, then how many more; an administrator may edit: the flow opens for editing there.
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Ping', '/w/net/core/flow/flows/upgrade.flow.yaml?step=n1&edit=1'],
      ['Backup', '/w/net/core/flow/flows/upgrade.flow.yaml?step=n2&edit=1'],
      ['The flow', '/w/net/core/flow/flows/upgrade.flow.yaml?edit=1'],
      ['n4', '/w/net/core/flow/flows/upgrade.flow.yaml?step=n4&edit=1'],
      ['n5', '/w/net/core/flow/flows/upgrade.flow.yaml?step=n5&edit=1'],
      ['and 1 more', '/w/net/core/flow/flows/upgrade.flow.yaml?edit=1'],
    ]);
    expect(note.textContent).toContain('Ping: No module is bound');
  });

  it('Launch: a configuration with a limit shows it, the fold open', async () => {
    routes = {
      ...common(dana),
      'GET /launch-configs/c1/form?': () => ({ body: { ...form, limit: 'edge' } }),
    };
    page('launch');
    const limit = (await screen.findByDisplayValue('edge')) as HTMLInputElement;
    expect((limit.closest('details') as HTMLDetailsElement).open).toBe(true);
  });

  it('Runs: the runs of this configuration, asked of the server', async () => {
    routes = {
      ...common(dana),
      [RUNS]: () => ({
        body: [
          run(12, 'running', 'c1', '2026-11-13T12:00:00.000Z'),
          run(10, 'failed', 'c1', '2026-11-13T10:00:00.000Z'),
        ],
      }),
    };
    page('runs');
    const list = (await screen.findByRole('region', { name: 'Runs' })) as HTMLElement;
    await within(list).findByText('#12');
    expect(
      within(list)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/runs/r12', '/runs/r10', '/runs']);
    // The server filters: nothing says the list is a part of something.
    expect(within(list).queryByText(/Looks among/)).toBeNull();
    expect(within(list).queryByRole('button', { name: 'Older runs' })).toBeNull();
    expect(
      within(screen.getByRole('navigation', { name: 'Launch configuration' }))
        .getByRole('link', { name: 'Runs' })
        .getAttribute('aria-current'),
    ).toBe('page');
    // The launch form is on its own tab.
    expect(screen.queryByRole('button', { name: 'Launch' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'What the flow needs' })).toBeNull();
  });

  it('Runs: says when there is none', async () => {
    routes = { ...common(dana), [RUNS]: () => ({ body: [] }) };
    page('runs');
    expect(await screen.findByText('No run of this configuration yet.')).toBeTruthy();
  });

  it('Runs: older runs are a page further, from where the last one ended', async () => {
    const newest = Array.from({ length: 100 }, (_, i) =>
      run(300 - i, 'succeeded', 'c1', new Date(Date.UTC(2026, 10, 13, 12, 0, -i)).toISOString()),
    );
    const last = newest[99] as { createdAt: string; number: number; id: string };
    const cursor = encodeURIComponent(`${last.createdAt},${last.number},${last.id}`);
    routes = {
      ...common(dana),
      [RUNS]: () => ({ body: newest }),
      [`GET /runs?config=c1&limit=100&before=${cursor}`]: () => ({
        body: [run(42, 'failed', 'c1', '2026-11-12T08:00:00.000Z')],
      }),
    };
    page('runs');
    const list = (await screen.findByRole('region', { name: 'Runs' })) as HTMLElement;
    fireEvent.click(await within(list).findByRole('button', { name: 'Older runs' }));
    await within(list).findByText('#42');
    expect(within(list).getByText('#300')).toBeTruthy();
    expect(within(list).getByText('No older runs.')).toBeTruthy();
  });

  it('Schedules: the schedules, and nothing of the other tabs', async () => {
    routes = { ...common(dana), 'GET /launch-configs/c1/schedules': () => ({ body: [] }) };
    page('schedules');
    await screen.findByRole('heading', { name: 'Schedules' });
    expect(await screen.findByText('No schedule.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Launch' })).toBeNull();
  });

  it('Settings: the form is changed in place and says Saved; Delete is under it', async () => {
    let now = config;
    routes = {
      ...common(dana),
      'GET /launch-configs/c1': () => ({ body: now }),
      'GET /projects/p1/flows': () => ({ body: { flows: [{ ...flow, problems: [] }] } }),
      'GET /workspaces/net/credentials': () => ({
        body: [{ id: 'k1', name: 'lab key', kind: 'ssh_key' }],
      }),
      'GET /workspaces/net/environments': () => ({ body: [] }),
      'PATCH /launch-configs/c1': (body) => {
        now = { ...config, ...(body as object), inventory: 'inventory/lab.yaml' };
        return { body: now };
      },
      'DELETE /launch-configs/c1': () => ({ status: 204 }),
    };
    vi.stubGlobal('confirm', () => true);
    window.history.replaceState(null, '', '/w/net/core/launch/c1/settings');
    page('settings');
    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    expect(name.value).toBe('Nightly check');
    expect(screen.queryByRole('button', { name: 'Launch' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Inventory/), {
      target: { value: 'inventory/lab.yaml' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('status')).textContent).toBe('Saved.');
    expect(asked.find((a) => a.key === 'PATCH /launch-configs/c1')?.body).toMatchObject({
      name: 'Nightly check',
      flowFile: 'flows/upgrade.flow.yaml',
      inventory: 'inventory/lab.yaml',
      credentials: ['k1'],
    });
    // It stays on the tab, and the line under the title follows.
    expect(window.location.pathname).toBe('/w/net/core/launch/c1/settings');
    await waitFor(() =>
      expect(document.querySelector('.statusline')?.textContent).toContain('inventory/lab.yaml'),
    );
    // Typing again takes the word back.
    fireEvent.change(name, { target: { value: 'Nightly' } });
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete this launch configuration' }));
    await waitFor(() => expect(window.location.pathname).toBe('/w/net/core'));
    expect(asked.some((a) => a.key === 'DELETE /launch-configs/c1')).toBe(true);
  });

  it('Settings: who may not change them reads them', async () => {
    routes = common(omar);
    page('settings', omar);
    expect(await screen.findByText(/Changing them needs rw/)).toBeTruthy();
    expect(screen.getByText('Tells')).toBeTruthy();
    expect(screen.getByText('ops, when a run fails')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
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
    // AFS-140: the problem goes once its field is changed, not at the next question.
    expect(secret.getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByText('api_password is required')).toBeNull();
    expect(screen.queryByText(/Some fields need a look/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'What would run' }));
    await screen.findByRole('heading', { name: 'What would run' });
    expect(secret.getAttribute('aria-invalid')).toBeNull();
    expect(screen.getByText('***')).toBeTruthy();
    const sent = asked.filter((a) => a.key === 'POST /launch-configs/c1/check').at(-1);
    expect(sent?.body).toEqual({
      inputs: { devices: 'fw-edge-01', api_password: 's3cret-value', retries: '3' },
    });
    // AFS-67: reading the hosts starts a container: ro does not ask.
    expect(screen.queryByRole('heading', { name: 'Hosts in the inventory' })).toBeNull();
    expect(asked.some((a) => a.key === 'POST /launch-configs/c1/facts')).toBe(false);
  });

  it('who may launch sees the hosts the inventory resolves the targets to (AFS-67)', async () => {
    routes = {
      ...common(dana),
      'POST /launch-configs/c1/check': () => ({
        body: {
          launch: {
            config: 'c1',
            project: 'p1',
            commit: COMMIT,
            flow,
            mode: 'check',
            inputs: { devices: ['edge', 'fw-lab-09'] },
            targets: ['edge', 'fw-lab-09'],
            credentials: [],
          },
          form,
        },
      }),
      'POST /launch-configs/c1/facts': () => ({
        body: {
          facts: {
            sources: ['inventory/prod/hosts.yaml'],
            count: 2,
            hosts: ['fw-edge-01', 'fw-edge-02'],
            unknown: ['fw-lab-09'],
            uses: [],
            prod: ['prod'],
            vault: false,
            environment: 'ee:1 (docker)',
          },
          environment: 'ee:1 (docker)',
          commit: COMMIT,
        },
      }),
    };
    window.history.replaceState(null, '', '/w/net/core/launch/c1');
    render(<App />);
    fireEvent.change(await screen.findByLabelText(/api_password/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'What would run' }));
    await screen.findByRole('heading', { name: 'Hosts in the inventory' });
    expect(await screen.findByText('Hosts: 2 (fw-edge-01, fw-edge-02)')).toBeTruthy();
    expect(screen.getByText('Not in the inventory: fw-lab-09')).toBeTruthy();
    expect(screen.getByText('Production-looking: prod')).toBeTruthy();
    // The same request as the check.
    const check = asked.find((a) => a.key === 'POST /launch-configs/c1/check');
    // The one for the check (the groups were asked for when the tab opened, AFS-99).
    const facts = asked.find(
      (a) => a.key === 'POST /launch-configs/c1/facts' && !(a.body as { groups?: boolean }).groups,
    );
    expect(facts?.body).toEqual(check?.body);
  });

  it('a host list offers the inventory groups as buttons and while typing, read once (AFS-97, AFS-99)', async () => {
    routes = {
      ...common(dana),
      'POST /launch-configs/c1/facts': () => ({
        body: { groups: ['edge', 'lab', 'prod'], environment: 'ee:1 (docker)', commit: COMMIT },
      }),
    };
    window.history.replaceState(null, '', '/w/net/core/launch/c1');
    render(<App />);
    const devices = (await screen.findByLabelText(/devices/)) as HTMLInputElement;
    // Read when the tab opens, as the canvas's dialog reads them when it opens.
    const groups = await screen.findByRole('group', { name: 'Groups for devices' });
    expect(asked.find((a) => a.key === 'POST /launch-configs/c1/facts')?.body).toMatchObject({
      groups: true,
    });
    // A button adds its group to what is there, and takes it out again.
    expect(devices.value).toBe('fw-edge-01');
    fireEvent.click(within(groups).getByRole('button', { name: 'lab' }));
    expect(devices.value).toBe('fw-edge-01, lab');
    expect(within(groups).getByRole('button', { name: 'lab' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(within(groups).getByRole('button', { name: 'lab' }));
    expect(devices.value).toBe('fw-edge-01');
    // Suggestions start with what is typed (a browser shows only those).
    const options = () =>
      [...(document.getElementById(devices.getAttribute('list') ?? '')?.children ?? [])].map(
        (o) => (o as HTMLOptionElement).value,
      );
    expect(options()).toEqual(['fw-edge-01, edge', 'fw-edge-01, lab', 'fw-edge-01, prod']);
    fireEvent.change(devices, { target: { value: 'edge, l' } });
    expect(options()).toEqual(['edge, lab']);
    expect(asked.filter((a) => a.key === 'POST /launch-configs/c1/facts')).toHaveLength(1);
  });

  it('targets the inventory lacks and a limit that leaves none are said at the field (AFS-147)', async () => {
    routes = {
      ...common(dana),
      'POST /launch-configs/c1/facts': (body) => {
        const typed = (body as { inputs?: { devices?: string }; limit?: string }) ?? {};
        const unknown = /nosuchhost/.test(typed.inputs?.devices ?? '') ? ['nosuchhost'] : [];
        return {
          body: {
            groups: ['edge'],
            groupHosts: { edge: { count: 2, hosts: ['fw-edge-01', 'fw-edge-02'] } },
            facts: {
              sources: ['inventory/hosts.yaml'],
              count: 1,
              hosts: ['fw-edge-01'],
              unknown,
              uses: [],
              prod: [],
              vault: false,
              environment: 'ee:1 (docker)',
            },
            ...(typed.limit ? { limited: { pattern: typed.limit, hosts: [], count: 0 } } : {}),
            environment: 'ee:1 (docker)',
            commit: COMMIT,
          },
        };
      },
    };
    window.history.replaceState(null, '', '/w/net/core/launch/c1');
    render(<App />);
    const devices = (await screen.findByLabelText(/devices/)) as HTMLInputElement;
    // A group's button says how many hosts it adds.
    const groups = await screen.findByRole('group', { name: 'Groups for devices' });
    expect(within(groups).getByRole('button', { name: /edge/ }).textContent).toBe('edge · 2');
    fireEvent.change(devices, { target: { value: 'fw-edge-01, nosuchhost' } });
    expect(
      await screen.findByText(
        /Not in the inventory, so nothing runs there: nosuchhost/,
        undefined,
        {
          timeout: 3000,
        },
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Limit'), { target: { value: 'sw-edge-01' } });
    expect(
      await screen.findByText(/leaves none of the targets' hosts/, undefined, { timeout: 3000 }),
    ).toBeTruthy();
  });

  it('a limit emptied runs without one; a launch where no host would run asks; Enter launches (AFS-191)', async () => {
    routes = {
      ...common(dana),
      'GET /launch-configs/c1/form?': () => ({ body: { ...form, limit: 'nosuchhost' } }),
      'POST /launch-configs/c1/facts': (body) => {
        const typed = (body as { limit?: string }) ?? {};
        const limit = typed.limit ?? 'nosuchhost';
        return {
          body: {
            groups: [],
            facts: {
              sources: ['inventory/hosts.yaml'],
              count: 1,
              hosts: ['fw-edge-01'],
              unknown: [],
              uses: [],
              prod: [],
              vault: false,
              environment: 'ee:1 (docker)',
            },
            ...(limit ? { limited: { pattern: limit, hosts: [], count: 0 } } : {}),
            environment: 'ee:1 (docker)',
            commit: COMMIT,
          },
        };
      },
      'POST /launch-configs/c1/launch': () => ({
        status: 201,
        body: { id: 'r9', number: 9, state: 'queued' },
      }),
      'GET /runs/r9': () => ({ status: 404, body: { error: 'not_found', message: 'gone' } }),
    };
    const questions: string[] = [];
    let yes = false;
    vi.stubGlobal('confirm', (text: string) => {
      questions.push(text);
      return yes;
    });
    window.history.replaceState(null, '', '/w/net/core/launch/c1');
    render(<App />);
    const limit = (await screen.findByDisplayValue('nosuchhost')) as HTMLInputElement;
    expect(screen.getByText(/Empty: no limit/)).toBeTruthy();
    await screen.findByText(/leaves none of the targets' hosts/, undefined, { timeout: 3000 });
    // Enter in a field is Launch: asked first, and No keeps the page.
    fireEvent.submit(limit.closest('form') as HTMLFormElement);
    await waitFor(() => expect(questions).toHaveLength(1));
    expect(questions[0]).toMatch(
      /^Launch the check run\? No host would run: the limit nosuchhost leaves none/,
    );
    expect(asked.some((a) => a.key === 'POST /launch-configs/c1/launch')).toBe(false);
    // Emptied: no limit, said at the field, and the run is asked for without one.
    fireEvent.change(limit, { target: { value: '' } });
    await waitFor(
      () => expect(screen.queryByText(/leaves none of the targets' hosts/)).toBeNull(),
      {
        timeout: 3000,
      },
    );
    yes = true;
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(window.location.pathname).toBe('/runs/r9'));
    expect(questions).toHaveLength(1);
    const launched = asked.find((a) => a.key === 'POST /launch-configs/c1/launch');
    expect(launched?.body).toMatchObject({ limit: '' });
  });

  it('the groups keep one place while they are read, so the buttons do not move (AFS-138)', async () => {
    let answer: (v: unknown) => void = () => undefined;
    routes = {
      ...common(dana),
      // The answer's body comes when the test says.
      'POST /launch-configs/c1/facts': () => ({
        body: new Promise((r) => {
          answer = r;
        }),
      }),
    };
    window.history.replaceState(null, '', '/w/net/core/launch/c1');
    render(<App />);
    const reading = await screen.findByText("Reading the inventory's groups…");
    const slot = reading.closest('.group-slot');
    expect(slot).toBeTruthy();
    // None found: the same place says so, rather than closing up under the buttons.
    answer({ groups: [], environment: 'ee:1 (docker)', commit: COMMIT });
    const none = await screen.findByText('No groups to pick from the inventory.');
    expect(none.closest('.group-slot')).toBe(slot);
  });

  it('Recipients suggests the people and groups of the server (AFS-97)', async () => {
    routes = {
      ...common(dana),
      'GET /projects/p1/flows': () => ({ body: { flows: [{ ...flow, problems: [] }] } }),
      'GET /workspaces/net/credentials': () => ({ body: [] }),
      'GET /workspaces/net/environments': () => ({ body: [] }),
      'GET /workspaces/net/recipients': () => ({
        body: [
          { name: 'network-oncall', kind: 'group' },
          { name: 'dana', kind: 'user', label: 'Dana Admin' },
          { name: 'omar', kind: 'user', label: 'Omar Operator' },
        ],
      }),
    };
    window.history.replaceState(null, '', '/w/net/core/launch/c1/settings');
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Notify when'), { target: { value: 'failed' } });
    const whom = screen.getByLabelText(/^Recipients/) as HTMLInputElement;
    fireEvent.change(whom, { target: { value: 'dana, ' } });
    await waitFor(() => expect(whom.getAttribute('list')).toBeTruthy());
    const options = [...(document.getElementById(whom.getAttribute('list') ?? '')?.children ?? [])];
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual([
      'dana, network-oncall',
      'dana, omar',
    ]);
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
    fireEvent.click(screen.getByLabelText(/^Real/));

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
    expect(screen.getByText(/another branch or commit needs read/)).toBeTruthy();
    // AFS-191: said once, not again at each field.
    expect(screen.getAllByText(/needs read and write/)).toHaveLength(1);
  });
});

describe('AFS-150: leaving with typing not saved', () => {
  const LEAVE = 'Leave this page? What you typed is not saved.';
  const tab = (name: string) =>
    within(screen.getByRole('navigation', { name: 'Launch configuration' })).getByRole('link', {
      name,
    });
  const settingsRoutes = () => ({
    ...common(dana),
    'GET /projects/p1/access': () => ({
      body: { admin: true, workspace: 'rw', approve: true, flows: {} },
    }),
    'GET /projects/p1/flows': () => ({ body: { flows: [{ ...flow, problems: [] }] } }),
    'GET /workspaces/net/credentials': () => ({ body: [] }),
    'GET /workspaces/net/environments': () => ({ body: [] }),
  });

  it("a configuration's Settings ask before a tab loses the typing; typing it back does not", async () => {
    routes = settingsRoutes();
    const questions: string[] = [];
    let answer = false;
    vi.stubGlobal('confirm', (text: string) => {
      questions.push(text);
      return answer;
    });
    window.history.replaceState(null, '', '/w/net/core/launch/c1/settings');
    render(<App />);
    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'a10 lc one' } });
    fireEvent.click(tab('Launch'));
    expect(questions).toEqual([LEAVE]);
    expect(window.location.pathname).toBe('/w/net/core/launch/c1/settings');
    expect(name.value).toBe('a10 lc one');
    // As it was saved: nothing to lose, nothing asked.
    fireEvent.change(name, { target: { value: 'Nightly check' } });
    fireEvent.click(tab('Runs'));
    expect(questions).toHaveLength(1);
    await waitFor(() => expect(window.location.pathname).toBe('/w/net/core/launch/c1/runs'));
    answer = true;
  });

  it('the launch page asks when the configuration is left, not on its own tabs', async () => {
    routes = {
      ...settingsRoutes(),
      'GET /runs?config=c1&limit=100': () => ({ body: [] }),
    };
    const questions: string[] = [];
    vi.stubGlobal('confirm', (text: string) => {
      questions.push(text);
      return false;
    });
    window.history.replaceState(null, '', '/w/net/core/launch/c1');
    render(<App />);
    fireEvent.change(await screen.findByLabelText(/^retries/), { target: { value: '5' } });
    // Runs is a tab of the same page, which keeps the typing.
    fireEvent.click(tab('Runs'));
    await waitFor(() => expect(window.location.pathname).toBe('/w/net/core/launch/c1/runs'));
    expect(questions).toEqual([]);
    // The project's page does not.
    // AFS-154: the breadcrumb names the project (Core), or its key until the name is read.
    fireEvent.click(screen.getByRole('link', { name: /^(core|Core)$/ }));
    expect(questions).toEqual([LEAVE]);
    expect(window.location.pathname).toBe('/w/net/core/launch/c1/runs');
  });

  it('a new configuration asks before the page is left', async () => {
    routes = settingsRoutes();
    const questions: string[] = [];
    vi.stubGlobal('confirm', (text: string) => {
      questions.push(text);
      return false;
    });
    window.history.replaceState(null, '', '/w/net/core/launch/new');
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Upgrade' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(questions).toEqual([LEAVE]);
    expect(window.location.pathname).toBe('/w/net/core/launch/new');
  });

  it('an operator who types the address is told it needs rw, not given the form', async () => {
    routes = {
      ...common(omar),
      'GET /projects/p1/access': () => ({
        body: { admin: false, workspace: 'ro', approve: false, flows: { [flow.file]: 'operator' } },
      }),
    };
    window.history.replaceState(null, '', '/w/net/core/launch/new');
    render(<App />);
    expect(await screen.findByText(/needs rw on the flow it runs/)).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(asked.some((a) => a.key.startsWith('GET /workspaces/net/recipients'))).toBe(false);
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
    // The branches come in their own request: under load, after the flows.
    expect(await screen.findByRole('option', { name: 'try/idea' })).toBeTruthy();
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

describe('AFS-140: a launch configuration of a project without flows', () => {
  it('says there is no flow to run instead of an empty list', async () => {
    routes = {
      ...common(dana),
      'GET /projects/p1/flows': () => ({ body: { flows: [] } }),
    };
    window.history.replaceState(null, '', '/w/net/core/launch/new');
    render(<App />);
    expect(await screen.findByText(/The project has no flow yet/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Flow/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Make a flow on the project page' })).toBeTruthy();
  });
});

describe('suggestions for a list of names (AFS-99)', () => {
  const names = ['change-board', 'andre', 'olga'];
  it('start with what is typed: a whole last name gets the others after it, a part is completed', () => {
    expect(listSuggestions('', names)).toEqual(names);
    expect(listSuggestions('olga', names)).toEqual(['olga, change-board', 'olga, andre']);
    expect(listSuggestions('olga, and', names)).toEqual(['olga, andre']);
    expect(listSuggestions('olga, ', names)).toEqual(['olga, change-board', 'olga, andre']);
    expect(listSuggestions('["olga"]', names)).toEqual([]);
  });
  it('a name is added to the list, or taken out of it', () => {
    expect(toggleName('', 'web')).toBe('web');
    expect(toggleName('db,  web', 'web')).toBe('db');
    expect(toggleName('db', 'web')).toBe('db, web');
  });
});
