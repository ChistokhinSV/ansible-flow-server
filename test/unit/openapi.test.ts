// AFS-199, AFS-245: the OpenAPI document is whole and its schemas are good JSON Schema: each one
// compiles, each reference names a schema that is there, and a route that says what it returns
// has that answer in the document.
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { headingOf, openApi, ROUTES } from '../../src/server/api/catalog';
import { SCHEMAS } from '../../src/server/api/schemas';

const routes = Object.keys(ROUTES).map((key) => {
  const [method, url] = key.split(' ') as [string, string];
  return { method, url };
});
const doc = openApi(routes) as {
  servers: { url: string }[];
  components: { schemas: Record<string, unknown> };
  paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
};

describe('the OpenAPI document', () => {
  it('sends to the address it was read from', () => {
    expect(doc.servers[0]?.url).toBe('/');
  });

  it('has good schemas, and every reference is to one that is there', () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    ajv.addSchema({ $id: 'afs', components: doc.components });
    const text = JSON.stringify(doc.paths);
    for (const [, name] of text.matchAll(/"#\/components\/schemas\/([^"]+)"/g))
      expect(doc.components.schemas, name).toHaveProperty(name as string);
    for (const name of Object.keys(SCHEMAS))
      expect(() => ajv.getSchema(`afs#/components/schemas/${name}`), name).not.toThrow();
    for (const [path, methods] of Object.entries(doc.paths))
      for (const [method, op] of Object.entries(methods))
        for (const [status, answer] of Object.entries(op.responses)) {
          const schema = (answer as { content?: Record<string, { schema?: unknown }> }).content?.[
            'application/json'
          ]?.schema;
          if (!schema) continue;
          const local = JSON.parse(
            JSON.stringify(schema).replaceAll('"#/components/', '"afs#/components/'),
          );
          expect(() => ajv.compile(local), `${method} ${path} ${status}`).not.toThrow();
        }
  });

  it('says what a route returns where the catalog does; the others keep a plain answer', () => {
    let described = 0;
    for (const [key, route] of Object.entries(ROUTES)) {
      const [method, url] = key.split(' ') as [string, string];
      const op = doc.paths[url.replace(/:([A-Za-z_]+)/g, '{$1}')]?.[method.toLowerCase()];
      expect(op, key).toBeDefined();
      const statuses = Object.keys(op?.responses ?? {});
      expect(statuses, key).toContain('4XX');
      if (route.returns) {
        described++;
        expect(
          statuses.some((s) => /^2\d\d$/.test(s)),
          key,
        ).toBe(true);
      } else expect(statuses, key).toContain('default');
    }
    // AFS-245: the run, flow, launch, approval and token routes first, about 60.
    expect(described).toBeGreaterThanOrEqual(60);
  });
});

describe('operation headings (AFS-255)', () => {
  it('are a few words without backticks; the whole text is the description', () => {
    expect(
      headingOf(
        'Runs, newest first; filters project, flow, `limit` and `before` (the last run) for paging',
      ),
    ).toBe('Runs, newest first');
    expect(headingOf('The pause points of a flow (`path`)')).toBe('The pause points of a flow');
    expect(headingOf('Launch: the run goes in the queue')).toBe(
      'Launch: the run goes in the queue',
    );
    const doc = openApi(
      Object.keys(ROUTES).map((k) => {
        const [method, url] = k.split(' ');
        return { method, url, schema: {} };
      }) as never,
    ) as { paths: Record<string, Record<string, { summary: string; description: string }>> };
    const runs = doc.paths['/api/v1/runs']?.get;
    expect(runs?.summary).toBe('Runs, newest first');
    expect(runs?.description).toMatch(/`limit`/);
    expect(runs?.description).toMatch(/Who: signed in\.$/);
    for (const path of Object.values(doc.paths))
      for (const op of Object.values(path)) expect(op.summary).not.toContain('`');
  });
});
