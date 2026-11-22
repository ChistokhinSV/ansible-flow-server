// Access on the pages. Administrators give and take levels on a workspace's page and see who can
// do what there; everyone's pages show only what their level lets them do (the server decides
// either way).
import { type FormEvent, useId, useState } from 'react';
import {
  api,
  type Grant,
  type GrantLevel,
  type Level,
  type MyAccess,
  type ProjectAccess,
} from './api';
import { ask } from './confirm';
import { Loading, messageOf, Scroll, useLoad, useReveal } from './ui';

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

/** AFS-152: a level as people say it, not its code. */
export const LEVEL_NAME: Record<GrantLevel, string> = {
  ro: 'read only',
  operator: 'operator',
  rw: 'read and write',
  approve: 'approver',
};
const LEVEL_DOES: Record<GrantLevel, string> = {
  ro: 'sees flows and runs, clones',
  operator: 'launches as configured, stops runs',
  rw: 'any branch, configurations, pushes',
  approve: 'decides approval gates',
};
const LEVEL_WORDS = Object.fromEntries(
  Object.entries(LEVEL_NAME).map(([level, name]) => [
    level,
    `${name[0]?.toUpperCase()}${name.slice(1)}: ${LEVEL_DOES[level as GrantLevel]}`,
  ]),
) as Record<GrantLevel, string>;

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
}: {
  level: Level | 'admin' | null;
  flows?: OwnFlow[];
  approve?: boolean;
}): string {
  if (level === 'admin') return 'administrator: everything';
  const parts: string[] = [];
  if (level) parts.push(`${LEVEL_NAME[level]} (${LEVEL_DOES[level]})`);
  const byLevel = new Map<Level | null, string[]>();
  for (const f of flows) byLevel.set(f.level, [...(byLevel.get(f.level) ?? []), f.title]);
  for (const [l, titles] of byLevel)
    parts.push(
      l
        ? `${LEVEL_NAME[l]} on ${titles.join(', ')}${level ? '' : ` (${LEVEL_DOES[l]})`}`
        : `none on ${titles.join(', ')}`,
    );
  if (approve) parts.push(`approves (${LEVEL_DOES.approve})`);
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

/** A workspace's grants and who can do what: for administrators. */
export function WorkspaceAccess({
  workspace,
  selfApprove = false,
}: {
  workspace: string;
  selfApprove?: boolean;
}) {
  const grants = useLoad(() => api.grants(workspace), [workspace]);
  const [self, setSelf] = useState(selfApprove);
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
  const remains = (g: Grant) => {
    if (g.principal.type === 'group')
      return 'Its members keep what their own grants and other groups give.';
    const groups = (who.data?.find((w) => w.user.login === g.principal.name)?.through ?? [])
      .filter((t) => t.startsWith('group:'))
      .map((t) => t.slice(6));
    const kept = (grants.data ?? []).filter(
      (o) =>
        o.id !== g.id &&
        (o.principal.type === 'group'
          ? groups.includes(o.principal.name)
          : o.principal.name === g.principal.name),
    );
    if (!kept.length) return 'They keep no access here.';
    return `They keep ${kept
      .map(
        (o) =>
          `${LEVEL_NAME[o.level]} on ${grantWhere(o)}${o.principal.type === 'group' ? ` through group ${o.principal.name}` : ''}`,
      )
      .join('; ')}.`;
  };
  const [taken, setTaken] = useState<string>();
  const [takeError, setTakeError] = useState<string>();
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
  return (
    <section className="panel" aria-labelledby={`${id}-access`}>
      <h2 id={`${id}-access`}>Access</h2>
      <p className="muted">
        Who may do what in this workspace. A grant on one flow replaces the workspace's for that
        flow; of a person's own and their groups' grants, the highest counts. Administrators may do
        everything.
      </p>
      <h3>Who can do what</h3>
      <Loading state={who} />
      {!!who.data?.length && (
        <Scroll>
          <table>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Workspace</th>
                <th scope="col">Flows of their own</th>
                <th scope="col">Approves</th>
                <th scope="col">Through</th>
              </tr>
            </thead>
            <tbody>
              {who.data.map((w) => (
                <tr key={w.user.id}>
                  <td>
                    {w.user.name} <span className="muted">({w.user.login})</span>
                    {w.disabled && <span className="muted"> · disabled</span>}
                  </td>
                  <td>{w.admin ? 'administrator' : w.workspace ? LEVEL_NAME[w.workspace] : ''}</td>
                  <td>
                    {w.flows.map((f) => (
                      <div key={`${f.project}/${f.file}`}>
                        {flowTitle(titles, f.projectId, f.file)}:{' '}
                        {f.level ? LEVEL_NAME[f.level] : 'none'}
                      </div>
                    ))}
                  </td>
                  <td>{w.approve ? 'yes' : ''}</td>
                  <td className="muted">
                    {w.admin ? 'administrator' : w.through.map(throughWords).join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}

      <div className="panel-head">
        <h3>Grants</h3>
        {!giving && (
          <button
            type="button"
            onClick={() => {
              setGiven(undefined);
              setTaken(undefined);
              setGiving(true);
            }}
          >
            Give access
          </button>
        )}
      </div>
      <Loading state={grants} />
      {grants.data?.length === 0 && (
        <p className="muted">No grants yet: only administrators see this workspace.</p>
      )}
      {!!grants.data?.length && (
        <Scroll>
          <table>
            <thead>
              <tr>
                <th scope="col">Who</th>
                <th scope="col">Level</th>
                <th scope="col">On</th>
                {/* AFS-169: the button column at the row's end, as wide as its button: a longer
                    grant added does not move it. */}
                <th scope="col" className="act">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {grants.data.map((g) => {
                // AFS-135, AFS-152: people by their names (login after), flows by title with their
                // project's name.
                const who = grantWho(g);
                const where = grantWhere(g);
                return (
                  <tr key={g.id}>
                    <td>{who}</td>
                    <td>
                      <span className="badge">{LEVEL_NAME[g.level]}</span>
                    </td>
                    <td>
                      {g.flow ? (
                        <>
                          {flowTitle(titles, g.flow.project, g.flow.file)}{' '}
                          <span className="muted">in {projectName(g.flow.projectKey)}</span>
                        </>
                      ) : (
                        'the whole workspace'
                      )}
                    </td>
                    <td className="act">
                      <button
                        type="button"
                        className="danger"
                        aria-label={`Take back ${LEVEL_NAME[g.level]} from ${who}`}
                        onClick={async () => {
                          const left = remains(g);
                          if (
                            !(await ask(
                              `Take back ${LEVEL_NAME[g.level]} on ${where} from ${who}? It ends at once. ${left}`,
                              { yes: 'Take back', danger: true },
                            ))
                          )
                            return;
                          setTaken(undefined);
                          setTakeError(undefined);
                          setGiven(undefined);
                          try {
                            await api.removeGrant(g.id);
                            // AFS-194: a note as Give leaves one.
                            setTaken(
                              `Took back ${LEVEL_NAME[g.level]} on ${where} from ${who}. ${left}`,
                            );
                          } catch (e) {
                            setTakeError(messageOf(e));
                          }
                          reload();
                        }}
                      >
                        Take back
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Scroll>
      )}

      {takeError && (
        <p className="notice error" role="alert">
          {takeError}
        </p>
      )}
      {taken && (
        <p className="notice ok" role="status">
          {taken}
        </p>
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
                  {LEVEL_WORDS[level]}
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
        Who launched a run may decide its approvals (off: someone else decides)
      </label>
    </section>
  );
}
