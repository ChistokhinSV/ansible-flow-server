# Ansible Flow Server: user guide

Ansible Flow Server runs visual Ansible playbooks for a team. Flows (`*.flow.yaml`) are built right
in the browser or in VS Code with
[Ansible Flow Designer](https://github.com/ChistokhinSV/ansible-flow-designer): you wire steps,
failure paths and approvals on a canvas, and the engine compiles them into plain Ansible playbooks
and runs them in execution environment containers.

![A real run waiting at an approval gate on the flow canvas](images/run-waiting.png)

## Edit, import and run

Start with the tasks you use every day:

| Guide                                   | What you do                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Edit flows](edit-flows.md)             | Create and edit flows on the canvas or in VS Code, collaborate in shared drafts, save and reuse subflows  |
| [Import playbooks](import-playbooks.md) | Bring existing Ansible playbooks, roles, Git repositories or AWX templates into a project as visual flows |
| [Run playbooks](runs.md)                | Set up a launch configuration (Check or Real), watch hosts and output live, stop and re-run failed hosts  |
| [Debug a run](debugging.md)             | Pause at steps or host failures, inspect variables, watch expressions, evaluate Jinja and retry a step    |

## Projects and workflows

| Guide                                                      | What it covers                                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Workspaces, projects and Git](workspaces-and-projects.md) | Hosted and mirrored Git repositories, editing project files, commit history and branches     |
| [Execution environments](environments.md)                  | Container images for runs, built from Ansible collections or pulled from a registry          |
| [Credentials](credentials.md)                              | SSH keys, passwords, vault passwords and tokens, encrypted with the master key               |
| [Approvals](approvals.md)                                  | Approval gates that pause real runs until an allowed approver decides                        |
| [Actions](actions.md)                                      | Short self-service forms and NetBox or Zabbix links for running approved tasks without flows |
| [Schedules](schedules.md)                                  | Cron and one-time scheduled launches with time zones                                         |
| [Inbox and navigation](inbox-and-navigation.md)            | Home inbox, cross-workspace lists, search (`/` or `Ctrl+K`), shortcuts and themes            |

## Administration and setup

| Guide                                              | What it covers                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Install and first setup](install.md)              | Docker Compose, Linux systemd service, first administrator setup and designer compatibility |
| [People, groups and access](people-and-sign-in.md) | Access levels (`ro`, `operator`, `rw`, `approve`), workspace matrix, tokens, OIDC and LDAP  |
| [Secret providers](secret-providers.md)            | Pull credentials at run start from HashiCorp Vault, CyberArk or AWS Secrets Manager         |
| [HTTPS and the certificate](certificates.md)       | Request, install, replace or roll back TLS certificates, or run behind a proxy              |
| [Notifications](notifications.md)                  | Email and signed webhooks for approvals, run outcomes and server alerts                     |
| [Event streaming](event-streaming.md)              | Stream audit entries and run traces to syslog (SIEM) and OpenTelemetry                      |
| [The audit log](audit.md)                          | Every change and refusal recorded, filtered by day and exported as CSV or JSON              |
| [Configuration](configuration.md)                  | Reference table of every `AFS_*` environment and `.env` setting                             |
| [Operations](operations.md)                        | Health checks, Prometheus metrics, online backup and restore, upgrades                      |

## API and automation

| Guide                                       | What it covers                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [API reference](/docs/api)                  | Every `/api/v1` endpoint from the OpenAPI document, with live **Test Request** in the page |
| [REST API and agents (MCP)](api-and-mcp.md) | Access tokens, SSE streams, and connecting Claude Code, Codex or Cursor over `/mcp`        |
| [Ansible collection](collection.md)         | `chistokhinsv.ansible_flow`: launch and gate on runs, and manage server resources as code  |

Examples across this guide use fictional data: the `network` workspace, Dana Whitfield
(administrator), Olga Petrova (operator), André Silva (approver), hosts `fw-01` and `sw-edge-01`,
and `example.com`.
