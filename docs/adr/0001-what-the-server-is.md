# ADR-0001: What the server is, and the decisions it starts from

- Status: accepted (2026-11-13, AFS-9; product-owner decisions of the same day)
- Context: Ansible Flow Designer runs a flow from one person's machine. A team needs a place that
  runs the same flows with shared projects, access levels, approvals, schedules and a record

## Context

The tools a team could use instead were looked at before any code:

- **AWX / AAP:** execution environments, approval nodes, role-based access. It needs Kubernetes,
  and its open-source releases have been paused since 2024. A workflow branches on whole jobs, not
  on hosts.
- **Semaphore UI:** one binary, quick to install. No approvals, no execution environment builder,
  coarse roles.
- **Rundeck:** fine-grained access rules, scripts as first-class steps. Ansible through a plugin;
  approvals and remote runners in the commercial edition.

None of them runs a flow as the designer means it: each host routed through the graph, with the
failure handling drawn in the flow.

## Decision

| Topic           | Decision                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product         | Ansible Flow Server: its own repository, MIT, cross-linked with Ansible Flow Designer                                                                            |
| Code reuse      | The designer's model, generator, run pipeline and canvas as npm packages (ADR-0002). The server is Node.js and TypeScript for that reason                        |
| Source of truth | A project's flows live in git: an external repository, or one the server hosts (ADR-0003)                                                                        |
| Database        | SQLite by default, PostgreSQL supported (ADR-0004). It holds what git does not: runs, access, secrets, schedules                                                 |
| Web page        | In 1.0 the designer's canvas is shown read-only: view a flow, launch it, watch it, approve. Editing in the browser comes later                                   |
| Access          | Levels `ro`, `operator` (view and launch), `rw`, `approve` (a separate grant) and `admin`, for users or groups, on a workspace or on one flow                    |
| Approvals       | An approval step of a flow pauses the run until a listed approver decides. No self-approval by default. No approval through MCP unless a token allows it         |
| Notifications   | Email and webhook in 1.0, behind one channel interface; Telegram and Slack later                                                                                 |
| Execution       | The server runs jobs itself, each in an execution environment container (Docker or rootless Podman). Jobs are leased from a queue, so remote agents can be added |
| Environments    | Built by the server from a list of collections (pinned or latest), on the designer's base image                                                                  |
| Scripts         | A shell or Python script is a step of a flow that runs through Ansible, so it runs the same from VS Code, in AWX and here                                        |
| Sign-in         | Local users, OIDC, LDAP. API and MCP tokens per user or service account                                                                                          |
| Transport       | HTTPS from 1.0: a self-signed certificate at first start, a page to request and replace certificates                                                             |
| Triggers        | By hand, on a schedule, by REST, by MCP, from the VS Code extension                                                                                              |
| Deployment      | docker compose, or a systemd service on Linux with jobs still in containers                                                                                      |

## The shape

```text
Browser (web page + the designer's canvas) --+
VS Code extension                            +-- REST /api/v1, WebSocket, /mcp --> server
MCP clients                                  --+

server:   sign-in, access, projects (git), viewer sessions, scheduler, job queue,
          approvals, notifications, environment builder, audit
executor: runFlow of @ansible-flow/node
          -> a container of the execution environment -> ansible-playbook with the events callback
          -> events -> a summary per node and host -> live status on the canvas
```

Objects: a Workspace (members, default approvers, credentials, environments) has Projects (a git
source and the branch that may run); a Project has Flows (`*.flow.yaml`); a Launch configuration
names a flow, an inventory, an environment, credentials and default inputs; a Run is one launch at
one commit; an Approval belongs to a run.

## Consequences

- The server cannot be written in another language without a second copy of the designer's rules.
  That is accepted: the rules are the product.
- A flow newer than the server's packages is not run: the server says to upgrade (it is checked
  from the first commit, `src/server/flows.ts`).
- What is left for after 1.0 is in YouTrack (epic AFS-8): inbound webhooks, more notification
  channels, ACME, editing in the browser, a built-in agent, remote agents.
