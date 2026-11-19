import { describe, expect, it } from 'vitest';
import { withLimit } from '../../src/server/runs/limit';

const run = [
  'run',
  '--rm',
  '-e',
  'A=1',
  'afd-ee:2.19',
  'sh',
  '-c',
  "ansible-playbook -i 'inv.ini' 'site.yml'",
];

describe('the launch limit (AFS-130)', () => {
  it('goes to ansible-playbook as --limit, quoted', () => {
    const out = withLimit(run, 'sw-edge-02,web:&prod');
    expect(out.slice(0, -1)).toEqual(run.slice(0, -1));
    expect(out.at(-1)).toBe(
      "ansible-playbook -i 'inv.ini' 'site.yml' --limit 'sw-edge-02,web:&prod'",
    );
  });

  it('cannot break out of its quotes', () => {
    expect(withLimit(run, "a'; rm -rf /").at(-1)).toBe(`${run.at(-1)} --limit 'a'"'"'; rm -rf /'`);
  });

  it('changes nothing without a limit', () => {
    expect(withLimit(run, undefined)).toEqual(run);
    expect(withLimit(run, '  ')).toEqual(run);
  });

  it('refuses a command it cannot limit, rather than run on every host', () => {
    expect(() => withLimit(['run', 'img', 'ansible-playbook', 'x.yml'], 'h1')).toThrow();
  });
});
