// The run pages with the server played by the test: the list, and one run following its
// stream (record, output, end), with Stop and Run again.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const dana = { id: 'u1', login: 'dana', name: 'Dana Whitfield', admin: true, groups: [] };
const omar = { id: 'u2', login: 'omar', name: 'Omar Haddad', admin: false, groups: [] };
const run = {
  id: 'r1',
  number: 7,
  project: 'p1',
  config: { id: 'c1', name: 'Nightly check' },
  commit: '9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b',
  ref: 'main',
  flow: { file: 'flows/hello.flow.yaml', key: 'hello', name: 'Hello, Ansible', version: 3 },
  mode: 'real',
  inputs: {},
  targets: ['fw-edge-01'],
  credentials: [],
  state: 'running',
  requestedBy: { id: 'u1', login: 'dana' },
  createdAt: '2026-11-13T12:00:00.000Z',
  startedAt: '2026-11-13T12:00:02.000Z',
  attempts: 1,
  cancelRequested: false,
};

/** Where the run belongs: a workspace and its project, as the pages look them up. */
const places = {
  'GET /workspaces': () => ({
    body: [{ id: 'w1', key: 'netops', name: 'Network operations', projects: 1 }],
  }),
  'GET /workspaces/netops/projects': () => ({
    body: [{ id: 'p1', workspace: 'w1', key: 'edge', name: 'Edge firewalls' }],
  }),
};

/** A stand-in for the browser's EventSource: the test says what the server sends. */
class FakeStream {
  static last: FakeStream | undefined;
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeStream.last = this;
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
}

let routes: Record<string, () => { status?: number; body?: unknown }>;
beforeEach(() => {
  FakeStream.last = undefined;
  window.localStorage.clear();
  window.scrollTo = () => undefined;
  vi.stubGlobal('EventSource', FakeStream);
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

describe('the runs list', () => {
  it('lists runs with their state, and filters by state', async () => {
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /runs?limit=100': () => ({
        body: [run, { ...run, id: 'r0', number: 6, state: 'failed' }],
      }),
      'GET /runs?state=failed&limit=100': () => ({
        body: [{ ...run, id: 'r0', number: 6, state: 'failed' }],
      }),
    };
    window.history.replaceState(null, '', '/runs');
    render(<App />);
    expect((await screen.findByRole('link', { name: /#7/ })).getAttribute('href')).toBe('/runs/r1');
    expect(screen.getByRole('link', { name: /#7/ }).textContent).toContain('running');
    expect(screen.getByRole('link', { name: 'Runs' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('radio', { name: 'Failed' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: /#7/ })).toBeNull());
    expect(screen.getByRole('link', { name: /#6/ }).textContent).toContain('failed');
    // The choice is in the address, so a reload shows the same list.
    expect(window.location.search).toBe('?state=failed');
  });

  it('filters by project on the server, and keeps the choice in the address (AFS-86)', async () => {
    const asked: string[] = [];
    const other = { ...run, id: 'r9', number: 2, project: 'p2' };
    routes = {
      'GET /session': () => ({ body: omar }),
      ...places,
      'GET /runs?limit=100': () => ({ body: [run, other] }),
      'GET /runs?project=p1&limit=100': () => {
        asked.push('p1');
        return { body: [run] };
      },
    };
    window.history.replaceState(null, '', '/runs');
    render(<App />);
    await screen.findByRole('link', { name: /#2/ });
    const choice = (await screen.findByRole('option', { name: 'Edge firewalls' })).closest(
      'select',
    ) as HTMLSelectElement;
    expect(screen.getByLabelText('Project')).toBe(choice);
    expect(screen.getByRole('group', { name: 'Network operations' })).toBeTruthy();
    fireEvent.change(choice, { target: { value: 'p1' } });
    await waitFor(() => expect(screen.queryByRole('link', { name: /#2/ })).toBeNull());
    expect(screen.getByRole('link', { name: /#7/ })).toBeTruthy();
    expect(asked).toEqual(['p1']);
    expect(window.location.pathname + window.location.search).toBe('/runs?project=p1');

    // Opened again at that address, the list is filtered from the start.
    cleanup();
    render(<App />);
    await screen.findByRole('link', { name: /#7/ });
    expect(asked).toEqual(['p1', 'p1']);
    await waitFor(() =>
      expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('p1'),
    );
  });

  it('loads older runs after the last one shown (AFS-86)', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({
      ...run,
      id: `n${i}`,
      number: 200 - i,
      state: 'succeeded',
      createdAt: new Date(Date.parse('2026-11-13T12:00:00.000Z') - i * 60_000).toISOString(),
    }));
    // Where the page ended: its last run's time, number and id, so that runs made in the same
    // moment are not skipped.
    const last = `${page[99]?.createdAt},${page[99]?.number},${page[99]?.id}`;
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /runs?limit=100': () => ({ body: page }),
      [`GET /runs?limit=100&before=${encodeURIComponent(last)}`]: () => ({
        body: [
          {
            ...run,
            id: 'old',
            number: 100,
            state: 'succeeded',
            createdAt: '2026-11-13T09:00:00.000Z',
          },
        ],
      }),
    };
    window.history.replaceState(null, '', '/runs');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Older runs' }));
    await screen.findByRole('link', { name: /#100/ });
    expect(screen.getByRole('link', { name: /#200/ })).toBeTruthy();
    // A short page was the last one.
    expect(screen.queryByRole('button', { name: 'Older runs' })).toBeNull();
    expect(screen.getByText('No older runs.')).toBeTruthy();
  });

  it('Mine asks the server for the runs of the person signed in, and stays in the address', async () => {
    const theirs = { ...run, id: 'r9', number: 2 };
    const mine = { ...run, id: 'r5', number: 5, requestedBy: { id: 'u2', login: 'omar' } };
    routes = {
      'GET /session': () => ({ body: omar }),
      ...places,
      'GET /runs?limit=100': () => ({ body: [theirs, mine] }),
      'GET /runs?by=omar&limit=100': () => ({ body: [mine] }),
      'GET /runs?state=failed&by=omar&limit=100': () => ({ body: [] }),
    };
    window.history.replaceState(null, '', '/runs');
    render(<App />);
    await screen.findByRole('link', { name: /#2/ });
    const choice = screen.getByRole('checkbox', { name: 'Mine' }) as HTMLInputElement;
    expect(choice.checked).toBe(false);
    fireEvent.click(choice);
    await waitFor(() => expect(screen.queryByRole('link', { name: /#2/ })).toBeNull());
    expect(screen.getByRole('link', { name: /#5/ })).toBeTruthy();
    expect(window.location.pathname + window.location.search).toBe('/runs?mine=1');
    // With a state beside it, both are asked for.
    fireEvent.click(screen.getByLabelText('Failed'));
    await screen.findByText('No run for these choices.');
    expect(window.location.search).toBe('?state=failed&mine=1');

    // Opened again at that address, the choice is made from the start.
    cleanup();
    window.history.replaceState(null, '', '/runs?mine=1');
    render(<App />);
    await screen.findByRole('link', { name: /#5/ });
    expect(screen.queryByRole('link', { name: /#2/ })).toBeNull();
    expect((screen.getByRole('checkbox', { name: 'Mine' }) as HTMLInputElement).checked).toBe(true);
  });

  it("a project's launch configurations narrow its runs to one", async () => {
    const other = { ...run, id: 'r9', number: 2, config: { id: 'c2', name: 'Weekly real' } };
    const configs = [
      { id: 'c1', name: 'Nightly check' },
      { id: 'c2', name: 'Weekly real' },
    ];
    routes = {
      'GET /session': () => ({ body: omar }),
      ...places,
      'GET /runs?limit=100': () => ({ body: [run, other] }),
      'GET /runs?project=p1&limit=100': () => ({ body: [run, other] }),
      'GET /runs?project=p1&config=c2&limit=100': () => ({ body: [other] }),
      'GET /projects/p1/launch-configs': () => ({ body: configs }),
    };
    window.history.replaceState(null, '', '/runs');
    render(<App />);
    await screen.findByRole('link', { name: /#7/ });
    // Configurations are a project's: no project chosen, no choice of one.
    expect(screen.queryByLabelText('Launch configuration')).toBeNull();
    await screen.findByRole('option', { name: 'Edge firewalls' });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p1' } });
    const choice = (await screen.findByLabelText('Launch configuration')) as HTMLSelectElement;
    await within(choice).findByRole('option', { name: 'Weekly real' });
    expect(within(choice).getAllByRole('option')).toHaveLength(3);
    fireEvent.change(choice, { target: { value: 'c2' } });
    await waitFor(() => expect(screen.queryByRole('link', { name: /#7/ })).toBeNull());
    expect(screen.getByRole('link', { name: /#2/ })).toBeTruthy();
    expect(window.location.search).toBe('?project=p1&config=c2');

    // Opened again at that address, both choices are made from the start.
    cleanup();
    render(<App />);
    await screen.findByRole('link', { name: /#2/ });
    expect(screen.queryByRole('link', { name: /#7/ })).toBeNull();
    await waitFor(() =>
      expect((screen.getByLabelText('Launch configuration') as HTMLSelectElement).value).toBe('c2'),
    );
    // Another project has other configurations: the choice goes with the project.
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '' } });
    await screen.findByRole('link', { name: /#7/ });
    expect(screen.queryByLabelText('Launch configuration')).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('a configuration in the address that the project does not have is not a choice', async () => {
    routes = {
      'GET /session': () => ({ body: omar }),
      ...places,
      'GET /runs?project=p1&config=gone&limit=100': () => ({ body: [] }),
      'GET /runs?project=p1&limit=100': () => ({ body: [run] }),
      'GET /projects/p1/launch-configs': () => ({ body: [{ id: 'c1', name: 'Nightly check' }] }),
    };
    window.history.replaceState(null, '', '/runs?project=p1&config=gone');
    render(<App />);
    await screen.findByRole('link', { name: /#7/ });
    expect(window.location.search).toBe('?project=p1');
  });
});

describe('a run', () => {
  it('follows the run: output as it comes, the state when it changes, the canvas once it started', async () => {
    routes = { 'GET /session': () => ({ body: omar }), 'GET /runs/r1': () => ({ body: run }) };
    window.history.replaceState(null, '', '/runs/r1');
    render(<App />);
    await screen.findByRole('heading', { name: 'Hello, Ansible · run 7' });
    const stream = FakeStream.last as FakeStream;
    expect(stream.url).toBe('/api/v1/runs/r1/events');
    // Someone who is not an administrator sees no Stop.
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    const frame = screen.getByTitle('Run 7 on the canvas') as HTMLIFrameElement;
    expect(Object.fromEntries(new URL(frame.src).searchParams)).toMatchObject({
      project: 'p1',
      path: 'flows/hello.flow.yaml',
      commit: run.commit,
      run: 'r1',
    });

    stream.emit('output', { text: 'PLAY [hello]\n', next: 13 });
    stream.emit('output', { text: 'ok: [fw-edge-01]\n', next: 30 });
    await waitFor(() =>
      expect(document.querySelector('pre')?.textContent).toBe('PLAY [hello]\nok: [fw-edge-01]\n'),
    );
    stream.emit('run', {
      ...run,
      state: 'failed',
      endedAt: '2026-11-13T12:01:00.000Z',
      error: 'ansible-playbook ended with 2; 1 host(s) failed',
    });
    stream.emit('end', { state: 'failed' });
    await screen.findByText('ansible-playbook ended with 2; 1 host(s) failed');
    expect(screen.getByText('failed', { selector: '.badge' })).toBeTruthy();
    expect(stream.closed).toBe(true);
  });

  it('an administrator stops a run, and runs an ended one again', async () => {
    let state = 'running';
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /runs/r1': () => ({ body: { ...run, state } }),
      'POST /runs/r1/cancel': () => ({
        status: 202,
        body: { ...run, cancelRequested: true, cancelledBy: 'dana' },
      }),
      'POST /runs/r1/relaunch': () => ({
        status: 201,
        body: { ...run, id: 'r2', number: 8, state: 'queued', startedAt: undefined },
      }),
      'GET /runs/r2': () => ({
        body: { ...run, id: 'r2', number: 8, state: 'queued', startedAt: undefined },
      }),
    };
    window.history.replaceState(null, '', '/runs/r1');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await screen.findByText(/asked to stop/);
    expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(true);

    cleanup();
    state = 'cancelled';
    window.history.replaceState(null, '', '/runs/r1');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run again' }));
    await screen.findByRole('heading', { name: 'Hello, Ansible · run 8' });
    expect(window.location.pathname).toBe('/runs/r2');
    expect(screen.getByText('The canvas shows the run once it started.')).toBeTruthy();
  });

  it('lists its hosts, those with a problem first, and says why one failed (AFS-64)', async () => {
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /runs/r1': () => ({
        body: { ...run, state: 'failed', endedAt: '2026-11-13T12:03:02.000Z' },
      }),
      'GET /runs/r1/view': () => ({
        body: {
          id: 'r1',
          mode: 'real',
          state: 'done',
          startedAt: run.startedAt,
          summary: {
            nodes: {},
            outcome: {},
            failures: [],
            unreachable: ['fw-edge-17'],
            hosts: ['fw-edge-01', 'fw-edge-17'],
            stoppedEarly: false,
            problems: {
              n1: {
                'fw-edge-17': {
                  task: 'Gather facts',
                  status: 'unreachable',
                  msg: 'ssh: connect to host port 22: Connection timed out',
                },
              },
            },
          },
        },
      }),
    };
    window.history.replaceState(null, '', '/runs/r1');
    render(<App />);
    const hosts = (await screen.findByRole('heading', { name: 'Hosts' })).closest(
      'section',
    ) as HTMLElement;
    const rows = () => [...hosts.querySelectorAll('li')].map((li) => li.textContent);
    // AFS-86: only the hosts with a problem, until all are asked for.
    expect(rows()).toEqual(['fw-edge-17not reachable']);
    expect(within(hosts).getByText('The one with a problem.')).toBeTruthy();
    fireEvent.click(within(hosts).getByRole('button', { name: 'All 2' }));
    expect(rows()).toEqual(['fw-edge-17not reachable', 'fw-edge-01went well']);
    fireEvent.click(within(hosts).getByRole('button', { name: 'Only with a problem' }));
    expect(rows()).toEqual(['fw-edge-17not reachable']);
    await screen.findByRole('heading', { name: 'Why fw-edge-17 was not reached' });
    expect(screen.getByText(/Connection timed out/)).toBeTruthy();
    expect(screen.getByText(/Failed after 3 min/)).toBeTruthy();
    expect(screen.getByText(/1 with a problem/)).toBeTruthy();
  });

  it('leads through where the run belongs: workspace, project, configuration (AFS-86)', async () => {
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /runs/r1': () => ({ body: run }),
      ...places,
      'GET /projects/p1/flows': () => ({
        body: { flows: [{ file: 'flows/hello.flow.yaml', name: 'Hello, Ansible', ok: true }] },
      }),
      'GET /projects/p1/launch-configs': () => ({ body: [{ id: 'c1', name: 'Nightly check' }] }),
    };
    window.history.replaceState(null, '', '/runs/r1');
    render(<App />);
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await within(crumbs).findByRole('link', { name: 'Nightly check' });
    expect(
      within(crumbs)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['Workspaces', '/workspaces'],
      ['netops', '/w/netops'],
      ['edge', '/w/netops/edge'],
      ['Nightly check', '/w/netops/edge/launch/c1'],
    ]);
    expect(crumbs.textContent).toMatch(/run 7$/);
    // What ran: the flow and the configuration are links too.
    const facts = screen.getByRole('heading', { name: 'What ran' }).closest('section');
    const ran = within(facts as HTMLElement);
    expect(ran.getByRole('link', { name: 'Hello, Ansible' }).getAttribute('href')).toBe(
      '/w/netops/edge/flow/flows/hello.flow.yaml',
    );
    expect(ran.getByRole('link', { name: 'Nightly check' }).getAttribute('href')).toBe(
      '/w/netops/edge/launch/c1',
    );
    expect(screen.getByRole('link', { name: 'All runs' }).getAttribute('href')).toBe('/runs');
    // The output is far down: a button at the top goes to it.
    fireEvent.click(screen.getByRole('button', { name: 'To the output' }));
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Output' }).closest('section'),
    );
  });

  it('leaves out what it cannot place: a configuration that is gone, a project out of sight', async () => {
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /runs/r1': () => ({ body: run }),
      ...places,
      'GET /projects/p1/launch-configs': () => ({ body: [] }),
    };
    window.history.replaceState(null, '', '/runs/r1');
    render(<App />);
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await within(crumbs).findByRole('link', { name: 'edge' });
    expect(within(crumbs).queryByRole('link', { name: 'Nightly check' })).toBeNull();
    expect(screen.getByText(/from “Nightly check”/)).toBeTruthy();
    // The flow is not in the project now: its name stays, without a link.
    expect(screen.queryByRole('link', { name: 'Hello, Ansible' })).toBeNull();

    cleanup();
    routes = { 'GET /session': () => ({ body: omar }), 'GET /runs/r1': () => ({ body: run }) };
    render(<App />);
    const plain = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(
      within(plain)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/runs']);
  });

  it('says so when there is no such run', async () => {
    routes = { 'GET /session': () => ({ body: omar }) };
    window.history.replaceState(null, '', '/runs/nothing');
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Nothing at GET \/runs\/nothing/,
    );
  });
});
