// The flows an agent reads over MCP (AFS-24): the designer's flow tools (`runTool`) on the server's
// projects. A flow is named `<workspace>/<project>/<file>` and read at the project's commit (the
// newest of its branch the server has); only flows the caller may see, and only in the workspace
// their token is for. Nothing is written: flows change in git, through a push or in VS Code.
import type { FlowIO } from '@ansible-flow/core/ai/handlers';
import type { OpsContext } from '@ansible-flow/core/ai/ops';
import { createIdFactory } from '@ansible-flow/core/flow/ids';
import { createSchemaValidator, type SchemaValidator } from '@ansible-flow/core/flow/schema';
import { layoutLevel, shownPositions } from '@ansible-flow/node/autoLayout';
import type { Kysely } from 'kysely';
import type { Access } from '../access/grants';
import type { Schema } from '../db/schema';
import type { ProjectFlows } from '../projects/flows';
import type { Git } from '../projects/git';
import { listProjects, listWorkspaces, type Project } from '../projects/store';

/** The flow tools that only read: the others write files, which the server does not do here. */
export const READ_TOOLS = ['flow_list', 'flow_describe', 'flow_validate', 'flow_reference'];

export const READ_ONLY =
  "The server's flows are read-only here: change a flow in git (clone the project from the server, edit it in VS Code, push) and read it again";

let validator: SchemaValidator | undefined;
/** The flow schema's validator: compiled once, on first use. */
const schemaValidator = () => {
  validator ??= createSchemaValidator();
  return validator;
};

export interface Caller {
  access: Access;
  /** The one workspace the caller's token is for (its id); absent: all. */
  workspace?: string;
}

interface Place {
  workspaceKey: string;
  project: Project;
}

export class ServerFlowIO implements FlowIO {
  readonly schema = schemaValidator();

  constructor(
    private readonly db: Kysely<Schema>,
    private readonly git: Git,
    private readonly flows: ProjectFlows,
    private readonly caller: Caller,
  ) {}

  /** The projects the caller may see something of. */
  private async places(): Promise<Place[]> {
    const workspaces = (await listWorkspaces(this.db)).filter(
      (w) => !this.caller.workspace || w.id === this.caller.workspace,
    );
    const keys = new Map(workspaces.map((w) => [w.id, w.key]));
    return (await listProjects(this.db))
      .filter((p) => keys.has(p.workspace) && this.caller.access.sees(p.workspace, p.id))
      .map((project) => ({ workspaceKey: keys.get(project.workspace) as string, project }));
  }

  private mayRead(project: Project, file: string): boolean {
    return !!this.caller.access.onFlow(project.workspace, project.id, file);
  }

  async list(): Promise<string[]> {
    const out: string[] = [];
    for (const { workspaceKey, project } of await this.places()) {
      if (!project.commit) continue;
      const list = await this.flows.list(project.id, project.commit).catch(() => ({ flows: [] }));
      for (const f of list.flows)
        if (this.mayRead(project, f.file)) out.push(`${workspaceKey}/${project.key}/${f.file}`);
    }
    return out;
  }

  /** The project and file a path names, when the caller may read it. */
  private async resolve(path: string): Promise<{ project: Project; file: string }> {
    const [workspaceKey, projectKey, ...rest] = path.replace(/^\/+/, '').split('/');
    const file = rest.join('/');
    const place = (await this.places()).find(
      (p) => p.workspaceKey === workspaceKey && p.project.key === projectKey,
    );
    // Not there, or not for this caller: the same answer, so a name tells nothing.
    if (!place || !file || !this.mayRead(place.project, file))
      throw new Error(
        `No flow ${path}: name a flow as <workspace>/<project>/<file>, as flow_list shows them`,
      );
    if (!place.project.commit)
      throw new Error(`The project ${workspaceKey}/${projectKey} has no commit yet`);
    return { project: place.project, file };
  }

  async read(path: string): Promise<string> {
    const { project, file } = await this.resolve(path);
    const bytes = await this.git
      .read(project.id, project.commit as string, file)
      .catch(() => undefined);
    if (!bytes) throw new Error(`No flow ${path} at the project's commit`);
    return bytes.toString('utf8');
  }

  async write(): Promise<{ text: string; notes: string[] }> {
    throw new Error(READ_ONLY);
  }

  async create(): Promise<{ text: string; notes: string[] }> {
    throw new Error(READ_ONLY);
  }

  ops(): OpsContext {
    return {
      newId: createIdFactory(),
      layout: (level) => layoutLevel(level),
      positions: (model) => shownPositions(model),
    };
  }
}
