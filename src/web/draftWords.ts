// AFS-209: what a draft's changes are called on the pages (the activity line, the Undo note, the
// Save dialog and the commit message made of it), in the words of the designer's forms, not the
// file's field names: "changed the description of Rollback", not "changed Rollback (intent)".

/** One place a draft changes, as the server says it (a step, a note, or the flow itself). */
export interface DraftChange {
  step?: string;
  note?: string;
  kind: 'added' | 'removed' | 'changed';
  fields: string[];
}

/** A step's fields, as its form names them. */
const STEP_WORDS: Record<string, string> = {
  title: 'name',
  intent: 'description',
  accepted: 'accepted findings',
  impl: 'binding',
  undo: 'undo binding',
  inputs: 'inputs',
  outputs: 'outputs',
  settings: 'settings',
  condition: 'condition',
  ports: 'ports',
  notify: 'notifications',
  notified: 'notifications',
  approval: 'approval',
  join_mode: 'join',
  branches: 'branches',
  purpose: 'purpose',
  handler: 'purpose',
  ref: 'shared subflow',
  level: 'place',
  boundary: 'subflow boundary',
  disabled: 'on or off switch',
  expanded_from: 'origin',
};

/** The flow's own fields, as its form names them. */
const FLOW_WORDS: Record<string, string> = {
  name: 'name',
  goal: 'goal',
  owner: 'owner',
  runtime: 'runtime',
  imported_from: 'import source',
  maintenance_window: 'maintenance window',
  inputs: 'run inputs',
  outputs: 'run results',
  external_vars: 'outside variables',
  format: 'file format',
};

/** A note's fields. */
const NOTE_WORDS: Record<string, string> = { on: 'step it is on' };

/** "a", "a and b", "a, b and c". */
const listOf = (words: string[]) =>
  words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : (words[0] ?? '');

/** A field's name in words: known ones as the form says them, others from their last part. */
export function fieldWord(field: string, of: 'step' | 'flow' | 'note' = 'step'): string {
  const known = (of === 'flow' ? FLOW_WORDS : of === 'note' ? NOTE_WORDS : STEP_WORDS)[field];
  if (known) return known;
  return (field.split('.').at(-1) ?? field)
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

/** The fields of one change in words, three at most ("name, description and binding"). */
const fieldsOf = (c: DraftChange, of: 'step' | 'flow' | 'note') =>
  listOf([...new Set(c.fields.map((f) => fieldWord(f, of)))].slice(0, 3));

/**
 * One change in a few words: "added Backup", "changed the name and binding of Backup", "changed
 * the flow's run inputs", "added the note “Why”". `short` (a commit message) leaves out a note's
 * text and so never carries a cut text's "…".
 */
export function changeWords(c: DraftChange, short = false): string {
  if (c.note !== undefined) {
    if (short || !c.note) return `${c.kind} a note`;
    return `${c.kind} the note “${c.note.length > 40 ? `${c.note.slice(0, 39)}…` : c.note}”`;
  }
  if (!c.step) return `changed the flow's ${fieldsOf(c, 'flow') || 'settings'}`;
  if (c.kind !== 'changed') return `${c.kind} ${c.step}`;
  const fields = fieldsOf(c, 'step');
  return fields ? `changed the ${fields} of ${c.step}` : `moved ${c.step}`;
}

/**
 * A commit's subject made of changes: as many whole as fit in `room` characters, then "and N
 * more"; never cut in the middle, so no "…" ends up in git. The first one goes in whole.
 */
export function subjectOf(parts: string[], room = 72): string {
  let taken = 0;
  let subject = '';
  for (const part of parts) {
    const next = subject ? `${subject}; ${part}` : part;
    const rest = parts.length - taken - 1;
    const tail = rest > 0 ? ` and ${rest} more` : '';
    if (subject && next.length + tail.length > room) break;
    subject = next;
    taken += 1;
  }
  if (taken < parts.length) subject += ` and ${parts.length - taken} more`;
  return subject.replace(/^./, (c) => c.toUpperCase());
}
