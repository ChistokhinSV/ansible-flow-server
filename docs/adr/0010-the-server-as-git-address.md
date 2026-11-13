# ADR-0010: The server is the git address of every project

- Status: accepted (2026-11-13, AFS-14). Carries out ADR-0003's amendment; builds on ADR-0008
  (mirrors, calling git safely) and ADR-0009 (tokens)
- Context: people work on a project's flows from VS Code with git. Whether they may is decided
  by the server, not by the git host, and must be the same for a project the server hosts and
  for one with an external source

## Decision

**Every project has one address**, `<server>/git/<workspace key>/<project key>.git`, spoken to
with git's smart HTTP (`src/server/projects/gitHttp.ts`). The git program answers
(`upload-pack`, `receive-pack`, started without a shell, with the safe settings of ADR-0008);
the server decides who may ask.

**Two kinds of project, one behaviour.**

- **Hosted:** a project made without a source. Its repository in the data folder is the only
  copy; a push lands in it. It starts empty: the first push makes its branch.
- **External:** the mirror answers a clone or a fetch, after a look at the source when the last
  one is older than ten seconds (a source that does not answer does not stop the client: it
  gets what the mirror has). A push is **passed on** to the source first, on the condition that
  the source's branches are where the mirror says they are; only when the source accepts it do
  the mirror's branches move. What the source refuses, the mirror never holds.

**Sign-in is a personal access token as the HTTP Basic password**, with any user name. Not a
session: a page in a browser must not be able to push with someone's cookie. Not the person's
password: it would end up in git's credential store.

**Who may do what** (until access levels exist, AFS-27): everyone signed in clones and fetches;
administrators push; a read-only token never pushes. The rule is one function (`mayPush`), which
AFS-27 replaces. What the git host enforces for an external source (protected branches, required
reviews) applies to the project's credential, not to the person.

**What a push may be** is checked by one hook, the server's own file in `repos/hooks`, written
at every start. No repository's own hooks ever run.

- Only branches: the mirror holds nothing else.
- The project's branch (the one that runs) is not deleted and its history is not rewritten, so
  a commit a run names stays readable. Other branches are free.
- At most 512 MB per push; ten minutes per request.

**A push has the repository to itself.** Pushes, looks at the source and the removal of a
project are done one after another per project (`ProjectSync.exclusive`); fetches read while
others read.

**Who pushed is recorded** (`git_push`: person, branch, commit before and after), found by
comparing the branches before and after the push. Commits keep their own authors. The answer to
the client ends after the record is written and the project's commit is updated, so a client
that reads the project right after its push sees it.

**A deleted hosted project's repository is put aside** (`repos/deleted/<id>-<time>.git`), not
removed: it was the only copy. A mirror is removed: its source has everything.

## Not in this decision

- **A credential for the source** (AFS-17). Until then a push to an external project works only
  where the server's own account may push (an SSH key of that account, a folder of the machine),
  and is otherwise refused with the source's refusal.
- **Starting a hosted project from a sample or an archive** (AFS-58).
- **Tags.** The mirror holds branches only (ADR-0008), so tags are not pushed or fetched here.
- **Removing what was put aside**, and repository size limits: with backup and retention
  (AFS-37).

## Alternatives considered

- **`git http-backend`.** It is the same two programs behind CGI. Calling them directly leaves
  out CGI and its environment, and keeps sign-in and paths in the server.
- **Checking a push in the server before git sees it.** No hook. But whether a push rewrites
  history can only be known with its commits at hand, which is after git has unpacked them; the
  hook runs at exactly that moment, and git throws the commits away when it says no.
- **Passing a push on after accepting it.** Simpler. But the client would be told "accepted"
  for something the source may then refuse, and the mirror would hold it.
- **Sending people to the source for pushes.** Nothing to build. But then a person with edit
  access on the server and none at the git host could edit in the browser and not from VS Code.

## Consequences

- The git program's shell (`sh`) is needed for the hook; git for Windows brings its own.
- A push to an external project takes as long as the push to its source.
- Hosted repositories are data: they belong in the backup of the data folder (AFS-37).
