// AFS-181: a failed end's error comes without the generated-code excerpt Ansible prints under it.
import { describe, expect, it } from 'vitest';
import { decidedOutcomes, quietEndOrigins } from '../../src/web/outputText';

const esc = String.fromCharCode(27);
const red = (line: string) => `${esc}[0;31m${line}${esc}[0m`;

/** ansible-core 2.22's output for a host a rejection sent to the failed end (fictional names). */
const ended = [
  'TASK [[end-failed] Failed] *****************************************************',
  '[ERROR]: Task failed: Action failed: Rejected at [approve] Approve. Ended at [end-failed] Failed (outcome: failed)',
  'Origin: /runner/project/generated/edge.yml:412:7',
  '',
  '410   hosts: afd_failed_end',
  '411   tasks:',
  '412     - name: "[end-failed] Failed"',
  '          ^ column 7',
  '',
  'fatal: [sw-edge-02]: FAILED! => {"changed": false, "msg": "Rejected at [approve] Approve. Ended at [end-failed] Failed (outcome: failed)"}',
  '',
  'PLAY RECAP *********************************************************************',
];

describe('quietEndOrigins', () => {
  it("leaves out the excerpt under a failed end's error, and keeps the error and the host's line", () => {
    const out = quietEndOrigins(ended.join('\n')).split('\n');
    expect(out).toEqual([ended[0], ended[1], ended[9], ended[10], ended[11]]);
  });

  it("does the same with Ansible's colours on every line", () => {
    const out = quietEndOrigins(ended.map((l) => (l ? red(l) : red(''))).join('\n'));
    expect(out).not.toContain('Origin:');
    expect(out).not.toContain('^ column');
    expect(out).toContain('Rejected at [approve] Approve');
    expect(out).toContain('fatal: [sw-edge-02]');
  });

  it("keeps the origin of a step's own failing task", () => {
    const own = [
      '[ERROR]: Task failed: Module failed: timed out waiting for the device',
      'Origin: /runner/project/roles/push_baseline/tasks/main.yml:8:3',
      '',
      '8 - name: Push the baseline',
      '    ^ column 3',
      '',
    ].join('\n');
    expect(quietEndOrigins(own)).toBe(own);
    expect(quietEndOrigins(`${own}\n${ended.join('\n')}`)).toContain('roles/push_baseline');
  });

  it('shows an excerpt not all here yet as it is (the output is still coming)', () => {
    const partial = ended.slice(0, 5).join('\n');
    expect(quietEndOrigins(partial)).toBe(partial);
  });
});

describe('round 3 (AFS-193)', () => {
  it('leaves out the excerpt under a stop at a port with no next step', () => {
    const stop = [
      '[ERROR]: Task failed: Action failed: Stopped at [precheck] Pre-checks: failed_hosts is not wired',
      'Origin: /work/flows/edge/generated/edge.yml:185:7',
      '',
      '183   hosts: afd_stop',
      '184   tasks:',
      '185     - name: "[precheck] failed_hosts is open"',
      '          ^ column 7',
      '',
      'fatal: [sw-edge-02]: FAILED! => {}',
    ];
    expect(quietEndOrigins(stop.join('\n')).split('\n')).toEqual([stop[0], stop[8]]);
    const onPurpose = stop.map((l, i) =>
      i === 0
        ? '[ERROR]: Task failed: Action failed: Stopped at [precheck] Pre-checks: failed_hosts open on purpose (checked by hand)'
        : l,
    );
    expect(quietEndOrigins(onPurpose.join('\n'))).not.toContain('Origin:');
  });

  it("says a rejected host's end was rejected, and leaves other ends as they are", () => {
    const text = [
      ...ended,
      '[ERROR]: Task failed: Action failed: Ended at [end-failed] Failed (outcome: failed)',
      'msg: No decision in time at [approve] Approve. Ended at [end-failed] Failed (outcome: failed)',
    ].join('\n');
    const out = decidedOutcomes(text).split('\n');
    expect(out[1]).toContain(
      'Rejected at [approve] Approve. Ended at [end-failed] Failed (outcome: rejected)',
    );
    expect(out.at(-2)).toContain('(outcome: failed)');
    expect(out.at(-1)).toContain('(outcome: not decided in time)');
  });
});
