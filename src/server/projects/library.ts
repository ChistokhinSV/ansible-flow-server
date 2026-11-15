// AFS-79: the flow library. A project marked as a library offers its flows' subflows to every
// project on the server; a flow takes a copy, pinned to the library flow's version and the commit
// it was read at (`afs://<workspace>/<project>/<file>#<key path>`, the designer's AFD-295). The copy
// lives in the flow: nothing here is read when a flow runs.
//
// What a library offers is read at the project's commit with the designer's own code, and kept per
// commit. A person sees the libraries whose workspace they may read (ro or more).
import { planCommand } from '@ansible-flow/core/flow/commands';
import { parseFlow } from '@ansible-flow/core/flow/document';
import { formatOf } from '@ansible-flow/core/flow/format';
import { createIdFactory } from '@ansible-flow/core/flow/ids';
import { CURRENT_FORMAT } from '@ansible-flow/core/flow/migrate';
import { subflowsOf } from '@ansible-flow/core/flow/refs';
import type { FlowDocument, FlowNode } from '@ansible-flow/core/flow/types';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { FLOW_FILE, MAX_FLOWS } from './flows';
import { type Git, GitError } from './git';
import { listProjects, listWorkspaces, type Project } from './store';

export const LIBRARY_SCHEME = 'afs://';

/** A subflow the library offers (the designer's LibrarySubflow, AFD-295). */
export interface LibrarySubflow {
  from: string;
  workspace: string;
  project: string;
  file: string;
  path: string;
  title: string;
  intent?: string;
  flow: string;
  version: number;
  commit: string;
}

interface Offered extends LibrarySubflow {
  /** The library project's id and workspace id, for access. */
  projectId: string;
  workspaceId: string;
}

/** How many library commits are kept read. */
const KEEP = 50;

export class Library {
  private readonly read = new Map<string, Promise<{ entry: Offered; node: FlowNode }[]>>();

  constructor(private readonly deps: { db: Kysely<Schema>; git: Git }) {}

  /** A library flow as format 2 (the designer copies into format 2 flows only). */
  private format2(text: string, doc: FlowDocument): FlowDocument {
    if (formatOf(doc) >= 2) return doc;
    const upgraded = planCommand(text, { kind: 'upgradeFormat' }, { newId: createIdFactory() });
    const doc2 = parseFlow(upgraded.text).doc;
    if (!doc2) throw new Error('The flow does not upgrade');
    return doc2;
  }

  /** What a library project offers at its commit. */
  private offeredBy(
    project: Project,
    workspaceKey: string,
  ): Promise<{ entry: Offered; node: FlowNode }[]> {
    const commit = project.commit;
    if (!commit) return Promise.resolve([]);
    const key = `${project.id}:${commit}`;
    let found = this.read.get(key);
    if (!found) {
      found = (async () => {
        let files: string[];
        try {
          files = (await this.deps.git.files(project.id, commit)).filter((f) => FLOW_FILE.test(f));
        } catch (e) {
          if (e instanceof GitError) return [];
          throw e;
        }
        const out: { entry: Offered; node: FlowNode }[] = [];
        for (const file of files.sort().slice(0, MAX_FLOWS)) {
          let text: string;
          try {
            text = (await this.deps.git.read(project.id, commit, file))?.toString('utf8') ?? '';
          } catch {
            continue;
          }
          const parsed = parseFlow(text).doc;
          // A flow this server cannot read (a newer format, or not a flow) offers nothing.
          if (!parsed?.flow || formatOf(parsed) > CURRENT_FORMAT) continue;
          let doc: FlowDocument;
          try {
            doc = this.format2(text, parsed);
          } catch {
            continue;
          }
          for (const s of subflowsOf(doc))
            out.push({
              node: s.node,
              entry: {
                from: `${LIBRARY_SCHEME}${workspaceKey}/${project.key}/${file}#${s.path}`,
                workspace: workspaceKey,
                project: project.key,
                file,
                path: s.path,
                title: s.node.title,
                ...(s.node.intent ? { intent: s.node.intent } : {}),
                flow: doc.flow.name,
                version: Number(doc.flow.version) || 1,
                commit,
                projectId: project.id,
                workspaceId: project.workspace,
              },
            });
        }
        return out;
      })();
      this.read.set(key, found);
      found.catch(() => this.read.delete(key));
      while (this.read.size > KEEP) this.read.delete(this.read.keys().next().value as string);
    }
    return found;
  }

  /** Everything the libraries offer that `may` lets the person read, by source. */
  private async offered(
    may: (workspaceId: string) => boolean,
  ): Promise<{ entry: Offered; node: FlowNode }[]> {
    const workspaces = await listWorkspaces(this.deps.db);
    const keyOf = new Map(workspaces.map((w) => [w.id, w.key]));
    const out: { entry: Offered; node: FlowNode }[] = [];
    for (const w of workspaces) {
      if (!may(w.id)) continue;
      for (const project of await listProjects(this.deps.db, w.id))
        if (project.library)
          out.push(...(await this.offeredBy(project, keyOf.get(project.workspace) ?? w.key)));
    }
    return out.sort((a, b) => (a.entry.from < b.entry.from ? -1 : 1));
  }

  async list(may: (workspaceId: string) => boolean): Promise<LibrarySubflow[]> {
    return (await this.offered(may)).map(({ entry }) => {
      const { projectId: _p, workspaceId: _w, ...shown } = entry;
      return shown;
    });
  }

  /** One subflow as the library has it now; undefined when it is not offered to this person. */
  async subflow(
    may: (workspaceId: string) => boolean,
    from: string,
  ): Promise<(LibrarySubflow & { node: FlowNode }) | undefined> {
    if (!from.startsWith(LIBRARY_SCHEME)) return undefined;
    const found = (await this.offered(may)).find((o) => o.entry.from === from);
    if (!found) return undefined;
    const { projectId: _p, workspaceId: _w, ...shown } = found.entry;
    return { ...shown, node: found.node };
  }
}
