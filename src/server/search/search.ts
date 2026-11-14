// Search as you type (AFS-69): one question, a short ranked list of what it names, each with the
// page it opens. Only what the person may see: the same access checks the lists use (AFS-27);
// people and groups for administrators only. Settings pages are found by the pages themselves.
//   Workspaces and projects: by key and name.
//   Flows: by name, key and file, at each visible project's commit (the cached flow list).
//   Launch configurations: by name and flow file.
//   Runs: by number (`12`, `#12`, `run 12`), and the newest runs by flow and configuration name.
//   Execution environments: by name.
//   People (login, name, email) and groups (name).
import type { Kysely } from 'kysely';
import type { Access } from '../access/grants';
import { listGroups, listUsers } from '../auth/users';
import type { Schema } from '../db/schema';
import type { ProjectFlows } from '../projects/flows';
import { listProjects, listWorkspaces } from '../projects/store';
import type { SearchHit, SearchKind } from './types';

export type { SearchHit, SearchKind } from './types';

type Db = Kysely<Schema>;
/** At most this many of one kind, and in all. */
const PER_KIND = 8;
const IN_ALL = 30;
/** Projects whose flows are read for one question (their lists are kept per commit). */
const FLOW_PROJECTS = 50;
/** The newest runs looked through by name. */
const RECENT_RUNS = 500;

const enc = encodeURIComponent;
const flowAddress = (ws: string, project: string, file: string) =>
  `/w/${enc(ws)}/${enc(project)}/flow/${file.split('/').map(enc).join('/')}`;

/** The words of a question, lower case. */
export const words = (q: string) =>
  q
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^#/, ''))
    .filter(Boolean);

/**
 * How well texts match the words: 0 when one word is in none of them; more for a whole text
 * equal to the question, a text starting with it, a word at the start of a text.
 */
export function score(question: string, texts: (string | undefined)[]): number {
  const ws = words(question);
  const hay = texts.filter((t): t is string => !!t).map((t) => t.toLowerCase());
  if (!ws.length || !hay.length) return 0;
  if (!ws.every((w) => hay.some((h) => h.includes(w)))) return 0;
  const whole = ws.join(' ');
  let best = 1;
  for (const h of hay) {
    if (h === whole) best = Math.max(best, 100);
    else if (h.startsWith(whole)) best = Math.max(best, 60);
    else if (ws.every((w) => h.split(/[\s/._-]+/).some((part) => part.startsWith(w))))
      best = Math.max(best, 30);
    else if (h.includes(whole)) best = Math.max(best, 10);
  }
  return best;
}

/** Ties go to kinds people look for most. */
const ORDER: Record<SearchKind, number> = {
  flow: 0,
  project: 1,
  'launch-config': 2,
  run: 3,
  workspace: 4,
  environment: 5,
  user: 6,
  group: 7,
};

export interface SearchDeps {
  db: Db;
  flows: ProjectFlows;
}

export async function search(
  deps: SearchDeps,
  access: Access,
  admin: boolean,
  question: string,
  /** A token made for one workspace: only that workspace. */
  onlyWorkspace?: string,
): Promise<SearchHit[]> {
  const { db } = deps;
  const q = question.trim();
  if (q.length < 2) return [];
  const hits: (SearchHit & { score: number })[] = [];
  const add = (hit: SearchHit, s: number) => {
    if (s > 0) hits.push({ ...hit, score: s });
  };

  const workspaces = (await listWorkspaces(db)).filter(
    (w) => access.sees(w.id) && (!onlyWorkspace || w.id === onlyWorkspace),
  );
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  for (const w of workspaces)
    add(
      { kind: 'workspace', title: w.name, detail: w.key, to: `/w/${enc(w.key)}` },
      score(q, [w.name, w.key]),
    );

  const projects = (await listProjects(db)).filter(
    (p) => wsById.has(p.workspace) && access.sees(p.workspace, p.id),
  );
  const projectById = new Map(projects.map((p) => [p.id, p]));
  for (const p of projects) {
    const ws = wsById.get(p.workspace);
    if (!ws) continue;
    add(
      {
        kind: 'project',
        title: p.name,
        detail: `${ws.key}/${p.key}`,
        to: `/w/${enc(ws.key)}/${enc(p.key)}`,
      },
      score(q, [p.name, p.key]),
    );
  }

  // Flows: the lists are kept per commit, so a second question costs nothing.
  for (const p of projects.slice(0, FLOW_PROJECTS)) {
    const ws = wsById.get(p.workspace);
    if (!ws || !p.commit) continue;
    const list = await deps.flows.list(p.id, p.commit).catch(() => ({ flows: [] }));
    for (const f of list.flows) {
      if (!access.onFlow(p.workspace, p.id, f.file)) continue;
      add(
        {
          kind: 'flow',
          title: f.name ?? f.file,
          detail: `${ws.key}/${p.key} · ${f.file}`,
          to: flowAddress(ws.key, p.key, f.file),
        },
        score(q, [f.name, f.key, f.file]),
      );
    }
  }

  const configs = await db
    .selectFrom('launch_config')
    .select(['id', 'project_id', 'name', 'flow_file'])
    .execute();
  for (const c of configs) {
    const p = projectById.get(c.project_id);
    const ws = p && wsById.get(p.workspace);
    if (!p || !ws || !access.onFlow(p.workspace, p.id, c.flow_file)) continue;
    add(
      {
        kind: 'launch-config',
        title: c.name,
        detail: `${ws.key}/${p.key} · ${c.flow_file}`,
        to: `/w/${enc(ws.key)}/${enc(p.key)}/launch/${enc(c.id)}`,
      },
      score(q, [c.name, c.flow_file]),
    );
  }

  // Runs: a number finds every run with it; words find the newest runs by flow or configuration.
  const number = /^(?:run\s+)?#?(\d{1,9})$/i.exec(q)?.[1];
  const runs = await (number
    ? db
        .selectFrom('run')
        .select([
          'id',
          'number',
          'project_id',
          'flow_file',
          'flow_name',
          'config_name',
          'state',
          'created_at',
        ])
        .where('number', '=', Number(number))
        .execute()
    : db
        .selectFrom('run')
        .select([
          'id',
          'number',
          'project_id',
          'flow_file',
          'flow_name',
          'config_name',
          'state',
          'created_at',
        ])
        .orderBy('created_at', 'desc')
        .limit(RECENT_RUNS)
        .execute());
  for (const r of runs) {
    const p = projectById.get(r.project_id);
    const ws = p && wsById.get(p.workspace);
    if (!p || !ws || !access.onFlow(p.workspace, p.id, r.flow_file)) continue;
    const s = number ? 90 : score(q, [r.flow_name, r.config_name ?? undefined]);
    add(
      {
        kind: 'run',
        title: `Run ${r.number} · ${r.flow_name}`,
        detail: `${ws.key}/${p.key} · ${r.state} · ${r.created_at.slice(0, 16).replace('T', ' ')}`,
        to: `/runs/${enc(r.id)}`,
      },
      // Among runs that match, the newest first.
      s,
    );
  }

  const environments = await db
    .selectFrom('environment')
    .select(['id', 'workspace_id', 'name', 'kind'])
    .execute();
  for (const e of environments) {
    const ws = wsById.get(e.workspace_id);
    if (!ws || !access.onWorkspace(e.workspace_id)) continue;
    add(
      {
        kind: 'environment',
        title: e.name,
        detail: `${ws.key} · execution environment`,
        to: `/w/${enc(ws.key)}/environments/${enc(e.id)}`,
      },
      score(q, [e.name]),
    );
  }

  if (admin) {
    for (const u of await listUsers(db))
      add(
        {
          kind: 'user',
          title: u.name || u.login,
          detail: `${u.login}${u.service ? ' · service account' : u.admin ? ' · administrator' : ''}${u.disabled ? ' · disabled' : ''}`,
          to: `/admin/people/${enc(u.id)}`,
        },
        score(q, [u.login, u.name, u.email]),
      );
    for (const g of await listGroups(db))
      add(
        {
          kind: 'group',
          title: g.name,
          detail: `group · ${g.members.length} members`,
          to: `/admin/groups/${enc(g.id)}`,
        },
        score(q, [g.name]),
      );
  }

  // Best first; at most PER_KIND of a kind, IN_ALL in all.
  hits.sort((a, b) => b.score - a.score || ORDER[a.kind] - ORDER[b.kind]);
  const perKind = new Map<SearchKind, number>();
  const out: SearchHit[] = [];
  for (const { score: _s, ...hit } of hits) {
    const n = perKind.get(hit.kind) ?? 0;
    if (n >= PER_KIND) continue;
    perKind.set(hit.kind, n + 1);
    out.push(hit);
    if (out.length >= IN_ALL) break;
  }
  return out;
}
