// The run pages with the server played by the test: the list, and one run following its
// stream (record, output, end), with Stop and Run again.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect((await screen.findByRole('link', { name: '#7' })).getAttribute('href')).toBe('/runs/r1');
    expect(screen.getByText('running', { selector: '.badge' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Runs' }).getAttribute('aria-current')).toBe('page');
    fireEvent.change(screen.getByLabelText(/State/), { target: { value: 'failed' } });
    await waitFor(() => expect(screen.queryByRole('link', { name: '#7' })).toBeNull());
    expect(screen.getByRole('link', { name: '#6' })).toBeTruthy();
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

  it('says so when there is no such run', async () => {
    routes = { 'GET /session': () => ({ body: omar }) };
    window.history.replaceState(null, '', '/runs/nothing');
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Nothing at GET \/runs\/nothing/,
    );
  });
});
