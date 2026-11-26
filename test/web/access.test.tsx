// The Access panel of a workspace, with the server played by the test: who can do what as a
// matrix (AFS-273), giving a grant on a flow, taking one back and changing a level from a row's
// menu, asked in the row.
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
  // AFS-273: a removal is asked in its row, never in the browser's dialog.
  window.confirm = () => {
    throw new Error('asked in a dialog');
  };
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
          flows: [
            { project: 'edge', projectId: 'p1', file: 'flows/upgrade.flow.yaml', level: 'ro' },
          ],
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
    'POST /workspaces/network/grants': () => {
      const made = {
        ...grant,
        id: 'g2',
        principal: { type: 'user', id: 'u2', name: 'omar' },
        level: 'ro',
        flow: { project: 'p1', projectKey: 'edge', file: 'flows/upgrade.flow.yaml' },
      };
      grants = [...grants, made];
      return { status: 201, body: made };
    },
    'DELETE /grants/g2': () => {
      grants = grants.filter((g) => (g as { id: string }).id !== 'g2');
      return { status: 204 };
    },
    'DELETE /grants/g1': () => {
      grants = grants.filter((g) => (g as { id: string }).id !== 'g1');
      return { status: 204 };
    },
    'PATCH /grants/g1': (body) => {
      grants = grants.map((g) =>
        (g as { id: string }).id === 'g1' ? { ...g, ...(body as object) } : g,
      );
      return { body: grants.find((g) => (g as { id: string }).id === 'g1') };
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
  const open = async () => {
    // AFS-84: access is a tab of the workspace.
    window.history.replaceState(null, '', '/w/network/-/access');
    render(<App />);
    return (await screen.findByRole('heading', { name: 'Access' })).closest(
      'section',
    ) as HTMLElement;
  };
  /** A matrix row's cells, as their words say them (what a screen reader hears). */
  const rowWords = (row: HTMLElement) =>
    [...row.querySelectorAll('td')].map((td) => td.textContent?.trim());

  it('says who can do what as a matrix: given here, through a group, or with a higher level', async () => {
    const panel = await open();
    const matrix = await within(panel).findByRole('table', { name: /^Who can do what/ });
    const heads = [...matrix.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(heads).toEqual([
      'Person or group',
      'Read',
      'Operate',
      'Edit',
      'Approve',
      'Through',
      'More',
    ]);
    const [group, omar] = within(matrix).getAllByRole('row').slice(1) as HTMLElement[];
    expect(rowWords(group as HTMLElement).slice(0, 6)).toEqual([
      'net-ops group · 1 person',
      'Read: comes with Edit',
      'Operate: comes with Edit',
      'Edit: given here',
      'Approve: no',
      'given here',
    ]);
    // Omar's Edit comes through the group; his grant on one flow is said where it comes from.
    expect(rowWords(omar as HTMLElement).slice(0, 6)).toEqual([
      'Omar Haddad omar',
      'Read: comes with Edit',
      'Operate: comes with Edit',
      'Edit: through net-ops',
      'Approve: no',
      'net-ops · read only on 1 flow',
    ]);
    // The marks are drawn: the words are for who does not see them, and on hover.
    expect(omar?.querySelector('[data-mark="group"]')?.getAttribute('title')).toBe(
      'Edit: through net-ops',
    );
    // Omar has no grant of his own on the workspace: his row has nothing to take back.
    expect(within(omar as HTMLElement).queryByRole('button')).toBeNull();
    // One main button: Give access, in the table's title bar.
    expect(within(panel).getByRole('button', { name: 'Give access' }).className).toBe('primary');
  });

  it('gives a grant on a flow, and takes it back from its row, asked in the row', async () => {
    const panel = await open();
    await within(panel).findByRole('table', { name: /^Who can do what/ });
    fireEvent.click(within(panel).getByRole('button', { name: 'Give access' }));
    fireEvent.change(within(panel).getByLabelText('Who'), { target: { value: 'user:u2' } });
    // Groups are marked as groups among the people.
    expect(within(panel).getByRole('option', { name: 'group net-ops' })).toBeTruthy();
    fireEvent.click(within(panel).getByLabelText(/^Read only:/));
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
    // AFS-152: what was given is said, the form starts again, the flow is named by its title.
    expect((await within(panel).findByText(/^Gave Omar Haddad/)).textContent).toBe(
      'Gave Omar Haddad (omar) read only on the flow Firewall upgrade in Edge.',
    );
    expect((within(panel).getByLabelText('Who') as HTMLSelectElement).value).toBe('');
    // A grant on one flow is an exception: what it gives, and what it replaces there.
    const flows = await within(panel).findByRole('table', { name: /^Exceptions on single flows/ });
    expect(rowWords(within(flows).getAllByRole('row')[1] as HTMLElement).slice(0, 4)).toEqual([
      'Firewall upgrade in Edge',
      'Omar Haddad (omar)',
      'read only',
      'read and write, from the workspace',
    ]);

    // Take back is a row's lesser action: in its menu, asked in the row.
    fireEvent.click(
      within(flows).getByRole('button', {
        name: 'More for Omar Haddad (omar) on Firewall upgrade',
      }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Take back read only…' }));
    const question = within(flows).getByRole('group');
    // AFS-194: the question says what the person keeps.
    expect(question.querySelector('legend')?.textContent).toBe(
      'Take back read only on the flow Firewall upgrade in Edge from Omar Haddad (omar)? It ends at once. They keep read and write on the whole workspace through group net-ops.',
    );
    const yes = within(question).getByRole('button', { name: 'Take back' });
    // The answer takes the focus: the keyboard is where the question is.
    expect(document.activeElement).toBe(yes);
    fireEvent.click(yes);
    // A note says it is done, as Give does.
    expect(
      (await within(panel).findByText(/^Took back read only on the flow Firewall upgrade/))
        .textContent,
    ).toBe(
      'Took back read only on the flow Firewall upgrade in Edge from Omar Haddad (omar). They keep read and write on the whole workspace through group net-ops.',
    );
    expect(asked.some((a) => a.key === 'DELETE /grants/g2')).toBe(true);
  });

  it("changes a group's level in place, and Escape asks nothing", async () => {
    const panel = await open();
    const matrix = await within(panel).findByRole('table', { name: /^Who can do what/ });
    const more = within(matrix).getByRole('button', { name: 'More for group net-ops' });
    fireEvent.click(more);
    const menu = screen.getByRole('menu', { name: 'More for group net-ops' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Change the level…', 'Take back read and write…']);
    // The keyboard moves in the menu, and Escape gives the focus back to its button.
    expect(document.activeElement?.textContent).toBe('Change the level…');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Take back read and write…');
    fireEvent.click(document.activeElement as HTMLElement);
    const asking = within(matrix).getByRole('group');
    fireEvent.keyDown(within(asking).getByRole('button', { name: 'Take back' }), { key: 'Escape' });
    expect(within(matrix).queryByRole('group')).toBeNull();
    expect(asked.some((a) => a.key === 'DELETE /grants/g1')).toBe(false);

    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change the level…' }));
    const change = within(matrix).getByRole('group');
    // The level it has now is chosen, and has the focus.
    const now = within(change).getByLabelText(/^Read and write:/) as HTMLInputElement;
    expect(now.checked).toBe(true);
    expect(document.activeElement).toBe(now);
    fireEvent.click(within(change).getByLabelText(/^Operator:/));
    fireEvent.click(within(change).getByRole('button', { name: 'Change' }));
    await waitFor(() =>
      expect(asked.find((a) => a.key === 'PATCH /grants/g1')?.body).toEqual({ level: 'operator' }),
    );
    expect(
      await within(panel).findByText('group net-ops now has operator on the whole workspace.'),
    ).toBeTruthy();
    // The matrix reads the grants again.
    await waitFor(() =>
      expect(rowWords(within(matrix).getAllByRole('row')[1] as HTMLElement).slice(1, 4)).toEqual([
        'Read: comes with Operate',
        'Operate: given here',
        'Edit: no',
      ]),
    );
  });
});
