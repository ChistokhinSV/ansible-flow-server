// AFD-351: the repository's own roles at a commit, as the designer asks for them (`roles`): each
// role under roles/ with its task files and the entry points of meta/argument_specs.yml. Binding
// then lists a role's options and their required ones, and About opens; before, the server
// answered no roles, and the designer said "No argument_specs" and "Reading…" for ever.
// Read from git, never from a checkout; a commit never changes, so the answer is kept per commit.
import type { CatalogOption } from '@ansible-flow/core/catalog/types';
import type { RoleInfo } from '@ansible-flow/core/protocol';
import { parse } from 'yaml';
import type { Git, TreeEntry } from './git';
import { VARS_MAX_FILE_BYTES } from './vars';

/** Answers kept, the least recently asked for going first. */
export const ROLES_KEPT = 32;

const SPEC_FILES = ['meta/argument_specs.yml', 'meta/argument_specs.yaml'];
const YAML = /\.ya?ml$/;

type Raw = Record<string, unknown>;
const isMap = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
/** A description as Ansible allows it: a string or a list of lines. */
const words = (v: unknown): string =>
  Array.isArray(v) ? v.map(String).join('\n') : typeof v === 'string' ? v : '';

function option(raw: unknown): CatalogOption {
  const o = isMap(raw) ? raw : {};
  const out: CatalogOption = {
    type: typeof o.type === 'string' ? o.type : 'str',
    description: words(o.description),
  };
  if (o.required === true) out.required = true;
  if (o.default !== undefined) out.default = o.default;
  if (Array.isArray(o.choices)) out.choices = o.choices;
  if (typeof o.elements === 'string') out.elements = o.elements;
  if (Array.isArray(o.aliases)) out.aliases = o.aliases.map(String);
  if (o.no_log === true) out.no_log = true;
  if (isMap(o.options)) out.suboptions = options(o.options);
  return out;
}

function options(raw: unknown): Record<string, CatalogOption> {
  const out: Record<string, CatalogOption> = {};
  if (isMap(raw)) for (const [name, o] of Object.entries(raw)) out[name] = option(o);
  return out;
}

/** The entry points of an argument_specs file; none when it does not parse. */
export function entryPoints(text: string): RoleInfo['entry_points'] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return {};
  }
  const specs = isMap(doc) ? doc.argument_specs : undefined;
  const out: RoleInfo['entry_points'] = {};
  if (isMap(specs))
    for (const [name, spec] of Object.entries(specs)) {
      const s = isMap(spec) ? spec : {};
      out[name] = {
        short_description: words(s.short_description),
        description: words(s.description),
        options: options(s.options),
      };
    }
  return out;
}

/** The roles of a repository tree: roles/<name>/ with a tasks/ folder or argument_specs. */
export async function rolesOf(
  tree: readonly TreeEntry[],
  read: (path: string) => Promise<string | undefined>,
): Promise<RoleInfo[]> {
  const byRole = new Map<string, TreeEntry[]>();
  for (const e of tree) {
    const m = /^roles\/([^/]+)\/(.+)$/.exec(e.path);
    if (!m) continue;
    const list = byRole.get(m[1] as string) ?? [];
    list.push(e);
    byRole.set(m[1] as string, list);
  }
  const out: RoleInfo[] = [];
  for (const [name, files] of [...byRole].sort(([a], [b]) => a.localeCompare(b))) {
    const path = `roles/${name}`;
    const tasks = files
      .map((f) => f.path.slice(path.length + 1))
      .filter((f) => f.startsWith('tasks/') && !f.slice(6).includes('/') && YAML.test(f))
      .map((f) => f.slice(6).replace(YAML, ''))
      .sort();
    const spec = files.find(
      (f) =>
        SPEC_FILES.includes(f.path.slice(path.length + 1)) &&
        f.mode !== '120000' &&
        f.size <= VARS_MAX_FILE_BYTES,
    );
    const text = spec ? await read(spec.path) : undefined;
    const entry_points = text ? entryPoints(text) : {};
    if (tasks.length === 0 && Object.keys(entry_points).length === 0) continue;
    out.push({ name, path, entry_points, tasks });
  }
  return out;
}

/** A project's roles at a commit, read once per commit. */
export class RepoRoles {
  private readonly kept = new Map<string, Promise<RoleInfo[]>>();

  constructor(private readonly git: Git) {}

  roles(project: string, commit: string): Promise<RoleInfo[]> {
    const key = `${project}@${commit}`;
    const had = this.kept.get(key);
    if (had) {
      this.kept.delete(key);
      this.kept.set(key, had);
      return had;
    }
    const built = (async () =>
      rolesOf(await this.git.tree(project, commit), async (p) =>
        (await this.git.read(project, commit, p).catch(() => undefined))?.toString('utf8'),
      ))();
    this.kept.set(key, built);
    // A failure is not kept: the next ask tries again.
    built.catch(() => this.kept.delete(key));
    while (this.kept.size > ROLES_KEPT) this.kept.delete(this.kept.keys().next().value as string);
    return built;
  }
}
