// The web application in a browser-like page, with the server's API played by the test: what
// each kind of visitor sees, and that the pages say what the server said.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';
import { match, navigate } from '../../src/web/router';

type Handler = (body: unknown) => { status?: number; body?: unknown };
let routes: Record<string, Handler>;
let calls: string[];

const dana = { id: 'u1', login: 'dana', name: 'Dana Whitfield', admin: true, groups: [] };
const omar = { id: 'u2', login: 'omar', name: 'Omar Haddad', admin: false, groups: [] };
const network = { id: 'w1', key: 'network', name: 'Network team', projects: 2 };
const edge = {
  id: 'p1',
  workspace: 'w1',
  key: 'edge',
  name: 'Edge switches',
  hosted: false,
  gitUrl: 'https://git.example.net/network/edge-flows.git',
  gitPath: '/git/network/edge.git',
  gitRef: 'main',
  commit: '9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b',
  sync: { state: 'ok', at: '2026-11-13T10:15:33.364Z' },
  pollSeconds: 300,
  hook: false,
};
const lab = {
  ...edge,
  id: 'p2',
  key: 'lab',
  name: 'Lab',
  hosted: true,
  gitUrl: undefined,
  gitPath: '/git/network/lab.git',
  commit: undefined,
  sync: { state: 'never' },
  pollSeconds: 0,
};

/** The API as a signed-in person sees it. */
const signedInAs = (user: typeof dana) => ({
  'GET /session': () => ({ body: user }),
  'GET /workspaces': () => ({ body: [network] }),
  'GET /workspaces/network': () => ({ body: network }),
  'GET /workspaces/network/projects': () => ({ body: [edge, lab] }),
  'GET /projects/p1/branches': () => ({ body: { branches: ['main', 'try/idea'] } }),
  'GET /projects/p2/branches': () => ({ body: { branches: [] } }),
  'GET /projects/p1/pushes?limit=20': () => ({
    body: [
      {
        id: 'g1',
        login: 'omar',
        ref: 'main',
        from: '9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b',
        to: '41d7a0c93be2f5681a0c4e7d9b3f2a6c8e1d0b57',
        at: '2026-11-13T12:09:23.386Z',
      },
    ],
  }),
  'GET /projects/p2/pushes?limit=20': () => ({ body: [] }),
  'GET /projects/p1/flows': () => ({
    body: {
      commit: edge.commit,
      flows: [
        {
          file: 'flows/os-upgrade.flow.yaml',
          ok: true,
          key: 'os-upgrade',
          name: 'OS upgrade',
          version: 7,
          format: 2,
          steps: 12,
          errors: 0,
          warnings: 2,
        },
        {
          file: 'old/broken.flow.yaml',
          ok: false,
          problem:
            'The flow is in format 99; this server reads up to format 2. Upgrade the server.',
          errors: 0,
          warnings: 0,
        },
      ],
    },
  }),
  'GET /projects/p2/flows': () => ({ body: { flows: [] } }),
  'GET /tokens': () => ({ body: [] }),
});

beforeEach(() => {
  calls = [];
  routes = {};
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  window.scrollTo = () => undefined;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
    calls.push(key);
    const handler = routes[key];
    const answer = handler
      ? handler(init.body ? JSON.parse(String(init.body)) : undefined)
      : { status: 404, body: { error: 'not_found', message: `Nothing at ${key}` } };
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => answer.body,
    } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('addresses', () => {
  it('a pattern matches a path with the same parts, and names them', () => {
    expect(match('/w/:workspace', '/w/network')).toEqual({ workspace: 'network' });
    expect(match('/w/:workspace/:project', '/w/network/edge/')).toEqual({
      workspace: 'network',
      project: 'edge',
    });
    expect(match('/w/:workspace', '/w/network/edge')).toBeUndefined();
    expect(match('/w/:workspace', '/x/network')).toBeUndefined();
    expect(match('/w/:workspace', '/w/a%20b')).toEqual({ workspace: 'a b' });
    expect(match('/w/:workspace', '/w/%E0%A4%A')).toBeUndefined();
  });
});

describe('before anyone is signed in', () => {
  it('a new server asks for its first administrator, then shows the application', async () => {
    routes = {
      'GET /session': () => ({ status: 401, body: { error: 'unauthorized', message: 'Sign in' } }),
      'GET /setup': () => ({ body: { needed: true } }),
      'POST /setup': (body) => {
        expect(body).toEqual({
          code: 'Jq3vN0c4TzWk',
          login: 'dana',
          name: 'Dana Whitfield',
          password: 'correct horse battery staple',
        });
        Object.assign(routes, signedInAs(dana));
        return { body: dana };
      },
    };
    render(<App />);
    await screen.findByRole('heading', { name: 'Set up Ansible Flow Server' });
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    type('Setup code', 'Jq3vN0c4TzWk');
    type('Login', 'dana');
    type('Name', 'Dana Whitfield');
    type('Password', 'correct horse battery staple');
    fireEvent.click(screen.getByRole('button', { name: 'Make the administrator' }));
    await screen.findByRole('heading', { name: 'Workspaces' });
    expect(screen.getByRole('link', { name: 'Dana Whitfield' })).toBeTruthy();
  });

  it('asks to sign in, says why a sign-in was refused, and then shows the page asked for', async () => {
    window.history.replaceState(null, '', '/w/network');
    let tries = 0;
    routes = {
      'GET /session': () => ({ status: 401, body: { error: 'unauthorized', message: 'Sign in' } }),
      'GET /setup': () => ({ body: { needed: false } }),
      'POST /session': () => {
        if (tries++ === 0)
          return {
            status: 401,
            body: { error: 'unauthorized', message: 'The login or the password is wrong' },
          };
        Object.assign(routes, signedInAs(omar));
        return { body: omar };
      },
    };
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in' });
    type('Login', 'omar');
    type('Password', 'not it');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The login or the password is wrong',
    );
    // A refused sign-in is not "the session ended": the form stays, with what was typed.
    expect((screen.getByLabelText('Login') as HTMLInputElement).value).toBe('omar');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Network team' });
    expect(window.location.pathname).toBe('/w/network');
  });

  it('says so when the server does not answer, and tries again when asked', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/does not answer/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('signed in', () => {
  it('an administrator sees what administrators do; someone else does not', async () => {
    routes = signedInAs(dana);
    const first = render(<App />);
    await screen.findByRole('link', { name: /Network team/ });
    expect(screen.getByRole('button', { name: 'Add workspace' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Administration' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Workspaces' }).getAttribute('aria-current')).toBe(
      'page',
    );
    first.unmount();

    routes = signedInAs(omar);
    window.history.replaceState(null, '', '/admin');
    render(<App />);
    await screen.findByRole('heading', { name: 'Nothing here' });
    expect(screen.queryByRole('link', { name: 'Administration' })).toBeNull();
    navigate('/');
    await screen.findByRole('link', { name: /Network team/ });
    expect(screen.queryByRole('button', { name: 'Add workspace' })).toBeNull();
  });

  it('adds a workspace and goes to it; a refusal is shown in the form', async () => {
    routes = {
      ...signedInAs(dana),
      'POST /workspaces': (body) =>
        (body as { key: string }).key === 'network'
          ? {
              status: 409,
              body: { error: 'taken', message: 'There is a workspace network already' },
            }
          : { status: 201, body: { id: 'w2', key: 'dc', name: 'Data centre', projects: 0 } },
      'GET /workspaces/dc': () => ({
        body: { id: 'w2', key: 'dc', name: 'Data centre', projects: 0 },
      }),
      'GET /workspaces/dc/projects': () => ({ body: [] }),
    };
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add workspace' }));
    type('Name', 'Data centre');
    type('Key', 'network');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'There is a workspace network already',
    );
    type('Key', 'dc');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByRole('heading', { name: 'Data centre' });
    expect(window.location.pathname).toBe('/w/dc');
    expect(screen.getByText('No project in this workspace yet.')).toBeTruthy();
  });

  it('a project page says where it is, how to clone it and who pushed', async () => {
    routes = signedInAs(dana);
    window.history.replaceState(null, '', '/w/network/edge');
    render(<App />);
    await screen.findByRole('heading', { name: 'Edge switches' });
    expect(
      screen.getByText(`git clone ${window.location.origin}/git/network/edge.git`),
    ).toBeTruthy();
    expect(screen.getByText('up to date')).toBeTruthy();
    expect(screen.getByText('9f2c1e7ab3d4')).toBeTruthy();
    await screen.findByText('main, try/idea');
    const row = (await screen.findByText('omar')).closest('tr');
    expect(row?.textContent).toContain('9f2c1e7a');
    expect(row?.textContent).toContain('41d7a0c9');
    expect(screen.getByRole('button', { name: 'Look at the source now' })).toBeTruthy();
    // The breadcrumb leads back.
    fireEvent.click(screen.getByRole('link', { name: 'network' }));
    await screen.findByRole('heading', { name: 'Network team' });
  });

  it("lists a project's flows with their findings, and shows one on the designer's page", async () => {
    routes = signedInAs(dana);
    window.history.replaceState(null, '', '/w/network/edge');
    render(<App />);
    const link = await screen.findByRole('link', { name: /OS upgrade/ });
    expect(link.textContent).toContain('version 7');
    expect(link.textContent).toContain('12 steps');
    expect(link.textContent).toContain('2 warnings');
    // A flow the server cannot read is listed with the reason, and is not a link.
    expect(screen.getByText(/Upgrade the server/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /broken/ })).toBeNull();

    fireEvent.click(link);
    await screen.findByRole('heading', { name: 'OS upgrade' });
    expect(window.location.pathname).toBe('/w/network/edge/flow/flows/os-upgrade.flow.yaml');
    const frame = (await screen.findByTitle(/OS upgrade on the designer/)) as HTMLIFrameElement;
    const src = new URL(frame.src);
    expect(src.pathname).toBe('/viewer.html');
    expect(Object.fromEntries(src.searchParams)).toEqual({
      project: 'p1',
      path: 'flows/os-upgrade.flow.yaml',
      theme: 'auto',
    });
    expect(screen.getByText(/main at 9f2c1e7ab3d4 · shown, not changed/)).toBeTruthy();
    // The designer follows the theme the person chose.
    fireEvent.click(screen.getByRole('button', { name: 'Theme: as the device' }));
    await waitFor(() =>
      expect(
        new URL(
          (screen.getByTitle(/OS upgrade on the designer/) as HTMLIFrameElement).src,
        ).searchParams.get('theme'),
      ).toBe('light'),
    );
  });

  it('a hosted project that is empty says to push; a project that is not there says so', async () => {
    routes = signedInAs(omar);
    window.history.replaceState(null, '', '/w/network/lab');
    render(<App />);
    await screen.findByRole('heading', { name: 'Lab' });
    expect(screen.getByText(/The repository is empty: push a first commit to main/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Look at the source now' })).toBeNull();
    navigate('/w/network/nothing');
    await screen.findByText('There is no such project.');
  });

  it('makes an access token, shows it once, and lists what it has', async () => {
    const made = {
      id: 't1',
      name: 'laptop git',
      hint: 'Xk3Q',
      readOnly: true,
      createdAt: '2026-11-13T09:44:37.512Z',
      expiresAt: '2026-12-13T09:44:37.512Z',
    };
    let have: unknown[] = [];
    routes = {
      ...signedInAs(omar),
      'GET /tokens': () => ({ body: have }),
      'POST /tokens': (body) => {
        expect(body).toEqual({ name: 'laptop git', expiresInDays: 30, readOnly: true });
        have = [made];
        return { status: 201, body: { ...made, token: `afs_${'A'.repeat(43)}` } };
      },
    };
    window.history.replaceState(null, '', '/account');
    render(<App />);
    await screen.findByText('You have no token.');
    type('Name', 'laptop git');
    type('Days until it expires', '30');
    fireEvent.click(screen.getByLabelText(/Read only/));
    fireEvent.click(screen.getByRole('button', { name: 'Make token' }));
    expect((await screen.findByRole('status')).textContent).toContain(`afs_${'A'.repeat(43)}`);
    await screen.findByText('…Xk3Q');
    fireEvent.click(screen.getByRole('button', { name: 'I have copied it' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.body.textContent).not.toContain('afs_AAAA');
  });

  it('shows sign-in again when the server says the session has ended', async () => {
    routes = signedInAs(dana);
    render(<App />);
    await screen.findByRole('link', { name: /Network team/ });
    routes['GET /workspaces/network'] = () => ({
      status: 401,
      body: { error: 'unauthorized', message: 'Sign in first' },
    });
    fireEvent.click(screen.getByRole('link', { name: /Network team/ }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it('signs out, and the theme button goes round: device, light, dark', async () => {
    routes = { ...signedInAs(dana), 'DELETE /session': () => ({ status: 204 }) };
    render(<App />);
    await screen.findByRole('link', { name: /Network team/ });
    const root = document.documentElement;
    fireEvent.click(screen.getByRole('button', { name: 'Theme: as the device' }));
    await waitFor(() => expect(root.dataset.theme).toBe('light'));
    fireEvent.click(screen.getByRole('button', { name: 'Theme: light' }));
    await waitFor(() => expect(root.dataset.theme).toBe('dark'));
    expect(window.localStorage.getItem('afs.theme')).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: 'Theme: dark' }));
    await waitFor(() => expect(root.dataset.theme).toBeUndefined());
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(calls).toContain('DELETE /session');
  });
});
