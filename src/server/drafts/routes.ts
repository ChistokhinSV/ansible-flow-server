// AFS-76: editing a flow in the pages, together. A project's flow has one draft; everyone with `rw`
// on the flow edits it with the designer's commands, sees the others' edits live (server-sent
// events), who is there and what each changed; undo takes back their own last edit; Save is one
// commit on the branch; Discard drops the draft.
//   GET  /api/v1/projects/:id/drafts                     the project's drafts
//   POST /api/v1/projects/:id/drafts?path=               open (or start) the flow's draft
//   GET  /api/v1/drafts/:id                              the draft and its flow as the designer shows it
//   GET  /api/v1/drafts/:id/events                       the draft as it changes, and who is there
//   POST /api/v1/drafts/:id/commands, /undo, /tidy       edits
//   POST /api/v1/drafts/:id/here                         "I am here" (and the step I have selected)
//   POST /api/v1/drafts/:id/save, DELETE /drafts/:id     save as one commit, discard
//   POST /api/v1/drafts/:id/catalog                      the module catalog of the flow's image
//   POST /api/v1/projects/:id/flows/catalog?path=        the same for a flow shown (AFS-118)
import type { ServerResponse } from 'node:http';
import type { FlowCommand } from '@ansible-flow/core/flow/commands';
import type { CatalogRequest, CatalogStatus } from '@ansible-flow/core/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { signedIn } from '../auth/guards';
import type { SessionUser } from '../auth/sessions';
import type { Schema } from '../db/schema';
import { environmentImage } from '../environments/image';
import { FlowError, snapshotOf } from '../projects/flows';
import { getProject } from '../projects/store';
import type { CatalogState } from '../runs/catalogs';
import { DraftError, type DraftNews, type Drafts, type Editor } from './drafts';

/** How long "I am here" lasts without another. */
const HERE_MS = 45_000;
/** How often a stream reads the draft's revision (an edit made through another server). */
const LOOK_MS = 1_500;
const KEEP_ALIVE_MS = 25_000;

export interface Person {
  login: string;
  name: string;
  /** The step they have selected, when they have one. */
  node?: string;
  at: number;
}

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
  },
): void {
  const { drafts } = deps;
  /** Who is in each draft (this server's pages; a page says so again every half minute). */
  const here = new Map<string, Map<string, Person>>();
  const peopleListeners = new Map<string, Set<(people: Person[]) => void>>();
  const people = (id: string) => {
    const at = Date.now();
    const room = here.get(id);
    for (const [login, p] of room ?? []) if (at - p.at > HERE_MS) room?.delete(login);
    return [...(room?.values() ?? [])];
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
    return { draft, snapshot: await snapshotOf(text.text, text.file, text.revision + 1) };
  };

  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/drafts',
    { schema: ID },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      return drafts.list(request.params.id);
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
  app.get<{ Params: { id: string } }>(
    '/api/v1/drafts/:id/events',
    { schema: ID },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
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
          const snapshot = await snapshotOf(text.text, text.file, text.revision + 1).catch(
            () => undefined,
          );
          send('edit', {
            revision: text.revision,
            ...(news && news.revision === text.revision ? { by: news.by, nodes: news.nodes } : {}),
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

  app.post<{ Params: { id: string }; Body: { node?: string | null } }>(
    '/api/v1/drafts/:id/here',
    {
      schema: {
        ...ID,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { node: { type: ['string', 'null'], maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      if (!(await drafts.text(request.params.id)))
        return reply.code(404).send({ error: 'not_found', message: 'No such draft' });
      const room = here.get(request.params.id) ?? new Map<string, Person>();
      const node = request.body?.node ?? undefined;
      room.set(me.login, {
        login: me.login,
        name: me.name,
        ...(node ? { node } : {}),
        at: Date.now(),
      });
      here.set(request.params.id, room);
      tellPeople(request.params.id);
      return { people: people(request.params.id) };
    },
  );

  app.post<{ Params: { id: string }; Body: { message?: string; force?: boolean } }>(
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
      try {
        return await drafts.save(request.params.id, { ...editorOf(me), email }, request.body ?? {});
      } catch (e) {
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
      const draft = await drafts.text(request.params.id);
      const project = await drafts.projectOf(request.params.id);
      if (!draft || !project)
        return reply.code(404).send({ error: 'not_found', message: 'No such draft' });
      return catalogAnswer(project.id, draft.file, request.body.request, reply);
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
      return catalogAnswer(project.id, request.query.path, asked, reply);
    },
  );

  async function catalogAnswer(
    projectId: string,
    file: string,
    asked: CatalogRequest | { op: 'status' },
    reply: FastifyReply,
  ) {
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
      // A repository's own roles and playbooks are not read here yet.
      case 'roles':
      case 'playbooks':
        return { result: [] };
      default:
        return reply.code(400).send({ error: 'invalid', message: 'Not a catalog request' });
    }
  }

  app.delete<{ Params: { id: string } }>(
    '/api/v1/drafts/:id',
    { schema: ID },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      try {
        await drafts.discard(request.params.id, editorOf(me));
        return reply.code(204).send();
      } catch (e) {
        return failed(reply, e);
      }
    },
  );
}
