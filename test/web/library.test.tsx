// AFS-79: the flow library in the pages, with the server played by the test: the Library page, a
// flow's library copies (which are behind, Update while its draft is edited), and Insert Shared
// Subflow… picking from the library into the draft.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Draft, Project } from '../../src/web/api';
import { App } from '../../src/web/app';
import { InsertFromLibrary, LibraryCopies, libraryCopies } from '../../src/web/library';

const COMMIT = '9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b';
const NEWER = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567';
const FROM = 'afs://platform/patterns/flows/maintenance.flow.yaml#backup';
const dana = { id: 'u1', login: 'dana', name: 'Dana Reyes', admin: true, groups: [] };
const project = {
  id: 'p1',
  workspace: 'w1',
  key: 'core',
  name: 'Core',
  hosted: true,
  gitRef: 'main',
  commit: COMMIT,
  sync: { state: 'ok' },
  library: false,
} as unknown as Project;
const draft = {
  id: 'd1',
  project: 'p1',
  file: 'flows/edge.flow.yaml',
  baseCommit: COMMIT,
  revision: 1,
  createdAt: '2026-11-15T09:00:00.000Z',
  updatedAt: '2026-11-15T09:00:00.000Z',
  editors: [],
} as Draft;
const offered = {
  from: FROM,
  workspace: 'platform',
  project: 'patterns',
  file: 'flows/maintenance.flow.yaml',
  path: 'backup',
  title: 'Back up the configuration',
  flow: 'Maintenance steps',
  version: 4,
  commit: NEWER,
};
const doc = {
  nodes: [
    { id: 'n1', key: 'start', title: 'Start', type: 'start' },
    {
      id: 'n2',
      key: 'backup',
      title: 'Back up the configuration',
      type: 'subflow',
      ref: { from: FROM, version: 3, commit: COMMIT },
      subflow: { nodes: [{ id: 'n3', key: 'read', title: 'Read', type: 'task' }] },
    },
  ],
};

let asked: { key: string; body?: unknown }[];
let routes: Record<string, (body?: unknown) => { status?: number; body?: unknown }>;
beforeEach(() => {
  asked = [];
  window.scrollTo = () => undefined;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    asked.push({ key, body });
    const answer = routes[key]?.(body) ?? {
      status: 404,
      body: { error: 'not_found', message: key },
    };
    const status = answer.status ?? 200;
    return {
      ok: status < 300,
      status,
      json: async () => answer.body,
      text: async () => '',
    } as Response;
  });
  routes = {
    'GET /session': () => ({ body: dana }),
    'GET /library/subflows': () => ({ body: { subflows: [offered] } }),
    [`GET /library/subflow?from=${encodeURIComponent(FROM)}`]: () => ({
      body: { ...offered, node: { key: 'backup', type: 'subflow', title: offered.title } },
    }),
    'GET /drafts/d1': () => ({ body: { draft, snapshot: { doc } } }),
    'POST /drafts/d1/commands': () => ({ body: {} }),
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const sent = (key: string) => asked.filter((a) => a.key === key).map((a) => a.body);

describe('the flow library in the pages', () => {
  it('the Library page lists what library projects offer', async () => {
    window.history.replaceState(null, '', '/library');
    render(<App />);
    expect(await screen.findByText('Back up the configuration')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'platform/patterns' })).toBeTruthy();
    expect(screen.getByText(/version 4 at 0a1b2c3d4e5f/)).toBeTruthy();
  });

  it("a flow's copies: one behind the library is updated in the draft", async () => {
    render(<LibraryCopies project={project} file={draft.file} editing={draft} />);
    expect(await screen.findByText('library has version 4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(sent('POST /drafts/d1/commands')).toHaveLength(1));
    expect(sent('POST /drafts/d1/commands')[0]).toEqual({
      command: {
        kind: 'updateReference',
        id: 'n2',
        version: 4,
        source: { key: 'backup', type: 'subflow', title: offered.title },
        commit: NEWER,
      },
    });
  });

  it('Insert Shared Subflow… from the canvas copies the one picked into the draft', async () => {
    const done = vi.fn();
    render(
      <InsertFromLibrary
        draft={draft}
        where={{ level: 'n9', at: { x: 10, y: 20 } }}
        onDone={done}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Back up the configuration' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(sent('POST /drafts/d1/commands')[0]).toEqual({
      command: {
        kind: 'addReference',
        parent: 'n9',
        from: FROM,
        version: 4,
        source: { key: 'backup', type: 'subflow', title: offered.title },
        commit: NEWER,
        position: { x: 10, y: 20 },
      },
    });
  });

  it('finds library copies at every depth', () => {
    expect(libraryCopies(doc).map((n) => n.key)).toEqual(['backup']);
    expect(
      libraryCopies({
        nodes: [{ id: 'a', key: 'a', title: 'A', ref: { from: '../x#y', version: 1 } }],
      }),
    ).toEqual([]);
  });
});
