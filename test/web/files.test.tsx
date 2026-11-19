// AFS-78: the Files page with the server played by the test: the tree of the branch, a text file
// read, a change set made of a delete and a move that the tree shows before Save, Save as one
// request with the commit it began at, and a refusal that lists the files the branch changed.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';
import { applyChanges, base64Size } from '../../src/web/files';

const omar = { id: 'u2', login: 'omar', name: 'Omar Haddad', admin: false, groups: [] };
const COMMIT = '9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b';
const project = {
  id: 'p1',
  workspace: 'w1',
  key: 'core',
  name: 'Core',
  hosted: true,
  gitRef: 'main',
  commit: COMMIT,
  sync: { state: 'ok' },
};
const files = [
  { path: 'flows/hello/hello.flow.yaml', size: 900 },
  { path: 'roles/web/tasks/main.yml', size: 40 },
  { path: 'templates/web.conf.j2', size: 24 },
];

let asked: { key: string; body?: unknown }[];
let routes: Record<string, (body?: unknown) => { status?: number; body?: unknown; text?: string }>;
beforeEach(() => {
  asked = [];
  window.scrollTo = () => undefined;
  // jsdom has no layout; CodeMirror asks for the boxes of text ranges.
  const empty = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  Range.prototype.getClientRects = empty as never;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  try {
    window.localStorage.clear();
  } catch {}
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
      headers: new Headers({
        'content-type':
          answer.text !== undefined ? 'text/plain; charset=utf-8' : 'application/json',
      }),
      json: async () => answer.body,
      text: async () => answer.text ?? '',
    } as Response;
  });
  routes = {
    'GET /session': () => ({ body: omar }),
    'GET /workspaces/net/projects': () => ({ body: [project] }),
    'GET /projects/p1/access': () => ({
      body: { admin: false, workspace: 'rw', approve: false, flows: {} },
    }),
    'GET /projects/p1/branches': () => ({ body: { branches: ['main', 'try/files'] } }),
    'GET /projects/p1/files?branch=main': () => ({
      body: { branch: 'main', commit: COMMIT, files },
    }),
    [`GET /projects/p1/files/content?commit=${COMMIT}&path=templates%2Fweb.conf.j2`]: () => ({
      text: 'listen {{ web_port }};\n',
    }),
    [`GET /projects/p1/files/history?commit=${COMMIT}&path=templates%2Fweb.conf.j2&limit=5`]:
      () => ({
        body: [{ commit: COMMIT, author: 'Lina', at: '2026-11-15T09:00:00.000Z', subject: 'Port' }],
      }),
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const sent = (key: string) => asked.filter((a) => a.key === key).map((a) => a.body);

describe('the files page', () => {
  it('shows a file, keeps changes until Save, and lists the files a refused Save is about', async () => {
    window.history.replaceState(null, '', '/w/net/core/files?path=templates%2Fweb.conf.j2');
    render(<App />);
    // The template opens with its text and who changed it last.
    await screen.findByText(/last changed by/);
    expect(await screen.findByText(/Lina/)).toBeTruthy();
    // The editor is in a shadow root (the pages' CSP allows its constructed style sheets there).
    await waitFor(() =>
      expect(document.querySelector('.code-editor')?.shadowRoot?.textContent).toContain(
        'listen {{ web_port }};',
      ),
    );

    // Move it into the role; delete the old flows folder.
    fireEvent.click(screen.getByRole('button', { name: 'Rename or move' }));
    const to = screen.getByRole('textbox', { name: 'New path' });
    fireEvent.change(to, { target: { value: 'roles/web/templates/web.conf.j2' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(
      await screen.findByText('Move templates/web.conf.j2 to roles/web/templates/web.conf.j2'),
    ).toBeTruthy();
    expect(screen.getByText('moved')).toBeTruthy();

    routes['POST /projects/p1/files'] = () => ({
      status: 409,
      body: {
        error: 'conflict',
        message: 'main changed the same files since the change set began',
        files: ['templates/web.conf.j2'],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save to main' }));
    expect(await screen.findByText(/changed the same files/)).toBeTruthy();
    expect(screen.getByText('templates/web.conf.j2', { selector: 'code' })).toBeTruthy();
    expect(sent('POST /projects/p1/files')[0]).toEqual({
      branch: 'main',
      base: COMMIT,
      // AFS-140: no message typed: the placeholder's words are the commit's.
      message: 'Move templates/web.conf.j2 to roles/web/templates/web.conf.j2',
      changes: [
        { op: 'move', from: 'templates/web.conf.j2', to: 'roles/web/templates/web.conf.j2' },
      ],
    });

    // The change set is still there; the second Save goes through.
    routes['POST /projects/p1/files'] = () => ({
      status: 201,
      body: { branch: 'main', commit: 'a'.repeat(40), files: ['x', 'y'] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save to main' }));
    expect(await screen.findByText(/Saved 1 change as aaaaaaaaaaaa on main/)).toBeTruthy();
    expect(screen.queryByText(/Changes not saved/)).toBeNull();
  });

  it('AFS-140: keeps every file of an upload, checks paths when typed, says a delete is pending', async () => {
    window.history.replaceState(null, '', '/w/net/core/files?path=templates%2Fweb.conf.j2');
    render(<App />);
    await screen.findByText(/last changed by/);
    // Three files picked at once: three changes.
    const picked = ['a7-one.txt', 'a7-two.txt', 'a7-three.txt'].map(
      (name) => new File([name], name, { type: 'text/plain' }),
    );
    fireEvent.change(screen.getByLabelText('Files to upload'), { target: { files: picked } });
    expect(await screen.findByText('Changes not saved (3)')).toBeTruthy();
    for (const name of ['a7-one.txt', 'a7-two.txt', 'a7-three.txt'])
      expect(screen.getByText(`Upload templates/${name}`)).toBeTruthy();

    // A new file outside the project, or onto one that is there, is refused as it is typed.
    fireEvent.click(screen.getByRole('button', { name: 'New file' }));
    const name = screen.getByRole('textbox', { name: 'New file' });
    fireEvent.change(name, { target: { value: '../a7-escape.txt' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/inside the project/);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(name, { target: { value: 'roles/web/tasks/main.yml' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/There is a file .* already/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // A rename onto a file that is there is refused, not hiding it.
    fireEvent.click(screen.getByRole('button', { name: 'Rename or move' }));
    const to = screen.getByRole('textbox', { name: 'New path' });
    fireEvent.change(to, { target: { value: 'roles/web/tasks/main.yml' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Deleted but not saved: said so, not "there is no ...".
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/is marked for deletion/)).toBeTruthy();
    expect(
      screen.getByPlaceholderText(/Upload templates\/a7-one.txt and 3 more changes/),
    ).toBeTruthy();
  });

  it('AFS-150: sizes of each upload, an archive that replaces files asks, Discard all asks', async () => {
    window.history.replaceState(null, '', '/w/net/core/files?path=templates%2Fweb.conf.j2');
    render(<App />);
    await screen.findByText(/last changed by/);
    // Each picked file shows its own size (22 B and 24 B; base64 padding is no byte).
    const picked = [
      new File(['x'.repeat(22)], 'a7-one.txt', { type: 'text/plain' }),
      new File(['x'.repeat(24)], 'a7-three.txt', { type: 'text/plain' }),
    ];
    fireEvent.change(screen.getByLabelText('Files to upload'), { target: { files: picked } });
    expect(await screen.findByText('Changes not saved (2)')).toBeTruthy();
    const size = (name: string) =>
      screen.getByRole('button', { name }).parentElement?.querySelector('.size')?.textContent;
    expect(size('a7-one.txt')).toBe('22 B');
    expect(size('a7-three.txt')).toBe('24 B');

    // An archive that would replace a file: refused, the files listed, saved only when asked.
    fireEvent.change(screen.getByLabelText('Archive to unpack'), {
      target: { files: [new File(['zip'], 'roles.zip')] },
    });
    expect(await screen.findByText('Changes not saved (3)')).toBeTruthy();
    routes['POST /projects/p1/files'] = (body) =>
      (body as { changes: { op: string; replace?: boolean }[] }).changes.some(
        (c) => c.op === 'unpack' && c.replace,
      )
        ? { status: 201, body: { branch: 'main', commit: 'b'.repeat(40), files: ['x'] } }
        : {
            status: 409,
            body: {
              error: 'replaces',
              message: 'The archive replaces a file that is there already',
              files: ['templates/web.conf.j2'],
            },
          };
    fireEvent.click(screen.getByRole('button', { name: 'Save to main' }));
    expect(await screen.findByText(/replaces a file that is there already/)).toBeTruthy();
    expect(screen.getByText('templates/web.conf.j2', { selector: 'li code' })).toBeTruthy();
    expect(screen.getByText('Changes not saved (3)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Replace them and save' }));
    expect(await screen.findByText(/Saved 3 changes as bbbbbbbbbbbb/)).toBeTruthy();
    const [first, second] = sent('POST /projects/p1/files') as {
      changes: { op: string; replace?: boolean }[];
    }[];
    expect(first?.changes.find((c) => c.op === 'unpack')?.replace).toBeUndefined();
    expect(second?.changes.find((c) => c.op === 'unpack')?.replace).toBe(true);

    // A new change: the old note goes. Discard all asks first, with how many.
    fireEvent.change(screen.getByLabelText('Files to upload'), {
      target: { files: [new File(['n'], 'n.txt')] },
    });
    expect(await screen.findByText('Changes not saved (1)')).toBeTruthy();
    expect(screen.queryByText(/Saved 3 changes/)).toBeNull();
    const questions: string[] = [];
    vi.stubGlobal('confirm', (text: string) => {
      questions.push(text);
      return false;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Discard all' }));
    expect(questions[0]).toMatch(/Discard the change not saved\? It cannot be brought back/);
    expect(screen.getByText('Changes not saved (1)')).toBeTruthy();
    vi.stubGlobal('confirm', () => true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard all' }));
    await waitFor(() => expect(screen.queryByText(/Changes not saved/)).toBeNull());
  });

  it('read-only people read, and get no buttons that change', async () => {
    routes['GET /projects/p1/access'] = () => ({
      body: { admin: false, workspace: 'ro', approve: false, flows: {} },
    });
    window.history.replaceState(null, '', '/w/net/core/files?path=templates%2Fweb.conf.j2');
    render(<App />);
    await screen.findByText(/last changed by/);
    expect(screen.queryByRole('button', { name: 'New file' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toContain(
      'download=true',
    );
  });
});

describe('the size of uploaded bytes', () => {
  it('AFS-150: counts the bytes, not the padding of base64', () => {
    for (const n of [0, 1, 2, 3, 22, 23, 24])
      expect(base64Size(Buffer.alloc(n).toString('base64'))).toBe(n);
  });
});

describe('the tree after a change set', () => {
  it('follows writes, moves of folders and deletes, and marks what changed', () => {
    const after = applyChanges(files, [
      { op: 'write', path: 'templates/web.conf.j2', text: 'listen 80;\n' },
      { op: 'move', from: 'templates', to: 'roles/web/templates' },
      { op: 'delete', path: 'flows' },
      { op: 'write', path: 'files/new.txt', text: 'hi' },
    ]);
    expect(after.map((f) => [f.path, f.state])).toEqual([
      ['files/new.txt', 'new'],
      ['roles/web/tasks/main.yml', undefined],
      ['roles/web/templates/web.conf.j2', 'changed'],
    ]);
    expect(after[2]?.from).toBe('templates/web.conf.j2');
  });
});
