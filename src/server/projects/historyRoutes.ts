// AFS-123: a project's history over the API, as the designer's History shows a folder's (AFD-320):
// the commits of a branch (a filter, a page at a time), one commit with the files it changed (flows
// by their title), a flow's commits (its flow and scenarios files), and what a commit did to a flow,
// for the flow at that commit. Reading needs ro on the project, or on the flow for a flow's own
// routes (api/catalog.ts checks it before the handler).
import { parseFlow } from '@ansible-flow/core/flow/document';
import type { Commit } from '@ansible-flow/node/history/gitLog';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { signedIn } from '../auth/guards';
import type { Schema } from '../db/schema';
import { FLOW_FILE } from './flows';
import { type Git, GitError } from './git';
import { getProject } from './store';

export interface HistoryRouteDeps {
  db: Kysely<Schema>;
  git: Git;
}

const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const ID = { params: { type: 'object', properties: { id: text(64, 1) }, required: ['id'] } };
const COMMIT = { type: 'string', pattern: '^[0-9a-f]{40}$' };
const SOME_COMMIT = { type: 'string', minLength: 1, maxLength: 200 };
const NO_PROJECT = { error: 'not_found', message: 'No such project' };
/** git's tree with nothing in it: what the first commit is compared with. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** A commit lists at most this many files; at most this many flows are named by their title. */
const MAX_FILES = 1000;
const MAX_TITLES = 100;

/** The flow's scenarios file, beside it: `<key>.scenarios.yaml`. */
export const scenariosOf = (flow: string) => flow.replace(FLOW_FILE, '.scenarios.yaml');

/** A commit as the lists show it. */
export interface CommitSummary {
  commit: string;
  parents: string[];
  author: string;
  /** ISO 8601 author date. */
  at: string;
  subject: string;
}
const summaryOf = (c: Commit): CommitSummary => ({
  commit: c.hash,
  parents: c.parents,
  author: c.author,
  at: c.date,
  subject: c.subject,
});

/** A flow's title in its text, if it reads as a flow. */
function titleOf(bytes: Buffer | undefined): string | undefined {
  if (!bytes) return undefined;
  try {
    const name = parseFlow(bytes.toString('utf8')).doc?.flow?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function registerHistory(app: FastifyInstance, deps: HistoryRouteDeps): void {
  const { db, git } = deps;
  type WithId = { Params: { id: string } };

  /** The commits of a branch (or of a flow), newest first, a page at a time, filtered by words. */
  app.get<
    WithId & {
      Querystring: {
        branch?: string;
        commit?: string;
        path?: string;
        q?: string;
        skip?: number;
        limit?: number;
      };
    }
  >(
    '/api/v1/projects/:id/commits',
    {
      schema: {
        ...ID,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            branch: text(200, 1),
            commit: COMMIT,
            path: text(1000, 1),
            q: text(200),
            skip: { type: 'integer', minimum: 0, maximum: 10_000_000 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const project = await getProject(db, request.params.id);
      if (!project) return reply.code(404).send(NO_PROJECT);
      const { path, q } = request.query;
      if (path && !FLOW_FILE.test(path))
        return reply.code(404).send({ error: 'not_found', message: 'Not a flow file' });
      const branch = request.query.branch ?? project.gitRef;
      let tip = request.query.commit;
      if (tip) {
        if (!(await git.hasCommit(project.id, tip)))
          return reply
            .code(404)
            .send({ error: 'not_found', message: 'The project has no such commit' });
      } else {
        if (!project.commit && !request.query.branch) return { branch, commits: [] };
        tip = await git.resolve(project.id, branch).catch(() => undefined);
        if (!tip)
          return reply
            .code(404)
            .send({ error: 'not_found', message: `The project has no branch ${branch}` });
      }
      try {
        const page = await git.log(project.id, tip, {
          skip: request.query.skip ?? 0,
          limit: request.query.limit ?? 50,
          ...(path ? { paths: [path, scenariosOf(path)] } : {}),
          ...(q?.trim() ? { filter: q } : {}),
        });
        return {
          branch,
          commit: tip,
          commits: page.commits.map((c) =>
            path
              ? {
                  ...summaryOf(c),
                  // A flow's history says which of its files each commit changed.
                  files: c.files
                    .filter((f) => f.path === path || f.path === scenariosOf(path))
                    .map((f) => ({
                      file: f.path,
                      change: f.status === 'A' ? 'added' : f.status === 'D' ? 'removed' : 'changed',
                    })),
                }
              : summaryOf(c),
          ),
          ...(page.next !== undefined ? { next: page.next } : {}),
        };
      } catch (e) {
        if (e instanceof GitError)
          return reply
            .code(404)
            .send({ error: 'not_found', message: 'The history cannot be read now' });
        throw e;
      }
    },
  );

  /** One commit: who, when, its message, and the files it changed (flows with their title). */
  app.get<WithId & { Params: { commit: string } }>(
    '/api/v1/projects/:id/commits/:commit',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: text(64, 1), commit: COMMIT },
          required: ['id', 'commit'],
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const project = await getProject(db, request.params.id);
      if (!project) return reply.code(404).send(NO_PROJECT);
      const { commit } = request.params;
      if (!(await git.hasCommit(project.id, commit)))
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'The project has no such commit' });
      const [one] = (await git.log(project.id, commit, { limit: 1 })).commits;
      if (!one)
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'The project has no such commit' });
      // Against the first parent (a merge: what it brought to the branch); the first commit
      // against nothing.
      const parent = one.parents[0];
      // AFS-190: a file moved is one entry, with the path it had.
      const changed = await git.commitFiles(project.id, parent ?? EMPTY_TREE, commit);
      let titled = 0;
      const files = [];
      for (const f of changed.slice(0, MAX_FILES)) {
        if (FLOW_FILE.test(f.file) && titled < MAX_TITLES) {
          titled++;
          // A removed flow is named as it was before.
          const at = f.change === 'removed' ? parent : commit;
          const title = at
            ? titleOf(await git.read(project.id, at, f.file).catch(() => undefined))
            : undefined;
          files.push({ ...f, flow: true, ...(title ? { title } : {}) });
        } else files.push(FLOW_FILE.test(f.file) ? { ...f, flow: true } : f);
      }
      return {
        ...summaryOf(one),
        body: one.body,
        files,
        ...(changed.length > MAX_FILES ? { more: changed.length - MAX_FILES } : {}),
      };
    },
  );

  /**
   * What a commit did to a flow (added, changed, removed it, or nothing), with the commit's
   * author, time and message: the flow page at a commit. `before`: the commit to compare with
   * (the parent, when it had the flow); `last`: for a removal, the last commit that changed it.
   */
  app.get<WithId & { Querystring: { path: string; commit: string } }>(
    '/api/v1/projects/:id/flows/commit',
    {
      schema: {
        ...ID,
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'commit'],
          // AFS-190: a full commit id, or its start as the pages show it (7 characters or more).
          properties: { path: text(1000, 1), commit: SOME_COMMIT },
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const project = await getProject(db, request.params.id);
      if (!project) return reply.code(404).send(NO_PROJECT);
      const { path } = request.query;
      if (!FLOW_FILE.test(path))
        return reply.code(404).send({ error: 'not_found', message: 'Not a flow file' });
      const found = await git.findCommit(project.id, request.query.commit);
      if ('ambiguous' in found)
        return reply.code(404).send({
          error: 'not_found',
          message: `More than one commit of the project starts with ${request.query.commit}: give more of its id.`,
        });
      if ('none' in found)
        return reply.code(404).send({
          error: 'not_found',
          message: `The project has no commit ${request.query.commit}.`,
        });
      const { commit } = found;
      try {
        const [one] = (await git.log(project.id, commit, { limit: 1 })).commits;
        if (!one)
          return reply
            .code(404)
            .send({ error: 'not_found', message: 'The project has no such commit' });
        const parent = one.parents[0];
        const here = await git.exists(project.id, commit, path);
        const before = parent ? await git.exists(project.id, parent, path) : false;
        if (!here && !before)
          return reply.code(404).send({
            error: 'not_found',
            message: `The flow was not in the project at commit ${commit.slice(0, 12)}.`,
          });
        let change: 'added' | 'changed' | 'removed' | 'unchanged';
        if (!before) change = 'added';
        else if (!here) change = 'removed';
        else
          change = (await git.changedFiles(project.id, parent as string, commit)).some(
            (f) => f.file === path,
          )
            ? 'changed'
            : 'unchanged';
        const last =
          change === 'removed'
            ? (await git.fileHistory(project.id, parent as string, path, { limit: 1 }))[0]?.commit
            : undefined;
        // AFS-190: whether the project's branch has the commit; if not, the branches that do.
        const branches = await git.branchesWith(project.id, commit).catch(() => [] as string[]);
        const onBranch = branches.includes(project.gitRef);
        return {
          ...summaryOf(one),
          body: one.body,
          path,
          change,
          ...(before && parent ? { before: parent } : {}),
          ...(last ? { last } : {}),
          onBranch,
          ...(onBranch ? {} : { branches: branches.slice(0, 5) }),
        };
      } catch (e) {
        if (e instanceof GitError)
          return reply.code(404).send({ error: 'not_found', message: 'No such commit or flow' });
        throw e;
      }
    },
  );
}
