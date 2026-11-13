// Access on the pages. Administrators give and take levels on a workspace's page and see who can
// do what there; everyone's pages show only what their level lets them do (the server decides
// either way).
import { type FormEvent, useId, useState } from 'react';
import { api, type GrantLevel, type Level, type ProjectAccess } from './api';
import { Loading, messageOf, useLoad } from './ui';

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

/** The level on one flow: its own, else the workspace's. */
export const flowLevel = (access: ProjectAccess | undefined, file: string): Level | null =>
  access?.admin ? 'rw' : (access?.flows[file] ?? access?.workspace ?? null);

const LEVEL_WORDS: Record<GrantLevel, string> = {
  ro: 'ro: sees flows and runs, clones',
  operator: 'operator: launches as configured, stops',
  rw: 'rw: any branch, configurations, pushes',
  approve: 'approve: decides approval gates',
};

/** A workspace's grants and who can do what: for administrators. */
export function WorkspaceAccess({ workspace }: { workspace: string }) {
  const grants = useLoad(() => api.grants(workspace), [workspace]);
  const who = useLoad(() => api.whoCan(workspace), [workspace]);
  const users = useLoad(() => api.users(), []);
  const groups = useLoad(() => api.groups(), []);
  const projects = useLoad(() => api.projects(workspace), [workspace]);
  const [input, setInput] = useState({
    principal: '',
    level: 'ro' as GrantLevel,
    project: '',
    flow: '',
  });
  const flows = useLoad(
    async () => (input.project ? (await api.flows(input.project)).flows : []),
    [input.project],
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
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
    const [type, principal] = input.principal.split(':') as ['user' | 'group', string];
    try {
      await api.addGrant(workspace, {
        [type]: principal,
        level: input.level,
        ...(input.project && input.flow ? { project: input.project, flow: input.flow } : {}),
      });
      setInput({ ...input, principal: '', flow: '' });
      reload();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby={`${id}-access`}>
      <h2 id={`${id}-access`}>Access</h2>
      <p className="muted">
        Who may do what in this workspace. A grant on one flow replaces the workspace's for that
        flow; of a person's own and their groups' grants, the highest counts. Administrators may do
        everything.
      </p>
      <Loading state={grants} />
      {grants.data?.length === 0 && (
        <p className="muted">No grants yet: only administrators see this workspace.</p>
      )}
      {!!grants.data?.length && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Who</th>
                <th scope="col">Level</th>
                <th scope="col">On</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {grants.data.map((g) => (
                <tr key={g.id}>
                  <td>
                    {g.principal.type === 'group' ? 'group ' : ''}
                    {g.principal.name}
                  </td>
                  <td>
                    <span className="badge">{g.level}</span>
                  </td>
                  <td>
                    {g.flow ? (
                      <>
                        <code>{g.flow.file}</code>{' '}
                        <span className="muted">in {g.flow.projectKey}</span>
                      </>
                    ) : (
                      'the whole workspace'
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="danger"
                      aria-label={`Take back ${g.level} from ${g.principal.name}`}
                      onClick={async () => {
                        if (!window.confirm(`Take back ${g.level} from ${g.principal.name}?`))
                          return;
                        await api.removeGrant(g.id).catch((e) => setError(messageOf(e)));
                        reload();
                      }}
                    >
                      Take back
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Give access</h3>
      <form className="form" onSubmit={give}>
        <div className="field">
          <label htmlFor={`${id}-who`}>Who</label>
          <select
            id={`${id}-who`}
            value={input.principal}
            onChange={(e) => setInput({ ...input, principal: e.target.value })}
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
                  {g.name}
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
                  one flow of {p.name}
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
        <div className="actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Giving…' : 'Give'}
          </button>
        </div>
      </form>

      <h3>Who can do what</h3>
      <Loading state={who} />
      {!!who.data?.length && (
        <div className="scroll">
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
                  <td>{w.admin ? 'administrator' : (w.workspace ?? '')}</td>
                  <td>
                    {w.flows.map((f) => (
                      <div key={`${f.project}/${f.file}`}>
                        <code>{f.file}</code>: {f.level}
                      </div>
                    ))}
                  </td>
                  <td>{w.approve ? 'yes' : ''}</td>
                  <td className="muted">{w.admin ? 'administrator' : w.through.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
