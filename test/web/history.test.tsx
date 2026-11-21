// AFS-123: history in the pages, with the server played by the test. The History tab lists the
// branch's commits, filters them, opens one to its files (flows by title, to the flow at that
// commit) and reads more on request; a flow's page lists the flow's commits and shows the flow
// as a commit left it (read only, the Changes lens against the version before), or says the
// commit removed it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlow } from '@ansible-flow/core/flow/document';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../src/web/api';
import { FlowPage } from '../../src/web/flow';
import { bodyWords, ProjectHistory } from '../../src/web/history';
import { compareOf, nothingOf } from '../../src/web/viewerPast';

const TIP = 'c'.repeat(40);
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const C3 = '3'.repeat(40);
const FILE = 'flows/upgrade.flow.yaml';
const project = {
  id: 'p1',
  workspace: 'w1',
  key: 'core',
  name: 'Core',
  hosted: true,
  gitPath: '/git/net/core.git',
  gitRef: 'main',
  commit: TIP,
  sync: { state: 'ok' },
} as unknown as Project;
const commit = (hash: string, subject: string, extra: object = {}) => ({
  commit: hash,
  parents: [],
  author: 'Mia Ortega',
  at: '2026-11-18T09:30:00.000Z',
  subject,
  ...extra,
});

let asked: string[];
let routes: Record<string, () => { status?: number; body?: unknown }>;
beforeEach(() => {
  asked = [];
  window.history.replaceState(null, '', '/');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
    asked.push(key);
    const answer = routes[key]?.() ?? {
      status: 404,
      body: { error: 'not_found', message: `Nothing at ${key}` },
    };
    const status = answer.status ?? 200;
    return { ok: status < 300, status, json: async () => answer.body } as Response;
  });
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener() {}
      close() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a project's History tab", () => {
  it('lists the commits, filters them, opens one to its files and reads more', async () => {
    routes = {
      'GET /projects/p1/branches': () => ({ body: { branches: ['main', 'feature/ospf'] } }),
      'GET /projects/p1/commits?limit=50': () => ({
        body: {
          branch: 'main',
          commit: TIP,
          commits: [commit(C1, 'Tune the timeouts'), commit(C2, 'Greet the team')],
          next: 50,
        },
      }),
      [`GET /projects/p1/commits?skip=50&commit=${TIP}&limit=50`]: () => ({
        body: { branch: 'main', commit: TIP, commits: [commit(C3, 'First flows')] },
      }),
      'GET /projects/p1/commits?q=greet&limit=50': () => ({
        body: { branch: 'main', commit: TIP, commits: [commit(C2, 'Greet the team')] },
      }),
      [`GET /projects/p1/commits/${C2}`]: () => ({
        body: {
          ...commit(C2, 'Greet the team'),
          parents: [C3],
          body: 'Say hello to the team by name.',
          files: [
            { file: FILE, change: 'changed', flow: true, title: 'Firewall upgrade' },
            { file: 'flows/old.flow.yaml', change: 'removed', flow: true, title: 'Old checks' },
            { file: 'README.md', change: 'added' },
            { file: 'inventory/lab.ini', change: 'renamed', from: 'hosts/lab.ini' },
            { file: 'roles/ntp/old.yml', change: 'removed' },
          ],
        },
      }),
    };
    render(<ProjectHistory workspace="net" project={project} />);
    const rows = await screen.findAllByRole('button', { expanded: false });
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Tune the timeouts'),
      expect.stringContaining('Greet the team'),
    ]);
    // Who, when (the person's own time) and the short hash.
    expect(rows[0]?.textContent).toContain('Mia Ortega');
    expect(rows[0]?.textContent).toContain('11111111');
    expect(rows[0]?.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-11-18T09:30:00.000Z',
    );

    fireEvent.click(rows[1] as HTMLElement);
    const files = await screen.findByText('Say hello to the team by name.');
    const list = files.parentElement as HTMLElement;
    const link = within(list).getByRole('link', { name: 'Firewall upgrade' });
    expect(link.getAttribute('href')).toBe(`/w/net/core/flow/flows/upgrade.flow.yaml?commit=${C2}`);
    expect(within(list).getByRole('link', { name: 'Old checks' })).toBeTruthy();
    // AFS-190: every other file opens as the commit left it; a removed one as it was before.
    expect(within(list).getByRole('link', { name: 'README.md' }).getAttribute('href')).toBe(
      `/api/v1/projects/p1/files/content?commit=${C2}&path=README.md`,
    );
    expect(within(list).getByRole('link', { name: 'roles/ntp/old.yml' }).getAttribute('href')).toBe(
      `/api/v1/projects/p1/files/content?commit=${C3}&path=roles%2Fntp%2Fold.yml`,
    );
    // A file moved is one line, with the path it had.
    expect(within(list).getByText('hosts/lab.ini').closest('li')?.textContent).toContain(
      'inventory/lab.ini',
    );
    expect(within(list).getAllByText('removed').length).toBe(2);
    // The open commit is in the address, to share.
    expect(window.location.search).toContain(`commit=${C2}`);

    fireEvent.click(screen.getByRole('button', { name: 'More commits' }));
    await screen.findByText('First flows');
    expect(screen.queryByRole('button', { name: 'More commits' })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('message, author, hash or file'), {
      target: { value: 'greet' },
    });
    await waitFor(() => expect(screen.queryByText('Tune the timeouts')).toBeNull());
    expect(asked).toContain('GET /projects/p1/commits?q=greet&limit=50');
    expect(window.location.search).toContain('q=greet');
  });

  it('reads another branch', async () => {
    routes = {
      'GET /projects/p1/branches': () => ({ body: { branches: ['main', 'feature/ospf'] } }),
      'GET /projects/p1/commits?limit=50': () => ({
        body: { branch: 'main', commit: TIP, commits: [] },
      }),
      'GET /projects/p1/commits?branch=feature%2Fospf&limit=50': () => ({
        body: { branch: 'feature/ospf', commit: C1, commits: [commit(C1, 'Try OSPF')] },
      }),
    };
    render(<ProjectHistory workspace="net" project={project} />);
    await screen.findByText('main has no commits yet.');
    const branch = await screen.findByRole('combobox');
    await waitFor(() => expect(within(branch).getAllByRole('option').length).toBe(2));
    fireEvent.change(branch, { target: { value: 'feature/ospf' } });
    await screen.findByText('Try OSPF');
    expect(window.location.search).toContain('branch=feature%2Fospf');
  });
});

const flowRoutes = (level = 'ro') => ({
  'GET /workspaces/net/projects': () => ({ body: [project] }),
  'GET /projects/p1/flows': () => ({ body: { flows: [{ file: FILE, name: 'Firewall upgrade' }] } }),
  'GET /projects/p1/drafts': () => ({ body: [] }),
  'GET /projects/p1/access': () => ({
    body: { admin: false, workspace: level, approve: false, flows: { [FILE]: 'rw' } },
  }),
  'GET /projects/p1/launch-configs': () => ({ body: [] }),
  'GET /runs?project=p1&flow=flows%2Fupgrade.flow.yaml&limit=3': () => ({ body: [] }),
  'GET /projects/p1/commits?path=flows%2Fupgrade.flow.yaml&limit=30': () => ({
    body: {
      branch: 'main',
      commit: TIP,
      commits: [
        commit(C2, 'Greet the team', { files: [{ file: FILE, change: 'changed' }] }),
        commit(C1, 'Add the scenarios', {
          files: [{ file: 'flows/upgrade.scenarios.yaml', change: 'added' }],
        }),
      ],
    },
  }),
});
const showFlow = () =>
  render(
    <FlowPage
      me={{ login: 'dana', name: 'Dana' }}
      workspace="net"
      project="core"
      file={FILE}
      theme="dark"
    />,
  );

describe("a flow's history and the flow at a commit", () => {
  it('lists the commits of the flow from the More menu, each to the flow at it', async () => {
    routes = flowRoutes();
    showFlow();
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));
    const panel = await screen.findByRole('region', { name: 'History of this flow' });
    const items = await within(panel).findAllByRole('link');
    expect(items.map((a) => a.getAttribute('href'))).toEqual([
      `/w/net/core/flow/flows/upgrade.flow.yaml?commit=${C2}`,
      `/w/net/core/flow/flows/upgrade.flow.yaml?commit=${C1}`,
    ]);
    expect(items[1]?.textContent).toContain('scenarios added');
    // Copy and Delete stay for who may change the files.
    expect(screen.queryByRole('menuitem', { name: 'Copy the flow…' })).toBeNull();
  });

  it('shows the flow as a commit left it, read only, with the way back', async () => {
    window.history.replaceState(null, '', `/w/net/core/flow/${FILE}?commit=${C2}`);
    routes = {
      ...flowRoutes('rw'),
      [`GET /projects/p1/flows/commit?path=flows%2Fupgrade.flow.yaml&commit=${C2}`]: () => ({
        body: {
          ...commit(C2, 'Greet the team'),
          body: '',
          path: FILE,
          change: 'changed',
          before: C1,
        },
      }),
    };
    showFlow();
    const past = await waitFor(() => {
      const el = document.querySelector('.past-note') as HTMLElement | null;
      if (!el) throw new Error('no note yet');
      return el;
    });
    expect(past.textContent).toContain('222222222222');
    expect(past.textContent).toContain('Mia Ortega');
    expect(past.textContent).toContain('Greet the team');
    expect(
      within(past).getByRole('link', { name: 'Back to the current flow' }).getAttribute('href'),
    ).toBe('/w/net/core/flow/flows/upgrade.flow.yaml');
    const frame = await waitFor(() => {
      const el = document.querySelector('iframe') as HTMLIFrameElement | null;
      if (!el) throw new Error('no frame yet');
      return el;
    });
    expect(frame.getAttribute('src')).toContain(`&commit=${C2}&history=1`);
    expect(frame.getAttribute('src')).not.toContain('draft=');
    // Nothing to edit at a commit, and no launch line.
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(document.querySelector('.flow-line')).toBeNull();
  });

  it('says when the commit removed the flow, with its last version', async () => {
    window.history.replaceState(null, '', `/w/net/core/flow/${FILE}?commit=${C3}`);
    routes = {
      ...flowRoutes(),
      [`GET /projects/p1/flows/commit?path=flows%2Fupgrade.flow.yaml&commit=${C3}`]: () => ({
        body: {
          ...commit(C3, 'Drop the upgrade'),
          body: '',
          path: FILE,
          change: 'removed',
          before: C2,
          last: C2,
        },
      }),
    };
    showFlow();
    const last = await screen.findByRole('link', { name: 'Its last version' });
    expect(last.getAttribute('href')).toBe(`/w/net/core/flow/flows/upgrade.flow.yaml?commit=${C2}`);
    expect(document.querySelector('.past-note')?.textContent).toContain('removed the flow');
    expect(document.querySelector('iframe')).toBeNull();
  });

  // AFS-190: a commit asked for is never the current flow to edit.
  it('finds a commit by the start of its id and keeps its full id in the address', async () => {
    window.history.replaceState(null, '', `/w/net/core/flow/${FILE}?commit=${C2.slice(0, 12)}`);
    routes = {
      ...flowRoutes('rw'),
      [`GET /projects/p1/flows/commit?path=flows%2Fupgrade.flow.yaml&commit=${C2.slice(0, 12)}`]:
        () => ({
          body: { ...commit(C2, 'Greet the team'), body: '', path: FILE, change: 'changed' },
        }),
    };
    showFlow();
    await waitFor(() => expect(window.location.search).toBe(`?commit=${C2}`));
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('refuses what is not a commit id, with the ways on, and shows no flow to edit', async () => {
    window.history.replaceState(null, '', `/w/net/core/flow/${FILE}?commit=nonsense`);
    routes = flowRoutes('rw');
    showFlow();
    const note = await screen.findByRole('alert');
    expect(note.textContent).toContain('nonsense is not a commit id');
    expect(within(note).getByRole('link', { name: 'Back to the current flow' })).toBeTruthy();
    expect(within(note).getByRole('button', { name: 'History of this flow' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
    expect(asked.some((a) => a.includes('/flows/commit'))).toBe(false);
  });

  it('says the server refused a commit, with the ways on', async () => {
    window.history.replaceState(null, '', `/w/net/core/flow/${FILE}?commit=${C1}`);
    routes = {
      ...flowRoutes('rw'),
      [`GET /projects/p1/flows/commit?path=flows%2Fupgrade.flow.yaml&commit=${C1}`]: () => ({
        status: 404,
        body: {
          error: 'not_found',
          message: 'The flow was not in the project at commit 111111111111.',
        },
      }),
    };
    showFlow();
    const note = await screen.findByRole('alert');
    expect(note.textContent).toContain('The flow was not in the project at commit 111111111111.');
    expect(within(note).getByRole('link', { name: 'Back to the current flow' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('names the branch of a commit the project branch does not have', async () => {
    window.history.replaceState(null, '', `/w/net/core/flow/${FILE}?commit=${C2}`);
    routes = {
      ...flowRoutes(),
      [`GET /projects/p1/flows/commit?path=flows%2Fupgrade.flow.yaml&commit=${C2}`]: () => ({
        body: {
          ...commit(C2, 'Try a change'),
          body: '',
          path: FILE,
          change: 'unchanged',
          onBranch: false,
          branches: ['try'],
        },
      }),
    };
    showFlow();
    await waitFor(() =>
      expect(document.querySelector('.past-note')?.textContent).toContain(
        'It is not on main: it is on try.',
      ),
    );
  });

  it('a removed flow that is gone leads back to the project', async () => {
    window.history.replaceState(null, '', `/w/net/core/flow/${FILE}?commit=${C3}`);
    routes = {
      ...flowRoutes(),
      'GET /projects/p1/flows': () => ({ body: { flows: [] } }),
      [`GET /projects/p1/flows/commit?path=flows%2Fupgrade.flow.yaml&commit=${C3}`]: () => ({
        body: {
          ...commit(C3, 'Drop the upgrade'),
          body: '',
          path: FILE,
          change: 'removed',
          before: C2,
          last: C2,
        },
      }),
    };
    showFlow();
    const back = await screen.findByRole('link', { name: 'Back to Core' });
    expect(back.getAttribute('href')).toBe('/w/net/core');
    expect(document.querySelector('.past-note')?.textContent).toContain('Its last version ·');
  });
});

describe('the Changes lens of a flow at a commit', () => {
  const doc = parseFlow(readFileSync(join(__dirname, '../fixtures/hello.flow.yaml'), 'utf8'))
    .doc as FlowDocument;
  const facts = {
    commit: C2,
    author: 'Mia Ortega',
    at: '2026-11-18T09:30:00.000Z',
    subject: 'Greet the team',
  };

  it('compares with the version before the commit, the one base offered', () => {
    const compare = compareOf({ ...facts, change: 'changed', before: C1 }, doc);
    expect(compare).toMatchObject({
      state: 'ready',
      ref: C1,
      label: 'the version before 222222222222',
      refs: [{ ref: C1, label: 'the version before 222222222222' }],
    });
    expect(compareOf({ ...facts, change: 'changed', before: C1 }, undefined).state).toBe('error');
  });

  it('compares a flow the commit added with nothing: every step new', () => {
    const nothing = nothingOf(doc);
    expect(nothing.nodes).toEqual([]);
    expect(nothing.edges).toEqual([]);
    expect(nothing.flow).toEqual(doc.flow);
    expect(compareOf({ ...facts, change: 'added' }, nothing)).toMatchObject({
      state: 'ready',
      label: 'nothing: 222222222222 added the flow',
      base: nothing,
    });
  });
});

describe("a commit's message (AFS-186)", () => {
  it('names a co-author without their e-mail address', () => {
    expect(
      bodyWords('Co-authored-by: Mia Ortega <mia@example.net>\nCo-authored-by: Omar <o@x.y>'),
    ).toBe('Co-author: Mia Ortega\nCo-author: Omar');
    expect(bodyWords('Says <this> stays')).toBe('Says <this> stays');
  });
});
