// AFS-214, AFS-213: a failed run's page: how its hosts went in one line, and Run again ▾: only
// the hosts that did not go well, Debug this failure (check by default, real asked first).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  type FlowEdge,
  type FlowStep,
  hostSets,
  outcomeLine,
  type ViewOfHosts,
} from '../../src/server/runs/hostSets';
import type { HostSets, RelaunchOffer, Run } from '../../src/web/api';
import { App } from '../../src/web/app';
import { fillFrom } from '../../src/web/launch';
import {
  debugBody,
  debuggable,
  debugPoints,
  namedSets,
  onlyQuestion,
  relaunchWords,
  steppedWords,
} from '../../src/web/runAgain';

const dana = { id: 'u1', login: 'dana', name: 'Dana Whitfield', admin: true, groups: [] };
const APPLY = '01JZAPPLY0000000000000000A';
const run = {
  id: 'r1',
  number: 41,
  project: 'p1',
  config: { id: 'c1', name: 'Edge change' },
  commit: '3f9c2a1d0b4e5f60718293a4b5c6d7e8f9012345',
  ref: 'main',
  flow: { file: 'flows/edge.flow.yaml', key: 'edge', name: 'Edge change', version: 3 },
  mode: 'real',
  inputs: {},
  targets: ['edge'],
  credentials: [],
  state: 'failed',
  requestedBy: { id: 'u1', login: 'dana' },
  createdAt: '2026-11-23T10:00:00.000Z',
  startedAt: '2026-11-23T10:00:02.000Z',
  endedAt: '2026-11-23T10:04:00.000Z',
  attempts: 1,
  cancelRequested: false,
  error: '3 of 40 hosts failed at Apply config',
};
const sets: HostSets = {
  total: 40,
  failed: [
    { host: 'edge-02.lab.example', node: APPLY, title: 'Apply config' },
    { host: 'edge-07.lab.example', node: APPLY, title: 'Apply config' },
  ],
  unreachable: [{ host: 'lb-02.lab.example', node: APPLY, title: 'Apply config' }],
  stopped: [],
  handled: [],
  notOk: ['edge-02.lab.example', 'edge-07.lab.example', 'lb-02.lab.example'],
};
const offer: RelaunchOffer = {
  sets,
  line: '3 of 40 hosts did not go well: 2 failed at Apply config, 1 unreachable',
  risks: [
    'Collect report runs on localhost: the host limit skips it unless localhost is one of the hosts',
  ],
  approvals: ['Change board'],
};

class FakeStream {
  addEventListener() {}
  close() {}
}

let routes: Record<string, () => { status?: number; body?: unknown }>;
let posted: unknown[];
beforeEach(() => {
  posted = [];
  window.scrollTo = () => undefined;
  vi.stubGlobal('EventSource', FakeStream);
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
    if (key === 'POST /runs/r1/relaunch')
      posted.push(init.body === undefined ? undefined : JSON.parse(String(init.body)));
    const answer = routes[key]?.() ?? {
      status: 404,
      body: { error: 'not_found', message: `Nothing at ${key}` },
    };
    const status = answer.status ?? 200;
    return { ok: status < 300, status, json: async () => answer.body } as Response;
  });
  routes = {
    'GET /session': () => ({ body: dana }),
    'GET /runs/r1': () => ({ body: run }),
    'GET /runs/r1/relaunch': () => ({ body: offer }),
    'POST /runs/r1/relaunch': () => ({
      status: 201,
      body: { ...run, id: 'r2', number: 42, state: 'queued', startedAt: undefined },
    }),
    'GET /runs/r2': () => ({
      body: {
        ...run,
        id: 'r2',
        number: 42,
        state: 'queued',
        startedAt: undefined,
        relaunchOf: { id: 'r1', number: 41, hosts: 'not-ok', count: 3 },
      },
    }),
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const openMenu = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Run again ▾' }));
  return screen.getByRole('menu');
};

describe('Run again ▾', () => {
  it('says how the hosts went, and runs only the ones that did not go well, asked first', async () => {
    const asked: string[] = [];
    vi.spyOn(window, 'confirm').mockImplementation((text) => {
      asked.push(String(text));
      return true;
    });
    window.history.replaceState(null, '', '/runs/r1');
    render(<App />);
    expect((await screen.findByText(offer.line as string)).closest('[data-outcome]')).toBeTruthy();
    const menu = await openMenu();
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((b) => b.querySelector('span')?.textContent),
    ).toEqual(['Run again', 'Only the 3 hosts that did not go well', 'Debug this failure…']);
    // AFS-251: each item says what it takes; Only names the hosts with their sets.
    expect(menu.querySelector('[data-not-ok-hosts]')?.textContent).toBe(
      'edge-02.lab.example (failed), edge-07.lab.example (failed), lb-02.lab.example (unreachable)',
    );
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Only the 3 hosts/ }));
    await waitFor(() => expect(posted).toEqual([{ hosts: 'not-ok' }]));
    expect(asked[0]).toMatch(
      /^Run #41 again for real on 3 hosts: edge-02\.lab\.example, edge-07\.lab\.example, lb-02\.lab\.example \(commit 3f9c2a1d0b4e, .*\)\? It changes the hosts it reaches\. Approvals are asked again\. Collect report runs on localhost/,
    );
    // The new run says what it is again of.
    expect(
      (
        await screen.findByText('Run again of #41 on the 3 hosts that did not go well')
      ).getAttribute('href'),
    ).toBe('/runs/r1');
  });

  it('AFS-212: opens by itself when Home sends a Run again here, with its choices', async () => {
    window.history.replaceState(null, '', '/runs/r1?again=1');
    render(<App />);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem')[0]?.querySelector('span')?.textContent).toBe(
      'Run again',
    );
    // From the keyboard too: the first choice has the focus.
    expect(document.activeElement).toBe(within(menu).getAllByRole('menuitem')[0]);
    expect(posted).toEqual([]);
  });

  it('Debug this failure: a check run by default; real is asked first and names the hosts', async () => {
    const asked: string[] = [];
    let yes = false;
    vi.spyOn(window, 'confirm').mockImplementation((text) => {
      asked.push(String(text));
      return yes;
    });
    window.history.replaceState(null, '', '/runs/r1');
    render(<App />);
    // The menu offers Debug this failure once the run's offer is read.
    await screen.findByText(offer.line as string);
    fireEvent.click(
      within(await openMenu()).getByRole('menuitem', { name: 'Debug this failure…' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Debug this failure' });
    expect(dialog.textContent).toContain(
      'Pauses before Apply config, where they went wrong, and when a host fails.',
    );
    expect(dialog.textContent).toContain('commit 3f9c2a1d0b4e');
    expect(
      (within(dialog).getByRole('radio', { name: /^Check mode/ }) as HTMLInputElement).checked,
    ).toBe(true);
    // Real: the approvals are asked again, and Start asks first; no is no.
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Real run/ }));
    expect(dialog.textContent).toContain('A real run waits again at Change board');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start debugging' }));
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toMatch(/^Debug run #41 for real on edge-02\.lab\.example, edge-07/);
    expect(posted).toEqual([]);
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Check mode/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start debugging' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      hosts: 'not-ok',
      mode: 'check',
      commit: 'same',
      step: { every: false, points: [APPLY], debug: true, pauseOnFailure: true },
    });
    yes = true;
  });

  it('AFS-253: offers only what the person may do, and says who may when nothing is left', async () => {
    routes['GET /runs/r1/relaunch'] = () => ({
      body: { ...offer, may: { again: false, change: true, debug: true, why: 'x' } },
    });
    window.history.replaceState(null, '', '/runs/r1');
    const first = render(<App />);
    await screen.findByText(offer.line as string);
    const menu = await openMenu();
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((b) => b.querySelector('span')?.textContent),
    ).toEqual(['Run again', 'Debug this failure…']);
    // AFS-257: Run again stays, greyed, with who may run it again under it.
    const refused = within(menu).getAllByRole('menuitem')[0] as HTMLElement;
    expect(refused.getAttribute('aria-disabled')).toBe('true');
    expect(refused.textContent).toContain('x');
    fireEvent.click(refused);
    expect(posted).toEqual([]);
    first.unmount();
    const why =
      'Run #41 ran another branch or commit than its launch configuration names: people who may change this flow run it again';
    routes['GET /runs/r1/relaunch'] = () => ({
      body: { ...offer, may: { again: false, change: false, debug: false, why } },
    });
    render(<App />);
    expect((await screen.findByText(why)).hasAttribute('data-run-again-who')).toBe(true);
    expect(screen.queryByRole('button', { name: /^Run again/ })).toBeNull();
  });

  it('words: the debug body, the question, what a run is again of', () => {
    expect(
      debugBody({ ...sets, failed: [], unreachable: [], stopped: [{ host: 'a' }] }, true),
    ).toEqual({
      hosts: 'not-ok',
      mode: 'real',
      commit: 'same',
      step: { every: true, debug: true, pauseOnFailure: true },
    });
    expect(onlyQuestion({ ...run, mode: 'check' } as Run, { ...offer, risks: [] })).toBe(
      'Run #41 again as a check run on 3 hosts: edge-02.lab.example, edge-07.lab.example, lb-02.lab.example (commit 3f9c2a1d0b4e, the same inputs, the credentials of its configuration)? Approvals are asked again.',
    );
    // AFS-251: a step-by-step run again says so, as Launch does.
    const stepped = { ...run, mode: 'check', step: { every: true, points: [], timeoutS: 3600 } };
    expect(onlyQuestion(stepped as Run, { ...offer, risks: [] })).toContain(
      'It runs step by step, as run #41 did: it pauses before each step until someone says Step, Continue or Stop. Approvals are asked again.',
    );
    expect(
      steppedWords({
        number: 41,
        step: { every: false, points: [APPLY], timeoutS: 60, debug: true },
      }),
    ).toBe(
      ' It is a debug run, as run #41 was: it pauses at its pause points and when a host fails.',
    );
    expect(steppedWords({ number: 41 })).toBe('');
    expect(relaunchWords({ id: 'r1', number: 41, hosts: 'all' })).toBe('Run again of #41');
    expect(relaunchWords({ id: 'r1', number: 41, hosts: 'unreachable', count: 1 })).toBe(
      'Run again of #41 on the 1 host that could not be reached',
    );
    expect(relaunchWords({ id: 'r1', number: 41, hosts: 'chosen', count: 2 })).toBe(
      'Run again of #41 on 2 hosts',
    );
  });
});

describe('Change and run', () => {
  const form = {
    mode: 'check' as const,
    commit: 'a'.repeat(40),
    limit: 'edge',
    fields: [
      {
        name: 'devices',
        type: 'host_list' as const,
        required: true,
        secret: false,
        text: 'edge-01',
      },
      { name: 'vlan', type: 'integer' as const, required: false, secret: false, text: '10' },
      { name: 'api_password', type: 'string' as const, required: false, secret: true, text: '' },
    ],
  };
  it('fills the form from the run and names what differs from the configuration', () => {
    const from = {
      number: 41,
      mode: 'real' as const,
      commit: 'b'.repeat(40),
      inputs: { devices: ['edge-02', 'edge-07'], vlan: 10, api_password: '***' },
    };
    expect(fillFrom(from, form, true)).toEqual({
      texts: { devices: 'edge-02, edge-07' },
      mode: 'real',
      limit: '',
      commit: 'b'.repeat(40),
      line: 'Filled in from run #41: unlike the configuration, a real run; no limit; commit bbbbbbbbbbbb; the input devices. Secret inputs are not filled in (api_password): type them again.',
    });
    // AFS-251: a step-by-step run fills Step by step; a run again of some hosts says so.
    expect(
      fillFrom(
        {
          ...from,
          mode: 'check',
          limit: 'edge',
          inputs: {},
          commit: 'a'.repeat(40),
          step: { every: true, points: [], timeoutS: 60 },
          hostLimit: { count: 1, hosts: ['edge-02'] },
        },
        form,
        true,
      ),
    ).toEqual({
      texts: {},
      stepped: true,
      line: 'Filled in from run #41: unlike the configuration, step by step. Run #41 ran on only edge-02: this launch runs on every host its limit takes.',
    });
    // Who may not pick a commit runs the configuration's, and is told.
    expect(fillFrom({ ...from, mode: 'check', limit: 'edge', inputs: {} }, form, false)).toEqual({
      texts: {},
      line: 'Filled in from run #41: the same as the configuration. It runs commit aaaaaaaaaaaa; run #41 ran bbbbbbbbbbbb.',
    });
  });
});

// AFS-250: closing the Debug this failure dialog puts the focus back on Run again, not the body.
describe('Debug this failure, closed', () => {
  it('gives the focus back to Run again', async () => {
    window.history.replaceState(null, '', '/runs/r1');
    render(<App />);
    // The menu offers Debug this failure once the run's offer is read.
    await screen.findByText(offer.line as string);
    fireEvent.click(
      within(await openMenu()).getByRole('menuitem', { name: 'Debug this failure…' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Debug this failure' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Run again ▾' }));
  });
});

// AFS-256, AFS-257 (round 2 of the 1.2 exploration): the sets of real runs, as the server reads
// the engine's records (test/fixtures/runs), and Run again of a debug run.
describe('Run again ▾ of real runs', () => {
  const fixtures = join(__dirname, '../fixtures');
  const flow = (file: string) =>
    parse(readFileSync(join(fixtures, file), 'utf8')) as { nodes: FlowStep[]; edges: FlowEdge[] };
  const setsOf = (name: string, file: string) => {
    const kept = JSON.parse(readFileSync(join(fixtures, 'runs', `${name}.json`), 'utf8')) as {
      state: string;
      view: ViewOfHosts;
    };
    const doc = flow(file);
    return hostSets(kept.view, doc.nodes, kept.state === 'cancelled', doc.edges);
  };

  it('Stop at a failure pause: Debug this failure pauses before the step that failed, on named hosts only', () => {
    const stopped = setsOf('stop-at-failure', 'edge-baseline.flow.yaml');
    expect(debugBody(stopped, false)).toEqual({
      hosts: 'not-ok',
      mode: 'check',
      commit: 'same',
      step: {
        every: false,
        points: ['01JEDGN0000000000000000002'],
        debug: true,
        pauseOnFailure: true,
      },
    });
    expect(namedSets(stopped)).toBe(
      'sw-edge-01 (stopped), sw-edge-02 (failed), sw-edge-03 (stopped), sw-edge-04 (stopped)',
    );
    // Retry, Step, Stop: before Validate and before Rollback, where each host was going.
    expect(debugPoints(setsOf('retry-step-stop', 'edge-baseline.flow.yaml')).titles).toEqual([
      'Validate',
      'Rollback',
    ]);
  });

  it('a rejected run: its host was not approved, and there is no Debug this failure', async () => {
    const rejected = setsOf('rejected', 'gate-baseline.flow.yaml');
    expect(namedSets(rejected)).toBe('localhost (not approved)');
    expect(debuggable(rejected)).toEqual([]);
    routes['GET /runs/r1/relaunch'] = () => ({
      body: { ...offer, sets: rejected, line: outcomeLine(rejected) },
    });
    window.history.replaceState(null, '', '/runs/r1');
    render(<App />);
    await screen.findByText('The host did not go well: 1 not approved at Change approval');
    expect(
      within(await openMenu())
        .getAllByRole('menuitem')
        .map((b) => b.querySelector('span')?.textContent),
    ).toEqual(['Run again', 'Only the host that did not go well']);
  });

  it('a stopped run lists its hosts and where they stopped, also before its first step', async () => {
    const first = setsOf('stop-before-first', 'edge-baseline.flow.yaml');
    routes['GET /runs/r1'] = () => ({
      body: { ...run, state: 'cancelled', error: 'Stopped by Mia before Push baseline' },
    });
    routes['GET /runs/r1/relaunch'] = () => ({
      body: { ...offer, sets: first, line: outcomeLine(first) },
    });
    routes['GET /runs/r1/view'] = () => ({
      body: JSON.parse(readFileSync(join(fixtures, 'runs', 'stop-before-first.json'), 'utf8')).view,
    });
    window.history.replaceState(null, '', '/runs/r1');
    render(<App />);
    const hosts = await screen.findByRole('region', { name: 'Hosts' });
    await waitFor(() =>
      expect(hosts.textContent).toContain('sw-edge-04stopped before Push baseline'),
    );
  });

  it('AFS-257: Run again of a debug run says it is one, and asks first', async () => {
    const asked: string[] = [];
    vi.spyOn(window, 'confirm').mockImplementation((text) => {
      asked.push(String(text));
      return true;
    });
    routes['GET /runs/r1'] = () => ({
      body: {
        ...run,
        mode: 'check',
        step: { every: true, points: [], timeoutS: 600, debug: true },
      },
    });
    window.history.replaceState(null, '', '/runs/r1');
    render(<App />);
    await screen.findByText(offer.line as string);
    const menu = await openMenu();
    expect(menu.querySelector('[data-again-note]')?.textContent).toBe(
      'All its hosts, the same commit and inputs: a debug run, as #41 was',
    );
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Run again' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(asked[0]).toContain(
      'It is a debug run, as run #41 was: it pauses before each step and when a host fails.',
    );
  });
});
