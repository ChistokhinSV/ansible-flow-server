// A flow file as the server lists it: what it is and whether it can run. The flow is read,
// checked against its schema and validated by the designer's own code, so the server and the
// editor never disagree about a flow.
import { parseFlow } from '@ansible-flow/core/flow/document';
import { CURRENT_FORMAT, formatOf } from '@ansible-flow/core/flow/format';
import { modelOf } from '@ansible-flow/core/flow/model';
import { createSchemaValidator } from '@ansible-flow/core/flow/schema';
import { validateFlow } from '@ansible-flow/core/flow/validate';

export interface FlowSummary {
  /** The file's path in its repository. */
  file: string;
  /** False when the file is not a flow this server can read; `problem` says why. */
  ok: boolean;
  problem?: string;
  key?: string;
  name?: string;
  version?: number;
  format?: number;
  /** Nodes on every level, without the start and end nodes. */
  steps?: number;
  errors: number;
  warnings: number;
}

// Compiling the schema takes a moment; one validator serves every flow.
export const schemaIssues = createSchemaValidator();

export function summarizeFlow(file: string, text: string): FlowSummary {
  const parsed = parseFlow(text);
  if (!parsed.doc)
    return {
      file,
      ok: false,
      problem: parsed.errors[0]?.message ?? 'Not a flow file',
      errors: 0,
      warnings: 0,
    };
  const doc = parsed.doc;
  const format = formatOf(doc);
  // A flow written by a newer designer may mean things this server does not know: it is not run.
  if (format > CURRENT_FORMAT)
    return {
      file,
      ok: false,
      problem: `The flow is in format ${format}; this server reads up to format ${CURRENT_FORMAT}. Upgrade the server.`,
      key: doc.flow?.key,
      name: doc.flow?.name,
      format,
      errors: 0,
      warnings: 0,
    };
  const { findings } = validateFlow(doc, schemaIssues(doc));
  const steps = [...modelOf(doc).nodes.values()].filter(
    (entry) => entry.node.type !== 'start' && entry.node.type !== 'end',
  ).length;
  return {
    file,
    ok: true,
    key: doc.flow.key,
    name: doc.flow.name,
    version: doc.flow.version,
    format,
    steps,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
  };
}
