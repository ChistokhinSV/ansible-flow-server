// Approvals on the pages, with the server played by the test: the inbox (yours to decide and
// waiting for others, with why), deciding with a comment, and a run's approvals on its page.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const omar = { id: 'u2', login: 'omar', name: 'Omar Haddad', admin: false, groups: [] };
const gate = (extra: object = {}) => ({
  id: 'g1',
  run: 'r1',
  node: { id: 'N1', key: 'change-approval', title: 'Approve the change' },
  segment: 'start',
  status: 'waiting',
  deadline: '2026-11-13T14:00:00.000Z',
  approvers: ['change-board'],
  notify: [],
  message: 'Check the change ticket first',
  createdAt: '2026-11-13T10:00:00.000Z',
  ...extra,
});
const waiting = (id: string, mayDecide: boolean, why?: string) => ({
  run: {
    id,
    number: 7,
    project: 'p1',
    flow: { file: 'flows/upgrade.flow.yaml', name: 'Firewall upgrade' },
  },
  requestedBy: 'dana',
  gate: gate({ id: `g-${id}`, run: id }),
  mayDecide,
  ...(why ? { why } : {}),
});

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

describe('approvals', () => {
  it('the inbox: yours to decide with a comment, and others with why not', async () => {
    let list = [
      waiting('r1', true),
      waiting('r2', false, 'Only change-board may decide this approval'),
    ];
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /approvals': () => ({ body: list }),
      'POST /runs/r1/approvals/N1': (body) => {
        list = list.slice(1);
        return { body: gate({ status: (body as { decision: string }).decision }) };
      },
    };
    window.history.replaceState(null, '', '/approvals');
    render(<App />);
    const yours = (await screen.findByRole('heading', { name: 'Yours to decide' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(yours).getByText('Check the change ticket first')).toBeTruthy();
    expect(within(yours).getByRole('link', { name: 'Firewall upgrade · run 7' })).toBeTruthy();
    const others = screen
      .getByRole('heading', { name: 'Waiting for others' })
      .closest('section') as HTMLElement;
    expect(within(others).getByText('Only change-board may decide this approval')).toBeTruthy();
    expect(within(others).queryByRole('button', { name: 'Approve' })).toBeNull();

    fireEvent.change(within(yours).getByLabelText('Comment'), {
      target: { value: 'Window confirmed' },
    });
    fireEvent.click(within(yours).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(asked.find((a) => a.key === 'POST /runs/r1/approvals/N1')?.body).toEqual({
        decision: 'approved',
        comment: 'Window confirmed',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Yours to decide' })).toBeNull(),
    );
    expect(screen.getByRole('link', { name: 'Approvals' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it("a run's page shows its approvals: decided ones with who and why", async () => {
    const run = {
      id: 'r1',
      number: 7,
      project: 'p1',
      commit: '9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b',
      flow: {
        file: 'flows/upgrade.flow.yaml',
        key: 'upgrade',
        name: 'Firewall upgrade',
        version: 1,
      },
      mode: 'real',
      inputs: {},
      targets: [],
      credentials: [],
      state: 'succeeded',
      requestedBy: { id: 'u1', login: 'dana' },
      createdAt: '2026-11-13T10:00:00.000Z',
      attempts: 2,
      cancelRequested: false,
    };
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /runs/r1': () => ({ body: run }),
      'GET /runs/r1/approvals': () => ({
        body: [
          {
            ...gate({
              status: 'rejected',
              decidedBy: 'omar',
              decidedAt: '2026-11-13T10:20:00.000Z',
              comment: 'Not during the freeze',
            }),
            mayDecide: false,
          },
        ],
      }),
    };
    window.history.replaceState(null, '', '/runs/r1');
    render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Approvals' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(section).getByText('rejected', { selector: '.badge' })).toBeTruthy();
    expect(within(section).getByText('Not during the freeze')).toBeTruthy();
    expect(within(section).queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
