// AFS-126: what an empty flow in the pages can start from, and starting from it.
//   GET  /api/v1/drafts/:id/start-from           samples, the repository's playbooks, AWX credentials
//   GET  /api/v1/drafts/:id/start-from/awx?credential=   that AWX's workflow and job templates
//   POST /api/v1/drafts/:id/start-from           {sample} | {playbook} | {awx: {credential, kind, id}}

import { parseFlow } from '@ansible-flow/core/flow/document';
import { createIdFactory } from '@ansible-flow/core/flow/ids';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import { signedIn } from '../auth/guards';
import type { Schema } from '../db/schema';
import type { Git } from '../projects/git';
import { listSamples } from '../projects/start';
import { reveal } from '../secrets/credentials';
import type { MasterKey } from '../secrets/masterKey';
import { DraftError, type Drafts } from './drafts';
import {
  asDraftFlow,
  awxReader,
  awxTemplates,
  fromAwx,
  fromPlaybook,
  playbooksIn,
  repositoryIO,
  StartFromError,
  sampleBindings,
  sampleFlowText,
  stepCount,
} from './startFrom';

const ID = {
  params: {
    type: 'object',
    properties: { id: { type: 'string', maxLength: 64 } },
    required: ['id'],
  },
};

type StartBody =
  | { sample: string }
  | { playbook: string }
  | { awx: { credential: string; kind: 'workflow' | 'job'; id: number } };

export function registerStartFrom(
  app: FastifyInstance,
  deps: { db: Kysely<Schema>; drafts: Drafts; git: Git; key?: MasterKey },
): void {
  const { db, drafts, git } = deps;
  const newId = createIdFactory();
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof DraftError || e instanceof StartFromError) {
      const status =
        e.code === 'not_found'
          ? 404
          : e.code === 'unreachable'
            ? 502
            : e.code === 'conflict'
              ? 409
              : 422;
      return reply.code(status).send({ error: e.code, message: e.message });
    }
    throw e;
  };
  /** The draft, its project, and the AWX credentials of the project's workspace. */
  const placeOf = async (id: string) => {
    const draft = await drafts.get(id);
    const project = draft ? await drafts.projectOf(id) : undefined;
    if (!draft || !project) throw new DraftError('not_found', 'No such draft');
    return { draft, project };
  };
  const awxCredential = async (workspace: string, credential: string) => {
    if (!deps.key) throw new StartFromError('refused', 'The server keeps no credentials');
    const row = await db
      .selectFrom('credential')
      .select(['id', 'workspace_id', 'kind'])
      .where('id', '=', credential)
      .executeTakeFirst();
    if (!row || row.workspace_id !== workspace || row.kind !== 'awx')
      throw new StartFromError('not_found', "The project's workspace has no such AWX credential");
    const revealed = await reveal(db, deps.key, credential);
    const url = revealed?.fields.url;
    const token = revealed?.secret.token;
    if (!url || !token)
      throw new StartFromError('refused', 'The AWX credential has no address or token');
    if (!/^https?:\/\//.test(url))
      throw new StartFromError('refused', 'The AWX address is not http(s)');
    return awxReader(url, token);
  };

  app.get<{ Params: { id: string } }>(
    '/api/v1/drafts/:id/start-from',
    { schema: ID },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      try {
        const { draft, project } = await placeOf(request.params.id);
        const awx = await db
          .selectFrom('credential')
          .select(['id', 'name', 'fields_json'])
          .where('workspace_id', '=', project.workspace)
          .where('kind', '=', 'awx')
          .orderBy('name')
          .execute();
        return {
          samples: listSamples(),
          playbooks: await playbooksIn(git, project.id, draft.baseCommit),
          awx: awx.map((c) => ({
            id: c.id,
            name: c.name,
            url: (JSON.parse(c.fields_json) as { url?: string }).url ?? '',
          })),
        };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { credential: string } }>(
    '/api/v1/drafts/:id/start-from/awx',
    {
      schema: {
        ...ID,
        querystring: {
          type: 'object',
          required: ['credential'],
          properties: { credential: { type: 'string', maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      try {
        const { project } = await placeOf(request.params.id);
        const reader = await awxCredential(project.workspace, request.query.credential);
        return { templates: await awxTemplates(reader) };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: StartBody }>(
    '/api/v1/drafts/:id/start-from',
    {
      schema: {
        ...ID,
        body: {
          type: 'object',
          minProperties: 1,
          maxProperties: 1,
          properties: {
            sample: { type: 'string', maxLength: 64 },
            playbook: { type: 'string', maxLength: 1024 },
            awx: {
              type: 'object',
              required: ['credential', 'kind', 'id'],
              additionalProperties: false,
              properties: {
                credential: { type: 'string', maxLength: 64 },
                kind: { enum: ['workflow', 'job'] },
                id: { type: 'integer', minimum: 1 },
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      try {
        const { draft, project } = await placeOf(request.params.id);
        const io = repositoryIO(git, project.id, draft.baseCommit);
        const body = request.body;
        let notes: string[] = [];
        let made = '';
        let from = '';
        const done = await drafts.replace(
          draft.id,
          { id: me.id, login: me.login, name: me.name },
          async (current) => {
            if ('sample' in body) {
              from = `the ${body.sample} sample`;
              const doc = parseFlow(sampleFlowText(body.sample)).doc as FlowDocument;
              // AFS-173: the roles it binds come with it, committed with the flow on Save.
              const bound = await sampleBindings(body.sample, doc, io, draft.file);
              notes = bound.notes;
              made = asDraftFlow(current, doc);
              return { text: made, files: bound.files };
            }
            const result =
              'playbook' in body
                ? await fromPlaybook(io, body.playbook, current, draft.file, newId)
                : await fromAwx(
                    await awxCredential(project.workspace, body.awx.credential),
                    body.awx,
                    io,
                    current,
                    newId,
                  );
            from =
              'playbook' in body ? body.playbook : `AWX ${body.awx.kind} template ${body.awx.id}`;
            notes = result.notes;
            made = result.text;
            return made;
          },
        );
        // AFS-151: the steps as the designer's Readiness counts them (every level), not the tasks
        // the importer read.
        const steps = stepCount(made);
        request.log.info(
          { by: me.login, project: project.key, file: draft.file, from, steps },
          'Draft started from',
        );
        return { revision: done.revision, steps, notes: notes.slice(0, 40) };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
}
