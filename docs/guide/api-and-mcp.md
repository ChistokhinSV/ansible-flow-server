# The API and agents (MCP)

[The guide](README.md)

## The API

Everything the pages do goes through the REST API under `/api/v1`, and every address is in the
server's OpenAPI 3.1 document, `GET /api/v1/openapi.json` (no sign-in needed). The page
`/docs/api` shows it by subject: what each address does, who may call it, and what it takes.

```sh
curl -s https://flows.example.net:8443/api/v1/openapi.json | jq '.paths | keys | length'
curl -H "Authorization: Bearer $AFS_TOKEN" \
  "https://flows.example.net:8443/api/v1/runs?project=<id>&state=failed&limit=20"
```

- Errors are JSON: `{"error": "<code>", "message": "<words fit to show>"}`, with the HTTP status.
  A refusal about one field of the request names it: `"field": "<name>"` (a name over 200
  characters: `{"error": "invalid", "message": "Name: at most 200 characters.", "field": "name"}`).
- A run is followed as server-sent events (`GET /api/v1/runs/<id>/events`), see [Runs](runs.md).
- The list of runs is narrowed with `project`, `flow`, `state`, `config` (a launch
  configuration's id) and `by` (the login of who asked for the run), and read a page at a time
  with `limit` and `before`, see [Runs](runs.md). A list never shows more than you may see,
  whatever it is asked for.
- Each route is described in one list on the server (what it does, who may call it, which
  workspace it reaches); a route that is not in it stops the server from starting.

## Agents (MCP)

Agents such as Claude Code, Codex and Cursor reach the server over MCP (Streamable HTTP) at
`/mcp`, signed in with an [access token](people-and-sign-in.md#access-tokens). The agent acts as the token's owner:
it sees and does only what they may, within the token's workspace, and what it changes is in
the audit log with the source `mcp`.

| Tool                                                            | Does                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `flow_list`, `flow_describe`, `flow_validate`, `flow_reference` | The designer's flow tools, read-only, on the projects' flows (`net/edge/flows/upgrade.flow.yaml`) |
| `project_list`                                                  | Workspaces and projects you may see: branch, commit, sync state                                   |
| `launch_config_list`                                            | A project's launch configurations, each with how its last run went (`lastRun`)                    |
| `run_check`                                                     | What a launch would run (commit, inputs, hosts) or what is in its way                             |
| `run_launch`                                                    | Queue a run of a launch configuration (`operator`); `step: true` runs it step by step             |
| `run_status`, `run_output`, `run_list`                          | How a run stands (state, approvals, hosts per step), its output, the runs                         |
| `run_stop`                                                      | Stop a run                                                                                        |
| `run_relaunch`                                                  | Run a run again (`operator`): all its hosts or those that did not go well, step by step           |
| `approval_list`                                                 | Approvals that wait, and whether you may decide each                                              |
| `approval_decide`                                               | Only with a token made to allow it (below)                                                        |
| `run_step`                                                      | Step, Continue, Pause or Stop a step-by-step run; only with a token made to allow it (below)      |

- **Flows are read-only here:** they change in git (clone the project from the server, edit it
  in VS Code, push). Edit tools come with editing on the server.
- **Approvals stay with people:** `approval_decide` is offered only to a token made with
  "An agent with this token may decide approvals over MCP" (on My account, or
  `"mcpApprovals": true` when making a token), and then only where its owner may decide.
- **Step-by-step runs stay with people too:** `run_step` is offered only to a token made with
  "An agent with this token may drive step-by-step runs over MCP" (`"mcpRunControl": true`), and
  then only where its owner may stop the run. See [Step by step](runs.md#step-by-step).
- A launch configuration is named by its id or as `<workspace>/<project>/<name>`.
- `run_list` takes a `project`, a `config` (a launch configuration), `by` (a login) or `mine`
  (the runs the token's owner asked for), and a `state`. When there are more runs, its answer
  has `next`: pass it as `before` for the next page.

Make a token on **My account** (for one workspace, if the agent needs no more), keep it in an
environment variable (`AFS_TOKEN` below), and add the server to the agent:

Claude Code:

```sh
claude mcp add --transport http ansible-flow-server https://flows.example.net:8443/mcp \
  --header "Authorization: Bearer $AFS_TOKEN"
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.ansible-flow-server]
url = "https://flows.example.net:8443/mcp"
bearer_token_env_var = "AFS_TOKEN"
```

Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "ansible-flow-server": {
      "url": "https://flows.example.net:8443/mcp",
      "headers": { "Authorization": "Bearer ${env:AFS_TOKEN}" }
    }
  }
}
```

With the server's self-signed certificate, the agent's machine must trust it (or use a
certificate from your authority, see [HTTPS and the certificate](certificates.md)).
The endpoint is stateless and answers with JSON: any server behind a load balancer answers any
request.
