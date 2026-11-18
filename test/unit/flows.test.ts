// The server reads flows with the designer's own code, from the designer's packages.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { errorsSentence } from '../../src/server/flowErrors';
import { checkFlow, summarizeFlow } from '../../src/server/flows';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name), 'utf8');

describe('summarizeFlow', () => {
  it('says what a flow is and that it has no errors', () => {
    const flow = summarizeFlow('samples/hello.flow.yaml', fixture('hello.flow.yaml'));
    expect(flow).toMatchObject({
      file: 'samples/hello.flow.yaml',
      ok: true,
      key: 'hello',
      name: 'Hello, Ansible',
      format: 2,
      errors: 0,
      warnings: 0,
    });
    expect(flow.steps).toBe(3);
    expect(flow.version).toBeGreaterThan(0);
  });

  it('counts the steps of every level, without the start and end nodes', () => {
    const flow = summarizeFlow('f.flow.yaml', fixture('firewall-upgrade.flow.yaml'));
    expect(flow).toMatchObject({ ok: true, errors: 0 });
    // The sample has subflows: their inner steps count too.
    expect(flow.steps).toBe(18);
  });

  it('counts the errors the designer would show', () => {
    // A wire that ends at a node the flow does not have.
    const text = fixture('hello.flow.yaml');
    const wire = text.indexOf('  to:');
    const node = text.indexOf('node: ', wire) + 'node: '.length;
    const broken = `${text.slice(0, node)}01AAAAAAAAAAAAAAAAAAAAAAAA${text.slice(node + 26)}`;
    expect(broken).not.toBe(text);
    const flow = summarizeFlow('f.flow.yaml', broken);
    expect(flow.ok).toBe(true);
    expect(flow.errors).toBeGreaterThan(0);
  });

  it('names each error with the step it is on (AFS-164)', () => {
    // "Read a few facts" takes the key of "Check the host answers".
    const text = fixture('hello.flow.yaml').replace('key: facts', 'key: ping');
    const { summary, errors } = checkFlow('f.flow.yaml', text);
    expect(summary.errors).toBe(1);
    expect(errors).toEqual([
      {
        node: '01M6GPM99KC9TX091MCH61REQV',
        step: 'Read a few facts',
        message: 'Duplicate key "ping" in this level',
      },
    ]);
    expect(errorsSentence(summary.errors, errors)).toBe(
      'The flow has 1 error, so it cannot run until it is fixed: Read a few facts: Duplicate key "ping" in this level.',
    );
  });

  it('a long list of errors is named in part, then how many more (AFS-164)', () => {
    const errors = ['A', 'B', 'C', 'D', 'E'].map((step) => ({ step, node: step, message: 'Bad.' }));
    expect(errorsSentence(5, errors)).toBe(
      'The flow has 5 errors, so it cannot run until they are fixed: A: Bad; B: Bad; C: Bad; and 2 more.',
    );
    expect(errorsSentence(1, [{ message: 'The flow has no start.' }])).toBe(
      'The flow has 1 error, so it cannot run until it is fixed: The flow has no start.',
    );
  });

  it('a file that is not a flow says why', () => {
    expect(summarizeFlow('f.flow.yaml', 'flow: [not closed')).toMatchObject({
      ok: false,
      errors: 0,
    });
    expect(summarizeFlow('f.flow.yaml', '').problem).toBeTruthy();
  });

  it('a flow in a newer format is not read: the server says to upgrade', () => {
    const newer = fixture('hello.flow.yaml').replace('schema_version: 2', 'schema_version: 99');
    const flow = summarizeFlow('f.flow.yaml', newer);
    expect(flow.ok).toBe(false);
    expect(flow.problem).toMatch(/format 99.*Upgrade the server/);
    expect(flow.key).toBe('hello');
  });
});
