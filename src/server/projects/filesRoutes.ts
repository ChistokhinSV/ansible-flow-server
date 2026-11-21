// AFS-78: a project's files over the API: the tree of a branch, a file's bytes and history, and
// Save (one commit with a change set). Reading needs ro on the project; Save rw on the workspace
// (api/catalog.ts checks both before the handler).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { signedIn } from '../auth/guards';
import type { Schema } from '../db/schema';
import { turnOffGoneFlows } from '../schedules/schedules';
import {
  type FileChange,
  FilesRefused,
  listFiles,
  MAX_CHANGES,
  readFile,
  saveFiles,
} from './files';
import { type Git, GitError } from './git';
import { getProject } from './store';
import type { ProjectSync } from './sync';

export interface FilesRouteDeps {
  db: Kysely<Schema>;
  git: Git;
  sync: ProjectSync;
  /** An archive unpacked into a folder: at most this (the start's limit, default 50 MB). */
  archiveMaxBytes?: number;
}

const STATUS = { invalid: 422, not_found: 404, conflict: 409, replaces: 409 } as const;
const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const ID = { params: { type: 'object', properties: { id: text(64, 1) }, required: ['id'] } };
const COMMIT = { type: 'string', pattern: '^[0-9a-f]{40}$' };
const NO_PROJECT = { error: 'not_found', message: 'No such project' };

/** Text the pages show and edit; anything else is downloaded. */
const looksText = (bytes: Buffer) => !bytes.subarray(0, 8000).includes(0);

export function registerFiles(app: FastifyInstance, deps: FilesRouteDeps): void {
  const { db } = deps;
  const archiveMaxBytes = deps.archiveMaxBytes ?? 50 * 1024 * 1024;
  type WithId = { Params: { id: string } };

  app.get<WithId & { Querystring: { branch?: string } }>(
    '/api/v1/projects/:id/files',
    {
      schema: {
        ...ID,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { branch: text(200, 1) },
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const project = await getProject(db, request.params.id);
      if (!project) return reply.code(404).send(NO_PROJECT);
      try {
        return await listFiles(deps, project, request.query.branch);
      } catch (e) {
        if (e instanceof FilesRefused)
          return reply.code(STATUS[e.code]).send({ error: e.code, message: e.message });
        if (e instanceof GitError)
          return reply
            .code(404)
            .send({ error: 'not_found', message: 'The files cannot be read now' });
        throw e;
      }
    },
  );

  /** A file's bytes at a commit: as text for the pages, or downloaded (`download`). */
  app.get<WithId & { Querystring: { path: string; commit: string; download?: boolean } }>(
    '/api/v1/projects/:id/files/content',
    {
      schema: {
        ...ID,
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'commit'],
          properties: { path: text(1000, 1), commit: COMMIT, download: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const project = await getProject(db, request.params.id);
      if (!project) return reply.code(404).send(NO_PROJECT);
      let bytes: Buffer;
      try {
        bytes = await readFile(deps, project, request.query.commit, request.query.path);
      } catch (e) {
        if (e instanceof FilesRefused)
          return reply.code(STATUS[e.code]).send({ error: e.code, message: e.message });
        throw e;
      }
      const name = request.query.path.split('/').pop() ?? 'file';
      // Never rendered by the browser as a page: text is plain, the rest a download.
      reply.header('x-content-type-options', 'nosniff');
      reply.header('content-security-policy', "default-src 'none'; sandbox");
      if (request.query.download || !looksText(bytes)) {
        reply.header(
          'content-disposition',
          `attachment; filename="${name.replace(/["\\\r\n]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        );
        return reply.type('application/octet-stream').send(bytes);
      }
      return reply.type('text/plain; charset=utf-8').send(bytes);
    },
  );

  /** The commits that changed a file or folder, newest first, up to `commit`. */
  app.get<WithId & { Querystring: { path: string; commit: string; limit?: number } }>(
    '/api/v1/projects/:id/files/history',
    {
      schema: {
        ...ID,
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'commit'],
          properties: {
            path: text(1000, 1),
            commit: COMMIT,
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const project = await getProject(db, request.params.id);
      if (!project) return reply.code(404).send(NO_PROJECT);
      try {
        return await deps.git.fileHistory(project.id, request.query.commit, request.query.path, {
          limit: request.query.limit ?? 10,
        });
      } catch (e) {
        if (e instanceof GitError)
          return reply.code(404).send({ error: 'not_found', message: 'No such commit or file' });
        throw e;
      }
    },
  );

  /** Save: the change set as one commit on the branch. */
  app.post<
    WithId & {
      Body: { branch?: string; base?: string; message?: string; changes: FileChange[] };
    }
  >(
    '/api/v1/projects/:id/files',
    {
      // Base64 of archives and uploads, plus room for the JSON around it.
      bodyLimit: Math.ceil(archiveMaxBytes * 1.4) + 1024 * 1024,
      schema: {
        ...ID,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['changes'],
          properties: {
            branch: text(200, 1),
            base: COMMIT,
            message: text(2000),
            changes: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_CHANGES,
              items: { type: 'object' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const project = await getProject(db, request.params.id);
      if (!project) return reply.code(404).send(NO_PROJECT);
      request.auditDetail = {
        branch: request.body.branch ?? project.gitRef,
        changes: String(request.body.changes.length),
      };
      try {
        const saved = await saveFiles(deps, project, request.body, me, { archiveMaxBytes });
        if (!saved.unchanged) {
          const off = await turnOffGoneFlows(db, deps.git, project, saved, me);
          if (off.length)
            request.log.info(
              { by: me.login, project: project.key, schedules: off },
              'Schedules turned off: their flow was deleted',
            );
        }
        if (!saved.unchanged)
          request.log.info(
            {
              by: me.login,
              project: project.key,
              branch: saved.branch,
              files: saved.files.length,
              commit: saved.commit.slice(0, 12),
            },
            'Files saved',
          );
        return reply.code(saved.unchanged ? 200 : 201).send(saved);
      } catch (e) {
        if (e instanceof FilesRefused)
          return reply.code(STATUS[e.code]).send({
            error: e.code,
            message: e.message,
            ...(e.files ? { files: e.files } : {}),
          });
        // A source that refused the push: its reason, without what git said around it.
        if (e instanceof GitError)
          return reply.code(400).send({ error: 'source_refused', message: e.message });
        throw e;
      }
    },
  );
}
