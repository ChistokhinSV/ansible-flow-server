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
      return `${c.text === undefined ? 'Upload' : existed && !existed(c.path) ? 'Add' : 'Edit'} ${c.path}`;
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
