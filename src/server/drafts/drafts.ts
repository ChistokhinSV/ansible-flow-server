// AFS-76: a flow edited in the pages. Everyone editing one flow edits one draft: the text of the
// flow at a commit of the project's branch, changed by the designer's own commands, in the order
// the server gets them. Commands name steps by their IDs, so two people's edits of different steps
// both apply; the same field twice: the later one wins. Each edit is kept (who, the text before and
// after): undo takes back a person's own last edit with the flow merge, and refuses when someone
// changed the same place since; redo (AFS-172) brings back what undo took, the same way. Save makes one commit on the branch (merged first when the branch
// moved on), by the person who saves, with everyone else who edited as co-authors.

import { randomUUID } from 'node:crypto';
import { CommandError, type FlowCommand, planCommand } from '@ansible-flow/core/flow/commands';
import { parseFlow } from '@ansible-flow/core/flow/document';
import { createIdFactory } from '@ansible-flow/core/flow/ids';
import { mergeFlows } from '@ansible-flow/core/flow/merge';
import { writeMergedFlow } from '@ansible-flow/core/flow/mergeText';
import { buildModel, ROOT } from '@ansible-flow/core/flow/model';
import { planSave } from '@ansible-flow/core/flow/save';
import { diffFlows } from '@ansible-flow/core/flow/semanticDiff';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import { applyEdits } from '@ansible-flow/core/yaml/edits';
import { layoutLevel } from '@ansible-flow/node/autoLayout';
import { mergeFlowTexts } from '@ansible-flow/node/flowMerge';
import type { Kysely } from 'kysely';
import type { FlowDraftEditTable, Schema } from '../db/schema';
import type { Logger } from '../log';
import { FLOW_FILE } from '../projects/flows';
import type { Git } from '../projects/git';
import { getProject, type Project, recordPushes } from '../projects/store';
import type { ProjectSync } from '../projects/sync';
import { type DraftFile, hasNoSteps, startedFrom } from './startFrom';

export interface Editor {
  id: string;
  login: string;
  name: string;
}

export interface Draft {
  id: string;
  project: string;
  file: string;
  baseCommit: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Everyone who changed it, the first first. */
  editors: Editor[];
}

export class DraftError extends Error {
  constructor(
    readonly code: 'not_found' | 'refused' | 'conflict' | 'invalid',
    message: string,
    /** For a conflict on Save: the places both the draft and the branch changed. */
    readonly conflicts?: SaveConflict[],
    /** AFS-186: the draft's revision those conflicts were read at (a choice is for that one). */
    readonly revision?: number,
  ) {
    super(message);
    this.name = 'DraftError';
  }
}

/**
 * AFS-149: a place both the draft and the branch changed since the draft began, with each side's
 * value in short (null: that side removed it or has none).
 */
export interface SaveConflict {
  id: string;
  label: string;
  draft: string | null;
  branch: string | null;
}

/** AFS-149: what one edit did, in words for the others' pages. */
export interface EditChange {
  /** A step, or the flow itself (its name, goal, inputs) when absent (and no note). */
  step?: string;
  /** AFS-186: a note, section or text on the canvas, by its first line. */
  note?: string;
  kind: 'added' | 'removed' | 'changed';
  /** The fields changed, dotted (`settings.timeout`); none for a step added, removed or moved. */
  fields: string[];
}

/** What happened to a draft, for the pages watching it. */
export type DraftNews =
  | {
      kind: 'edit';
      revision: number;
      by: Editor;
      nodes: string[];
      changes: EditChange[];
      wires: number;
    }
  | { kind: 'saved'; commit: string; by: Editor; coAuthors: string[] }
  | { kind: 'discarded'; by: Editor };

type Db = Kysely<Schema>;
/** AFS-186: how long a discarded draft can be brought back. */
const KEEP_DISCARDED_MS = 15 * 60_000;
const now = () => new Date().toISOString();

/** The steps an edit added, removed or changed: what the others' pages mark. */
function changedNodes(before: string, after: string): string[] {
  const a = parseFlow(before).doc;
  const b = parseFlow(after).doc;
  return a && b ? diffFlows(a, b).nodes.map((n) => n.id) : [];
}

/**
 * The steps that differ between two versions, by their titles as `now` has them (the other's for a
 * step `now` lacks). AFS-151: steps inside subflows are named too, not "a step".
 */
function stepTitles(now: string, other: string): string[] {
  const docs = [parseFlow(other).doc, parseFlow(now).doc].filter((d) => !!d);
  const titles = new Map(
    docs.flatMap((d) =>
      [...buildModel(d).nodes.values()].map(({ node }) => [node.id, node.title] as const),
    ),
  );
  return changedNodes(other, now).map((n) => titles.get(n) ?? 'a step');
}

/** AFS-149: what an edit did, step by step and to the flow's own fields. */
function changesOf(before: string, after: string): { changes: EditChange[]; wires: number } {
  const a = parseFlow(before).doc;
  const b = parseFlow(after).doc;
  if (!a || !b) return { changes: [], wires: 0 };
  const diff = diffFlows(a, b);
  const changes: EditChange[] = diff.nodes.map((n) => ({
    step: n.title,
    kind: n.kind,
    fields: n.kind === 'changed' ? n.fields.map((f) => f.field) : [],
  }));
  // AFS-186: a note's text is a change too (an undo of it is not "a move on the canvas").
  for (const a of diff.annotations)
    changes.push({
      note: a.label || a.annotation,
      kind: a.kind,
      fields: a.kind === 'changed' ? a.fields.map((f) => f.field) : [],
    });
  if (diff.flow.length) changes.push({ kind: 'changed', fields: diff.flow.map((f) => f.field) });
  return { changes, wires: diff.wires.length };
}

/**
 * AFS-186: what a draft changes against the commit it began at, step by step, with who changed
 * each (the people whose edits, not taken back, touched it), for the Save dialog.
 */
export interface DraftSummary {
  /** Something to save: the flow differs from its commit, or files come with it. */
  changed: boolean;
  changes: (EditChange & { by: string[] })[];
  wires: number;
}

/** AFS-149: one side's value of a clashing place, in short. */
function shortValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const cut = (text: string) => (text.length > 160 ? `${text.slice(0, 159)}…` : text);
  if (typeof value === 'string') return cut(value);
  if (typeof value === 'object' && 'title' in value && typeof value.title === 'string')
    return `the step "${value.title}"`;
  return cut(JSON.stringify(value) ?? String(value));
}

export class Drafts {
  private readonly newId = createIdFactory();
  /** One change of a draft at a time on this server; the revision guards across servers. */
  private readonly queue = new Map<string, Promise<unknown>>();
  private readonly listeners = new Map<string, Set<(news: DraftNews) => void>>();

  /** AFS-151: what git said is at a path of a commit (`probe`). */
  private readonly seen = new Map<string, Promise<boolean>>();
  /** AFS-186: the flow at a commit, for whether a draft changes anything (`changed`). */
  private readonly bases = new Map<string, Promise<string | undefined>>();
  /** AFS-186: drafts discarded a moment ago, by their id, to bring back (`restore`). */
  private readonly discarded = new Map<
    string,
    {
      project: string;
      file: string;
      baseCommit: string;
      text: string;
      files: DraftFile[];
      at: number;
    }
  >();

  constructor(private readonly deps: { db: Db; git: Git; sync: ProjectSync; log: Logger }) {}

  private one<T>(id: string, work: () => Promise<T>): Promise<T> {
    const before = this.queue.get(id) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    this.queue.set(id, tail);
    void tail.then(() => {
      if (this.queue.get(id) === tail) this.queue.delete(id);
    });
    return run;
  }

  /** Tells the pages watching a draft on this server (the others read the revision). */
  subscribe(id: string, listener: (news: DraftNews) => void): () => void {
    const set = this.listeners.get(id) ?? new Set();
    set.add(listener);
    this.listeners.set(id, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(id);
    };
  }

  private tell(id: string, news: DraftNews): void {
    for (const l of this.listeners.get(id) ?? []) {
      try {
        l(news);
      } catch (e) {
        this.deps.log.warn({ err: e }, 'A draft listener failed');
      }
    }
  }

  private async editors(id: string): Promise<Editor[]> {
    const rows = await this.deps.db
      .selectFrom('flow_draft_edit')
      .innerJoin('user_account', 'user_account.id', 'flow_draft_edit.user_id')
      .select([
        'user_account.id',
        'user_account.login',
        'user_account.name',
        'flow_draft_edit.revision',
      ])
      .where('flow_draft_edit.draft_id', '=', id)
      .orderBy('flow_draft_edit.revision')
      .execute();
    const seen = new Map<string, Editor>();
    for (const r of rows)
      if (!seen.has(r.id)) seen.set(r.id, { id: r.id, login: r.login, name: r.name });
    return [...seen.values()];
  }

  private async row(id: string) {
    return this.deps.db
      .selectFrom('flow_draft')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  private async view(row: NonNullable<Awaited<ReturnType<Drafts['row']>>>): Promise<Draft> {
    return {
      id: row.id,
      project: row.project_id,
      file: row.file,
      baseCommit: row.base_commit,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      editors: await this.editors(row.id),
    };
  }

  async get(id: string): Promise<Draft | undefined> {
    const row = await this.row(id);
    return row ? this.view(row) : undefined;
  }

  /** The draft's text and revision. */
  async text(id: string): Promise<{ text: string; revision: number; file: string } | undefined> {
    const row = await this.row(id);
    return row ? { text: row.text, revision: row.revision, file: row.file } : undefined;
  }

  /** The drafts of a project, for its pages (a flow with unsaved edits says so). */
  async list(projectId: string): Promise<Draft[]> {
    const rows = await this.deps.db
      .selectFrom('flow_draft')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('file')
      .execute();
    return Promise.all(rows.map((r) => this.view(r)));
  }

  /** The flow's draft, made from the project's commit when there is none yet. */
  async open(project: Project, file: string, by: Editor): Promise<Draft> {
    if (!FLOW_FILE.test(file)) throw new DraftError('invalid', 'Not a flow file');
    const found = await this.deps.db
      .selectFrom('flow_draft')
      .selectAll()
      .where('project_id', '=', project.id)
      .where('file', '=', file)
      .executeTakeFirst();
    if (found) return this.view(found);
    if (!project.commit) throw new DraftError('refused', 'The project has no commit yet');
    const bytes = await this.deps.git.read(project.id, project.commit, file);
    if (!bytes) throw new DraftError('not_found', 'The project has no such flow at its commit');
    const text = bytes.toString('utf8');
    if (!parseFlow(text).doc)
      throw new DraftError('refused', 'The flow cannot be read: fix it in git');
    const at = now();
    const id = randomUUID();
    try {
      await this.deps.db
        .insertInto('flow_draft')
        .values({
          id,
          project_id: project.id,
          file,
          base_commit: project.commit,
          text,
          revision: 0,
          created_by: by.id,
          created_at: at,
          updated_at: at,
        })
        .execute();
    } catch {
      // Someone opened it at the same moment: theirs is the one.
      return this.open(project, file, by);
    }
    return this.view((await this.row(id)) as NonNullable<Awaited<ReturnType<Drafts['row']>>>);
  }

  /** Writes a new text for a draft at `revision`, and keeps the edit. */
  private async write(
    id: string,
    by: Editor,
    kind: FlowDraftEditTable['kind'],
    before: { text: string; revision: number },
    after: string,
    files?: DraftFile[],
    /** AFS-172: a redo keeps the person's other undos to redo; any new edit of theirs ends them. */
    redoing = false,
  ): Promise<number> {
    const revision = before.revision + 1;
    const at = now();
    await this.deps.db.transaction().execute(async (trx) => {
      const done = await trx
        .updateTable('flow_draft')
        .set({ text: after, revision, updated_at: at })
        .where('id', '=', id)
        .where('revision', '=', before.revision)
        .executeTakeFirst();
      if (Number(done.numUpdatedRows) !== 1)
        throw new DraftError('refused', 'The draft changed meanwhile: try again');
      await trx
        .insertInto('flow_draft_edit')
        .values({
          id: randomUUID(),
          draft_id: id,
          revision,
          user_id: by.id,
          kind,
          before_text: before.text,
          after_text: after,
          files_json: files?.length
            ? JSON.stringify(
                files.map((f) => ({ path: f.path, base64: f.bytes.toString('base64') })),
              )
            : null,
          undone: 0,
          at,
        })
        .execute();
      if (!redoing && kind !== 'undo' && kind !== 'undo-start')
        await trx
          .updateTable('flow_draft_edit')
          .set({ undone: 1 })
          .where('draft_id', '=', id)
          .where('user_id', '=', by.id)
          .where('kind', 'in', ['undo', 'undo-start'])
          .where('undone', '=', 0)
          .execute();
    });
    this.tell(id, {
      kind: 'edit',
      revision,
      by,
      nodes: changedNodes(before.text, after),
      ...changesOf(before.text, after),
    });
    return revision;
  }

  /** One of the designer's commands, on the draft as it is now. */
  async apply(
    id: string,
    by: Editor,
    command: FlowCommand,
  ): Promise<{ revision: number; created?: string; pasted?: string[] }> {
    return this.one(id, async () => {
      const current = await this.text(id);
      if (!current) throw new DraftError('not_found', 'No such draft');
      // A decision records who made it: the person, as the server knows them.
      const cmd =
        command.kind === 'setDecision' && !command.by ? { ...command, by: by.login } : command;
      let planned: ReturnType<typeof planCommand>;
      try {
        planned = planCommand(current.text, cmd, { newId: this.newId });
      } catch (e) {
        if (e instanceof CommandError || e instanceof Error)
          throw new DraftError('refused', (e as Error).message);
        throw e;
      }
      const extra = {
        ...(planned.created ? { created: planned.created } : {}),
        ...(planned.pasted ? { pasted: planned.pasted } : {}),
      };
      if (planned.text === current.text) return { revision: current.revision, ...extra };
      const kind = cmd.kind === 'tidyUp' ? 'layout' : 'command';
      return { revision: await this.write(id, by, kind, current, planned.text), ...extra };
    });
  }

  /**
   * AFS-126: the draft's flow replaced by one made from something (a sample, a playbook, an AWX
   * template), as one edit Ctrl+Z takes back. Only while the flow has no step: it never writes
   * over someone's work.
   */
  async replace(
    id: string,
    by: Editor,
    make: (current: string) => Promise<string | { text: string; files?: DraftFile[] }>,
  ): Promise<{ revision: number }> {
    return this.one(id, async () => {
      const current = await this.text(id);
      if (!current) throw new DraftError('not_found', 'No such draft');
      if (!hasNoSteps(current.text))
        throw new DraftError(
          'refused',
          'The flow has steps already: start from something only in an empty flow',
        );
      let made: Awaited<ReturnType<typeof make>>;
      try {
        made = await make(current.text);
      } catch (e) {
        throw new DraftError('refused', (e as Error).message);
      }
      const { text, files } = typeof made === 'string' ? { text: made, files: undefined } : made;
      // AFS-151: kind 'start', so its undo says what it took back as one thing (AFS-173: and the
      // files it brings, which are kept on the edit).
      return { revision: await this.write(id, by, 'start', current, text, files) };
    });
  }

  /** Tidy Up: the level laid out again, as one edit. */
  async tidy(id: string, by: Editor, level = ROOT): Promise<{ revision: number }> {
    const current = await this.text(id);
    const doc = current ? parseFlow(current.text).doc : undefined;
    const found = doc ? buildModel(doc).levels.get(level) : undefined;
    if (!found) throw new DraftError('not_found', 'No such level');
    return this.apply(id, by, {
      kind: 'tidyUp',
      positions: await layoutLevel(found),
    } as FlowCommand);
  }

  /**
   * Takes back the person's own last edit that is not taken back yet: the flow merged with the
   * version before it, so what others changed since stays. Refused when they changed the same
   * place.
   */
  async undo(
    id: string,
    by: Editor,
  ): Promise<{
    revision: number;
    steps: string[];
    nothing?: true;
    message?: string;
    /** AFS-151: a start from a sample or an import was taken back: what it was, and its steps. */
    started?: { what: string; steps: number };
    changes?: EditChange[];
    wires?: number;
  }> {
    return this.one(id, async () => {
      const current = await this.text(id);
      if (!current) throw new DraftError('not_found', 'No such draft');
      const last = await this.deps.db
        .selectFrom('flow_draft_edit')
        .selectAll()
        .where('draft_id', '=', id)
        .where('user_id', '=', by.id)
        .where('undone', '=', 0)
        .where('kind', 'not in', ['undo', 'undo-start'])
        .orderBy('revision', 'desc')
        .executeTakeFirst();
      // AFS-149: nothing to take back is an answer, not a refusal.
      if (!last)
        return {
          revision: current.revision,
          steps: [],
          nothing: true,
          message: 'Nothing of yours to undo in this draft',
        };
      const doc = (t: string) => parseFlow(t).doc as FlowDocument;
      const merged = mergeFlows(doc(last.after_text), doc(current.text), doc(last.before_text));
      if (merged.conflicts.length)
        throw new DraftError(
          'refused',
          `Someone changed the same place since: ${merged.conflicts.map((c) => c.label).join('; ')}`,
        );
      const text = writeMergedFlow(current.text, merged.doc);
      // AFS-172: an undo of a start says so, for its redo.
      const kind = last.kind === 'start' ? 'undo-start' : 'undo';
      const revision = await this.write(id, by, kind, current, text);
      await this.deps.db
        .updateTable('flow_draft_edit')
        .set({ undone: 1 })
        .where('id', '=', last.id)
        .execute();
      if (last.kind === 'start')
        return { revision, steps: [], started: startedFrom(last.after_text) };
      // AFS-136: what was taken back, by the steps' titles as they are again (none: a move).
      // AFS-186: and what it was (a note's text, the flow's goal), in the activity's words.
      return {
        revision,
        steps: stepTitles(last.before_text, last.after_text),
        ...changesOf(last.after_text, last.before_text),
      };
    });
  }

  /**
   * AFS-172: brings back what the person's last undo took, while they made no other edit since:
   * the flow merged with the version before that undo, so what others changed since stays.
   * Refused when they changed the same place. A redo is an edit Ctrl+Z takes back again.
   */
  async redo(
    id: string,
    by: Editor,
  ): Promise<{
    revision: number;
    steps: string[];
    nothing?: true;
    message?: string;
    started?: { what: string; steps: number };
    changes?: EditChange[];
    wires?: number;
  }> {
    return this.one(id, async () => {
      const current = await this.text(id);
      if (!current) throw new DraftError('not_found', 'No such draft');
      const last = await this.deps.db
        .selectFrom('flow_draft_edit')
        .selectAll()
        .where('draft_id', '=', id)
        .where('user_id', '=', by.id)
        .where('undone', '=', 0)
        .where('kind', 'in', ['undo', 'undo-start'])
        .orderBy('revision', 'desc')
        .executeTakeFirst();
      if (!last)
        return {
          revision: current.revision,
          steps: [],
          nothing: true,
          message: 'Nothing of yours to redo in this draft',
        };
      const doc = (t: string) => parseFlow(t).doc as FlowDocument;
      const merged = mergeFlows(doc(last.after_text), doc(current.text), doc(last.before_text));
      if (merged.conflicts.length)
        throw new DraftError(
          'refused',
          `Someone changed the same place since: ${merged.conflicts.map((c) => c.label).join('; ')}`,
        );
      const text = writeMergedFlow(current.text, merged.doc);
      const started = last.kind === 'undo-start';
      // AFS-173: a start brought back brings back the sample's files of the start its undo took.
      const files = started ? await this.startFiles(id, by, last.revision) : undefined;
      const revision = await this.write(
        id,
        by,
        started ? 'start' : 'redo',
        current,
        text,
        files,
        true,
      );
      await this.deps.db
        .updateTable('flow_draft_edit')
        .set({ undone: 1 })
        .where('id', '=', last.id)
        .execute();
      if (started) return { revision, steps: [], started: startedFrom(text) };
      return {
        revision,
        steps: stepTitles(last.before_text, last.after_text),
        ...changesOf(last.after_text, last.before_text),
      };
    });
  }

  /**
   * One commit on the project's branch with the draft's flow. When the branch moved since the
   * draft began, the draft is merged onto it first; conflicts refuse the save unless `force`
   * (the draft's side at each).
   */
  async save(
    id: string,
    by: Editor & { email?: string | null },
    options: {
      message?: string;
      force?: boolean;
      /** AFS-149: per clashing place (by its id), whose side to keep; the draft's when not given. */
      choices?: Record<string, 'draft' | 'branch'>;
      /**
       * AFS-186: the draft's revision the choices were made at. Changed since (someone edited a
       * place shown), the save is refused with the places as they are now, to choose again.
       */
      seen?: number;
    } = {},
  ): Promise<{ commit: string; unchanged?: boolean; coAuthors?: string[]; added?: string[] }> {
    const row = await this.row(id);
    if (!row) throw new DraftError('not_found', 'No such draft');
    const { git, sync } = this.deps;
    return sync.exclusive(row.project_id, () =>
      this.one(id, async () => {
        const draft = await this.row(id);
        if (!draft) throw new DraftError('not_found', 'No such draft');
        const project = await sync.refresh(draft.project_id);
        if (!project?.commit)
          throw new DraftError('refused', 'The project has no commit to save onto');
        const head = project.commit;
        const headBytes = await git.read(project.id, head, draft.file);
        if (!headBytes)
          throw new DraftError('refused', 'The flow is gone from the branch: discard the draft');
        const headText = headBytes.toString('utf8');
        let text = draft.text;
        if (head !== draft.base_commit) {
          const base = (await git.read(project.id, draft.base_commit, draft.file))?.toString(
            'utf8',
          );
          const choices = Object.fromEntries(
            Object.entries(options.choices ?? {}).map(([c, side]) => [
              c,
              side === 'branch' ? ('theirs' as const) : ('ours' as const),
            ]),
          );
          const merged =
            base !== undefined ? mergeFlowTexts(base, draft.text, headText, choices) : undefined;
          if (merged?.kind !== 'merged')
            throw new DraftError(
              'refused',
              'The branch changed this flow in a way that cannot be merged',
            );
          // AFS-149: a place with a side chosen is settled; any other refuses unless forced.
          const open = merged.merge.conflicts.filter((c) => !options.choices?.[c.id]);
          const clashes = merged.merge.conflicts.map((c) => ({
            id: c.id,
            label: c.label,
            draft: shortValue(c.ours),
            branch: shortValue(c.theirs),
          }));
          if (open.length && !options.force)
            throw new DraftError(
              'conflict',
              'The branch changed the same places since the draft began',
              clashes,
              draft.revision,
            );
          // AFS-186: the choices were made on values someone has changed since: chosen again.
          if (
            options.choices &&
            options.seen !== undefined &&
            options.seen !== draft.revision &&
            clashes.length
          )
            throw new DraftError(
              'conflict',
              'The draft changed while you chose: check the values again',
              clashes,
              draft.revision,
            );
          text = merged.text;
        }
        const editors = await this.editors(id);
        // AFS-173: what a start from a sample brings, but never over what the branch has (it may
        // have come since the start): a role there already keeps its own whole folder.
        const adds: DraftFile[] = [];
        const there = new Map<string, Promise<boolean>>();
        for (const f of await this.files(id)) {
          const at = /^roles\/[^/]+/.exec(f.path)?.[0] ?? f.path;
          if (!there.has(at)) there.set(at, git.exists(project.id, head, at));
          if (!(await there.get(at))) adds.push(f);
        }
        if (text === headText && !adds.length) {
          await this.drop(id);
          this.tell(id, { kind: 'saved', commit: head, by, coAuthors: [] });
          return { commit: head, unchanged: true };
        }
        // AFS-171: a save that changes the flow moves flow.version on once from the branch's, as a
        // save in VS Code does (ADR-0006): a run then names the version it ran, and the badge moves.
        const bumped = planSave(text, undefined, headText);
        if (bumped.edits.length) text = applyEdits(text, bumped.edits);
        const people = await this.deps.db
          .selectFrom('user_account')
          .select(['id', 'name', 'login', 'email'])
          .where('id', 'in', [by.id, ...editors.map((e) => e.id)])
          .execute();
        const mail = (p?: { login: string; email: string | null }) =>
          p?.email ?? `${p?.login ?? 'someone'}@users.ansible-flow-server`;
        const me = people.find((p) => p.id === by.id);
        const others = editors
          .filter((e) => e.id !== by.id)
          .map((e) => people.find((p) => p.id === e.id))
          .filter((p): p is NonNullable<typeof p> => !!p);
        // AFS-194: the flow by its title, as the pages name it, not its file's path.
        const named = parseFlow(text).doc?.flow?.name?.trim() || draft.file;
        const subject = options.message?.trim() || `Edit ${named} in Ansible Flow Server`;
        const trailers = others.map((p) => `Co-authored-by: ${p.name} <${mail(p)}>`);
        const message = `${subject}\n${trailers.length ? `\n${trailers.join('\n')}\n` : ''}`;
        const author = {
          name: me?.name ?? by.name,
          email: mail(me ?? { login: by.login, email: null }),
        };
        const commit = adds.length
          ? await git.commitChanges(project.id, {
              parent: head,
              writes: [
                { path: draft.file, mode: '100644', bytes: Buffer.from(text, 'utf8') },
                ...adds.map((f) => ({ path: f.path, mode: '100644', bytes: f.bytes })),
              ],
              removes: [],
              author,
              message,
            })
          : await git.commitFile(project.id, {
              parent: head,
              path: draft.file,
              text,
              author,
              message,
            });
        await git.publish(
          project.id,
          project.gitRef,
          head,
          commit,
          project.gitUrl ? { url: project.gitUrl, auth: await sync.auth(project) } : undefined,
        );
        // AFS-136: a save is a push through this server, listed with the others.
        await recordPushes(
          this.deps.db,
          project.id,
          { id: by.id, login: by.login },
          [{ ref: project.gitRef, from: head, to: commit }],
          'save',
        );
        await sync.refresh(project.id);
        await this.drop(id);
        const coAuthors = others.map((p) => p.name);
        this.tell(id, { kind: 'saved', commit, by, coAuthors });
        this.deps.log.info(
          { project: project.key, file: draft.file, commit: commit.slice(0, 12), by: by.login },
          'Draft saved',
        );
        return {
          commit,
          coAuthors,
          ...(adds.length ? { added: adds.map((f) => f.path) } : {}),
        };
      }),
    );
  }

  async discard(id: string, by: Editor): Promise<void> {
    await this.one(id, async () => {
      const row = await this.row(id);
      if (!row) throw new DraftError('not_found', 'No such draft');
      // AFS-186: what was discarded can be brought back for a while.
      const files = await this.files(id);
      const at = Date.now();
      for (const [key, d] of this.discarded)
        if (at - d.at > KEEP_DISCARDED_MS) this.discarded.delete(key);
      this.discarded.set(id, {
        project: row.project_id,
        file: row.file,
        baseCommit: row.base_commit,
        text: row.text,
        files,
        at,
      });
      await this.drop(id);
    });
    this.tell(id, { kind: 'discarded', by });
  }

  /**
   * AFS-186: a draft discarded a moment ago, back as a new draft of the same flow at the same
   * commit, with the text it had (one edit by the person bringing it back). Refused once the
   * flow has a draft again, or after KEEP_DISCARDED_MS.
   */
  async restore(id: string, by: Editor, of: { project: string; file: string }): Promise<Draft> {
    const kept = this.discarded.get(id);
    if (
      !kept ||
      kept.project !== of.project ||
      kept.file !== of.file ||
      Date.now() - kept.at > KEEP_DISCARDED_MS
    )
      throw new DraftError('not_found', 'The discarded draft is no longer kept');
    const there = await this.deps.db
      .selectFrom('flow_draft')
      .select('id')
      .where('project_id', '=', kept.project)
      .where('file', '=', kept.file)
      .executeTakeFirst();
    if (there) throw new DraftError('refused', 'The flow has a new draft already: open that one');
    const base = await this.baseText({
      project_id: kept.project,
      base_commit: kept.baseCommit,
      file: kept.file,
    });
    if (base === undefined)
      throw new DraftError('refused', 'The commit the draft began at is gone');
    const at = now();
    const fresh = randomUUID();
    await this.deps.db
      .insertInto('flow_draft')
      .values({
        id: fresh,
        project_id: kept.project,
        file: kept.file,
        base_commit: kept.baseCommit,
        text: base,
        revision: 0,
        created_by: by.id,
        created_at: at,
        updated_at: at,
      })
      .execute();
    this.discarded.delete(id);
    if (kept.text !== base || kept.files.length)
      await this.one(fresh, () =>
        this.write(
          fresh,
          by,
          kept.files.length ? 'start' : 'command',
          { text: base, revision: 0 },
          kept.text,
          kept.files,
        ),
      );
    return this.view((await this.row(fresh)) as NonNullable<Awaited<ReturnType<Drafts['row']>>>);
  }

  /** AFS-186: the flow at the draft's base commit, read once per commit and file. */
  private baseText(row: {
    project_id: string;
    base_commit: string;
    file: string;
  }): Promise<string | undefined> {
    const key = `${row.project_id}:${row.base_commit}:${row.file}`;
    let found = this.bases.get(key);
    if (!found) {
      found = this.deps.git
        .read(row.project_id, row.base_commit, row.file)
        .then((b) => b?.toString('utf8'));
      if (this.bases.size > 500) this.bases.clear();
      this.bases.set(key, found);
    }
    return found;
  }

  /**
   * AFS-186: whether the draft changes anything against the commit it began at (an edit and its
   * undo change nothing): Save has nothing to make then, and leaving it drops it.
   */
  async changed(id: string): Promise<boolean> {
    const row = await this.row(id);
    if (!row || row.revision === 0) return false;
    if ((await this.files(id)).length) return true;
    return row.text !== (await this.baseText(row));
  }

  /** AFS-186: what the draft changes, and who changed each place (see DraftSummary). */
  async summary(id: string): Promise<DraftSummary | undefined> {
    const row = await this.row(id);
    if (!row) return undefined;
    const base = await this.baseText(row);
    const files = (await this.files(id)).length > 0;
    const a = base === undefined ? undefined : parseFlow(base).doc;
    const b = parseFlow(row.text).doc;
    if (!a || !b || row.text === base) return { changed: files, changes: [], wires: 0 };
    const diff = diffFlows(a, b);
    // Who touched each step or note: the edits not taken back (an undo is not a change of its own).
    const edits = await this.deps.db
      .selectFrom('flow_draft_edit')
      .innerJoin('user_account', 'user_account.id', 'flow_draft_edit.user_id')
      .select(['user_account.name', 'flow_draft_edit.before_text', 'flow_draft_edit.after_text'])
      .where('flow_draft_edit.draft_id', '=', id)
      .where('flow_draft_edit.undone', '=', 0)
      .where('flow_draft_edit.kind', 'not in', ['undo', 'undo-start'])
      .orderBy('flow_draft_edit.revision')
      .execute();
    const who = new Map<string, Set<string>>();
    const flowBy = new Set<string>();
    for (const e of edits) {
      const x = parseFlow(e.before_text).doc;
      const y = parseFlow(e.after_text).doc;
      if (!x || !y) continue;
      const d = diffFlows(x, y);
      for (const c of [...d.nodes, ...d.annotations]) {
        const set = who.get(c.id) ?? new Set<string>();
        set.add(e.name);
        who.set(c.id, set);
      }
      if (d.flow.length || d.wires.length) flowBy.add(e.name);
    }
    const anyone = [...new Set(edits.map((e) => e.name))];
    const by = (place?: string) => {
      const found = [...(place ? (who.get(place) ?? []) : flowBy)];
      return found.length ? found : anyone;
    };
    const fields = (c: { kind: string; fields: { field: string }[] }) =>
      c.kind === 'changed' ? c.fields.map((f) => f.field) : [];
    const changes: DraftSummary['changes'] = [
      ...diff.nodes.map((n) => ({ step: n.title, kind: n.kind, fields: fields(n), by: by(n.id) })),
      ...diff.annotations.map((n) => ({
        note: n.label || n.annotation,
        kind: n.kind,
        fields: fields(n),
        by: by(n.id),
      })),
      ...(diff.flow.length
        ? [{ kind: 'changed' as const, fields: diff.flow.map((f) => f.field), by: by() }]
        : []),
    ];
    return { changed: true, changes, wires: diff.wires.length };
  }

  private async drop(id: string): Promise<void> {
    await this.deps.db.deleteFrom('flow_draft_edit').where('draft_id', '=', id).execute();
    await this.deps.db.deleteFrom('flow_draft').where('id', '=', id).execute();
  }

  /** AFS-173: the files of the person's last start taken back before `revision` (for its redo). */
  private async startFiles(
    id: string,
    by: Editor,
    revision: number,
  ): Promise<DraftFile[] | undefined> {
    const row = await this.deps.db
      .selectFrom('flow_draft_edit')
      .select('files_json')
      .where('draft_id', '=', id)
      .where('user_id', '=', by.id)
      .where('kind', '=', 'start')
      .where('undone', '=', 1)
      .where('revision', '<', revision)
      .orderBy('revision', 'desc')
      .executeTakeFirst();
    if (!row?.files_json) return undefined;
    return (JSON.parse(row.files_json) as { path: string; base64: string }[]).map((f) => ({
      path: f.path,
      bytes: Buffer.from(f.base64, 'base64'),
    }));
  }

  /**
   * AFS-173: the files a start from a sample brings, from its edit while it is not taken back;
   * Save commits them with the flow.
   */
  async files(id: string): Promise<DraftFile[]> {
    const rows = await this.deps.db
      .selectFrom('flow_draft_edit')
      .select('files_json')
      .where('draft_id', '=', id)
      .where('kind', '=', 'start')
      .where('undone', '=', 0)
      .where('files_json', 'is not', null)
      .orderBy('revision')
      .execute();
    const out = new Map<string, DraftFile>();
    for (const r of rows)
      for (const f of JSON.parse(r.files_json as string) as { path: string; base64: string }[])
        out.set(f.path, { path: f.path, bytes: Buffer.from(f.base64, 'base64') });
    return [...out.values()];
  }

  /**
   * AFS-151: what the draft's base commit has, for the designer's findings (roles); AFS-173: and
   * the files the draft adds on Save.
   */
  async probe(id: string): Promise<((path: string) => Promise<boolean>) | undefined> {
    const row = await this.row(id);
    if (!row) return undefined;
    const adds = (await this.files(id)).map((f) => f.path);
    const added = (path: string) => adds.some((p) => p === path || p.startsWith(`${path}/`));
    // A commit does not change: each path is asked of git once (snapshots are made per edit).
    return async (path) => {
      if (added(path)) return true;
      const key = `${row.project_id}:${row.base_commit}:${path}`;
      let found = this.seen.get(key);
      if (!found) {
        found = this.deps.git.exists(row.project_id, row.base_commit, path);
        if (this.seen.size > 5000) this.seen.clear();
        this.seen.set(key, found);
      }
      return found;
    };
  }

  /** The draft's project, for the routes' checks. */
  async projectOf(id: string): Promise<Project | undefined> {
    const row = await this.row(id);
    return row ? getProject(this.deps.db, row.project_id) : undefined;
  }
}
