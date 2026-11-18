// AFS-153: the words of a change set, as the Files page shows them and the commit says them.
import { describe, expect, it } from 'vitest';
import { changeWords, defaultMessage } from '../../src/server/projects/changeWords';

describe('change words', () => {
  const had = new Set(['playbooks/site.yml']);
  const existed = (path: string) => had.has(path);

  it('a new file typed is added; a file that was there is edited; an upload is an upload', () => {
    expect(changeWords({ op: 'write', path: 'playbooks/new.yml', text: '' }, existed)).toBe(
      'Add playbooks/new.yml',
    );
    expect(changeWords({ op: 'write', path: 'playbooks/site.yml', text: 'x' }, existed)).toBe(
      'Edit playbooks/site.yml',
    );
    expect(changeWords({ op: 'write', path: 'a.bin', base64: 'AA==' }, existed)).toBe(
      'Upload a.bin',
    );
    // Without knowing what was there, a write of text is an edit, as before.
    expect(changeWords({ op: 'write', path: 'playbooks/new.yml', text: '' })).toBe(
      'Edit playbooks/new.yml',
    );
  });

  it('the default commit message says the same', () => {
    expect(
      defaultMessage(
        [
          { op: 'write', path: 'playbooks/new.yml', text: '- hosts: all' },
          { op: 'delete', path: 'playbooks/site.yml' },
        ],
        existed,
      ),
    ).toBe('Add playbooks/new.yml; Delete playbooks/site.yml');
  });
});
