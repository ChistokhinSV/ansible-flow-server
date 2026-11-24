// AFS-241 on the pages, with the server played by the test: Administration › Secret providers
// (add a Vault, test it, its secret never shown again), and a credential whose password is taken
// from a provider (Test read says no value; the reference is sent, no password). A member sees
// which provider only.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const dana = { id: 'u1', login: 'dana', name: 'Dana Whitfield', admin: true, groups: [] };
const omar = { id: 'u2', login: 'omar', name: 'Omar Haddad', admin: false, groups: [] };
const network = { id: 'w1', key: 'network', name: 'Network team', projects: 1 };
const vault = {
  id: 'p1',
  key: 'corp-vault',
  name: 'Corp Vault',
  kind: 'vault',
  settings: { address: 'https://vault.example.net:8200', auth: 'approle' },
  has: ['roleId', 'secretId'],
  workspaces: ['w1'],
  createdAt: '2026-11-23T09:00:00.000Z',
  updatedAt: '2026-11-23T09:00:00.000Z',
};
const login = {
  id: 'c1',
  workspace: 'w1',
  name: 'Lab switches',
  kind: 'login',
  fields: { username: 'netops' },
  has: ['password'],
  refs: {
    password: {
      provider: 'corp-vault',
      providerName: 'Corp Vault',
      kind: 'vault',
      path: { path: 'network/switches', field: 'password' },
    },
  },
  usedBy: 0,
  createdAt: '2026-11-23T09:00:00.000Z',
  updatedAt: '2026-11-23T09:00:00.000Z',
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

describe('secret providers', () => {
  it('an administrator adds a Vault, tests it, and its secret is never shown again', async () => {
    let list: unknown[] = [];
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /workspaces': () => ({ body: [network] }),
      'GET /admin/secret-providers': () => ({ body: list }),
      'POST /admin/secret-providers': (body) => {
        list = [{ ...vault, ...(body as object), has: ['roleId', 'secretId'] }];
        return { status: 201, body: list[0] };
      },
      'POST /admin/secret-providers/p1/test': () => ({
        body: { ok: true, message: 'Signed in with AppRole' },
      }),
    };
    open('/admin/secret-providers');
    expect(await screen.findByText('No secret provider yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a provider' }));
    const form = screen.getByRole('region', { name: 'Add a secret provider' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Corp Vault' } });
    fireEvent.change(within(form).getByLabelText('Address'), {
      target: { value: 'https://vault.example.net:8200' },
    });
    fireEvent.change(within(form).getByLabelText('Role id'), { target: { value: 'role-1' } });
    const secretId = within(form).getByLabelText('Secret id') as HTMLInputElement;
    expect(secretId.type).toBe('password');
    fireEvent.change(secretId, { target: { value: 'fictional-secret-id' } });
    fireEvent.click(within(form).getByLabelText('Network team'));
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    const card = await screen.findByRole('article', { name: 'Corp Vault' });
    expect(sent('POST /admin/secret-providers')).toEqual([
      {
        key: 'corp-vault',
        name: 'Corp Vault',
        kind: 'vault',
        settings: { address: 'https://vault.example.net:8200', auth: 'approle' },
        secret: { roleId: 'role-1', secretId: 'fictional-secret-id' },
        workspaces: ['w1'],
      },
    ]);
    expect(within(card).getByText('Network team')).toBeTruthy();
    fireEvent.click(within(card).getByText('Test the provider'));
    fireEvent.click(within(card).getByRole('button', { name: 'Test' }));
    expect(await within(card).findByText('Signed in with AppRole')).toBeTruthy();
    // A change keeps the secret part unless asked: its fields are not there.
    fireEvent.click(within(card).getByRole('button', { name: 'Change' }));
    const change = screen.getByRole('region', { name: 'Change Corp Vault' });
    // AFS-252: the form above the list says which provider it changes.
    expect(within(change).getByRole('heading', { name: 'Change Corp Vault' })).toBeTruthy();
    expect(within(change).queryByLabelText('Secret id')).toBeNull();
    expect(within(change).getByText(/role id and secret id are kept/)).toBeTruthy();
  });

  it('AFS-261: switched to a token, the form asks for it and drops the AppRole parts', async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /workspaces': () => ({ body: [network] }),
      'GET /admin/secret-providers': () => ({
        body: [{ ...vault, settings: { ...vault.settings, authMount: 'ar' } }],
      }),
      'PATCH /admin/secret-providers/p1': (body) => ({ body: { ...vault, ...(body as object) } }),
    };
    open('/admin/secret-providers');
    const card = await screen.findByRole('article', { name: 'Corp Vault' });
    // AFS-260: the reference's own parts are not called optional; Test keeps its name.
    fireEvent.click(within(card).getByText('Test the provider'));
    expect(within(card).getByLabelText('Path')).toBeTruthy();
    expect(within(card).getByLabelText('KV mount (optional)')).toBeTruthy();
    fireEvent.change(within(card).getByLabelText('Path'), { target: { value: 'lab/switch' } });
    expect(within(card).getByRole('button', { name: 'Test' })).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Change' }));
    const change = screen.getByRole('region', { name: 'Change Corp Vault' });
    expect(within(change).getByLabelText('AppRole mount')).toBeTruthy();
    fireEvent.change(within(change).getByLabelText('Sign in with'), { target: { value: 'token' } });
    expect(within(change).queryByText(/are kept/)).toBeNull();
    expect(within(change).queryByLabelText('AppRole mount')).toBeNull();
    fireEvent.change(within(change).getByLabelText('Token'), {
      target: { value: 'hvs.fictional-token' },
    });
    fireEvent.click(within(change).getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Add a provider' });
    expect(sent('PATCH /admin/secret-providers/p1')).toEqual([
      {
        key: 'corp-vault',
        name: 'Corp Vault',
        settings: { address: 'https://vault.example.net:8200', auth: 'token' },
        workspaces: ['w1'],
        secret: { token: 'hvs.fictional-token' },
      },
    ]);
  });

  it('a credential takes its password from a provider; Test read never shows a value', async () => {
    let list: unknown[] = [];
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /workspaces/network': () => ({ body: network }),
      'GET /workspaces/network/projects': () => ({ body: [] }),
      'GET /workspaces/network/credentials': () => ({ body: list }),
      'GET /workspaces/network/secret-providers': () => ({
        body: [{ key: 'corp-vault', name: 'Corp Vault', kind: 'vault' }],
      }),
      'POST /workspaces/network/secret-refs/test': () => ({
        body: {
          ok: true,
          message: 'Read from HashiCorp Vault "Corp Vault" (the value is not shown)',
        },
      }),
      'POST /workspaces/network/credentials': () => {
        list = [login];
        return { status: 201, body: login };
      },
    };
    open('/w/network/-/credentials');
    const section = (await screen.findByRole('heading', { name: 'Credentials' })).closest(
      'section',
    ) as HTMLElement;
    fireEvent.click(within(section).getByRole('button', { name: 'Add credential' }));
    fireEvent.change(within(section).getByLabelText('Kind'), { target: { value: 'login' } });
    fireEvent.change(within(section).getByLabelText('Name'), { target: { value: 'Lab switches' } });
    fireEvent.change(within(section).getByLabelText('User name'), { target: { value: 'netops' } });
    fireEvent.click(await within(section).findByLabelText('From a secret provider'));
    expect(within(section).queryByLabelText('Password')).toBeNull();
    fireEvent.change(within(section).getByLabelText('Path'), {
      target: { value: 'network/switches' },
    });
    fireEvent.change(within(section).getByLabelText('Field'), { target: { value: 'password' } });
    // AFS-252: nothing is kept here, so the form does not say a secret is kept encrypted; and
    // Stored here and back gives the reference back as it was.
    expect(within(section).queryByText(/Kept encrypted on the server/)).toBeNull();
    fireEvent.click(within(section).getByLabelText('Stored here'));
    expect(within(section).getByText(/Kept encrypted on the server/)).toBeTruthy();
    fireEvent.click(within(section).getByLabelText('From a secret provider'));
    expect((within(section).getByLabelText('Path') as HTMLInputElement).value).toBe(
      'network/switches',
    );
    fireEvent.click(within(section).getByRole('button', { name: 'Test read' }));
    expect(await within(section).findByText(/^Read OK at .* \(value not shown\)$/)).toBeTruthy();
    expect(sent('POST /workspaces/network/secret-refs/test')).toEqual([
      { ref: { provider: 'corp-vault', path: 'network/switches', field: 'password' } },
    ]);
    fireEvent.click(within(section).getByRole('button', { name: 'Add credential' }));
    expect(
      await within(section).findByText(
        'user name netops · password from Corp Vault (network/switches#password)',
      ),
    ).toBeTruthy();
    expect(sent('POST /workspaces/network/credentials')).toEqual([
      {
        name: 'Lab switches',
        kind: 'login',
        fields: { username: 'netops' },
        secret: {},
        refs: { password: { provider: 'corp-vault', path: 'network/switches', field: 'password' } },
      },
    ]);
  });

  it('a member sees which provider, not where', async () => {
    const { path: _path, ...withoutPath } = login.refs.password;
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /workspaces': () => ({ body: [network] }),
      'GET /workspaces/network': () => ({ body: network }),
      'GET /workspaces/network/projects': () => ({ body: [] }),
      'GET /workspaces/network/credentials': () => ({
        body: [{ ...login, refs: { password: withoutPath } }],
      }),
    };
    open('/w/network/-/credentials');
    expect(await screen.findByText('user name netops · password from Corp Vault')).toBeTruthy();
    expect(screen.queryByText(/network\/switches/)).toBeNull();
  });

  it('a change of a credential read whole from a provider offers no Replace tick', async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /workspaces': () => ({ body: [network] }),
      'GET /workspaces/network': () => ({ body: network }),
      'GET /workspaces/network/projects': () => ({ body: [] }),
      'GET /workspaces/network/credentials': () => ({ body: [login] }),
      'GET /workspaces/network/secret-providers': () => ({
        body: [{ key: 'corp-vault', name: 'Corp Vault', kind: 'vault' }],
      }),
    };
    open('/w/network/-/credentials');
    fireEvent.click(await screen.findByRole('button', { name: 'Change Lab switches' }));
    expect(await screen.findByLabelText('Path')).toBeTruthy();
    expect(screen.queryByLabelText(/Replace the secret/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Stored here'));
    expect(screen.getByLabelText('Replace the secret stored here')).toBeTruthy();
    // The part is named once, by its group: the field's own label is for screen readers.
    const field = screen.getByLabelText('Password').closest('.field') as HTMLElement;
    expect(field.querySelector('label .sr-only')?.textContent).toBe('Password');
  });
});
