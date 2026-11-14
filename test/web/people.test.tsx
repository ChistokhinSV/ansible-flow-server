// People and groups pages (AFS-56), with the server played by the test: the list, adding a
// person (who then opens), a person's page (profile, a refusal worded by the server, disable,
// password, revoking a token), a service account's page making a token shown once, and a group's
// members chosen by login and sent by id. A person who is not an administrator gets no page.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

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
  it('lists people and groups, and a person added opens on their page', async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /users': () => ({ body: [dana, omar, ci] }),
      'GET /groups': () => ({ body: [netops] }),
      'POST /users': (body) => ({
        status: 201,
        body: user('u4', (body as { login: string }).login),
      }),
      'GET /users/u4': () => ({ body: user('u4', 'rita') }),
      'GET /users/u4/tokens': () => ({ body: [] }),
      'GET /workspaces': () => ({ body: [] }),
    };
    open('/admin/people');
    const people = (await screen.findByRole('heading', { name: 'People' })).closest(
      'section',
    ) as HTMLElement;
    await within(people).findByText('Omar Haddad');
    expect(within(people).getByText('service account')).toBeTruthy();
    expect(within(people).getByText('tokens only')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'netops' })).toBeTruthy();

    const add = screen
      .getByRole('heading', { name: 'Add a person or service account' })
      .closest('section') as HTMLElement;
    fireEvent.change(within(add).getByLabelText('Login'), { target: { value: 'rita' } });
    fireEvent.change(within(add).getByLabelText('Password'), {
      target: { value: 'a long enough secret' },
    });
    fireEvent.click(within(add).getByRole('button', { name: 'Add' }));
    await screen.findByRole('heading', { name: 'rita', level: 1 });
    expect(sent('POST /users')).toEqual([
      { login: 'rita', name: '', password: 'a long enough secret' },
    ]);
    expect(window.location.pathname).toBe('/admin/people/u4');
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
    expect(screen.queryByRole('button', { name: 'Make token' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke laptop git' }));
    await waitFor(() => expect(sent('DELETE /users/u2/tokens/t1')).toHaveLength(1));
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

    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'net-ops' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'net-ops', level: 1 });
    expect(sent('PATCH /groups/g1')).toEqual([{ name: 'net-ops', email: null, webhookUrl: null }]);
  });

  it('is not there for someone who is not an administrator', async () => {
    routes = { 'GET /session': () => ({ body: omar }) };
    open('/admin/people');
    await screen.findByRole('heading', { name: 'Nothing here' });
    expect(asked.some((a) => a.key === 'GET /users')).toBe(false);
  });
});
