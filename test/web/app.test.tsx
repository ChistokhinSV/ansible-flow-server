// The web application in a browser-like page, with the server's API played by the test: what
// each kind of visitor sees, and that the pages say what the server said.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  'GET /projects/p1/branches': () => ({
    body: {
      branches: ['main', 'try/idea'],
      details: [
        {
          name: 'try/idea',
          commit: '41d7a0c93be2f5681a0c4e7d9b3f2a6c8e1d0b57',
          author: 'Omar Haddad',
          at: '2026-11-13T12:09:23.386Z',
          subject: 'Try NTP pools',
          ahead: 2,
        },
        {
          name: 'main',
          commit: '9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b',
          author: 'Dana Whitfield',
          at: '2026-11-13T10:00:00.000Z',
          subject: 'Edge baseline v7',
          ahead: 0,
          project: true,
        },
      ],
    },
  }),
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
          lastRun: {
            id: 'r41',
            number: 41,
            state: 'failed',
            createdAt: '2026-11-13T11:00:00.000Z',
            endedAt: '2026-11-13T11:03:00.000Z',
          },
        },
        {
          file: 'flows/blank.flow.yaml',
          ok: true,
          key: 'blank',
          name: 'Blank',
          version: 1,
          format: 2,
          steps: 0,
          errors: 0,
          warnings: 0,
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

  it('the setup address from the log brings the code, and the page leaves it once done', async () => {
    window.history.replaceState(null, '', '/setup?code=Jq3vN0c4TzWk');
    routes = {
      'GET /session': () => ({ status: 401, body: { error: 'unauthorized', message: 'Sign in' } }),
      'GET /setup': () => ({ body: { needed: true } }),
      'POST /setup': (body) => {
        expect(body).toMatchObject({ code: 'Jq3vN0c4TzWk', login: 'dana' });
        Object.assign(routes, signedInAs(dana));
        return { body: dana };
      },
    };
    render(<App />);
    await screen.findByRole('heading', { name: 'Set up Ansible Flow Server' });
    expect((screen.getByLabelText('Setup code') as HTMLInputElement).value).toBe('Jq3vN0c4TzWk');
    type('Login', 'dana');
    type('Name', 'Dana Whitfield');
    type('Password', 'correct horse battery staple');
    fireEvent.click(screen.getByRole('button', { name: 'Make the administrator' }));
    await screen.findByRole('heading', { name: 'Workspaces' });
    expect(window.location.pathname).toBe('/');
  });

  it('asks to sign in, says why a sign-in was refused, and then shows the page asked for', async () => {
    window.history.replaceState(null, '', '/w/network');
    let tries = 0;
    routes = {
      // AFS-144: the page asks as "optional": nobody signed in is an empty answer, not a 401.
      'GET /session': () => ({ status: 204 }),
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
    await screen.findByRole('heading', { name: 'Sign in to Ansible Flow Server' });
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
    // AFS-192: no Add project here, and who adds one is said.
    expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull();
    expect(
      await screen.findByText(/Projects are added by administrators of the server/),
    ).toBeTruthy();
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
    window.history.replaceState(null, '', '/workspaces');
    const first = render(<App />);
    await screen.findAllByRole('link', { name: /Network team/ });
    expect(screen.getByRole('button', { name: 'Add workspace' })).toBeTruthy();
    // AFS-87: the administration's pages are in the side menu.
    expect(screen.getByRole('link', { name: 'Audit log' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Workspaces' }).getAttribute('aria-current')).toBe(
      'page',
    );
    first.unmount();

    routes = signedInAs(omar);
    window.history.replaceState(null, '', '/admin');
    render(<App />);
    // AFS-102: an administration page says it is for administrators.
    await screen.findByRole('heading', { name: 'For administrators' });
    expect(screen.queryByRole('link', { name: 'Audit log' })).toBeNull();
    navigate('/workspaces');
    await screen.findByRole('heading', { name: 'Workspaces' });
    await screen.findAllByRole('link', { name: /Network team/ });
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
    window.history.replaceState(null, '', '/workspaces');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add workspace' }));
    type('Name', 'Data centre');
    // AFS-125: the key is made from the name as it is typed.
    expect((screen.getByLabelText('Key') as HTMLInputElement).value).toBe('data-centre');
    type('Key', 'network');
    // A key typed by hand stays when the name changes.
    type('Name', 'Data centre west');
    expect((screen.getByLabelText('Key') as HTMLInputElement).value).toBe('network');
    type('Name', 'Data centre');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'There is a workspace network already',
    );
    type('Key', 'dc');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByRole('heading', { name: 'Data centre' });
    expect(window.location.pathname).toBe('/w/dc');
    expect(await screen.findByText('No project in this workspace yet.')).toBeTruthy();
    expect(screen.queryByText(/Projects are added by administrators/)).toBeNull();
  });

  it('a project page says where it is, how to clone it and who pushed', async () => {
    routes = signedInAs(dana);
    window.history.replaceState(null, '', '/w/network/edge');
    render(<App />);
    await screen.findByRole('heading', { name: 'Edge switches' });
    // AFS-84: the state is one line under the title on every tab; the rest is in tabs.
    expect(screen.getByText('up to date')).toBeTruthy();
    expect(screen.getByText('9f2c1e7ab3d4')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.queryByText(/^git clone/)).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(
      await screen.findByText(`git clone ${window.location.origin}/git/network/edge.git`),
    ).toBeTruthy();
    expect(window.location.pathname).toBe('/w/network/edge/settings');
    fireEvent.click(screen.getByRole('link', { name: /^Branches/ }));
    const branches = (await screen.findByRole('heading', { name: 'Branches' })).closest(
      'section',
    ) as HTMLElement;
    expect(branches.textContent).toContain('try/idea');
    expect(branches.textContent).toContain('Try NTP pools');
    const row = (await screen.findByText('omar')).closest('tr');
    expect(row?.textContent).toContain('9f2c1e7a');
    expect(row?.textContent).toContain('41d7a0c9');
    expect(screen.getByRole('button', { name: 'Look at the source now' })).toBeTruthy();
    // AFS-144: the actions of a branch sit in a box of their own at the row's end.
    expect(branches.querySelector('td.act > .actions')).toBeTruthy();
    // The breadcrumb leads back, by the workspace's name (AFS-144).
    const crumbs = document.querySelector('.bar-crumbs') as HTMLElement;
    fireEvent.click(await within(crumbs).findByRole('link', { name: 'Network team' }));
    await screen.findByRole('heading', { name: 'Network team' });
  });

  it('an administrator deletes a project once its key is typed; a refusal is shown (AFS-100)', async () => {
    let refuse = true;
    routes = {
      ...signedInAs(dana),
      'DELETE /projects/p1': () =>
        refuse
          ? {
              status: 409,
              body: {
                error: 'not_empty',
                message: 'Run 41 of the project is still going: stop it first',
              },
            }
          : { status: 204 },
    };
    window.history.replaceState(null, '', '/w/network/edge/settings');
    render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Delete the project' })).closest(
      'section',
    ) as HTMLElement;
    // AFS-162: in the red-bordered box of what cannot be undone.
    expect(section.classList.contains('danger-zone')).toBe(true);
    expect(section.textContent).toMatch(/run history/);
    const button = within(section).getByRole('button', { name: 'Delete the project' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(section).getByLabelText('Type edge to confirm'), {
      target: { value: 'edg' },
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(section).getByLabelText('Type edge to confirm'), {
      target: { value: 'edge' },
    });
    fireEvent.click(button);
    expect(await within(section).findByRole('alert')).toHaveProperty(
      'textContent',
      'Run 41 of the project is still going: stop it first',
    );
    refuse = false;
    fireEvent.click(button);
    await waitFor(() => expect(window.location.pathname).toBe('/w/network'));
    expect(calls.filter((c) => c === 'DELETE /projects/p1')).toHaveLength(2);
  });

  it("AFS-150: an administrator changes a project's name, description and branch in Settings", async () => {
    let now = { ...edge };
    const sent: unknown[] = [];
    routes = {
      ...signedInAs(dana),
      'GET /workspaces/network/projects': () => ({ body: [now, lab] }),
      'PATCH /projects/p1': (body) => {
        sent.push(body);
        now = { ...now, ...(body as object) };
        return { body: now };
      },
    };
    vi.stubGlobal('confirm', () => true);
    window.history.replaceState(null, '', '/w/network/edge/settings');
    render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Name and branch' })).closest(
      'section',
    ) as HTMLElement;
    fireEvent.change(within(section).getByLabelText('Name'), { target: { value: 'Edge' } });
    fireEvent.change(within(section).getByLabelText('Description'), {
      target: { value: 'Edge switches and firewalls' },
    });
    await within(section).findByRole('option', { name: 'try/idea' });
    fireEvent.change(within(section).getByLabelText('Branch'), { target: { value: 'try/idea' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    expect(await within(section).findByText('Saved.')).toBeTruthy();
    expect(sent).toEqual([
      { name: 'Edge', description: 'Edge switches and firewalls', gitRef: 'try/idea' },
    ]);
  });

  it('AFS-150: a source that cannot be read is said once on Settings, under Source', async () => {
    const why = 'fatal: unable to access the repository: Could not resolve host';
    const broken = { ...edge, commit: undefined, sync: { state: 'error', error: why } };
    routes = {
      ...signedInAs(dana),
      'GET /workspaces/network/projects': () => ({ body: [broken, lab] }),
      'POST /projects/p1/sync': () => ({ body: broken }),
    };
    window.history.replaceState(null, '', '/w/network/edge/settings');
    render(<App />);
    const source = await screen.findByRole('heading', { name: 'Source' });
    // AFS-192: the problem comes first, and a mirror with nothing in it offers no clone.
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf('Source')).toBeLessThan(headings.indexOf('Name and branch'));
    expect(source).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Work on it with git' })).toBeNull();
    const count = () => document.body.textContent?.split(why).length ?? 0;
    expect(count() - 1).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Look at the source now' }));
    expect(await screen.findByText(/still cannot be read \(see Last look/)).toBeTruthy();
    expect(count() - 1).toBe(1);
  });

  it('AFS-171: a mirror with no commit says why it has no files and what to do; its state explains itself', async () => {
    const why = 'The repository has no branch main';
    const empty = { ...edge, commit: undefined, sync: { state: 'error', error: why } };
    routes = {
      ...signedInAs(dana),
      'GET /workspaces/network/projects': () => ({ body: [empty, lab] }),
    };
    window.history.replaceState(null, '', '/w/network/edge');
    render(<App />);
    const note = await screen.findByText('No files or flows yet.');
    // AFS-192: no flow to launch yet: no Add a launch configuration either.
    await screen.findByRole('heading', { name: 'Launch configurations' });
    expect(screen.queryByRole('link', { name: 'Add a launch configuration' })).toBeNull();
    expect(note.closest('p')?.textContent).toContain(
      'If the repository is empty, push a first commit to main with git; the server looks again by itself, or use Look at the source now. The Files tab and New flow come with the first commit.',
    );
    // No Files tab (nothing to show or add to), and the badge and the line say what it means.
    expect(screen.queryByRole('link', { name: 'Files' })).toBeNull();
    expect(screen.getByText('cannot be read').getAttribute('title')).toMatch(
      /^cannot be read: the server could not fetch the repository/,
    );
    expect(document.querySelector('.statusline .bad-text')?.textContent).toBe(
      `${why}. The server cannot fetch the repository. Check the address on Settings, then look at the source again.`,
    );
  });

  it('AFS-171: an answer with no words of its own says what it means and what to do', async () => {
    routes = {
      ...signedInAs(dana),
      'GET /workspaces/network': () => ({ status: 422 }),
    };
    window.history.replaceState(null, '', '/w/network');
    render(<App />);
    expect(
      await screen.findByText(
        'The server cannot do this now (422): what it is about is not in a state that allows it. Reload the page to see why.',
      ),
    ).toBeTruthy();
  });

  it('My account changes the password; the two new ones must agree (AFS-104)', async () => {
    routes = {
      ...signedInAs(omar),
      'PUT /session/password': () => ({ status: 204 }),
    };
    window.history.replaceState(null, '', '/account');
    render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Password' })).closest(
      'section',
    ) as HTMLElement;
    const fill = (label: string, value: string) =>
      fireEvent.change(within(section).getByLabelText(label), { target: { value } });
    fill('Current password', 'old-secret-1');
    fill('New password', 'new-secret-22');
    fill('New password again', 'new-secret-23');
    fireEvent.click(within(section).getByRole('button', { name: 'Change the password' }));
    expect((await within(section).findByRole('alert')).textContent).toBe(
      'The two new passwords are not the same',
    );
    expect(calls).not.toContain('PUT /session/password');
    fill('New password again', 'new-secret-22');
    fireEvent.click(within(section).getByRole('button', { name: 'Change the password' }));
    await within(section).findByText(/Changed\./);
    expect(calls).toContain('PUT /session/password');
    // The tab says Profile; the profile's own heading is for screen readers only.
    expect(screen.getByRole('heading', { name: 'Profile' }).className).toBe('sr-only');
  });

  it("a workspace's Access tab says it is for administrators to someone else (AFS-102)", async () => {
    routes = signedInAs(omar);
    window.history.replaceState(null, '', '/w/network/-/access');
    render(<App />);
    expect(await screen.findByText(/for administrators to see and change/)).toBeTruthy();
  });

  it('someone who is not an administrator is not offered Delete (AFS-100)', async () => {
    routes = {
      ...signedInAs(omar),
      'GET /projects/p1/access': () => ({ body: { workspace: 'rw', flows: [] } }),
    };
    window.history.replaceState(null, '', '/w/network/edge/settings');
    render(<App />);
    await screen.findByRole('heading', { name: 'Library' });
    expect(screen.queryByRole('heading', { name: 'Delete the project' })).toBeNull();
  });

  it("deletes a workspace from its Access tab; the server's refusal is shown (AFS-100)", async () => {
    routes = {
      ...signedInAs(dana),
      'DELETE /workspaces/w1': () => ({
        status: 409,
        body: {
          error: 'not_empty',
          message: 'The workspace still has projects: delete them first',
        },
      }),
    };
    window.history.replaceState(null, '', '/w/network/-/access');
    render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Delete the workspace' })).closest(
      'section',
    ) as HTMLElement;
    expect(section.classList.contains('danger-zone')).toBe(true);
    fireEvent.change(within(section).getByLabelText('Type network to confirm'), {
      target: { value: 'network' },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Delete the workspace' }));
    expect((await within(section).findByRole('alert')).textContent).toBe(
      'The workspace still has projects: delete them first',
    );
    expect(window.location.pathname).toBe('/w/network/-/access');
  });

  it("makes and deletes branches, and makes one the project's branch (AFS-59)", async () => {
    const asked: [string, unknown][] = [];
    const confirms: string[] = [];
    vi.stubGlobal('confirm', (text: string) => {
      confirms.push(text);
      return true;
    });
    routes = {
      ...signedInAs(dana),
      'POST /projects/p1/branches': (body) => {
        asked.push(['create', body]);
        return { status: 201, body: { name: 'feature/ntp', commit: edge.commit } };
      },
      'DELETE /projects/p1/branches?name=try%2Fidea&force=true': () => {
        asked.push(['delete', 'try/idea']);
        return { body: { name: 'try/idea', commit: edge.commit } };
      },
      'PATCH /projects/p1': (body) => {
        asked.push(['patch', body]);
        return { body: { ...edge, gitRef: 'try/idea' } };
      },
    };
    window.history.replaceState(null, '', '/w/network/edge/branches');
    render(<App />);
    const panel = (await screen.findByRole('heading', { name: 'Branches' })).closest(
      'section',
    ) as HTMLElement;
    // The branch that runs cannot be deleted from here.
    expect(screen.queryByRole('button', { name: 'Delete main' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete try/idea' }));
    await waitFor(() => expect(asked).toEqual([['delete', 'try/idea']]));
    expect(confirms[0]).toBe('Delete the branch try/idea? It has 2 commits not on main.');

    fireEvent.click(screen.getByRole('button', { name: "Make it the project's branch" }));
    await waitFor(() => expect(asked[1]).toEqual(['patch', { gitRef: 'try/idea' }]));

    fireEvent.click(screen.getByRole('button', { name: 'New branch' }));
    const name = screen.getByLabelText('Name', {
      selector: 'section[aria-labelledby=branches] input',
    });
    // AFS-192: a name git refuses is said at the field; the server is not asked.
    fireEvent.change(name, { target: { value: 'bad name..' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make the branch' }));
    expect(await screen.findByText(/A branch name is letters, digits/)).toBeTruthy();
    expect(asked).toHaveLength(2);
    fireEvent.change(name, { target: { value: 'feature/ntp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make the branch' }));
    await waitFor(() =>
      expect(asked[2]).toEqual(['create', { name: 'feature/ntp', from: 'main' }]),
    );
    expect(panel.isConnected).toBe(true);
  });

  it("lists a project's flows with their findings, and shows one on the designer's page", async () => {
    routes = signedInAs(dana);
    window.history.replaceState(null, '', '/w/network/edge');
    render(<App />);
    const link = await screen.findByRole('link', { name: /OS upgrade/ });
    expect(link.textContent).toContain('version 7');
    expect(link.textContent).toContain('12 steps');
    // Beside its findings, how its last run went, leading to that run.
    const row = link.closest('li') as HTMLElement;
    expect(row.textContent).toContain('2 warnings');
    const last = within(row).getByRole('link', { name: /last run/ });
    expect(last.textContent).toBe('last run failed');
    expect(last.getAttribute('href')).toBe('/runs/r41');
    // A flow the server cannot read is listed with the reason, and is not a link.
    expect(screen.getByText(/Upgrade the server/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /broken/ })).toBeNull();
    // AFS-153: a flow with no step is not shown as healthy.
    const blank = (screen.getByRole('link', { name: /Blank/ }).closest('li') as HTMLElement)
      .textContent;
    expect(blank).toContain('no steps yet');
    expect(blank).not.toContain('no findings');

    fireEvent.click(link);
    await screen.findByRole('heading', { name: 'OS upgrade' });
    expect(window.location.pathname).toBe('/w/network/edge/flow/flows/os-upgrade.flow.yaml');
    const frame = (await screen.findByTitle(/OS upgrade on the designer/)) as HTMLIFrameElement;
    const src = new URL(frame.src);
    expect(src.pathname).toBe('/viewer.html');
    expect(Object.fromEntries(src.searchParams)).toEqual({
      project: 'p1',
      path: 'flows/os-upgrade.flow.yaml',
      theme: 'dark',
    });
    expect(document.querySelector('.flow-line')?.textContent).toContain(
      'main at 9f2c1e7ab3d4 · read only',
    );
    // The designer follows the theme the person chose.
    fireEvent.click(screen.getByRole('button', { name: 'Theme: dark' }));
    await waitFor(() =>
      expect(
        new URL(
          (screen.getByTitle(/OS upgrade on the designer/) as HTMLIFrameElement).src,
        ).searchParams.get('theme'),
      ).toBe('light'),
    );
    // AFS-107: the breadcrumbs are in the top bar, beside the search box. AFS-194: the flow by
    // its title, its file in the tooltip.
    const crumbs = document.querySelector('.bar nav[aria-label="Breadcrumb"]');
    expect(crumbs?.textContent).toMatch(/ \/ OS upgrade$/);
    expect(crumbs?.querySelector('[aria-current="page"]')?.getAttribute('title')).toBe(
      'flows/os-upgrade.flow.yaml',
    );
    // Full screen and its own page are icon buttons with their names.
    const canvas = screen.getByTitle(/OS upgrade on the designer/) as HTMLIFrameElement;
    // AFS-114: the canvas with what opens over it (the library picker) goes full screen.
    const stage = canvas.parentElement as HTMLElement;
    expect(stage.className).toBe('flow-stage');
    const asked: Element[] = [];
    stage.requestFullscreen = async function (this: Element) {
      asked.push(this);
    } as never;
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(asked).toEqual([stage]);
    expect(screen.getByRole('link', { name: 'Open on its own page' }).getAttribute('href')).toMatch(
      /^\/viewer\.html\?project=p1&path=flows%2Fos-upgrade\.flow\.yaml/,
    );
  });

  it('says which flows someone changed on the branch while the page is open', async () => {
    // A stand-in for the browser's EventSource: the test plays the server's events.
    const streams: { url: string; on: Record<string, (e: MessageEvent) => void> }[] = [];
    vi.stubGlobal(
      'EventSource',
      class {
        on: Record<string, (e: MessageEvent) => void> = {};
        constructor(readonly url: string) {
          streams.push(this);
        }
        addEventListener(kind: string, listener: (e: MessageEvent) => void) {
          this.on[kind] = listener;
        }
        close() {}
      },
    );
    const next = '41d7a0c93be2f5681a0c4e7d9b3f2a6c8e1d0b57';
    routes = {
      ...signedInAs(dana),
      [`GET /projects/p1/changes?from=${edge.commit}&to=${next}`]: () => ({
        body: {
          from: edge.commit,
          to: next,
          flows: [
            { file: 'flows/os-upgrade.flow.yaml', change: 'changed', authors: ['Mia Ortega'] },
            { file: 'old/broken.flow.yaml', change: 'removed', authors: ['Omar Haddad'] },
          ],
        },
      }),
    };
    window.history.replaceState(null, '', '/w/network/edge');
    render(<App />);
    await screen.findByRole('link', { name: /OS upgrade/ });
    const stream = streams.find((s) => s.url === '/api/v1/projects/p1/events');
    expect(stream).toBeTruthy();
    stream?.on.moved?.({ data: JSON.stringify({ from: edge.commit, to: next }) } as MessageEvent);
    const news = await screen.findByText(/Changed on the branch just now/);
    const box = news.closest('.notice') as HTMLElement;
    expect(box.textContent).toContain('flows/os-upgrade.flow.yaml changed by Mia Ortega');
    expect(box.textContent).toContain('old/broken.flow.yaml removed by Omar Haddad');
    // The list is read again for the new commit.
    await waitFor(() =>
      expect(calls.filter((c) => c === 'GET /workspaces/network/projects').length).toBeGreaterThan(
        1,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Changed on the branch just now/)).toBeNull();
  });

  it('edits a flow in the pages: the draft, who is there, a Save the branch stands in the way of (AFS-76)', async () => {
    const file = 'flows/os-upgrade.flow.yaml';
    const draft = {
      id: 'd1',
      project: 'p1',
      file,
      baseCommit: edge.commit,
      revision: 0,
      createdAt: '2026-11-15T09:00:00.000Z',
      updatedAt: '2026-11-15T09:00:00.000Z',
      editors: [],
    };
    let saves = 0;
    routes = {
      ...signedInAs(omar),
      'GET /projects/p1/access': () => ({
        body: { admin: false, workspace: 'ro', approve: false, flows: { [file]: 'rw' } },
      }),
      'GET /projects/p1/drafts': () => ({ body: [] }),
      [`POST /projects/p1/drafts?path=${encodeURIComponent(file)}`]: () => ({
        status: 201,
        body: draft,
      }),
      'POST /drafts/d1/save': (body) => {
        saves++;
        // AFS-149: the side kept at each clashing place.
        return (body as { choices?: Record<string, string> }).choices?.['node:x:title'] === 'draft'
          ? { body: { commit: '41d7a0c93be2f5681a0c4e7d9b3f2a6c8e1d0b57' } }
          : {
              status: 409,
              body: {
                error: 'conflict',
                message: 'The branch changed the same places since the draft began',
                conflicts: [{ id: 'node:x:title', label: 'Upgrade: title' }],
              },
            };
      },
    };
    window.history.replaceState(null, '', `/w/network/edge/flow/${file}`);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByRole('button', { name: 'Stop editing' });
    const frame = screen.getByTitle(/on the designer/) as HTMLIFrameElement;
    expect(new URL(frame.src).searchParams.get('draft')).toBe('d1');
    // The frame says who is there and what the others changed.
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        // The list has the person looking too (AFS-136: not named as someone else).
        data: {
          type: 'afs-draft-people',
          people: [
            { login: omar.login, name: omar.name },
            { login: 'mia', name: 'Mia Ortega' },
          ],
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'afs-draft-edit', by: 'Mia Ortega', steps: ['Pre-checks'] },
      }),
    );
    // AFS-165: with someone else in the draft, the line about the others shows.
    const bar = await screen.findByRole('region', { name: 'Editing together' });
    await waitFor(() => expect(bar.textContent).toContain('Here now: you, Mia Ortega'));
    expect(bar.textContent).toContain('Mia Ortega changed Pre-checks');
    // AFS-165: Save asks for the commit's message.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    type("What changed (the commit's message)", 'Safer pre-checks');
    // AFS-136: with Mia here, Save names her first.
    const asked: string[] = [];
    window.confirm = (text?: string) => {
      asked.push(String(text));
      return true;
    };
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Save the draft' })).getByRole('button', {
        name: 'Save',
      }),
    );
    expect(await screen.findByText('Upgrade: title')).toBeTruthy();
    expect(asked[0]).toMatch(/^Mia Ortega is editing this draft too/);
    fireEvent.click(screen.getByRole('button', { name: 'Save with these' }));
    expect((await screen.findByText(/Saved as/)).textContent).toBe('Saved as 41d7a0c93be2.');
    expect(saves).toBe(2);
    expect(screen.queryByRole('button', { name: 'Stop editing' })).toBeNull();
  });

  it('a hosted project that is empty says to push; a project that is not there says so', async () => {
    routes = {
      ...signedInAs(omar),
      // ro on the workspace: the git panel is for who may clone.
      'GET /projects/p2/access': () => ({
        body: { admin: false, workspace: 'ro', approve: false, flows: {} },
      }),
      'GET /session/access': () => ({
        body: {
          admin: false,
          administrators: ['Dana Admin'],
          workspaces: [
            {
              workspace: { id: network.id, key: 'network', name: network.name },
              level: 'ro',
              approve: false,
              flows: [],
              through: ['user:omar'],
            },
          ],
        },
      }),
    };
    window.history.replaceState(null, '', '/w/network/lab/settings');
    render(<App />);
    await screen.findByRole('heading', { name: 'Lab' });
    expect(
      await screen.findByText(/The repository is empty: push a first commit to main/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Look at the source now' })).toBeNull();
    navigate('/w/network/nothing');
    // AFS-143: says what was looked for.
    await screen.findByRole('heading', { name: 'Not found' });
    // AFS-152: back to the workspace by its name; with a level on it, every project shows, so one
    // not listed does not exist (no advice to ask for access).
    expect(await screen.findByRole('link', { name: 'Back to Network team' })).toBeTruthy();
    expect(await screen.findByText(/does not exist/)).toBeTruthy();
    expect(screen.queryByText(/An administrator gives access/)).toBeNull();
  });

  it('starts an empty hosted project from a sample, and makes one from a sample (AFS-58)', async () => {
    const samples = [
      { key: 'hello', name: 'Hello, Ansible', description: 'The smallest useful flow.' },
      { key: 'edge-baseline', name: 'Edge baseline', description: 'NTP, AAA and syslog.' },
    ];
    let started = false;
    const sent: unknown[] = [];
    routes = {
      ...signedInAs(dana),
      'GET /workspaces/network/projects': () => ({
        body: [edge, started ? { ...lab, commit: 'a'.repeat(40), sync: { state: 'ok' } } : lab],
      }),
      'GET /samples': () => ({ body: samples }),
      'GET /projects/p2/branches': () => ({
        body: started
          ? { branches: ['main'], details: [{ name: 'main', commit: 'a'.repeat(40) }] }
          : { branches: [], details: [] },
      }),
      // AFS-192: the sample brings a launch configuration: the note names it, the list shows it.
      'GET /projects/p2/launch-configs': () => ({
        body: started
          ? [
              {
                id: 'c9',
                project: 'p2',
                name: 'Edge switches (simulated)',
                flowFile: 'flows/edge/edge.flow.yaml',
                mode: 'check',
                inputs: {},
                createdAt: '2026-11-13T10:00:00.000Z',
                updatedAt: '2026-11-13T10:00:00.000Z',
              },
            ]
          : [],
      }),
      'GET /projects/p2/files?branch=main': () => ({
        body: {
          branch: 'main',
          commit: 'a'.repeat(40),
          files: [
            { path: 'flows/edge/edge.flow.yaml', size: 9 },
            { path: 'README.md', size: 9 },
          ],
        },
      }),
      'POST /projects/p2/start': (body) => {
        sent.push(body);
        started = true;
        return { status: 201, body: { ...lab, commit: 'a'.repeat(40) } };
      },
      'POST /workspaces/network/projects': (body) => {
        sent.push(body);
        return { status: 201, body: { ...lab, id: 'p3', key: 'try' } };
      },
    };
    window.history.replaceState(null, '', '/w/network/lab');
    render(<App />);
    await screen.findByRole('heading', { name: 'Start this project' });
    // AFS-159: files go in before the first flow: the Files tab is there, and the start says so.
    expect(
      within(screen.getByRole('navigation', { name: 'Project' }))
        .getByRole('link', { name: 'Files' })
        .getAttribute('href'),
    ).toBe('/w/network/lab/files');
    expect(document.querySelector('[data-own-playbooks]')?.textContent).toMatch(
      /Add them in Files .* then make a New flow and start it from one/,
    );
    // Nothing to choose "start empty" from: it is empty already.
    expect(screen.queryByLabelText(/Nothing: the first push/)).toBeNull();
    await screen.findByText('The smallest useful flow.');
    fireEvent.change(screen.getByLabelText('Sample'), { target: { value: 'edge-baseline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Start this project' })).toBeNull(),
    );
    expect(sent).toEqual([{ sample: 'edge-baseline' }]);
    expect(
      await screen.findByText(
        'The project has started: 2 files, 1 flow, and the launch configuration Edge switches (simulated).',
      ),
    ).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Edge switches (simulated)' })).toBeTruthy();
    // AFS-139: the Branches tab counts the branch the start made, with no reload.
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /Branches/ }).textContent).toMatch(/1/),
    );

    navigate('/w/network');
    fireEvent.click(await screen.findByRole('button', { name: 'Add project' }));
    type('Name', 'Try it: Edge #2');
    fireEvent.click(screen.getByLabelText('A sample project'));
    await screen.findByText('The smallest useful flow.');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({ key: 'try-it-edge-2', name: 'Try it: Edge #2', sample: 'hello' });
  });

  it('AFS-140: Add project makes a readable key, says a refusal at its field, and keeps typing', async () => {
    const sent: unknown[] = [];
    const checked: unknown[] = [];
    routes = {
      ...signedInAs(dana),
      'GET /workspaces/network/projects': () => ({ body: [edge, lab] }),
      'GET /samples': () => ({ body: [] }),
      'POST /workspaces/network/projects/check': (body) => {
        checked.push(body);
        return { body: { ok: false, message: 'Could not resolve host: git.invalid.example' } };
      },
      'POST /workspaces/network/projects': (body) => {
        sent.push(body);
        return sent.length === 1
          ? {
              status: 409,
              body: {
                error: 'taken',
                message: 'The workspace has a project edge already',
                field: 'key',
              },
            }
          : {
              status: 201,
              body: {
                ...lab,
                id: 'p9',
                key: 'mirror',
                hosted: false,
                gitUrl: 'https://git.invalid.example/a10/x.git',
                sync: { state: 'error', error: 'fatal: unable to access the address' },
              },
            };
      },
    };
    window.history.replaceState(null, '', '/w/network');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add project' }));
    const name = screen.getByLabelText('Name') as HTMLInputElement;
    // The form opened takes the cursor, and a name has a limit the field keeps.
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(name.maxLength).toBe(200);
    type('Name', 'a10 Ünïcödé 🚀 "quoted" / slash');
    const key = screen.getByLabelText('Key') as HTMLInputElement;
    expect(key.value).toBe('a10-unicode-quoted-slash');
    type('Name', `datacenter refresh ${'wave '.repeat(14)}`);
    expect(key.value.length).toBeLessThanOrEqual(60);
    expect(key.value.endsWith('-wave')).toBe(true);

    type('Key', 'edge');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(key.getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByText('The workspace has a project edge already')).toBeTruthy();
    // Changing the key takes the refusal away.
    type('Key', 'mirror');
    expect(screen.queryByText('The workspace has a project edge already')).toBeNull();

    // Leaving with typing not sent asks first; staying keeps it.
    vi.stubGlobal('confirm', () => false);
    fireEvent.click(screen.getByRole('link', { name: 'Execution environments' }));
    expect(window.location.pathname).toBe('/w/network');
    expect((screen.getByLabelText('Key') as HTMLInputElement).value).toBe('mirror');

    // AFS-171: an existing repository is read first; one that cannot be read is said at its
    // address, and nothing is added until Add anyway.
    fireEvent.click(screen.getByLabelText('An existing repository'));
    type('Repository address', 'https://git.invalid.example/a10/x.git');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const address = screen.getByLabelText('Repository address');
    await waitFor(() => expect(address.getAttribute('aria-invalid')).toBe('true'));
    expect(
      screen.getByText(
        "The repository cannot be read: Could not resolve host: git.invalid.example. Check the address and the credential, or Add anyway and fix it on the project's Settings.",
      ),
    ).toBeTruthy();
    expect(checked).toEqual([{ gitUrl: 'https://git.invalid.example/a10/x.git' }]);
    expect(sent).toHaveLength(1);
    // Added anyway: it is said at once, on Settings, where its address can change.
    fireEvent.click(screen.getByRole('button', { name: 'Add anyway' }));
    await waitFor(() => expect(window.location.pathname).toBe('/w/network/mirror/settings'));
    expect(checked).toHaveLength(1);
  });

  it('makes an access token for one workspace, shows it once, and lists what it has', async () => {
    const made = {
      id: 't1',
      name: 'laptop git',
      hint: 'Xk3Q',
      readOnly: true,
      workspace: network.id,
      createdAt: '2026-11-13T09:44:37.512Z',
      expiresAt: '2026-12-13T09:44:37.512Z',
    };
    let have: unknown[] = [];
    routes = {
      ...signedInAs(omar),
      'GET /tokens': () => ({ body: have }),
      'POST /tokens': (body) => {
        expect(body).toEqual({
          name: 'laptop git',
          expiresInDays: 30,
          readOnly: true,
          workspace: network.id,
        });
        have = [made];
        return { status: 201, body: { ...made, token: `afs_${'A'.repeat(43)}` } };
      },
    };
    window.history.replaceState(null, '', '/account/tokens');
    render(<App />);
    await screen.findByText('You have no token.');
    // AFS-88: the form is opened when wanted.
    fireEvent.click(screen.getByRole('button', { name: 'Make a token' }));
    type('Name', 'laptop git');
    type('Days until it expires', '30');
    fireEvent.click(screen.getByLabelText(/Read only/));
    await screen.findByRole('option', { name: /only Network team/ });
    fireEvent.change(screen.getByLabelText('Reaches'), { target: { value: network.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Make token' }));
    expect((await screen.findByRole('status')).textContent).toContain(`afs_${'A'.repeat(43)}`);
    await screen.findByText('…Xk3Q');
    // AFS-152: by its name, as the form names it.
    expect(screen.getByRole('cell', { name: network.name })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'API reference' }).getAttribute('href')).toBe(
      '/docs/api',
    );
    fireEvent.click(screen.getByRole('button', { name: 'I have copied it' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.body.textContent).not.toContain('afs_AAAA');
  });

  it('shows sign-in again when the server says the session has ended', async () => {
    routes = signedInAs(dana);
    render(<App />);
    const [link] = await screen.findAllByRole('link', { name: /Network team/ });
    routes['GET /workspaces/network'] = () => ({
      status: 401,
      body: { error: 'unauthorized', message: 'Sign in first' },
    });
    fireEvent.click(link as HTMLElement);
    await screen.findByRole('heading', { name: 'Sign in to Ansible Flow Server' });
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it('signs out, and the theme button goes round: dark, light, device', async () => {
    routes = { ...signedInAs(dana), 'DELETE /session': () => ({ status: 204 }) };
    render(<App />);
    await screen.findAllByRole('link', { name: /Network team/ });
    const root = document.documentElement;
    // Dark unless the person chose otherwise (AFS-64).
    expect(root.dataset.theme).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: 'Theme: dark' }));
    await waitFor(() => expect(root.dataset.theme).toBe('light'));
    expect(window.localStorage.getItem('afs.theme')).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: 'Theme: light' }));
    await waitFor(() => expect(root.dataset.theme).toBeUndefined());
    expect(window.localStorage.getItem('afs.theme')).toBe('system');
    fireEvent.click(screen.getByRole('button', { name: 'Theme: as the device' }));
    await waitFor(() => expect(root.dataset.theme).toBe('dark'));
    expect(window.localStorage.getItem('afs.theme')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in to Ansible Flow Server' });
    expect(calls).toContain('DELETE /session');
  });
});

describe('AFS-152: one own access, in words', () => {
  const nora = { ...omar, id: 'u5', login: 'nora', name: 'Nora Lind' };
  const noraAccess = {
    admin: false,
    administrators: ['Dana Whitfield'],
    workspaces: [
      {
        workspace: { id: network.id, key: 'network', name: network.name },
        level: 'ro',
        approve: false,
        flows: [
          {
            project: 'edge',
            projectId: 'p1',
            file: 'flows/os-upgrade.flow.yaml',
            level: 'operator',
          },
        ],
        through: ['group:ops', 'user:nora'],
      },
    ],
  };

  it('a project says read only on the workspace and operator on one flow, on every tab', async () => {
    routes = {
      ...signedInAs(nora),
      'GET /projects/p1/access': () => ({
        body: {
          admin: false,
          workspace: 'ro',
          approve: false,
          flows: { 'flows/os-upgrade.flow.yaml': 'operator', 'old/broken.flow.yaml': 'ro' },
        },
      }),
      'GET /projects/p1/files?branch=main': () => ({ body: { commit: edge.commit, files: [] } }),
    };
    window.history.replaceState(null, '', '/w/network/edge');
    render(<App />);
    const line = 'Your access: read only (sees flows and runs, clones); operator on OS upgrade';
    expect((await screen.findByText(/^Your access:/)).textContent).toBe(line);
    navigate('/w/network/edge/files');
    await waitFor(() => expect(screen.getByText(/^Your access:/).textContent).toBe(line));
    expect(document.body.textContent).not.toMatch(/\bro:/);
  });

  it('My account lists the access workspace by workspace, flows by title', async () => {
    routes = { ...signedInAs(nora), 'GET /session/access': () => ({ body: noraAccess }) };
    window.history.replaceState(null, '', '/account');
    render(<App />);
    const panel = (await screen.findByRole('heading', { name: 'Your access' })).closest(
      'section',
    ) as HTMLElement;
    await waitFor(() =>
      expect(panel.textContent).toContain(
        'Network team: read only (sees flows and runs, clones); operator on OS upgrade',
      ),
    );
    expect(panel.textContent).toContain('Through group ops, your own grant');
    expect(panel.textContent).toContain('Dana Whitfield');
  });

  it('who has no workspace is told whom to ask, and not where runs start', async () => {
    routes = {
      ...signedInAs(nora),
      'GET /workspaces': () => ({ body: [] }),
      'GET /runs?limit=100': () => ({ body: [] }),
      'GET /approvals': () => ({ body: [] }),
      'GET /session/access': () => ({
        body: { admin: false, administrators: ['Dana Whitfield'], workspaces: [] },
      }),
    };
    render(<App />);
    expect(
      await screen.findByText(
        'You have no access to a workspace yet: ask an administrator for it (Dana Whitfield).',
      ),
    ).toBeTruthy();
    expect(screen.getByText('No run yet.')).toBeTruthy();
    // No empty Workspaces heading in the side menu.
    expect(screen.queryByRole('navigation', { name: 'Workspaces' })).toBeNull();
  });
});
