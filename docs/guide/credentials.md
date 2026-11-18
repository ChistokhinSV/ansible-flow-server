# Credentials and the master key

[The guide](README.md)

What a run or a mirror signs in with is kept by the server, encrypted with a **master key**
that is not in the database.

- With no setting, the server makes `data/master.key` at its first start and says so in the
  log. **Keep a copy somewhere safe:** without it the stored credentials cannot be read.
- Stronger: keep the key outside the data folder with `AFS_MASTER_KEY_FILE`, or give it as
  `AFS_MASTER_KEY` (32 random bytes in base64: `openssl rand -base64 32`).
- A server started with another key than its database's refuses to start.

```sh
curl ... -X POST https://flows.example.net:8443/api/v1/workspaces/network/credentials \
  -d '{"name":"Git host","kind":"git_token","fields":{"username":"deploy"},"secret":{"token":"<the token>"}}'
```

```json
{
  "id": "7b1f6c0a-3c1e-4c58-9f0e-2f6a1d4b8e90",
  "workspace": "5d0c2f0e-0f52-4a55-a2f4-0d2f5c0e7a11",
  "name": "Git host",
  "kind": "git_token",
  "fields": { "username": "deploy" },
  "has": ["token"],
  "usedBy": 0,
  "createdAt": "2026-11-13T13:55:06.120Z",
  "updatedAt": "2026-11-13T13:55:06.120Z"
}
```

| Kind        | Open part            | Secret part                | For                                                          |
| ----------- | -------------------- | -------------------------- | ------------------------------------------------------------ |
| `ssh_key`   | `username`           | `privateKey`, `passphrase` | Machines over SSH                                            |
| `login`     | `username`           | `password`                 | Machines; a git host over HTTPS                              |
| `become`    | `method`, `username` | `password`                 | Becoming another user (sudo)                                 |
| `vault`     | `vaultId`            | `password`                 | An Ansible vault                                             |
| `git_token` | `username`           | `token`                    | A git host over HTTPS                                        |
| `registry`  | `host`, `username`   | `password`                 | A container registry                                         |
| `awx`       | `url`                | `token`                    | Importing an AWX workflow or job template into an empty flow |
| `env`       | the variables' names | the variables' values      | Variables of a run's environment                             |

| Address (under `/api/v1`)     | Does                                                     | Who                                                 |
| ----------------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| `/workspaces/:id/credentials` | List; add                                                | read: `ro` on the workspace; change: administrators |
| `/credentials/:id`            | One; change name, open part, or the whole secret; delete | as above                                            |

- **A secret goes in and never comes out.** Answers name what a credential holds (`has`), not
  the values. To change a secret, send it again whole.
- **An AWX token** (kind `awx`, **AWX token** in the form): the address of an AWX or Automation
  Controller (`url`, like `https://awx.example.net`) and a token of a user there who can read
  its templates (in AWX: **Users > Tokens**, scope `read`). It is used only to import a workflow
  or job template into an empty flow (see [Editing flows in the pages](web-pages.md#editing-flows-in-the-pages));
  runs never get it.

  ```sh
  curl ... -X POST https://flows.example.net:8443/api/v1/workspaces/network/credentials \
    -d '{"name":"AWX","kind":"awx","fields":{"url":"https://awx.example.net"},"secret":{"token":"<the token>"}}'
  ```

- **A private repository:** give the project a credential of its workspace:
  `"gitCredential": "<credential id>"` when adding it, or `PATCH /projects/:id` (`null` takes it
  away). A `git_token` or `login` for an `https://` source, an `ssh_key` for an `ssh://` or
  `git@host:path` one. The server signs in with it to read the source and to pass pushes on.
- **An SSH key** is written to a private folder for one git call only and removed after it; a key
  with a passphrase is unlocked by a helper that reads it from a private file (never an argument or
  a variable of the call). The user is the one in the address, else the credential's `username`.
  Without a credential, an ssh source uses the server account's own key, as before.
- **SSH host keys** are trusted on first use: the first look at an ssh source keeps its host key
  in `<data folder>/repos/known_hosts` (the account's `~/.ssh/known_hosts` is read too), says so
  in the log and the audit log (`git.host-key-trusted`), and the project's page shows the
  fingerprint. A host that later shows another key stops the project with a reason; an
  administrator who knows why it changed presses **Accept the new host key**
  (`POST /projects/:id/host-key/forget`), and the next look trusts the key it finds.
  `GET /projects/:id/host-key` gives the fingerprints.
- A credential a project uses is not deleted until the project has another.
- With authorities of your own (`AFS_CA_FILE`), the server's git trusts them too.

| Command          | Does                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secrets status` | Which master key the server has, and whether the stored credentials open with it                                                                  |
| `secrets rotate` | Makes a new master key and seals everything again: credentials, runs' inputs, the mail server's password, the webhook key (stop the server first) |

On the pages, a workspace's **Credentials** list what each holds (never a secret) and how many
projects and launch configurations use it; administrators add one with a form for its kind, change
its name, description and visible fields, replace its secret (the fields start empty and the
browser does not fill them; a private key can come from a file), and delete one nothing uses. An
external project chooses what it signs in with on its page (and when it is added): a git token or
a login for an `https://` address, an SSH key for an ssh one; a source that asks for a sign-in
says so there.
