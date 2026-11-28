# People, groups and access

[The guide](README.md)

## Access levels

![A workspace's Access matrix and single-flow exceptions](images/access.png)

Administrators have full access everywhere. Everyone else sees and does only what their **grants**
allow (unshared workspaces, projects, flows and runs return `404` as if absent; disallowed actions on
visible items return `403`). Grants apply to a user or group on a whole workspace, or as an
exception on a single flow:

| Level                    | What it allows                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Read** (`ro`)          | View projects, flows, launch configurations, credential names and runs; `git clone` / `fetch` (workspace grant) |
| **Operate** (`operator`) | Everything in Read, plus launch configured runs, stop runs and **Run again**                                    |
| **Edit** (`rw`)          | Everything in Operate, plus edit flows and files, `git push`, manage launch configurations and schedules, debug |
| **Approve** (`approve`)  | Decide [approval gates](approvals.md) and view runs they govern (combines with any level without lowering it)   |

- **Effective access**: a user gets the highest level across their personal and group grants. A
  grant on a single flow replaces the workspace level for _that_ flow only (single-flow grants do
  not expose repository files, commit history or `git clone`).
- **Action grants**: let someone run a specific [action](actions.md) without seeing anything else in
  the workspace.
- **Managing grants**: open **Govern › Access** (`/w/<workspace>/-/access`) to view the **Who can do
  what** matrix, click **Give access**, or open any row's **⋯** menu to change or revoke a grant in
  place. Check your own effective access under **Account › Profile › Your access**.

## Local users, groups and CLI recovery

Administrators manage users, [service accounts](#service-accounts) and groups under **Govern ›
People** (`/admin/people`).

- **Passwords and sessions**: passwords require at least 12 characters with 5 distinct characters,
  cannot contain the login, and are stored as `argon2id` hashes. **After five wrong passwords for a
  login within 15 minutes, sign-in for that login waits.** Sessions expire after 8 hours idle (7
  days max), and the last administrator cannot be demoted, disabled or deleted.
- **CLI recovery** when nobody can sign in — run via `docker compose exec server node dist/server.js
  user …` (Docker Compose) or `sudo /usr/local/bin/ansible-flow-server user …` (Linux service; use
  the full `/usr/local/bin` path with `sudo` on RHEL-family hosts):

| Command                                              | Action                                                 |
| ---------------------------------------------------- | ------------------------------------------------------ |
| `user list`                                          | List accounts, admin status, state and groups          |
| `user add <login> [--name] [--email] [--admin]`      | Create a user (prompts unseen for password)            |
| `user password <login>`                              | Reset password and end open sessions                   |
| `user disable <login>` / `user enable <login>`       | Disable (immediately ending sessions/tokens) or enable |
| `user admin <login> on\|off`                         | Grant or remove administrator                          |
| `user token <login> [--name] [--days] [--read-only]` | Mint and print a personal access token                 |

## Access tokens

Git clients, the [Ansible Flow Designer](https://github.com/ChistokhinSV/ansible-flow-designer) VS
Code extension, scripts and [MCP agents](api-and-mcp.md#agents-mcp) authenticate with access tokens
(`afs_…`), created under **Account › Access tokens** (`/account/tokens`, up to 50 per user).

- Send as `Authorization: Bearer <token>` or as the HTTP Basic password for Git.
- Tokens are shown **once** (stored hashed), expire in 90 days by default (up to 365 days), stop
  immediately when revoked or when their owner is disabled, and cannot create/revoke tokens or
  change passwords (those require an interactive session).
- **Scoping options**: restrict a token to **one workspace** (`403 out_of_scope` outside it), mark it
  **read-only** (`403 read_only_token` on writes), or explicitly opt in to **MCP approvals**
  (`mcpApprovals`) or **MCP run control / debugging** (`mcpRunControl`).

## Service accounts

For CI pipelines and external automation, administrators create a **service account** under **Govern
› People** (`--service` on the CLI). Service accounts have no password, cannot sign in to the web
UI, receive workspace/flow grants like any user, and authenticate solely with tokens minted by an
administrator on the account's page.

## Single sign-on (OIDC) and LDAP

Administrators configure external sign-in under **Govern › Server › Sign-in** (`/admin/sign-in`):

- **OIDC** (Keycloak, Microsoft Entra ID, Okta, Google, Authentik): register the callback URL shown
  on the page (`/api/v1/auth/oidc/<key>/callback`), configure issuer, client ID/secret and group
  claim mappings, and click **Test** (Authorization Code + PKCE).
- **LDAP / Active Directory**: start from the Active Directory or OpenLDAP preset (`ldaps://` or
  StartTLS), bind DN, search base/filter (including nested AD group matching) and group mappings.
  - **Directory sync** runs every `60` minutes by default (`0` syncs only at sign-in), and on demand
    with **Sync now**. Users who left the directory or were disabled in Active Directory are
    disabled here (ending open sessions and tokens immediately) and re-enabled if they return. **A
    directory that does not answer disables nobody, and an account disabled here manually stays
    disabled.**
- **How mapped groups and rights behave (OIDC and LDAP)**: at each sign-in (and LDAP sync), mapped
  groups and administrator rights that the provider or directory no longer returns are **taken
  back**, while groups and rights granted manually on this server are **kept**. Editing a group's
  members on this server keeps the mapped members mapped: the provider can still take them back. Removing a provider
  or directory keeps its user accounts and drops the groups, administrator rights and
  directory-driven disables it gave.
- **Passwords for administrators only**: once an OIDC provider or LDAP directory is enabled, you can
  restrict local passwords to administrators (refused with `409` while no provider or directory is
  active).

The [API reference](/docs/api) lists every user, group, session, token, grant and sign-in endpoint
and who may call it.
