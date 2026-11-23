// AFS-245: every 2xx JSON answer of a route that says what it returns (api/catalog.ts `returns`,
// api/schemas.ts) is checked against its schema while the route tests run. The schemas are taken
// closed here: an object may have only the fields its schema names, so a new field without its
// schema fails as a missing one does. Test-only: the server itself never checks its answers.
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { FastifyInstance } from 'fastify';
import { ROUTES } from '../../../src/server/api/catalog';
import { type JsonSchema, SCHEMAS } from '../../../src/server/api/schemas';

/** A schema with every object closed to the fields it names (unless it says otherwise). */
export function closed(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(closed);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema))
    out[key] =
      key === 'properties' || key === '$defs'
        ? Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, closed(v)]))
        : closed(value);
  if (out.properties && !('additionalProperties' in out)) out.additionalProperties = false;
  return out;
}

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema({ $id: 'afs', components: { schemas: closed(SCHEMAS) } });
const validators = new Map<string, ValidateFunction>();

/** The check of one route's answers, or undefined when it says nothing it can be checked by. */
export function checkerOf(key: string): ValidateFunction | undefined {
  const answer = ROUTES[key]?.returns;
  if (!answer || !('json' in answer)) return undefined;
  let found = validators.get(key);
  if (!found) {
    const text = JSON.stringify(closed(answer.json)).replaceAll(
      '"#/components/schemas/',
      '"afs#/components/schemas/',
    );
    found = ajv.compile(JSON.parse(text) as JsonSchema);
    validators.set(key, found);
  }
  return found;
}

/** What went wrong so far, one line each; the tests' setup fails a test that added any. */
export const problems: string[] = [];

/** Checks the app's answers as they go out. */
export function checkAnswers(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    const route = request.routeOptions.url;
    if (!route) return payload;
    const key = `${request.method} ${route}`;
    const answer = ROUTES[key]?.returns;
    const status = reply.statusCode;
    if (!answer || status < 200 || status > 299) return payload;
    const said =
      'json' in answer
        ? [answer.status ?? 200, ...(answer.also ? [answer.also] : [])]
        : 'empty' in answer
          ? [204]
          : [200];
    if (!said.includes(status)) {
      problems.push(`${key}: answered ${status}, the catalog says ${said.join(' or ')}`);
      return payload;
    }
    const check = checkerOf(key);
    if (!check || status === 204 || typeof payload !== 'string') return payload;
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      problems.push(`${key}: the answer is not JSON`);
      return payload;
    }
    if (!check(body))
      problems.push(
        `${key}: ${ajv.errorsText(check.errors, { separator: '; ', dataVar: 'answer' })} in ${payload.slice(0, 600)}`,
      );
    return payload;
  });
}
