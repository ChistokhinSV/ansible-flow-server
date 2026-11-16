// The lab suite (AFS-38): the server in docker compose (test/e2e/stack) runs flows against real
// hosts of the GNS3 lab (web-01, web-02, db-01, db-02; ghost-01 has no machine behind it).
// Skipped unless AFS_E2E=1; see test/e2e/README.md for the lab and the settings.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fetch as undiciFetch } from 'undici';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Api, insecure, type Json, until } from './lib/api';
import { base, catcher, freshWorld, mailpit, signIn, type World } from './lib/world';

const on = process.env.AFS_E2E === '1';
// Building an execution environment downloads Python packages and collections: minutes.
const buildEe = process.env.AFS_E2E_EE !== '0';
const here = dirname(fileURLToPath(import.meta.url));

/** Node ids of a flow of test/e2e/repo by their keys (the run view names nodes by id). */
function nodeIds(flow: string): (key: string) => string {
  const text = readFileSync(resolve(here, 'repo/flows', flow), 'utf8');
  const ids: Record<string, string> = {};
  for (const [, nodeId, key] of text.matchAll(/^\s*- id: (\S+)\n\s+key: (\S+)$/gm))
    if (nodeId && key) ids[key] = nodeId;
  return (key) => {
    const nodeId = ids[key];
    if (!nodeId) throw new Error(`No node ${key} in ${flow}`);
    return nodeId;
  };
}

const ENDED = ['succeeded', 'failed', 'cancelled', 'lost'];
async function ended(api: Api, id: string, limitMs = 420_000) {
  return until(
    `run ${id} to end`,
    async () => {
      const run = await api.get(`/api/v1/runs/${id}`);
      return ENDED.includes(run.state) && run;
    },
    limitMs,
  );
}

async function mails(to: string): Promise<{ Subject: string; Snippet: string }[]> {
  const res = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
  return ((await res.json()) as { messages: { Subject: string; Snippet: string }[] }).messages;
}

async function hooks(): Promise<{ path: string; headers: Record<string, string>; body: Json }[]> {
  return (await fetch(`${catcher}/received`)).json() as never;
}

describe.skipIf(!on)('the lab', () => {
  let world: World;
  let admin: Api;
  let olga: Api;
  let andre: Api;
  let nina: Api;
  beforeAll(async () => {
    world = await freshWorld();
    admin = await signIn(world, 'admin');
    olga = await signIn(world, 'olga');
    andre = await signIn(world, 'andre');
    nina = await signIn(world, 'nina');
  }, 900_000);

  it('routes each host its own way: web hosts, the others, and the one it cannot reach', async () => {
    const id = nodeIds('lab-routing.flow.yaml');
    const launched = await olga.post(`/api/v1/launch-configs/${world.configs.routing}/launch`, {});
    const run = await ended(olga, launched.id);
    // A host that is not reached ends at a failed end, so the run fails, and only for it.
    expect(run.state).toBe('failed');
    expect(run.error).toMatch(/1 host\(s\) failed/);
    const { summary } = await olga.get(`/api/v1/runs/${launched.id}/view`);
    expect(summary.hosts.sort()).toEqual(['db-01', 'db-02', 'ghost-01', 'web-01', 'web-02']);
    expect(summary.nodes[id('reach')].unreachable).toEqual(['ghost-01']);
    expect(summary.nodes[id('reach')].ok_hosts.sort()).toEqual([
      'db-01',
      'db-02',
      'web-01',
      'web-02',
    ]);
    expect(summary.nodes[id('is-web')].ok_hosts.sort()).toEqual(['web-01', 'web-02']);
    expect(summary.nodes[id('is-web')].failed_hosts.sort()).toEqual(['db-01', 'db-02']);
    expect(summary.nodes[id('mark-web')].ok_hosts.sort()).toEqual(['web-01', 'web-02']);
    expect(summary.nodes[id('mark-other')].ok_hosts.sort()).toEqual(['db-01', 'db-02']);
    expect(summary.outcome['ghost-01']).toMatch(/not-reached/);
    expect(summary.problems[id('reach')]['ghost-01'].status).toBe('unreachable');
    // Each host's own output.
    const host = await olga.get(`/api/v1/runs/${launched.id}/hosts/${id('mark-web')}/web-01`);
    expect(JSON.stringify(host.entries)).toMatch(/changed|ok/);
    // The launch configuration tells olga when a run ends, by email.
    const told = await until('the run-ended email', async () =>
      (await mails('olga@example.net')).find((m) => m.Subject.includes(`run ${run.number}`)),
    );
    expect(told.Subject).toMatch(/^Run failed: Lab: route hosts by role/);
  });

  it('waits for the change board: who may decide, the webhook, the decision and the audit', async () => {
    const id = nodeIds('lab-approval.flow.yaml');
    await fetch(`${catcher}/received`, { method: 'DELETE' });
    const launched = await olga.post(`/api/v1/launch-configs/${world.configs.approval}/launch`, {});
    await until(
      'the run to wait at its approval',
      async () => (await olga.get(`/api/v1/runs/${launched.id}`)).state === 'waiting',
      300_000,
    );

    // The change board is told on its webhook, with a link to the run.
    const waiting = await until('the approval webhook', async () =>
      (await hooks()).find((h) => h.body?.event === 'approval.waiting'),
    );
    expect(waiting.path).toBe('/change-board');
    expect(waiting.headers['x-afs-event']).toBe('approval.waiting');
    expect(waiting.body.run.id).toBe(launched.id);
    expect(waiting.body.approval.approvers).toEqual(['change-board']);

    // Only the change board decides: not who only reads, not who launched.
    const forAndre = await andre.get('/api/v1/approvals');
    expect(forAndre.find((a: Json) => a.run.id === launched.id)?.mayDecide).toBe(true);
    const forOlga = await olga.get('/api/v1/approvals');
    expect(forOlga.find((a: Json) => a.run.id === launched.id)?.mayDecide).toBe(false);
    const decide = (api: Api, decision: string, comment?: string) =>
      api.call('POST', `/api/v1/runs/${launched.id}/approvals/approve`, { decision, comment });
    expect((await decide(nina, 'approved')).status).toBe(403);
    expect((await decide(olga, 'approved')).status).toBe(403);
    const decided = await decide(andre, 'approved', 'Change ticket CHG-1042 checked');
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ status: 'approved', decidedBy: 'andre' });
    expect((await decide(andre, 'rejected')).status).toBe(409);

    const run = await ended(olga, launched.id);
    expect(run.state).toBe('succeeded');
    const { summary } = await olga.get(`/api/v1/runs/${launched.id}/view`);
    expect(summary.nodes[id('change')].ok_hosts.sort()).toEqual(['web-01', 'web-02']);

    // Who decided, in the audit; the refused attempts too.
    const audit = await admin.get('/api/v1/audit?action=approval.decide&limit=20');
    const mine = audit.entries.filter((e: Json) => JSON.stringify(e).includes(launched.id));
    expect(mine.find((e: Json) => e.result === 'ok')?.actor.login).toBe('andre');
    expect(
      mine
        .filter((e: Json) => e.result === 'refused')
        .map((e: Json) => e.actor.login)
        .sort(),
    ).toEqual(['nina', 'olga']);
  });

  it('a rejection sends the hosts to the rejected end', async () => {
    const id = nodeIds('lab-approval.flow.yaml');
    const launched = await olga.post(`/api/v1/launch-configs/${world.configs.approval}/launch`, {});
    await until(
      'the run to wait',
      async () => (await olga.get(`/api/v1/runs/${launched.id}`)).state === 'waiting',
      300_000,
    );
    await andre.post(`/api/v1/runs/${launched.id}/approvals/approve`, { decision: 'rejected' });
    const run = await ended(olga, launched.id);
    expect(run.state).toBe('failed');
    const { summary } = await olga.get(`/api/v1/runs/${launched.id}/view`);
    expect(summary.nodes[id('change')]).toBeUndefined();
    expect(summary.outcome['web-01']).toMatch(/rejected/);
  });

  it('a schedule launches the configuration by itself', async () => {
    const at = new Date(Date.now() + 40_000).toISOString();
    const schedule = await admin.post(`/api/v1/launch-configs/${world.configs.quick}/schedules`, {
      name: 'In a moment',
      kind: 'once',
      onceAt: at,
    });
    // The scheduler looks every 30 s.
    const fired = await until(
      'the schedule to fire',
      async () => {
        const list = await admin.get(`/api/v1/launch-configs/${world.configs.quick}/schedules`);
        return list.find((s: Json) => s.id === schedule.id)?.last?.run;
      },
      150_000,
    );
    const run = await ended(admin, fired);
    expect(run.schedule).toBeTruthy();
    expect(run.state).toBe('succeeded');
  });

  it('an agent launches and follows a run over MCP with a token', async () => {
    const token = await olga.post('/api/v1/tokens', { name: 'e2e agent', expiresInDays: 1 });
    const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token.token}` } },
        fetch: ((url: string, init: object) =>
          undiciFetch(url, { ...init, dispatcher: insecure } as never)) as never,
      }),
    );
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('run_launch');
      // Approvals over MCP need a token that allows them.
      expect(tools).not.toContain('approval_decide');
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as {
          content: { text: string }[];
          isError?: boolean;
        };
        const text = r.content.map((c) => c.text).join('\n');
        if (r.isError) throw new Error(`${name}: ${text}`);
        return JSON.parse(text);
      };
      const launched = await call('run_launch', { config: world.configs.quick });
      expect(launched).toMatchObject({ state: 'queued', flow: 'Lab: route hosts by role' });
      const status = await until(
        'the run to end, read over MCP',
        async () => {
          const s = await call('run_status', { run: launched.run });
          return ENDED.includes(s.state) && s;
        },
        420_000,
      );
      expect(status.state).toBe('succeeded');
      expect(status.requestedBy.login).toBe('olga');
      const audit = await admin.get('/api/v1/audit?action=run.launch&source=mcp&limit=5');
      expect(audit.entries[0].actor.login).toBe('olga');
    } finally {
      await client.close();
    }
  });

  it.skipIf(!buildEe)('builds an execution environment and runs a flow in it', async () => {
    const env = await admin.post(`/api/v1/workspaces/${world.workspace}/environments`, {
      name: 'lab-posix',
      kind: 'spec',
      spec: { collections: [{ name: 'ansible.posix', version: 'latest' }], python: [], system: [] },
    });
    const build = await admin.post(`/api/v1/environments/${env.id}/builds`);
    const done = await until(
      'the build',
      async () => {
        const builds = await admin.get(`/api/v1/environments/${env.id}/builds`);
        const b = builds.find((x: Json) => x.id === build.id);
        return ['done', 'failed'].includes(b.state) && b;
      },
      1_200_000,
      5_000,
    );
    if (done.state !== 'done')
      throw new Error(
        `The build failed: ${done.error}\n${await admin.ok('GET', `/api/v1/environments/${env.id}/builds/${build.id}/log`)}`,
      );
    await admin.patch(`/api/v1/launch-configs/${world.configs.quick}`, { environment: env.id });
    try {
      const launched = await olga.post(`/api/v1/launch-configs/${world.configs.quick}/launch`, {});
      const run = await ended(olga, launched.id);
      expect(run.eeImage).toBe(done.image);
      expect(run.state).toBe('succeeded');
    } finally {
      await admin.patch(`/api/v1/launch-configs/${world.configs.quick}`, { environment: null });
    }
  });
});
