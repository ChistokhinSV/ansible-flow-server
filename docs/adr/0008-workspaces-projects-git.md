# ADR-0008: Workspaces, projects, and how the server uses git

- Status: accepted (2026-11-13, AFS-13). Builds on ADR-0003 (a project's flows live in git)
- Context: a project is a git repository. The server must have its content at hand, know which
  commit is current, and never be made to run something else through a repository's address

## Decision

**Workspaces and projects** (`src/server/projects/store.ts`).

- A workspace has a key (lower-case letters, digits, dashes; used in addresses) and a name. It
  holds projects, and later credentials, environments and who may do what. One that still has
  projects is not deleted.
- A project names a repository address, the branch whose commits may run (`main` unless set), how
  often its source is looked at, and what the last look found: the commit, or why it failed.
- Until access levels exist (AFS-27): everyone signed in reads workspaces and projects,
  administrators change them.

**A mirror per project** in `<data folder>/repos/<project id>.git`, a bare repository with every
branch of the source, exactly as the source has them (a branch deleted there is deleted here).

- **A look at the source** fetches the branches and reads the commit the project's branch is at.
  It happens when a project is added or its source changes, when an administrator asks, when the
  git host says so (the push hook), and on a timer (every 5 minutes unless set; not more often
  than every 30 seconds; 0 turns it off).
- **A source that cannot be read is the project's state**, not an error of the server: the
  project says why in words for its page, keeps the commit it had, and the log says it once.
- One look at a time per project; a second asker waits for the first's answer.
- Everything that reads a flow reads it from the mirror at a commit (`files`, `read`), byte for
  byte. Nothing is checked out.

**Calling git safely** (`src/server/projects/git.ts`). The git program does the work. A
repository's address comes from a person, so:

- No shell: the program is started with its arguments as a list.
- An address is `https://…`, `ssh://…` or `git@host:path`. Never one that starts with a dash (it
  would read as an option), never plain `http`, never one with a password in it (it would be
  kept, logged and shown). A folder of this machine only with `AFS_GIT_LOCAL=on`.
- Only those ways of fetching are allowed to git itself (`GIT_ALLOW_PROTOCOL`), and the helper
  that runs a program (`ext::`) is switched off.
- Git does not read the settings of the machine or of the account: an empty file stands in for
  both. No hooks, no automatic clean-up in the middle of a fetch.
- Git never waits for someone to type: a fetch that needs a password fails at once.
- Every call has a time limit (two minutes for a fetch). What git says is cleaned of anything
  between `//` and `@` before it is shown or logged.
- A branch name is a name: no `..`, no spaces, nothing that reads as an option. A file is read by
  a path inside the repository at a full commit id, never at a name.

**The push hook.** A project can have a hook token: 24 random bytes, shown once when made, kept
as a hash. The git host calls `POST /api/v1/hooks/projects/<id>/push` with the token in
`X-Gitlab-Token`, `X-AFS-Token` or `Authorization: Bearer`. The server answers 202 and looks at
the source itself; what the host sends besides is not read. A wrong token, a project without a
hook and no such project get the same answer, and guessing is rate-limited.

## Not in this decision

- **Credentials for private repositories.** They come with the credentials store (AFS-17): an
  HTTPS token or an SSH key per project. Until then a project is a public HTTPS repository, or an
  SSH one the server's own account can already reach.
- **GitHub's signed hooks.** GitHub proves itself by signing the request with a secret the server
  must keep readable, which also waits for AFS-17. GitLab, Gitea and anything that can send a
  header work now.
- **The server as the git address of every project** (AFS-14; ADR-0003's amendment): cloning from
  it, and pushing through it to an external source. Until then the mirror is only read.
- **Choosing the commit of a run.** A project's commit here is the newest of its branch, which a
  run takes unless its launch names another branch or commit (AFS-18).
- **Finding the flows** in a project (AFS-16).

## Alternatives considered

- **A git library instead of the git program.** No program to install. But the program is what
  people's repositories are tested against (protocols, large repositories, SSH), and its safe use
  is a short list of rules, kept in one file.
- **A working copy per project.** Simple reads. But a run needs the files of one commit while a
  newer one arrives, and line-ending settings would change bytes. Reading from the mirror at a
  commit has neither problem.
- **The hook's token in the address.** Works with every host, GitHub included. But addresses are
  logged, by the server and by everything in front of it.

## Consequences

- The server needs the `git` program. Its absence shows as every project's look failing.
- A repository's history is kept: a mirror grows with its source. Old runs can always be read at
  their commit.
- A look at a large repository holds one of the server's processes for its time; looks are one
  after another on the timer, so one slow source delays the others' timer looks, not their
  requests.
