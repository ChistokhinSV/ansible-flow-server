// Access tokens: a person's own on My account, and a service account's on its page (AFS-56). A
// token is shown once, when it is made; the list shows its name, its last characters and what it
// may do.
import { type ReactNode, useId, useState } from 'react';
import { api, type NewToken, type TokenInfo, type Workspace as WorkspaceInfo } from './api';
import { Copyable, Field, Form, Loading, Time, useLoad } from './ui';

export function TokensPanel({
  load,
  add,
  revoke,
  intro,
  none,
}: {
  load: () => Promise<TokenInfo[]>;
  /** Absent: tokens are only seen and revoked here (another person makes their own). */
  add?: (input: {
    name: string;
    expiresInDays?: number;
    readOnly?: boolean;
    workspace?: string;
    mcpApprovals?: boolean;
  }) => Promise<NewToken>;
  revoke: (id: string) => Promise<void>;
  intro: ReactNode;
  none: string;
}) {
  const list = useLoad(load, []);
  const workspaces = useLoad(api.workspaces, []);
  const [input, setInput] = useState({
    name: '',
    days: 90,
    readOnly: false,
    workspace: '',
    mcpApprovals: false,
  });
  const workspaceName = (id?: string) =>
    id ? (workspaces.data?.find((w) => w.id === id)?.key ?? 'a deleted workspace') : 'all';
  const [made, setMade] = useState<NewToken>();
  return (
    <section className="panel" aria-labelledby="tokens">
      <h2 id="tokens">Access tokens</h2>
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
      <Loading state={list} />
      {list.data?.length === 0 && <p className="muted">{none}</p>}
      {!!list.data?.length && (
        <div className="scroll">
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
                        if (!window.confirm(`Revoke the token "${t.name}"? It stops working.`))
                          return;
                        await revoke(t.id).catch(() => undefined);
                        list.reload();
                      }}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {add && (
        <>
          <h3>Make a token</h3>
          <Form
            submit="Make token"
            onSubmit={async () => {
              setMade(
                await add({
                  name: input.name,
                  expiresInDays: input.days,
                  readOnly: input.readOnly,
                  ...(input.mcpApprovals && !input.readOnly ? { mcpApprovals: true } : {}),
                  ...(input.workspace ? { workspace: input.workspace } : {}),
                }),
              );
              setInput({ ...input, name: '' });
              list.reload();
            }}
          >
            <Field
              label="Name"
              value={input.name}
              onChange={(e) => setInput({ ...input, name: e.target.value })}
              required
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
              Read only (can clone and read, cannot push or change anything)
            </label>
            <label className="choice">
              <input
                type="checkbox"
                checked={input.mcpApprovals && !input.readOnly}
                disabled={input.readOnly}
                onChange={(e) => setInput({ ...input, mcpApprovals: e.target.checked })}
              />
              An agent with this token may decide approvals over MCP (off: approvals stay with
              people)
            </label>
            <WorkspaceChoice
              value={input.workspace}
              workspaces={workspaces.data ?? []}
              onChange={(workspace) => setInput({ ...input, workspace })}
            />
          </Form>
        </>
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
