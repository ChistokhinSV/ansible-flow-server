// AFS-126: an empty flow in the pages starts from something, as the designer's empty canvas offers
// in VS Code: a sample flow, a playbook of the project's repository, or an AWX workflow or job
// template. Each becomes the draft's flow in one edit (Ctrl+Z takes it back); the flow keeps its
// id and key (the file's), the rest is what was imported. Only a flow that has no step yet.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { samplesDir } from '@ansible-flow/assets';
import { importWorkflow } from '@ansible-flow/core/awx/import';
import {
  jobTemplateFromApi,
  playbooksOf,
  type WorkflowSource,
  workflowFromApi,
} from '@ansible-flow/core/awx/workflow';
import { parseFlow } from '@ansible-flow/core/flow/document';
import type { IdFactory } from '@ansible-flow/core/flow/ids';
import { buildModel, ROOT } from '@ansible-flow/core/flow/model';
import { flowText } from '@ansible-flow/core/flow/text';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import { generatedDirOf } from '@ansible-flow/core/import/outline';
import { importPlaybook } from '@ansible-flow/core/import/playbook';
import type { SourceIO } from '@ansible-flow/core/import/read';
import { type PlaybookForm, readPlaybook } from '@ansible-flow/core/import/source';
import type { Git } from '../projects/git';
import { sampleFiles } from '../projects/start';

export class StartFromError extends Error {
  constructor(
    readonly code: 'refused' | 'not_found' | 'unreachable',
    message: string,
  ) {
    super(message);
    this.name = 'StartFromError';
  }
}

/** True when the flow's top level has nothing but Start and End. */
export function hasNoSteps(text: string): boolean {
  const doc = parseFlow(text).doc;
  if (!doc) return false;
  const top = buildModel(doc).levels.get(ROOT)?.nodes ?? [];
  return top.every((n) => n.type === 'start' || n.type === 'end');
}

/**
 * The imported flow as the draft's: its id, key, name, version and owner kept (AFS-151: a sample's
 * version 3 and owner netops are not this flow's), everything else the import's.
 */
export function asDraftFlow(current: string, imported: FlowDocument): string {
  const doc = parseFlow(current).doc;
  if (!doc) throw new StartFromError('refused', 'The flow does not read: fix it first');
  const { owner: _theirs, ...rest } = imported.flow;
  const flow = {
    ...rest,
    ...(doc.flow.id ? { id: doc.flow.id } : {}),
    key: doc.flow.key,
    ...(doc.flow.name ? { name: doc.flow.name } : {}),
    version: doc.flow.version ?? 1,
    ...(doc.flow.owner ? { owner: doc.flow.owner } : {}),
  };
  return flowText({ ...imported, flow });
}

/**
 * AFS-151: the steps of a flow as the designer's Readiness counts them: every node on every level
 * but Start and End.
 */
export function stepCount(text: string): number {
  const doc = parseFlow(text).doc;
  if (!doc) return 0;
  let n = 0;
  for (const { node } of buildModel(doc).nodes.values())
    if (node.type !== 'start' && node.type !== 'end') n++;
  return n;
}

/** The flow text of a sample project (samples/projects.json), or why not. */
export function sampleFlowText(key: string): string {
  const list = JSON.parse(readFileSync(join(samplesDir, 'projects.json'), 'utf8')) as {
    projects?: { key: string; files: { from: string; to: string }[] }[];
  };
  const sample = list.projects?.find((p) => p.key === key);
  const flow = sample?.files.find((f) => f.to.endsWith('.flow.yaml'));
  if (!flow) throw new StartFromError('not_found', `No sample "${key}"`);
  return readFileSync(join(samplesDir, flow.from), 'utf8');
}

/** AFS-173: a repository file a start from a sample adds with the flow, when the draft is saved. */
export interface DraftFile {
  path: string;
  bytes: Buffer;
}

/**
 * AFS-173: the repository files a sample's flow binds (each role's folder, a playbook), from the
 * sample's own files, to be committed with the flow so it runs at once. What the project has
 * already is kept, never overwritten: a role the project has keeps the project's whole folder
 * (a role half one, half the other would run neither). `notes` say what is added and what not.
 */
export async function sampleBindings(
  key: string,
  doc: FlowDocument,
  io: SourceIO,
  flowFile: string,
): Promise<{ files: DraftFile[]; notes: string[] }> {
  const shipped = sampleFiles(key);
  const dir = flowFile.includes('/') ? flowFile.slice(0, flowFile.lastIndexOf('/')) : '';
  const files: DraftFile[] = [];
  const added: string[] = [];
  const notes: string[] = [];
  // AFS-192: what the project keeps of its own is said once, all names in one sentence.
  const keptRoles: string[] = [];
  const keptFiles: string[] = [];
  const exists = async (path: string) => (io.exists ? io.exists(path) : false);
  const bound = new Map<string, 'role' | 'playbook'>();
  for (const { node } of buildModel(doc).nodes.values())
    if (node.impl && (node.impl.kind === 'role' || node.impl.kind === 'playbook') && node.impl.ref)
      bound.set(node.impl.ref, node.impl.kind);
  for (const [ref, kind] of bound) {
    if (kind === 'role') {
      // Collection roles (namespace.collection.role) come from Galaxy, not from the repository.
      if (!/^[A-Za-z0-9_-]+$/.test(ref)) continue;
      const folder = `roles/${ref}`;
      const own = [...shipped].filter(([p]) => p.startsWith(`${folder}/`));
      if (!own.length) {
        notes.push(
          `It uses the role ${ref}, which the sample does not have either: add roles/${ref} to the repository, or bind another.`,
        );
        continue;
      }
      if ((await exists(folder)) || (dir && (await exists(`${dir}/${folder}`)))) {
        keptRoles.push(ref);
        continue;
      }
      for (const [path, f] of own) files.push({ path, bytes: f.bytes });
      added.push(folder);
      continue;
    }
    const path = ref.replace(/^\.?\//, '');
    const f = shipped.get(path);
    if (!f) continue;
    if (await exists(path)) {
      keptFiles.push(path);
      continue;
    }
    files.push({ path, bytes: f.bytes });
    added.push(path);
  }
  const kept = [
    ...(keptRoles.length
      ? [`${keptRoles.length === 1 ? 'the role' : 'the roles'} ${andList(keptRoles)}`]
      : []),
    ...(keptFiles.length ? [andList(keptFiles)] : []),
  ];
  if (kept.length) {
    const one = keptRoles.length + keptFiles.length === 1;
    notes.push(
      `The project has ${kept.join(' and ')} already: it keeps its own, the sample's ${one ? 'is' : 'are'} not added.`,
    );
  }
  if (added.length)
    notes.unshift(
      `Save adds the sample's ${added.join(', ')} to the repository with the flow (${files.length} file${files.length === 1 ? '' : 's'}).`,
    );
  return { files, notes };
}

/** a, b and c. */
const andList = (items: string[]): string =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** The project's files at a commit, as the designer's importers read them. */
export function repositoryIO(git: Git, projectId: string, commit: string): SourceIO {
  let files: Promise<string[]> | undefined;
  const all = () => {
    files ??= git.files(projectId, commit);
    return files;
  };
  return {
    async read(path) {
      const bytes = await git
        .read(projectId, commit, path.replace(/^\.?\//, ''))
        .catch(() => undefined);
      return bytes?.toString('utf8');
    },
    async list(dir) {
      const prefix = dir ? `${dir.replace(/\/+$/, '')}/` : '';
      const seen = new Map<string, boolean>();
      for (const f of await all()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf('/');
        const name = slash < 0 ? rest : rest.slice(0, slash);
        if (name) seen.set(name, (seen.get(name) ?? false) || slash >= 0);
      }
      return [...seen].map(([name, isDir]) => ({ name, dir: isDir }));
    },
    async exists(path) {
      const p = path.replace(/^\.?\//, '');
      return (await all()).some((f) => f === p || f.startsWith(`${p}/`));
    },
  };
}

/**
 * The playbooks of the repository: YAML files outside flows/ and the folders of roles, tasks,
 * vars and the like whose top is a list of plays (`hosts:` or `import_playbook:`).
 */
export async function playbooksIn(git: Git, projectId: string, commit: string): Promise<string[]> {
  const skip =
    /(^|\/)(flows|roles|tasks|handlers|vars|defaults|group_vars|host_vars|templates|files|meta|collections|\.[^/]+)\//;
  const candidates = (await git.files(projectId, commit)).filter(
    (f) => /\.ya?ml$/.test(f) && !skip.test(f),
  );
  const out: string[] = [];
  for (const f of candidates.slice(0, 400)) {
    const text = (await git.read(projectId, commit, f).catch(() => undefined))?.toString('utf8');
    if (
      text &&
      /^-\s+(name:.*\n\s+)?(hosts|import_playbook|ansible\.builtin\.import_playbook):/m.test(text)
    )
      out.push(f);
  }
  return out;
}

/** A playbook of the repository as the draft's flow. */
export async function fromPlaybook(
  io: SourceIO,
  path: string,
  current: string,
  file: string,
  newId: IdFactory,
): Promise<{ text: string; notes: string[]; steps: number }> {
  const read = await readPlaybook(io, path);
  if (!read.playbook?.plays.length)
    throw new StartFromError(
      'refused',
      read.notes.join(' ') || `${path} has no plays: import the playbook that uses it`,
    );
  const key = parseFlow(current).doc?.flow.key ?? 'flow';
  const result = importPlaybook(
    read.playbook,
    { key, newId, generatedDir: generatedDirOf(file, key) },
    read.notes,
  );
  return {
    text: asDraftFlow(current, result.doc),
    notes: result.notes,
    steps: result.counts.steps,
  };
}

/** AWX's API with a token, for the importer; every request has a time limit. */
export function awxReader(url: string, token: string, timeoutMs = 20_000) {
  const base = url.replace(/\/+$/, '');
  const get = async <T>(path: string): Promise<T> => {
    const target = path.startsWith('http')
      ? path
      : `${base}/api/v2/${path.replace(/^\/+/, '').replace(/^api\/v2\//, '')}`;
    if (new URL(target).origin !== new URL(base).origin)
      throw new StartFromError('refused', 'AWX pointed outside its own address');
    let reply: Response;
    try {
      reply = await fetch(target, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new StartFromError(
        'unreachable',
        `Cannot reach AWX at ${base}: ${(e as Error).message}`,
      );
    }
    if (reply.status === 401 || reply.status === 403)
      throw new StartFromError('refused', `AWX at ${base} does not accept the credential's token`);
    if (!reply.ok)
      throw new StartFromError('unreachable', `AWX answered ${reply.status} for ${path}`);
    return (await reply.json()) as T;
  };
  return {
    base,
    get,
    async all<T>(path: string): Promise<T[]> {
      const out: T[] = [];
      let next: string | null = path.includes('?')
        ? `${path}&page_size=200`
        : `${path}?page_size=200`;
      for (let pages = 0; next && pages < 50; pages++) {
        const page: { results: T[]; next: string | null } = await get(next);
        out.push(...page.results);
        next = page.next;
      }
      return out;
    },
  };
}

export interface AwxTemplate {
  kind: 'workflow' | 'job';
  id: number;
  name: string;
  description?: string;
}

/** The workflow and job templates the token reaches. */
export async function awxTemplates(reader: ReturnType<typeof awxReader>): Promise<AwxTemplate[]> {
  type Row = { id: number; name: string; description?: string };
  const [workflows, jobs] = await Promise.all([
    reader.all<Row>('workflow_job_templates/'),
    reader.all<Row>('job_templates/'),
  ]);
  const row =
    (kind: AwxTemplate['kind']) =>
    (r: Row): AwxTemplate => ({
      kind,
      id: r.id,
      name: r.name,
      ...(r.description ? { description: r.description } : {}),
    });
  return [...workflows.map(row('workflow')), ...jobs.map(row('job'))];
}

/**
 * An AWX template as the draft's flow; a job node whose playbook the repository has becomes its
 * steps (as in VS Code).
 */
export async function fromAwx(
  reader: ReturnType<typeof awxReader>,
  template: { kind: 'workflow' | 'job'; id: number },
  io: SourceIO,
  current: string,
  newId: IdFactory,
): Promise<{ text: string; notes: string[]; steps: number }> {
  const src: WorkflowSource =
    template.kind === 'job'
      ? await jobTemplateFromApi(reader, template.id)
      : await workflowFromApi(reader, template.id);
  const present = new Set<string>();
  const playbooks = new Map<string, PlaybookForm>();
  for (const ref of playbooksOf(src)) {
    const read = await readPlaybook(io, ref.replace(/^\.?\//, '')).catch(() => undefined);
    if (!read?.playbook) continue;
    present.add(ref);
    if (read.playbook.plays.length) playbooks.set(ref, read.playbook);
  }
  const key = parseFlow(current).doc?.flow.key ?? 'flow';
  const result = importWorkflow(src, {
    key,
    newId,
    sourceId: template.id,
    hasPlaybook: (r) => present.has(r),
    playbooks,
    kind: template.kind === 'job' ? 'awx_job_template' : 'awx_workflow',
  });
  return {
    text: asDraftFlow(current, result.doc),
    notes: result.notes,
    steps: result.counts.steps,
  };
}

/**
 * AFS-151: what a start from something was, for the toast of its undo: "the import of site.yml",
 * an AWX template's name, or a sample flow, with its steps as Readiness counts them.
 */
export function startedFrom(text: string): { what: string; steps: number } {
  const from = parseFlow(text).doc?.flow.imported_from;
  const what = !from
    ? 'the sample flow'
    : from.template
      ? `the import of ${from.template}`
      : from.path
        ? `the import of ${from.path}`
        : 'the import';
  return { what, steps: stepCount(text) };
}
