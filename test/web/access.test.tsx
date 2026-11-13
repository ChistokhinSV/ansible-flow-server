// The Access panel of a workspace, with the server played by the test: grants, giving one on a
// flow, taking one back, who can do what.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const dana = { id: 'u1', login: 'dana', name: 'Dana Whitfield', admin: true, groups: [] };
const network = { id: 'w1', key: 'network', name: 'Network team', projects: 1 };
const edge = {
  id: 'p1',
  workspace: 'w1',
  key: 'edge',
  name: 'Edge',
  hosted: true,
  gitRef: 'main',
  sync: { state: 'ok' },
};
const grant = {
  id: 'g1',
  principal: { type: 'group', id: 'gr1', name: 'net-ops' },
  level: 'rw',
  workspace: 'w1',
  createdAt: '2026-11-13T10:00:00.000Z',
  createdBy: 'dana',
};

let asked: { key: string; body?: unknown }[];
let grants: object[];
beforeEach(() => {
  asked = [];
  grants = [grant];
  window.scrollTo = () => undefined;
  window.confirm = () => true;
  const routes: Record<string, (body?: unknown) => { status?: number; body?: unknown }> = {
    'GET /session': () => ({ body: dana }),
    'GET /workspaces/network': () => ({ body: network }),
    'GET /workspaces/network/projects': () => ({ body: [edge] }),
    'GET /workspaces/network/grants': () => ({ body: grants }),
    'GET /workspaces/network/access': () => ({
      body: [
        {
          user: { id: 'u2', login: 'omar', name: 'Omar Haddad' },
          admin: false,
          disabled: false,
          service: false,
          workspace: 'rw',
          approve: false,
          flows: [{ project: 'edge', file: 'flows/upgrade.flow.yaml', level: 'ro' }],
          through: ['group:net-ops', 'user:omar'],
        },
      ],
    }),
    'GET /users': () => ({
      body: [dana, { id: 'u2', login: 'omar', name: 'Omar Haddad', admin: false, service: false }],
    }),
    'GET /groups': () => ({ body: [{ id: 'gr1', name: 'net-ops', members: ['omar'] }] }),
    'GET /projects/p1/flows': () => ({
      body: { flows: [{ file: 'flows/upgrade.flow.yaml', name: 'Firewall upgrade' }] },
    }),
    'POST /workspaces/network/grants': (body) => {
      grants = [
        ...grants,
        {
          ...grant,
          id: 'g2',
          principal: { type: 'user', id: 'u2', name: 'omar' },
          level: 'ro',
          flow: { project: 'p1', projectKey: 'edge', file: 'flows/upgrade.flow.yaml' },
        },
      ];
      return { status: 201, body };
    },
    'DELETE /grants/g1': () => {
      grants = grants.filter((g) => (g as { id: string }).id !== 'g1');
      return { status: 204 };
    },
  };
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

describe("a workspace's access", () => {
  it('lists grants, gives one on a flow, takes one back, and says who can do what', async () => {
    window.history.replaceState(null, '', '/w/network');
    render(<App />);
    const panel = (await screen.findByRole('heading', { name: 'Access' })).closest(
      'section',
    ) as HTMLElement;
    expect(await within(panel).findByRole('cell', { name: 'the whole workspace' })).toBeTruthy();
    expect(await within(panel).findByText('group:net-ops, user:omar')).toBeTruthy();

    fireEvent.change(within(panel).getByLabelText('Who'), { target: { value: 'user:u2' } });
    fireEvent.click(within(panel).getByLabelText(/^ro:/));
    fireEvent.change(within(panel).getByLabelText('On'), { target: { value: 'p1' } });
    const flow = await within(panel).findByLabelText('Flow');
    await within(panel).findByRole('option', { name: /Firewall upgrade/ });
    fireEvent.change(flow, { target: { value: 'flows/upgrade.flow.yaml' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Give' }));
    await waitFor(() =>
      expect(asked.find((a) => a.key === 'POST /workspaces/network/grants')?.body).toEqual({
        user: 'u2',
        level: 'ro',
        project: 'p1',
        flow: 'flows/upgrade.flow.yaml',
      }),
    );
    expect(await within(panel).findByText('in edge')).toBeTruthy();

    fireEvent.click(within(panel).getByRole('button', { name: 'Take back rw from net-ops' }));
    await waitFor(() =>
      expect(within(panel).queryByRole('button', { name: 'Take back rw from net-ops' })).toBeNull(),
    );
  });
});
