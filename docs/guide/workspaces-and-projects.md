# Workspaces, projects and Git

[The guide](README.md)

![A project's Overview tab](images/project.png)

A **workspace** groups a team's projects, environments, credentials and access grants. A **project**
is a Git repository containing flows (`*.flow.yaml`), playbooks, roles and inventories.

## Hosted vs mirrored projects

Administrators create workspaces (**All workspaces › Add workspace**) and projects (**Build ›
Projects › Add project**):

- **Server-hosted repository** (no external URL): the server stores and serves the Git repository.
  Start it empty, from a built-in sample, or from a `.zip` / `.tar.gz` archive (up to 5,000 files
  and `AFS_ARCHIVE_MAX_MB`, default `50` MB).
- **Mirrored external repository** (`https://…`, `ssh://…` or `git@host:path`): the server mirrors
  your Git host, signing in with a workspace [credential](credentials.md) (`git_token` or `login`
  for HTTPS, `ssh_key` for SSH; SSH host keys are trusted on first use and shown on **Settings**).

The project's status badge shows **up to date**, **not read yet**, **empty**, or **cannot be read**
(runs continue using the last fetched commit until fixed on **Settings › Look at the source now**).

### Keeping an external repository in sync

External projects sync when added, on demand (**Look at the source now**, `rw`), every
`pollSeconds` (`300` s by default; `0` disables polling), and via **push webhooks**:

- Open **Settings › Push hook** (administrators) to generate the webhook URL and secret token.
- **GitHub**: add a webhook with **Payload URL**, content type `application/json`, **Secret** set to
  the token (`X-Hub-Signature-256` verified), and **Just the push event**.
- **GitLab / Gitea / scripts**: send the token in `X-Gitlab-Token`, `X-AFS-Token` or
  `Authorization: Bearer`.

## Git: clone, fetch and push

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
  pushes forward to the upstream repository first). Force-pushes and deleting the project's default
  branch are blocked.
- **VS Code**: clone the repository and open it in
  [Ansible Flow Designer](https://github.com/ChistokhinSV/ansible-flow-designer) to edit flows,
  playbooks and roles side by side.

## Files of a project

The **Files** tab lets you browse any branch and download or edit non-flow files (`inventory`,
`group_vars/`, `roles/`, `templates/`, `ansible.cfg`, scripts) right in the browser with syntax
highlighting (flows open in [Edit flows](edit-flows.md)).

With `rw` on the workspace you can queue multiple edits before committing:

- **New file**, text edits (up to 1 MB), **Upload files** (up to 5 MB), **Upload a folder (zip)**
  (`.zip` or `.tar.gz`), **Rename or move** and **Delete**.
- All queued changes appear in the bar at the bottom until you press **Save** (`Ctrl+S`), which
  creates a single commit on the branch (and pushes upstream for mirrored projects).
- Moving or renaming a flow offers **Point them at the new file in the same save** so launch
  configurations and [schedules](schedules.md) keep working without interruption.

## History and branches

- **History**: lists commits on the selected branch with search across message, author, hash and
  changed files. Click a commit to inspect changed files.
- **Branches**: view branches with ahead counts, create or delete branches (`rw`), inspect **Pushes
  through this server**, or change the project's active branch on **Settings** (administrators).
  Active branches and branches referenced by launch configurations cannot be deleted.

### A flow at a commit

Opening a flow from **History** (or **⋯ › History** on a flow page, `?commit=<hash>`) shows that
historical version read-only in the designer's **Changes** lens, highlighting steps, wires and
settings added, changed or removed compared to the parent commit.

> **Deleting**: administrators delete projects at the bottom of **Settings** and empty workspaces at
> the bottom of **Access** after typing the key (hosted repositories are archived under
> `data/repos/deleted`).
