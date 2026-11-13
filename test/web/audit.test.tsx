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
  it('administration leads to it', async () => {
    routes = { 'GET /session': () => ({ body: dana }) };
    window.history.replaceState(null, '', '/admin');
    render(<App />);
    const link = await screen.findByRole('link', { name: /Audit log/ });
    expect(link.getAttribute('href')).toBe('/admin/audit');
    expect(screen.getByRole('link', { name: 'Administration' }).getAttribute('aria-current')).toBe(
      'page',
    );
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
    expect(screen.getByText('mallory?')).toBeTruthy();
    expect(screen.getByText('refused 401')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Older entries' }));
    await screen.findByText('on the server (root)');
    expect(screen.queryByRole('button', { name: 'Older entries' })).toBeNull();

    fireEvent.change(screen.getByLabelText(/Result/), { target: { value: 'refused' } });
    await waitFor(() => expect(asked).toContain('GET /audit?result=refused&limit=100'));
    expect(screen.getByRole('link', { name: 'Export CSV' }).getAttribute('href')).toBe(
      '/api/v1/audit/export?result=refused&format=csv',
    );
  });

  it('is not there for someone who is not an administrator', async () => {
    routes = { 'GET /session': () => ({ body: omar }) };
    window.history.replaceState(null, '', '/admin/audit');
    render(<App />);
    await screen.findByRole('heading', { name: 'Nothing here' });
    expect(asked.some((a) => a.includes('/audit'))).toBe(false);
  });
});
