// AFS-58: what a hosted project starts with, instead of waiting for a first push: one of the
// designer's sample projects (@ansible-flow/assets, samples/projects.json) or an uploaded archive
// (zip or tar.gz). Either becomes a set of files in memory, checked here, then one commit.
//
// An archive is untrusted: paths that leave the project (absolute, `..`, drive letters), links,
// devices and a `.git` folder are refused, not skipped, so what is committed is what was sent.
// Sizes are counted while unpacking, never taken from the archive's own headers, so a small file
// that unpacks to gigabytes stops at the limit.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { samplesDir } from '@ansible-flow/assets';
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import type { Kysely } from 'kysely';
import { extract } from 'tar-stream';
import type { Schema } from '../db/schema';
import { LaunchConfigs } from '../launch/configs';
import type { Git } from './git';
import { getProject, type Project, ProjectError, recordPushes } from './store';
import type { ProjectSync } from './sync';

/** A file of the start: its bytes, and whether it is a program (mode 100755). */
export interface StartFile {
  bytes: Buffer;
  executable?: boolean;
}

export type StartFiles = Map<string, StartFile>;

export class StartRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartRefused';
  }
}

export interface Limits {
  /** The unpacked files together, in bytes. */
  maxBytes: number;
  maxFiles: number;
}

export const MAX_FILES = 5000;

// --- samples

export interface Sample {
  key: string;
  name: string;
  description: string;
}

/** AFS-124: a launch configuration a sample project comes with (samples/projects.json). */
export interface SampleLaunch {
  name: string;
  description?: string;
  flowFile: string;
  inventory?: string;
  mode?: 'check' | 'real';
  inputs?: Record<string, unknown>;
}

interface SampleEntry extends Sample {
  files: { from: string; to: string }[];
  launchConfigs?: SampleLaunch[];
}

let samples: SampleEntry[] | undefined;

function sampleEntries(): SampleEntry[] {
  if (!samples) {
    const read = JSON.parse(readFileSync(join(samplesDir, 'projects.json'), 'utf8')) as {
      projects?: SampleEntry[];
    };
    samples = read.projects ?? [];
  }
  return samples;
}

/** The sample projects a hosted project can start from. */
export function listSamples(): Sample[] {
  return sampleEntries().map(({ key, name, description }) => ({ key, name, description }));
}

/** A sample's files, laid out as a project. */
export function sampleFiles(key: string): StartFiles {
  const sample = sampleEntries().find((s) => s.key === key);
  if (!sample) throw new StartRefused(`No sample "${key}"`);
  const files: StartFiles = new Map();
  const add = (from: string, to: string) => {
    const path = join(samplesDir, from);
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path)) add(posix.join(from, name), posix.join(to, name));
      return;
    }
    files.set(checkedPath(to), { bytes: readFileSync(path) });
  };
  for (const f of sample.files) add(f.from, f.to);
  return files;
}

/**
 * AFS-124: the launch configurations of a sample, made for a project just started from it, so its
 * flow runs at once. One that the server refuses (a name taken, a flow it cannot read) is skipped
 * and named in `skipped` with the reason: the project itself is there either way.
 */
export async function addSampleLaunchConfigs(
  deps: { db: Kysely<Schema>; git: Git },
  project: Project,
  key: string,
): Promise<{ made: string[]; skipped: { name: string; reason: string }[] }> {
  const configs = new LaunchConfigs(deps.db, deps.git);
  const out = { made: [] as string[], skipped: [] as { name: string; reason: string }[] };
  for (const c of sampleEntries().find((s) => s.key === key)?.launchConfigs ?? []) {
    try {
      await configs.create(project.id, {
        name: c.name,
        ...(c.description ? { description: c.description } : {}),
        flowFile: c.flowFile,
        ...(c.inventory ? { inventory: c.inventory } : {}),
        mode: c.mode ?? 'check',
        inputs: c.inputs ?? {},
      });
      out.made.push(c.name);
    } catch (e) {
      out.skipped.push({ name: c.name, reason: (e as Error).message });
    }
  }
  return out;
}

// --- archives

/** A path inside the project, or refused. Backslashes are taken as separators. */
function checkedPath(raw: string): string {
  const path = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  if (
    !parts.length ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\0') ||
    parts.includes('..')
  )
    throw new StartRefused(`The archive has a path outside the project: ${JSON.stringify(raw)}`);
  if (parts.some((p) => p.toLowerCase() === '.git'))
    throw new StartRefused('The archive has a .git folder: send the files, not a repository');
  return parts.join('/');
}

/** What kind of archive the bytes are, by their first bytes. */
export function archiveKind(bytes: Buffer): 'zip' | 'tar.gz' | undefined {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)
    return 'zip';
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'tar.gz';
  return undefined;
}

/**
 * The files of a zip or tar.gz archive, with one folder that holds everything taken off (a start);
 * `keepTop` keeps it (AFS-78: a folder's archive unpacked into a folder of the project).
 */
export async function archiveFiles(
  bytes: Buffer,
  limits: Limits,
  options: { keepTop?: boolean } = {},
): Promise<StartFiles> {
  const kind = archiveKind(bytes);
  if (!kind) throw new StartRefused('Not a zip or tar.gz archive');
  const files = kind === 'zip' ? unzip(bytes, limits) : await untar(bytes, limits);
  if (!files.size) throw new StartRefused('The archive has no files');
  return options.keepTop ? files : withoutTopFolder(files);
}

/** A tally of what is unpacked, refused past the limits. */
function counter(limits: Limits) {
  let bytes = 0;
  let count = 0;
  const mb = Math.round(limits.maxBytes / (1024 * 1024));
  return {
    file() {
      if (++count > limits.maxFiles)
        throw new StartRefused(`The archive has more than ${limits.maxFiles} files`);
    },
    bytes(n: number) {
      bytes += n;
      if (bytes > limits.maxBytes)
        throw new StartRefused(`The archive unpacks to more than ${mb} MB`);
    },
  };
}

function unzip(bytes: Buffer, limits: Limits): StartFiles {
  const files: StartFiles = new Map();
  const tally = counter(limits);
  let failure: unknown;
  const unzipper = new Unzip((entry) => {
    if (failure) return;
    try {
      // Folders are implied by the files in them.
      if (entry.name.endsWith('/')) return;
      const path = checkedPath(entry.name);
      tally.file();
      const chunks: Uint8Array[] = [];
      entry.ondata = (error, chunk, final) => {
        if (failure) return;
        try {
          if (error) throw new StartRefused(`The zip file is damaged: ${error.message}`);
          tally.bytes(chunk.length);
          chunks.push(chunk);
          if (final) files.set(path, { bytes: Buffer.concat(chunks) });
        } catch (e) {
          failure = e;
          entry.terminate();
        }
      };
      entry.start();
    } catch (e) {
      failure = e;
    }
  });
  unzipper.register(UnzipInflate);
  unzipper.register(UnzipPassThrough);
  // Fed in pieces: a refusal stops the unpacking at the next piece.
  for (let at = 0; at < bytes.length && !failure; at += 64 * 1024)
    unzipper.push(bytes.subarray(at, at + 64 * 1024), at + 64 * 1024 >= bytes.length);
  if (failure) throw failure;
  // Zip keeps Unix modes in the upper half of the external attributes; fflate does not expose
  // them, so programs in a zip are committed as plain files (tar keeps them).
  return files;
}

async function untar(bytes: Buffer, limits: Limits): Promise<StartFiles> {
  let tar: Buffer;
  try {
    // The tar itself is at most the limit plus its headers (512 bytes each).
    tar = gunzipSync(bytes, { maxOutputLength: limits.maxBytes + (limits.maxFiles + 2) * 1024 });
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
      throw new StartRefused(
        `The archive unpacks to more than ${Math.round(limits.maxBytes / (1024 * 1024))} MB`,
      );
    throw new StartRefused('The tar.gz file is damaged');
  }
  const files: StartFiles = new Map();
  const tally = counter(limits);
  const reader = extract();
  const done = new Promise<void>((resolve, reject) => {
    reader.on('entry', (header, stream, next) => {
      try {
        if (header.type === 'directory') {
          stream.resume();
          stream.on('end', next);
          return;
        }
        if (header.type !== 'file' && header.type !== 'contiguous-file')
          throw new StartRefused(
            `The archive has a ${header.type ?? 'special'} entry (${header.name}): only files and folders are taken`,
          );
        const path = checkedPath(header.name);
        tally.file();
        const chunks: Buffer[] = [];
        stream.on('data', (data: unknown) => {
          const chunk = data as Buffer;
          try {
            tally.bytes(chunk.length);
            chunks.push(chunk);
          } catch (e) {
            reader.destroy(e as Error);
          }
        });
        stream.on('end', () => {
          files.set(path, {
            bytes: Buffer.concat(chunks),
            ...((header.mode ?? 0) & 0o111 ? { executable: true } : {}),
          });
          next();
        });
      } catch (e) {
        stream.resume();
        reader.destroy(e as Error);
      }
    });
    reader.on('finish', resolve);
    reader.on('error', (e) =>
      reject(e instanceof StartRefused ? e : new StartRefused('The tar.gz file is damaged')),
    );
  });
  Readable.from([tar]).pipe(reader);
  await done;
  return files;
}

/** An archive of one folder (`project/…`, as most tools make them) gives what is in the folder. */
function withoutTopFolder(files: StartFiles): StartFiles {
  const tops = new Set([...files.keys()].map((p) => p.split('/')[0]));
  const [top] = tops;
  if (tops.size !== 1 || !top || files.has(top)) return files;
  return new Map([...files].map(([path, file]) => [path.slice(top.length + 1), file]));
}

// --- the first commit

/**
 * Gives a hosted project that has no commits its first one, made of `files`, by `by`. Refused for
 * a project with a source (its history is the source's) and for one that has commits already.
 */
export async function startProject(
  deps: { db: Kysely<Schema>; git: Git; sync: ProjectSync },
  project: Project,
  files: StartFiles,
  by: { id: string; login: string; name: string },
  what: string,
): Promise<{ project: Project; commit: string; files: number }> {
  if (!project.hosted)
    throw new ProjectError(
      'invalid',
      'Only a project the server hosts starts from files; this one has a source of its own',
    );
  const commit = await deps.sync.exclusive(project.id, async () => {
    await deps.git.ensure(project.id, project.gitRef);
    if ((await deps.git.branches(project.id)).length)
      throw new ProjectError('not_empty', 'The project has commits already: push to it instead');
    const row = await deps.db
      .selectFrom('user_account')
      .select('email')
      .where('id', '=', by.id)
      .executeTakeFirst();
    const made = await deps.git.commitFirst(project.id, project.gitRef, files, {
      author: { name: by.name, email: row?.email ?? `${by.login}@users.ansible-flow-server` },
      message: `Start ${project.key} from ${what}\n`,
    });
    await recordPushes(deps.db, project.id, by, [{ ref: project.gitRef, to: made }]);
    await deps.sync.refresh(project.id);
    return made;
  });
  return { project: (await getProject(deps.db, project.id)) ?? project, commit, files: files.size };
}
