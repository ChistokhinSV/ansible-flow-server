// AFS-183: the designer's variable index (where a value comes from, phase 4) built from a project's
// repository at a commit: the inventory a run uses, its group_vars/host_vars beside it and at the
// root, and the roles, playbooks and task files the flow runs (designer core/inventory/varIndex).
// Read from git, never from a checkout; a commit never changes, so an index is kept per commit
// and request. Within the designer's limits (files and time) and this file's (bytes per file);
// the index holds no secret value (the designer keeps none of a vaulted or secret-looking one).
import type { InventoryFs } from '@ansible-flow/core/inventory/files';
import { buildVarIndex, type VarIndex } from '@ansible-flow/core/inventory/varIndex';
import type { Git, TreeEntry } from './git';

/** A file larger than this is not read: variables files are small, and a big one is not one. */
export const VARS_MAX_FILE_BYTES = 256 * 1024;
/** Files read and milliseconds spent at most for one index (the designer's defaults). */
export const VARS_MAX_FILES = 400;
export const VARS_BUDGET_MS = 2000;
/** Indexes kept, the least recently asked for going first. */
export const VARS_KEPT = 64;

/** What an index is of: the flow's steps, as `indexInputs` gives them, and the inventory. */
export interface VarsRequest {
  /** The inventory file a run uses; empty or absent: what the repository's ansible.cfg names. */
  inventory?: string;
  roles?: readonly string[];
  files?: readonly string[];
}

/** The repository at `commit` as the designer's file interface, from git's tree of it. */
export function gitFs(git: Git, project: string, commit: string, tree: TreeEntry[]): InventoryFs {
  const files = new Map<string, TreeEntry>();
  const dirs = new Set<string>(['']);
  for (const e of tree) {
    files.set(e.path, e);
    const parts = e.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const clean = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '');
  return {
    async read(path) {
      const e = files.get(clean(path));
      // A link may point anywhere, a big file is not a variables file: neither is read.
      if (!e || e.mode === '120000' || e.size > VARS_MAX_FILE_BYTES) return undefined;
      const bytes = await git.read(project, commit, e.path).catch(() => undefined);
      return bytes?.toString('utf8');
    },
    async kind(path) {
      const p = clean(path);
      return files.has(p) ? 'file' : dirs.has(p) ? 'dir' : undefined;
    },
    async list(path) {
      const p = clean(path);
      if (!dirs.has(p)) return undefined;
      const pre = p ? `${p}/` : '';
      const names = new Map<string, boolean>();
      for (const f of files.keys())
        if (f.startsWith(pre)) {
          const rest = f.slice(pre.length);
          const name = rest.split('/')[0] as string;
          names.set(name, (names.get(name) ?? false) || rest.includes('/'));
        }
      return [...names]
        .map(([name, dir]) => ({ name, dir }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

/** The index of a project's repository at a commit, built once per commit and request. */
export class VarIndexes {
  private readonly kept = new Map<string, Promise<VarIndex>>();

  constructor(
    private readonly git: Git,
    private readonly limits: { maxFiles?: number; budgetMs?: number; kept?: number } = {},
  ) {}

  /** How many indexes are kept now (tests). */
  get size(): number {
    return this.kept.size;
  }

  index(project: string, commit: string, request: VarsRequest): Promise<VarIndex> {
    const roles = [...new Set(request.roles ?? [])].sort();
    const files = [...new Set(request.files ?? [])].sort();
    const inventory = request.inventory?.trim() ?? '';
    const key = JSON.stringify([project, commit, inventory, roles, files]);
    const had = this.kept.get(key);
    if (had) {
      // Asked again: the newest now.
      this.kept.delete(key);
      this.kept.set(key, had);
      return had;
    }
    const built = (async () => {
      const tree = await this.git.tree(project, commit);
      return buildVarIndex(gitFs(this.git, project, commit, tree), {
        inventory,
        roles,
        files,
        maxFiles: this.limits.maxFiles ?? VARS_MAX_FILES,
        budgetMs: this.limits.budgetMs ?? VARS_BUDGET_MS,
      });
    })();
    this.kept.set(key, built);
    // A failure is not kept: the next ask tries again.
    built.catch(() => this.kept.delete(key));
    const most = this.limits.kept ?? VARS_KEPT;
    while (this.kept.size > most) {
      const oldest = this.kept.keys().next().value as string;
      this.kept.delete(oldest);
    }
    return built;
  }
}
