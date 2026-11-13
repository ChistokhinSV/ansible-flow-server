// The server as a git address: every project, hosted or with an external source, is cloned,
// fetched and pushed at
//   /git/<workspace key>/<project key>.git
// over git's "smart HTTP". The git program answers; this file decides who may ask, and keeps a
// record of who pushed what.
//   GET  .../info/refs?service=git-upload-pack|git-receive-pack
//   POST .../git-upload-pack      a clone or a fetch
//   POST .../git-receive-pack     a push
// Sign-in is a personal access token as the password (any user name): never a session, so a
// page in a browser cannot push with someone's cookie, and never the person's password.
import { PassThrough, type Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionUser } from '../auth/sessions';
import { type GitService, MAX_PUSH_BYTES, scrub } from './git';
import type { ProjectDeps } from './routes';
import { getWorkspace, listProjects, type Project, type PushedRef, recordPushes } from './store';

/** A clone or fetch asks the source first when the last look is older than this. */
export const FRESH_MS = 10_000;
/** How long one fetch or push may take. */
const RPC_TIMEOUT_MS = 10 * 60 * 1000;
const REALM = 'Basic realm="Ansible Flow Server (password: a personal access token)"';

type Params = { workspace: string; repo: string };
type Service = 'git-upload-pack' | 'git-receive-pack';
const toGit = (service: Service) => service.slice(4) as GitService;
const pkt = (text: string) => (Buffer.byteLength(text) + 4).toString(16).padStart(4, '0') + text;

/**
 * May this person push to this project? Until access levels exist (AFS-27) pushing is changing
 * a project, which administrators do. This function is the one place that rule lives.
 */
export function mayPush(user: SessionUser, _project: Project): boolean {
  return user.admin;
}

export function registerGit(app: FastifyInstance, deps: ProjectDeps): void {
  const { db, git, sync } = deps;
  const freshMs = deps.freshMs ?? FRESH_MS;

  // What a git client sends is a stream for the git program, not a body to parse.
  for (const service of ['git-upload-pack', 'git-receive-pack'])
    app.addContentTypeParser(`application/x-${service}-request`, (_request, payload, done) =>
      done(null, payload),
    );

  const refuse = (reply: FastifyReply, code: number, message: string) =>
    reply.code(code).type('text/plain; charset=utf-8').send(`${message}\n`);

  /** The person a token signs in, allowed to do this; else answers and gives undefined. */
  const who = (request: FastifyRequest, reply: FastifyReply): SessionUser | undefined => {
    if (request.user?.token) return request.user;
    reply.header('www-authenticate', REALM);
    refuse(reply, 401, 'Sign in with a personal access token as the password');
    return undefined;
  };

  const find = async (params: Params): Promise<Project | undefined> => {
    const workspace = await getWorkspace(db, params.workspace);
    if (!workspace) return undefined;
    const key = params.repo.replace(/\.git$/, '');
    return (await listProjects(db, workspace.id)).find((p) => p.key === key);
  };

  /** The project asked for, when this person may do this to it; else answers. */
  const allowed = async (
    request: FastifyRequest<{ Params: Params }>,
    reply: FastifyReply,
    push: boolean,
  ): Promise<{ user: SessionUser; project: Project } | undefined> => {
    const user = who(request, reply);
    if (!user) return undefined;
    const project = await find(request.params);
    if (!project) {
      refuse(reply, 404, 'No such project');
      return undefined;
    }
    if (push && user.token?.readOnly) {
      refuse(reply, 403, 'This token may only read');
      return undefined;
    }
    if (push && !mayPush(user, project)) {
      refuse(reply, 403, 'You may read this project, not push to it');
      return undefined;
    }
    return { user, project };
  };

  /** The version of git's protocol the client asks for, when it is one the server passes on. */
  const protocolOf = (request: FastifyRequest): string | undefined => {
    const header = request.headers['git-protocol'];
    return typeof header === 'string' && /^version=[12]$/.test(header) ? header : undefined;
  };

  app.get<{ Params: Params; Querystring: { service?: string } }>(
    '/git/:workspace/:repo/info/refs',
    async (request, reply) => {
      const service = request.query.service;
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack')
        return refuse(reply, 403, 'This server speaks git smart HTTP only: update your git');
      const push = service === 'git-receive-pack';
      const found = await allowed(request, reply, push);
      if (!found) return reply;
      const { project } = found;
      // A clone or a fetch of a project with a source gets what the source has now. A source
      // that does not answer is the project's state; the mirror still answers the client.
      const stale = !project.sync.at || Date.now() - Date.parse(project.sync.at) >= freshMs;
      if (project.gitUrl && !push && stale) await sync.sync(project.id);
      else await git.ensure(project.id, project.gitRef);
      // Only a fetch has a version 2; a push is always the first protocol.
      const protocol = push ? undefined : protocolOf(request);
      const refs = await sync.exclusive(project.id, () =>
        git.advertise(project.id, toGit(service), protocol),
      );
      const head = protocol === 'version=2' ? '' : `${pkt(`# service=${service}\n`)}0000`;
      return reply
        .header('content-type', `application/x-${service}-advertisement`)
        .header('cache-control', 'no-cache, max-age=0, must-revalidate')
        .send(Buffer.concat([Buffer.from(head), refs]));
    },
  );

  const rpc = (service: Service) =>
    async function handler(request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) {
      if (request.headers['content-type'] !== `application/x-${service}-request`)
        return refuse(reply, 415, 'Not a git request');
      const push = service === 'git-receive-pack';
      const found = await allowed(request, reply, push);
      if (!found) return reply;
      const { user, project } = found;

      const serve = async () => {
        const before = push ? await git.refs(project.id) : undefined;
        const child = git.serve(project.id, toGit(service), {
          protocol: push ? undefined : protocolOf(request),
          protectedRef: project.gitRef,
          upstream: project.gitUrl,
        });
        // The answer ends only when the server's own bookkeeping is done: a client that reads
        // the project right after its push sees the pushed commit.
        const out = new PassThrough();
        child.stdout.pipe(out, { end: false });
        const stop = () => {
          if (child.exitCode === null) child.kill();
        };
        const timer = setTimeout(stop, RPC_TIMEOUT_MS);
        reply.raw.on('close', stop);
        let said = '';
        child.stderr.on('data', (chunk: Buffer) => {
          if (said.length < 4000) said += chunk.toString('utf8');
        });
        // A client that goes away mid-request closes git's input: that is git's to notice.
        child.stdin.on('error', () => undefined);

        let input = request.body as Readable;
        if (request.headers['content-encoding'] === 'gzip') {
          const gunzip = createGunzip();
          gunzip.on('error', stop);
          input = input.pipe(gunzip);
        }
        let bytes = 0;
        input.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_PUSH_BYTES) stop();
        });
        input.on('error', stop);
        input.pipe(child.stdin);

        void reply
          .header('content-type', `application/x-${service}-result`)
          .header('cache-control', 'no-cache, max-age=0, must-revalidate')
          .send(out);

        const code = await new Promise<number | null>((resolve) => {
          child.on('error', () => resolve(null));
          child.on('close', resolve);
        });
        clearTimeout(timer);
        try {
          if (code !== 0)
            request.log.warn(
              { project: project.key, service, code, detail: scrub(said).slice(0, 600) },
              'A git request did not finish',
            );
          if (!before) return;
          const after = await git.refs(project.id);
          const pushed: PushedRef[] = [];
          for (const ref of new Set([...before.keys(), ...after.keys()]))
            if (before.get(ref) !== after.get(ref))
              pushed.push({ ref, from: before.get(ref), to: after.get(ref) });
          if (!pushed.length) return;
          await recordPushes(db, project.id, user, pushed);
          request.log.info(
            {
              by: user.login,
              project: project.key,
              branches: pushed.map((p) => `${p.ref}@${(p.to ?? 'deleted').slice(0, 12)}`),
            },
            'Push',
          );
          // For a project with a source this asks the source again: it is the truth.
          await sync.refresh(project.id);
        } catch (e) {
          request.log.error({ err: e, project: project.key }, 'Recording a push failed');
        } finally {
          out.end();
        }
      };
      // A push has the repository to itself; fetches read it while others read too.
      await (push ? sync.exclusive(project.id, serve) : serve());
      return reply;
    };

  app.post<{ Params: Params }>('/git/:workspace/:repo/git-upload-pack', rpc('git-upload-pack'));
  app.post<{ Params: Params }>('/git/:workspace/:repo/git-receive-pack', rpc('git-receive-pack'));
}
