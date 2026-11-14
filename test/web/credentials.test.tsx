// Credentials on the pages (AFS-63), with the server played by the test: a workspace's list with
// what each holds; an administrator adds one (secret inputs not filled by the browser), renames
// one without touching its secret, and is told why one in use cannot be deleted; someone else
// only sees the list. A project whose https source asks for a sign-in says so, and its
// administrator chooses the git credential.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const dana = { id: 'u1', login: 'dana', name: 'Dana Whitfield', admin: true, groups: [] };
const omar = { id: 'u2', login: 'omar', name: 'Omar Haddad', admin: false, groups: [] };
const network = { id: 'w1', key: 'network', name: 'Network team', projects: 1 };
const sshKey = {
  id: 'c1',
  workspace: 'w1',
  name: 'edge-ssh',
  kind: 'ssh_key',
  fields: { username: 'netops' },
  has: ['privateKey'],
  usedBy: 2,
  createdAt: '2026-11-13T09:00:00.000Z',
  updatedAt: '2026-11-13T09:00:00.000Z',
};
const gitToken = {
  ...sshKey,
  id: 'c2',
  name: 'git-bot',
  kind: 'git_token',
  fields: {},
  has: ['token'],
  usedBy: 0,
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
const panel = async () =>
  (await screen.findByRole('heading', { name: 'Credentials' })).closest('section') as HTMLElement;

describe("a workspace's credentials", () => {
  it('an administrator adds, renames without the secret, and is told why one in use stays', async () => {
    let list = [sshKey];
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /workspaces/network': () => ({ body: network }),
      'GET /workspaces/network/projects': () => ({ body: [] }),
      'GET /workspaces/network/credentials': () => ({ body: list }),
      'POST /workspaces/network/credentials': (body) => {
        const made = { ...sshKey, id: 'c3', usedBy: 0, ...(body as object), has: ['password'] };
        list = [...list, made as typeof sshKey];
        return { status: 201, body: made };
      },
      'PATCH /credentials/c1': (body) => {
        list = [{ ...sshKey, ...(body as object) }];
        return { body: list[0] };
      },
      'DELETE /credentials/c1': () => ({
        status: 409,
        body: {
          error: 'in_use',
          message:
            'The project edge signs in to its repository with it: give the project another first',
        },
      }),
    };
    open('/w/network');
    const section = await panel();
    expect(await within(section).findByText('user name netops · private key')).toBeTruthy();
    expect(within(section).getByText('SSH key')).toBeTruthy();

    fireEvent.click(within(section).getByRole('button', { name: 'Add credential' }));
    fireEvent.change(within(section).getByLabelText('Kind'), { target: { value: 'login' } });
    fireEvent.change(within(section).getByLabelText('Name'), { target: { value: 'switch-login' } });
    fireEvent.change(within(section).getByLabelText('User name'), { target: { value: 'admin' } });
    const password = within(section).getByLabelText('Password') as HTMLInputElement;
    expect(password.type).toBe('password');
    expect(password.autocomplete).toBe('off');
    fireEvent.change(password, { target: { value: 'an example secret' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Add credential' }));
    await within(section).findByText('switch-login');
    expect(sent('POST /workspaces/network/credentials')).toEqual([
      {
        name: 'switch-login',
        kind: 'login',
        fields: { username: 'admin' },
        secret: { password: 'an example secret' },
      },
    ]);

    fireEvent.click(within(section).getByRole('button', { name: 'Change edge-ssh' }));
    const change = within(section).getByRole('region', { name: 'Change edge-ssh' });
    // The secret stays unless asked: its fields are not even there.
    expect(within(change).queryByLabelText('Private key')).toBeNull();
    fireEvent.change(within(change).getByLabelText('Name'), { target: { value: 'edge-ssh-2026' } });
    fireEvent.click(within(change).getByRole('button', { name: 'Save' }));
    await within(section).findByText('edge-ssh-2026');
    expect(sent('PATCH /credentials/c1')).toEqual([
      { name: 'edge-ssh-2026', description: null, fields: { username: 'netops' } },
    ]);

    fireEvent.click(within(section).getByRole('button', { name: 'Delete edge-ssh-2026' }));
    expect((await within(section).findByRole('alert')).textContent).toMatch(
      /signs in to its repository with it/,
    );
  });

  it('someone who is not an administrator sees the list and nothing to change', async () => {
    routes = {
      'GET /session': () => ({ body: omar }),
      'GET /workspaces/network': () => ({ body: network }),
      'GET /workspaces/network/projects': () => ({ body: [] }),
      'GET /workspaces/network/credentials': () => ({ body: [sshKey] }),
    };
    open('/w/network');
    const section = await panel();
    await within(section).findByText('edge-ssh');
    expect(within(section).queryByRole('button')).toBeNull();
  });
});

describe("a project's git credential", () => {
  it('a source that asks for a sign-in says so; the administrator chooses a git token', async () => {
    let edge = {
      id: 'p1',
      workspace: 'w1',
      key: 'edge',
      name: 'Edge',
      hosted: false,
      gitUrl: 'https://git.example.net/network/edge-flows.git',
      gitRef: 'main',
      sync: {
        state: 'error',
        error:
          "fatal: could not read Username for 'https://git.example.net': terminal prompts disabled",
      },
    } as Record<string, unknown>;
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /workspaces/network/projects': () => ({ body: [edge] }),
      'GET /workspaces/network/credentials': () => ({ body: [sshKey, gitToken] }),
      'PATCH /projects/p1': (body) => {
        edge = { ...edge, ...(body as object), sync: { state: 'ok' } };
        return { body: edge };
      },
    };
    open('/w/network/edge');
    await screen.findByText(/The repository asks for a sign-in: choose/);
    const choice = (await screen.findByLabelText('Signs in with')) as HTMLSelectElement;
    // Only what a git source can sign in with is offered.
    await waitFor(() =>
      expect([...choice.options].map((o) => o.textContent)).toEqual([
        'nothing (a public repository)',
        'git-bot (git token)',
      ]),
    );
    fireEvent.change(choice, { target: { value: 'c2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and look at the source' }));
    await screen.findByText('Saved.');
    expect(sent('PATCH /projects/p1')).toEqual([{ gitCredential: 'c2' }]);
  });
});
