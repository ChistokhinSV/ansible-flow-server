// AFD-351: the repository's own roles for the designer: a role with meta/argument_specs.yml is
// read as such (its options and required ones), so Binding lists them and About opens.
import { describe, expect, it } from 'vitest';
import type { TreeEntry } from '../../src/server/projects/git';
import { entryPoints, rolesOf } from '../../src/server/projects/roles';

const SPECS = `---
argument_specs:
  main:
    short_description: Push the baseline
    description:
      - Writes NTP and AAA.
      - Then saves.
    options:
      ntp_servers:
        type: list
        elements: str
        required: true
        description: NTP servers to set.
      backup_keep:
        type: int
        default: 3
        description: Backups kept.
`;

const files: Record<string, string> = {
  'roles/push_baseline/meta/argument_specs.yml': SPECS,
  'roles/push_baseline/tasks/main.yml': '- debug: msg=hi\n',
  'roles/push_baseline/tasks/ntp.yaml': '- debug: msg=ntp\n',
  'roles/netops_backup/tasks/main.yml': '- debug: msg=backup\n',
  'roles/empty/README.md': 'nothing here',
  'playbooks/site.yml': '- hosts: all\n',
};
const tree: TreeEntry[] = Object.entries(files).map(([path, text]) => ({
  path,
  mode: '100644',
  object: '0'.repeat(40),
  size: text.length,
}));
const read = async (p: string) => files[p];

describe('the repository roles (AFD-351)', () => {
  it('reads each role under roles/ with its task files and argument_specs', async () => {
    const roles = await rolesOf(tree, read);
    expect(roles.map((r) => r.name)).toEqual(['netops_backup', 'push_baseline']);
    const push = roles.find((r) => r.name === 'push_baseline');
    expect(push?.path).toBe('roles/push_baseline');
    expect(push?.tasks).toEqual(['main', 'ntp']);
    const main = push?.entry_points.main;
    expect(main?.short_description).toBe('Push the baseline');
    expect(main?.description).toBe('Writes NTP and AAA.\nThen saves.');
    expect(main?.options.ntp_servers).toMatchObject({
      type: 'list',
      required: true,
      elements: 'str',
    });
    expect(main?.options.backup_keep).toMatchObject({ type: 'int', default: 3 });
    // A role without argument_specs is a role still: free-form variables.
    expect(roles.find((r) => r.name === 'netops_backup')?.entry_points).toEqual({});
  });

  it('an argument_specs file that does not parse gives no entry points', () => {
    expect(entryPoints('argument_specs: [not closed')).toEqual({});
    expect(entryPoints('just: text')).toEqual({});
  });
});
