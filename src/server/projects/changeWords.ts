// AFS-140: a change set in words. Values only, no server code: the Files page shows the default
// commit message as the placeholder of Message, and the server writes the same words when the
// message is left empty.
import type { FileChange } from './files';

/**
 * Words for one change. AFS-153: `existed` says whether a path is in the commit the change set
 * starts from: a new file typed is added, not edited.
 */
export function changeWords(c: FileChange, existed?: (path: string) => boolean): string {
  switch (c.op) {
    case 'write':
      // AFS-210: an upload over a file that is there says it replaces it.
      if (c.text === undefined)
        return existed?.(c.path) ? `Replace ${c.path} with an upload` : `Upload ${c.path}`;
      return `${existed && !existed(c.path) ? 'Add' : 'Edit'} ${c.path}`;
    case 'delete':
      return `Delete ${c.path}`;
    case 'move':
      return `Move ${c.from} to ${c.to}`;
    case 'unpack':
      return `Unpack an archive into ${c.path || 'the top folder'}`;
  }
}

/** The commit message of a change set saved without one. */
export function defaultMessage(
  changes: readonly FileChange[],
  existed?: (path: string) => boolean,
): string {
  const words = changes.map((c) => changeWords(c, existed));
  const joined =
    words.length <= 3 ? words.join('; ') : `${words[0]} and ${words.length - 1} more changes`;
  return joined.length > 200 ? `${joined.slice(0, 199)}…` : joined;
}

const clean = (p: string) => p.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');

/**
 * Where `path` is once the change set is saved: followed through its moves (of the file or a folder
 * it is in), in order; null when a delete takes it away. A path no change touches is itself.
 */
export function whereAfter(path: string, changes: readonly FileChange[]): string | null {
  let at: string | null = clean(path);
  const holds = (base: string) => at !== null && (at === base || at.startsWith(`${base}/`));
  for (const c of changes) {
    if (at === null) break;
    if (c.op === 'move') {
      const from = clean(c.from);
      if (from && holds(from)) at = clean(c.to) + at.slice(from.length);
    } else if (c.op === 'delete') {
      const gone = clean(c.path);
      if (gone && holds(gone)) at = null;
    }
  }
  return at;
}

/** How many changes a commit's body lists one by one. */
const BODY_LINES = 100;

/**
 * AFS-210: the body of a commit saved without a message, when its subject does not say every
 * change: each change on a line of its own, so History shows them all.
 */
export function defaultBody(
  changes: readonly FileChange[],
  existed?: (path: string) => boolean,
): string {
  if (changes.length <= 3 && !defaultMessage(changes, existed).endsWith('…')) return '';
  const lines = changes.slice(0, BODY_LINES).map((c) => `- ${changeWords(c, existed)}`);
  if (changes.length > BODY_LINES) lines.push(`- and ${changes.length - BODY_LINES} more`);
  return lines.join('\n');
}
