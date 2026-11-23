// AFS-179: the Debugger panel of a debug run on its page: the reason line, Retry with its warning,
// the host picker at the first failed host, scopes read lazily, Watch with compare across hosts,
// Evaluate (Ctrl+Enter), masked values with their reason; read-only for others watching.
import type { InspectAnswer, StepPause } from '@ansible-flow/core/run/step';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run } from '../../src/web/api';
import {
  answerText,
  bare,
  compareHosts,
  DebugPanel,
  entryText,
  firstHost,
  hostOrder,
  reasonLine,
  shownValue,
} from '../../src/web/debugger';
import type { ShownStep } from '../../src/web/stepBar';

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
      'Paused after Apply config · 1 of 6 hosts failed (attempt 1) · stops by itself in 60 min',
    );
    expect(
      reasonLine({ ...pause, kind: 'condition', matched: ['edge-03'] }, 'Apply config', 1000_000),
    ).toContain('condition held on 1 of 6 hosts');
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
      '"abc"… (cut at 65536 bytes)',
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
    // The host picker starts at the failed host, and the failure is said.
    expect((screen.getByLabelText(/Host/) as HTMLSelectElement).value).toBe('edge-02');
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
    fireEvent.click(await screen.findByRole('button', { name: 'Compare across hosts' }));
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
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText(/Host/)).toBeNull();
    expect(asked).toEqual([]);
  });
});
