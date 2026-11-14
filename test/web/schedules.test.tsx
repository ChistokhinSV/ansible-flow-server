// Schedules on a launch configuration's page (AFS-34), with the server played by the test: a
// schedule with its next times and last fire; adding one (the cron's next times shown as it is
// typed, secret inputs not offered, empty inputs left out), a refusal at its field, pausing; an
// administrator hands one to a service account; an operator only reads them.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const dana = { id: 'u1', login: 'dana', name: 'Dana Whitfield', admin: true, groups: [] };
const omar = { id: 'u2', login: 'omar', name: 'Omar Haddad', admin: false, groups: [] };
const ci = {
  id: 'u3',
  login: 'ci',
  name: 'CI',
  admin: false,
  service: true,
  disabled: false,
  groups: [],
};
const COMMIT = '9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b';
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
const config = {
  id: 'c1',
  project: 'p1',
  name: 'Nightly check',
  flowFile: 'flows/upgrade.flow.yaml',
  mode: 'check',
  inputs: { devices: ['fw-edge-01'] },
  credentials: [],
  createdAt: '2026-11-13T10:00:00.000Z',
  updatedAt: '2026-11-13T10:00:00.000Z',
};
const form = {
  commit: COMMIT,
  ref: 'main',
  flow: { file: 'flows/upgrade.flow.yaml', key: 'upgrade', name: 'Firewall upgrade', version: 3 },
  mode: 'check',
  fields: [
    { name: 'devices', type: 'host_list', required: true, secret: false, text: 'fw-edge-01' },
    { name: 'api_password', type: 'string', required: false, secret: true, text: '' },
    { name: 'retries', type: 'integer', required: false, secret: false, text: '3' },
  ],
};
const weekdays = {
  id: 's1',
  config: 'c1',
  name: 'Weekdays at three',
  kind: 'cron',
  cron: '0 3 * * 1-5',
  timezone: 'Europe/Berlin',
  enabled: true,
  inputs: {},
  missed: 'once',
  overlap: 'skip',
  owner: { id: 'u1', login: 'dana' },
  next: '2026-11-16T02:00:00.000Z',
  upcoming: ['2026-11-16T02:00:00.000Z', '2026-11-17T02:00:00.000Z', '2026-11-18T02:00:00.000Z'],
  last: { at: '2026-11-13T02:00:00.000Z', result: 'skipped', detail: 'Run 41 has not ended' },
  createdBy: 'dana',
  createdAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z',
};

let asked: { key: string; body?: unknown }[];
let routes: Record<string, (body?: unknown) => { status?: number; body?: unknown }>;
beforeEach(() => {
  asked = [];
  window.scrollTo = () => undefined;
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    asked.push({ key, body });
    const answer =
      routes[key]?.(body) ??
      (key.startsWith('GET /schedule-times?')
        ? { body: { times: ['2026-11-16T05:30:00.000Z', '2026-11-17T05:30:00.000Z'] } }
        : { status: 404, body: { error: 'not_found', message: key } });
    const status = answer.status ?? 200;
    return { ok: status < 300, status, json: async () => answer.body } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const sent = (key: string) => asked.filter((a) => a.key === key).map((a) => a.body);
const page = (me: object, schedules: () => unknown[]) => ({
  'GET /session': () => ({ body: me }),
  'GET /workspaces/net/projects': () => ({ body: [project] }),
  'GET /projects/p1/branches': () => ({ body: { branches: ['main'] } }),
  'GET /launch-configs/c1': () => ({ body: config }),
  'GET /launch-configs/c1/form?': () => ({ body: form }),
  'GET /launch-configs/c1/schedules': () => ({ body: schedules() }),
  'GET /users': () => ({ body: [dana, ci] }),
});
const section = async () =>
  (await screen.findByRole('heading', { name: 'Schedules' })).closest('section') as HTMLElement;

describe('schedules of a launch configuration', () => {
  it('shows one, adds one with its next times, refuses at a field, pauses, hands over', async () => {
    let list: Record<string, unknown>[] = [weekdays];
    let tries = 0;
    routes = {
      ...page(dana, () => list),
      'POST /launch-configs/c1/schedules': (body) => {
        if (tries++ === 0)
          return {
            status: 400,
            body: {
              error: 'invalid',
              message: 'A schedule fires at most once a minute',
              field: 'cron',
            },
          };
        list = [
          ...list,
          { ...weekdays, id: 's2', ...(body as object), upcoming: [], last: undefined },
        ];
        return { status: 201, body: list.at(-1) };
      },
      'PATCH /launch-configs/c1/schedules/s1': (body) => {
        list = list.map((s) => (s.id === 's1' ? { ...s, ...(body as object) } : s));
        return { body: list[0] };
      },
    };
    window.history.replaceState(null, '', '/w/net/core/launch/c1');
    render(<App />);
    const box = await section();
    const one = await within(box).findByRole('article', { name: 'Weekdays at three' });
    expect(within(one).getByText('0 3 * * 1-5')).toBeTruthy();
    expect(within(one).getByText('Run 41 has not ended')).toBeTruthy();
    expect(within(one).getByText('skipped')).toBeTruthy();

    fireEvent.click(within(box).getByRole('button', { name: 'Add schedule' }));
    fireEvent.change(within(box).getByLabelText('Name'), { target: { value: 'Mornings' } });
    fireEvent.change(within(box).getByLabelText('Cron'), { target: { value: '30 6 * * *' } });
    fireEvent.change(within(box).getByLabelText('Time zone'), { target: { value: 'UTC' } });
    expect(await within(box).findByText(/^Next:/)).toBeTruthy();
    // Secret inputs are not offered: a schedule keeps none.
    expect(within(box).queryByLabelText('api_password')).toBeNull();
    fireEvent.change(within(box).getByLabelText('retries'), { target: { value: '5' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Add schedule' }));
    expect((await within(box).findByRole('alert')).textContent).toMatch(/at most once a minute/);
    fireEvent.click(within(box).getByRole('button', { name: 'Add schedule' }));
    await within(box).findByRole('article', { name: 'Mornings' });
    expect(sent('POST /launch-configs/c1/schedules').at(-1)).toEqual({
      name: 'Mornings',
      kind: 'cron',
      cron: '30 6 * * *',
      timezone: 'UTC',
      mode: null,
      commit: null,
      missed: 'once',
      overlap: 'skip',
      inputs: { retries: '5' },
    });

    const first = within(box).getByRole('article', { name: 'Weekdays at three' });
    fireEvent.click(within(first).getByRole('button', { name: 'Pause' }));
    await waitFor(() =>
      expect(sent('PATCH /launch-configs/c1/schedules/s1')).toEqual([{ enabled: false }]),
    );
    fireEvent.change(await within(first).findByLabelText('Hand to a service account'), {
      target: { value: 'u3' },
    });
    fireEvent.click(within(first).getByRole('button', { name: 'Hand over' }));
    await waitFor(() =>
      expect(sent('PATCH /launch-configs/c1/schedules/s1').at(-1)).toEqual({ owner: 'u3' }),
    );
  });

  it('an operator reads them and changes nothing', async () => {
    routes = page(omar, () => [weekdays]);
    window.history.replaceState(null, '', '/w/net/core/launch/c1');
    render(<App />);
    const box = await section();
    const one = await within(box).findByRole('article', { name: 'Weekdays at three' });
    expect(within(box).queryByRole('button', { name: 'Add schedule' })).toBeNull();
    expect(within(one).queryByRole('button')).toBeNull();
  });
});
