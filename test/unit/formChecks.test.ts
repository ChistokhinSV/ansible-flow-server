// AFS-140: the checks the pages make before sending, shared with the server, and the words of
// what the server refuses.
import { describe, expect, it } from 'vitest';
import { fieldLabel, plainInvalid } from '../../src/server/api/invalid';
import { collectionProblem } from '../../src/server/environments/collections';
import {
  changeWords,
  defaultBody,
  defaultMessage,
  whereAfter,
} from '../../src/server/projects/changeWords';
import { plainCron } from '../../src/server/schedules/schedules';
import { fieldProblem, fieldValue, privateKeyProblem } from '../../src/server/secrets/kinds';

describe('plain words for refusals', () => {
  it('names fields as the forms label them', () => {
    expect(fieldLabel('privateKey')).toBe('Private key');
    expect(fieldLabel('gitUrl')).toBe('Git URL');
    expect(fieldLabel('name')).toBe('Name');
  });

  it("says a schema refusal without the schema library's words", () => {
    expect(
      plainInvalid([{ instancePath: '/name', keyword: 'maxLength', params: { limit: 200 } }]),
    ).toEqual({ message: 'Name: at most 200 characters.', field: 'name' });
    expect(
      plainInvalid([
        { instancePath: '', keyword: 'required', params: { missingProperty: 'flowFile' } },
      ]),
    ).toEqual({ message: 'Flow file is needed.', field: 'flowFile' });
    expect(
      plainInvalid([
        { instancePath: '/mode', keyword: 'enum', params: { allowedValues: ['check', 'real'] } },
      ]),
    ).toEqual({ message: 'Mode: one of check, real.', field: 'mode' });
  });

  it('says what is wrong with a cron, part by part', () => {
    expect(plainCron('CronPattern: Invalid value for minute: 61')).toBe(
      'The minute part is out of range: it takes 0 to 59.',
    );
    expect(plainCron('CronPattern: Invalid value for dayOfWeek: 8')).toMatch(/^The weekday part/);
    expect(plainCron('CronPattern: Invalid value for hour: 25')).toMatch(/0 to 23/);
    expect(plainCron("invalid configuration format ('a b c')")).toMatch(/five parts/);
  });
});

describe('credential fields', () => {
  it('checks the become method, registry host, AWX address and vault id', () => {
    expect(fieldProblem('method', 'sudo')).toBeUndefined();
    expect(fieldProblem('method', 'community.general.doas')).toBeUndefined();
    expect(fieldProblem('method', 'notamethod!!')).toMatch(/become method/);
    expect(fieldProblem('host', 'registry.example.net:5000')).toBeUndefined();
    expect(fieldProblem('host', 'https://bad host/with path')).toMatch(/without a path/);
    // AFS-153: an address typed for a registry host is taken as its host and port.
    expect(fieldProblem('host', 'https://registry.example.net:5000/')).toBeUndefined();
    expect(fieldValue('host', ' https://registry.example.net:5000/ ')).toBe(
      'registry.example.net:5000',
    );
    expect(fieldProblem('url', 'http://awx.example.net')).toBeUndefined();
    expect(fieldProblem('url', 'ftp://awx.example.net')).toMatch(/https:\/\/ or http:\/\//);
    expect(fieldProblem('url', 'https://awx.example.net')).toBeUndefined();
    expect(fieldProblem('url', 'not a url')).toMatch(/https:\/\//);
    expect(fieldProblem('vaultId', 'prod')).toBeUndefined();
    expect(fieldProblem('vaultId', 'prod id with spaces')).toMatch(/one word/);
    expect(fieldProblem('username', 'any thing')).toBeUndefined();
  });

  it('says a private key is not one in words, not by its field name', () => {
    expect(privateKeyProblem('not a key at all')).toMatch(/^This is not a private key/);
    expect(privateKeyProblem('not a key at all')).not.toMatch(/privateKey/);
  });
});

describe('the rest', () => {
  it('says which part of a collection row is wrong', () => {
    expect(collectionProblem({ name: 'cisco.ios', version: 'not a version' })?.part).toBe(
      'version',
    );
    expect(collectionProblem({ name: 'cisco', version: 'latest' })?.part).toBe('name');
    expect(collectionProblem({ name: 'cisco.ios', version: '>=11.0.0,<12' })).toBeUndefined();
  });

  it('commits a change set saved without a message with the words the page showed', () => {
    expect(changeWords({ op: 'delete', path: 'a.yml' })).toBe('Delete a.yml');
    expect(defaultMessage([{ op: 'move', from: 'a.yml', to: 'b.yml' }])).toBe(
      'Move a.yml to b.yml',
    );
    expect(
      defaultMessage([
        { op: 'delete', path: 'a' },
        { op: 'delete', path: 'b' },
        { op: 'delete', path: 'c' },
        { op: 'delete', path: 'd' },
      ]),
    ).toBe('Delete a and 3 more changes');
  });
});

describe('change words of a new file (AFS-153)', () => {
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

describe('AFS-210: what a change set does to a path, and its words', () => {
  it('follows a path through moves of it or its folder; a delete takes it away', () => {
    const changes = [
      { op: 'move' as const, from: 'flows/motd', to: 'flows/motd-x' },
      { op: 'move' as const, from: 'flows/motd-x/motd.flow.yaml', to: 'flows/b.flow.yaml' },
    ];
    expect(whereAfter('flows/motd/motd.flow.yaml', changes)).toBe('flows/b.flow.yaml');
    // A folder named like the start of another is not it.
    expect(whereAfter('flows/motd2/a.flow.yaml', changes)).toBe('flows/motd2/a.flow.yaml');
    expect(whereAfter('flows/b.flow.yaml', [{ op: 'delete', path: 'flows' }])).toBeNull();
  });

  it('an upload over a file that is there replaces it; a long change set lists all in the body', () => {
    const had = new Set(['inventory.ini']);
    const existed = (path: string) => had.has(path);
    expect(changeWords({ op: 'write', path: 'inventory.ini', base64: 'AA==' }, existed)).toBe(
      'Replace inventory.ini with an upload',
    );
    expect(defaultBody([{ op: 'delete', path: 'a' }])).toBe('');
    const many = ['a', 'b', 'c', 'd'].map((path) => ({ op: 'delete' as const, path }));
    expect(defaultMessage(many)).toBe('Delete a and 3 more changes');
    expect(defaultBody(many)).toBe('- Delete a\n- Delete b\n- Delete c\n- Delete d');
  });
});
