// Editing a flow's draft on its page (AFS-149), with the server played by the test: a save the
// branch's changes clash with shows both values per place and keeps the side picked; the draft's
// notes lie over the canvas and the activity line is there before the first edit; a save says
// its commit and co-authors, and one made in another tab of the same person says "you"; one
// Discard question names whose edits go. AFS-165: one person editing has the canvas right under the
// head (no line about others, no message field: Save asks for it; the commit is behind "i").
// AFS-166: Ctrl+S saves the draft, from the page and from the designer's frame. AFS-164: `?step=`
// selects a step on the canvas.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discardQuestion, FlowPage } from '../../src/web/flow';
import { listenForSaveKey, SAVE_KEY } from '../../src/web/saveKey';

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
let stopKeys: () => void;
beforeEach(() => {
  stopKeys = listenForSaveKey();
});
afterEach(() => {
  stopKeys();
  window.history.replaceState(null, '', '/');
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
  await screen.findByRole('button', { name: 'Stop editing' });
};
const saveForm = () => screen.getByRole('form', { name: 'Save the draft' });

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
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.change(within(saveForm()).getByLabelText("What changed (the commit's message)"), {
      target: { value: 'Safer rollback' },
    });
    fireEvent.click(within(saveForm()).getByRole('button', { name: 'Save' }));
    const note = await screen.findByRole('alert');
    // AFS-165: the message asked for goes with the save.
    expect(bodies['POST /drafts/d1/save']?.[0]).toMatchObject({ message: 'Safer rollback' });
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
    expect(screen.queryByRole('button', { name: 'Stop editing' })).toBeNull();
  });

  it('puts the canvas under the head for one person; the others line only with others (AFS-165)', async () => {
    routes = base();
    await editing();
    // No line about others, no message field, no lead with the commit.
    expect(screen.queryByRole('region', { name: 'Editing together' })).toBeNull();
    expect(screen.queryByLabelText("What changed (the commit's message)")).toBeNull();
    expect(document.querySelector('.page-head p')).toBeNull();
    // The commit and how saving goes, behind "i" beside Full screen.
    fireEvent.click(screen.getByRole('button', { name: 'About this draft' }));
    const info = document.querySelector('.draft-info') as HTMLElement;
    expect(info.textContent).toContain(`A draft of main at ${COMMIT.slice(0, 12)}`);
    expect(info.textContent).toContain('Ctrl+Z');
    // Another tab of the same person: the line shows.
    tell({
      type: 'afs-draft-people',
      people: [{ login: 'dana', name: 'Dana Whitfield', tabs: 2 }],
    });
    const line = await screen.findByRole('region', { name: 'Editing together' });
    expect(line.textContent).toContain('here now: only you (you in other tabs too).');
  });

  it('tells the others a save is coming while Save is open, and says so when someone else opens it (AFS-171)', async () => {
    routes = { ...base(), 'POST /drafts/d1/here': () => ({ body: { people: [] } }) };
    await editing();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() =>
      expect(bodies['POST /drafts/d1/here']).toEqual([{ tab: expect.any(String), saving: true }]),
    );
    fireEvent.click(within(saveForm()).getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() =>
      expect(bodies['POST /drafts/d1/here']?.[1]).toMatchObject({ saving: false }),
    );
    // Mia opens Save in her page: Dana is told before her editing ends.
    tell({
      type: 'afs-draft-people',
      people: [
        { login: 'dana', name: 'Dana Whitfield' },
        { login: 'mia', name: 'Mia Ortega', saving: true },
      ],
    });
    expect(
      (await screen.findByText('Mia Ortega is about to save.')).closest('.draft-float'),
    ).toBeTruthy();
    tell({
      type: 'afs-draft-people',
      people: [
        { login: 'dana', name: 'Dana Whitfield' },
        { login: 'mia', name: 'Mia Ortega' },
      ],
    });
    expect(screen.queryByText('Mia Ortega is about to save.')).toBeNull();
  });

  it('saves on Ctrl+S, from the page and from the canvas (AFS-166)', async () => {
    routes = { ...base(), 'POST /drafts/d1/save': () => ({ body: { commit: SAVED } }) };
    await editing();
    const key = () =>
      act(() => {
        fireEvent.keyDown(window, { key: 's', ctrlKey: true });
      });
    key();
    // Asked for the message first; nothing is saved yet.
    expect(saveForm()).toBeTruthy();
    expect(bodies['POST /drafts/d1/save']).toBeUndefined();
    // Ctrl+S in the designer's frame comes as a message: it saves what is asked.
    tell({ type: SAVE_KEY });
    expect(await screen.findByText(/Saved as/)).toBeTruthy();
    expect(bodies['POST /drafts/d1/save']).toHaveLength(1);
    // Not editing now: Ctrl+S does nothing here (and the browser's dialog is kept away).
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(bodies['POST /drafts/d1/save']).toHaveLength(1);
  });

  it('selects the step a link names on the canvas (AFS-164)', async () => {
    routes = base();
    window.history.replaceState(null, '', '/?step=01HSTEP&edit=1');
    render(
      <FlowPage
        me={{ login: 'dana', name: 'Dana Whitfield' }}
        workspace="net"
        project="core"
        file={FILE}
        theme="dark"
      />,
    );
    // Opened for editing, with the step asked for selected in the draft's frame.
    await screen.findByRole('button', { name: 'Stop editing' });
    const frame = screen.getByTitle(/on the designer/) as HTMLIFrameElement;
    const asked = new URL(frame.src, window.location.origin).searchParams;
    expect(asked.get('draft')).toBe('d1');
    expect(asked.get('node')).toBe('01HSTEP');
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
