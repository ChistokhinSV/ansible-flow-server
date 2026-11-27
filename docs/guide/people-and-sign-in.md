# People, groups and access

[The guide](README.md)

## Access levels

![A workspace's Access matrix and single-flow exceptions](images/access.png)

Administrators have full access everywhere. Everyone else sees and does only what their **grants**
allow (unshared workspaces, projects, flows and runs return `404` as if absent). Grants apply to a
user or group on a whole workspace, or as an exception on a single flow:

| Level                    | What it allows                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Read** (`ro`)          | View projects, flows, launch configurations, credential names and runs; `git clone` / `fetch` (workspace grant) |
| **Operate** (`operator`) | Everything in Read, plus launch configured runs, stop runs and **Run again**                                    |
| **Edit** (`rw`)          | Everything in Operate, plus edit flows and files, `git push`, manage launch configurations and schedules, debug |
| **Approve** (`approve`)  | Decide [approval gates](approvals.md) and view runs they govern (combines with any level without lowering it)   |

- **Effective access**: a user gets the highest level across their personal and group grants. A
  grant on a single flow overrides the workspace level for _that_ flow only (single-flow grants do
  not expose repository files, commit history or `git clone`).
- **Action grants**: let someone run a specific [action](actions.md) without seeing anything else in
  the workspace.
- **Managing grants**: open **Govern › Access** (`/w/<workspace>/-/access`) to view the **Who can do
  what** matrix, click **Give access**, or open any row's **⋯** menu to change or revoke a grant in
  place. Anyone can check their own effective permissions under **Account › Profile › Your access**.

## Local users, groups and CLI recovery

Administrators manage users, [service accounts](#service-accounts) and groups under **Govern ›
People** (`/admin/people`). Passwords require at least 12 characters with 5 distinct characters,
cannot contain the login, and are stored as `argon2id` hashes. Sessions expire after 8 hours idle
(7 days max), and the last administrator cannot be demoted, disabled or deleted.

If everyone is locked out, manage accounts from the server host (`just user …` or
`/usr/local/bin/ansible-flow-server user …`):

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
(`afs_…`), created under **Account › Access tokens** (`/account/tokens`).

- Send as `Authorization: Bearer <token>` or as the HTTP Basic password for Git.
- Tokens are shown **once** (stored hashed), expire in 90 days by default (up to 365 days), and
  cannot create other tokens or change passwords.
- **Scoping options**: restrict a token to **one workspace**, mark it **read-only**, or explicitly
  opt in to **MCP approvals** (`mcpApprovals`) or **MCP run control / debugging** (`mcpRunControl`).

## Service accounts

For CI pipelines and external automation, administrators can create a **service account** under
**Govern › People** (`--service` on the CLI). Service accounts have no password, cannot sign in to
the web UI, receive workspace/flow grants like any user, and authenticate solely with tokens minted
by an administrator on the account's page.

## Single sign-on (OIDC) and LDAP

Administrators configure external sign-in under **Govern › Server › Sign-in** (`/admin/sign-in`):

- **OIDC** (Keycloak, Microsoft Entra ID, Okta, Google, Authentik): register the callback URL shown
  on the page (`/api/v1/auth/oidc/<key>/callback`), configure issuer, client ID/secret and group
  claim mappings (to server groups or administrator), and click **Test**. Uses Authorization Code +
  PKCE.
- **LDAP / Active Directory**: start from the Active Directory or OpenLDAP preset (`ldaps://` or
  StartTLS), bind DN, search base/filter (including nested AD group matching) and group mappings.
  Periodic sync disables local sessions and tokens when an account leaves or is disabled in AD.
- **Passwords for administrators only**: once an OIDC provider or LDAP directory is active, you can
  restrict local password sign-in to administrators so regular users always authenticate through SSO
  or LDAP while admins keep a break-glass login.
