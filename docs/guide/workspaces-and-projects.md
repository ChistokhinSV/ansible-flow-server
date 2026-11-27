# Workspaces, projects and Git

[The guide](README.md)

![A project's Overview tab](images/project.png)

A **workspace** groups a team's projects, environments, credentials and access grants. A **project**
is a Git repository containing flows (`*.flow.yaml`), playbooks, roles and inventories.

## Hosted vs mirrored projects

Administrators create workspaces (**All workspaces › Add workspace**) and projects (**Build ›
Projects › Add project**):

- **Server-hosted repository** (no external URL): the server stores and serves the Git repository.
- **Mirrored external repository** (`https://…`, `ssh://…` or `git@host:path`; URLs containing
  passwords are refused, and local folders require `AFS_GIT_LOCAL=on`): the server mirrors your Git
  host, signing in with a workspace [credential](credentials.md) (`git_token` or `login` for HTTPS,
  `ssh_key` for SSH).
  - **SSH host keys** are trusted on first use (`<data>/repos/known_hosts`, fingerprint shown on
    **Settings**). **If a remote host later presents a different key, the project stops syncing**
    with a reason until an administrator verifies it and clicks **Accept the new host key**.
  - **Empty mirrors**: an external mirror with no commits yet (empty upstream or not yet fetched)
    has **no Files tab and no New flow button** — push the initial commit to the upstream repository
    with Git first, then let the server poll or click **Look at the source now**.

The project's status badge shows **up to date**, **not read yet**, **empty**, or **cannot be read**
(runs continue using the last fetched commit until fixed on **Settings › Look at the source now**).

### Starting a hosted project from a sample or an archive

A hosted project can get its first commit from the server (when created or on its **Overview** while
empty):

- **Samples**: _Hello, Ansible_, _Edge baseline_ or _Firewall firmware upgrade_, each with its
  `inventory.ini`, roles and a ready-to-launch configuration.
- **Archives**: `.zip` or `.tar.gz` (up to 5,000 files and `AFS_ARCHIVE_MAX_MB`, default `50` MB;
  paths outside the project, symlinks and `.git` folders are refused).

### Keeping an external repository in sync

External projects sync when added, on demand (**Look at the source now**, `rw`), every
`pollSeconds` (`300` s by default; `0` disables polling), and via **push webhooks** (**Settings ›
Push hook**, administrators):

- **GitHub**: add a webhook with **Payload URL**, content type `application/json`, **Secret** set to
  the hook token (`X-Hub-Signature-256` verified), and **Just the push event**.
- **GitLab / Gitea / scripts**: send the token in `X-Gitlab-Token`, `X-AFS-Token` or
  `Authorization: Bearer`.

## Git: clone, fetch and push through the server

Every project — hosted or mirrored — has a Git HTTP address on this server (shown with a **Copy**
button on **Settings** and on empty project overviews). Authenticate with a
[personal access token](people-and-sign-in.md#access-tokens) as the password (any username works):

```sh
git clone https://flows.example.com:8443/git/network/edge.git
# Username: dana   Password: <your access token>
git push origin main
```

If the server uses its initial self-signed certificate, download `/api/v1/certificate.pem` (linked
on **Settings**) and pass it on clone:

```sh
git clone -c http.sslCAInfo=/path/to/server-certificate.pem https://flows.example.com:8443/git/network/edge.git
# On Windows, add: -c http.sslBackend=openssl
```

- **Permissions**: `ro` on the workspace clones and fetches; `rw` pushes (for mirrored projects,
  pushes forward to the upstream repository first).
- **Branch protection**: **the project's active branch** (`gitRef`, `main` by default) cannot be
  deleted or force-pushed (history rewritten) through the server. Other branches allow force-pushes
  and deletion, and only branches (not tags) are pushed through the server.
- **VS Code**: clone the repository and open it in
  [Ansible Flow Designer](https://github.com/ChistokhinSV/ansible-flow-designer) to edit flows,
  playbooks and roles side by side.

## Files of a project

The **Files** tab lets you browse any branch and download or edit non-flow files (`inventory`,
`group_vars/`, `roles/`, `templates/`, `ansible.cfg`, scripts) in the browser with syntax
highlighting (flows open in [Edit flows](edit-flows.md)).

With `rw` on the workspace you can queue **New file**, text edits (up to `1` MB), **Upload files**
(up to `5` MB), **Upload a folder (zip)** (`.zip` or `.tar.gz`), **Rename or move** and **Delete**,
then press **Save** (`Ctrl+S`) to commit them together (pushing upstream first for mirrored
projects; conflicts on files changed concurrently on the branch return `409`). Moving or renaming a
flow offers **Point them at the new file in the same save** so launch configurations and
[schedules](schedules.md) stay on it.

## History

The **History** tab (`ro` on the workspace) lists commits on the selected branch with filtering by
message, author, hash or file path; click a commit to inspect changed files.

### A flow at a commit

Opening a flow from **History** (or **⋯ › History** on a flow page, `?commit=<hash>`) shows that
historical version read-only in the designer's **Changes** lens against its parent commit.

## Branches

The **Branches** tab lists branches with their latest commit and unmerged commit count, plus
**Pushes through this server**. Editors (`rw`) create and delete branches (unmerged branches ask to
confirm; the project's active branch and branches referenced by launch configurations cannot be
deleted), and administrators change which branch runs on **Settings**.

## Deleting projects and workspaces

- Administrators delete a project at the bottom of **Settings** after typing its key. **Deleting a
  project also deletes its launch configurations, their schedules, its run history and the server's
  repository copy** (hosted repositories are archived under `data/repos/deleted`; external upstream
  repositories are untouched), and **is refused while any run of the project is active**.
- Administrators delete a workspace at the bottom of **Access**; deletion is refused while the
  workspace still holds projects or [execution environments](environments.md).

The [API reference](/docs/api) lists every workspace, project, file, commit, branch and webhook call
and who may make it.
