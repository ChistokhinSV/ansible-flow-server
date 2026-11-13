# ADR-0023: The MCP endpoint for agents

- Status: accepted (2026-11-13, AFS-24). Builds on ADR-0019 (the API, tokens for one workspace),
  ADR-0020 (access levels), ADR-0021 (approval gates), ADR-0018 (the audit log)
- Context: agents (Claude Code, Codex, Cursor) should read a team's flows and run them through
  the server, under the same rules as a person, with approvals left to people

## Decision

**Streamable HTTP at `/mcp`, stateless, JSON answers.** Each POST gets its own MCP server and
transport (`@modelcontextprotocol/server` 2.4.0, its web-standard transport: a `Request` in, a
`Response` out, no other HTTP framework); no sessions, no SSE stream (GET answers 405). Any
server of a group answers any request; nothing is kept between calls.

**A token signs in, never a session.** No `Authorization: Bearer` with a good token: 401 with
`WWW-Authenticate: Bearer`. A browser's cookie is not taken, so a page elsewhere cannot drive the
endpoint as whoever is signed in.

**The server's tools call the server's API in-process** (`app.inject`) with the caller's token:
the catalog's access check (ADR-0020), the one-workspace limit of a token (ADR-0019), read-only
tokens, the handlers' rules and the audit entries are the API's, not repeated. A call carries a
mark made at each start and never sent out (`x-afs-mcp`), so the audit records it as `mcp`; a
request from outside cannot claim it.

**Flows: the designer's tools that read** (`flow_list`, `flow_describe`, `flow_validate`,
`flow_reference`, its `runTool`) over a server `FlowIO`: a flow is `<workspace>/<project>/<file>`
at the project's commit; only flows the caller may read, within the token's workspace; a flow
not there and one not allowed get the same answer. Writing throws: flows change in git until
editing on the server (AFS-48); the edit tools are not offered.

**Runs:** `project_list`, `launch_config_list`, `run_check`, `run_launch`, `run_status`,
`run_output` (its end, at most 40 000 characters), `run_stop`, `run_list`. A launch
configuration is named by id or `<workspace>/<project>/<name>`.

**Approvals stay with people:** `approval_list` for anyone; `approval_decide` is offered and
works only with a token made to allow it (`api_token.mcp_approve`, "An agent with this token may
decide approvals over MCP", not with a read-only token), and then only where the owner may
decide (ADR-0021). The tool's description asks the agent to decide only when the user said so.

## Consequences

- An agent is exactly as strong as its token: a token for one workspace, read-only, or without
  approvals limits it, and revoking the token stops it.
- New API rules reach agents without work here; new tools are thin wrappers over API routes.
- No live progress over MCP: agents poll `run_status`. A streaming channel can come with sessions
  if agents need it.
- The edit tools come with a server `FlowIO` that commits (AFS-48).
