// A flow's page (AFS-85) with the server played by the test: over the canvas, one line that leads
// to the flow's launch configurations and its newest runs; who has rw and no configuration yet is
// offered to add one for this flow.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowPage } from '../../src/web/flow';

const COMMIT = '9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b';
const FILE = 'flows/upgrade.flow.yaml';
const project = {
  id: 'p1',
  workspace: 'w1',
  key: 'core',
  name: 'Core',
  hosted: true,
  gitPath: '/git/net/core.git',
  gitRef: 'main',
  commit: COMMIT,
  sync: { state: 'ok' },
};
const flow = { file: FILE, key: 'upgrade', name: 'Firewall upgrade', version: 3 };
const config = (id: string, name: string, flowFile = FILE) => ({
  id,
  project: 'p1',
  name,
  flowFile,
  mode: 'check',
  inputs: {},
  credentials: [],
});
const run = (n: number, state: string) => ({
  id: `r${n}`,
  number: n,
  project: 'p1',
  commit: COMMIT,
  flow,
  mode: 'check',
  inputs: {},
  targets: [],
  credentials: [],
  state,
  requestedBy: { id: 'u1', login: 'dana' },
  createdAt: '2026-11-13T12:00:00.000Z',
  attempts: 1,
  cancelRequested: false,
});

let asked: string[];
let routes: Record<string, () => { status?: number; body?: unknown }>;
beforeEach(() => {
  asked = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
    asked.push(key);
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

const RUNS = 'GET /runs?project=p1&flow=flows%2Fupgrade.flow.yaml&limit=3';
const common = (level: string) => ({
  'GET /workspaces/net/projects': () => ({ body: [project] }),
  'GET /projects/p1/flows': () => ({ body: { flows: [flow] } }),
  'GET /projects/p1/drafts': () => ({ body: [] }),
  'GET /projects/p1/access': () => ({
    body: { admin: false, workspace: level, approve: false, flows: {} },
  }),
});
const show = () =>
  render(
    <FlowPage me={{ login: 'dana' }} workspace="net" project="core" file={FILE} theme="dark" />,
  );
const line = () => document.querySelector('.flow-line') as HTMLElement;

describe("a flow's page", () => {
  it('leads to the launch configurations of this flow and to its newest runs', async () => {
    routes = {
      ...common('ro'),
      'GET /projects/p1/launch-configs': () => ({
        body: [
          config('c1', 'Nightly check'),
          config('c2', 'Other flow', 'flows/other.flow.yaml'),
          config('c3', 'Weekly real'),
        ],
      }),
      [RUNS]: () => ({ body: [run(12, 'running'), run(11, 'failed'), run(10, 'succeeded')] }),
    };
    show();
    const first = await screen.findByRole('link', { name: 'Launch: Nightly check' });
    expect(first.getAttribute('href')).toBe('/w/net/core/launch/c1');
    expect(screen.getByRole('link', { name: 'Launch: Weekly real' }).getAttribute('href')).toBe(
      '/w/net/core/launch/c3',
    );
    expect(screen.queryByRole('link', { name: /Other flow/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add a launch configuration' })).toBeNull();
    await screen.findByRole('link', { name: '#12 running' });
    expect(
      within(line())
        .getAllByRole('link')
        .filter((a) => a.getAttribute('href')?.startsWith('/runs/'))
        .map((a) => [a.getAttribute('href'), a.textContent]),
    ).toEqual([
      ['/runs/r12', '#12 running'],
      ['/runs/r11', '#11 failed'],
      ['/runs/r10', '#10 went well'],
    ]);
    expect(line().textContent).toContain('main at 9f2c1e7ab3d4');
    // The canvas is there under the line.
    expect(screen.getByTitle(/on the designer's canvas/)).toBeTruthy();
  });

  it('reads its Latest runs again when the canvas launches a run or one ends (AFS-139)', async () => {
    let list = [run(1, 'succeeded')];
    routes = {
      ...common('ro'),
      'GET /projects/p1/launch-configs': () => ({ body: [config('c1', 'Nightly check')] }),
      [RUNS]: () => ({ body: list }),
    };
    show();
    await screen.findByRole('link', { name: '#1 went well' });
    list = [run(2, 'succeeded'), run(1, 'succeeded')];
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'afs-flow-runs' },
        origin: window.location.origin,
      }),
    );
    await screen.findByRole('link', { name: '#2 went well' });
  });

  it('offers who has rw to add a configuration for this flow when there is none', async () => {
    routes = {
      ...common('rw'),
      'GET /projects/p1/launch-configs': () => ({ body: [] }),
      [RUNS]: () => ({ body: [] }),
    };
    show();
    const add = await screen.findByRole('link', { name: 'Add a launch configuration' });
    expect(add.getAttribute('href')).toBe('/w/net/core/launch/new?flow=flows%2Fupgrade.flow.yaml');
    expect(line().textContent).not.toContain('Latest runs');
  });

  it('says there is none to who may not add one', async () => {
    routes = {
      ...common('operator'),
      'GET /projects/p1/launch-configs': () => ({ body: [] }),
      [RUNS]: () => ({ body: [] }),
    };
    show();
    expect(await screen.findByText('No launch configuration')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Add a launch configuration' })).toBeNull();
  });

  it('opens a flow just made for editing, even when its list comes after the access (AFS-160)', async () => {
    window.history.replaceState(null, '', `/w/net/core/flow/${FILE}?edit=1`);
    let listed: (() => void) | undefined;
    const late = new Promise<void>((done) => {
      listed = done;
    });
    routes = {
      ...common('rw'),
      'GET /projects/p1/flows': () => ({ body: { flows: [{ ...flow, ok: true, steps: 0 }] } }),
      'GET /projects/p1/access': () => ({
        body: { admin: false, workspace: 'rw', approve: false, flows: { [FILE]: 'rw' } },
      }),
      'GET /projects/p1/launch-configs': () => ({ body: [] }),
      [RUNS]: () => ({ body: [] }),
      'POST /projects/p1/drafts?path=flows%2Fupgrade.flow.yaml': () => ({
        status: 201,
        body: { id: 'd1', project: 'p1', file: FILE, baseCommit: COMMIT, editors: [] },
      }),
    };
    const answer = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      // The flow list answers last: the access is known before the page knows the flow is there.
      if (url.endsWith('/projects/p1/flows')) await late;
      return answer(url, init);
    });
    show();
    await vi.waitFor(() => expect(asked).toContain('GET /projects/p1/access'));
    await new Promise((r) => setTimeout(r, 20));
    listed?.();
    await vi.waitFor(() =>
      expect(asked).toContain('POST /projects/p1/drafts?path=flows%2Fupgrade.flow.yaml'),
    );
    expect(window.location.search).toBe('');
  });

  it('offers Edit first on a flow with no steps yet to who may edit (AFS-160)', async () => {
    window.history.replaceState(null, '', `/w/net/core/flow/${FILE}`);
    routes = {
      ...common('rw'),
      'GET /projects/p1/flows': () => ({ body: { flows: [{ ...flow, ok: true, steps: 0 }] } }),
      'GET /projects/p1/access': () => ({
        body: { admin: false, workspace: 'rw', approve: false, flows: { [FILE]: 'rw' } },
      }),
      'GET /projects/p1/launch-configs': () => ({ body: [] }),
      [RUNS]: () => ({ body: [] }),
    };
    show();
    const edit = await screen.findByRole('button', { name: 'Edit' });
    expect(edit.className).toContain('primary');
  });
});
