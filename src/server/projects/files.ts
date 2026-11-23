// AFS-78: a project's files in the pages. The tree of a branch is read from the mirror; changes
// (files written, uploaded, unpacked from an archive, moved, deleted) are a change set the page
// keeps until Save, which makes one commit on the branch by the person who saves. The change set
// names the commit it began at: when the branch moved since, the save goes on top of where it is
// now, unless the branch changed one of the same files, which refuses it with those files listed.
// A save is recorded like a push (git_push), and audited.
//
// Paths follow the rules of an uploaded start (AFS-58): inside the project, no `.git`.
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { defaultBody, defaultMessage } from './changeWords';
import { type Git, GitError, MAX_FILE_BYTES, refProblem, type TreeEntry } from './git';
import { archiveFiles, MAX_FILES } from './start';
import { type Project, recordPushes } from './store';
import type { ProjectSync } from './sync';

/** Text a page may send as one file's new content. */
export const MAX_EDIT_BYTES = 1024 * 1024;
/** Changes in one save. */
export const MAX_CHANGES = 5000;

export type FileChange =
  | { op: 'write'; path: string; text?: string; base64?: string; executable?: boolean }
  | { op: 'delete'; path: string }
  | { op: 'move'; from: string; to: string }
  /** AFS-150: `replace` says the archive may replace files that are there; without it, refused. */
  | { op: 'unpack'; path: string; base64: string; replace?: boolean };

export interface FileEntry {
  path: string;
  size: number;
  executable?: boolean;
  link?: boolean;
}

export class FilesRefused extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'conflict' | 'replaces',
    message: string,
    /**
     * For a conflict: the files the branch changed since the change set began; for `replaces`, the
     * files an archive would replace.
     */
    readonly files?: string[],
    /** AFS-232: for a conflict, the branch's commit now, which a change set without those files
     * may begin at instead. */
    readonly head?: string,
  ) {
    super(message);
    this.name = 'FilesRefused';
  }
}

export interface FilesDeps {
  db: Kysely<Schema>;
  git: Git;
  sync: ProjectSync;
}

/** A path inside the project, or refused. Backslashes are taken as separators. */
export function filePath(raw: string, what = 'path'): string {
  const path = String(raw ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  if (
    !parts.length ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\0') ||
    parts.includes('..')
  )
    throw new FilesRefused(
      'invalid',
      `The ${what} ${JSON.stringify(raw)} is not inside the project`,
    );
  if (parts.some((p) => p.toLowerCase() === '.git'))
    throw new FilesRefused('invalid', `The ${what} ${JSON.stringify(raw)} is in a .git folder`);
  return parts.join('/');
}

/** A folder inside the project ('' is the top). */
const folderPath = (raw: string) =>
  String(raw ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.?\/*|\/+$/g, '') === ''
    ? ''
    : filePath(raw, 'folder');

/** The branch to read or change: the project's unless another is named; its newest commit. */
export async function branchHead(
  deps: FilesDeps,
  project: Project,
  branch?: string,
): Promise<{ branch: string; commit?: string }> {
  const name = branch?.trim() || project.gitRef;
  const problem = refProblem(name);
  if (problem) throw new FilesRefused('invalid', problem);
  const refs = await deps.git.refs(project.id).catch(() => new Map<string, string>());
  const commit = refs.get(name);
  if (!commit && name !== project.gitRef)
    throw new FilesRefused('not_found', `There is no branch ${name}`);
  return { branch: name, ...(commit ? { commit } : {}) };
}

export async function listFiles(
  deps: FilesDeps,
  project: Project,
  branch?: string,
): Promise<{ branch: string; commit?: string; files: FileEntry[] }> {
  const head = await branchHead(deps, project, branch);
  if (!head.commit) return { ...head, files: [] };
  const files = (await deps.git.tree(project.id, head.commit)).map((e) => ({
    path: e.path,
    size: e.size,
    ...(e.mode === '100755' ? { executable: true } : {}),
    ...(e.mode === '120000' ? { link: true } : {}),
  }));
  return { branch: head.branch, commit: head.commit, files };
}

/** What a file in the change set is: an existing object, or new bytes. */
type Planned = { mode: string; object?: string; bytes?: Buffer };

const decode = (base64: string, path: string): Buffer => {
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(base64))
    throw new FilesRefused('invalid', `${path}: the content is not base64`);
  return Buffer.from(base64, 'base64');
};

/**
 * The tree after the changes, applied in order to the files at `head`: a delete or a move names a
 * file or a folder; a write replaces or adds a file; an unpack writes an archive's files into a
 * folder.
 */
export async function planChanges(
  entries: TreeEntry[],
  changes: FileChange[],
  limits: { archiveMaxBytes: number },
): Promise<Map<string, Planned>> {
  const tree = new Map<string, Planned>(
    entries.map((e) => [e.path, { mode: e.mode, object: e.object }]),
  );
  const under = (path: string) =>
    [...tree.keys()].filter((p) => p === path || p.startsWith(`${path}/`));
  let unpacked = 0;
  for (const change of changes) {
    switch (change?.op) {
      case 'write': {
        const path = filePath(change.path);
        let bytes: Buffer;
        if (typeof change.text === 'string') {
          bytes = Buffer.from(change.text, 'utf8');
          if (bytes.length > MAX_EDIT_BYTES)
            throw new FilesRefused(
              'invalid',
              `${path}: text larger than ${MAX_EDIT_BYTES / 1024 / 1024} MB is uploaded, not edited`,
            );
        } else if (typeof change.base64 === 'string') bytes = decode(change.base64, path);
        else throw new FilesRefused('invalid', `${path}: a write needs text or base64`);
        if (bytes.length > MAX_FILE_BYTES)
          throw new FilesRefused(
            'invalid',
            `${path} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB: push it with git`,
          );
        const was = tree.get(path);
        const mode =
          change.executable === true
            ? '100755'
            : change.executable === false
              ? '100644'
              : was?.mode === '100755'
                ? '100755'
                : '100644';
        tree.set(path, { mode, bytes });
        break;
      }
      case 'delete': {
        const path = filePath(change.path);
        const gone = under(path);
        if (!gone.length) throw new FilesRefused('not_found', `There is no ${path} to delete`);
        for (const p of gone) tree.delete(p);
        break;
      }
      case 'move': {
        const from = filePath(change.from, 'source');
        const to = filePath(change.to, 'target');
        if (to === from) break;
        if (to.startsWith(`${from}/`))
          throw new FilesRefused('invalid', `${from} cannot move into itself`);
        const moving = under(from);
        if (!moving.length) throw new FilesRefused('not_found', `There is no ${from} to move`);
        const taken = under(to);
        if (taken.length) throw new FilesRefused('invalid', `${to} is there already`);
        for (const p of moving) {
          const file = tree.get(p) as Planned;
          tree.delete(p);
          tree.set(to + p.slice(from.length), file);
        }
        break;
      }
      case 'unpack': {
        const folder = folderPath(change.path);
        const bytes = decode(change.base64, folder || 'the archive');
        unpacked += bytes.length;
        if (unpacked > limits.archiveMaxBytes)
          throw new FilesRefused('invalid', 'The archives are larger than the server takes');
        let files: Awaited<ReturnType<typeof archiveFiles>>;
        try {
          files = await archiveFiles(
            bytes,
            { maxBytes: limits.archiveMaxBytes, maxFiles: MAX_FILES },
            { keepTop: true },
          );
        } catch (e) {
          throw new FilesRefused('invalid', (e as Error).message);
        }
        // AFS-150: an archive does not replace a file that is there (with other content) unless
        // the request says it may: the page lists those files and asks first.
        const replaced: string[] = [];
        for (const [path, file] of files) {
          const at = filePath(folder ? `${folder}/${path}` : path);
          const was = tree.get(at);
          if (
            was &&
            !(was.bytes
              ? was.bytes.equals(file.bytes)
              : was.object && blobId(file.bytes, was.object) === was.object)
          )
            replaced.push(at);
          tree.set(at, { mode: file.executable ? '100755' : '100644', bytes: file.bytes });
        }
        if (replaced.length && change.replace !== true)
          throw new FilesRefused(
            'replaces',
            `The archive replaces ${replaced.length === 1 ? 'a file that is' : `${replaced.length} files that are`} there already`,
            replaced.sort(),
          );
        break;
      }
      default:
        throw new FilesRefused('invalid', 'A change is write, delete, move or unpack');
    }
  }
  // A path cannot be a file and a folder at once.
  const paths = [...tree.keys()].sort();
  for (let i = 0; i + 1 < paths.length; i++) {
    const a = paths[i] as string;
    const b = paths[i + 1] as string;
    if (b.startsWith(`${a}/`))
      throw new FilesRefused('invalid', `${a} would be a file and a folder at once`);
  }
  return tree;
}

/** Git's id of a file's bytes, in the hash the repository uses (by the length of `like`). */
function blobId(bytes: Buffer, like: string): string {
  return createHash(like.length === 64 ? 'sha256' : 'sha1')
    .update(`blob ${bytes.length} `)
    .update(bytes)
    .digest('hex');
}

/** The writes and removes that turn `entries` into `tree`, and the paths they touch. */
export function diffTree(entries: TreeEntry[], tree: Map<string, Planned>) {
  const before = new Map(entries.map((e) => [e.path, e]));
  const writes: { path: string; mode: string; bytes?: Buffer; object?: string }[] = [];
  const removes: string[] = [];
  for (const [path, file] of tree) {
    const was = before.get(path);
    if (
      was &&
      file.mode === was.mode &&
      (file.bytes ? blobId(file.bytes, was.object) : file.object) === was.object
    )
      continue;
    writes.push({
      path,
      mode: file.mode,
      ...(file.bytes ? { bytes: file.bytes } : { object: file.object }),
    });
  }
  for (const path of before.keys()) if (!tree.has(path)) removes.push(path);
  return { writes, removes, touched: [...writes.map((w) => w.path), ...removes].sort() };
}

/** Save: one commit on the branch with the change set, by `by`. */
export async function saveFiles(
  deps: FilesDeps,
  project: Project,
  input: { branch?: string; base?: string; message?: string; changes: FileChange[] },
  by: { id: string; login: string; name: string },
  limits: { archiveMaxBytes: number },
): Promise<{ branch: string; commit: string; files: string[]; unchanged?: boolean }> {
  const changes = Array.isArray(input.changes) ? input.changes : [];
  if (!changes.length) throw new FilesRefused('invalid', 'There is nothing to save');
  if (changes.length > MAX_CHANGES)
    throw new FilesRefused('invalid', `More than ${MAX_CHANGES} changes in one save`);
  return deps.sync.exclusive(project.id, async () => {
    // A project with a source: where its branch is now, so nothing is pushed over.
    if (project.gitUrl) await deps.sync.refresh(project.id);
    const head = await branchHead(deps, project, input.branch);
    if (!head.commit) {
      // AFS-113: a hosted project with no commit at all (a new flow in an empty project): the
      // change set is its first commit.
      if (project.hosted && !project.gitUrl && !(await deps.git.branches(project.id)).length)
        return await firstCommit(deps, project, head.branch, changes, input.message, by, limits);
      throw new FilesRefused(
        'not_found',
        `${head.branch} has no commit yet: start the project or push to it first`,
      );
    }
    const entries = await deps.git.tree(project.id, head.commit);
    const tree = await planChanges(entries, changes, limits);
    const { writes, removes, touched } = diffTree(entries, tree);
    if (!touched.length)
      return { branch: head.branch, commit: head.commit, files: [], unchanged: true };
    // The branch moved since the change set began: refused only where it changed the same files.
    if (input.base && input.base !== head.commit) {
      let since: string[];
      try {
        since = (await deps.git.changedFiles(project.id, input.base, head.commit)).map(
          (c) => c.file,
        );
      } catch (e) {
        if (e instanceof GitError)
          throw new FilesRefused(
            'invalid',
            'The change set began at a commit the project does not have',
          );
        throw e;
      }
      const mine = new Set([
        ...touched,
        // A move or delete of a folder touches what the branch added in it too.
        ...changes.flatMap((c) =>
          c?.op === 'move' ? [c.from, c.to] : c?.op === 'delete' ? [c.path] : [],
        ),
      ]);
      const both = since.filter(
        (f) => mine.has(f) || [...mine].some((m) => f.startsWith(`${m.replace(/\/+$/, '')}/`)),
      );
      if (both.length)
        throw new FilesRefused(
          'conflict',
          `${head.branch} changed the same files since the change set began`,
          both.sort(),
          head.commit,
        );
    }
    const row = await deps.db
      .selectFrom('user_account')
      .select('email')
      .where('id', '=', by.id)
      .executeTakeFirst();
    // AFS-140: without a message, the words the page showed as its placeholder.
    const had = new Set(entries.map((e) => e.path));
    const subject = input.message?.trim() || defaultMessage(changes, (path) => had.has(path));
    // AFS-210: a subject that sums the changes up has them all in the body.
    const body = input.message?.trim() ? '' : defaultBody(changes, (path) => had.has(path));
    const commit = await deps.git.commitChanges(project.id, {
      parent: head.commit,
      writes,
      removes,
      author: { name: by.name, email: row?.email ?? `${by.login}@users.ansible-flow-server` },
      message: body ? `${subject}\n\n${body}\n` : `${subject}\n`,
    });
    await deps.git.publish(
      project.id,
      head.branch,
      head.commit,
      commit,
      project.gitUrl ? { url: project.gitUrl, auth: await deps.sync.auth(project) } : undefined,
    );
    await recordPushes(
      deps.db,
      project.id,
      by,
      [{ ref: head.branch, from: head.commit, to: commit }],
      'files',
    );
    await deps.sync.refresh(project.id);
    return { branch: head.branch, commit, files: touched };
  });
}

/** AFS-113: the change set as the first commit of an empty hosted project. */
async function firstCommit(
  deps: FilesDeps,
  project: Project,
  branch: string,
  changes: FileChange[],
  message: string | undefined,
  by: { id: string; login: string; name: string },
  limits: { archiveMaxBytes: number },
): Promise<{ branch: string; commit: string; files: string[] }> {
  const { writes, touched } = diffTree([], await planChanges([], changes, limits));
  if (!touched.length) throw new FilesRefused('invalid', 'There is nothing to save');
  const files = new Map(
    writes.map((w) => [
      w.path,
      { bytes: w.bytes ?? Buffer.alloc(0), ...(w.mode === '100755' ? { executable: true } : {}) },
    ]),
  );
  const row = await deps.db
    .selectFrom('user_account')
    .select('email')
    .where('id', '=', by.id)
    .executeTakeFirst();
  await deps.git.ensure(project.id, branch);
  const subject =
    message?.trim() || (touched.length === 1 ? `Add ${touched[0]}` : `Add ${touched.length} files`);
  const commit = await deps.git.commitFirst(project.id, branch, files, {
    author: { name: by.name, email: row?.email ?? `${by.login}@users.ansible-flow-server` },
    message: `${subject}\n`,
  });
  await recordPushes(deps.db, project.id, by, [{ ref: branch, to: commit }], 'files');
  await deps.sync.refresh(project.id);
  return { branch, commit, files: touched };
}

/** A file's bytes at a commit of the project, refused outside it. */
export async function readFile(
  deps: FilesDeps,
  project: Project,
  commit: string,
  path: string,
): Promise<Buffer> {
  const at = filePath(path);
  if (!(await deps.git.hasCommit(project.id, commit)))
    throw new FilesRefused('not_found', 'The project has no such commit');
  try {
    const bytes = await deps.git.read(project.id, commit, at);
    if (!bytes) throw new FilesRefused('not_found', `There is no ${at}`);
    return bytes;
  } catch (e) {
    if (e instanceof GitError) throw new FilesRefused('invalid', e.message);
    throw e;
  }
}
