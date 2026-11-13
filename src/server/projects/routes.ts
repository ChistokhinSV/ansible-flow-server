// Workspaces and projects over HTTP. Until access levels exist (AFS-27): everyone signed in may
// read them, administrators change them.
//   /api/v1/workspaces, /workspaces/:id            :id is the workspace's id or its key
//   /api/v1/workspaces/:id/projects
//   /api/v1/projects/:id, /sync, /branches, /pushes, /hook
//   /api/v1/hooks/projects/:id/push                called by the git host, with the hook's token
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { administrator, signedIn } from '../auth/guards';
import { FailureLimiter } from '../auth/limiter';
import type { Schema } from '../db/schema';
import { type Git, GitError } from './git';
import {
  createProject,
  createWorkspace,
  deleteProject,
  deleteWorkspace,
  getProject,
  getWorkspace,
  hookTokenMatches,
  listProjects,
  listPushes,
  listWorkspaces,
  newHookToken,
  ProjectError,
  removeHookToken,
  updateProject,
  updateWorkspace,
} from './store';
import type { ProjectSync } from './sync';

export interface ProjectDeps {
  db: Kysely<Schema>;
  git: Git;
  sync: ProjectSync;
  /** A repository may be a folder of this machine (AFS_GIT_LOCAL). */
  allowLocal: boolean;
  /** A clone or fetch asks the source first when the last look is older than this (tests). */
  freshMs?: number;
}

const STATUS: Record<ProjectError['code'], number> = {
  invalid: 400,
  not_found: 404,
  taken: 409,
  not_empty: 409,
};

const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const body = (required: string[], properties: Record<string, unknown>) => ({
  body: { type: 'object', additionalProperties: false, required, properties },
});
const ID = { params: { type: 'object', properties: { id: text(64, 1) }, required: ['id'] } };
const NO_PROJECT = { error: 'not_found', message: 'No such project' };
const NO_WORKSPACE = { error: 'not_found', message: 'No such workspace' };

export function registerProjects(app: FastifyInstance, deps: ProjectDeps): void {
  const { db } = deps;
  const hookFailures = new FailureLimiter({ max: 20, windowMs: 15 * 60 * 1000 });

  const answering =
    <R extends FastifyRequest>(handler: (request: R, reply: FastifyReply) => Promise<unknown>) =>
    async (request: R, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (e) {
        if (e instanceof ProjectError)
          return reply.code(STATUS[e.code]).send({ error: e.code, message: e.message });
        throw e;
      }
    };
  type WithId = { Params: { id: string } };

  // --- workspaces

  app.get('/api/v1/workspaces', async (request, reply) =>
    signedIn(request, reply) ? listWorkspaces(db) : reply,
  );

  app.post<{ Body: { key: string; name: string; description?: string } }>(
    '/api/v1/workspaces',
    {
      schema: body(['key', 'name'], {
        key: text(63, 1),
        name: text(200, 1),
        description: text(2000),
      }),
    },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const workspace = await createWorkspace(db, request.body);
      request.log.info({ by: me.login, workspace: workspace.key }, 'Workspace added');
      return reply.code(201).send(workspace);
    }),
  );

  app.get<WithId>('/api/v1/workspaces/:id', { schema: ID }, async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    return (await getWorkspace(db, request.params.id)) ?? reply.code(404).send(NO_WORKSPACE);
  });

  app.patch<WithId & { Body: { name?: string; description?: string | null } }>(
    '/api/v1/workspaces/:id',
    {
      schema: {
        ...ID,
        ...body([], {
          name: text(200, 1),
          description: { type: ['string', 'null'], maxLength: 2000 },
        }),
      },
    },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const workspace = await getWorkspace(db, request.params.id);
      if (!workspace) return reply.code(404).send(NO_WORKSPACE);
      const changed = await updateWorkspace(db, workspace.id, request.body);
      request.log.info({ by: me.login, workspace: changed.key }, 'Workspace changed');
      return changed;
    }),
  );

  app.delete<WithId>(
    '/api/v1/workspaces/:id',
    { schema: ID },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const workspace = await getWorkspace(db, request.params.id);
      if (!workspace) return reply.code(404).send(NO_WORKSPACE);
      await deleteWorkspace(db, workspace.id);
      request.log.info({ by: me.login, workspace: workspace.key }, 'Workspace deleted');
      return reply.code(204).send();
    }),
  );

  // --- projects

  app.get<WithId>('/api/v1/workspaces/:id/projects', { schema: ID }, async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    const workspace = await getWorkspace(db, request.params.id);
    return workspace ? listProjects(db, workspace.id) : reply.code(404).send(NO_WORKSPACE);
  });

  type NewProjectBody = {
    key: string;
    name: string;
    /** Left out: the server hosts the repository itself. */
    gitUrl?: string;
    gitRef?: string;
    pollSeconds?: number;
  };
  app.post<WithId & { Body: NewProjectBody }>(
    '/api/v1/workspaces/:id/projects',
    {
      schema: {
        ...ID,
        ...body(['key', 'name'], {
          key: text(63, 1),
          name: text(200, 1),
          gitUrl: text(2000, 1),
          gitRef: text(200, 1),
          pollSeconds: { type: 'integer', minimum: 0 },
        }),
      },
    },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const workspace = await getWorkspace(db, request.params.id);
      if (!workspace) return reply.code(404).send(NO_WORKSPACE);
      const project = await createProject(db, workspace.id, request.body, deps.allowLocal);
      request.log.info(
        { by: me.login, workspace: workspace.key, project: project.key },
        'Project added',
      );
      // The first look at the source: the answer already says whether the address works.
      return reply.code(201).send((await deps.sync.sync(project.id)) ?? project);
    }),
  );

  app.get<WithId>('/api/v1/projects/:id', { schema: ID }, async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    return (await getProject(db, request.params.id)) ?? reply.code(404).send(NO_PROJECT);
  });

  type ProjectChangeBody = {
    name?: string;
    gitUrl?: string;
    gitRef?: string;
    pollSeconds?: number;
  };
  app.patch<WithId & { Body: ProjectChangeBody }>(
    '/api/v1/projects/:id',
    {
      schema: {
        ...ID,
        ...body([], {
          name: text(200, 1),
          gitUrl: text(2000, 1),
          gitRef: text(200, 1),
          pollSeconds: { type: 'integer', minimum: 0 },
        }),
      },
    },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const changed = await updateProject(db, request.params.id, request.body, deps.allowLocal);
      request.log.info({ by: me.login, project: changed.key }, 'Project changed');
      // A new source or branch is looked at right away.
      const moved = request.body.gitUrl !== undefined || request.body.gitRef !== undefined;
      return moved ? ((await deps.sync.sync(changed.id)) ?? changed) : changed;
    }),
  );

  app.delete<WithId>(
    '/api/v1/projects/:id',
    { schema: ID },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const project = await getProject(db, request.params.id);
      if (!project) return reply.code(404).send(NO_PROJECT);
      await deleteProject(db, project.id);
      await deps.sync.forget(project.id, project.hosted);
      request.log.info({ by: me.login, project: project.key }, 'Project deleted');
      return reply.code(204).send();
    }),
  );

  app.post<WithId>('/api/v1/projects/:id/sync', { schema: ID }, async (request, reply) => {
    if (!administrator(request, reply)) return reply;
    return (await deps.sync.sync(request.params.id)) ?? reply.code(404).send(NO_PROJECT);
  });

  app.get<WithId>('/api/v1/projects/:id/branches', { schema: ID }, async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    const project = await getProject(db, request.params.id);
    if (!project) return reply.code(404).send(NO_PROJECT);
    try {
      return { branches: await deps.git.branches(project.id) };
    } catch (e) {
      if (e instanceof GitError) return { branches: [] };
      throw e;
    }
  });

  app.get<WithId & { Querystring: { limit?: number } }>(
    '/api/v1/projects/:id/pushes',
    {
      schema: {
        ...ID,
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } },
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const project = await getProject(db, request.params.id);
      if (!project) return reply.code(404).send(NO_PROJECT);
      return listPushes(db, project.id, request.query.limit);
    },
  );

  // --- the push hook

  app.post<WithId>(
    '/api/v1/projects/:id/hook',
    { schema: ID },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const token = await newHookToken(db, request.params.id);
      request.log.info({ by: me.login, project: request.params.id }, 'Push hook set up');
      return reply.code(201).send({
        // Shown this once. The git host sends it back in one of these headers.
        token,
        url: `/api/v1/hooks/projects/${request.params.id}/push`,
        headers: ['X-Gitlab-Token', 'X-AFS-Token', 'Authorization: Bearer'],
      });
    }),
  );

  app.delete<WithId>('/api/v1/projects/:id/hook', { schema: ID }, async (request, reply) => {
    if (!administrator(request, reply)) return reply;
    await removeHookToken(db, request.params.id);
    return reply.code(204).send();
  });

  /**
   * The git host says the repository changed. It proves who it is with the hook's token; what it
   * sends besides is not read: the server looks at the source itself.
   */
  app.post<WithId>('/api/v1/hooks/projects/:id/push', { schema: ID }, async (request, reply) => {
    const key = `ip:${request.ip}`;
    const wait = hookFailures.retryAfter(key);
    if (wait > 0)
      return reply
        .code(429)
        .header('retry-after', String(wait))
        .send({ error: 'too_many_attempts', message: 'Too many wrong tokens', retryAfter: wait });
    const header = (name: string) => {
      const value = request.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    const token =
      header('x-gitlab-token') ??
      header('x-afs-token') ??
      /^Bearer\s+(\S+)$/i.exec(header('authorization') ?? '')?.[1];
    if (!token || !(await hookTokenMatches(db, request.params.id, token))) {
      hookFailures.fail(key);
      // One answer for a wrong token, a project without a hook and no such project.
      return reply.code(401).send({ error: 'unauthorized', message: 'The hook token is wrong' });
    }
    // The host does not wait for the fetch: it is told the server heard it.
    void deps.sync
      .sync(request.params.id)
      .catch((e) =>
        request.log.error({ err: e }, 'A push hook could not bring a project up to date'),
      );
    return reply.code(202).send({ status: 'accepted' });
  });
}
