// Access tokens: a person's own on My account, and a service account's on its page (AFS-56). A
// token is shown once, when it is made; the list shows its name, its last characters and what it
// may do. The list comes first: making a token is behind a button (AFS-88).
import { type ReactNode, useId, useState } from 'react';
import { launchesAny } from './access';
import {
  api,
  type NewToken,
  type TokenInfo,
  type UserReach,
  type Workspace as WorkspaceInfo,
} from './api';
import { ask } from './confirm';
import { Copyable, Field, Form, Loading, messageOf, Scroll, Time, useLoad, useRefresh } from './ui';

export function TokensPanel({
  load,
  add,
  revoke,
  intro,
  none,
  onChanged,
  reach,
}: {
  load: () => Promise<TokenInfo[]>;
  /** Absent: tokens are only seen and revoked here (another person makes their own). */
  add?: (input: {
    name: string;
    expiresInDays?: number;
    readOnly?: boolean;
    workspace?: string;
    mcpApprovals?: boolean;
    mcpRunControl?: boolean;
  }) => Promise<NewToken>;
  revoke: (id: string) => Promise<void>;
  intro: ReactNode;
  none: string;
  /** A token was made or revoked: a page that counts them counts again. */
  onChanged?: () => void;
  /**
   * AFS-206: what the token's person reaches, so the form offers only what they may use: deciding
   * approvals (an approve grant, or operator for their own runs), driving step-by-step runs
   * (operator somewhere). Absent while unknown: everything is offered.
   */
  reach?: UserReach | undefined;
}) {
  const list = useLoad(load, []);
  // AFS-139: Last used follows a token's use elsewhere (the API, an MCP client).
  useRefresh(list.reload, 30_000);
  const workspaces = useLoad(api.workspaces, []);
  const fresh = {
    name: '',
    days: 90,
    readOnly: false,
    workspace: '',
    mcpApprovals: false,
    mcpRunControl: false,
  };
  const [input, setInput] = useState(fresh);
  // AFS-206: launching (operator) lets one drive one's own step-by-step runs and, where the
  // workspace allows it, decide one's own runs' approvals.
  const launches = !reach || launchesAny({ ...reach, administrators: [] });
  const mayApprove = !reach || reach.admin || !!reach.approves || launches;
  const workspaceName = (id?: string) =>
    id ? (workspaces.data?.find((w) => w.id === id)?.name ?? 'a deleted workspace') : 'all';
  const [made, setMade] = useState<NewToken>();
  const [adding, setAdding] = useState(false);
  // AFS-194: a note after Revoke, as after making one.
  const [revoked, setRevoked] = useState<{ ok: boolean; text: string }>();
  return (
    <section className="panel" aria-labelledby="tokens">
      {/* AFS-102: the section's action at its head. */}
      <div className="section-head">
        <h2 id="tokens">Access tokens</h2>
        {add && !adding && (
          <button type="button" onClick={() => setAdding(true)}>
            Make a token
          </button>
        )}
      </div>
      {intro}
      {made && (
        <div className="notice ok" role="status">
          <p>
            <strong>Copy the token now.</strong> It is not shown again.
          </p>
          <Copyable text={made.token} label="the token" />
          <p>
            <button type="button" onClick={() => setMade(undefined)}>
              I have copied it
            </button>
          </p>
        </div>
      )}
      {revoked && (
        <p
          className={`notice ${revoked.ok ? 'ok' : 'error'}`}
          role={revoked.ok ? 'status' : 'alert'}
        >
          {revoked.text}
        </p>
      )}
      <Loading state={list} />
      {list.data?.length === 0 && <p className="muted">{none}</p>}
      {!!list.data?.length && (
        <Scroll>
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Ends with</th>
                <th scope="col">May</th>
                <th scope="col">Reaches</th>
                <th scope="col">Last used</th>
                <th scope="col">Expires</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>
                    <code>…{t.hint}</code>
                  </td>
                  <td>
                    {t.readOnly ? 'read' : 'read and change'}
                    {t.mcpApprovals ? ', decide approvals (agents)' : ''}
                    {t.mcpRunControl ? ', drive and look into step-by-step runs (agents)' : ''}
                  </td>
                  <td>{t.workspace ? workspaceName(t.workspace) : 'all workspaces'}</td>
                  <td>
                    <Time at={t.lastUsedAt} />
                  </td>
                  <td>
                    <Time at={t.expiresAt} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="danger"
                      aria-label={`Revoke ${t.name}`}
                      onClick={async () => {
                        if (
                          !(await ask(
                            `Revoke the token "${t.name}"? Programs that sign in with it are refused from now on.`,
                            { yes: 'Revoke', danger: true },
                          ))
                        )
                          return;
                        setRevoked(undefined);
                        try {
                          await revoke(t.id);
                          setRevoked({
                            ok: true,
                            text: `Revoked the token "${t.name}": it no longer works.`,
                          });
                        } catch (e) {
                          setRevoked({ ok: false, text: messageOf(e) });
                        }
                        list.reload();
                        onChanged?.();
                      }}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
      {add && adding && (
        <section className="panel sheet" aria-label="Make a token">
          <Form
            submit="Make token"
            onCancel={() => setAdding(false)}
            onSubmit={async () => {
              setMade(
                await add({
                  name: input.name,
                  expiresInDays: input.days,
                  readOnly: input.readOnly,
                  ...(input.mcpApprovals && !input.readOnly ? { mcpApprovals: true } : {}),
                  ...(input.mcpRunControl && !input.readOnly ? { mcpRunControl: true } : {}),
                  ...(input.workspace ? { workspace: input.workspace } : {}),
                }),
              );
              // AFS-134: the next token starts from the defaults, not this one's choices.
              setInput(fresh);
              // The form closes: what is left to look at is the token, shown this once.
              setAdding(false);
              list.reload();
              onChanged?.();
            }}
          >
            <Field
              label="Name"
              value={input.name}
              onChange={(e) => setInput({ ...input, name: e.target.value })}
              required
              autoFocus
              maxLength={100}
              placeholder="laptop git"
              hint="What will use it, so you know which one to revoke."
            />
            <Field
              label="Days until it expires"
              type="number"
              min={1}
              max={365}
              value={input.days}
              onChange={(e) => setInput({ ...input, days: Number(e.target.value) })}
              required
            />
            <label className="choice">
              <input
                type="checkbox"
                checked={input.readOnly}
                onChange={(e) => setInput({ ...input, readOnly: e.target.checked })}
              />
              Read only (clone and read; no changes)
            </label>
            {mayApprove && (
              <label className="choice">
                <input
                  type="checkbox"
                  checked={input.mcpApprovals && !input.readOnly}
                  disabled={input.readOnly}
                  onChange={(e) => setInput({ ...input, mcpApprovals: e.target.checked })}
                />
                Allow MCP agents to decide approvals
                {input.readOnly ? ' · not for a read-only token' : ''}
              </label>
            )}
            {/* AFS-177: run_step, off unless asked for, as deciding approvals is. */}
            {launches && (
              <label className="choice">
                <input
                  type="checkbox"
                  checked={input.mcpRunControl && !input.readOnly}
                  disabled={input.readOnly}
                  title="Step, Continue, Pause, Stop, Retry, and reading variables, Watch and Evaluate at debug pauses"
                  onChange={(e) => setInput({ ...input, mcpRunControl: e.target.checked })}
                />
                {/* AFS-253: all the option allows, the debugger's reading and Evaluate too. */}
                Allow MCP agents to drive step-by-step runs and inspect debug variables
                {input.readOnly ? ' · not for a read-only token' : ''}
              </label>
            )}
            <WorkspaceChoice
              value={input.workspace}
              workspaces={workspaces.data ?? []}
              onChange={(workspace) => setInput({ ...input, workspace })}
            />
          </Form>
        </section>
      )}
    </section>
  );
}

/** Which workspace a token reaches: all, or one. */
function WorkspaceChoice({
  value,
  workspaces,
  onChange,
}: {
  value: string;
  workspaces: WorkspaceInfo[];
  onChange: (id: string) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>Reaches</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={`${id}-hint`}
      >
        <option value="">all workspaces you can reach</option>
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            only {w.name} ({w.key})
          </option>
        ))}
      </select>
      <small id={`${id}-hint`} className="muted">
        A token for one workspace cannot reach another, nor what spans them (all runs, people).
      </small>
    </div>
  );
}
