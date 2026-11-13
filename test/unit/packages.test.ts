// The designer's packages as this server uses them: one copy of the core, shared by the server's
// code and by @ansible-flow/node, and the probe found by path.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeDir, schemaDir } from '@ansible-flow/assets';
import { parseFlow } from '@ansible-flow/core/flow/document';
import { modelOf, ROOT } from '@ansible-flow/core/flow/model';
import { layoutLevel } from '@ansible-flow/node/autoLayout';
import { stamp } from '@ansible-flow/node/run/ids';
import { describe, expect, it } from 'vitest';
import { serverMeta } from '../../src/server/meta';

describe('the designer packages', () => {
  it('the node package works on the model the core package made', async () => {
    const text = readFileSync(join(__dirname, '../fixtures/hello.flow.yaml'), 'utf8');
    const doc = parseFlow(text).doc;
    if (!doc) throw new Error('the fixture did not parse');
    const level = modelOf(doc).levels.get(ROOT);
    if (!level) throw new Error('the flow has no root level');
    const positions = await layoutLevel(level);
    expect(Object.keys(positions).length).toBe(level.nodes.length);
    // The model is cached per document: asking again gives the same object.
    expect(modelOf(doc)).toBe(modelOf(doc));
  });

  it('the assets package says where the probe and the schemas are', () => {
    expect(existsSync(join(probeDir, 'afd_probe', 'serve.py'))).toBe(true);
    expect(existsSync(join(probeDir, 'callback_plugins', 'afd_events.py'))).toBe(true);
    expect(existsSync(join(schemaDir, 'flow.schema.json'))).toBe(true);
  });

  it('a run id is a sortable time stamp', () => {
    expect(stamp(new Date('2026-11-13T07:08:09.123Z'))).toBe('20261113T070809Z');
  });
});

describe('serverMeta', () => {
  it('names the server, its version and the designer version it is built on', () => {
    const meta = serverMeta();
    expect(meta.name).toBe('Ansible Flow Server');
    expect(meta.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(meta.designer.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(meta.designer.format).toBeGreaterThanOrEqual(2);
  });
});
