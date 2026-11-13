# ADR-0013: Credentials and the master key

- Status: accepted (2026-11-13, AFS-17). Builds on ADR-0008 and ADR-0010 (git), ADR-0005
  (database)
- Context: a run signs in to machines, a project's mirror signs in to its git host. Those
  secrets must be kept by the server, used by the server, and not be readable from a copy of the
  database or through the API

## Decision

**One master key, outside the database** (`src/server/secrets/masterKey.ts`). 32 random bytes:
from `AFS_MASTER_KEY` (base64), from the file `AFS_MASTER_KEY_FILE` names, or, given neither,
from `<data folder>/master.key`, which the server makes at its first start (readable by its
account only) with a warning to keep a copy. A key has a short id (the start of its SHA-256)
that says which key it is and nothing of it.

**Secrets are sealed with AES-256-GCM** (`secrets/crypto.ts`): a fresh nonce per value, and the
value bound to where it is kept (`credential:<id>`), so a sealed value moved to another row does
not open. A sealed value names the key it needs.

**The database remembers its key** by a sealed word. A server given another key refuses to
start and says so: better at start than when a run needs a password. A new database takes the
key it is started with.

**Credentials** (`secrets/credentials.ts`) belong to a workspace and have a kind:

| Kind        | Open part              | Secret part                |
| ----------- | ---------------------- | -------------------------- |
| `ssh_key`   | `username`             | `privateKey`, `passphrase` |
| `login`     | `username`             | `password`                 |
| `become`    | `method`, `username`   | `password`                 |
| `vault`     | `vaultId`              | `password`                 |
| `git_token` | `username`             | `token`                    |
| `registry`  | `host`, `username`     | `password`                 |
| `env`       | (the variables' names) | the variables' values      |

- The secret part goes in and never comes out: every answer is the credential with the names of
  what it holds. To change a secret it is replaced whole.
- A refusal never repeats what was sent; the log says who changed which credential, never to
  what.
- Until access levels exist (AFS-27): everyone signed in sees which credentials a workspace
  has; administrators make, change and delete them.
- A credential a project signs in with is not deleted from under it.

**A project signs in to its source with a credential** (`gitCredential`): a `git_token` or a
`login` of the project's own workspace, for a source reached over https.

- The sign-in is handed to git for one call as a setting in that call's environment
  (`http.<source's origin>/.extraheader`), so it is in no address, no argument list, no file and
  no mirror's settings, and git does not send it to another host the source redirects to.
- The same goes for a push passed on to the source (ADR-0010): the hook's push runs in that
  environment.
- A credential the source refuses is the project's state ("cannot be read"), like any source
  that does not answer.

**Git trusts what the server trusts.** With `AFS_CA_FILE`, the server writes all the
authorities it trusts to `<data>/repos/ca-bundle.pem` at start and gives git that file (and
tells git on Windows to use it instead of the system's store). Found by the real run: before,
`AFS_CA_FILE` reached the server's own connections and not git's.

**Rotating the key** (`secrets rotate`, with the server stopped): a new key is written beside
the old one, everything is sealed again in one database transaction, then the files change
places; the old key is kept as `master.key.<id>.old`. With the key in `AFS_MASTER_KEY` the new
one is printed once, to be put in the settings.

**Plain http to this machine itself** is allowed as a source where folders of the machine are
(`AFS_GIT_LOCAL=on`): tests and single-machine installs.

## Not in this decision

- Handing credentials to a run, and taking their values out of a run's output (AFS-20, AFS-21).
- Who may use which credential (AFS-27), and the record of each use (AFS-22).
- An ssh source with a key from the store, and host keys (AFS-60).
- GitHub's signed push hooks (AFS-61). Sealing the server certificate's key (AFS-62).
- The pages (AFS-63). Secrets kept elsewhere, such as HashiCorp Vault (AFS-47).

## Alternatives considered

- **The token in the source's address** or in the mirror's settings. Simple. But addresses are
  shown, logged and kept; ADR-0008 refuses them for that reason.
- **A credential helper program.** Git's own way. But it is a program to write and to find at
  run time on two platforms, for what one environment setting does.
- **A key derived from a passphrase typed at start.** Nothing on disk. But a server that cannot
  start unattended does not restart after a power cut.
- **A key per workspace.** Smaller loss if one leaks. But they would all sit in the same place
  as the one key does.

## Consequences

- The data folder and the master key are both needed to restore a server. A backup of the
  database without the key has no usable credentials; that is the point, and the README says it.
- With the generated key in the data folder, a copy of the whole folder has both. Keeping the
  key elsewhere (`AFS_MASTER_KEY_FILE`) is the stronger setup.
- A number sent where text is expected is taken as text (the web framework's behaviour): a
  password `12345` sent as a number is kept as `"12345"`.
