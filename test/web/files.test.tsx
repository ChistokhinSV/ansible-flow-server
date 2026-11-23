// AFS-78: the Files page with the server played by the test: the tree of the branch, a text file
// read, a change set made of a delete and a move that the tree shows before Save, Save as one
// request with the commit it began at, and a refusal that lists the files the branch changed.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';
import { addChange, applyChanges, base64Size, takeBack, uploadedText } from '../../src/web/files';

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
    // AFS-169: the changes come after the files, so they do not push the editor down.
    const changes = screen.getByRole('heading', { name: /Changes not saved/ }).closest('section');
    expect(changes?.classList.contains('files-changes')).toBe(true);
    expect(
      (document.querySelector('.files') as Element).compareDocumentPosition(changes as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

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
      // AFS-232: no message typed, none sent: the server writes the placeholder's words and lists
      // the changes in the body.
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
    // AFS-192: the first upload is what shows next, with its text, before it is saved.
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('path')).toBe('templates/a7-one.txt'),
    );
    expect(screen.getByText(/Uploaded here/)).toBeTruthy();
    await waitFor(() =>
      expect(document.querySelector('.code-editor')?.shadowRoot?.textContent).toContain(
        'a7-one.txt',
      ),
    );
    // Moved before it is saved: one change, the upload at its new path.
    fireEvent.click(screen.getByRole('button', { name: 'Rename or move' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New path' }), {
      target: { value: 'group_vars/a7-one.txt' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByText('Upload group_vars/a7-one.txt')).toBeTruthy();
    expect(screen.getByText('Changes not saved (3)')).toBeTruthy();
    // Deleted before it is saved: the upload is taken back.
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Changes not saved (2)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'web.conf.j2' }));
    await screen.findByText(/last changed by/);

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

    // Deleted but not saved: said so, not "there is no ...", and still listed, struck through.
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/is marked for deletion/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'web.conf.j2' }).classList).toContain('deleted');
    expect(screen.getByText('deleted')).toBeTruthy();
    expect(
      screen.getByPlaceholderText(
        /Upload templates\/a7-two.txt; Upload templates\/a7-three.txt; Delete/,
      ),
    ).toBeTruthy();
    // AFS-192: Keep it takes the deletion back.
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(await screen.findByText('Changes not saved (2)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'web.conf.j2' }).classList).not.toContain('deleted');
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

  it('AFS-232: once the refused changes are taken back, the rest saves on the branch as it is now', async () => {
    const HEAD = 'b'.repeat(40);
    const move = { op: 'move', from: 'templates/web.conf.j2', to: 'roles/web/web.conf.j2' };
    const del = { op: 'delete', path: 'flows' };
    window.localStorage.setItem(
      'afs.files.p1.main',
      JSON.stringify({ base: COMMIT, changes: [del, move] }),
    );
    window.history.replaceState(null, '', '/w/net/core/files?path=templates%2Fweb.conf.j2');
    render(<App />);
    await screen.findByText(/Changes not saved \(2\)/);
    routes['POST /projects/p1/files'] = () => ({
      status: 409,
      body: {
        error: 'conflict',
        message: 'main changed the same files since the change set began',
        files: ['templates/web.conf.j2'],
        head: HEAD,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save to main' }));
    expect(await screen.findByText(/changed the same files/)).toBeTruthy();
    // The refusal is kept with the change set (a reload keeps it), and the list is read again.
    expect(JSON.parse(window.localStorage.getItem('afs.files.p1.main') ?? '{}').conflict).toEqual({
      files: ['templates/web.conf.j2'],
      head: HEAD,
    });
    const listed = () => asked.filter((a) => a.key === 'GET /projects/p1/files?branch=main').length;
    await waitFor(() => expect(listed()).toBe(2));

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Take back: Move templates/web.conf.j2 to roles/web/web.conf.j2',
      }),
    );
    await waitFor(() => expect(listed()).toBe(3));
    routes['POST /projects/p1/files'] = () => ({
      status: 201,
      body: { branch: 'main', commit: 'c'.repeat(40), files: ['flows/hello/hello.flow.yaml'] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save to main' }));
    expect(await screen.findByText(/Saved 1 change/)).toBeTruthy();
    expect(sent('POST /projects/p1/files')[1]).toEqual({
      branch: 'main',
      base: HEAD,
      changes: [del],
    });
  });
});

describe('taking back a change after a refused Save', () => {
  const conflict = { files: ['templates/web.conf.j2'], head: 'b'.repeat(40) };
  const edit = { op: 'write', path: 'templates/web.conf.j2', text: 'x' } as const;
  const other = { op: 'write', path: 'notes.txt', text: 'y' } as const;
  const folder = { op: 'move', from: 'templates', to: 'tpl' } as const;
  it('AFS-232: keeps the old beginning while a change still touches a refused file', () => {
    expect(takeBack({ base: COMMIT, conflict, changes: [other, folder, edit] }, 2)).toEqual({
      base: COMMIT,
      conflict,
      changes: [other, folder],
    });
    expect(takeBack({ base: COMMIT, conflict, changes: [other, folder] }, 1)).toEqual({
      base: conflict.head,
      changes: [other],
    });
    // Without a refusal the beginning stays; with nothing left there is none.
    expect(takeBack({ base: COMMIT, changes: [other, edit] }, 1)).toEqual({
      base: COMMIT,
      changes: [other],
    });
    expect(takeBack({ base: COMMIT, conflict, changes: [edit] }, 0)).toEqual({ changes: [] });
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
      // AFS-192: marked for deletion, still listed until saved.
      ['flows/hello/hello.flow.yaml', 'deleted'],
      ['roles/web/tasks/main.yml', undefined],
      ['roles/web/templates/web.conf.j2', 'changed'],
    ]);
    expect(after[3]?.from).toBe('templates/web.conf.j2');
  });

  it('AFS-192: a move or delete of an upload changes the upload, not the branch', () => {
    const up = { op: 'write', path: 'all.yml', base64: 'eDogMQo=' } as const;
    expect(
      addChange([up], { op: 'move', from: 'all.yml', to: 'group_vars/all.yml' }, files),
    ).toEqual([{ ...up, path: 'group_vars/all.yml' }]);
    expect(addChange([up], { op: 'delete', path: 'all.yml' }, files)).toEqual([]);
    // A file the branch has, or a path an archive may fill, is moved as asked.
    const move = { op: 'move', from: 'templates', to: 't' } as const;
    expect(addChange([], move, files)).toEqual([move]);
    const unpack = { op: 'unpack', path: '', base64: 'eA==' } as const;
    const moveUp = { op: 'move', from: 'all.yml', to: 'b.yml' } as const;
    expect(addChange([unpack, up], moveUp, files)).toEqual([unpack, up, moveUp]);
    expect(uploadedText('eDogMQo=')).toBe('x: 1\n');
    expect(uploadedText(Buffer.from([0, 1, 2]).toString('base64'))).toBeUndefined();
  });
});

describe('AFS-210: moving a flow in Files', () => {
  it('names the configurations and schedules that run it, and takes them along on Save', async () => {
    window.localStorage.setItem(
      'afs.files.p1.main',
      JSON.stringify({
        base: COMMIT,
        changes: [{ op: 'move', from: 'flows/hello', to: 'flows/hi' }],
      }),
    );
    routes['GET /projects/p1/launch-configs'] = () => ({
      body: [
        { id: 'c1', name: 'Hello nightly', flowFile: 'flows/hello/hello.flow.yaml' },
        // Pinned to a commit: the flow stays there, nothing to say.
        { id: 'c2', name: 'Hello pinned', flowFile: 'flows/hello/hello.flow.yaml', commit: COMMIT },
      ],
    });
    routes['GET /launch-configs/c1/schedules'] = () => ({
      body: [{ id: 's1', name: 'At three', enabled: true }],
    });
    routes['POST /projects/p1/files'] = () => ({
      status: 201,
      body: {
        branch: 'main',
        commit: 'b'.repeat(40),
        files: ['flows/hello/hello.flow.yaml', 'flows/hi/hello.flow.yaml'],
        repointed: [
          {
            id: 'c1',
            name: 'Hello nightly',
            from: 'flows/hello/hello.flow.yaml',
            to: 'flows/hi/hello.flow.yaml',
          },
        ],
      },
    });
    window.history.replaceState(null, '', '/w/net/core/files?path=templates%2Fweb.conf.j2');
    render(<App />);
    const note = (await screen.findByText(/run(s)? a flow/)).closest('[data-flow-users]');
    expect(note?.textContent).toContain(
      'Hello nightly runs flows/hello/hello.flow.yaml, which moves to flows/hi/hello.flow.yaml; the schedule At three fires it',
    );
    expect(note?.textContent).not.toContain('Hello pinned');
    const follow = screen.getByRole('checkbox', { name: /Point it at the new file/ });
    expect((follow as HTMLInputElement).checked).toBe(true);
    // Left as it is, the page says what that means.
    fireEvent.click(follow);
    expect(note?.textContent).toContain(
      'it cannot launch, and the schedule At three is turned off',
    );
    fireEvent.click(follow);
    fireEvent.click(screen.getByRole('button', { name: 'Save to main' }));
    expect(
      await screen.findByText(/Hello nightly now runs flows\/hi\/hello.flow.yaml/),
    ).toBeTruthy();
    expect(sent('POST /projects/p1/files')[0]).toMatchObject({ repoint: true });
  });
});
