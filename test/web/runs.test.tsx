// The run pages with the server played by the test: the list, and one run following its
// stream (record, output, end), with Stop and Run again.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run } from '../../src/web/api';
import { App } from '../../src/web/app';
import { againWords, stoppedWhen } from '../../src/web/runs';
import { formatTime } from '../../src/web/ui';
import { stepTitle, stopQuestion } from '../../src/web/viewerRuns';

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
    await screen.findByText(/^No run for these choices\./);
    expect(window.location.search).toBe('?state=failed&mine=1');
    // AFS-144: a way back from choices that leave nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Show all runs' }));
    await screen.findByRole('link', { name: /#2/ });
    expect(window.location.search).toBe('');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mine' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: /#2/ })).toBeNull());

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
    await screen.findByRole('heading', { name: 'Hello, Ansible #7' });
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
    // Ansible's colours stay: the codes become styled text, not shown as they are.
    const esc = String.fromCharCode(27);
    stream.emit('output', { text: `${esc}[0;32mok: [fw-edge-01]${esc}[0m\n`, next: 30 });
    await waitFor(() =>
      expect(document.querySelector('pre')?.textContent).toBe('PLAY [hello]\nok: [fw-edge-01]\n'),
    );
    expect(document.querySelector('pre .ansi-fg-2')?.textContent).toBe('ok: [fw-edge-01]');
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
    // AFS-185: Stop of a real run asks first, naming the run; no is no.
    const stopAsked: string[] = [];
    let stop = false;
    const stopConfirm = vi.spyOn(window, 'confirm').mockImplementation((text) => {
      stopAsked.push(String(text));
      return stop;
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(stopAsked).toHaveLength(1));
    expect(stopAsked[0]).toMatch(
      /^Stop real run #\d+ of Hello, Ansible\? The step in progress is cut off/,
    );
    expect(screen.queryByText(/asked to stop/)).toBeNull();
    stop = true;
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await screen.findByText(/asked to stop/);
    stopConfirm.mockRestore();
    expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(true);

    cleanup();
    state = 'cancelled';
    window.history.replaceState(null, '', '/runs/r1');
    render(<App />);
    // AFS-147: a real run again is asked about first, with the inputs it reuses; no is no.
    const asked: string[] = [];
    let answer = false;
    const confirm = vi.spyOn(window, 'confirm').mockImplementation((text) => {
      asked.push(String(text));
      return answer;
    });
    const again = await screen.findByRole('button', { name: 'Run again' });
    expect(again.getAttribute('title')).toMatch(/^A real run again, at the same commit\./);
    fireEvent.click(again);
    expect(asked[0]).toMatch(
      /^Run Hello, Ansible for real again\? It changes the hosts it reaches\./,
    );
    expect(window.location.pathname).toBe('/runs/r1');
    answer = true;
    fireEvent.click(again);
    confirm.mockRestore();
    await screen.findByRole('heading', { name: 'Hello, Ansible #8' });
    expect(window.location.pathname).toBe('/runs/r2');
    expect(screen.getByText('The canvas shows the run once it started.')).toBeTruthy();
  });

  it('Run again asks first, naming its action, when the run reached no host (AFS-191)', () => {
    const base = {
      flow: { name: 'Hello' },
      inputs: { devices: ['ghost-01'] },
      error: 'No host ran: none of the targets (ghost-01) is in the inventory',
    } as unknown as Run;
    expect(againWords({ ...base, mode: 'check' } as Run)).toMatchObject({
      confirm:
        'Run Hello again as a check run? No host ran: none of the targets (ghost-01) is in the inventory. It would likely end the same way.',
      yes: 'Run again anyway',
    });
    expect(againWords({ ...base, mode: 'real' } as Run)).toMatchObject({
      confirm: expect.stringMatching(/^Run Hello for real again\? .* It would likely end/),
      yes: 'Run for real',
    });
    expect(againWords({ ...base, mode: 'check', error: undefined } as Run).confirm).toBeUndefined();
  });

  it('What ran names the inputs, limit, credentials, environment and skipped targets (AFS-147)', async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /runs/r1': () => ({
        body: {
          ...run,
          state: 'succeeded',
          endedAt: '2026-11-13T12:03:02.000Z',
          inputs: { target_version: '7.6.0', api_token: '***' },
          limit: 'fw-edge-*',
          inventory: 'inventory/hosts.yaml',
          eeImage: 'afs-ee/net-tools:0a1b2c3d4e5f6a7b',
          credentials: ['k1', 'k2'],
          credentialNames: ['netops-key', 'vault'],
          environment: { id: 'e1', name: 'net-tools', workspace: 'w1' },
          skippedTargets: ['nosuchhost'],
        },
      }),
      ...places,
    };
    window.history.replaceState(null, '', '/runs/r1');
    render(<App />);
    const facts = (await screen.findByRole('heading', { name: 'What ran' })).closest(
      'section',
    ) as HTMLElement;
    const inputs = facts.querySelector('[data-run-inputs]') as HTMLElement;
    expect(inputs.textContent).toContain('target_version7.6.0');
    expect(inputs.textContent).toContain('api_token***');
    expect(facts.textContent).toContain('fw-edge-*');
    expect(facts.textContent).toContain('netops-key, vault');
    expect(
      (await within(facts).findByRole('link', { name: 'net-tools' })).getAttribute('href'),
    ).toBe('/w/netops/environments/e1');
    expect(facts.textContent).toContain("counted over the project's runs");
    // Went well, and still not plainly: the target the inventory lacks is named.
    expect(document.querySelector('[data-skipped-targets]')?.textContent).toBe(
      'Not in the inventory inventory/hosts.yaml, so nothing ran there: nosuchhost',
    );
    expect(screen.getByText(/1 target not in the inventory/)).toBeTruthy();
  });

  it("AFS-163: What ran says the image came from the server's default", async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /runs/r1': () => ({
        body: {
          ...run,
          state: 'succeeded',
          endedAt: '2026-11-13T12:03:02.000Z',
          eeImage: 'afs-ee/net-team:0a1b2c3d4e5f6a7b',
          environment: { id: 'e1', name: 'team', workspace: 'w1' },
          serverDefault: true,
        },
      }),
      ...places,
    };
    window.history.replaceState(null, '', '/runs/r1');
    render(<App />);
    const facts = (await screen.findByRole('heading', { name: 'What ran' })).closest(
      'section',
    ) as HTMLElement;
    expect(facts.textContent).toContain("afs-ee/net-team:0a1b2c3d4e5f6a7b (the server's default)");
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
    expect(screen.getByText(/after 3 min/)).toBeTruthy();
    expect(screen.getByText(/1 with a problem/)).toBeTruthy();

    // AFS-170: a host's row opens what it did, step by step.
    routes['GET /runs/r1/hosts/fw-edge-17'] = () => ({
      body: {
        steps: [
          {
            node: 'n1',
            step: 'Pre-checks',
            entries: [
              {
                task: 'Gather facts',
                status: 'unreachable',
                msg: 'Connection timed out (port 22)',
              },
            ],
          },
        ],
      },
    });
    const row = within(hosts).getByRole('button', { name: /fw-edge-17/ });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(row);
    const did = await within(hosts).findByRole('region', { name: 'What fw-edge-17 did' });
    expect(within(did).getByRole('heading', { name: 'Pre-checks' })).toBeTruthy();
    expect(within(did).getByText('Connection timed out (port 22)')).toBeTruthy();
    expect(row.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(row);
    expect(within(hosts).queryByRole('region', { name: 'What fw-edge-17 did' })).toBeNull();
  });

  it('a run its approval rejected reads as rejected; a held run has its hosts waiting (AFS-146)', async () => {
    const view = (outcome: Record<string, string>) => ({
      body: {
        id: 'r1',
        mode: 'real',
        state: 'running',
        startedAt: run.startedAt,
        summary: {
          nodes: {},
          outcome,
          failures: [],
          unreachable: [],
          hosts: ['localhost'],
          stoppedEarly: false,
        },
      },
    });
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /runs/r1': () => ({
        body: {
          ...run,
          state: 'failed',
          decidedAgainst: 'rejected',
          error: 'Rejected at Change approval by Sam Reyes: no NOC slot',
          endedAt: '2026-11-13T12:03:02.000Z',
        },
      }),
      'GET /runs/r1/view': () =>
        view({ localhost: 'Ended at [not-approved] Not approved (outcome: failed)' }),
    };
    window.history.replaceState(null, '', '/runs/r1');
    render(<App />);
    const hosts = (await screen.findByRole('heading', { name: 'Hosts' })).closest(
      'section',
    ) as HTMLElement;
    expect(hosts.querySelector('li')?.textContent).toBe(
      'localhostEnded at Not approved (rejected)',
    );
    expect(screen.getByText('rejected', { selector: '.badge' })).toBeTruthy();
    expect(screen.getByText(/1 not approved/)).toBeTruthy();
    cleanup();

    routes['GET /runs/r1'] = () => ({ body: { ...run, state: 'waiting' } });
    routes['GET /runs/r1/view'] = () => view({});
    render(<App />);
    const held = (await screen.findByRole('heading', { name: 'Hosts' })).closest(
      'section',
    ) as HTMLElement;
    expect(held.querySelector('li')?.textContent).toBe('localhostwaiting for a decision');
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
    // AFS-144: the workspace by its name, once it is read.
    await within(crumbs).findByRole('link', { name: 'Network operations' });
    expect(
      within(crumbs)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['Workspaces', '/workspaces'],
      ['Network operations', '/w/netops'],
      // AFS-146: the project by its name too.
      ['Edge firewalls', '/w/netops/edge'],
      ['Nightly check', '/w/netops/edge/launch/c1'],
    ]);
    expect(crumbs.textContent).toMatch(/#7$/);
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
    const terminal = screen.getByRole('heading', { name: 'Terminal output' }).closest('section');
    expect(document.activeElement).toBe(terminal);
    expect(terminal?.className).toMatch(/run-output-shown/);
    // Show Terminal on this page's canvas asks the page to go to its output, without loading it
    // again.
    (document.activeElement as HTMLElement).blur();
    await waitFor(() => expect(terminal?.className).not.toMatch(/run-output-shown/), {
      timeout: 3000,
    });
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'afs-show-output', run: 'r1' },
        origin: window.location.origin,
      }),
    );
    await waitFor(() => expect(terminal?.className).toMatch(/run-output-shown/));
    expect(document.activeElement).toBe(terminal);
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
    await within(crumbs).findByRole('link', { name: 'Edge firewalls' });
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
    // AFS-152: the not-found page of every item, with a way back.
    await screen.findByRole('heading', { name: 'Not found' });
    expect(document.querySelector('main')?.textContent).toContain(
      'The run nothing is not here, or is not shared with you.',
    );
    expect(screen.getByRole('link', { name: 'Back to Runs' })).toBeTruthy();
  });
});

// AFS-185: what Stop asks of a real run, and when a stopped run says it stopped.
describe('stop words', () => {
  it('names the run and what stopping it does where it is', () => {
    expect(stopQuestion({ number: 4, flowName: 'Firewalls', state: 'waiting' })).toBe(
      'Stop real run #4 of Firewalls? It waits for approval: nobody decides it after this, and its hosts go no further.',
    );
    expect(stopQuestion({ number: 4, state: 'running', step: 'Push baseline' })).toBe(
      'Stop real run #4? Push baseline is cut off, and its hosts go no further.',
    );
  });

  it('a stopped run says when, after who stopped it', () => {
    const at = '2026-11-21T08:47:56Z';
    const when = formatTime(at, 'en-GB');
    expect(stoppedWhen('Stopped by Dana Whitfield during Push baseline', at, 'en-GB')).toBe(
      `Stopped by Dana Whitfield at ${when} during Push baseline`,
    );
    expect(stoppedWhen('Stopped by Dana Whitfield', at, 'en-GB')).toBe(
      `Stopped by Dana Whitfield at ${when}`,
    );
    expect(stoppedWhen('Stopped on request', at, 'en-GB')).toBe(`Stopped on request at ${when}`);
    expect(stoppedWhen('Failed', at)).toBe('Failed');
  });

  it("a step's title at any level of the flow", () => {
    const doc = {
      nodes: [
        {
          id: 'a',
          title: 'Pre-checks',
          subflow: { nodes: [{ id: 'b', title: 'Check the path' }] },
        },
      ],
    };
    expect(stepTitle(doc, 'b')).toBe('Check the path');
    expect(stepTitle(doc, 'c')).toBeUndefined();
  });
});
