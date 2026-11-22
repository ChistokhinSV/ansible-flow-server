// The audit log page with the server played by the test: entries, a filter, older entries, the
// export links; and that only administrators have it.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const dana = { id: 'u1', login: 'dana', name: 'Dana Whitfield', admin: true, groups: [] };
const omar = { id: 'u2', login: 'omar', name: 'Omar Haddad', admin: false, groups: [] };
const entry = (n: number, extra: object = {}) => ({
  id: `e${n}`,
  at: `2026-11-13T12:${String(59 - n).padStart(2, '0')}:00.000Z`,
  actor: { id: 'u1', login: 'dana' },
  source: 'ui',
  action: 'workspace.change',
  object: { type: 'workspace', id: 'w1', name: 'net' },
  result: 'ok',
  status: 200,
  ip: '192.0.2.10',
  detail: { changed: ['description'] },
  ...extra,
});

let asked: string[];
let routes: Record<string, () => { status?: number; body?: unknown }>;
beforeEach(() => {
  asked = [];
  window.localStorage.clear();
  window.scrollTo = () => undefined;
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

describe('the audit log', () => {
  it('names who by their name, with the login at hand (AFS-195)', async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /audit?limit=100': () => ({
        body: { entries: [entry(1)], people: { u1: 'Dana Whitfield' } },
      }),
    };
    window.history.replaceState(null, '', '/admin/audit');
    render(<App />);
    const who = await screen.findByText('Dana Whitfield', { selector: 'td span' });
    expect(who.getAttribute('title')).toBe('dana');
  });

  it('administration leads to it', async () => {
    routes = { 'GET /session': () => ({ body: dana }) };
    window.history.replaceState(null, '', '/admin');
    render(<App />);
    const link = await screen.findByRole('link', { name: /Audit log/ });
    expect(link.getAttribute('href')).toBe('/admin/audit');
    // AFS-87: the administration's own address opens People and groups.
    expect(
      screen.getByRole('link', { name: 'People and groups' }).getAttribute('aria-current'),
    ).toBe('page');
  });

  it('shows entries, filters them, brings older ones, and exports with the filter', async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /audit?limit=100': () => ({
        body: {
          entries: [
            entry(1),
            entry(2, {
              actor: null,
              source: 'api',
              action: 'session.sign-in',
              object: { type: 'session' },
              result: 'refused',
              status: 401,
              detail: { login: 'mallory', error: 'invalid_credentials' },
            }),
          ],
          next: 'cursor-2',
        },
      }),
      'GET /audit?before=cursor-2&limit=100': () => ({
        body: {
          entries: [
            entry(3, {
              actor: null,
              source: 'cli',
              action: 'user.create',
              object: { type: 'user', name: 'lena' },
              detail: { command: 'user add lena', osUser: 'root' },
            }),
          ],
        },
      }),
      'GET /audit?result=refused&limit=100': () => ({ body: { entries: [entry(2)] } }),
    };
    window.history.replaceState(null, '', '/admin/audit');
    render(<App />);
    await screen.findByText('workspace.change');
    // AFS-153: the login typed for a refused sign-in, said as such, on one line.
    expect(screen.getByText('mallory').className).toBe('login');
    expect(screen.getByText('login typed, not signed in')).toBeTruthy();
    expect(screen.getByText('refused 401')).toBeTruthy();
    // AFS-195: refused in the warning colour, not the colour of ok.
    expect(screen.getByText('refused 401').className).toBe('badge warn');

    fireEvent.click(screen.getByRole('button', { name: 'Older entries' }));
    await screen.findByText('on the server (root)');
    expect(screen.queryByRole('button', { name: 'Older entries' })).toBeNull();

    fireEvent.change(screen.getByLabelText(/Result/), { target: { value: 'refused' } });
    await waitFor(() => expect(asked).toContain('GET /audit?result=refused&limit=100'));
    expect(screen.getByRole('link', { name: 'Export CSV' }).getAttribute('href')).toBe(
      '/api/v1/audit/export?result=refused&format=csv',
    );
  });

  it('keeps the filter in the address, and reads it from there (AFS-153)', async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /audit?actor=a1&action=user&limit=100': () => ({ body: { entries: [entry(1)] } }),
      'GET /audit?actor=a1&action=user&result=refused&limit=100': () => ({
        body: { entries: [] },
      }),
    };
    window.history.replaceState(null, '', '/admin/audit?who=a1&about=user&bogus=1');
    render(<App />);
    await screen.findByText('workspace.change');
    expect(asked).toContain('GET /audit?actor=a1&action=user&limit=100');
    expect((screen.getByLabelText(/Who/) as HTMLInputElement).value).toBe('a1');
    fireEvent.change(screen.getByLabelText(/Result/), { target: { value: 'refused' } });
    await waitFor(() => expect(window.location.search).toBe('?who=a1&about=user&result=refused'));
    await screen.findByText('Nothing in the log matches.');
  });

  it('names what an entry is about, linked while it exists; a push as its branches (AFS-106)', async () => {
    const LC = '544c2527-bcf1-4ff2-bf17-3bd9943b1711';
    const PROJECT = '3b67bf9f-27c5-4e89-8e03-6ef9c5028c0b';
    const GONE = 'af88a302-47c3-4ea8-acb6-ecef4c88aa0b';
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /audit?limit=100': () => ({
        body: {
          entries: [
            entry(1, {
              action: 'launch-config.create',
              object: { type: 'launch-config', id: LC, name: 'Back up edge' },
              detail: { project: PROJECT },
            }),
            entry(2, {
              source: 'git',
              action: 'git.push',
              object: { type: 'project', id: PROJECT, name: 'net/edge' },
              detail: {
                refs: [{ ref: 'refs/heads/main', from: '37e668ed0011', to: '71595cb50022' }],
              },
            }),
            entry(3, {
              action: 'run.launch',
              object: { type: 'run' },
              detail: { 'launch-config': GONE, error: 'not_ready' },
            }),
          ],
          refs: {
            [LC]: { type: 'launch-config', name: 'Back up edge', path: `/w/net/edge/launch/${LC}` },
            [PROJECT]: { type: 'project', name: 'net/edge', path: '/w/net/edge' },
          },
        },
      }),
    };
    window.history.replaceState(null, '', '/admin/audit');
    render(<App />);
    await screen.findByText('launch-config.create');
    expect(screen.getByRole('link', { name: 'Back up edge' }).getAttribute('href')).toBe(
      `/w/net/edge/launch/${LC}`,
    );
    // The project in the detail and as what was pushed to: its name, linked; not its id.
    expect(
      screen
        .getAllByRole('link', { name: 'net/edge' })
        .every((a) => a.getAttribute('href') === '/w/net/edge'),
    ).toBe(true);
    expect(screen.queryByText(PROJECT)).toBeNull();
    expect(screen.getByText('main: 37e668ed → 71595cb5')).toBeTruthy();
    // A launch configuration deleted since: its id, short, said to be deleted.
    expect(screen.getByText('af88a302… (deleted)')).toBeTruthy();
    // All of an entry's detail, on demand.
    expect(screen.getAllByText('All of it').length).toBe(3);
  });

  it("names a relaunch's new run by its number, and says real or check (AFS-170)", async () => {
    const NEW = '7d1f0c2e-5b6a-4c3d-9e8f-0a1b2c3d4e5f';
    const GONE = '0f1e2d3c-4b5a-4968-8776-655443322110';
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /audit?limit=100': () => ({
        body: {
          entries: [
            entry(1, {
              action: 'run.relaunch',
              object: { type: 'run', id: 'r1', name: 'Back up edge #3' },
              detail: { run: NEW, number: 4, mode: 'real' },
            }),
            entry(2, {
              action: 'run.relaunch',
              object: { type: 'run', id: 'r0', name: 'Back up edge #1' },
              detail: { run: GONE, number: 2, mode: 'check' },
            }),
          ],
          refs: { [NEW]: { type: 'run', name: 'Back up edge #4', path: `/runs/${NEW}` } },
        },
      }),
    };
    window.history.replaceState(null, '', '/admin/audit');
    render(<App />);
    await screen.findAllByText('run.relaunch');
    expect(screen.getByRole('link', { name: 'Back up edge #4' }).getAttribute('href')).toBe(
      `/runs/${NEW}`,
    );
    // A run removed since: by its number, not its id.
    expect(screen.getByText('#2')).toBeTruthy();
    expect(screen.queryByText(/0f1e2d3c…/)).toBeNull();
    // The number is said with the run, not again.
    expect(screen.queryByText('number:')).toBeNull();
    expect(screen.getByText('real')).toBeTruthy();
    expect(screen.getByText('check')).toBeTruthy();
  });

  it('names the token an action was done with, beside its source (AFS-145)', async () => {
    const TOKEN = 'e428a134-1111-4222-8333-944455556666';
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /audit?limit=100': () => ({
        body: {
          entries: [
            entry(1, {
              source: 'api',
              token: TOKEN,
              action: 'project.create',
              result: 'refused',
              status: 403,
              detail: { workspace: 'w1', error: 'read_only_token', token: 'a1-readonly' },
            }),
            // Written before tokens were named in the log: its id, short.
            entry(2, { source: 'api', token: TOKEN, action: 'group.create', detail: {} }),
          ],
          refs: {},
        },
      }),
    };
    window.history.replaceState(null, '', '/admin/audit');
    render(<App />);
    await screen.findByText('project.create');
    expect(screen.getByText('token a1-readonly')).toBeTruthy();
    expect(screen.getByText('token e428a134…')).toBeTruthy();
    // Said once: not again among the detail.
    expect(screen.queryByText('token:')).toBeNull();
  });

  it('is not there for someone who is not an administrator', async () => {
    routes = { 'GET /session': () => ({ body: omar }) };
    window.history.replaceState(null, '', '/admin/audit');
    render(<App />);
    await screen.findByRole('heading', { name: 'For administrators' });
    expect(asked.some((a) => a.includes('/audit'))).toBe(false);
  });
});
