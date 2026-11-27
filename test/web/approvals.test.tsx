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
  it('AFS-274: names each one’s workspace, decided ones too, and narrows to one in the address', async () => {
    const inWs = (id: string, mayDecide: boolean, key: string, name: string) => {
      const w = waiting(id, mayDecide);
      return {
        ...w,
        run: { ...w.run, projectName: 'Edge', workspaceName: name, workspace: { key, name } },
      };
    };
    const all = [inWs('r1', true, 'net', 'Network team'), inWs('r2', true, 'lab', 'Lab')];
    const decided = {
      ...inWs('r3', false, 'lab', 'Lab'),
      gate: gate({ id: 'g-r3', run: 'r3', status: 'approved', decidedBy: 'omar' }),
    };
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /workspaces': () => ({
        body: [
          { id: 'w1', key: 'net', name: 'Network team', projects: 1 },
          { id: 'w2', key: 'lab', name: 'Lab', projects: 1 },
        ],
      }),
      'GET /approvals': () => ({ body: all }),
      'GET /approvals?workspace=lab': () => ({ body: all.slice(1) }),
      'GET /approvals?decided=1': () => ({ body: [decided] }),
      'GET /approvals?decided=1&workspace=lab': () => ({ body: [decided] }),
    };
    window.history.replaceState(null, '', '/approvals');
    render(<App />);
    const yours = (await screen.findByRole('heading', { name: 'Yours to decide' })).closest(
      'section',
    ) as HTMLElement;
    expect(yours.textContent).toContain('Network team / Edge');
    expect(yours.textContent).toContain('Lab / Edge');
    const history = (await screen.findByRole('heading', { name: 'Decided lately' })).closest(
      'section',
    ) as HTMLElement;
    expect(history.textContent).toContain('Approve the change · Lab');
    fireEvent.change(screen.getByRole('combobox', { name: 'Workspace' }), {
      target: { value: 'lab' },
    });
    expect(window.location.pathname + window.location.search).toBe('/approvals?workspace=lab');
    await waitFor(() => expect(yours.textContent).not.toContain('Network team'));
    expect(asked.map((a) => a.key)).toEqual(
      expect.arrayContaining([
        'GET /approvals?workspace=lab',
        'GET /approvals?decided=1&workspace=lab',
      ]),
    );
    // The menu's count is of every workspace: it never asks for one.
    const menu = screen.getByRole('navigation', { name: 'Work' });
    expect(within(menu).getByRole('link', { name: /^Approvals/ }).textContent).toBe('Approvals2');
  });

  it('AFS-274: a workspace no longer seen (a bookmark) is let go, not said as an error', async () => {
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /workspaces': () => ({ body: [] }),
      'GET /approvals': () => ({ body: [waiting('r1', true)] }),
      'GET /approvals?decided=1': () => ({ body: [] }),
      'GET /approvals?workspace=gone': () => ({
        status: 404,
        body: { error: 'not_found', message: 'There is no workspace gone' },
      }),
      'GET /approvals?decided=1&workspace=gone': () => ({
        status: 404,
        body: { error: 'not_found', message: 'There is no workspace gone' },
      }),
    };
    window.history.replaceState(null, '', '/approvals?workspace=gone');
    render(<App />);
    await screen.findByRole('heading', { name: 'Yours to decide' });
    expect(window.location.pathname + window.location.search).toBe('/approvals');
    expect(document.body.textContent).not.toContain('There is no workspace gone');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('AFS-274: the filter offers the approvals’ own workspaces, also to who sees none in /workspaces', async () => {
    const inWs = (id: string, key: string, name: string) => {
      const w = waiting(id, true);
      return { ...w, run: { ...w.run, projectName: 'Edge', workspace: { key, name } } };
    };
    const all = [inWs('r1', 'net', 'Network team'), inWs('r2', 'lab', 'Lab')];
    routes = {
      'GET /session': () => ({ body: omar }),
      // An approver with no grant on either workspace: `/workspaces` lists neither.
      'GET /workspaces': () => ({ body: [] }),
      'GET /approvals': () => ({ body: all }),
      'GET /approvals?workspace=lab': () => ({ body: all.slice(1) }),
      'GET /approvals?decided=1': () => ({ body: [] }),
      'GET /approvals?decided=1&workspace=lab': () => ({ body: [] }),
    };
    window.history.replaceState(null, '', '/approvals');
    render(<App />);
    const filter = await screen.findByRole('combobox', { name: 'Workspace' });
    const offered = () =>
      within(filter)
        .getAllByRole('option')
        .map((o) => o.textContent);
    expect(offered()).toEqual(['All workspaces', 'Lab', 'Network team']);
    fireEvent.change(filter, { target: { value: 'lab' } });
    const yours = (await screen.findByRole('heading', { name: 'Yours to decide' })).closest(
      'section',
    ) as HTMLElement;
    await waitFor(() => expect(yours.textContent).not.toContain('Network team'));
    // Narrowed to Lab, the other is still a choice.
    expect(offered()).toEqual(['All workspaces', 'Lab', 'Network team']);
  });

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
    // AFS-193: why not, without repeating Who decides from the line above.
    expect(within(others).getByText('Only change-board may decide this approval.')).toBeTruthy();
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

  it('AFS-271: the card says what each answer lets happen, and what to weigh', async () => {
    const one = {
      ...waiting('r1', true),
      gate: gate({
        next: { approved: 'Upgrade', rejected: 'Not approved' },
        after: ['Upgrade', 'Post-checks', 'Done'],
        evidence: {
          checkRun: {
            id: 'r0',
            number: 6,
            state: 'succeeded',
            endedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            sameCommit: true,
          },
        },
      }),
    };
    const old = {
      ...waiting('r2', false, 'Only change-board may decide this approval'),
      // A gate opened before the steps were kept: the next step alone; no check run yet.
      gate: gate({ id: 'g-r2', run: 'r2', next: { approved: 'Upgrade' }, evidence: {} }),
    };
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /approvals': () => ({ body: [one, old] }),
    };
    window.history.replaceState(null, '', '/approvals');
    render(<App />);
    const yours = (await screen.findByRole('heading', { name: 'Yours to decide' })).closest(
      'section',
    ) as HTMLElement;
    const list = within(yours).getByText('If approved').closest('dl') as HTMLElement;
    expect(within(list).getByText('The hosts go on: Upgrade › Post-checks › Done')).toBeTruthy();
    expect(within(list).getByText('The hosts go to "Not approved"')).toBeTruthy();
    // No timeout port: a gate that times out takes the rejected one.
    expect(within(list).getByText(/it times out and the hosts go to "Not approved"/)).toBeTruthy();
    const evidence = within(list).getByRole('link', { name: 'Check run #6' });
    expect(evidence.getAttribute('href')).toBe('/runs/r0');
    expect(evidence.parentElement?.textContent).toMatch(
      /^Check run #6 went well, 5 min ago \(same commit\)$/,
    );
    // Said before anyone decides, also to who may not decide it.
    const others = screen
      .getByRole('heading', { name: 'Waiting for others' })
      .closest('section') as HTMLElement;
    expect(within(others).getByText('The hosts go on: Upgrade')).toBeTruthy();
    expect(within(others).getByText('No prior check run')).toBeTruthy();
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
