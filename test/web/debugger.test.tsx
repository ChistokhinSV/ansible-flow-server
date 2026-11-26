// AFS-179: the debugger of a debug run, in the debug workbench's views (AFS-265): the reason line,
// Retry with its warning, the Hosts view at the first failed host, scopes read lazily, Watch with
// compare across hosts, the Debug Console (Enter, Ctrl+Enter), masked values with their reason;
// read-only for others watching.
import type { InspectAnswer, StepPause } from '@ansible-flow/core/run/step';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run } from '../../src/web/api';
import {
  answerText,
  bare,
  compareHosts,
  entryText,
  firstHost,
  hostOrder,
  keptHosts,
  reasonLine,
  shownValue,
  stoppedLine,
} from '../../src/web/debugger';
import type { ShownStep } from '../../src/web/stepBar';
import { DebugWorkbench, useWorkbenchState } from '../../src/web/workbench';

/** The debugger's views in the workbench, as a run's page has them. */
function DebugPanel(props: {
  run: Run;
  step: ShownStep | undefined;
  mayDrive: boolean;
  mayStop?: boolean;
  launcher: string;
  onRun(run: Run): void;
  onError(message: string | undefined): void;
}) {
  const state = useWorkbenchState(true);
  return (
    <DebugWorkbench
      {...props}
      debug
      going
      state={state}
      frame={() => null}
      canvas={<div />}
      terminal={<p>No output.</p>}
      sizeKey="test"
    />
  );
}

const APPLY = '01JZAPPLY0000000000000000A';
const pause: StepPause = {
  id: 'p-1',
  node: APPLY,
  play: '[apply] Apply config',
  hosts: ['edge-01', 'edge-02', 'edge-03', 'core-01', 'core-02', 'lb-01'],
  since: 1000,
  timeout: 3600,
  kind: 'failure',
  failed: [{ host: 'edge-02', task: 'Push the VLAN', msg: 'VLAN 210 is in use' }],
  attempt: 1,
  debug: true,
};
const run = {
  id: 'r1',
  number: 412,
  project: 'p1',
  flow: { file: 'flows/edge.flow.yaml', key: 'edge', name: 'Edge change', version: 3 },
  mode: 'check',
  state: 'running',
  requestedBy: { id: 'u1', login: 'dana' },
  step: { every: false, points: [APPLY], timeoutS: 3600, debug: true },
  pausedBefore: 'Apply config',
} as unknown as Run;
const step = { every: false, points: [APPLY], pauses: 1, debug: true, paused: pause } as ShownStep;

let asked: Record<string, unknown>[];
let answers: (ask: Record<string, unknown>) => InspectAnswer;
let commands: unknown[];
beforeEach(() => {
  asked = [];
  commands = [];
  window.localStorage.clear();
  answers = (a) => {
    if (a.op === 'scopes')
      return {
        host: String(a.host),
        scopes: [
          { id: 'inputs', name: 'Step inputs', vars: [{ name: 'vlan_id', type: 'int' }] },
          { id: 'host', name: 'Host variables' },
          { id: 'facts', name: 'Facts', expensive: true },
        ],
      };
    if (a.op === 'vars')
      return {
        children: [
          { name: 'vlan_id', type: 'int', value: 210 },
          { name: 'admin_password', type: 'masked', masked: 'credential' },
          { name: 'api_token', type: 'masked', masked: 'external' },
        ],
      };
    if (a.op === 'watch')
      return {
        results: pause.hosts.map((host) => ({
          host,
          expr: 'vlan_id',
          value: host === 'edge-02' ? 210 : 200,
        })),
      };
    if (a.op === 'eval')
      return String(a.expr).includes('lookup')
        ? { refused: true, error: 'lookups are not allowed in Evaluate' }
        : { value: 0, type: 'int' };
    return { error: 'unknown' };
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith('/inspect')) {
      asked.push(body);
      return { ok: true, status: 200, json: async () => answers(body) } as Response;
    }
    if (url.endsWith('/step')) {
      commands.push(body);
      return { ok: true, status: 202, json: async () => ({ ...run, sent: body.command }) };
    }
    return { ok: false, status: 404, json: async () => ({ message: 'no' }) } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('words', () => {
  it('the reason line names the step, the hosts and why', () => {
    expect(reasonLine(pause, 'Apply config', 1000_000)).toBe(
      'Paused after Apply config: 1 of 6 hosts failed (attempt 1) · stops by itself in 60 min',
    );
    expect(
      reasonLine({ ...pause, kind: 'condition', matched: ['edge-03'] }, 'Apply config', 1000_000),
    ).toContain('condition held on edge-03 (1 of 6 hosts)');
    expect(reasonLine({ ...pause, kind: 'point' }, 'Apply config', 1000_000)).toContain(
      'Paused before Apply config · pause point · 6 hosts',
    );
    expect(
      reasonLine(
        { ...pause, failed: [{ host: 'lb-01', task: 't', msg: 'm', unreachable: true }] },
        'X',
        1000_000,
      ),
    ).toContain('1 of 6 hosts unreachable');
  });

  it('starts at the first failed or matching host, failed first in the list', () => {
    expect(firstHost(pause)).toBe('edge-02');
    expect(firstHost({ ...pause, failed: [], matched: ['core-01'] })).toBe('core-01');
    expect(hostOrder(pause)[0]).toEqual({ host: 'edge-02', note: 'failed' });
  });

  it('masked values say why, never their size; cut values say where', () => {
    expect(entryText({ name: 'p', type: 'masked', masked: 'external' })).toBe(
      'masked: external secret',
    );
    expect(entryText({ name: 'v', type: 'str', value: 'abc', cut: 65536 })).toBe(
      '"abc"… (cut at 3 bytes of 64 KB)',
    );
    expect(entryText({ name: 'd', type: 'dict', count: 3 })).toBe('{…} 3 items');
    expect(shownValue({ a: { __afd__: 'masked', masked: 'vault' }, b: 1 })).toBe(
      '{"a":"masked: vault","b":1}',
    );
    expect(answerText({ refused: true, error: 'lookups are not allowed in Evaluate' }).text).toBe(
      'Refused: lookups are not allowed in Evaluate',
    );
    expect(answerText({ timeout: true }).text).toContain('longer than 2 s');
    expect(bare('{{ vlan_id }}')).toBe('vlan_id');
  });

  it('compare across hosts groups them by value', () => {
    expect(
      compareHosts([
        { host: 'a', value: 1 },
        { host: 'b', value: 2 },
        { host: 'c', value: 1 },
      ]),
    ).toEqual([
      { value: '1', hosts: ['a', 'c'] },
      { value: '2', hosts: ['b'] },
    ]);
  });
});

describe('the panel', () => {
  it('drives a failure pause: Retry warns, scopes open lazily, watch compares, Ctrl+Enter evaluates', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <DebugPanel
        run={run}
        step={step}
        mayDrive
        launcher="Dana"
        onRun={() => undefined}
        onError={() => undefined}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('1 of 6 hosts failed (attempt 1)');
    expect(screen.getByText(/Changes on hosts are not undone/).textContent).toBe(
      'Retry runs Apply config again on edge-02. Changes on hosts are not undone.',
    );
    // The Hosts view starts at the failed host, and the failure is said.
    const hosts = screen.getByRole('list', { name: 'Hosts at the pause' });
    expect(
      within(hosts)
        .getAllByRole('button')
        .map((b) => b.getAttribute('data-debug-host')),
    ).toEqual(['edge-02', 'edge-01', 'edge-03', 'core-01', 'core-02', 'lb-01']);
    expect(
      within(hosts)
        .getByRole('button', { name: /edge-02/ })
        .getAttribute('aria-current'),
    ).toBe('true');
    expect(screen.getByText(/VLAN 210 is in use/)).toBeTruthy();
    await screen.findByText('Step inputs');
    expect(asked[0]).toEqual({ op: 'scopes', host: 'edge-02' });
    // A scope's values are read when it opens.
    const inputs = screen.getByText('Step inputs').closest('details') as HTMLDetailsElement;
    inputs.open = true;
    fireEvent(inputs, new Event('toggle'));
    expect(await screen.findByText('masked: credential')).toBeTruthy();
    expect(screen.getByText('masked: external secret')).toBeTruthy();
    expect(asked.at(-1)).toEqual({
      op: 'vars',
      host: 'edge-02',
      scope: 'inputs',
      path: [],
      start: 0,
      count: 100,
    });
    // Watch: added, its value for this host, and compared across hosts.
    fireEvent.change(screen.getByLabelText('Expression to watch'), {
      target: { value: '{{ vlan_id }}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(asked.at(-1)).toEqual({ op: 'watch', exprs: ['vlan_id'] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Compare vlan_id across hosts' }));
    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('row')
        .map((r) => r.textContent),
    ).toEqual(['200edge-01, edge-03, core-01, core-02, lb-01', '210edge-02']);
    // Evaluate with Ctrl+Enter; a refusal says why.
    const box = screen.getByLabelText('Jinja expression to evaluate');
    fireEvent.change(box, { target: { value: "lookup('pipe', 'id')" } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect((await screen.findByText(/^Refused:/)).textContent).toBe(
      'Refused: lookups are not allowed in Evaluate',
    );
    // Retry asks first, then reaches the run.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(commands).toEqual([{ command: 'retry' }]));
    expect(confirm.mock.calls[0]?.[0]).toContain('Changes it made on them are not undone');
    // F8 continues.
    fireEvent.keyDown(document, { key: 'F8' });
    await waitFor(() => expect(commands.at(-1)).toEqual({ command: 'continue' }));
  });

  it('others watching see the reason line and who drives it, nothing else', () => {
    render(
      <DebugPanel
        run={run}
        step={step}
        mayDrive={false}
        launcher="Dana"
        onRun={() => undefined}
        onError={() => undefined}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain(
      'Paused by Dana: only Dana or an administrator drives it',
    );
    expect(within(screen.getByRole('toolbar', { name: 'Debug' })).queryAllByRole('button')).toEqual(
      [],
    );
    expect(screen.queryByRole('list', { name: 'Hosts at the pause' })).toBeNull();
    expect(screen.queryByLabelText('Jinja expression to evaluate')).toBeNull();
    expect(asked).toEqual([]);
  });
});

// Round 1 of the 1.2 exploration (AFS-249, AFS-250, AFS-253).
describe('AFS-249: the panel words', () => {
  it('names the hosts a condition held on; a point with no match or a count is a pause point', () => {
    const cond = { ...pause, kind: 'condition' as const, failed: [] };
    expect(
      reasonLine(
        { ...cond, matched: ['edge-01', 'edge-02', 'edge-03', 'core-01', 'core-02'] },
        'X',
        1000_000,
      ),
    ).toContain('condition held on edge-01, edge-02, edge-03 and 2 more (5 of 6 hosts)');
    // "Always, after 3 arrivals" and a Step that lands on a point: not "condition held on 0".
    const line = reasonLine({ ...cond, matched: [] }, 'Validate', 1000_000, { hits: 3 });
    expect(line).toContain('Paused before Validate · pause point, after 3 arrivals · 6 hosts');
    expect(line).not.toContain('condition');
  });

  it('a run stopped at a failure pause: the failed hosts, and the others stopped after it', () => {
    expect(
      stoppedLine(
        {
          node: APPLY,
          hosts: ['edge-01', 'edge-02', 'edge-03', 'core-01'],
          reason: 'driver',
          after: true,
          failed: [{ host: 'edge-02' }],
        },
        'Push baseline',
      ),
    ).toBe('Stopped after Push baseline · 1 host failed, 3 stopped after it');
    expect(stoppedLine({ node: APPLY, hosts: ['a', 'b'], reason: 'timeout' }, 'Validate')).toBe(
      'Stopped before Validate · 2 hosts (nobody answered the pause)',
    );
  });

  it('after a Retry the pause still counts all the hosts it holds', () => {
    const retried = { ...pause, hosts: ['edge-02'], attempt: 2 };
    expect(reasonLine(retried, 'Apply config', 1000_000, { hosts: pause.hosts })).toContain(
      '1 of 6 hosts failed (attempt 2)',
    );
    expect(hostOrder(retried, pause.hosts).map((h) => h.host)).toEqual([
      'edge-02',
      'edge-01',
      'edge-03',
      'core-01',
      'core-02',
      'lb-01',
    ]);
  });

  it('a template shows its text; a cut value says where it was cut and its whole size', () => {
    expect(
      entryText({
        name: 'site',
        type: 'template',
        value: { __afd__: 'template', text: '{{ x }}' },
      }),
    ).toBe('{{ x }} (template, not rendered)');
    expect(entryText({ name: 's', type: 'str', value: 'a'.repeat(65536), cut: 168889 })).toMatch(
      /… \(cut at 64 KB of 164\.9 KB\)$/,
    );
  });

  it('Evaluate says lookups are not allowed, and an expression left open is said so', () => {
    expect(
      answerText({
        refused: true,
        error: 'lookup() is not allowed while debugging: it can read or run things',
      }).text,
    ).toBe('Refused: lookups are not allowed in Evaluate');
    expect(
      answerText({ refused: true, error: "Not a Jinja expression: unexpected '}'" }).text,
    ).toBe('Not a complete expression: a bracket or a quote is not closed');
    // AFS-258: a syntax error is not a refusal, whatever the run calls it.
    expect(
      answerText({ refused: true, error: 'Not a Jinja expression: unexpected the end' }).text,
    ).toBe('Not a complete expression: a bracket or a quote is not closed');
    expect(answerText({ error: "A quote (') is not closed" }).text).toBe(
      'Not a complete expression: a bracket or a quote is not closed',
    );
    expect(
      answerText({ refused: true, error: 'The password filter is not allowed while debugging' })
        .text,
    ).toBe('Refused: The password filter is not allowed in Evaluate');
    // Braces typed on one side only go, so the run is not told about braces.
    expect(bare('{{ foo(')).toBe('foo(');
    expect(bare('foo }}')).toBe('foo');
    expect(bare("{{ '{{' }}")).toBe("'{{'");
  });

  it('a finished run shows the values its pauses showed, each watch once', () => {
    const kept = keptHosts({
      pause: 'p1',
      node: APPLY,
      play: '[apply] Apply config',
      entries: [
        {
          op: 'scopes',
          host: 'edge-02',
          at: '2026-11-24T10:00:00.000Z',
          answer: {
            scopes: [
              {
                id: 'inputs',
                name: 'Step inputs',
                vars: [
                  { name: 'site', type: 'str', size: 7 },
                  { name: 'afd_repo_root', type: 'str', size: 9 },
                ],
              },
              { id: 'host', name: 'Host variables', vars: [{ name: 'vlan_id', type: 'int' }] },
            ],
          },
        },
        {
          op: 'vars',
          host: 'edge-02',
          scope: 'inputs',
          at: '2026-11-24T10:00:01.000Z',
          answer: {
            children: [
              { name: 'site', type: 'str', value: 'local' },
              { name: 'afd_repo_root', type: 'str', value: '/runner' },
            ],
          },
        },
        {
          op: 'watch',
          exprs: ['vlan_id'],
          at: '2026-11-24T10:00:02.000Z',
          answer: { results: [{ host: 'edge-02', expr: 'vlan_id', value: 200 }] },
        },
        {
          op: 'watch',
          exprs: ['vlan_id', 'site'],
          at: '2026-11-24T10:00:03.000Z',
          answer: {
            results: [
              { host: 'edge-02', expr: 'vlan_id', value: 210 },
              { host: 'edge-02', expr: 'site', value: 'local' },
            ],
          },
        },
      ],
    });
    expect(kept).toHaveLength(1);
    const [edge] = kept;
    const inputs = edge?.scopes.find((s) => s.id === 'inputs');
    expect(inputs?.opened).toBe(true);
    expect(inputs?.vars.map((v) => entryText(v))).toEqual(['"local"']);
    expect(edge?.scopes.find((s) => s.id === 'host')?.opened).toBe(false);
    expect(edge?.watches.map((w) => `${w.expr}=${answerText(w.answer).text}`)).toEqual([
      'vlan_id=210',
      'site="local"',
    ]);
  });
});

describe('AFS-250, AFS-253: watches per person, keys, Stop for an operator, log points', () => {
  let kept: string[][];
  beforeEach(() => {
    kept = [];
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (url.includes('/watches?path=')) {
        if (init.method === 'PUT') {
          const body = JSON.parse(String(init.body));
          kept.push(body.exprs);
          return { ok: true, status: 200, json: async () => body } as Response;
        }
        return { ok: true, status: 200, json: async () => ({ exprs: ['site'] }) } as Response;
      }
      return inner(url, init);
    });
  });

  it("reads this person's watches from the server and keeps changes there, not in the browser", async () => {
    window.localStorage.setItem('afs.watch.p1.flows/edge.flow.yaml', '["mias_expr"]');
    render(
      <DebugPanel
        run={run}
        step={step}
        mayDrive
        launcher="Dana"
        onRun={() => undefined}
        onError={() => undefined}
      />,
    );
    expect(await screen.findByText('{{ site }}')).toBeTruthy();
    expect(screen.queryByText('{{ mias_expr }}')).toBeNull();
    expect(window.localStorage.getItem('afs.watch.p1.flows/edge.flow.yaml')).toBeNull();
    fireEvent.change(screen.getByLabelText('Expression to watch'), {
      target: { value: 'vlan_id' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(kept).toEqual([['site', 'vlan_id']]));
    expect(window.localStorage.length).toBe(0);
  });

  it('F10 steps while the focus is in the Evaluate box', async () => {
    render(
      <DebugPanel
        run={run}
        step={{ ...step, paused: { ...pause, kind: 'point', failed: [] } }}
        mayDrive
        launcher="Dana"
        onRun={() => undefined}
        onError={() => undefined}
      />,
    );
    const box = screen.getByLabelText('Jinja expression to evaluate');
    box.focus();
    fireEvent.keyDown(box, { key: 'F10' });
    await waitFor(() => expect(commands).toEqual([{ command: 'step' }]));
  });

  it('an operator who does not drive it has Stop, asked first, and nothing else', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <DebugPanel
        run={run}
        step={step}
        mayDrive={false}
        mayStop
        launcher="Dana"
        onRun={() => undefined}
        onError={() => undefined}
      />,
    );
    const toolbar = screen.getByRole('toolbar', { name: 'Debug' });
    expect(
      within(toolbar)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Stop']);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(commands).toEqual([{ command: 'stop' }]));
    expect(confirm.mock.calls[0]?.[0]).toContain("Stop Dana's debug run #412?");
    expect(asked).toEqual([]);
  });

  it("shows the log points' lines, and leaves the engine's own variables out of the inputs", async () => {
    answers = (a) =>
      a.op === 'scopes'
        ? {
            scopes: [
              {
                id: 'inputs',
                name: 'Step inputs',
                vars: [
                  { name: 'afd_repo_root', type: 'str' },
                  { name: 'site', type: 'template' },
                ],
              },
            ],
          }
        : {
            children: [
              { name: 'afd_repo_root', type: 'str', value: '/runner' },
              {
                name: 'site',
                type: 'template',
                value: { __afd__: 'template', text: '{{ s }}' },
              },
            ],
          };
    render(
      <DebugPanel
        run={run}
        step={{
          ...step,
          logs: [
            { node: APPLY, host: 'edge-01', message: 'c1log edge-01 site=lab', ts: 1 },
            { node: 'other', host: 'edge-02', error: "'site' is undefined", source: 'log', ts: 2 },
          ],
        }}
        mayDrive
        launcher="Dana"
        onRun={() => undefined}
        onError={() => undefined}
      />,
    );
    const logs = await screen.findByText('Log points');
    const list = logs.parentElement as HTMLElement;
    expect(within(list).getByText('c1log edge-01 site=lab')).toBeTruthy();
    expect(within(list).getByText('Apply config · edge-01')).toBeTruthy();
    expect(within(list).getByText("The message failed: 'site' is undefined")).toBeTruthy();
    const inputs = (await screen.findByText('Step inputs')).closest(
      'details',
    ) as HTMLDetailsElement;
    expect(inputs.textContent).toContain('1 variable');
    inputs.open = true;
    fireEvent(inputs, new Event('toggle'));
    expect(await screen.findByText('{{ s }} (template, not rendered)')).toBeTruthy();
    expect(screen.queryByText('afd_repo_root')).toBeNull();
  });
});

describe('AFS-258: round 2', () => {
  it('names a log point’s step from the flow, also where the run did not pause', async () => {
    const OTHER = '01JZBACKUP000000000000000B';
    const doc = {
      version: 1,
      flow: { key: 'edge', name: 'Edge change', version: 3 },
      nodes: [
        { id: APPLY, key: 'apply', type: 'task', title: 'Apply config' },
        { id: OTHER, key: 'backup', type: 'task', title: 'Backup config' },
      ],
      edges: [],
    };
    const fetched: string[] = [];
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      fetched.push(url);
      if (url.includes('/flows/view'))
        return { ok: true, status: 200, json: async () => ({ commit: 'c', snapshot: { doc } }) };
      return inner(url, init);
    });
    render(
      <DebugPanel
        run={{ ...run, commit: 'c'.repeat(40) } as Run}
        step={{ ...step, logs: [{ node: OTHER, host: 'edge-01', message: 'm1', ts: 1 }] }}
        mayDrive
        launcher="Dana"
        onRun={() => undefined}
        onError={() => undefined}
      />,
    );
    expect(await screen.findByText('Backup config · edge-01')).toBeTruthy();
    expect(fetched.some((u) => u.includes(`commit=${'c'.repeat(40)}`))).toBe(true);
  });

  it('a kept scope is named, and the engine’s own host variables are left out', () => {
    const [kept] = keptHosts({
      pause: 'p1',
      node: APPLY,
      entries: [
        {
          op: 'vars',
          host: 'edge-01',
          scope: 'host',
          at: '2026-11-24T10:00:00.000Z',
          answer: {
            children: [
              { name: 'afd_inputs', type: 'dict', count: 1 },
              { name: 'site', type: 'str', value: 'lab' },
            ],
          },
        },
      ],
    });
    expect(kept?.scopes.map((s) => [s.name, s.vars.map((v) => v.name)])).toEqual([
      ['Host variables', ['site']],
    ]);
  });

  it('the Debug Console keeps its lines and what is typed when drawn again (a width crossed)', async () => {
    const props = {
      run,
      step,
      mayDrive: true,
      launcher: 'Dana',
      onRun: () => undefined,
      onError: () => undefined,
    };
    const first = render(<DebugPanel {...props} />);
    const box = (await screen.findByLabelText(
      'Jinja expression to evaluate',
    )) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'vlan_id + 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate' }));
    await screen.findByText('0');
    // A REPL: the box is empty again, the line evaluated stays above it.
    expect(box.value).toBe('');
    expect(screen.getByText('vlan_id + 1')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'site' } });
    first.unmount();
    render(<DebugPanel {...props} />);
    expect(
      ((await screen.findByLabelText('Jinja expression to evaluate')) as HTMLTextAreaElement).value,
    ).toBe('site');
    expect(screen.getByText('0')).toBeTruthy();
    // The arrow up brings back what was evaluated.
    const again = screen.getByLabelText('Jinja expression to evaluate') as HTMLTextAreaElement;
    fireEvent.change(again, { target: { value: '' } });
    fireEvent.keyDown(again, { key: 'ArrowUp' });
    expect(again.value).toBe('vlan_id + 1');
  });

  it('the toolbar is in VS Code’s order: Continue, Step, Retry, Stop', async () => {
    render(
      <DebugPanel
        run={run}
        step={step}
        mayDrive
        launcher="Dana"
        onRun={() => undefined}
        onError={() => undefined}
      />,
    );
    await screen.findByText(/Paused after/);
    const head = screen.getByRole('toolbar', { name: 'Debug' });
    expect(
      [...head.querySelectorAll('[data-step-command]')].map((b) =>
        b.getAttribute('data-step-command'),
      ),
    ).toEqual(['continue', 'step', 'retry', 'stop']);
  });
});
