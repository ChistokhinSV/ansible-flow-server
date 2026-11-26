// AFS-265: the debug workbench: the splitter's keys and kept sizes, what happens at a pause (the
// focus on Continue, the window's title, the side bar, a phone's Debug tab, a notification), the
// Hosts and Pause points views talking to the canvas, the layout at 390, 1024 and 1440 px, and a
// debug run debugged in place on the flow's page.
import type { StepPause } from '@ansible-flow/core/run/step';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run } from '../../src/web/api';
import { FlowPage } from '../../src/web/flow';
import type { ShownStep } from '../../src/web/stepBar';
import { Splitter, useKeptSize } from '../../src/web/ui';
import { DebugWorkbench, useWorkbenchState } from '../../src/web/workbench';

const PUSH = '01JEDGN0000000000000000002';
const VALIDATE = '01JEDGN0000000000000000003';
const FILE = 'flows/edge-baseline.flow.yaml';
const hosts = ['sw-edge-01', 'sw-edge-02', 'sw-edge-03'];
const pause: StepPause = {
  id: 'p-1',
  node: PUSH,
  play: '[push] Push baseline',
  hosts,
  since: Date.now() / 1000,
  timeout: 3600,
  kind: 'failure',
  failed: [{ host: 'sw-edge-02', task: 'Push the VLAN', msg: 'VLAN 210 is in use' }],
  attempt: 1,
  debug: true,
};
const run = {
  id: 'r1',
  number: 412,
  project: 'p1',
  commit: 'c'.repeat(40),
  flow: { file: FILE, key: 'edge-baseline', name: 'Edge baseline', version: 1 },
  mode: 'check',
  inputs: {},
  targets: hosts,
  credentials: [],
  state: 'running',
  requestedBy: { id: 'u1', login: 'dana' },
  createdAt: '2026-11-26T10:00:00.000Z',
  startedAt: '2026-11-26T10:00:02.000Z',
  attempts: 1,
  cancelRequested: false,
  pausedBefore: 'Push baseline',
  step: { every: false, points: [VALIDATE], timeoutS: 3600, debug: true },
} as unknown as Run;
const running = { every: false, points: [VALIDATE], pauses: 0, debug: true } as ShownStep;
const paused = { ...running, pauses: 1, paused: pause } as ShownStep;

/** The window's width as the media queries see it. */
function width(px: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    const matches = (!max || px <= Number(max[1])) && (!min || px >= Number(min[1]));
    return {
      matches,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  });
}

let commands: unknown[];
let asked: Record<string, unknown>[];
let posted: Record<string, unknown>[];
const frame = {
  contentWindow: {
    postMessage: (m: Record<string, unknown>) => posted.push(m),
  },
} as unknown as HTMLIFrameElement;
beforeEach(() => {
  commands = [];
  asked = [];
  posted = [];
  window.localStorage.clear();
  document.title = 'Edge baseline #412 · Ansible Flow Server';
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith('/inspect')) {
      asked.push(body);
      return {
        ok: true,
        status: 200,
        json: async () =>
          body.op === 'scopes'
            ? { scopes: [{ id: 'inputs', name: 'Step inputs', vars: [] }] }
            : { results: [] },
      } as Response;
    }
    if (url.endsWith('/step')) {
      commands.push(body);
      return { ok: true, status: 202, json: async () => run } as Response;
    }
    if (url.includes('/watches'))
      return { ok: true, status: 200, json: async () => ({ exprs: [] }) };
    return { ok: false, status: 404, json: async () => ({ message: 'no' }) } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Bench({ step, mayDrive = true }: { step: ShownStep; mayDrive?: boolean }) {
  const state = useWorkbenchState(true);
  return (
    <DebugWorkbench
      run={run}
      step={step}
      debug
      going
      mayDrive={mayDrive}
      launcher="Dana"
      state={state}
      frame={() => frame}
      canvas={<div data-canvas />}
      terminal={<p>No output.</p>}
      sizeKey="test"
      titleBase="Edge baseline #412 · Ansible Flow Server"
      onRun={() => undefined}
      onError={() => undefined}
    />
  );
}

function Sized() {
  const [size, setSize] = useKeptSize('afs.workbench.t.side', 320);
  return (
    <Splitter
      orientation="vertical"
      size={size}
      min={220}
      max={640}
      label="Side bar width"
      controls="x"
      onSize={setSize}
    />
  );
}

function Panel() {
  const [size, setSize] = useState(200);
  return (
    <Splitter
      orientation="horizontal"
      size={size}
      min={96}
      max={720}
      label="Panel height"
      controls="x"
      onSize={setSize}
    />
  );
}

describe('the splitter', () => {
  it('moves with the arrow keys, Shift further, Home and End to the ends, and is kept', () => {
    render(<Sized />);
    const line = screen.getByRole('separator', { name: 'Side bar width' });
    expect(line.getAttribute('aria-valuenow')).toBe('320');
    fireEvent.keyDown(line, { key: 'ArrowRight' });
    expect(line.getAttribute('aria-valuenow')).toBe('336');
    fireEvent.keyDown(line, { key: 'ArrowLeft', shiftKey: true });
    expect(line.getAttribute('aria-valuenow')).toBe('272');
    fireEvent.keyDown(line, { key: 'Home' });
    expect(line.getAttribute('aria-valuenow')).toBe('220');
    fireEvent.keyDown(line, { key: 'End' });
    expect(line.getAttribute('aria-valuenow')).toBe('640');
    expect(window.localStorage.getItem('afs.workbench.t.side')).toBe('640');
    cleanup();
    render(<Sized />);
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('640');
  });

  it('a horizontal one grows the panel under it with the arrow up', () => {
    render(<Panel />);
    const line = screen.getByRole('separator');
    fireEvent.keyDown(line, { key: 'ArrowUp' });
    expect(line.getAttribute('aria-valuenow')).toBe('216');
    fireEvent.keyDown(line, { key: 'ArrowDown' });
    fireEvent.keyDown(line, { key: 'ArrowDown' });
    expect(line.getAttribute('aria-valuenow')).toBe('184');
  });

  it('works where the browser keeps nothing (storage closed)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('closed');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('closed');
    });
    render(<Sized />);
    const line = screen.getByRole('separator');
    fireEvent.keyDown(line, { key: 'ArrowRight' });
    expect(line.getAttribute('aria-valuenow')).toBe('336');
  });
});

describe('at a pause', () => {
  it('opens the side bar on Variables, focuses Continue, and the title says Paused', async () => {
    width(1024);
    const page = render(<Bench step={running} />);
    // At 1024 the side bar lies over the canvas, closed until it is needed.
    expect((document.getElementById('wb-side') as HTMLElement).hidden).toBe(true);
    expect(document.title).toBe('Edge baseline #412 · Ansible Flow Server');
    page.rerender(<Bench step={paused} />);
    const go = await screen.findByRole('button', { name: 'Continue' });
    await waitFor(() => expect(document.activeElement).toBe(go));
    expect((document.getElementById('wb-side') as HTMLElement).hidden).toBe(false);
    expect(screen.getByRole('heading', { name: 'Variables' })).toBeTruthy();
    expect(document.title).toBe('⏸ Paused · Edge baseline #412');
    // The canvas marks the first failed host; the step is not selected (the canvas keeps its room).
    expect(posted.some((m) => (m as { type: string }).type === 'afs-reveal')).toBe(false);
    await waitFor(() => expect(posted).toContainEqual({ type: 'afs-host', host: 'sw-edge-02' }));
    // The run goes on: the title is the run's again.
    page.rerender(<Bench step={running} />);
    expect(document.title).toBe('Edge baseline #412 · Ansible Flow Server');
  });

  it('does not take the focus from the Debug Console while someone types there', async () => {
    width(1440);
    const page = render(<Bench step={paused} />);
    const box = await screen.findByLabelText('Jinja expression to evaluate');
    box.focus();
    page.rerender(<Bench step={{ ...paused, paused: { ...pause, id: 'p-2', kind: 'point' } }} />);
    await new Promise((done) => setTimeout(done, 20));
    expect(document.activeElement).toBe(screen.getByLabelText('Jinja expression to evaluate'));
  });

  it('on a phone selects the Debug tab', async () => {
    width(390);
    const page = render(<Bench step={running} />);
    const tabs = screen.getByRole('tablist', { name: 'Parts of the debugger' });
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Flow' }));
    expect(within(tabs).getByRole('tab', { name: 'Flow' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    page.rerender(<Bench step={paused} />);
    await waitFor(() =>
      expect(within(tabs).getByRole('tab', { name: 'Debug' }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
    expect((document.getElementById('wb-side') as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('wb-canvas') as HTMLElement).hidden).toBe(true);
  });

  it('shows a notification when the tab is hidden, only where they are allowed', async () => {
    width(1440);
    const shown: unknown[][] = [];
    class FakeNote {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      constructor(...args: unknown[]) {
        shown.push(args);
      }
      close() {}
    }
    vi.stubGlobal('Notification', FakeNote);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    try {
      const page = render(<Bench step={running} />);
      page.rerender(<Bench step={paused} />);
      await waitFor(() => expect(shown).toHaveLength(1));
      expect(shown[0]?.[0]).toBe('⏸ Paused · Edge baseline #412');
      expect(String((shown[0]?.[1] as { body?: string } | undefined)?.body)).toContain(
        'Paused after Push baseline',
      );
      cleanup();
      FakeNote.permission = 'default';
      const again = render(<Bench step={running} />);
      again.rerender(<Bench step={paused} />);
      await screen.findByRole('button', { name: 'Notify me at pauses' });
      expect(shown).toHaveLength(1);
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    }
  });
});

describe('the views and the canvas', () => {
  it('choosing a host in Hosts sets it for Variables and marks it on the canvas', async () => {
    width(1440);
    render(<Bench step={paused} />);
    await waitFor(() => expect(asked[0]).toEqual({ op: 'scopes', host: 'sw-edge-02' }));
    fireEvent.click(screen.getByRole('button', { name: /^sw-edge-03/ }));
    await waitFor(() => expect(asked.at(-1)).toEqual({ op: 'scopes', host: 'sw-edge-03' }));
    expect(posted).toContainEqual({ type: 'afs-host', host: 'sw-edge-03' });
    expect(screen.getByRole('button', { name: /^sw-edge-03/ }).getAttribute('aria-current')).toBe(
      'true',
    );
  });

  it('Pause points: a box takes a point off and back, the filters go to the canvas', async () => {
    width(1440);
    render(<Bench step={paused} />);
    const points = screen.getByRole('heading', { name: 'Pause points' }).closest('details');
    const view = within(points as HTMLElement);
    const box = view.getByRole('checkbox', { name: 'Pause at A step' });
    fireEvent.click(box);
    expect(posted.at(-1)).toEqual({ type: 'afs-set-points', points: [] });
    // Cleared, it stays listed, to be put back.
    fireEvent.click(view.getByRole('checkbox', { name: 'Pause at A step' }));
    expect(posted.at(-1)).toEqual({ type: 'afs-set-points', points: [VALIDATE] });
    fireEvent.click(view.getByRole('checkbox', { name: 'Pause on unreachable' }));
    expect(posted.at(-1)).toEqual({
      type: 'afs-set-points',
      points: [VALIDATE],
      failures: { failed: true, unreachable: true },
    });
    // Its step on the canvas.
    fireEvent.click(view.getByRole('button', { name: 'A step' }));
    expect(posted.at(-1)).toEqual({ type: 'afs-reveal', node: VALIDATE });
  });

  it('hears the canvas: the step chosen, the points it has, and F5 from inside the frame', async () => {
    width(1440);
    render(<Bench step={paused} />);
    const say = (data: Record<string, unknown>) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data,
            origin: window.location.origin,
            source: frame.contentWindow,
          }),
        );
      });
    say({ type: 'afs-points', points: [VALIDATE, { node: PUSH, condition: 'vlan_id == 210' }] });
    expect(await screen.findByText('if vlan_id == 210')).toBeTruthy();
    say({ type: 'afs-node-selected', node: PUSH });
    const row = screen.getByText('if vlan_id == 210').closest('li') as HTMLElement;
    expect(row.getAttribute('aria-current')).toBe('true');
    say({ type: 'afs-debug-key', key: 'F5', shift: false });
    await waitFor(() => expect(commands).toEqual([{ command: 'continue' }]));
    // The canvas asks again when it is ready: it hears the toolbar is the page's.
    posted = [];
    say({ type: 'afs-canvas-ready' });
    expect(posted).toContainEqual({ type: 'afs-host-toolbar', on: true });
  });

  it('F5 continues, Shift+F5 stops, Ctrl+Shift+D folds the side bar and opens it again', async () => {
    width(1440);
    render(<Bench step={paused} />);
    fireEvent.keyDown(document, { key: 'F5' });
    await waitFor(() => expect(commands).toEqual([{ command: 'continue' }]));
    fireEvent.keyDown(document, { key: 'F5', shiftKey: true });
    await waitFor(() => expect(commands.at(-1)).toEqual({ command: 'stop' }));
    const side = document.getElementById('wb-side') as HTMLElement;
    expect(side.hidden).toBe(false);
    fireEvent.keyDown(document, { key: 'D', ctrlKey: true, shiftKey: true });
    expect(side.hidden).toBe(true);
    fireEvent.keyDown(document, { key: 'D', ctrlKey: true, shiftKey: true });
    expect(side.hidden).toBe(false);
  });

  it('a reader has no toolbar and tells the canvas nothing of a toolbar', () => {
    width(1440);
    render(<Bench step={paused} mayDrive={false} />);
    expect(screen.queryByRole('toolbar', { name: 'Debug' })).toBeNull();
    expect(posted).toContainEqual({ type: 'afs-host-toolbar', on: false });
    expect(posted).not.toContainEqual({ type: 'afs-host-toolbar', on: true });
  });
});

describe('the layout', () => {
  const at = (px: number) => {
    width(px);
    render(<Bench step={paused} />);
    return document.querySelector('[data-workbench]') as HTMLElement;
  };
  it('1440: the side bar beside the canvas, resizable, and the panel under it', () => {
    const bench = at(1440);
    expect(bench.className).toContain('wb-wide');
    expect((document.getElementById('wb-side') as HTMLElement).hidden).toBe(false);
    expect(screen.getByRole('separator', { name: 'Side bar width' })).toBeTruthy();
    expect(screen.getByRole('separator', { name: 'Panel height' })).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: 'Parts of the debugger' })).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Side bar views' })).toBeTruthy();
  });
  it('1024: the side bar over the canvas, opened at the pause, with no splitter beside it', async () => {
    const bench = at(1024);
    expect(bench.className).toContain('wb-overlay');
    await waitFor(() =>
      expect((document.getElementById('wb-side') as HTMLElement).hidden).toBe(false),
    );
    // The activity bar folds it away to see the canvas.
    fireEvent.click(screen.getByRole('button', { name: 'Run and Debug' }));
    expect((document.getElementById('wb-side') as HTMLElement).hidden).toBe(true);
    expect((document.getElementById('wb-canvas') as HTMLElement).hidden).toBe(false);
  });
  it('390: tabs Flow, Debug and Console; the toolbar and the status line stay', () => {
    const bench = at(390);
    expect(bench.className).toContain('wb-phone');
    const tabs = screen.getByRole('tablist', { name: 'Parts of the debugger' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Flow', 'Debug', 'Console']);
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.getByRole('toolbar', { name: 'Debug' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Paused after Push baseline');
  });
});

describe('AFS-266: the toolbar over the canvas', () => {
  it('is icons only, each with its name and its key, floating over the canvas', async () => {
    width(1440);
    render(<Bench step={paused} />);
    const bar = screen.getByRole('toolbar', { name: 'Debug' });
    const buttons = within(bar).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Continue',
      'Step',
      'Retry',
      'Stop',
    ]);
    expect(bar.textContent?.trim()).toBe('');
    expect(buttons.map((b) => b.getAttribute('title'))).toEqual([
      'Continue (F5)',
      'Step over (F10)',
      'Retry the step (like Restart Frame): runs Push baseline again on sw-edge-02. Changes on hosts are not undone.',
      'Stop (Shift+F5)',
    ]);
    // Over the canvas, not in a row above it; the reason is said once, in the status line.
    expect(document.getElementById('wb-canvas')?.contains(bar)).toBe(true);
    expect(document.querySelector('.wb-bar')).toBeNull();
    expect(screen.getAllByText(/Paused after Push baseline/)).toHaveLength(1);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Continue' })),
    );
  });

  it('has Retry at a failure pause only', () => {
    width(1440);
    render(<Bench step={{ ...paused, paused: { ...pause, kind: 'point', failed: [] } }} />);
    const bar = screen.getByRole('toolbar', { name: 'Debug' });
    expect(within(bar).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Continue', 'Step', 'Stop']);
  });

  it('while the run goes: Pause, and Step that waits for a pause', () => {
    width(1440);
    render(<Bench step={running} />);
    const bar = screen.getByRole('toolbar', { name: 'Debug' });
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Pause', 'Step', 'Stop']);
    expect(within(bar).getByRole('button', { name: 'Step' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('on a phone it stays in sight above the tabs', () => {
    width(390);
    render(<Bench step={paused} />);
    const bar = screen.getByRole('toolbar', { name: 'Debug' });
    expect(document.getElementById('wb-canvas')?.contains(bar)).toBe(false);
  });
});

describe('AFS-266: folding the side bar and the panel', () => {
  const side = () => document.getElementById('wb-side') as HTMLElement;
  const consoleBody = () => document.getElementById('wb-panel-console') as HTMLElement;

  it('Ctrl+B folds the side bar to its activity bar and opens it, and the choice is kept', () => {
    width(1440);
    const first = render(<Bench step={running} />);
    expect(side().hidden).toBe(false);
    fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
    expect(side().hidden).toBe(true);
    expect(screen.getByRole('navigation', { name: 'Side bar views' })).toBeTruthy();
    expect(window.localStorage.getItem('afs.workbench.sideFolded')).toBe('1');
    first.unmount();
    render(<Bench step={running} />);
    expect(side().hidden).toBe(true);
    // The active view's icon opens it again, as in VS Code.
    fireEvent.click(screen.getByRole('button', { name: 'Run and Debug' }));
    expect(side().hidden).toBe(false);
    expect(window.localStorage.getItem('afs.workbench.sideFolded')).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: 'Run and Debug' }));
    expect(side().hidden).toBe(true);
  });

  it('Ctrl+Shift+D folds it and is kept too; a pause opens it, without changing what is kept', async () => {
    width(1440);
    const page = render(<Bench step={running} />);
    fireEvent.keyDown(document, { key: 'D', ctrlKey: true, shiftKey: true });
    expect(side().hidden).toBe(true);
    expect(window.localStorage.getItem('afs.workbench.sideFolded')).toBe('1');
    page.rerender(<Bench step={paused} />);
    await waitFor(() => expect(side().hidden).toBe(false));
    expect(window.localStorage.getItem('afs.workbench.sideFolded')).toBe('1');
  });

  it('Ctrl+J and the chevron fold the panel to its tab strip; a tab opens it; kept', () => {
    width(1440);
    const first = render(<Bench step={paused} />);
    expect(consoleBody().hidden).toBe(false);
    fireEvent.keyDown(document, { key: 'j', ctrlKey: true });
    expect(consoleBody().hidden).toBe(true);
    // The strip stays, and the splitter goes.
    expect(screen.getByRole('tablist', { name: 'Panel views' })).toBeTruthy();
    expect(screen.queryByRole('separator', { name: 'Panel height' })).toBeNull();
    const chevron = screen.getByRole('button', { name: 'Unfold the panel' });
    expect(chevron.getAttribute('aria-expanded')).toBe('false');
    expect(chevron.getAttribute('title')).toBe('Unfold the panel (Ctrl+J)');
    expect(window.localStorage.getItem('afs.workbench.panelFolded')).toBe('1');
    first.unmount();
    render(<Bench step={paused} />);
    expect(consoleBody().hidden).toBe(true);
    // A tab of a folded panel opens it.
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect((document.getElementById('wb-panel-terminal') as HTMLElement).hidden).toBe(false);
    expect(window.localStorage.getItem('afs.workbench.panelFolded')).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: 'Fold the panel' }));
    expect((document.getElementById('wb-panel-terminal') as HTMLElement).hidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Unfold the panel' }));
    expect((document.getElementById('wb-panel-terminal') as HTMLElement).hidden).toBe(false);
  });

  it('Watch adds with Enter and Evaluate evaluates with Enter: no text buttons', async () => {
    width(1440);
    render(<Bench step={paused} />);
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Evaluate' })).toBeNull();
    const box = await screen.findByLabelText('Jinja expression to evaluate');
    expect(box.getAttribute('placeholder')).toContain('Shift+Enter');
  });
});

/** A stand-in for the browser's EventSource: the test says what the server sends. */
class FakeStream {
  static all: FakeStream[] = [];
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeStream.all.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
}

describe("a debug run on the flow's page", () => {
  it('opens the workbench in place around the same canvas, fed by one stream', async () => {
    width(1440);
    FakeStream.all = [];
    vi.stubGlobal('EventSource', FakeStream);
    const project = {
      id: 'p1',
      workspace: 'w1',
      key: 'edge',
      name: 'Edge',
      gitRef: 'main',
      commit: run.commit,
      sync: { state: 'ok' },
    };
    const routes: Record<string, unknown> = {
      'GET /workspaces/net/projects': [project],
      'GET /projects/p1/flows': { flows: [{ file: FILE, name: 'Edge baseline', ok: true }] },
      'GET /projects/p1/drafts': [],
      'GET /projects/p1/launch-configs': [],
      'GET /projects/p1/access': { admin: false, workspace: 'rw', approve: false, flows: {} },
      'GET /runs/r1': run,
      'GET /projects/p1/watches?path=flows%2Fedge-baseline.flow.yaml': { exprs: [] },
    };
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
      const body = key.startsWith('GET /runs?') ? [] : routes[key];
      return {
        ok: body !== undefined,
        status: body !== undefined ? 200 : 404,
        json: async () => body ?? { message: 'no' },
      } as Response;
    });
    render(
      <FlowPage me={{ login: 'dana' }} workspace="net" project="edge" file={FILE} theme="dark" />,
    );
    const canvas = (await screen.findByTitle(/on the designer's canvas/)) as HTMLIFrameElement;
    expect(canvas.getAttribute('src')).toContain('&feed=1');
    expect(document.querySelector('[data-workbench]')?.className).toContain('wb-off');
    expect(screen.queryByRole('toolbar', { name: 'Debug' })).toBeNull();
    const frameWindow = canvas.contentWindow as Window;
    const sent: Record<string, unknown>[] = [];
    vi.spyOn(frameWindow, 'postMessage').mockImplementation((m: unknown) => {
      sent.push(m as Record<string, unknown>);
    });
    const fromCanvas = (data: Record<string, unknown>) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data,
            origin: window.location.origin,
            source: frameWindow,
          }),
        );
      });
    // The canvas launched a debug run and shows it: the page follows it, once.
    fromCanvas({ type: 'afs-run-started', id: 'r1' });
    fromCanvas({ type: 'afs-watch-run', id: 'r1' });
    await waitFor(() => expect(FakeStream.all).toHaveLength(1));
    const stream = FakeStream.all[0] as FakeStream;
    expect(stream.url).toBe('/api/v1/runs/r1/events');
    act(() => {
      stream.emit('run', run);
      stream.emit('view', { state: 'running', step: paused });
    });
    expect(await screen.findByRole('toolbar', { name: 'Debug' })).toBeTruthy();
    // The same frame: the canvas was not loaded again.
    expect(screen.getByTitle(/on the designer's canvas/)).toBe(canvas);
    expect(document.querySelector('[data-workbench]')?.className).not.toContain('wb-off');
    // The canvas got the run's events from the page, and left its buttons to the toolbar.
    await waitFor(() =>
      expect(sent.filter((m) => m.type === 'afs-run-event').map((m) => m.kind)).toEqual([
        'run',
        'view',
      ]),
    );
    expect(sent).toContainEqual({ type: 'afs-host-toolbar', on: true });
    expect(screen.getByRole('status').textContent).toContain('Paused after Push baseline');
    expect(screen.getByRole('link', { name: "The run's page" }).getAttribute('href')).toBe(
      '/runs/r1',
    );
    expect(FakeStream.all).toHaveLength(1);
  });
});
