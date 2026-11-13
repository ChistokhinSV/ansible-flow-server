// Where a run's files are: the project's repository checked out at the run's commit, and the
// flow's code generated fresh into it. The project's branch has one lasting folder; a run of
// anything else gets a folder of its own, removed when the run ends.
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import type { GenerateResult } from '@ansible-flow/core/engine/types';
import type { Git } from '../projects/git';
import type { ProjectSync } from '../projects/sync';

export interface Workdir {
  /** The repository's files at the run's commit. */
  dir: string;
  /** Removes it when the run is over (a folder of its own); a lasting one is kept. */
  release(): Promise<void>;
}

/** The folder the flow's code is generated into, beside the flow (as the designer does). */
export const generatedDirOf = (flowFile: string) =>
  posix.join(posix.dirname(flowFile), 'generated');

/** The repository's root as seen from the generated folder (`..`, `../..`). */
export function rootFromGenerated(flowFile: string): string {
  const depth = generatedDirOf(flowFile)
    .split('/')
    .filter((p) => p && p !== '.').length;
  return Array.from({ length: depth }, () => '..').join('/');
}

export class Workdirs {
  /** Lasting folders a run is using now: a second run of the branch gets its own. */
  private readonly busy = new Set<string>();

  constructor(
    private readonly root: string,
    private readonly git: Git,
    private readonly sync: ProjectSync,
  ) {}

  private projectDir(projectId: string): string {
    return join(this.root, projectId);
  }

  /**
   * The repository at `commit`, for one run. `lasting` (a run of the project's branch) reuses
   * the project's folder when no other run has it, after putting it exactly at the commit.
   */
  async checkout(
    projectId: string,
    commit: string,
    lasting: boolean,
    runId: string,
  ): Promise<Workdir> {
    const base = this.projectDir(projectId);
    const branchDir = join(base, 'branch');
    const own = lasting && !this.busy.has(branchDir);
    const dir = own ? branchDir : join(base, `run-${runId}`);
    if (own) this.busy.add(branchDir);
    try {
      await mkdir(base, { recursive: true });
      // Nothing else changes the repository while files are taken out of it.
      await this.sync.exclusive(projectId, () => this.git.checkout(projectId, commit, dir));
    } catch (e) {
      if (own) this.busy.delete(branchDir);
      else await this.remove(projectId, dir);
      throw e;
    }
    return {
      dir,
      release: async () => {
        if (own) this.busy.delete(branchDir);
        else await this.remove(projectId, dir);
      },
    };
  }

  private async remove(projectId: string, dir: string): Promise<void> {
    await this.sync
      .exclusive(projectId, () => this.git.removeCheckout(projectId, dir))
      .catch(() => rm(dir, { recursive: true, force: true }));
  }

  /** Removes the folders runs left behind (a server that stopped mid-run). */
  async sweep(): Promise<number> {
    let removed = 0;
    const projects = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const entries = await readdir(join(this.root, project.name), { withFileTypes: true });
      for (const entry of entries)
        if (entry.isDirectory() && entry.name.startsWith('run-')) {
          await this.remove(project.name, join(this.root, project.name, entry.name));
          removed++;
        }
    }
    return removed;
  }
}

/**
 * Writes the flow's generated code into the checkout, replacing whatever the commit has there.
 * The folder is made fresh; a path that is a link (the repository could hold one pointing
 * anywhere) is never followed: the link is removed, or the write refused.
 */
export async function writeGenerated(
  root: string,
  flowFile: string,
  code: GenerateResult,
): Promise<string> {
  const rel = generatedDirOf(flowFile);
  const target = resolve(root, rel);
  if (relative(root, target).startsWith('..') || !target.startsWith(resolve(root) + sep))
    throw new Error('The generated folder is outside the repository');
  // Every folder on the way is a real folder of the checkout.
  let at = resolve(root);
  for (const part of posix
    .dirname(rel)
    .split('/')
    .filter((p) => p && p !== '.')) {
    at = join(at, part);
    const info = await lstat(at);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`${part} in the flow's path is not a folder of the repository`);
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target);
  for (const file of code.files) {
    if (file.name.includes('/') || file.name.includes('\\') || file.name.startsWith('.'))
      throw new Error(`Not a generated file name: ${file.name}`);
    await writeFile(join(target, file.name), file.text, { flag: 'wx' });
  }
  return posix.join(rel, code.files[0]?.name ?? '');
}

/** The folder of a path, for messages. */
export const folderOf = (path: string) => dirname(path);
