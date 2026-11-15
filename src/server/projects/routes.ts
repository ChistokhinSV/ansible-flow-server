// Workspaces and projects over HTTP. Administrators make and change them; others see the
// workspaces, projects and flows they have a grant on (AFS-27; the level each route needs is in
// api/catalog.ts, and the lists here are narrowed to what the person may see).
//   /api/v1/workspaces, /workspaces/:id            :id is the workspace's id or its key
//   /api/v1/workspaces/:id/projects
//   /api/v1/projects/:id, /sync, /branches, /pushes, /hook
//   /api/v1/projects/:id/branches                  list with commits, make, delete (AFS-59)
//   /api/v1/projects/:id/flows, /flows/view?path=   the flows at the project's commit
//   /api/v1/projects/:id/events, /changes, /flows/history   who changed which flow (AFS-75)
//   /api/v1/hooks/projects/:id/push                called by the git host, with the hook's token
//   /api/v1/samples, /api/v1/projects/:id/start     a hosted project's first commit (AFS-58)
import type { ServerResponse } from 'node:http';
import { type LibrarySubflow, libraryFindings, usesLibrary } from '@ansible-flow/core/flow/library';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { accessOf, atLeast } from '../access/grants';
import { administrator, signedIn } from '../auth/guards';
import { FailureLimiter } from '../auth/limiter';
import type { Schema } from '../db/schema';
import type { MasterKey } from '../secrets/masterKey';
import { BranchRefused, createBranch, deleteBranch, listBranches } from './branches';
import { FLOW_FILE, FlowError, ProjectFlows } from './flows';
import { type Git, GitError, sshHost } from './git';
import type { Library } from './library';
import {
  archiveFiles,
  listSamples,
  MAX_FILES,
  type StartFiles,
  StartRefused,
  sampleFiles,
  startProject,
} from './start';
import {
  createProject,
  createWorkspace,
  deleteProject,
  deleteWorkspace,
  getProject,
  getWorkspace,
  hookSignatureMatches,
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
import type { ProjectWatch } from './watch';

export interface ProjectDeps {
  db: Kysely<Schema>;
  git: Git;
  sync: ProjectSync;
  /** A repository may be a folder of this machine (AFS_GIT_LOCAL). */
  allowLocal: boolean;
  /** A clone or fetch asks the source first when the last look is older than this (tests). */
  freshMs?: number;
  /** AFS-75: tells the event streams when a project's branch moves. */
  watch?: ProjectWatch;
  /** AFS-61: seals a push hook's secret, so GitHub's signature of a hook can be checked. */
  masterKey?: MasterKey;
  /** AFS-58: an archive a project starts from unpacks to at most this (default 50 MB). */
  archiveMaxBytes?: number;
  /** AFS-79: the flow library, to say which library copies of a flow are behind. */
  library?: Library;
}

/** A comment line now and then keeps a quiet stream open through proxies. */
const KEEP_ALIVE_MS = 25_000;
/** AFS-61: a hook's body is read only for its signature; GitHub sends at most 25 MB. */
const HOOK_BODY_MAX = 25 * 1024 * 1024;
const COMMIT_PATTERN = { type: 'string', pattern: '^[0-9a-f]{40}$' };

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
  const flows = new ProjectFlows(deps.git);
  const archiveMaxBytes = deps.archiveMaxBytes ?? 50 * 1024 * 1024;

  const answering =
    <R extends FastifyRequest>(handler: (request: R, reply: FastifyReply) => Promise<unknown>) =>
    async (request: R, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (e) {
        if (e instanceof ProjectError)
          return reply.code(STATUS[e.code]).send({ error: e.code, message: e.message });
        if (e instanceof StartRefused)
          return reply.code(400).send({ error: 'invalid', message: e.message });
        if (e instanceof BranchRefused)
          return reply
            .code(e.code === 'not_found' ? 404 : 409)
            .send({ error: e.code, message: e.message, ...e.details });
        // A source that refused a branch change: its reason, without what git said around it.
        if (e instanceof GitError)
          return reply.code(400).send({ error: 'source_refused', message: e.message });
        throw e;
      }
    };
  type WithId = { Params: { id: string } };

  // --- workspaces

  app.get('/api/v1/workspaces', async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    const access = await accessOf(db, request);
    return (await listWorkspaces(db)).filter((w) => access?.sees(w.id));
  });

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
    const me = signedIn(request, reply);
    if (!me) return reply;
    const ws = await getWorkspace(db, request.params.id);
    if (!ws) return reply.code(404).send(NO_WORKSPACE);
    // AFS-32: the caller's own level on it, so the pages show only what it allows.
    const access = await accessOf(db, request);
    return { ...ws, level: me.admin ? 'admin' : (access?.onWorkspace(ws.id) ?? null) };
  });

  app.patch<
    WithId & { Body: { name?: string; description?: string | null; selfApprove?: boolean } }
  >(
    '/api/v1/workspaces/:id',
    {
      schema: {
        ...ID,
        ...body([], {
          name: text(200, 1),
          description: { type: ['string', 'null'], maxLength: 2000 },
          // AFS-28: who launched a run may decide its approvals too.
          selfApprove: { type: 'boolean' },
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
    if (!workspace) return reply.code(404).send(NO_WORKSPACE);
    const access = await accessOf(db, request);
    return (await listProjects(db, workspace.id)).filter((p) => access?.sees(workspace.id, p.id));
  });

  type NewProjectBody = {
    key: string;
    name: string;
    /** Left out: the server hosts the repository itself. */
    gitUrl?: string;
    gitCredential?: string;
    gitRef?: string;
    pollSeconds?: number;
    /** AFS-58: a hosted project's first commit is this sample project. */
    sample?: string;
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
          gitCredential: text(64, 1),
          gitRef: text(200, 1),
          pollSeconds: { type: 'integer', minimum: 0 },
          sample: text(63, 1),
        }),
      },
    },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const workspace = await getWorkspace(db, request.params.id);
      if (!workspace) return reply.code(404).send(NO_WORKSPACE);
      const { sample, ...asked } = request.body;
      if (sample && asked.gitUrl)
        return reply.code(400).send({
          error: 'invalid',
          message: 'A project with a source starts from it, not from a sample',
        });
      // The sample is read before the project is made: a wrong key makes nothing.
      const start = sample ? sampleFiles(sample) : undefined;
      const project = await createProject(db, workspace.id, asked, deps.allowLocal);
      if (start) {
        const started = await startProject(deps, project, start, me, `the ${sample} sample`);
        request.log.info(
          { by: me.login, workspace: workspace.key, project: project.key, sample },
          'Project added from a sample',
        );
        return reply.code(201).send(started.project);
      }
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
    gitCredential?: string | null;
    gitRef?: string;
    pollSeconds?: number;
    library?: boolean;
  };
  app.patch<WithId & { Body: ProjectChangeBody }>(
    '/api/v1/projects/:id',
    {
      schema: {
        ...ID,
        ...body([], {
          name: text(200, 1),
          gitUrl: text(2000, 1),
          gitCredential: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
          gitRef: text(200, 1),
          pollSeconds: { type: 'integer', minimum: 0 },
          library: { type: 'boolean' },
        }),
      },
    },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const changed = await updateProject(db, request.params.id, request.body, deps.allowLocal);
      request.log.info({ by: me.login, project: changed.key }, 'Project changed');
      // A new source or branch is looked at right away.
      const moved =
        request.body.gitUrl !== undefined ||
        request.body.gitRef !== undefined ||
        request.body.gitCredential !== undefined;
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

  // --- AFS-58: a hosted project's first commit, from a sample or an archive

  app.get('/api/v1/samples', async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    return listSamples();
  });

  // An archive comes as the body itself: zip or tar.gz, at most the limit (packed).
  for (const type of ['application/zip', 'application/gzip', 'application/x-gzip'])
    app.addContentTypeParser(
      type,
      { parseAs: 'buffer', bodyLimit: archiveMaxBytes },
      (_request, body, done) => done(null, body),
    );
  app.post<WithId & { Body: { sample?: string } | Buffer }>(
    '/api/v1/projects/:id/start',
    { schema: ID, bodyLimit: archiveMaxBytes },
    answering(async (request, reply) => {
      // rw on the workspace: checked before (api/catalog.ts).
      const me = signedIn(request, reply);
      if (!me) return reply;
      const project = await getProject(db, request.params.id);
      if (!project) return reply.code(404).send(NO_PROJECT);
      const body = request.body;
      let files: StartFiles;
      let what: string;
      if (Buffer.isBuffer(body)) {
        files = await archiveFiles(body, { maxBytes: archiveMaxBytes, maxFiles: MAX_FILES });
        what = 'an archive';
      } else if (body && typeof body === 'object' && typeof body.sample === 'string') {
        files = sampleFiles(body.sample);
        what = `the ${body.sample} sample`;
      } else
        return reply.code(400).send({
          error: 'invalid',
          message:
            'Send {"sample": "<key>"}, or a zip (application/zip) or tar.gz (application/gzip) as the body',
        });
      const started = await startProject(deps, project, files, me, what);
      request.log.info(
        {
          by: me.login,
          project: project.key,
          from: what,
          files: started.files,
          commit: started.commit.slice(0, 12),
        },
        'Project started',
      );
      return reply.code(201).send(started.project);
    }),
  );

  // --- AFS-60: the SSH host key the server trusts for a project's ssh source

  app.get<WithId>('/api/v1/projects/:id/host-key', { schema: ID }, async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    const project = await getProject(db, request.params.id);
    if (!project) return reply.code(404).send(NO_PROJECT);
    const host = project.gitUrl ? sshHost(project.gitUrl) : undefined;
    if (!host || !project.gitUrl) return { keys: [] };
    return { host, keys: await deps.git.hostKeys(project.gitUrl) };
  });

  app.post<WithId>(
    '/api/v1/projects/:id/host-key/forget',
    { schema: ID },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const project = await getProject(db, request.params.id);
      if (!project) return reply.code(404).send(NO_PROJECT);
      const host = project.gitUrl ? sshHost(project.gitUrl) : undefined;
      if (!host || !project.gitUrl)
        return reply.code(400).send({ error: 'invalid', message: 'The project has no ssh source' });
      const before = await deps.git.hostKeys(project.gitUrl);
      await deps.git.forgetHostKeys(project.gitUrl);
      request.auditDetail = { host, forgot: before.join(', ') };
      request.log.warn(
        { by: me.login, project: project.key, host, forgot: before },
        'SSH host key forgotten: the next look at the source trusts the key it finds',
      );
      // The next look trusts what the host shows now.
      return (await deps.sync.sync(project.id)) ?? reply.code(404).send(NO_PROJECT);
    }),
  );

  app.post<WithId>('/api/v1/projects/:id/sync', { schema: ID }, async (request, reply) => {
    // rw on the workspace: checked before (api/catalog.ts).
    if (!signedIn(request, reply)) return reply;
    return (await deps.sync.sync(request.params.id)) ?? reply.code(404).send(NO_PROJECT);
  });

  app.get<WithId>('/api/v1/projects/:id/branches', { schema: ID }, async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    const project = await getProject(db, request.params.id);
    if (!project) return reply.code(404).send(NO_PROJECT);
    // `branches`: the names, as before; `details`: each with its newest commit (AFS-59).
    const details = await listBranches(deps, project);
    return { branches: details.map((b) => b.name).sort(), details };
  });

  app.post<WithId & { Body: { name: string; from: string } }>(
    '/api/v1/projects/:id/branches',
    { schema: { ...ID, ...body(['name', 'from'], { name: text(200, 1), from: text(200, 1) }) } },
    answering(async (request, reply) => {
      // rw on the workspace: checked before (api/catalog.ts).
      const me = signedIn(request, reply);
      if (!me) return reply;
      const project = await getProject(db, request.params.id);
      if (!project) return reply.code(404).send(NO_PROJECT);
      request.auditDetail = { branch: request.body.name, from: request.body.from };
      const made = await createBranch(deps, project, request.body, me);
      request.log.info(
        { by: me.login, project: project.key, branch: made.name, commit: made.commit.slice(0, 12) },
        'Branch made',
      );
      return reply.code(201).send(made);
    }),
  );

  app.delete<WithId & { Querystring: { name: string; force?: boolean } }>(
    '/api/v1/projects/:id/branches',
    {
      schema: {
        ...ID,
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: { name: text(200, 1), force: { type: 'boolean' } },
        },
      },
    },
    answering(async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const project = await getProject(db, request.params.id);
      if (!project) return reply.code(404).send(NO_PROJECT);
      request.auditDetail = { branch: request.query.name, force: request.query.force === true };
      const gone = await deleteBranch(
        deps,
        project,
        request.query.name,
        { force: request.query.force === true },
        me,
      );
      request.log.info(
        { by: me.login, project: project.key, branch: gone.name, was: gone.commit.slice(0, 12) },
        'Branch deleted',
      );
      return reply.code(200).send(gone);
    }),
  );

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

  // --- flows

  app.get<WithId>('/api/v1/projects/:id/flows', { schema: ID }, async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    const project = await getProject(db, request.params.id);
    if (!project) return reply.code(404).send(NO_PROJECT);
    try {
      const list = await flows.list(project.id, project.commit);
      // Someone with grants on some flows only sees those.
      const access = await accessOf(db, request);
      return {
        ...list,
        flows: list.flows.filter((f) => access?.onFlow(project.workspace, project.id, f.file)),
      };
    } catch (e) {
      // A repository that cannot be read just now has no list; the project's page says why.
      if (e instanceof GitError) return { commit: project.commit, flows: [] };
      throw e;
    }
  });

  /** One flow as the designer shows it: at the project's commit, or at `commit` (a run's). */
  app.get<WithId & { Querystring: { path: string; commit?: string } }>(
    '/api/v1/projects/:id/flows/view',
    {
      schema: {
        ...ID,
        querystring: {
          type: 'object',
          required: ['path'],
          properties: {
            path: text(1000, 1),
            commit: { type: 'string', pattern: '^[0-9a-f]{40}$' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const project = await getProject(db, request.params.id);
      if (!project) return reply.code(404).send(NO_PROJECT);
      const commit = request.query.commit ?? project.commit;
      if (!commit)
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'The project has no commit yet' });
      if (request.query.commit && !(await deps.git.hasCommit(project.id, commit)))
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'The project has no such commit' });
      try {
        const view = await flows.view(project.id, commit, request.query.path);
        // AFS-79: library copies against the library, as the person asking may read it.
        const doc = view.snapshot.doc;
        if (deps.library && doc && usesLibrary(doc)) {
          const access = await accessOf(db, request);
          const listed = await deps.library.list((w) => atLeast(access?.onWorkspace(w), 'ro'));
          return {
            ...view,
            snapshot: {
              ...view.snapshot,
              findings: [
                ...view.snapshot.findings,
                ...libraryFindings(doc, listed as LibrarySubflow[]),
              ],
            },
          };
        }
        return view;
      } catch (e) {
        if (e instanceof FlowError)
          return reply
            .code(e.code === 'not_found' ? 404 : 422)
            .send({ error: e.code, message: e.message });
        if (e instanceof GitError)
          return reply.code(404).send({ error: 'not_found', message: 'No such flow' });
        throw e;
      }
    },
  );

  // --- who changed which flow (AFS-75)

  /** The streams open now: a server that closes ends them, or it would wait for them. */
  const streams = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
    streams.clear();
  });

  /**
   * The project's branch as it moves, as server-sent events: `commit` (where it is, at once) and
   * `moved` (from, to) each time it goes to another commit. What changed: `/changes`.
   */
  app.get<WithId>('/api/v1/projects/:id/events', { schema: ID }, async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    const project = await getProject(db, request.params.id);
    if (!project) return reply.code(404).send(NO_PROJECT);
    if (!deps.watch)
      return reply.code(404).send({ error: 'not_found', message: 'This server does not watch' });
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
    send('commit', { commit: project.commit ?? null });
    const unwatch = await deps.watch.watch(project.id, (move) => send('moved', move));
    const alive = setInterval(() => {
      if (open) raw.write(': still here\n\n');
    }, KEEP_ALIVE_MS);
    streams.add(raw);
    raw.on('close', () => {
      open = false;
      unwatch();
      clearInterval(alive);
      streams.delete(raw);
    });
    return reply;
  });

  /**
   * The flows that differ between a commit and the project's commit (or `to`), among those the
   * person may see: added, changed or removed, and who changed them, newest first.
   */
  app.get<WithId & { Querystring: { from: string; to?: string } }>(
    '/api/v1/projects/:id/changes',
    {
      schema: {
        ...ID,
        querystring: {
          type: 'object',
          required: ['from'],
          additionalProperties: false,
          properties: { from: COMMIT_PATTERN, to: COMMIT_PATTERN },
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const project = await getProject(db, request.params.id);
      if (!project) return reply.code(404).send(NO_PROJECT);
      const to = request.query.to ?? project.commit;
      const { from } = request.query;
      if (!to)
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'The project has no commit yet' });
      // A commit the server does not have (one not pushed yet) cannot be compared here.
      for (const commit of [from, to])
        if (!(await deps.git.hasCommit(project.id, commit)))
          return reply.code(409).send({
            error: 'unknown_commit',
            message: `The project has no commit ${commit.slice(0, 12)}`,
          });
      const access = await accessOf(db, request);
      const changed = (await deps.git.changedFiles(project.id, from, to)).filter(
        (f) => FLOW_FILE.test(f.file) && access?.onFlow(project.workspace, project.id, f.file),
      );
      const flowsChanged = [];
      for (const f of changed.slice(0, 200)) {
        // Who changed it in between, newest first.
        const commits = await deps.git
          .fileHistory(project.id, to, f.file, { since: from, limit: 50 })
          .catch(() => []);
        flowsChanged.push({
          ...f,
          authors: [...new Set(commits.map((c) => c.author))],
          ...(commits[0] ? { at: commits[0].at, commit: commits[0].commit } : {}),
        });
      }
      return { from, to, flows: flowsChanged };
    },
  );

  /** The commits that changed a flow, newest first, up to the project's commit (or `commit`). */
  app.get<WithId & { Querystring: { path: string; commit?: string; limit?: number } }>(
    '/api/v1/projects/:id/flows/history',
    {
      schema: {
        ...ID,
        querystring: {
          type: 'object',
          required: ['path'],
          additionalProperties: false,
          properties: {
            path: text(1000, 1),
            commit: COMMIT_PATTERN,
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const project = await getProject(db, request.params.id);
      if (!project) return reply.code(404).send(NO_PROJECT);
      const commit = request.query.commit ?? project.commit;
      if (!commit) return [];
      if (!FLOW_FILE.test(request.query.path))
        return reply.code(404).send({ error: 'not_found', message: 'Not a flow file' });
      try {
        return await deps.git.fileHistory(project.id, commit, request.query.path, {
          limit: request.query.limit ?? 30,
        });
      } catch (e) {
        if (e instanceof GitError)
          return reply.code(404).send({ error: 'not_found', message: 'No such commit or flow' });
        throw e;
      }
    },
  );

  /** What the person asking may do in this project: for the pages, to show what applies. */
  app.get<WithId>('/api/v1/projects/:id/access', { schema: ID }, async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    const project = await getProject(db, request.params.id);
    if (!project) return reply.code(404).send(NO_PROJECT);
    const access = await accessOf(db, request);
    if (!access) return reply;
    let files: string[] = [];
    try {
      files = (await flows.list(project.id, project.commit)).flows.map((f) => f.file);
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
    }
    return {
      admin: access.admin,
      workspace: access.onWorkspace(project.workspace) ?? null,
      approve: access.approves(project.workspace),
      flows: Object.fromEntries(
        files.map((file) => [file, access.onFlow(project.workspace, project.id, file) ?? null]),
      ),
    };
  });

  // --- the push hook

  app.post<WithId>(
    '/api/v1/projects/:id/hook',
    { schema: ID },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const token = await newHookToken(db, request.params.id, deps.masterKey);
      request.log.info({ by: me.login, project: request.params.id }, 'Push hook set up');
      return reply.code(201).send({
        // Shown this once. The git host sends it back in one of these headers, or (GitHub,
        // AFS-61) signs the hook's body with it as the hook's secret.
        token,
        url: `/api/v1/hooks/projects/${request.params.id}/push`,
        headers: ['X-Gitlab-Token', 'X-AFS-Token', 'Authorization: Bearer'],
        ...(deps.masterKey ? { signature: 'X-Hub-Signature-256' } : {}),
      });
    }),
  );

  app.delete<WithId>('/api/v1/projects/:id/hook', { schema: ID }, async (request, reply) => {
    if (!administrator(request, reply)) return reply;
    await removeHookToken(db, request.params.id);
    return reply.code(204).send();
  });

  /**
   * The git host says the repository changed. It proves who it is with the hook's token in a
   * header, or (GitHub, AFS-61) with a signature of the body made with the token as its secret;
   * what it sends is not read otherwise: the server looks at the source itself. The body is kept
   * as bytes for the signature, whatever its type.
   */
  app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: HOOK_BODY_MAX },
      (_request, body, done) => done(null, body),
    );
    hooks.post<WithId>(
      '/api/v1/hooks/projects/:id/push',
      { schema: ID, bodyLimit: HOOK_BODY_MAX },
      pushHook,
    );
  });
  async function pushHook(request: FastifyRequest<WithId>, reply: FastifyReply) {
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
    const signature = header('x-hub-signature-256');
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const proven = token
      ? await hookTokenMatches(db, request.params.id, token)
      : signature && deps.masterKey
        ? await hookSignatureMatches(db, deps.masterKey, request.params.id, body, signature)
        : false;
    if (!proven) {
      hookFailures.fail(key);
      // One answer for a wrong token or signature, a project without a hook and no such project.
      return reply.code(401).send({ error: 'unauthorized', message: 'The hook token is wrong' });
    }
    // GitHub's first call when a hook is made: the signature is checked, nothing to look at.
    if (header('x-github-event') === 'ping') return reply.code(200).send({ status: 'pong' });
    // The host does not wait for the fetch: it is told the server heard it.
    void deps.sync
      .sync(request.params.id)
      .catch((e) =>
        request.log.error({ err: e }, 'A push hook could not bring a project up to date'),
      );
    return reply.code(202).send({ status: 'accepted' });
  }
}
