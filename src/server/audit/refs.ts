// AFS-106: what the ids of a page of the audit log name now: workspaces, projects, launch
// configurations and runs that still exist, with their names and the page that shows them. An
// entry keeps the name it had when it was written; this adds the link, and a name where the entry
// has only an id (a launch configuration or project in its detail).
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import type { AuditEntry } from './store';

export interface AuditRef {
  type: 'workspace' | 'project' | 'launch-config' | 'run';
  name: string;
  /** The page of the pages that shows it. */
  path: string;
}

/** The detail keys whose values are ids of these kinds. */
const DETAIL_KEYS: Record<string, AuditRef['type']> = {
  workspace: 'workspace',
  project: 'project',
  'launch-config': 'launch-config',
  run: 'run',
};
const KINDS = new Set<string>(Object.values(DETAIL_KEYS));
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const seg = (s: string) => encodeURIComponent(s);

export async function auditRefs(
  db: Kysely<Schema>,
  entries: AuditEntry[],
): Promise<Record<string, AuditRef>> {
  const wanted: Record<AuditRef['type'], Set<string>> = {
    workspace: new Set(),
    project: new Set(),
    'launch-config': new Set(),
    run: new Set(),
  };
  for (const e of entries) {
    if (e.object.id && KINDS.has(e.object.type) && ID.test(e.object.id))
      wanted[e.object.type as AuditRef['type']].add(e.object.id);
    for (const [key, value] of Object.entries(e.detail ?? {})) {
      const type = DETAIL_KEYS[key];
      if (type && typeof value === 'string' && ID.test(value)) wanted[type].add(value);
    }
  }
  const refs: Record<string, AuditRef> = {};
  const ids = (type: AuditRef['type']) => [...wanted[type]];
  if (wanted.workspace.size > 0)
    for (const w of await db
      .selectFrom('workspace')
      .select(['id', 'key'])
      .where('id', 'in', ids('workspace'))
      .execute())
      refs[w.id] = { type: 'workspace', name: w.key, path: `/w/${seg(w.key)}` };
  if (wanted.project.size > 0)
    for (const p of await db
      .selectFrom('project')
      .innerJoin('workspace', 'workspace.id', 'project.workspace_id')
      .select(['project.id as id', 'project.key as key', 'workspace.key as ws'])
      .where('project.id', 'in', ids('project'))
      .execute())
      refs[p.id] = {
        type: 'project',
        name: `${p.ws}/${p.key}`,
        path: `/w/${seg(p.ws)}/${seg(p.key)}`,
      };
  if (wanted['launch-config'].size > 0)
    for (const c of await db
      .selectFrom('launch_config')
      .innerJoin('project', 'project.id', 'launch_config.project_id')
      .innerJoin('workspace', 'workspace.id', 'project.workspace_id')
      .select([
        'launch_config.id as id',
        'launch_config.name as name',
        'project.key as project',
        'workspace.key as ws',
      ])
      .where('launch_config.id', 'in', ids('launch-config'))
      .execute())
      refs[c.id] = {
        type: 'launch-config',
        name: c.name,
        path: `/w/${seg(c.ws)}/${seg(c.project)}/launch/${seg(c.id)}`,
      };
  if (wanted.run.size > 0)
    for (const r of await db
      .selectFrom('run')
      .select(['id', 'number', 'flow_name'])
      .where('id', 'in', ids('run'))
      .execute())
      refs[r.id] = { type: 'run', name: `${r.flow_name} #${r.number}`, path: `/runs/${seg(r.id)}` };
  return refs;
}
