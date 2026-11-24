// AFS-214, AFS-213, AFS-240: a run's hosts in sets (failed, unreachable, stopped, handled), where
// each went wrong, the outcome line, and the limit file a run again of some hosts gets.
import { describe, expect, it } from 'vitest';
import {
  chosenHosts,
  type FlowEdge,
  type FlowStep,
  hostSets,
  limitFile,
  limitLine,
  outcomeLine,
  stepIds,
} from '../../src/server/runs/hostSets';
import { approvalTitles, limitRisks } from '../../src/server/runs/relaunch';

const APPLY = '01JZAPPLY0000000000000000A';
const VERIFY = '01JZVERIFY000000000000000B';
const DONE = '01JZDONE00000000000000000C';
const FAILED_END = '01JZFAILED000000000000000D';
const PRE = '01JZPRE0000000000000000000';
const READ = '01JZREAD000000000000000000';
const ROLL = '01JZROLL000000000000000000';
const ROLL_STEP = '01JZROLLSTEP00000000000000';

const START = '01JZSTART00000000000000000E';
const NODES: FlowStep[] = [
  { id: START, key: 'start', title: 'Start', type: 'start' },
  { id: APPLY, key: 'apply-config', title: 'Apply config', type: 'task' },
  { id: VERIFY, key: 'verify', title: 'Verify', type: 'task' },
  {
    id: PRE,
    key: 'pre',
    title: 'Pre-checks',
    type: 'subflow',
    subflow: { nodes: [{ id: READ, key: 'read', title: 'Read status', type: 'task' }] },
  },
  {
    id: ROLL,
    key: 'upgrade',
    title: 'Upgrade',
    type: 'subflow',
    settings: { rolling: 2 },
    subflow: { nodes: [{ id: ROLL_STEP, key: 'reboot', title: 'Reboot', type: 'task' }] },
  },
  { id: DONE, key: 'done', title: 'Done', type: 'end' },
  { id: FAILED_END, key: 'stopped', title: 'Stopped', type: 'end' },
];

/** Start, Apply config, Verify, Done; Apply config's failed hosts to the failed end Stopped. */
const EDGES: FlowEdge[] = [
  { from: { node: START, port: 'ok_hosts' }, to: { node: APPLY, port: 'in' } },
  { from: { node: APPLY, port: 'ok_hosts' }, to: { node: VERIFY, port: 'in' } },
  { from: { node: VERIFY, port: 'ok_hosts' }, to: { node: DONE, port: 'in' } },
  { from: { node: APPLY, port: 'failed_hosts' }, to: { node: FAILED_END, port: 'in' } },
];

const hosts = Array.from(
  { length: 40 },
  (_, i) => `leaf-${String(i + 1).padStart(2, '0')}.lab.example`,
);
const [h1, h2, h3, h4] = hosts as [string, string, string, string];

/** 40 hosts: 2 failed at Apply config, 1 unreachable there, 1 handled at Verify, 36 went well. */
const VIEW = {
  summary: {
    hosts,
    nodes: {
      [DONE]: { in: hosts.slice(3) },
      [FAILED_END]: { in: [h1, h2] },
    },
    outcome: {
      [h1]: 'Stopped at [apply-config] Apply config: failed_hosts is not wired',
      [h2]: 'Stopped at [apply-config] Apply config: failed_hosts is not wired',
    },
    failures: [],
    unreachable: [h3],
    stoppedEarly: false,
    timings: { [APPLY]: { start: 1, end: 2 }, [VERIFY]: { start: 3, end: 4 } },
    problems: {
      [APPLY]: {
        [h1]: { task: '[apply-config] Push config', status: 'failed', msg: 'commit failed' },
        [h2]: { task: '[apply-config] Push config', status: 'failed', msg: 'commit failed' },
        [h3]: { task: '[apply-config] Push config', status: 'unreachable', msg: 'ssh timeout' },
      },
      [VERIFY]: { [h4]: { task: '[verify] Check BGP', status: 'failed', msg: 'peer down' } },
    },
  },
};

describe('host sets', () => {
  it('splits the hosts: failed, unreachable, handled; not-ok is the ones that did not go well', () => {
    const sets = hostSets(VIEW, NODES);
    expect(sets.total).toBe(40);
    expect(sets.failed).toEqual([
      {
        host: h1,
        node: APPLY,
        title: 'Apply config',
        task: '[apply-config] Push config',
        msg: 'commit failed',
      },
      {
        host: h2,
        node: APPLY,
        title: 'Apply config',
        task: '[apply-config] Push config',
        msg: 'commit failed',
      },
    ]);
    expect(sets.unreachable).toEqual([
      expect.objectContaining({ host: h3, node: APPLY, title: 'Apply config' }),
    ]);
    expect(sets.stopped).toEqual([]);
    expect(sets.handled).toEqual([expect.objectContaining({ host: h4, title: 'Verify' })]);
    expect(sets.notOk).toEqual([h1, h2, h3]);
    expect(outcomeLine(sets)).toBe(
      '3 of 40 hosts did not go well: 2 failed at Apply config, 1 unreachable; 1 more had a failure the flow handled',
    );
    expect(chosenHosts(sets, 'not-ok')).toEqual([h1, h2, h3]);
    expect(chosenHosts(sets, 'failed')).toEqual([h1, h2]);
    expect(chosenHosts(sets, 'unreachable')).toEqual([h3]);
    expect(chosenHosts(sets, 'not-ok', true)).toEqual([h1, h2, h3, h4]);
  });

  it('names the inner step of a subflow, and a rolling subflow as a whole', () => {
    const view = {
      summary: {
        hosts: ['fw-a', 'fw-b'],
        nodes: {},
        outcome: { 'fw-a': 'x' },
        failures: [{ host: 'fw-b', node: ROLL_STEP, task: '[reboot] Reboot' }],
        unreachable: [],
        stoppedEarly: false,
        problems: {
          [READ]: { 'fw-a': { task: '[read] Read', status: 'failed' } },
          [ROLL_STEP]: { 'fw-b': { task: '[reboot] Reboot', status: 'failed' } },
        },
      },
    };
    const sets = hostSets(view, NODES);
    expect(sets.failed.map((f) => [f.host, f.node, f.title])).toEqual([
      ['fw-b', ROLL, 'Upgrade'],
      ['fw-a', READ, 'Read status'],
    ]);
    expect(stepIds(NODES).has(ROLL_STEP)).toBe(true);
  });

  it('counts hosts of a stopped run that reached no end as stopped, with where it stopped', () => {
    const view = {
      summary: {
        hosts: ['fw-a', 'fw-b', 'fw-c'],
        nodes: { [VERIFY]: { ok_hosts: ['fw-c'] } },
        outcome: {},
        failures: [],
        unreachable: [],
        stoppedEarly: true,
      },
      step: { stopped: { node: APPLY, hosts: ['fw-a', 'fw-b'] } },
    };
    const sets = hostSets(view, NODES, true, EDGES);
    expect(sets.stopped.map((s) => [s.host, s.title])).toEqual([
      ['fw-a', 'Apply config'],
      ['fw-b', 'Apply config'],
    ]);
    expect(outcomeLine(sets)).toBe(
      '2 of 3 hosts did not go well: 2 stopped before the end (before Apply config)',
    );
    // Without the flow's wires, every host that did not fail in a stopped run counts as stopped.
    expect(hostSets(view, NODES, true).notOk).toEqual(['fw-a', 'fw-b', 'fw-c']);
  });

  it('AFS-247: a finished run whose hosts reached a success end went well', () => {
    // As the designer's summary has it: ports hosts left by; nothing "leaves" an end.
    const hello = {
      summary: {
        hosts: ['localhost'],
        nodes: { [APPLY]: { ok_hosts: ['localhost'] }, [VERIFY]: { ok_hosts: ['localhost'] } },
        outcome: {},
        failures: [],
        unreachable: [],
        stoppedEarly: false,
      },
    };
    for (const sets of [hostSets(hello, NODES, false, EDGES), hostSets(hello, NODES)]) {
      expect(sets.notOk).toEqual([]);
      expect(sets.stopped).toEqual([]);
      expect(outcomeLine(sets)).toBe('The host went well');
    }
    // A partly failed run: only the host that failed did not go well.
    const edge = {
      summary: {
        hosts: ['sw-1', 'sw-2', 'sw-3', 'sw-4'],
        nodes: {
          [APPLY]: { ok_hosts: ['sw-1', 'sw-3', 'sw-4'], failed_hosts: ['sw-2'] },
          [VERIFY]: { ok_hosts: ['sw-1', 'sw-3', 'sw-4'] },
        },
        outcome: { 'sw-2': 'Stopped at [stopped] Stopped' },
        failures: [],
        unreachable: [],
        stoppedEarly: false,
        problems: { [APPLY]: { 'sw-2': { task: '[apply-config] Push', status: 'failed' } } },
      },
    };
    const sets = hostSets(edge, NODES, false, EDGES);
    expect(sets.notOk).toEqual(['sw-2']);
    expect(chosenHosts(sets, 'not-ok')).toEqual(['sw-2']);
    expect(outcomeLine(sets)).toBe('1 of 4 hosts did not go well: 1 failed at Apply config');
  });

  it('AFS-247: a host a play failed because Ansible could not reach it is unreachable', () => {
    const view = {
      summary: {
        hosts: ['ghost', 'ok'],
        nodes: {
          [APPLY]: { ok_hosts: ['ok'], failed_hosts: ['ghost'] },
          [VERIFY]: { ok_hosts: ['ok'] },
        },
        outcome: { ghost: 'Stopped at [stopped] Stopped' },
        failures: [{ host: 'ghost', node: APPLY, task: '[apply-config] Ping' }],
        unreachable: [],
        stoppedEarly: false,
        problems: {
          [APPLY]: {
            ghost: { task: '[apply-config] Ping', status: 'unreachable', msg: 'timeout' },
          },
        },
      },
    };
    const sets = hostSets(view, NODES, false, EDGES);
    expect(sets.failed).toEqual([]);
    expect(sets.unreachable.map((u) => [u.host, u.title])).toEqual([['ghost', 'Apply config']]);
    expect(chosenHosts(sets, 'unreachable')).toEqual(['ghost']);
    expect(outcomeLine(sets)).toBe('1 of 2 hosts did not go well: 1 unreachable');
  });

  it('AFS-247: a run stopped before its first step counts its waiting hosts as stopped', () => {
    const view = {
      summary: { hosts: [], nodes: {}, outcome: {}, failures: [], unreachable: [] },
      step: { stopped: { node: APPLY, hosts: ['sw-1', 'sw-2', 'sw-3', 'sw-4'] } },
    };
    const sets = hostSets(view, NODES, true, EDGES);
    expect(sets.total).toBe(4);
    expect(sets.notOk).toEqual(['sw-1', 'sw-2', 'sw-3', 'sw-4']);
    expect(outcomeLine(sets)).toBe(
      'All 4 hosts did not go well: 4 stopped before the end (before Apply config)',
    );
  });

  it('AFD-375: Stop at a failure pause: the failed host failed there, the others stopped after', () => {
    const view = {
      summary: {
        hosts: ['sw-1', 'sw-2', 'sw-3', 'sw-4'],
        nodes: { [APPLY]: { ok_hosts: ['sw-1', 'sw-3', 'sw-4'] } },
        outcome: {},
        failures: [],
        unreachable: [],
        stoppedEarly: false,
        timings: { [APPLY]: { start: 1, end: 2 } },
        problems: {
          [APPLY]: { 'sw-2': { task: '[apply-config] Push', status: 'failed', msg: 'denied' } },
        },
      },
      step: { stopped: { node: APPLY, hosts: ['sw-1', 'sw-2', 'sw-3', 'sw-4'] } },
    };
    const sets = hostSets(view, NODES, true, EDGES);
    expect(sets.failed.map((f) => [f.host, f.title, f.msg])).toEqual([
      ['sw-2', 'Apply config', 'denied'],
    ]);
    expect(sets.stopped.map((s) => [s.host, s.after])).toEqual([
      ['sw-1', true],
      ['sw-3', true],
      ['sw-4', true],
    ]);
    expect(outcomeLine(sets)).toBe(
      'All 4 hosts did not go well: 1 failed at Apply config, 3 stopped before the end (after Apply config)',
    );
  });

  it('AFD-375: the engine says a failure pause stop: failed hosts failed, others after', () => {
    const view = {
      summary: {
        hosts: ['sw-1', 'sw-2', 'sw-3'],
        nodes: {},
        outcome: {},
        failures: [],
        unreachable: [],
        stoppedEarly: false,
      },
      step: {
        stopped: {
          node: APPLY,
          after: true,
          hosts: ['sw-1', 'sw-3'],
          failed: [{ host: 'sw-2', task: '[apply-config] Push', msg: 'denied' }],
        },
      },
    };
    const sets = hostSets(view, NODES, true, EDGES);
    expect(sets.failed).toEqual([
      {
        host: 'sw-2',
        node: APPLY,
        title: 'Apply config',
        task: '[apply-config] Push',
        msg: 'denied',
      },
    ]);
    expect(sets.stopped.map((s) => [s.host, s.after])).toEqual([
      ['sw-1', true],
      ['sw-3', true],
    ]);
    expect(outcomeLine(sets)).toBe(
      'All 3 hosts did not go well: 1 failed at Apply config, 2 stopped before the end (after Apply config)',
    );
  });

  it('says a run whose hosts all went well, or all did not', () => {
    const well = hostSets(
      {
        summary: { hosts: ['a', 'b'], nodes: { [VERIFY]: { ok_hosts: ['a', 'b'] } }, outcome: {} },
      },
      NODES,
      false,
      EDGES,
    );
    expect(outcomeLine(well)).toBe('All 2 hosts went well');
    const bad = hostSets({ summary: { hosts: ['a'], outcome: {}, unreachable: ['a'] } }, NODES);
    expect(outcomeLine(bad)).toBe('The host did not go well: 1 unreachable');
    expect(outcomeLine(hostSets(undefined))).toBeUndefined();
  });
});

describe('limit file', () => {
  it('writes plain names as they are, and special ones as anchored patterns', () => {
    expect(limitLine('leaf-01.lab.example')).toBe('leaf-01.lab.example');
    expect(limitLine('2001:db8::1')).toBe('2001:db8::1');
    expect(limitLine('fw,a')).toBe('fw,a');
    expect(limitLine('localhost')).toBe('localhost');
    // A plain "!x" or "&x" would run every host of the inventory.
    expect(limitLine('!bang')).toBe('~^\\!bang$');
    expect(limitLine('&amp')).toBe('~^\\&amp$');
    expect(limitLine('@at')).toBe('~^\\@at$');
    expect(limitLine('~tilde')).toBe('~^\\~tilde$');
    expect(limitLine('web*1')).toBe('~^web\\*1$');
    expect(limitLine('q?x')).toBe('~^q\\?x$');
    expect(limitLine('r[1]')).toBe('~^r\\[1\\]$');
    expect(limitLine(' pad')).toBe('~^\\ pad$');
    expect(limitFile(['a', '!b'])).toBe('a\n~^\\!b$\n');
  });
});

describe('what a host limit changes', () => {
  it('says steps on other hosts, run_once, and percentages and batches', () => {
    const nodes = [
      {
        id: 'n1',
        key: 'report',
        title: 'Collect report',
        type: 'task',
        settings: { inventory_target: 'localhost' },
      },
      {
        id: 'n2',
        key: 'once',
        title: 'Open ticket',
        type: 'task',
        impl: { keywords: { run_once: true } },
      },
      { id: 'n3', key: 'up', title: 'Upgrade', type: 'subflow', settings: { rolling: '25%' } },
      { id: 'n4', key: 'ok', title: 'Change board', type: 'approval' },
    ];
    expect(limitRisks(nodes)).toEqual([
      'Collect report runs on localhost: the host limit skips it unless localhost is one of the hosts',
      'Open ticket runs once (run_once): only on these hosts, and it sees only them',
      'Failure percentages and rolling batches (Upgrade) count only the hosts in the limit',
    ]);
    expect(approvalTitles(nodes)).toEqual(['Change board']);
    expect(limitRisks(NODES)).toEqual([
      'Failure percentages and rolling batches (Upgrade) count only the hosts in the limit',
    ]);
  });
});
