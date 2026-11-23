// AFS-147: how a run that ended says why, in plain words.
import type { RunView } from '@ansible-flow/core/protocol';
import { describe, expect, it } from 'vitest';
import {
  exitWords,
  failedWhy,
  noHostWhy,
  pathOf,
  plainStepLine,
  skippedTarget,
  stoppedBy,
  titleOf,
} from '../../src/server/runs/words';

const nodes = [
  { id: 'n1', key: 'precheck', title: 'Pre-checks' },
  { id: 'n2', key: 'upgrade', title: 'Upgrade', subflow: { nodes: [{ id: 'n3', key: 'reboot' }] } },
];
const view = (summary: Partial<NonNullable<RunView['summary']>>): RunView =>
  ({
    id: 'r',
    mode: 'real',
    state: 'done',
    startedAt: '2026-11-18T09:00:00Z',
    summary: { hosts: [], nodes: {}, outcome: {}, failures: [], unreachable: [], ...summary },
  }) as RunView;

describe('a run in words (AFS-147)', () => {
  it('names the targets Ansible skipped', () => {
    expect(
      skippedTarget('[WARNING]: Could not match supplied host pattern, ignoring: nosuchhost'),
    ).toBe('nosuchhost');
    expect(skippedTarget('ok: [fw-edge-01]')).toBeUndefined();
  });

  it('finds a step by its id, in a subflow too', () => {
    expect(titleOf(nodes, 'n1')).toBe('Pre-checks');
    expect(titleOf(nodes, 'n3')).toBe('reboot');
    expect(titleOf(nodes, 'nope')).toBeUndefined();
  });

  it('says why no host ran: the limit, the targets, the inventory', () => {
    expect(noHostWhy({ targets: ['all'], inventory: 'inventory.ini' })).toBe(
      'No host ran: none of the targets (all) is in the inventory inventory.ini',
    );
    expect(noHostWhy({ targets: ['sw-edge-01'], limit: 'nosuchhost' })).toBe(
      'No host ran: the limit nosuchhost matched none of the targets (sw-edge-01) in the inventory',
    );
    // Every target was skipped: the limit is not the reason.
    expect(noHostWhy({ targets: ['ghost'], limit: 'ghost', skipped: ['ghost'] })).toMatch(
      /none of the targets \(ghost\) is in the inventory/,
    );
  });

  it('says how many hosts failed and where, then the exit code in words', () => {
    const failed = view({
      hosts: ['a', 'b', 'c', 'd'],
      failures: [{ host: 'b', node: 'n1', task: 'check' }] as never,
    });
    expect(failedWhy(failed, nodes, 2)).toBe(
      '1 of 4 hosts failed at Pre-checks (Ansible ended with code 2: one or more hosts failed)',
    );
    // AFS-170: a code with no known meaning is said as it is; no code, nothing.
    expect(failedWhy(failed, nodes, 7)).toBe(
      '1 of 4 hosts failed at Pre-checks (Ansible ended with code 7)',
    );
    expect(failedWhy(failed, nodes, undefined)).toBe('1 of 4 hosts failed at Pre-checks');
    expect(failedWhy(failed, nodes, 1)).toBe(
      '1 of 4 hosts failed at Pre-checks (Ansible ended with code 1: Ansible stopped on an error)',
    );
    expect(failedWhy(view({ hosts: ['a'] }), nodes, 2)).toBe(
      'One or more hosts failed (Ansible ended with code 2)',
    );
  });

  it('names hosts that could not be reached', () => {
    const v = view({
      hosts: ['a', 'b', 'c'],
      outcome: { b: 'unreachable' } as never,
      unreachable: ['b'],
    });
    expect(failedWhy(v, nodes, 4)).toBe(
      '1 of 3 hosts could not be reached: b (Ansible ended with code 4: one or more hosts could not be reached)',
    );
  });
});

describe('Ansible exit codes in words (AFS-167)', () => {
  it.each([
    [1, 'Ansible stopped on an error (Ansible ended with code 1)'],
    [2, 'One or more hosts failed (Ansible ended with code 2)'],
    [3, 'One or more hosts could not be reached (Ansible ended with code 3)'],
    [
      4,
      'Ansible could not read the playbook or the inventory, or found no host to run on (Ansible ended with code 4)',
    ],
    [5, 'Ansible was given options it does not accept (Ansible ended with code 5)'],
    [99, 'The run was interrupted (Ansible ended with code 99)'],
    [250, 'Ansible stopped on an unexpected error (Ansible ended with code 250)'],
  ])('code %i', (rc, words) => {
    expect(exitWords(rc)).toBe(words);
    // A run with no summary says the same, as do mails and the API (they carry the run's error).
    expect(failedWhy({ ...view({}), summary: undefined } as RunView, nodes, rc)).toBe(words);
  });

  it('adds the last error Ansible wrote, which names the file or the host', () => {
    expect(exitWords(4, "ERROR! the role 'baseline' was not found in /runner/project/roles")).toBe(
      "Ansible could not read the playbook or the inventory, or found no host to run on: the role 'baseline' was not found in /runner/project/roles (Ansible ended with code 4)",
    );
    expect(exitWords(3, 'fatal: [sw-edge-01]: UNREACHABLE! => {"msg": "timed out"}')).toBe(
      'One or more hosts could not be reached: fatal: [sw-edge-01]: UNREACHABLE! => {"msg": "timed out"} (Ansible ended with code 3)',
    );
  });

  it('an unknown code, or none, as it is', () => {
    expect(exitWords(7)).toBe('Ansible ended with code 7');
    expect(exitWords(7, '[ERROR]: something')).toBe('Ansible ended with code 7: something');
    expect(exitWords(undefined)).toBe('Ansible ended without an exit code');
  });

  it('says who stopped a run and during which step', () => {
    expect(stoppedBy('Stopped on request during Upgrade', 'Dana Whitfield')).toBe(
      'Stopped by Dana Whitfield during Upgrade',
    );
    expect(stoppedBy('Stopped on request', undefined)).toBe('Stopped on request');
  });
});

describe('AFS-205: step-by-step words', () => {
  it('names a step inside a subflow by its path', () => {
    expect(pathOf(nodes, 'n3')).toBe('Upgrade › reboot');
    expect(pathOf(nodes, 'n1')).toBe('Pre-checks');
    expect(pathOf(nodes, 'nx')).toBeUndefined();
  });

  it("says a pause once in plain words: an older designer's line is put in the pages' words", () => {
    expect(
      plainStepLine(
        'AFD: paused before [facts] Read a few facts (1 host(s)); waiting for the driver',
      ),
    ).toBe('Paused before Read a few facts: 1 host waits for Step, Continue or Stop');
    expect(plainStepLine('AFD: paused before [x] Push (3 host(s)); waiting for the driver')).toBe(
      'Paused before Push: 3 hosts wait for Step, Continue or Stop',
    );
    expect(plainStepLine('[WARNING]: AFD: nobody answered within 60 s; the run stops')).toBe(
      'Nobody answered the pause for 60 s: the run stops here',
    );
    expect(plainStepLine('TASK [ping] ****')).toBe('TASK [ping] ****');
  });
});
