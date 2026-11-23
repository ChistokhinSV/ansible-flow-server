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
    expect(within(yours).getByRole('link', { name: 'Firewall upgrade #7' })).toBeTruthy();
    const others = screen
      .getByRole('heading', { name: 'Waiting for others' })
      .closest('section') as HTMLElement;
    // AFS-193: why not as a sentence, and who does decide it.
    expect(
      within(others).getByText(
        'Only change-board may decide this approval. change-board decides it.',
      ),
    ).toBeTruthy();
    // And how long it has waited.
    expect(within(yours).getByText(/Waiting since.*\(\d+ h( \d+ min)?\)/)).toBeTruthy();
    expect(within(others).queryByRole('button', { name: 'Approve…' })).toBeNull();

    fireEvent.change(within(yours).getByLabelText('Comment'), {
      target: { value: 'Window confirmed' },
    });
    // AFS-133: Approve… asks once more, naming what happens next.
    fireEvent.click(within(yours).getByRole('button', { name: 'Approve…' }));
    expect(within(yours).getByText(/The hosts waiting here go on/)).toBeTruthy();
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
    expect(screen.getByRole('link', { name: /^Approvals/ }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('AFS-211: with nothing waiting, one sentence says so', async () => {
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /approvals': () => ({ body: [] }),
    };
    window.history.replaceState(null, '', '/approvals');
    render(<App />);
    expect(await screen.findByText('No run waits for a decision.')).toBeTruthy();
    expect(screen.queryByText('Nothing waits for you.')).toBeNull();
  });

  it("an approval without a message shows its step's intent (AFS-193)", async () => {
    const one = waiting('r1', true);
    const { message: _, ...rest } = one.gate as ReturnType<typeof gate> & { message?: string };
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /approvals': () => ({
        body: [{ ...one, gate: { ...rest, intent: 'The engineer on duty confirms the window.' } }],
      }),
    };
    window.history.replaceState(null, '', '/approvals');
    render(<App />);
    expect(await screen.findByText('The engineer on duty confirms the window.')).toBeTruthy();
  });

  it('rejecting needs a reason and asks once more; then it is said and counted (AFS-133)', async () => {
    let list = [waiting('r1', true)];
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /approvals': () => ({ body: list }),
      'POST /runs/r1/approvals/N1': (body) => {
        list = [];
        return { body: gate({ status: (body as { decision: string }).decision }) };
      },
    };
    window.history.replaceState(null, '', '/approvals');
    render(<App />);
    const yours = (await screen.findByRole('heading', { name: 'Yours to decide' })).closest(
      'section',
    ) as HTMLElement;
    fireEvent.click(within(yours).getByRole('button', { name: 'Reject…' }));
    expect(within(yours).getByRole('alert').textContent).toMatch(/Say why you reject it/);
    fireEvent.change(within(yours).getByLabelText('Comment'), {
      target: { value: 'No change ticket' },
    });
    fireEvent.click(within(yours).getByRole('button', { name: 'Reject…' }));
    expect(within(yours).getByText(/take the rejected path/)).toBeTruthy();
    expect(asked.some((x) => x.key.startsWith('POST'))).toBe(false);
    fireEvent.click(within(yours).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/You rejected .Approve the change/),
    );
    expect(asked.find((x) => x.key === 'POST /runs/r1/approvals/N1')?.body).toEqual({
      decision: 'rejected',
      comment: 'No change ticket',
    });
  });

  it('the card names who decides, the inputs and people by name; the confirmation keeps the comment and names where the hosts go (AFS-146)', async () => {
    const list = [
      {
        ...waiting('r1', true),
        requestedByName: 'Dana Ruiz',
        run: {
          ...waiting('r1', true).run,
          projectName: 'Edge',
          workspaceName: 'Network',
          mode: 'real',
          inputs: { target_version: '7.4.2', password: '***' },
        },
        gate: gate({
          deciders: ['Change Board', 'Omar Haddad'],
          next: { approved: 'Upgrade', rejected: 'Not approved' },
        }),
      },
    ];
    let counted = 0;
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /approvals': () => {
        counted += 1;
        return { body: list };
      },
    };
    window.history.replaceState(null, '', '/approvals');
    render(<App />);
    const yours = (await screen.findByRole('heading', { name: 'Yours to decide' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(yours).getByText('Dana Ruiz')).toBeTruthy();
    expect(within(yours).getByText(/Who decides: Change Board or Omar Haddad/)).toBeTruthy();
    expect(within(yours).getByText(/Inputs:/).textContent).toMatch(/target_version = 7\.4\.2/);
    expect(within(yours).getByText(/real run/)).toBeTruthy();
    // The badge reads again once the page has its list: both say the same.
    await waitFor(() => expect(counted).toBeGreaterThanOrEqual(3));

    fireEvent.change(within(yours).getByLabelText('Comment'), {
      target: { value: 'No NOC slot' },
    });
    fireEvent.click(within(yours).getByRole('button', { name: 'Reject…' }));
    expect(within(yours).getByText(/go to "Not approved", not on to the change/)).toBeTruthy();
    expect(within(yours).getByText('No NOC slot')).toBeTruthy();
    expect(within(yours).getByRole('button', { name: 'Keep waiting' }).className).toBe('neutral');
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
              decidedByName: 'Omar Haddad',
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
    // AFS-146: people by name.
    expect(within(section).getByText('Omar Haddad')).toBeTruthy();
    expect(within(section).queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
