// The MCP endpoint (AFS-24): Streamable HTTP at /mcp for agents (Claude Code, Codex, Cursor),
// signed in with an access token. Stateless: each request gets its own MCP server, answered with
// JSON, so any server of a group can answer any request.
//
// Tools:
//   - the designer's flow tools that read (flow_list, flow_describe, flow_validate,
//     flow_reference) on the server's projects (flowIO.ts);
//   - the server's: projects, launch configurations, check and launch, runs (status, output, stop,
//     list), approvals (list; decide only with a token that allows it).
// The server's tools call the server's own API in-process with the caller's token: the same access
// checks, the same limits of a token made for one workspace, the same audit entries (source mcp).
import { runTool } from '@ansible-flow/core/ai/handlers';
import { TOOL_SPECS } from '@ansible-flow/core/ai/specs';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { Access } from '../access/grants';
import type { Schema } from '../db/schema';
import { serverMeta } from '../meta';
import { ProjectFlows } from '../projects/flows';
import type { Git } from '../projects/git';
import { READ_TOOLS, ServerFlowIO } from './flowIO';
import { MCP_CALL, MCP_HEADER } from './mark';

/** The most text a tool answers with; longer output is cut at its start. */
const MAX_TEXT = 40_000;

const INSTRUCTIONS = `Tools of an Ansible Flow Server: the flows of its projects (read-only) and their runs.
Flows are named <workspace>/<project>/<file> (flow_list); read one with flow_describe. Flows change in git, not here.
A run is launched from a launch configuration (launch_config_list): run_check says what a launch would run (commit, inputs, hosts) or what is in the way; run_launch queues it. Follow it with run_status and run_output; run_stop stops it.
A run of a flow with approvals waits at each until a person decides (approval_list). Approvals stay with people: approval_decide works only with a token made to allow it, and only for someone allowed to decide.
You act as the token's owner: you see and do only what they may.`;

interface ServerTool {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
}

const str = (description: string) => ({ type: 'string', description });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const LAUNCH = {
  config: str(
    'The launch configuration: its id, or <workspace>/<project>/<name> as launch_config_list shows it',
  ),
  mode: { type: 'string', enum: ['check', 'real'], description: 'check (nothing changes) or real' },
  ref: str('Another branch to run the newest commit of (needs rw on the flow)'),
  commit: str('A commit to run, its 40-character id (needs rw on the flow)'),
  limit: str("Ansible's --limit"),
  inputs: {
    type: 'object',
    description: 'The flow\'s inputs as text, by name: "fw-edge-01, fw-edge-02" is a host list',
    additionalProperties: { type: 'string' },
  },
};

export const SERVER_TOOLS: ServerTool[] = [
  {
    name: 'project_list',
    title: 'List projects',
    description: 'The workspaces and projects you may see: their commit and how their sync stands',
    readOnly: true,
    inputSchema: object({}),
  },
  {
    name: 'launch_config_list',
    title: 'List launch configurations',
    description: "A project's launch configurations: what each runs (flow, mode, inventory)",
    readOnly: true,
    inputSchema: object({ project: str('<workspace>/<project>, or the project id') }, ['project']),
  },
  {
    name: 'run_check',
    title: 'Check a launch',
    description:
      'What a launch would run (commit, inputs as the flow gets them, hosts) or everything in its way; nothing is run',
    readOnly: true,
    inputSchema: object(LAUNCH, ['config']),
  },
  {
    name: 'run_launch',
    title: 'Launch a run',
    description:
      "Queues a run of a launch configuration (operator on the flow). A real run changes devices: say what will run and get the user's go-ahead first (run_check)",
    readOnly: false,
    inputSchema: object(LAUNCH, ['config']),
  },
  {
    name: 'run_status',
    title: 'Run status',
    description: 'How a run stands: its state, why it failed, its approvals, hosts per step',
    readOnly: true,
    inputSchema: object({ run: str('The run id') }, ['run']),
  },
  {
    name: 'run_output',
    title: 'Run output',
    description: 'What Ansible wrote for a run, secrets hidden; the end of it when it is long',
    readOnly: true,
    inputSchema: object(
      {
        run: str('The run id'),
        tail: {
          type: 'integer',
          minimum: 1000,
          maximum: MAX_TEXT,
          description: 'Characters from the end (default 20000)',
        },
      },
      ['run'],
    ),
  },
  {
    name: 'run_stop',
    title: 'Stop a run',
    description: 'Stops a run: at once when it waits or is queued, else at its next heartbeat',
    readOnly: false,
    inputSchema: object({ run: str('The run id') }, ['run']),
  },
  {
    name: 'run_list',
    title: 'List runs',
    description: 'Runs you may see, newest first',
    readOnly: true,
    inputSchema: object({
      project: str('<workspace>/<project>, or the project id'),
      state: {
        type: 'string',
        enum: ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'lost'],
      },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    }),
  },
  {
    name: 'approval_list',
    title: 'List approvals',
    description:
      'Approvals that wait for a decision that you may see, and whether you may decide each',
    readOnly: true,
    inputSchema: object({}),
  },
  {
    name: 'approval_decide',
    title: 'Decide an approval',
    description:
      'Approve or reject an approval a run waits at, with a comment. Only with a token made to allow it, and only when the user has told you to decide it',
    readOnly: false,
    inputSchema: object(
      {
        run: str('The run id'),
        node: str("The approval's node key or id"),
        decision: { type: 'string', enum: ['approved', 'rejected'] },
        comment: str('Why, for the record'),
      },
      ['run', 'node', 'decision'],
    ),
  },
];

export interface McpDeps {
  db: Kysely<Schema>;
  git: Git;
}

type Answer = { text: string; isError?: boolean };

export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  const flows = new ProjectFlows(deps.git);
  const meta = serverMeta();

  /** The server's own API, as the caller (their token), marked as MCP's. */
  const api = async (authorization: string, method: string, url: string, body?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: {
        authorization,
        [MCP_HEADER]: MCP_CALL,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    let json: unknown;
    try {
      json = res.json();
    } catch {}
    return { status: res.statusCode, json, text: res.body };
  };

  const toolsFor = (request: FastifyRequest) => {
    const authorization = request.headers.authorization as string;
    const token = request.user?.token;
    const json = (value: unknown): Answer => ({ text: JSON.stringify(value, null, 2) });
    const refused = (r: { status: number; json: unknown; text: string }): Answer => {
      const body = r.json as { message?: string; problems?: unknown } | undefined;
      return {
        text: body?.problems
          ? JSON.stringify({ refused: body.message, problems: body.problems }, null, 2)
          : `Refused (${r.status}): ${body?.message ?? r.text.slice(0, 300)}`,
        isError: true,
      };
    };
    const get = async (url: string) => api(authorization, 'GET', url);

    /** A project named <workspace>/<project>, or its id. */
    const projectId = async (name: string): Promise<string | undefined> => {
      const [ws, key] = name.split('/');
      if (!key) return name;
      const r = await get(`/api/v1/workspaces/${encodeURIComponent(ws as string)}/projects`);
      return (r.json as { id: string; key: string }[] | undefined)?.find?.((p) => p.key === key)
        ?.id;
    };
    /** A launch configuration named <workspace>/<project>/<name>, or its id. */
    const configId = async (name: string): Promise<string | undefined> => {
      const parts = name.split('/');
      if (parts.length < 3) return name;
      const project = await projectId(`${parts[0]}/${parts[1]}`);
      if (!project) return undefined;
      const r = await get(`/api/v1/projects/${project}/launch-configs`);
      const wanted = parts.slice(2).join('/');
      return (r.json as { id: string; name: string }[] | undefined)?.find?.(
        (c) => c.name === wanted,
      )?.id;
    };
    const launchBody = (input: Record<string, unknown>) => {
      const { config: _c, ...rest } = input;
      return rest;
    };

    const handlers: Record<string, (input: Record<string, unknown>) => Promise<Answer>> = {
      project_list: async () => {
        // A token for one workspace may not list them all: it lists its own.
        const ws = await get(
          token?.workspace ? `/api/v1/workspaces/${token.workspace}` : '/api/v1/workspaces',
        );
        if (ws.status === 404) return json([]);
        if (ws.status !== 200) return refused(ws);
        const out = [];
        for (const w of [ws.json].flat() as { id: string; key: string; name: string }[]) {
          const projects = await get(`/api/v1/workspaces/${w.id}/projects`);
          if (projects.status !== 200) continue;
          for (const p of projects.json as {
            id: string;
            key: string;
            name: string;
            gitRef: string;
            commit?: string;
            sync: { state: string; error?: string };
          }[])
            out.push({
              project: `${w.key}/${p.key}`,
              id: p.id,
              name: p.name,
              branch: p.gitRef,
              commit: p.commit ?? null,
              sync: p.sync.state,
              ...(p.sync.error ? { syncError: p.sync.error } : {}),
            });
        }
        return json(out);
      },
      launch_config_list: async ({ project }) => {
        const id = await projectId(String(project));
        if (!id) return { text: `No project ${project}`, isError: true };
        const r = await get(`/api/v1/projects/${id}/launch-configs`);
        if (r.status !== 200) return refused(r);
        return json(
          (r.json as Record<string, unknown>[]).map((c) => ({
            id: c.id,
            name: c.name,
            flow: c.flowFile,
            mode: c.mode,
            ...(c.inventory ? { inventory: c.inventory } : {}),
            ...(c.gitRef ? { branch: c.gitRef } : {}),
            ...(c.commit ? { commit: c.commit } : {}),
            ...(c.limit ? { limit: c.limit } : {}),
            ...(c.description ? { description: c.description } : {}),
          })),
        );
      },
      run_check: async (input) => {
        const id = await configId(String(input.config));
        if (!id) return { text: `No launch configuration ${input.config}`, isError: true };
        const r = await api(
          authorization,
          'POST',
          `/api/v1/launch-configs/${id}/check`,
          launchBody(input),
        );
        if (r.status !== 200) return refused(r);
        return json((r.json as { launch: unknown }).launch);
      },
      run_launch: async (input) => {
        const id = await configId(String(input.config));
        if (!id) return { text: `No launch configuration ${input.config}`, isError: true };
        const r = await api(
          authorization,
          'POST',
          `/api/v1/launch-configs/${id}/launch`,
          launchBody(input),
        );
        if (r.status !== 201) return refused(r);
        const run = r.json as { id: string; number: number; state: string; flow: { name: string } };
        return json({ run: run.id, number: run.number, state: run.state, flow: run.flow.name });
      },
      run_status: async ({ run }) => {
        const id = encodeURIComponent(String(run));
        const r = await get(`/api/v1/runs/${id}`);
        if (r.status !== 200) return refused(r);
        const approvals = await get(`/api/v1/runs/${id}/approvals`);
        const view = await get(`/api/v1/runs/${id}/view`);
        const summary = (view.json as { summary?: { nodes?: Record<string, unknown> } } | undefined)
          ?.summary;
        return json({
          ...(r.json as object),
          approvals:
            approvals.status === 200
              ? (approvals.json as Record<string, unknown>[]).map((g) => ({
                  node: (g.node as { key: string }).key,
                  title: (g.node as { title: string }).title,
                  status: g.status,
                  ...(g.message ? { message: g.message } : {}),
                  ...(g.decidedBy ? { decidedBy: g.decidedBy, comment: g.comment } : {}),
                  mayDecide: g.mayDecide,
                }))
              : [],
          ...(summary?.nodes ? { steps: summary.nodes } : {}),
        });
      },
      run_output: async ({ run, tail }) => {
        const r = await get(`/api/v1/runs/${encodeURIComponent(String(run))}/output`);
        if (r.status !== 200) return refused(r);
        const keep = Math.min(Number(tail ?? 20_000), MAX_TEXT);
        return {
          text:
            r.text.length > keep
              ? `… (the first ${r.text.length - keep} characters left out)\n${r.text.slice(-keep)}`
              : r.text || '(no output yet)',
        };
      },
      run_stop: async ({ run }) => {
        const r = await api(
          authorization,
          'POST',
          `/api/v1/runs/${encodeURIComponent(String(run))}/cancel`,
        );
        if (r.status !== 202) return refused(r);
        const after = r.json as { state: string; number: number };
        return {
          text:
            after.state === 'cancelled'
              ? `Run ${after.number} is stopped`
              : `Run ${after.number} is asked to stop (it is ${after.state})`,
        };
      },
      run_list: async ({ project, state, limit }) => {
        const query = new URLSearchParams();
        if (project) {
          const id = await projectId(String(project));
          if (!id) return { text: `No project ${project}`, isError: true };
          query.set('project', id);
        }
        if (state) query.set('state', String(state));
        query.set('limit', String(limit ?? 20));
        const r = await get(`/api/v1/runs?${query}`);
        if (r.status !== 200) return refused(r);
        return json(
          (r.json as Record<string, unknown>[]).map((x) => ({
            id: x.id,
            number: x.number,
            flow: (x.flow as { name: string }).name,
            state: x.state,
            mode: x.mode,
            by: (x.requestedBy as { login: string }).login,
            createdAt: x.createdAt,
            ...(x.endedAt ? { endedAt: x.endedAt } : {}),
          })),
        );
      },
      approval_list: async () => {
        const r = await get('/api/v1/approvals');
        if (r.status !== 200) return refused(r);
        return json(
          (r.json as Record<string, unknown>[]).map((a) => {
            const gate = a.gate as {
              node: { key: string; title: string };
              message?: string;
              deadline?: string;
            };
            const run = a.run as { id: string; number: number; flow: { name: string } };
            return {
              run: run.id,
              number: run.number,
              flow: run.flow.name,
              node: gate.node.key,
              title: gate.node.title,
              ...(gate.message ? { message: gate.message } : {}),
              ...(gate.deadline ? { deadline: gate.deadline } : {}),
              launchedBy: a.requestedBy,
              mayDecide: a.mayDecide,
              ...(a.why ? { why: a.why } : {}),
            };
          }),
        );
      },
      approval_decide: async ({ run, node, decision, comment }) => {
        if (!token?.mcpApprovals)
          return {
            text: 'This token may not decide approvals: approvals stay with people. Ask the user to decide it on the Approvals page, or to make a token that allows agents to decide approvals.',
            isError: true,
          };
        const r = await api(
          authorization,
          'POST',
          `/api/v1/runs/${encodeURIComponent(String(run))}/approvals/${encodeURIComponent(String(node))}`,
          { decision, ...(comment ? { comment } : {}) },
        );
        if (r.status !== 200) return refused(r);
        return { text: `The approval is ${decision}; the run goes on` };
      },
    };
    return handlers;
  };

  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user;
    // An agent signs in with an access token; a browser's session is not taken here.
    if (!user?.token)
      return reply.code(401).header('www-authenticate', 'Bearer realm="ansible-flow-server"').send({
        error: 'unauthorized',
        message: 'Sign in with an access token: Authorization: Bearer <token>',
      });
    const access = await Access.of(deps.db, user);
    const io = new ServerFlowIO(deps.db, deps.git, flows, {
      access,
      ...(user.token.workspace ? { workspace: user.token.workspace } : {}),
    });
    const tools = toolsFor(request);
    const flowSpecs = TOOL_SPECS.filter((s) => READ_TOOLS.includes(s.name));

    const server = new Server(
      { name: 'ansible-flow-server', version: meta.version },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    );
    server.setRequestHandler('tools/list', async () => ({
      tools: [
        ...flowSpecs.map((s) => ({
          name: s.name,
          title: s.title,
          description: s.description,
          inputSchema: s.inputSchema as { type: 'object' },
          annotations: { title: s.title, readOnlyHint: true, openWorldHint: false },
        })),
        ...SERVER_TOOLS.filter((t) => t.name !== 'approval_decide' || user.token?.mcpApprovals).map(
          (t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema as { type: 'object' },
            annotations: {
              title: t.title,
              readOnlyHint: t.readOnly,
              destructiveHint: !t.readOnly,
              openWorldHint: !t.readOnly,
            },
          }),
        ),
      ],
    }));
    server.setRequestHandler('tools/call', async (call) => {
      const name = call.params.name;
      const input = (call.params.arguments ?? {}) as Record<string, unknown>;
      let answer: Answer;
      try {
        if (READ_TOOLS.includes(name)) answer = await runTool(io, name, input);
        else if (tools[name]) answer = await tools[name](input);
        else answer = { text: `No tool ${name} on this server`, isError: true };
      } catch (e) {
        answer = { text: `Error: ${(e as Error).message}`, isError: true };
      }
      request.log.info({ tool: name, ok: !answer.isError }, 'MCP tool');
      const text =
        answer.text.length > MAX_TEXT
          ? `${answer.text.slice(0, MAX_TEXT)}\n… (cut at ${MAX_TEXT} characters)`
          : answer.text;
      return {
        content: [{ type: 'text' as const, text }],
        ...(answer.isError ? { isError: true } : {}),
      };
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const headers = new Headers();
    for (const [k, v] of Object.entries(request.headers))
      if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    const url = `http://${request.hostname}${request.url}`;
    const webRequest = new Request(url, {
      method: request.method,
      headers,
      ...(request.method === 'POST' ? { body: JSON.stringify(request.body ?? null) } : {}),
    });
    try {
      const res = await transport.handleRequest(webRequest, {
        ...(request.method === 'POST' ? { parsedBody: request.body } : {}),
      });
      reply.code(res.status);
      res.headers.forEach((value, key) => {
        reply.header(key, value);
      });
      return reply.send(await res.text());
    } finally {
      await server.close().catch(() => undefined);
    }
  };

  app.post('/mcp', handle);
  // Stateless: there is no stream to open (GET) or session to end (DELETE).
  app.get('/mcp', async (_request, reply) =>
    reply
      .code(405)
      .header('allow', 'POST')
      .send({ error: 'method_not_allowed', message: 'This MCP endpoint answers POST only' }),
  );
}
