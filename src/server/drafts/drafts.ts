// AFS-76: a flow edited in the pages. Everyone editing one flow edits one draft: the text of the
// flow at a commit of the project's branch, changed by the designer's own commands, in the order
// the server gets them. Commands name steps by their IDs, so two people's edits of different steps
// both apply; the same field twice: the later one wins. Each edit is kept (who, the text before and
// after): undo takes back a person's own last edit with the flow merge, and refuses when someone
// changed the same place since. Save makes one commit on the branch (merged first when the branch
// moved on), by the person who saves, with everyone else who edited as co-authors.

import { randomUUID } from 'node:crypto';
import { CommandError, type FlowCommand, planCommand } from '@ansible-flow/core/flow/commands';
import { parseFlow } from '@ansible-flow/core/flow/document';
import { createIdFactory } from '@ansible-flow/core/flow/ids';
import { mergeFlows } from '@ansible-flow/core/flow/merge';
import { writeMergedFlow } from '@ansible-flow/core/flow/mergeText';
import { buildModel, ROOT } from '@ansible-flow/core/flow/model';
import { diffFlows } from '@ansible-flow/core/flow/semanticDiff';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import { layoutLevel } from '@ansible-flow/node/autoLayout';
import { mergeFlowTexts } from '@ansible-flow/node/flowMerge';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import type { Logger } from '../log';
import { FLOW_FILE } from '../projects/flows';
import type { Git } from '../projects/git';
import { getProject, type Project, recordPushes } from '../projects/store';
import type { ProjectSync } from '../projects/sync';
import { hasNoSteps } from './startFrom';

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
    readonly conflicts?: { id: string; label: string }[],
  ) {
    super(message);
    this.name = 'DraftError';
  }
}

/** What happened to a draft, for the pages watching it. */
export type DraftNews =
  | { kind: 'edit'; revision: number; by: Editor; nodes: string[] }
  | { kind: 'saved'; commit: string; by: Editor }
  | { kind: 'discarded'; by: Editor };

type Db = Kysely<Schema>;
const now = () => new Date().toISOString();

/** The steps an edit added, removed or changed: what the others' pages mark. */
function changedNodes(before: string, after: string): string[] {
  const a = parseFlow(before).doc;
  const b = parseFlow(after).doc;
  return a && b ? diffFlows(a, b).nodes.map((n) => n.id) : [];
}

export class Drafts {
  private readonly newId = createIdFactory();
  /** One change of a draft at a time on this server; the revision guards across servers. */
  private readonly queue = new Map<string, Promise<unknown>>();
  private readonly listeners = new Map<string, Set<(news: DraftNews) => void>>();

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
    kind: 'command' | 'undo' | 'layout',
    before: { text: string; revision: number },
    after: string,
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
          undone: 0,
          at,
        })
        .execute();
    });
    this.tell(id, { kind: 'edit', revision, by, nodes: changedNodes(before.text, after) });
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
    make: (current: string) => Promise<string>,
  ): Promise<{ revision: number }> {
    return this.one(id, async () => {
      const current = await this.text(id);
      if (!current) throw new DraftError('not_found', 'No such draft');
      if (!hasNoSteps(current.text))
        throw new DraftError(
          'refused',
          'The flow has steps already: start from something only in an empty flow',
        );
      let text: string;
      try {
        text = await make(current.text);
      } catch (e) {
        throw new DraftError('refused', (e as Error).message);
      }
      return { revision: await this.write(id, by, 'command', current, text) };
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
  async undo(id: string, by: Editor): Promise<{ revision: number; steps: string[] }> {
    return this.one(id, async () => {
      const current = await this.text(id);
      if (!current) throw new DraftError('not_found', 'No such draft');
      const last = await this.deps.db
        .selectFrom('flow_draft_edit')
        .selectAll()
        .where('draft_id', '=', id)
        .where('user_id', '=', by.id)
        .where('undone', '=', 0)
        .where('kind', '!=', 'undo')
        .orderBy('revision', 'desc')
        .executeTakeFirst();
      if (!last) throw new DraftError('refused', 'Nothing of yours to undo in this draft');
      const doc = (t: string) => parseFlow(t).doc as FlowDocument;
      const merged = mergeFlows(doc(last.after_text), doc(current.text), doc(last.before_text));
      if (merged.conflicts.length)
        throw new DraftError(
          'refused',
          `Someone changed the same place since: ${merged.conflicts.map((c) => c.label).join('; ')}`,
        );
      const text = writeMergedFlow(current.text, merged.doc);
      const revision = await this.write(id, by, 'undo', current, text);
      await this.deps.db
        .updateTable('flow_draft_edit')
        .set({ undone: 1 })
        .where('id', '=', last.id)
        .execute();
      // AFS-136: what was taken back, by the steps' titles (none: a move on the canvas).
      const titles = new Map(
        [...(doc(last.before_text).nodes ?? []), ...(doc(last.after_text).nodes ?? [])].map((n) => [
          n.id,
          n.title,
        ]),
      );
      const steps = changedNodes(last.before_text, last.after_text).map(
        (n) => titles.get(n) ?? 'a step',
      );
      return { revision, steps };
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
    options: { message?: string; force?: boolean } = {},
  ): Promise<{ commit: string; unchanged?: boolean }> {
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
          const merged =
            base !== undefined ? mergeFlowTexts(base, draft.text, headText) : undefined;
          if (merged?.kind !== 'merged')
            throw new DraftError(
              'refused',
              'The branch changed this flow in a way that cannot be merged',
            );
          if (merged.merge.conflicts.length && !options.force)
            throw new DraftError(
              'conflict',
              'The branch changed the same places since the draft began',
              merged.merge.conflicts.map((c) => ({ id: c.id, label: c.label })),
            );
          text = merged.text;
        }
        const editors = await this.editors(id);
        if (text === headText) {
          await this.drop(id);
          this.tell(id, { kind: 'saved', commit: head, by });
          return { commit: head, unchanged: true };
        }
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
        const subject = options.message?.trim() || `Edit ${draft.file} in Ansible Flow Server`;
        const trailers = others.map((p) => `Co-authored-by: ${p.name} <${mail(p)}>`);
        const message = `${subject}\n${trailers.length ? `\n${trailers.join('\n')}\n` : ''}`;
        const commit = await git.commitFile(project.id, {
          parent: head,
          path: draft.file,
          text,
          author: {
            name: me?.name ?? by.name,
            email: mail(me ?? { login: by.login, email: null }),
          },
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
        await recordPushes(this.deps.db, project.id, { id: by.id, login: by.login }, [
          { ref: project.gitRef, from: head, to: commit },
        ]);
        await sync.refresh(project.id);
        await this.drop(id);
        this.tell(id, { kind: 'saved', commit, by });
        this.deps.log.info(
          { project: project.key, file: draft.file, commit: commit.slice(0, 12), by: by.login },
          'Draft saved',
        );
        return { commit };
      }),
    );
  }

  async discard(id: string, by: Editor): Promise<void> {
    if (!(await this.row(id))) throw new DraftError('not_found', 'No such draft');
    await this.drop(id);
    this.tell(id, { kind: 'discarded', by });
  }

  private async drop(id: string): Promise<void> {
    await this.deps.db.deleteFrom('flow_draft_edit').where('draft_id', '=', id).execute();
    await this.deps.db.deleteFrom('flow_draft').where('id', '=', id).execute();
  }

  /** The draft's project, for the routes' checks. */
  async projectOf(id: string): Promise<Project | undefined> {
    const row = await this.row(id);
    return row ? getProject(this.deps.db, row.project_id) : undefined;
  }
}
