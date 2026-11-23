// AFS-76: editing a flow in the pages, together. A project's flow has one draft; everyone with `rw`
// on the flow edits it with the designer's commands, sees the others' edits live (server-sent
// events), who is there and what each changed; undo takes back their own last edit (redo brings it
// back, AFS-172); Save is one commit on the branch; Discard drops the draft.
//   GET  /api/v1/projects/:id/drafts                     the project's drafts
//   POST /api/v1/projects/:id/drafts?path=               open (or start) the flow's draft
//   GET  /api/v1/drafts/:id                              the draft and its flow as the designer shows it
//   GET  /api/v1/drafts/:id/events                       the draft as it changes, and who is there
//   POST /api/v1/drafts/:id/commands, /undo, /redo, /tidy edits
//   POST /api/v1/drafts/:id/here                         "I am here" (and the step I have selected)
//   POST /api/v1/drafts/:id/flushed                      AFS-149: "what I was typing is sent"
//   POST /api/v1/drafts/:id/save, DELETE /drafts/:id     save as one commit, discard
//   POST /api/v1/projects/:id/drafts/restore?path=       AFS-186: a draft just discarded, back
//   GET  /api/v1/drafts/:id/summary                      AFS-186: what it changes, and by whom
//   POST /api/v1/drafts/:id/leave                        AFS-186: Stop editing (drops a draft
//                                                        that changes nothing, nobody else in it)
//   POST /api/v1/drafts/:id/catalog                      the module catalog of the flow's image
//   POST /api/v1/projects/:id/flows/catalog?path=        the same for a flow shown (AFS-118)
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { FlowCommand } from '@ansible-flow/core/flow/commands';
import type { CatalogRequest, CatalogStatus } from '@ansible-flow/core/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { accessOf } from '../access/grants';
import { signedIn } from '../auth/guards';
import type { SessionUser } from '../auth/sessions';
import type { Schema } from '../db/schema';
import { environmentImage } from '../environments/image';
import { FlowError, snapshotOf } from '../projects/flows';
import type { RepoRoles } from '../projects/roles';
import { getProject } from '../projects/store';
import type { CatalogState } from '../runs/catalogs';
import { DraftError, type DraftNews, type Drafts, type Editor } from './drafts';

/** How long "I am here" lasts without another. */
const HERE_MS = 45_000;
/**
 * AFS-136: how long a save waits at most for the other pages in the draft to send what they are
 * typing. AFS-149: it ends sooner, once each page has said it sent it.
 */
const FLUSH_MS = 3_000;
/** How often a stream reads the draft's revision (an edit made through another server). */
const LOOK_MS = 1_500;
const KEEP_ALIVE_MS = 25_000;

export interface Person {
  login: string;
  name: string;
  /** The step they have selected, when they have one. */
  node?: string;
  at: number;
  /** AFS-149: in how many pages (tabs) they have the draft open. */
  tabs?: number;
  /**
   * AFS-171: they opened Save (are writing the commit's message): the others are told before the
   * save ends the draft for everyone.
   */
  saving?: boolean;
  /** AFS-186: they asked to discard the draft (the question is open): the others are told. */
  discarding?: boolean;
}

/** AFS-149: one page's "I am here": a person may have the draft open in several tabs. */
type Here = Person & { tab?: string };

/** AFS-149: a page following a draft, told when someone is about to save it. */
interface Listener {
  /** This stream, named in the `saving` event so the page's answer says which it is. */
  stream: string;
  login: string;
  tab?: string;
  hear(news: {
    by: { login: string; name: string };
    flush: string;
    stream: string;
    /** AFS-186: a save (the default) or a discard is coming. */
    what?: 'discard';
  }): void;
}

const TAB = { type: 'string', minLength: 1, maxLength: 64 };

const ID = {
  params: {
    type: 'object',
    properties: { id: { type: 'string', maxLength: 64 } },
    required: ['id'],
  },
};
const STATUS: Record<DraftError['code'], number> = {
  not_found: 404,
  refused: 422,
  conflict: 409,
  invalid: 400,
};

const editorOf = (u: SessionUser): Editor => ({ id: u.id, login: u.login, name: u.name });

export function registerDrafts(
  app: FastifyInstance,
  deps: {
    db: Kysely<Schema>;
    drafts: Drafts;
    catalog?: { get(image?: string): CatalogState; retry(image?: string): void };
    /** AFD-351: the repository's own roles at a commit (the designer's `roles`). */
    roles?: RepoRoles;
    /** How long a save waits for the others' typing (tests: shorter). */
    flushMs?: number;
  },
): void {
  const { drafts } = deps;
  /**
   * Who is in each draft (this server's pages; a page says so again every half minute), by person
   * and tab (AFS-149: the same person in two tabs is two pages to flush on a save).
   */
  const here = new Map<string, Map<string, Here>>();
  const peopleListeners = new Map<string, Set<(people: Person[]) => void>>();
  /**
   * AFS-136: told when someone is about to save a draft others are in: their pages send what is
   * being typed (a field commits when it is left) before the commit is made.
   */
  const savingListeners = new Map<string, Set<Listener>>();
  /** AFS-149: the saves waiting for pages to send their typing: the streams not answered yet. */
  const flushes = new Map<string, { left: Map<string, string>; done(): void }>();
  /** Who is in the draft, once per person (the newest page's step), with their pages counted. */
  const people = (id: string): Person[] => {
    const at = Date.now();
    const room = here.get(id);
    for (const [key, p] of room ?? []) if (at - p.at > HERE_MS) room?.delete(key);
    const byPerson = new Map<string, Person>();
    for (const p of room?.values() ?? []) {
      const seen = byPerson.get(p.login);
      const { tab: _tab, ...person } = p;
      if (!seen) byPerson.set(p.login, { ...person, tabs: 1 });
      else {
        const saving = seen.saving || person.saving;
        const discarding = seen.discarding || person.discarding;
        byPerson.set(p.login, {
          ...(p.at >= seen.at ? person : seen),
          tabs: (seen.tabs ?? 1) + 1,
          ...(saving ? { saving } : {}),
          ...(discarding ? { discarding } : {}),
        });
      }
    }
    return [...byPerson.values()];
  };
  const tellPeople = (id: string) => {
    const list = people(id);
    for (const l of peopleListeners.get(id) ?? []) l(list);
  };

  const streams = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const s of streams) s.end();
    streams.clear();
  });

  const failed = (reply: FastifyReply, e: unknown) => {
    if (e instanceof DraftError)
      return reply.code(STATUS[e.code]).send({
        error: e.code,
        message: e.message,
        ...(e.conflicts ? { conflicts: e.conflicts } : {}),
      });
    if (e instanceof FlowError) return reply.code(422).send({ error: e.code, message: e.message });
    throw e;
  };

  /** The draft, as its page shows it: the draft and the flow at its revision. */
  const shown = async (id: string) => {
    const draft = await drafts.get(id);
    const text = await drafts.text(id);
    if (!draft || !text) return undefined;
    return {
      draft,
      snapshot: await snapshotOf(text.text, text.file, text.revision + 1, await drafts.probe(id)),
      // AFS-186: whether it changes anything (Save is off while it does not).
      changed: await drafts.changed(id),
    };
  };

  /**
   * AFS-136, AFS-149: before a save (AFS-186: or a discard), the other pages in the draft send
   * what they are typing: every page but the asker's own (the asker's other tabs too). It goes on
   * once each has answered, or after FLUSH_MS (a page that cannot: a frozen tab).
   */
  const flushPages = async (
    id: string,
    me: { login: string; name: string },
    tab: string | undefined,
    what?: 'discard',
  ) => {
    const pages = [...(savingListeners.get(id) ?? [])].filter(
      (l) => !(tab && l.tab === tab && l.login === me.login),
    );
    if (!pages.length) return;
    const flush = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      flushes.set(flush, { left: new Map(pages.map((l) => [l.stream, l.login])), done: resolve });
      timer = setTimeout(resolve, deps.flushMs ?? FLUSH_MS);
      for (const l of pages)
        l.hear({
          by: { login: me.login, name: me.name },
          flush,
          stream: l.stream,
          ...(what ? { what } : {}),
        });
    });
    clearTimeout(timer);
    flushes.delete(flush);
  };

  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/drafts',
    { schema: ID },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const project = await getProject(deps.db, request.params.id);
      if (!project) return reply.code(404).send({ error: 'not_found', message: 'No such project' });
      // AFS-206: the drafts of the flows the person may see, not every flow's.
      const access = await accessOf(deps.db, request);
      return (await drafts.list(project.id)).filter(
        (d) => !!access?.onFlow(project.workspace, project.id, d.file),
      );
    },
  );

  app.post<{ Params: { id: string }; Querystring: { path: string } }>(
    '/api/v1/projects/:id/drafts',
    {
      schema: {
        ...ID,
        querystring: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string', minLength: 1, maxLength: 1000 } },
        },
      },
    },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const project = await getProject(deps.db, request.params.id);
      if (!project) return reply.code(404).send({ error: 'not_found', message: 'No such project' });
      try {
        const draft = await drafts.open(project, request.query.path, editorOf(me));
        return reply.code(draft.revision === 0 && !draft.editors.length ? 201 : 200).send(draft);
      } catch (e) {
        return failed(reply, e);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/drafts/:id',
    { schema: ID },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      try {
        const found = await shown(request.params.id);
        return found ?? reply.code(404).send({ error: 'not_found', message: 'No such draft' });
      } catch (e) {
        return failed(reply, e);
      }
    },
  );

  /**
   * The draft as it changes: `draft` (it and its flow) at once, `edit` (who changed which steps,
   * and the flow after) at each change, `people` (who is there), and `saved` or `discarded`.
   */
  app.get<{ Params: { id: string }; Querystring: { tab?: string } }>(
    '/api/v1/drafts/:id/events',
    {
      schema: {
        ...ID,
        querystring: { type: 'object', properties: { tab: TAB } },
      },
    },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const id = request.params.id;
      let first: Awaited<ReturnType<typeof shown>>;
      try {
        first = await shown(id);
      } catch (e) {
        return failed(reply, e);
      }
      if (!first) return reply.code(404).send({ error: 'not_found', message: 'No such draft' });
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let open = true;
      const send = (event: string, data: unknown) => {
        if (open) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      send('draft', first);
      send('people', people(id));
      let revision = first.draft.revision;
      let sending = Promise.resolve();
      /** The flow at the draft's newest revision, once per revision. */
      const catchUp = (news?: Extract<DraftNews, { kind: 'edit' }>) => {
        sending = sending.then(async () => {
          const text = await drafts.text(id);
          if (!text || !open || text.revision <= revision) return;
          revision = text.revision;
          const snapshot = await snapshotOf(
            text.text,
            text.file,
            text.revision + 1,
            await drafts.probe(id),
          ).catch(() => undefined);
          const changed = await drafts.changed(id).catch(() => true);
          send('edit', {
            revision: text.revision,
            changed,
            ...(news && news.revision === text.revision
              ? { by: news.by, nodes: news.nodes, changes: news.changes, wires: news.wires }
              : {}),
            ...(snapshot ? { snapshot } : {}),
          });
        });
      };
      const unsubscribe = drafts.subscribe(id, (news) => {
        if (news.kind === 'edit') catchUp(news);
        else {
          send(news.kind, news);
          finish();
        }
      });
      const peopleSet = peopleListeners.get(id) ?? new Set();
      const onPeople = (list: Person[]) => send('people', list);
      peopleSet.add(onPeople);
      peopleListeners.set(id, peopleSet);
      const savingSet = savingListeners.get(id) ?? new Set();
      const onSaving: Listener = {
        stream: randomUUID(),
        login: me.login,
        ...(request.query.tab ? { tab: request.query.tab } : {}),
        hear: (news) => send('saving', news),
      };
      savingSet.add(onSaving);
      savingListeners.set(id, savingSet);
      // An edit made through another server is seen here by its revision; a draft saved or
      // discarded there is gone here.
      const looking = setInterval(() => {
        void drafts.text(id).then((t) => {
          if (!t) {
            send('discarded', {});
            finish();
          } else if (t.revision > revision) catchUp();
        });
      }, LOOK_MS);
      const alive = setInterval(() => {
        if (open) raw.write(': still here\n\n');
      }, KEEP_ALIVE_MS);
      const finish = () => {
        if (!open) return;
        open = false;
        unsubscribe();
        peopleSet.delete(onPeople);
        savingSet.delete(onSaving);
        clearInterval(looking);
        clearInterval(alive);
        streams.delete(raw);
        raw.end();
      };
      streams.add(raw);
      raw.on('close', finish);
      return reply;
    },
  );

  /** Runs an edit for a signed-in person, and answers with what came of it. */
  const editing =
    <B>(work: (id: string, me: Editor, body: B) => Promise<unknown>) =>
    async (request: FastifyRequest<{ Params: { id: string }; Body: B }>, reply: FastifyReply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      try {
        return await work(request.params.id, editorOf(me), request.body as B);
      } catch (e) {
        return failed(reply, e);
      }
    };

  app.post<{ Params: { id: string }; Body: { command: FlowCommand } }>(
    '/api/v1/drafts/:id/commands',
    {
      schema: {
        ...ID,
        body: {
          type: 'object',
          required: ['command'],
          properties: { command: { type: 'object', required: ['kind'] } },
        },
      },
    },
    editing((id, me, body: { command: FlowCommand }) => drafts.apply(id, me, body.command)),
  );
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/v1/drafts/:id/undo',
    { schema: ID },
    editing((id, me) => drafts.undo(id, me)),
  );
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/v1/drafts/:id/redo',
    { schema: ID },
    editing((id, me) => drafts.redo(id, me)),
  );
  app.post<{ Params: { id: string }; Body: { level?: string } }>(
    '/api/v1/drafts/:id/tidy',
    {
      schema: {
        ...ID,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { level: { type: 'string', maxLength: 64 } },
        },
      },
    },
    editing((id, me, body: { level?: string } | undefined) => drafts.tidy(id, me, body?.level)),
  );

  app.post<{
    Params: { id: string };
    Body: { node?: string | null; tab?: string; saving?: boolean; discarding?: boolean };
  }>(
    '/api/v1/drafts/:id/here',
    {
      schema: {
        ...ID,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            node: { type: ['string', 'null'], maxLength: 64 },
            tab: TAB,
            saving: { type: 'boolean' },
            discarding: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      if (!(await drafts.text(request.params.id)))
        return reply.code(404).send({ error: 'not_found', message: 'No such draft' });
      const room = here.get(request.params.id) ?? new Map<string, Here>();
      const tab = request.body?.tab;
      const key = `${me.login} ${tab ?? ''}`;
      const was = room.get(key);
      // AFS-171: the frame's "I am here" says nothing of Save (the page says it): what was said stays.
      const node = request.body?.node ?? undefined;
      const saving = request.body?.saving ?? was?.saving;
      const discarding = request.body?.discarding ?? was?.discarding;
      room.set(key, {
        login: me.login,
        name: me.name,
        ...(node ? { node } : {}),
        ...(tab ? { tab } : {}),
        ...(saving ? { saving } : {}),
        ...(discarding ? { discarding } : {}),
        at: Date.now(),
      });
      here.set(request.params.id, room);
      tellPeople(request.params.id);
      return { people: people(request.params.id) };
    },
  );

  /** AFS-149: a page sent what it was typing for a save: the save goes on once all have. */
  app.post<{ Params: { id: string }; Body: { flush: string; stream: string } }>(
    '/api/v1/drafts/:id/flushed',
    {
      schema: {
        ...ID,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['flush', 'stream'],
          properties: { flush: TAB, stream: TAB },
        },
      },
    },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const waiting = flushes.get(request.body.flush);
      if (waiting && waiting.left.get(request.body.stream) === me.login) {
        waiting.left.delete(request.body.stream);
        if (!waiting.left.size) waiting.done();
      }
      return reply.code(204).send();
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      message?: string;
      force?: boolean;
      choices?: Record<string, 'draft' | 'branch'>;
      seen?: number;
      tab?: string;
      answerConflicts?: boolean;
    };
  }>(
    '/api/v1/drafts/:id/save',
    {
      schema: {
        ...ID,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            message: { type: 'string', maxLength: 500 },
            force: { type: 'boolean' },
            // AFS-149: per clashing place, whose side to keep (by the conflict's id).
            choices: {
              type: 'object',
              maxProperties: 500,
              additionalProperties: { type: 'string', enum: ['draft', 'branch'] },
            },
            // AFS-186: the draft's revision the choices were made at.
            seen: { type: 'integer', minimum: 0 },
            tab: TAB,
            answerConflicts: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const email = (
        await deps.db
          .selectFrom('user_account')
          .select('email')
          .where('id', '=', me.id)
          .executeTakeFirst()
      )?.email;
      // AFS-136: the other pages in the draft send what they are typing first, then it is saved.
      const body = request.body ?? {};
      await flushPages(request.params.id, me, body.tab);
      const { tab: _tab, answerConflicts, ...options } = body;
      try {
        return await drafts.save(request.params.id, { ...editorOf(me), email }, options);
      } catch (e) {
        // AFS-149: the pages ask for clashes as an answer, not a refusal (a 409 is a console error).
        if (answerConflicts && e instanceof DraftError && e.code === 'conflict')
          return {
            saved: false,
            message: e.message,
            conflicts: e.conflicts ?? [],
            ...(e.revision !== undefined ? { revision: e.revision } : {}),
          };
        return failed(reply, e);
      }
    },
  );

  /**
   * The image a flow's runs use: a launch configuration of the flow names its environment or
   * image; without one, the server's default.
   */
  const imageOf = async (project: string, file: string): Promise<string | undefined> => {
    const configs = await deps.db
      .selectFrom('launch_config')
      .select(['environment_id', 'ee_image'])
      .where('project_id', '=', project)
      .where('flow_file', '=', file)
      .execute();
    for (const c of configs) {
      if (c.environment_id) {
        const found = await environmentImage(deps.db, c.environment_id);
        if (found.image) return found.image;
      }
      if (c.ee_image) return c.ee_image;
    }
    return undefined;
  };
  const statusOf = (state: CatalogState): CatalogStatus =>
    state.state === 'ready'
      ? { state: 'ready', environment: state.image, ...state.index.stats() }
      : state.state === 'loading'
        ? {
            state: 'loading',
            environment: state.image,
            message: `Reading the plugin docs of ${state.image} (the first time takes a few minutes)…`,
          }
        : { state: 'error', environment: state.image, message: state.error };

  /**
   * The module catalog of the flow's image, as the designer asks it: search, a plugin's docs,
   * the names for Jinja completion, the catalog's state (`status`) and Rebuild. While the image's
   * catalog is first read, the answer says so (202 with the state).
   */
  app.post<{ Params: { id: string }; Body: { request: CatalogRequest | { op: 'status' } } }>(
    '/api/v1/drafts/:id/catalog',
    {
      schema: {
        ...ID,
        body: {
          type: 'object',
          required: ['request'],
          properties: { request: { type: 'object', required: ['op'] } },
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const draft = await drafts.get(request.params.id);
      const project = await drafts.projectOf(request.params.id);
      if (!draft || !project)
        return reply.code(404).send({ error: 'not_found', message: 'No such draft' });
      return catalogAnswer(project.id, draft.file, request.body.request, reply, draft.baseCommit);
    },
  );

  /**
   * AFS-118: the same catalog for a flow shown, not edited (a run's page, a flow's page): the
   * designer reads a step's module docs there too.
   */
  app.post<{
    Params: { id: string };
    Querystring: { path: string };
    Body: { request: CatalogRequest | { op: 'status' } };
  }>(
    '/api/v1/projects/:id/flows/catalog',
    {
      schema: {
        ...ID,
        querystring: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string', minLength: 1, maxLength: 1000 } },
        },
        body: {
          type: 'object',
          required: ['request'],
          properties: { request: { type: 'object', required: ['op'] } },
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const project = await getProject(deps.db, request.params.id);
      if (!project) return reply.code(404).send({ error: 'not_found', message: 'No such project' });
      // Shown, not changed: Rebuild is for those who edit.
      const asked = request.body.request;
      if (asked.op === 'rebuild')
        return reply.code(403).send({ error: 'forbidden', message: 'Edit the flow to rebuild' });
      return catalogAnswer(project.id, request.query.path, asked, reply, project.commit);
    },
  );

  async function catalogAnswer(
    projectId: string,
    file: string,
    asked: CatalogRequest | { op: 'status' },
    reply: FastifyReply,
    /** The commit the flow shown is at: its repository's roles are read there. */
    commit?: string,
  ) {
    // AFD-351: the repository's own roles come from git, not from the image's catalog.
    if (asked.op === 'roles') {
      if (!deps.roles || !commit) return { result: [] };
      try {
        return { result: await deps.roles.roles(projectId, commit) };
      } catch {
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'The repository cannot be read now' });
      }
    }
    if (!deps.catalog)
      return reply.code(422).send({ error: 'refused', message: 'This server reads no catalogs' });
    const image = await imageOf(projectId, file);
    if (asked.op === 'rebuild') deps.catalog.retry(image);
    const state = deps.catalog.get(image);
    if (asked.op === 'status' || asked.op === 'rebuild') return { status: statusOf(state) };
    if (state.state !== 'ready') return reply.code(202).send({ status: statusOf(state) });
    const index = state.index;
    switch (asked.op) {
      case 'search':
        return {
          result: index.search(asked.query, { ...(asked.types ? { types: asked.types } : {}) }, 20),
        };
      case 'doc': {
        const type = asked.type ?? 'module';
        const resolved = index.resolve(asked.fqcn, [], type);
        const plugin = index.plugin(resolved.fqcn ?? asked.fqcn, type);
        return {
          result: plugin
            ? { ...plugin, collection_version: index.collectionVersion(plugin.collection) }
            : null,
        };
      }
      case 'names':
        return { result: index.names(asked.type) };
      // A repository's own playbooks are not read here yet.
      case 'playbooks':
        return { result: [] };
      default:
        return reply.code(400).send({ error: 'invalid', message: 'Not a catalog request' });
    }
  }

  app.delete<{ Params: { id: string }; Querystring: { tab?: string } }>(
    '/api/v1/drafts/:id',
    { schema: { ...ID, querystring: { type: 'object', properties: { tab: TAB } } } },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      try {
        // AFS-186: what the others are typing goes in first, so Bring back has it too.
        if (await drafts.text(request.params.id))
          await flushPages(request.params.id, me, request.query.tab, 'discard');
        await drafts.discard(request.params.id, editorOf(me));
        return reply.code(204).send();
      } catch (e) {
        return failed(reply, e);
      }
    },
  );

  /**
   * AFS-186: a draft of the flow (`path`) discarded a moment ago (`draft`, its old id), back as the
   * flow's draft (the new one answered). On the project, as the draft is gone: rw on the flow.
   */
  app.post<{ Params: { id: string }; Querystring: { path: string }; Body: { draft: string } }>(
    '/api/v1/projects/:id/drafts/restore',
    {
      schema: {
        ...ID,
        querystring: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string', minLength: 1, maxLength: 1000 } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['draft'],
          properties: { draft: { type: 'string', maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      try {
        return await drafts.restore(request.body.draft, editorOf(me), {
          project: request.params.id,
          file: request.query.path,
        });
      } catch (e) {
        return failed(reply, e);
      }
    },
  );

  /** AFS-186: what the draft changes against its commit, place by place, and who changed each. */
  app.get<{ Params: { id: string } }>(
    '/api/v1/drafts/:id/summary',
    { schema: ID },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const found = await drafts.summary(request.params.id);
      return found ?? reply.code(404).send({ error: 'not_found', message: 'No such draft' });
    },
  );

  /**
   * AFS-186: Stop editing. The page is no longer in the draft; a draft that changes nothing (its
   * edits taken back) and has nobody else in it is dropped, as if it never began.
   */
  app.post<{ Params: { id: string }; Body: { tab?: string } }>(
    '/api/v1/drafts/:id/leave',
    {
      schema: {
        ...ID,
        body: { type: 'object', additionalProperties: false, properties: { tab: TAB } },
      },
    },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const id = request.params.id;
      if (!(await drafts.text(id))) return { dropped: false };
      here.get(id)?.delete(`${me.login} ${request.body?.tab ?? ''}`);
      const others = people(id).length > 0;
      const watching = [...(savingListeners.get(id) ?? [])].some(
        (l) => !(request.body?.tab && l.tab === request.body.tab && l.login === me.login),
      );
      if (others || watching || (await drafts.changed(id))) {
        tellPeople(id);
        return { dropped: false };
      }
      try {
        await drafts.discard(id, editorOf(me));
      } catch (e) {
        return failed(reply, e);
      }
      return { dropped: true };
    },
  );
}
