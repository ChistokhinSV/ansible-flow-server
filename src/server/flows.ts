// A flow file as the server lists it: what it is and whether it can run. The flow is read,
// checked against its schema and validated by the designer's own code, so the server and the
// editor never disagree about a flow.
import { parseFlow } from '@ansible-flow/core/flow/document';
import { CURRENT_FORMAT, formatOf } from '@ansible-flow/core/flow/format';
import { modelOf } from '@ansible-flow/core/flow/model';
import { createSchemaValidator } from '@ansible-flow/core/flow/schema';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import { validateFlow } from '@ansible-flow/core/flow/validate';
import type { FlowError } from './flowErrors';
import type { LastRun } from './runs/cursor';

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
  /**
   * Its newest run in the project, among the runs the person asking may see; only a project's
   * list of flows says it.
   */
  lastRun?: LastRun;
}

// Compiling the schema takes a moment; one validator serves every flow.
export const schemaIssues = createSchemaValidator();

export function summarizeFlow(file: string, text: string): FlowSummary {
  return checkFlow(file, text).summary;
}

/** At most this many errors are kept with a flow that cannot run (AFS-164). */
const KEPT = 100;

/**
 * A flow file read and validated: its summary, the flow when it is one, and its errors with the
 * step each is on (AFS-164: a flow that cannot run says where).
 */
export function checkFlow(
  file: string,
  text: string,
): { summary: FlowSummary; doc?: FlowDocument; errors: FlowError[] } {
  const parsed = parseFlow(text);
  if (!parsed.doc)
    return {
      summary: {
        file,
        ok: false,
        problem: parsed.errors[0]?.message ?? 'Not a flow file',
        errors: 0,
        warnings: 0,
      },
      errors: [],
    };
  const doc = parsed.doc;
  const format = formatOf(doc);
  // A flow written by a newer designer may mean things this server does not know: it is not run.
  if (format > CURRENT_FORMAT)
    return {
      summary: {
        file,
        ok: false,
        problem: `The flow is in format ${format}; this server reads up to format ${CURRENT_FORMAT}. Upgrade the server.`,
        key: doc.flow?.key,
        name: doc.flow?.name,
        format,
        errors: 0,
        warnings: 0,
      },
      doc,
      errors: [],
    };
  const { findings } = validateFlow(doc, schemaIssues(doc));
  const nodes = modelOf(doc).nodes;
  const steps = [...nodes.values()].filter(
    (entry) => entry.node.type !== 'start' && entry.node.type !== 'end',
  ).length;
  const errors = findings.filter((f) => f.severity === 'error');
  return {
    summary: {
      file,
      ok: true,
      key: doc.flow.key,
      name: doc.flow.name,
      version: doc.flow.version,
      format,
      steps,
      errors: errors.length,
      warnings: findings.filter((f) => f.severity === 'warning').length,
    },
    doc,
    errors: errors.slice(0, KEPT).map((f) => {
      const step = f.node ? nodes.get(f.node)?.node : undefined;
      return {
        message: f.message,
        ...(step ? { node: step.id, step: step.title || step.key || step.id } : {}),
      };
    }),
  };
}
