// The flows of a project: which files at its commit are flows, what each is, and one of them as
// the designer shows it. Everything is read from the project's repository at a commit, and the
// designer's own code does the reading, so the page shows what VS Code would.
import { codePreview } from '@ansible-flow/core/engine/preview';
import { parseFlow } from '@ansible-flow/core/flow/document';
import { buildModel } from '@ansible-flow/core/flow/model';
import { openFailPorts } from '@ansible-flow/core/flow/openPorts';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import { type Finding, validateFlow } from '@ansible-flow/core/flow/validate';
import type { Snapshot } from '@ansible-flow/core/protocol';
import { autoPositions, shownLayout } from '@ansible-flow/node/autoLayout';
import { type FlowSummary, summarizeFlow } from '../flows';
import type { Git } from './git';

export type { FlowSummary };

/** A flow is a file named like this, anywhere in the repository. */
export const FLOW_FILE = /\.flow\.ya?ml$/i;
/** A repository with more flows than this shows the first ones, by path. */
export const MAX_FLOWS = 500;
/** How many answers are kept for the same commit being asked about again. */
const KEEP = 100;

export interface FlowList {
  /** The commit the list was read at; absent when the project has none yet. */
  commit?: string;
  flows: FlowSummary[];
  /** The repository has more flow files than are listed. */
  more?: boolean;
}

export interface FlowView {
  commit: string;
  file: string;
  /** What the designer shows: the flow, its findings, positions and generated plays. */
  snapshot: Snapshot;
}

export class FlowError extends Error {
  constructor(
    readonly code: 'not_found' | 'unreadable',
    message: string,
  ) {
    super(message);
    this.name = 'FlowError';
  }
}

/** A commit never changes, so what was read at one is good for as long as it is kept. */
class Kept<T> {
  private readonly items = new Map<string, Promise<T>>();
  get(key: string, make: () => Promise<T>): Promise<T> {
    const had = this.items.get(key);
    if (had) return had;
    const made = make();
    this.items.set(key, made);
    // A failure is not kept: the next asker tries again.
    made.catch(() => this.items.delete(key));
    if (this.items.size > KEEP) this.items.delete(this.items.keys().next().value as string);
    return made;
  }
}

export class ProjectFlows {
  private readonly lists = new Kept<FlowList>();
  private readonly views = new Kept<FlowView>();

  constructor(private readonly git: Git) {}

  /** The flows at a commit of a project, by path. */
  list(projectId: string, commit: string | undefined): Promise<FlowList> {
    if (!commit) return Promise.resolve({ flows: [] });
    return this.lists.get(`${projectId}:${commit}`, async () => {
      const files = (await this.git.files(projectId, commit))
        .filter((file) => FLOW_FILE.test(file))
        .sort();
      const flows: FlowSummary[] = [];
      for (const file of files.slice(0, MAX_FLOWS)) {
        const bytes = await this.git.read(projectId, commit, file).catch(() => undefined);
        flows.push(
          bytes
            ? summarizeFlow(file, bytes.toString('utf8'))
            : { file, ok: false, problem: 'The file could not be read', errors: 0, warnings: 0 },
        );
      }
      return { commit, flows, ...(files.length > MAX_FLOWS ? { more: true } : {}) };
    });
  }

  /**
   * One flow as the designer shows it. Rejects with a FlowError when there is no such flow at
   * the commit, or the file is not a flow this server can read (the reason is for the page).
   */
  view(projectId: string, commit: string, file: string): Promise<FlowView> {
    return this.views.get(`${projectId}:${commit}:${file}`, async () => {
      if (!FLOW_FILE.test(file)) throw new FlowError('not_found', 'Not a flow file');
      const bytes = await this.git.read(projectId, commit, file);
      if (!bytes) throw new FlowError('not_found', 'The project has no such flow at this commit');
      return {
        commit,
        file,
        snapshot: await snapshotOf(bytes.toString('utf8'), file, 1, (p) =>
          this.git.exists(projectId, commit, p),
        ),
      };
    });
  }
}

/**
 * One flow's text as the designer shows it: the flow, its findings, positions and generated plays
 * (AFS-76: also a draft's text, with the draft's revision as its version). Rejects with a
 * FlowError when the text is not a flow this server can read.
 */
/** True when the repository has a file or folder at this path (at the commit shown). */
export type RepoProbe = (path: string) => Promise<boolean>;

/** A repository role's name: no dots (a collection's role is namespace.collection.role). */
const ROLE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * AFS-151: steps bound to a role the repository does not have (roles/<name> at its top or beside
 * the flow): a warning on each, so the designer does not show them implemented. Collection roles
 * are not checked here.
 */
export async function roleGaps(
  doc: FlowDocument,
  file: string,
  has: RepoProbe,
): Promise<Finding[]> {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  const known = new Map<string, Promise<boolean>>();
  const present = (role: string) => {
    let p = known.get(role);
    if (!p) {
      // A path that cannot be checked counts as there: no warning on a guess.
      const ask = (path: string) =>
        Promise.resolve()
          .then(() => has(path))
          .catch(() => true);
      p = (async () =>
        (await ask(`roles/${role}`)) || (!!dir && (await ask(`${dir}/roles/${role}`))))();
      known.set(role, p);
    }
    return p;
  };
  const out: Finding[] = [];
  for (const { node, path } of buildModel(doc).nodes.values()) {
    const role = node.impl?.kind === 'role' ? node.impl.ref : undefined;
    if (!role || !ROLE_NAME.test(role) || (await present(role))) continue;
    out.push({
      code: 'role-missing',
      severity: 'warning',
      message: `"${node.title}" runs the role ${role}, which this project does not have: add roles/${role} to the repository, or bind another`,
      path: [...path, 'impl', 'ref'],
      node: node.id,
      subject: role,
    });
  }
  return out;
}

export async function snapshotOf(
  text: string,
  file: string,
  docVersion = 1,
  has?: RepoProbe,
): Promise<Snapshot> {
  const summary = summarizeFlow(file, text);
  const parsed = parseFlow(text);
  if (!summary.ok || !parsed.doc)
    throw new FlowError('unreadable', summary.problem ?? 'Not a flow file');
  const { model, findings } = validateFlow(parsed.doc);
  const layout = shownLayout(model);
  const shown = layout === model.doc.layout ? model.doc : { ...model.doc, layout };
  // Code is generated only for a flow without errors, as in the designer.
  const preview = findings.some((f) => f.severity === 'error')
    ? undefined
    : codePreview(parsed.doc, file);
  const positions = await Promise.all(
    [...model.levels.values()].map((level) => autoPositions(level, shown.layout)),
  );
  return {
    docVersion,
    doc: shown,
    stale: false,
    file: file.split('/').at(-1),
    findings: [
      ...findings,
      ...(preview?.findings ?? []),
      ...(has ? await roleGaps(parsed.doc, file, has) : []),
    ],
    openPorts: openFailPorts(model),
    autoPositions: Object.assign({}, ...positions),
    ...(preview?.plays ? { plays: preview.plays } : {}),
  };
}
