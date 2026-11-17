// AFS-120: a run's name (its folder and container) is unique across projects in the same second.
import { describe, expect, it } from 'vitest';
import { runName } from '../../src/server/runs/executor';

describe('runName', () => {
  const at = new Date('2026-11-17T14:29:03.120Z');
  it('starts with the time, so run folders sort by it', () => {
    expect(runName({ id: '0d1c2b3a-aaaa-4bbb-8ccc-000000000001', number: 1 }, undefined, at)).toBe(
      '20261117T142903Z-1-0d1c2b3a',
    );
  });

  it('differs for two projects’ run 1 started in the same second, and names a segment', () => {
    const a = runName({ id: '0d1c2b3a-aaaa-4bbb-8ccc-000000000001', number: 1 }, undefined, at);
    const b = runName({ id: '9f8e7d6c-aaaa-4bbb-8ccc-000000000002', number: 1 }, undefined, at);
    expect(a).not.toBe(b);
    expect(runName({ id: '9f8e7d6c-x', number: 3 }, 'seg_start', at)).toBe(
      '20261117T142903Z-3-9f8e7d6c-seg_start',
    );
  });
});
