// Access on the pages. Administrators give and take levels on a workspace's page and see who can
// do what there; everyone's pages show only what their level lets them do (the server decides
// either way).

import { type FormEvent, Fragment, useEffect, useId, useRef, useState } from 'react';
import { LEVEL_NAME, LEVELS } from '../server/access/types';
import { WorkspaceActions } from './actions';
import {
  api,
  type Grant,
  type GrantLevel,
  type Level,
  type MyAccess,
  type ProjectAccess,
  type WhoCan,
} from './api';
import {
  InPlace,
  Loading,
  messageOf,
  RowMenu,
  type RowMenuItem,
  Scroll,
  useLoad,
  useReveal,
} from './ui';

const RANK: Record<Level, number> = { ro: 1, operator: 2, rw: 3 };
/** True when `have` is at least `need`. */
export const atLeast = (have: Level | null | undefined, need: Level) =>
  !!have && RANK[have] >= RANK[need];

/** What the person may do in a project, for the pages to show what applies. */
export function useProjectAccess(projectId: string | undefined) {
  return useLoad(
    async (): Promise<ProjectAccess | undefined> =>
      projectId ? api.projectAccess(projectId) : undefined,
    [projectId],
  );
}

/** AFS-152: one's own access, read where a page says what one may do. */
export const useMyAccess = () => useLoad(api.myAccess, []);

/** AFS-152: whether this access launches anything: operator or more on a workspace or a flow. */
export const launchesAny = (mine: MyAccess | undefined): boolean =>
  !!mine &&
  (mine.admin ||
    mine.workspaces.some(
      (w) => atLeast(w.level, 'operator') || w.flows.some((f) => atLeast(f.level, 'operator')),
    ));

/** AFS-152: whether this access launches any flow of a project. */
export const launchesInProject = (access: ProjectAccess | undefined): boolean =>
  !!access &&
  (access.admin ||
    atLeast(access.workspace, 'operator') ||
    Object.values(access.flows).some((level) => atLeast(level, 'operator')));

/** The level on one flow: its own, else the workspace's. */
export const flowLevel = (access: ProjectAccess | undefined, file: string): Level | null =>
  access?.admin ? 'rw' : (access?.flows[file] ?? access?.workspace ?? null);

export { LEVEL_NAME };

const LEVEL_DOES: Record<GrantLevel, string> = {
  ro: 'sees flows and runs, clones',
  operator: 'launches as configured, stops runs',
  rw: 'any branch, configurations, pushes',
  approve: 'decides approval gates',
};
/**
 * AFS-206: what a level gives on one flow: that flow and its runs, never the repository (a flow
 * grant does not clone, push or read the project's files or history).
 */
const FLOW_DOES: Record<GrantLevel, string> = {
  ro: 'sees the flow and its runs',
  operator: 'launches it as configured, stops its runs',
  rw: 'launches any branch, manages its configurations',
  approve: 'decides its approval gates',
};
const wordsOf = (does: Record<GrantLevel, string>) =>
  Object.fromEntries(
    Object.entries(LEVEL_NAME).map(([level, name]) => [
      level,
      `${name[0]?.toUpperCase()}${name.slice(1)}: ${does[level as GrantLevel]}`,
    ]),
  ) as Record<GrantLevel, string>;
const LEVEL_WORDS = wordsOf(LEVEL_DOES);
const FLOW_LEVEL_WORDS = wordsOf(FLOW_DOES);

/** A flow's file as people read it when its title is not known: its name without folders. */
export const flowName = (file: string) =>
  (file.split('/').at(-1) ?? file).replace(/\.flow\.ya?ml$/, '');

/** AFS-152: a flow of one's own, by its title, with the level its grant gives. */
export interface OwnFlow {
  title: string;
  level: Level | null;
}

/** AFS-152: the parts of one's access in words: the workspace's level, flows of one's own, approving. */
export function accessWords({
  level,
  flows = [],
  approve = false,
  actions = [],
}: {
  level: Level | 'admin' | null;
  flows?: OwnFlow[];
  approve?: boolean;
  /** AFS-206: the titles of the actions an action grant lets them run. */
  actions?: string[];
}): string {
  if (level === 'admin') return 'administrator: everything';
  const parts: string[] = [];
  if (level) parts.push(`${LEVEL_NAME[level]} (${LEVEL_DOES[level]})`);
  const byLevel = new Map<Level | null, string[]>();
  for (const f of flows) byLevel.set(f.level, [...(byLevel.get(f.level) ?? []), f.title]);
  for (const [l, titles] of byLevel)
    parts.push(
      l
        ? `${LEVEL_NAME[l]} on ${titles.join(', ')}${level ? '' : ` (${FLOW_DOES[l]})`}`
        : `none on ${titles.join(', ')}`,
    );
  if (approve) parts.push(`approves (${LEVEL_DOES.approve})`);
  if (actions.length) parts.push(`may run ${actions.join(', ')}`);
  // Seen without a level of one's own: through grants on some of its flows.
  return parts.length ? parts.join('; ') : 'some flows only';
}

/** AFS-135, AFS-152: one's own access, said where it applies (a workspace, a project), in words. */
export function YourAccess({
  level,
  flows,
  approve,
}: {
  level: Level | 'admin' | null | undefined;
  flows?: OwnFlow[];
  approve?: boolean;
}) {
  if (level === undefined) return null;
  return (
    <span className="your-access" data-your-access={level ?? 'none'}>
      Your access:{' '}
      {accessWords({ level, ...(flows ? { flows } : {}), ...(approve ? { approve } : {}) })}
    </span>
  );
}

/**
 * AFS-152: one's own access to a project, on each of its tabs: the workspace's level and the flows
 * whose grant gives another (a person with read only on the workspace and operator on one flow
 * sees both), by their titles.
 */
export function ProjectYourAccess({
  access,
  flows,
}: {
  access: ProjectAccess | undefined;
  /** The project's flows, for their titles. */
  flows: { file: string; name?: string | undefined }[] | undefined;
}) {
  if (!access) return null;
  if (access.admin) return <YourAccess level="admin" />;
  const own = Object.entries(access.flows)
    .filter(([, level]) => level !== access.workspace)
    .map(([file, level]) => ({
      title: flows?.find((f) => f.file === file)?.name ?? flowName(file),
      level,
    }));
  return <YourAccess level={access.workspace} flows={own} approve={access.approve} />;
}

/** AFS-152: the titles of flows in these projects (by `project id/file`), from their flow lists. */
export function useFlowTitles(projectIds: string[]) {
  const ids = [...new Set(projectIds)].sort().join(',');
  return useLoad(async () => {
    const titles = new Map<string, string>();
    await Promise.all(
      (ids ? ids.split(',') : []).map(async (id) => {
        const list = await api.flows(id).catch(() => undefined);
        for (const f of list?.flows ?? []) if (f.name) titles.set(`${id}/${f.file}`, f.name);
      }),
    );
    return titles;
  }, [ids]).data;
}

/** A flow by its title when known, else by its file's name. */
export const flowTitle = (
  titles: Map<string, string> | undefined,
  projectId: string,
  file: string,
) => titles?.get(`${projectId}/${file}`) ?? flowName(file);

/** AFS-152: whose grants gave a person their access, in words (`group:ops` is "group ops"). */
export const throughWords = (through: string) =>
  through.startsWith('group:') ? `group ${through.slice(6)}` : 'their own grant';

const NO_INPUT = { principal: '', level: 'ro' as GrantLevel, project: '', flow: '' };

/** AFS-273: the matrix's columns, as ADR-0039 names them (the levels' words are in their titles). */
const COLUMN: Record<GrantLevel, string> = {
  ro: 'Read',
  operator: 'Operate',
  rw: 'Edit',
  approve: 'Approve',
};

type MarkKind = 'given' | 'group' | 'higher' | 'none';

/** A cell of the matrix: a mark to see, and its words for who does not see it (and on hover). */
function Mark({ kind, words }: { kind: MarkKind; words: string }) {
  return (
    <span className="mark" data-mark={kind} {...(words ? { title: words } : {})}>
      <span className="mark-dot" aria-hidden="true" />
      {words && <span className="sr-only">{words}</span>}
    </span>
  );
}

const NO = (column: string) => ({ kind: 'none' as const, words: `${column}: no` });

/**
 * A level's cell: the level held is given here or through a group (or by being an administrator);
 * a lower one comes with it.
 */
function levelMark(
  l: Level,
  held: Level | undefined,
  source: 'given' | 'group' | undefined,
  groups: string[] = [],
  why?: string,
): { kind: MarkKind; words: string } {
  const column = COLUMN[l];
  if (!held || RANK[held] < RANK[l]) return NO(column);
  if (RANK[held] > RANK[l])
    return { kind: 'higher', words: `${column}: comes with ${COLUMN[held]}` };
  if (why) return { kind: 'given', words: `${column}: ${why}` };
  return source === 'group'
    ? { kind: 'group', words: `${column}: through ${groups.join(', ') || 'a group'}` }
    : { kind: 'given', words: `${column}: given here` };
}

/** Where a person's access comes from, and what else they have: flows of their own, actions. */
function throughOf(w: WhoCan, own: boolean, groups: string[]): string {
  if (w.admin) return 'administrator';
  const parts = [...(own ? ['given here'] : []), ...groups];
  const levels = new Map<string, number>();
  for (const f of w.flows) {
    const words = f.level ? LEVEL_NAME[f.level] : 'none';
    levels.set(words, (levels.get(words) ?? 0) + 1);
  }
  for (const [words, n] of levels) parts.push(`${words} on ${n === 1 ? '1 flow' : `${n} flows`}`);
  // AFS-206, AFS-232: actions run through a grant; operators of the workspace run every one.
  if (w.actions?.length && w.workspace !== 'operator' && w.workspace !== 'rw')
    parts.push(`runs ${w.actions.map((a) => a.title).join(', ')}`);
  return parts.join(' · ') || '–';
}

/** A workspace's grants and who can do what: for administrators. */
export function WorkspaceAccess({
  workspace,
  selfApprove = false,
  operatorsDebug = false,
}: {
  workspace: string;
  selfApprove?: boolean;
  /** AFS-179: operators may start debug runs. */
  operatorsDebug?: boolean;
}) {
  const grants = useLoad(() => api.grants(workspace), [workspace]);
  const [self, setSelf] = useState(selfApprove);
  const [debugging, setDebugging] = useState(operatorsDebug);
  const who = useLoad(() => api.whoCan(workspace), [workspace]);
  const users = useLoad(() => api.users(), []);
  const groups = useLoad(() => api.groups(), []);
  const projects = useLoad(() => api.projects(workspace), [workspace]);
  const [input, setInput] = useState(NO_INPUT);
  const flows = useLoad(
    async () => (input.project ? (await api.flows(input.project)).flows : []),
    [input.project],
  );
  const [error, setError] = useState<string>();
  // AFS-152: what the last Give gave, said under the form (which starts again empty).
  const [given, setGiven] = useState<string>();
  const [busy, setBusy] = useState(false);
  // AFS-152: flows by their titles, projects by their names.
  const titles = useFlowTitles([
    ...(grants.data ?? []).flatMap((g) => (g.flow ? [g.flow.project] : [])),
    ...(who.data ?? []).flatMap((w) => w.flows.map((f) => f.projectId)),
  ]);
  const projectName = (key: string) => projects.data?.find((p) => p.key === key)?.name ?? key;
  const grantWho = (g: Grant) => {
    const person = users.data?.find((u) => u.login === g.principal.name);
    return g.principal.type === 'group'
      ? `group ${g.principal.name}`
      : person && person.name !== person.login
        ? `${person.name} (${person.login})`
        : g.principal.name;
  };
  const grantWhere = (g: Grant) =>
    g.flow
      ? `the flow ${flowTitle(titles, g.flow.project, g.flow.file)} in ${projectName(g.flow.projectKey)}`
      : 'the whole workspace';
  // AFS-194: what a person keeps when one grant of theirs is taken back: their other grants and
  // those of the groups they are in. A group's members keep what their own grants give.
  // AFS-273: an administrator keeps everything; taking back Approve says whether they still
  // approve, not which levels they keep.
  const remains = (g: Grant) => {
    if (g.principal.type === 'group')
      return 'Its members keep what their own grants and other groups give.';
    const row = who.data?.find((w) => w.user.login === g.principal.name);
    if (row?.admin) return 'They are an administrator: they may still do everything here.';
    const groups = (row?.through ?? [])
      .filter((t) => t.startsWith('group:'))
      .map((t) => t.slice(6));
    const others = (grants.data ?? []).filter(
      (o) =>
        o.id !== g.id &&
        (o.principal.type === 'group'
          ? groups.includes(o.principal.name)
          : o.principal.name === g.principal.name),
    );
    const through = (o: Grant) =>
      o.principal.type === 'group' ? ` through group ${o.principal.name}` : '';
    const approving = others.filter((o) => o.level === 'approve');
    const stillApprove = approving.length
      ? `They can still approve on ${approving.map((o) => `${grantWhere(o)}${through(o)}`).join('; ')}.`
      : 'They can no longer approve here.';
    if (g.level === 'approve') return stillApprove;
    const kept = others.filter((o) => o.level !== 'approve');
    if (!kept.length)
      return approving.length
        ? `They keep no level here. ${stillApprove}`
        : 'They keep no access here.';
    return `They keep ${kept
      .map((o) => `${LEVEL_NAME[o.level]} on ${grantWhere(o)}${through(o)}`)
      .join('; ')}.`;
  };
  // AFS-273: what a flow grant replaces: the level its person or group has on the workspace.
  const insteadOf = (g: Grant) => {
    if (g.level === 'approve') {
      const approves =
        g.principal.type === 'user'
          ? who.data?.find((w) => w.user.id === g.principal.id)?.approve
          : whole('group', g.principal.id).some((o) => o.level === 'approve');
      return approves ? `${LEVEL_NAME.approve}, from the workspace` : 'nothing';
    }
    const from =
      g.principal.type === 'user'
        ? who.data?.find((w) => w.user.id === g.principal.id)?.workspace
        : whole('group', g.principal.id).find((o) => o.level !== 'approve')?.level;
    return from ? `${LEVEL_NAME[from]}, from the workspace` : 'nothing';
  };
  const [note, setNote] = useState<string>();
  const [takeError, setTakeError] = useState<string>();
  // AFS-273: the grant a question is asked about in its row, and the level a Change chooses.
  const [asking, setAsking] = useState<{ grant: Grant; what: 'take' | 'change'; row: string }>();
  // Where the focus goes once a question in a row is gone (see `close`).
  const focusAfter = useRef<{ row: string; afterReload: boolean } | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a question gone, or grants read again
  useEffect(() => {
    const want = focusAfter.current;
    if (!want || asking) return;
    if (want.afterReload) {
      want.afterReload = false;
      return;
    }
    focusAfter.current = undefined;
    (
      document.querySelector<HTMLElement>(`[data-row-menu="${want.row}"]`) ??
      document.getElementById(`${id}-matrix`)
    )?.focus();
  }, [asking, grants.data]);
  const [level, setLevel] = useState<Level>('ro');
  // AFS-84: giving access is opened when wanted; who can do what is what the page is read for.
  const [giving, setGiving] = useState(false);
  const id = useId();
  const reload = () => {
    grants.reload();
    who.reload();
  };

  const give = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !input.principal) return;
    setBusy(true);
    setError(undefined);
    setGiven(undefined);
    const [type, principal] = input.principal.split(':') as ['user' | 'group', string];
    try {
      const grant = await api.addGrant(workspace, {
        [type]: principal,
        level: input.level,
        ...(input.project && input.flow ? { project: input.project, flow: input.flow } : {}),
      });
      const flow = flows.data?.find((f) => f.file === input.flow);
      const where = grant.flow
        ? `the flow ${flow?.name ?? flowName(grant.flow.file)} in ${projectName(grant.flow.projectKey)}`
        : 'the whole workspace';
      setGiven(`Gave ${grantWho(grant)} ${LEVEL_NAME[grant.level]} on ${where}.`);
      setInput(NO_INPUT);
      reload();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  // AFS-140: the form opens below the grants: it is brought into view, the cursor on Who.
  const giveSheet = useReveal<HTMLDivElement>(giving);
  // AFS-273 (ADR-0039 §7): who can do what as a matrix, a person's or group's own grants on the
  // whole workspace in their row's menu, grants on single flows in a table of their own.
  const all = grants.data ?? [];
  const whole = (type: 'user' | 'group', id: string) =>
    all.filter((g) => !g.flow && g.principal.type === type && g.principal.id === id);
  const groupRows = [
    ...new Map(
      all
        .filter((g) => !g.flow && g.principal.type === 'group')
        .map((g) => [g.principal.id, g.principal]),
    ).values(),
  ];
  const memberCount = (id: string) => groups.data?.find((g) => g.id === id)?.members.length;
  const flowGrants = all.filter((g) => g.flow);
  const askAbout = (grant: Grant, what: 'take' | 'change', row: string) => {
    setNote(undefined);
    setTakeError(undefined);
    setGiven(undefined);
    setLevel(grant.level === 'approve' ? 'ro' : grant.level);
    setAsking({ grant, what, row });
  };
  const menuOf = (own: Grant[], row: string): RowMenuItem[] =>
    own.flatMap((g) => [
      ...(g.level === 'approve'
        ? []
        : [{ label: 'Change the level…', onSelect: () => askAbout(g, 'change', row) }]),
      { label: `Take back ${LEVEL_NAME[g.level]}…`, onSelect: () => askAbout(g, 'take', row) },
    ]);
  /**
   * The question is gone: the focus goes back to the row's More button, so the keyboard stays
   * where it was. After a take back, once the grants are read again: the row may be gone with
   * its last grant, and then the table's heading has it.
   */
  const close = (afterReload = false) => {
    if (asking) focusAfter.current = { row: asking.row, afterReload };
    setAsking(undefined);
  };
  const answer = async () => {
    if (!asking) return;
    const { grant, what } = asking;
    const person = grantWho(grant);
    const where = grantWhere(grant);
    setBusy(true);
    try {
      if (what === 'take') {
        const left = remains(grant);
        await api.removeGrant(grant.id);
        // AFS-194: a note as Give leaves one.
        setNote(`Took back ${LEVEL_NAME[grant.level]} on ${where} from ${person}. ${left}`);
      } else {
        await api.changeGrant(grant.id, level);
        setNote(`${person} now has ${LEVEL_NAME[level]} on ${where}.`);
      }
      close(what === 'take');
    } catch (e) {
      setTakeError(messageOf(e));
    } finally {
      setBusy(false);
      reload();
    }
  };
  /** The question asked in the row of the grant it is about. */
  const inPlace = (grant: Grant, columns: number) =>
    asking?.grant.id === grant.id ? (
      <tr className="row-in-place">
        <td colSpan={columns}>
          {asking.what === 'take' ? (
            <InPlace
              // A new question in the same row takes the focus again.
              key={asking.what}
              question={`Take back ${LEVEL_NAME[grant.level]} on ${grantWhere(grant)} from ${grantWho(grant)}? It ends at once. ${remains(grant)}`}
              yes="Take back"
              danger
              busy={busy}
              onYes={() => void answer()}
              onNo={() => close()}
            />
          ) : (
            <InPlace
              key={asking.what}
              question={`The level of ${grantWho(grant)} on ${grantWhere(grant)}`}
              yes="Change"
              busy={busy}
              onYes={() => void answer()}
              onNo={() => close()}
            >
              <div className="choices">
                {LEVELS.map((l) => (
                  <label key={l} className="inline">
                    <input
                      type="radio"
                      name={`${id}-change`}
                      checked={level === l}
                      onChange={() => setLevel(l)}
                    />
                    {(grant.flow ? FLOW_LEVEL_WORDS : LEVEL_WORDS)[l]}
                  </label>
                ))}
              </div>
            </InPlace>
          )}
        </td>
      </tr>
    ) : null;

  return (
    <section className="panel" aria-labelledby={`${id}-access`}>
      <h2 id={`${id}-access`} className="sr-only">
        Access
      </h2>
      <div className="ledger">
        <div className="ledger-head">
          <h3 id={`${id}-matrix`} tabIndex={-1}>
            Who can do what{' '}
            {who.data && <span className="ledger-count">{groupRows.length + who.data.length}</span>}
          </h3>
          {!giving && (
            <button
              type="button"
              className="primary"
              onClick={() => {
                setGiven(undefined);
                setNote(undefined);
                setGiving(true);
              }}
            >
              Give access
            </button>
          )}
        </div>
        <ul className="mark-legend" aria-label="What the marks say">
          <li>
            <Mark kind="given" words="" /> given here
          </li>
          <li>
            <Mark kind="group" words="" /> through a group
          </li>
          <li>
            <Mark kind="higher" words="" /> comes with a higher level
          </li>
        </ul>
        <Loading state={who} />
        {grants.data?.length === 0 && who.data?.every((w) => w.admin) && (
          <p className="muted">No grants yet: only administrators see this workspace.</p>
        )}
        {!!who.data?.length && (
          <Scroll>
            <table className="matrix" aria-labelledby={`${id}-matrix`}>
              <thead>
                <tr>
                  <th scope="col">Person or group</th>
                  {(['ro', 'operator', 'rw', 'approve'] as const).map((l) => (
                    <th key={l} scope="col" className="mark-col" title={LEVEL_WORDS[l]}>
                      {COLUMN[l]}
                    </th>
                  ))}
                  <th scope="col">Through</th>
                  <th scope="col" className="act">
                    <span className="sr-only">More</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {groupRows.map((g) => {
                  const own = whole('group', g.id);
                  const lvl = own.find((o) => o.level !== 'approve')?.level as Level | undefined;
                  const count = memberCount(g.id);
                  return (
                    <Fragment key={`group:${g.id}`}>
                      <tr>
                        <td>
                          {g.name}{' '}
                          <span className="muted">
                            group
                            {count === undefined
                              ? ''
                              : ` · ${count === 1 ? '1 person' : `${count} people`}`}
                          </span>
                        </td>
                        {LEVELS.map((l) => (
                          <td key={l} className="mark-col">
                            <Mark {...levelMark(l, lvl, lvl ? 'given' : undefined)} />
                          </td>
                        ))}
                        <td className="mark-col">
                          <Mark
                            {...(own.some((o) => o.level === 'approve')
                              ? { kind: 'given', words: 'Approve: given here' }
                              : NO('Approve'))}
                          />
                        </td>
                        <td className="muted">given here</td>
                        <td className="act">
                          <RowMenu
                            id={`group:${g.id}`}
                            name={`group ${g.name}`}
                            items={menuOf(own, `group:${g.id}`)}
                          />
                        </td>
                      </tr>
                      {own.map((o) => inPlace(o, 7))}
                    </Fragment>
                  );
                })}
                {who.data.map((w) => {
                  const own = whole('user', w.user.id);
                  const ownLevel = own.find((o) => o.level !== 'approve')?.level as
                    | Level
                    | undefined;
                  const viaGroups = w.through
                    .filter((t) => t.startsWith('group:'))
                    .map((t) => t.slice(6));
                  const lvl = w.admin ? 'rw' : (w.workspace ?? undefined);
                  const source = w.admin || ownLevel === lvl ? 'given' : 'group';
                  return (
                    <Fragment key={w.user.id}>
                      <tr>
                        <td>
                          {w.user.name} <span className="muted">{w.user.login}</span>
                          {w.admin && <span className="badge">administrator</span>}
                          {w.disabled && <span className="muted"> · disabled</span>}
                        </td>
                        {LEVELS.map((l) => (
                          <td key={l} className="mark-col">
                            <Mark
                              {...levelMark(
                                l,
                                lvl,
                                source,
                                viaGroups,
                                w.admin ? 'administrator' : undefined,
                              )}
                            />
                          </td>
                        ))}
                        <td className="mark-col">
                          <Mark
                            {...(w.admin
                              ? { kind: 'given', words: 'Approve: administrator' }
                              : !w.approve
                                ? NO('Approve')
                                : own.some((o) => o.level === 'approve')
                                  ? { kind: 'given', words: 'Approve: given here' }
                                  : {
                                      kind: 'group',
                                      words: `Approve: through ${viaGroups.join(', ') || 'a group'}`,
                                    })}
                          />
                        </td>
                        <td className="muted">{throughOf(w, own.length > 0, viaGroups)}</td>
                        <td className="act">
                          <RowMenu
                            id={`user:${w.user.id}`}
                            name={w.user.name}
                            items={menuOf(own, `user:${w.user.id}`)}
                          />
                        </td>
                      </tr>
                      {own.map((o) => inPlace(o, 7))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </Scroll>
        )}
      </div>

      {takeError && (
        <p className="notice error" role="alert">
          {takeError}
        </p>
      )}
      {note && (
        <p className="notice ok" role="status">
          {note}
        </p>
      )}

      {flowGrants.length > 0 && (
        <div className="ledger">
          <div className="ledger-head">
            <h3 id={`${id}-flows`}>
              Exceptions on single flows <span className="ledger-count">{flowGrants.length}</span>
            </h3>
          </div>
          <Scroll>
            <table aria-labelledby={`${id}-flows`}>
              <thead>
                <tr>
                  <th scope="col">Flow</th>
                  <th scope="col">Who</th>
                  <th scope="col">Level</th>
                  <th scope="col">Instead of</th>
                  <th scope="col" className="act">
                    <span className="sr-only">More</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {flowGrants.map((g) => {
                  const flow = g.flow as NonNullable<Grant['flow']>;
                  const whoName = grantWho(g);
                  return (
                    <Fragment key={g.id}>
                      <tr>
                        <td>
                          {flowTitle(titles, flow.project, flow.file)}{' '}
                          <span className="muted">in {projectName(flow.projectKey)}</span>
                        </td>
                        <td>{whoName}</td>
                        <td>
                          <span className="badge">{LEVEL_NAME[g.level]}</span>
                        </td>
                        <td className="muted">{insteadOf(g)}</td>
                        <td className="act">
                          <RowMenu
                            id={`flow:${g.id}`}
                            name={`${whoName} on ${flowTitle(titles, flow.project, flow.file)}`}
                            items={menuOf([g], `flow:${g.id}`)}
                          />
                        </td>
                      </tr>
                      {inPlace(g, 5)}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </Scroll>
        </div>
      )}

      {giving && (
        <div className="sheet" ref={giveSheet}>
          <h3>Give access</h3>
          <form className="form" onSubmit={give}>
            <div className="field">
              <label htmlFor={`${id}-who`}>Who</label>
              <select
                id={`${id}-who`}
                value={input.principal}
                onChange={(e) => {
                  setGiven(undefined);
                  setInput({ ...input, principal: e.target.value });
                }}
                required
              >
                <option value="">(choose a person or a group)</option>
                <optgroup label="People">
                  {users.data
                    ?.filter((u) => !u.admin)
                    .map((u) => (
                      <option key={u.id} value={`user:${u.id}`}>
                        {u.name} ({u.login}){u.service ? ', service account' : ''}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="Groups">
                  {groups.data?.map((g) => (
                    <option key={g.id} value={`group:${g.id}`}>
                      group {g.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>
            <fieldset className="choices">
              <legend>Level</legend>
              {(['ro', 'operator', 'rw', 'approve'] as const).map((level) => (
                <label key={level} className="inline">
                  <input
                    type="radio"
                    name={`${id}-level`}
                    checked={input.level === level}
                    onChange={() => setInput({ ...input, level })}
                  />
                  {/* AFS-206: on one flow, what a flow grant gives (no clone, no files). */}
                  {(input.project ? FLOW_LEVEL_WORDS : LEVEL_WORDS)[level]}
                </label>
              ))}
            </fieldset>
            <div className="pair">
              <div className="field">
                <label htmlFor={`${id}-project`}>On</label>
                <select
                  id={`${id}-project`}
                  value={input.project}
                  onChange={(e) => setInput({ ...input, project: e.target.value, flow: '' })}
                >
                  <option value="">the whole workspace</option>
                  {projects.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      a flow of the project {p.name}
                    </option>
                  ))}
                </select>
              </div>
              {input.project && (
                <div className="field">
                  <label htmlFor={`${id}-flow`}>Flow</label>
                  <select
                    id={`${id}-flow`}
                    value={input.flow}
                    onChange={(e) => setInput({ ...input, flow: e.target.value })}
                    required
                  >
                    <option value="">(choose a flow)</option>
                    {flows.data?.map((f) => (
                      <option key={f.file} value={f.file}>
                        {f.name ? `${f.name} (${f.file})` : f.file}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            {given && (
              <p className="notice ok" role="status">
                {given}
              </p>
            )}
            <div className="actions">
              <button type="submit" className="primary" disabled={busy}>
                {busy ? 'Giving…' : 'Give'}
              </button>
              <button type="button" onClick={() => setGiving(false)} disabled={busy}>
                Close
              </button>
            </div>
          </form>
        </div>
      )}

      <WorkspaceActions workspace={workspace} />

      <h3>Approvals</h3>
      <label className="choice">
        <input
          type="checkbox"
          checked={self}
          onChange={async (e) => {
            const on = e.target.checked;
            setSelf(on);
            await api.setSelfApprove(workspace, on).catch((err) => {
              setSelf(!on);
              setError(messageOf(err));
            });
          }}
        />
        Who launched a run may decide its approvals
      </label>

      <h3>Debugging</h3>
      <label className="choice">
        <input
          type="checkbox"
          checked={debugging}
          data-operators-debug
          onChange={async (e) => {
            const on = e.target.checked;
            setDebugging(on);
            await api.setOperatorsDebug(workspace, on).catch((err) => {
              setDebugging(!on);
              setError(messageOf(err));
            });
          }}
        />
        Operators may debug (inspect host variables at pauses)
      </label>
    </section>
  );
}
