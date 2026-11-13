// The API reference: the server's own OpenAPI document (/api/v1/openapi.json), shown by
// subject. Each address with what it does, who may call it, and what it takes.
import { useState } from 'react';
import { Loading, PageHead, useLoad } from './ui';

interface Schema {
  type?: string | string[];
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
}
interface Parameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: Schema;
}
interface Operation {
  summary: string;
  tags: string[];
  description: string;
  parameters?: Parameter[];
  requestBody?: { content: { 'application/json': { schema: Schema } } };
}
interface Document {
  info: { title: string; version: string; description: string };
  paths: Record<string, Record<string, Operation>>;
}

const ORDER = ['get', 'post', 'put', 'patch', 'delete'];

/** Text with `code` in backquotes, as the document writes it. */
function Words({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text
        i % 2 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

/** A schema in a few words: its type and its limits. */
function typeOf(schema: Schema): string {
  const type = [schema.type ?? 'any'].flat().join(' or ');
  const limits = [
    schema.enum ? `one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}` : '',
    schema.minLength !== undefined && schema.minLength > 0 ? `at least ${schema.minLength}` : '',
    schema.maxLength !== undefined ? `at most ${schema.maxLength} characters` : '',
    schema.minimum !== undefined ? `from ${schema.minimum}` : '',
    schema.maximum !== undefined ? `to ${schema.maximum}` : '',
    schema.pattern ? `matching ${schema.pattern}` : '',
    schema.items ? `of ${typeOf(schema.items)}` : '',
  ].filter(Boolean);
  return limits.length ? `${type}, ${limits.join(', ')}` : type;
}

function Fields({
  rows,
}: {
  rows: { name: string; where?: string; required: boolean; schema: Schema }[];
}) {
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Name</th>
            {rows.some((r) => r.where) && <th scope="col">In</th>}
            <th scope="col">Type</th>
            <th scope="col">Required</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.where}-${r.name}`}>
              <td>
                <code>{r.name}</code>
              </td>
              {rows.some((x) => x.where) && <td>{r.where}</td>}
              <td>{typeOf(r.schema)}</td>
              <td>{r.required ? 'yes' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Endpoint({ method, path, op }: { method: string; path: string; op: Operation }) {
  const body = op.requestBody?.content['application/json'].schema;
  const params = op.parameters ?? [];
  const more = params.length > 0 || !!body?.properties;
  const head = (
    <>
      <span className={`method ${method}`}>{method.toUpperCase()}</span> <code>{path}</code>{' '}
      <Words text={op.summary} />{' '}
      <span className="muted">· {op.description.replace(/^Who: |\.$/g, '')}</span>
    </>
  );
  if (!more) return <li className="endpoint">{head}</li>;
  return (
    <li className="endpoint">
      <details>
        <summary>{head}</summary>
        {params.length > 0 && (
          <Fields
            rows={params.map((p) => ({
              name: p.name,
              where: p.in,
              required: p.required,
              schema: p.schema,
            }))}
          />
        )}
        {body?.properties && (
          <>
            <p className="muted">JSON body:</p>
            <Fields
              rows={Object.entries(body.properties).map(([name, schema]) => ({
                name,
                required: body.required?.includes(name) ?? false,
                schema,
              }))}
            />
          </>
        )}
      </details>
    </li>
  );
}

export function ApiDocs() {
  const doc = useLoad(async () => {
    const reply = await fetch('/api/v1/openapi.json', { credentials: 'same-origin' });
    if (!reply.ok) throw new Error(`The server answered ${reply.status}`);
    return (await reply.json()) as Document;
  }, []);
  const [filter, setFilter] = useState('');
  const ops = Object.entries(doc.data?.paths ?? {}).flatMap(([path, methods]) =>
    Object.entries(methods)
      .sort(([a], [b]) => ORDER.indexOf(a) - ORDER.indexOf(b))
      .map(([method, op]) => ({ path, method, op })),
  );
  const words = filter.trim().toLowerCase();
  const shown = words
    ? ops.filter(({ path, op }) => `${path} ${op.summary}`.toLowerCase().includes(words))
    : ops;
  const tags = [...new Set(ops.map((o) => o.op.tags[0] ?? 'Other'))];
  return (
    <>
      <PageHead title="API reference" lead={doc.data && <Words text={doc.data.info.description} />}>
        <a className="button" href="/api/v1/openapi.json">
          OpenAPI document
        </a>
      </PageHead>
      <Loading state={doc} />
      {doc.data && (
        <>
          <p className="muted">
            Version {doc.data.info.version}. Every address is under this server; examples use{' '}
            <code>curl -H "Authorization: Bearer $AFS_TOKEN" …</code>
          </p>
          <label className="inline filters">
            Find{' '}
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="runs, token, launch"
            />
          </label>
        </>
      )}
      {tags.map((tag) => {
        const mine = shown.filter((o) => (o.op.tags[0] ?? 'Other') === tag);
        if (mine.length === 0) return null;
        return (
          <section key={tag} className="panel" aria-labelledby={`api-${tag}`}>
            <h2 id={`api-${tag}`}>{tag}</h2>
            <ul className="endpoints">
              {mine.map(({ path, method, op }) => (
                <Endpoint key={`${method} ${path}`} method={method} path={path} op={op} />
              ))}
            </ul>
          </section>
        );
      })}
      {doc.data && shown.length === 0 && <p className="empty">No address matches.</p>}
    </>
  );
}
