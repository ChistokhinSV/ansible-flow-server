# REST API and agents (MCP)

[The guide](README.md)

## The API

Every feature in the web UI is backed by `/api/v1` and documented in the server's OpenAPI 3.1
specification (`GET /api/v1/openapi.json`).

Open **Help › API reference** ([/docs/api](/docs/api)) for interactive documentation served locally
by the server:

- Browse endpoints by subject with request/response schemas and `curl` examples.
- Click **Test Request** to call this server directly using your current browser session, or select
  **token** under **Authentication** and paste an [access token](people-and-sign-in.md#access-tokens)
  (kept in page memory only) to test scoped or read-only permissions. Write requests (`POST`, `PUT`,
  `PATCH`, `DELETE`) ask for confirmation and are audited normally.

```sh
curl -H "Authorization: Bearer $AFS_TOKEN" \
  "https://flows.example.com:8443/api/v1/runs?workspace=network&state=failed&limit=20"
```

- **Errors**: JSON `{"error": "<code>", "message": "<plain text>", "field"?: "<name>"}`.
- **Live streams**: follow runs (`GET /api/v1/runs/<id>/events`), action progress and collaborative
  drafts over Server-Sent Events (`text/event-stream`).
- **Inbox**: `GET /api/v1/inbox` returns everything needing attention across visible workspaces.

## Agents (MCP)

AI coding and operations agents (Claude Code, Codex, Cursor and others) connect over Streamable HTTP
MCP at `/mcp` using a [personal or service-account token](people-and-sign-in.md#access-tokens). All
calls enforce the token owner's permissions (and optional workspace scope) and log under source
`mcp` in the [audit log](audit.md).

| MCP tools                                                                       | Purpose                                                                                  |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `project_list`, `flow_list`, `flow_describe`, `flow_validate`, `flow_reference` | Inspect workspaces, projects and flows (read-only; edit flows via Git or the web editor) |
| `launch_config_list`, `run_check`, `run_launch`, `run_relaunch`                 | Check what would run, launch a run, or re-run failed hosts                               |
| `run_list`, `run_status`, `run_output`, `run_stop`                              | Monitor runs, read masked output, or cancel                                              |
| `approval_list`, `approval_decide`                                              | List waiting gates; deciding requires a token minted with `mcpApprovals`                 |
| `run_step`, `run_inspect`                                                       | Drive step/debug runs and inspect paused variables; requires `mcpRunControl`             |

### Agent configuration examples

Keep your token in `AFS_TOKEN` and register `/mcp`:

**Claude Code**:

```sh
claude mcp add --transport http ansible-flow-server https://flows.example.com:8443/mcp \
  --header "Authorization: Bearer $AFS_TOKEN"
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.ansible-flow-server]
url = "https://flows.example.com:8443/mcp"
bearer_token_env_var = "AFS_TOKEN"
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "ansible-flow-server": {
      "url": "https://flows.example.com:8443/mcp",
      "headers": { "Authorization": "Bearer ${env:AFS_TOKEN}" }
    }
  }
}
```
