// AFS-183: where a value comes from, on the pages' canvas (designer AFD-342). The page reads the
// repository's variables at the commit it shows (POST /api/v1/projects/:id/vars, vars.ts on the
// server) for the steps of the flow, and hands them to the designer (`varIndex`): tooltips and
// Details then say where the repository sets a name, with its file and line. The snapshot's
// findings get the repository's part too (a name the repository sets is not unknown; an input
// default that hides the inventory's value). A definition's file:line opens the Files tab at that
// line, in a new tab. Someone who may not read the project's files gets no index: the canvas then
// answers from the flow alone, as before.
import { modelOf } from '@ansible-flow/core/flow/model';
import { withRepoFindings } from '@ansible-flow/core/flow/origin';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import { indexInputs, type VarIndex } from '@ansible-flow/core/inventory/varIndex';
import type { HostMessage, Snapshot } from '@ansible-flow/core/protocol';

/** A launch configuration as far as the inventory of its runs goes. */
export interface ConfigInventory {
  flowFile: string;
  inventory?: string | null;
}

/**
 * The inventory the runs of the flow at `path` use, as its launch configurations name it: theirs
 * when they all name the same one; otherwise (none, or several that differ) what the
 * repository's ansible.cfg names, as a run without one gets.
 */
export function flowInventory(configs: readonly ConfigInventory[], path: string): string {
  const named = new Set(configs.filter((c) => c.flowFile === path).map((c) => c.inventory ?? ''));
  return named.size === 1 ? ([...named][0] as string) : '';
}

/** What the index is read for: the commit, the inventory, the flow's roles and files. */
export interface VarsAsk {
  commit: string;
  inventory: string;
  roles: string[];
  files: string[];
}

/** Reads an index; undefined when it cannot be had (no access, no such commit). */
export type VarsReader = (project: string, ask: VarsAsk) => Promise<VarIndex | undefined>;

/** The server's route; a refusal is no index, never an error on the page. */
export const readVars: VarsReader = async (project, ask) => {
  const reply = await fetch(`/api/v1/projects/${encodeURIComponent(project)}/vars`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commit: ask.commit,
      ...(ask.inventory ? { inventory: ask.inventory } : {}),
      roles: ask.roles,
      files: ask.files,
    }),
  }).catch(() => undefined);
  if (!reply?.ok) return undefined;
  const data = (await reply.json().catch(() => undefined)) as { index?: VarIndex } | undefined;
  return data?.index;
};

/** The repository's variables for one canvas: kept in step with the flow and the commit shown. */
export interface RepoVars {
  /** A snapshot on its way to the designer, with the repository's findings once the index is in. */
  snapshot(snapshot: Snapshot): Snapshot;
  /** The canvas shows the flow at another commit now (the branch moved). */
  at(commit: string): void;
}

export function repoVars(options: {
  project: string;
  commit: string;
  /** The inventory the flow's runs use (empty: ansible.cfg's); asked once, when first needed. */
  inventory: () => Promise<string>;
  send: (message: HostMessage) => void;
  read?: VarsReader;
}): RepoVars {
  const read = options.read ?? readVars;
  let commit = options.commit;
  let inventory: Promise<string> | undefined;
  let last: Snapshot | undefined;
  let index: VarIndex | undefined;
  /** What the index in hand (or on its way) is of. */
  let asked = '';

  const merged = (s: Snapshot): Snapshot =>
    index && s.doc
      ? {
          ...s,
          findings: withRepoFindings(
            s.findings,
            modelOf(s.doc as FlowDocument),
            index,
          ) as Snapshot['findings'],
        }
      : s;

  const load = (doc: FlowDocument) => {
    const inputs = indexInputs(doc.nodes);
    const key = JSON.stringify([commit, inputs.roles, inputs.files]);
    if (key === asked) return;
    asked = key;
    const at = commit;
    inventory ??= options.inventory().catch(() => '');
    void inventory
      .then((inv) => read(options.project, { commit: at, inventory: inv, ...inputs }))
      .catch(() => undefined)
      .then((got) => {
        // A newer ask went out meanwhile: its answer is the one that counts.
        if (key !== asked) return;
        index = got;
        options.send({ type: 'varIndex', index: got ?? null, openFiles: !!got });
        if (got && last) options.send({ type: 'snapshot', snapshot: merged(last) });
      });
  };

  return {
    snapshot(snapshot) {
      last = snapshot;
      if (snapshot.doc) load(snapshot.doc as FlowDocument);
      return merged(snapshot);
    },
    at(next) {
      if (next === commit) return;
      commit = next;
      if (last?.doc) load(last.doc as FlowDocument);
    },
  };
}

/**
 * The Files tab of a project at a file and line: `/w/<workspace>/<project>/files?path=…&line=…`.
 * The keys are read once, when the canvas starts, so a click opens it at once (a new tab opened
 * after a wait is blocked as a pop-up).
 */
export function filesAddress(
  keys: { workspace: string; project: string },
  path: string,
  line?: number,
): string {
  const q = new URLSearchParams({ path });
  if (line && line > 0) q.set('line', String(Math.floor(line)));
  return `/w/${encodeURIComponent(keys.workspace)}/${encodeURIComponent(keys.project)}/files?${q}`;
}

/** The workspace and project keys of a project, for its pages' addresses; undefined if unread. */
export async function projectKeys(
  project: string,
): Promise<{ workspace: string; project: string } | undefined> {
  const read = async (url: string) => {
    const reply = await fetch(url, { credentials: 'same-origin' }).catch(() => undefined);
    return reply?.ok ? ((await reply.json()) as { key?: string; workspace?: string }) : undefined;
  };
  const p = await read(`/api/v1/projects/${encodeURIComponent(project)}`);
  const w = p?.workspace
    ? await read(`/api/v1/workspaces/${encodeURIComponent(p.workspace)}`)
    : undefined;
  return p?.key && w?.key ? { workspace: w.key, project: p.key } : undefined;
}

/**
 * A definition's file:line, asked by the canvas (`openCode`): the Files tab at that line, in a
 * new tab, so the canvas stays. Without the keys yet, the window around the frame goes there.
 */
export function openCodeIn(
  keys: { workspace: string; project: string } | undefined,
  path: string,
  line: number | undefined,
  fallback: (path: string, line?: number) => void,
): void {
  if (keys) window.open(filesAddress(keys, path, line), '_blank', 'noopener');
  else fallback(path, line);
}
