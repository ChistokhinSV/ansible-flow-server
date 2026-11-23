// People and groups pages (AFS-56, AFS-87), with the server played by the test: the two tabs with
// their own table, adding from a button (the form closes, the list is read again), a person's
// page (what they reach, profile, a refusal worded by the server, disable, password, revoking a
// token), a service account's page making a token shown once, and a group's page (members chosen
// by login and sent by id, the workspaces that name it). A person who is not an administrator
// gets no page.
// The list is rendered by itself (its tab is a prop the app's routes give); the other pages
// through the app.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';
import { PeoplePage } from '../../src/web/people';

const user = (id: string, login: string, extra: Record<string, unknown> = {}) => ({
  id,
  login,
  name: '',
  admin: false,
  disabled: false,
  service: false,
  createdAt: '2026-11-01T09:00:00.000Z',
  groups: [] as string[],
  ...extra,
});
const dana = user('u1', 'dana', { name: 'Dana Reyes', admin: true });
const omar = user('u2', 'omar', { name: 'Omar Haddad', groups: ['netops'] });
const ci = user('u3', 'ci-bot', { name: 'CI', service: true });
const netops = { id: 'g1', name: 'netops', members: ['omar'] };

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
const sent = (key: string) => asked.filter((a) => a.key === key).map((a) => a.body);
const open = (path: string) => {
  window.history.replaceState(null, '', path);
  render(<App />);
};

describe('People and groups', () => {
  it('shows people and groups each on their own tab, and filters people', async () => {
    routes = {
      'GET /users': () => ({ body: [dana, omar, ci, user('u5', 'lena', { disabled: true })] }),
      'GET /groups': () => ({ body: [netops] }),
    };
    render(<PeoplePage tab="people" />);
    await screen.findByText('Omar Haddad');
    expect(screen.getByText('tokens only')).toBeTruthy();
    // The groups are on the other tab: here only how many there are.
    expect(screen.queryByRole('link', { name: 'netops' })).toBeNull();
    const tabs = screen.getByRole('navigation', { name: 'People and groups' });
    expect(
      within(tabs)
        .getByRole('link', { name: /^People/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    const groupsTab = within(tabs).getByRole('link', { name: /^Groups/ });
    expect(groupsTab.getAttribute('href')).toBe('/admin/groups');
    expect(groupsTab.textContent).toBe('Groups1');
    // No form until it is asked for.
    expect(screen.queryByLabelText('Login')).toBeNull();

    fireEvent.click(screen.getByLabelText('Service accounts'));
    expect(screen.queryByText('Omar Haddad')).toBeNull();
    expect(screen.getByRole('link', { name: 'CI' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Disabled'));
    expect(screen.getByRole('link', { name: 'lena' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'CI' })).toBeNull();
    fireEvent.click(screen.getByLabelText('All'));
    fireEvent.change(screen.getByLabelText('Find'), { target: { value: 'OMAR' } });
    expect(screen.getByRole('link', { name: 'Omar Haddad' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Dana Reyes' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Find'), { target: { value: 'nobody' } });
    expect(screen.getByText('No one matches.')).toBeTruthy();

    cleanup();
    render(<PeoplePage tab="groups" />);
    const group = await screen.findByRole('link', { name: 'netops' });
    expect(group.getAttribute('href')).toBe('/admin/groups/g1');
    expect(screen.queryByText('Omar Haddad')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add a group' })).toBeTruthy();
  });

  it('adds a person from the button: the form closes and the list is read again', async () => {
    const people = [dana, omar];
    routes = {
      'GET /users': () => ({ body: [...people] }),
      'GET /groups': () => ({ body: [netops] }),
      'POST /users': (body) => {
        const made = user('u4', (body as { login: string }).login);
        people.push(made);
        return { status: 201, body: made };
      },
    };
    window.history.replaceState(null, '', '/admin/people');
    const view = render(<PeoplePage tab="people" />);
    await screen.findByText('Omar Haddad');
    fireEvent.click(screen.getByRole('button', { name: 'Add a person' }));
    const add = screen.getByRole('region', { name: 'Add a person or service account' });
    // Cancel closes it with nothing sent.
    fireEvent.click(within(add).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Login')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add a person' }));
    fireEvent.change(screen.getByLabelText('Login'), { target: { value: 'rita' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'a long enough secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByLabelText('Login')).toBeNull());
    expect(sent('POST /users')).toEqual([
      { login: 'rita', name: '', password: 'a long enough secret' },
    ]);
    // They are in the list (and in the line that says so), and the page stays on it.
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'rita' })).toHaveLength(2));
    expect(screen.getByRole('status').textContent).toBe('Added rita.');
    expect(window.location.pathname).toBe('/admin/people');
    expect(screen.getByRole('button', { name: 'Add a person' })).toBeTruthy();
    // AFS-144: the note goes with another tab.
    view.rerender(<PeoplePage tab="groups" />);
    await waitFor(() => expect(screen.queryByText(/^Added /)).toBeNull());
  });

  it('adds a group from the button on the groups tab', async () => {
    const all = [netops];
    routes = {
      'GET /users': () => ({ body: [dana, omar] }),
      'GET /groups': () => ({ body: [...all] }),
      'POST /groups': (body) => {
        const made = { id: 'g2', name: (body as { name: string }).name, members: [] };
        all.push(made);
        return { status: 201, body: made };
      },
    };
    render(<PeoplePage tab="groups" />);
    await screen.findByRole('link', { name: 'netops' });
    expect(screen.queryByLabelText('Group name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add a group' }));
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'approvers' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add group' }));
    await waitFor(() => expect(screen.queryByLabelText('Group name')).toBeNull());
    expect(sent('POST /groups')).toEqual([{ name: 'approvers' }]);
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'approvers' })).toHaveLength(2));
  });

  it("a person's page says what they reach, workspace by workspace", async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /users/u2': () => ({ body: omar }),
      'GET /users/u2/tokens': () => ({ body: [] }),
      // One answer for every workspace: only those where they reach something have a row.
      'GET /users/u2/access': () => ({
        body: {
          admin: false,
          workspaces: [
            {
              workspace: { id: 'w-ops', key: 'ops', name: 'Operations' },
              level: 'operator',
              approve: true,
              flows: [{ project: 'core', projectId: 'p1', file: 'upgrade.flow.yaml', level: 'rw' }],
              through: ['user:omar', 'group:netops'],
            },
          ],
        },
      }),
    };
    open('/admin/people/u2');
    const reach = (await screen.findByRole('heading', { name: 'What they reach' })).closest(
      'section',
    ) as HTMLElement;
    const link = await within(reach).findByRole('link', { name: 'Operations' });
    expect(link.getAttribute('href')).toBe('/w/ops');
    const cells = within(link.closest('tr') as HTMLElement)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells).toEqual([
      'Operations',
      'operator',
      // AFS-152: levels in words; a flow by its title when its project's list has one.
      'upgrade: read and write in core',
      // AFS-206: the actions an action grant gives (none here).
      '',
      'yes',
      'their own grant, group netops',
    ]);
    expect(within(reach).getAllByRole('row')).toHaveLength(2);
    // One question, not one per workspace.
    expect(asked.filter((a) => a.key.endsWith('/access')).map((a) => a.key)).toEqual([
      'GET /users/u2/access',
    ]);
    expect(asked.some((a) => /^GET \/workspaces\/.+\/access$/.test(a.key))).toBe(false);

    // What they reach comes before the profile; taking access away is the last part.
    const order = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(order.slice(0, 2)).toEqual(['Groups', 'What they reach']);
    expect(order.at(-1)).toBe('Access to the server');
    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
        .getByRole('link', { name: 'People and groups' })
        .getAttribute('href'),
    ).toBe('/admin/people');

    // An administrator: said in a sentence, nothing asked of the workspaces' access.
    cleanup();
    asked = [];
    routes = {
      ...routes,
      'GET /users/u1': () => ({ body: dana }),
      'GET /users/u1/tokens': () => ({ body: [] }),
    };
    open('/admin/people/u1');
    await screen.findByText('Administrators may do everything.');
    expect(asked.some((a) => a.key.endsWith('/access'))).toBe(false);
  });

  it("a person's page: profile, the server's refusal, disable, password, revoke a token", async () => {
    let me = { ...dana };
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /users/u1': () => ({ body: me }),
      'GET /users/u1/tokens': () => ({ body: [] }),
      'GET /workspaces': () => ({ body: [] }),
      'PATCH /users/u1': (body) =>
        (body as { admin?: boolean }).admin === false
          ? {
              status: 409,
              body: {
                error: 'last_admin',
                message: 'This is the only administrator: make another one first',
              },
            }
          : (() => {
              me = { ...me, ...(body as object) };
              return { body: me };
            })(),
    };
    open('/admin/people/u1');
    await screen.findByText(/This is you/);
    // No Delete or Disable for yourself.
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    fireEvent.click(screen.getByLabelText(/^Administrator/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/only administrator/);

    cleanup();
    let o = { ...omar };
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /users/u2': () => ({ body: o }),
      'GET /workspaces': () => ({ body: [] }),
      'GET /users/u2/tokens': () => ({
        body: [
          {
            id: 't1',
            name: 'laptop git',
            hint: 'x7Qa',
            readOnly: false,
            createdAt: '2026-11-01T09:00:00.000Z',
            expiresAt: '2027-01-30T09:00:00.000Z',
          },
        ],
      }),
      'PATCH /users/u2': (body) => {
        o = { ...o, ...(body as object) };
        return { body: o };
      },
      'PUT /users/u2/password': () => ({ status: 204 }),
      'DELETE /users/u2/tokens/t1': () => ({ status: 204 }),
    };
    open('/admin/people/u2');
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    await screen.findByRole('button', { name: 'Enable' });
    expect(sent('PATCH /users/u2')).toEqual([{ disabled: true }]);

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'another long secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));
    await screen.findByText('Password set.');
    expect(sent('PUT /users/u2/password')).toEqual([{ password: 'another long secret' }]);

    // Their tokens are seen and revoked here; they make their own.
    expect(screen.queryByRole('button', { name: /^Make/ })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke laptop git' }));
    await waitFor(() => expect(sent('DELETE /users/u2/tokens/t1')).toHaveLength(1));
  });

  it("a person's groups link to their pages; deleting says so on the list (AFS-153)", async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /users/u2': () => ({ body: omar }),
      'GET /users/u2/tokens': () => ({ body: [] }),
      'GET /workspaces': () => ({ body: [] }),
      'GET /groups': () => ({ body: [netops] }),
      'GET /users': () => ({ body: [dana] }),
      'DELETE /users/u2': () => ({ status: 204 }),
    };
    open('/admin/people/u2');
    const link = await screen.findByRole('link', { name: 'netops' });
    expect(link.getAttribute('href')).toBe('/admin/groups/g1');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect((await screen.findByText('Deleted Omar Haddad.')).getAttribute('role')).toBe('status');
    expect(window.location.pathname).toBe('/admin/people');
  });

  it('a service account gets its tokens here, shown once; it has no password', async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /users/u3': () => ({ body: ci }),
      'GET /users/u3/tokens': () => ({ body: [] }),
      'GET /workspaces': () => ({ body: [] }),
      'POST /users/u3/tokens': (body) => ({
        status: 201,
        body: { id: 't2', hint: 'k9Zz', ...(body as object), token: 'afs_example-service-token' },
      }),
    };
    open('/admin/people/u3');
    await screen.findByText(/No token: the account cannot sign in/);
    expect(screen.queryByLabelText('New password')).toBeNull();
    // The token form is behind its button.
    fireEvent.click(screen.getByRole('button', { name: 'Make a token' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'pipeline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make token' }));
    await screen.findByText('afs_example-service-token');
    expect(sent('POST /users/u3/tokens')).toEqual([
      { name: 'pipeline', expiresInDays: 90, readOnly: false },
    ]);
  });

  it("a group's members are chosen by name and sent by id; the group can be renamed", async () => {
    let g = { ...netops };
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /groups/g1': () => ({ body: g }),
      'GET /users': () => ({ body: [dana, omar, ci] }),
      // The grants that name the group, in every workspace, in one answer.
      'GET /groups/g1/grants': () => ({
        body: [
          {
            id: 'gr1',
            level: 'approve',
            workspace: { id: 'w1', key: 'ops', name: 'Operations' },
            createdAt: '2026-11-01T09:00:00.000Z',
            createdBy: 'dana',
          },
          {
            id: 'gr3',
            level: 'ro',
            workspace: { id: 'w2', key: 'lab', name: 'Lab' },
            flow: { project: 'p1', projectKey: 'core', file: 'upgrade.flow.yaml' },
            createdAt: '2026-11-02T09:00:00.000Z',
            createdBy: 'dana',
          },
        ],
      }),
      // AFS-207: the actions it lets its members run.
      'GET /groups/g1/action-grants': () => ({
        body: [
          {
            id: 'ag1',
            config: 'c1',
            principal: { type: 'group', id: 'g1', name: 'netops' },
            createdAt: '2026-11-03T09:00:00.000Z',
            createdBy: 'dana',
            action: {
              title: 'Restart an edge switch',
              config: 'c1',
              project: 'p1',
              projectKey: 'core',
              workspaceKey: 'ops',
            },
          },
        ],
      }),
      'PUT /groups/g1/members': (body) => {
        const ids = (body as { users: string[] }).users;
        g = {
          ...g,
          members: [dana, omar, ci].filter((u) => ids.includes(u.id)).map((u) => u.login),
        };
        return { body: g };
      },
      'PATCH /groups/g1': (body) => {
        g = { ...g, ...(body as object) };
        return { body: g };
      },
    };
    open('/admin/groups/g1');
    const members = (await screen.findByRole('heading', { name: /^Members/ })).closest(
      'section',
    ) as HTMLElement;
    fireEvent.click(await within(members).findByLabelText(/Dana Reyes/));
    fireEvent.click(within(members).getByLabelText(/Omar Haddad/));
    fireEvent.click(within(members).getByRole('button', { name: 'Save members' }));
    await within(members).findByText('Saved.');
    expect(sent('PUT /groups/g1/members')).toEqual([{ users: ['u1'] }]);

    // The group's grants, each leading to its workspace.
    const named = screen
      .getByRole('heading', { name: 'Access this group gives' })
      .closest('section') as HTMLElement;
    const space = await within(named).findByRole('link', { name: 'Operations' });
    expect(space.getAttribute('href')).toBe('/w/ops');
    expect(
      within(named)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual([
      'Operations',
      'approver',
      'the whole workspace',
      'Lab',
      'read only',
      'upgrade in core',
    ]);
    expect(asked.some((a) => a.key.startsWith('GET /workspaces/'))).toBe(false);
    expect(
      (await within(named).findByRole('link', { name: 'Restart an edge switch' })).getAttribute(
        'href',
      ),
    ).toBe('/w/ops/core/launch/c1/settings');

    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'net-ops' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'net-ops', level: 1 });
    expect(sent('PATCH /groups/g1')).toEqual([{ name: 'net-ops', email: null, webhookUrl: null }]);
  });

  it('is not there for someone who is not an administrator', async () => {
    routes = { 'GET /session': () => ({ body: omar }) };
    open('/admin/people');
    await screen.findByRole('heading', { name: 'For administrators' });
    expect(asked.some((a) => a.key === 'GET /users')).toBe(false);
  });
});
