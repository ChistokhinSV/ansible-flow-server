// Editing a flow's draft on its page (AFS-149), with the server played by the test: a save the
// branch's changes clash with shows both values per place and keeps the side picked; the draft's
// notes lie over the canvas and the activity line is there before the first edit; a save says
// its commit and co-authors, and one made in another tab of the same person says "you"; one
// Discard question names whose edits go.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discardQuestion, FlowPage } from '../../src/web/flow';

const COMMIT = '9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b';
const SAVED = '269d7e7326b8aa1b2c3d4e5f60718293a4b5c6d7';
const FILE = 'flows/upgrade.flow.yaml';
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
const flow = { file: FILE, key: 'upgrade', name: 'Firewall upgrade', version: 3 };
const draft = {
  id: 'd1',
  project: 'p1',
  file: FILE,
  baseCommit: COMMIT,
  revision: 0,
  createdAt: '2026-11-18T10:00:00.000Z',
  updatedAt: '2026-11-18T10:00:00.000Z',
  editors: [],
};

let bodies: Record<string, unknown[]>;
let routes: Record<string, (body: unknown) => { status?: number; body?: unknown }>;
beforeEach(() => {
  bodies = {};
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    bodies[key] = [...(bodies[key] ?? []), body];
    const answer = routes[key]?.(body) ?? {
      status: 404,
      body: { error: 'not_found', message: `Nothing at ${key}` },
    };
    const status = answer.status ?? 200;
    return { ok: status < 300, status, json: async () => answer.body } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const base = () => ({
  'GET /workspaces/net/projects': () => ({ body: [project] }),
  'GET /projects/p1/flows': () => ({ body: { flows: [flow] } }),
  'GET /projects/p1/drafts': () => ({ body: [] }),
  'GET /projects/p1/access': () => ({
    body: { admin: false, workspace: 'rw', approve: false, flows: { [FILE]: 'rw' } },
  }),
  'GET /projects/p1/launch-configs': () => ({ body: [] }),
  'GET /runs?project=p1&flow=flows%2Fupgrade.flow.yaml&limit=3': () => ({ body: [] }),
  'POST /projects/p1/drafts?path=flows%2Fupgrade.flow.yaml': () => ({ body: draft }),
});
const tell = (data: unknown) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin: window.location.origin }));
  });
const editing = async () => {
  render(
    <FlowPage
      me={{ login: 'dana', name: 'Dana Whitfield' }}
      workspace="net"
      project="core"
      file={FILE}
      theme="dark"
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  await screen.findByRole('region', { name: 'Editing' });
};

describe("a flow's draft on its page (AFS-149)", () => {
  it('shows both values of each clash over the canvas and saves the side picked per place', async () => {
    const clashes = [
      { id: 'c1', label: 'Rollback: title', draft: 'Rollback (a3 draft)', branch: 'Roll back' },
      { id: 'c2', label: 'Ping: settings.timeout', draft: '30', branch: null },
    ];
    routes = {
      ...base(),
      'POST /drafts/d1/save': (body) =>
        (body as { choices?: unknown }).choices
          ? { body: { commit: SAVED, coAuthors: ['Mia Ortega'] } }
          : {
              body: {
                saved: false,
                message: 'The branch changed the same places',
                conflicts: clashes,
              },
            },
    };
    await editing();
    // The activity line is there before anyone changed anything: its first edit moves nothing.
    expect(document.querySelector('.draft-edits')?.textContent).toMatch(/others change/);
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Editing' })).getByRole('button', { name: 'Save' }),
    );
    const note = await screen.findByRole('alert');
    // Over the canvas, not above it.
    expect(note.closest('.flow-stage')).toBeTruthy();
    expect(note.textContent).toContain('Rollback (a3 draft)');
    expect(note.textContent).toContain('Roll back');
    expect(note.textContent).toContain('removed or not set');
    // The tab and "answer conflicts" go with every save from the page: no 409 in the console.
    expect(bodies['POST /drafts/d1/save']?.[0]).toMatchObject({ answerConflicts: true });
    expect(bodies['POST /drafts/d1/save']?.[0]).toMatchObject({ tab: expect.any(String) });
    fireEvent.click(within(note).getAllByRole('radio', { name: /The branch’s/ })[0] as HTMLElement);
    fireEvent.click(within(note).getByRole('button', { name: 'Save with these' }));
    const said = await screen.findByText(/Saved as/);
    expect(bodies['POST /drafts/d1/save']?.[1]).toMatchObject({
      choices: { c1: 'branch', c2: 'draft' },
    });
    expect(said.textContent).toContain('with Mia Ortega as co-authors');
    const link = within(said).getByRole('link');
    expect(link.getAttribute('href')).toContain(`commit=${SAVED}`);
    expect(link.textContent).toBe(SAVED.slice(0, 12));
  });

  it('names what others did on one line, and the earlier ones open on asking', async () => {
    routes = base();
    await editing();
    tell({ type: 'afs-draft-edit', by: 'Mia Ortega', steps: ['a2 ping'], what: 'removed a2 ping' });
    tell({
      type: 'afs-draft-edit',
      by: 'Mia Ortega',
      steps: ['Backup'],
      what: 'changed Backup (timeout)',
    });
    const line = document.querySelector('.draft-edits') as HTMLElement;
    expect(line.textContent).toContain('Mia Ortega changed Backup (timeout)');
    fireEvent.click(within(line).getByRole('button', { name: '1 earlier' }));
    expect(within(line).getByRole('list').textContent).toContain('Mia Ortega removed a2 ping');
  });

  it('says "you" for a save made in another tab of the same person, with its commit', async () => {
    routes = base();
    await editing();
    tell({ type: 'afs-draft-saving', by: 'Dana Whitfield', sent: true, mine: true });
    expect(
      await screen.findByText(
        'You are saving the draft in another tab: what you were typing here is in it.',
      ),
    ).toBeTruthy();
    tell({
      type: 'afs-draft-saved',
      by: 'Dana Whitfield',
      mine: true,
      commit: SAVED,
      coAuthors: [],
    });
    const said = await screen.findByText(/You saved the draft in another tab/);
    expect(said.textContent).not.toContain('Dana Whitfield');
    expect(said.textContent).toContain('What you were typing here is in it.');
    expect(within(said).getByRole('link').textContent).toBe(SAVED.slice(0, 12));
    expect(screen.queryByRole('region', { name: 'Editing' })).toBeNull();
  });

  it('asks one Discard question naming whose edits go', () => {
    expect(
      discardQuestion(
        [
          { login: 'mia', name: 'Mia Ortega' },
          { login: 'dana', name: 'Dana Whitfield' },
          { login: 'mia', name: 'Mia Ortega' },
        ],
        'dana',
      ),
    ).toBe(
      'Discard the draft for everyone? It cannot be undone: the unsaved edits by you and Mia Ortega go.',
    );
    expect(discardQuestion([], 'dana')).toBe(
      'Discard the draft for everyone? It cannot be undone: nobody has changed it yet.',
    );
  });
});
