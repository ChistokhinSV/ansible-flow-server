# Credentials

[The guide](README.md)

Credentials hold the secrets that runs, Git mirrors and integrations sign in with. Administrators
manage them per workspace under **Build › Credentials**.

Secrets are write-only — once saved, neither the pages nor the API ever return a secret value (to
change a stored secret, send the whole secret again). Each secret field can be **Stored here**
(encrypted with the server's master key) or fetched at run start from an external
[secret provider](secret-providers.md) (Vault, CyberArk or AWS Secrets Manager).

## Credential kinds

| Kind                | Visible fields       | Secret fields              | Used for                                                                                                        |
| ------------------- | -------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ssh_key`           | `username`           | `privateKey`, `passphrase` | Target hosts over SSH, or SSH Git mirrors                                                                       |
| `login`             | `username`           | `password`                 | Target hosts, or HTTPS Git mirrors                                                                              |
| `become`            | `method`, `username` | `password`                 | Privilege escalation (`sudo`, `su`, `doas`, …)                                                                  |
| `vault`             | `vaultId`            | `password`                 | Decrypting Ansible Vault files and variables                                                                    |
| `env`               | Variable names       | Variable values            | Environment variables injected into runs and dynamic inventories                                                |
| `registry`          | `host`, `username`   | `password`                 | Pulling execution environment images from private registries                                                    |
| `git_token`         | `username`           | `token`                    | Reading and pushing to private HTTPS Git repositories                                                           |
| `awx`               | `url`                | `token`                    | [Importing AWX templates](import-playbooks.md#import-from-awx-or-automation-controller) (never exposed to runs) |
| `netbox` / `zabbix` | `address`            | `token`                    | Posting [action](actions.md) results back to NetBox or Zabbix                                                   |

## SSH keys and host keys

- **SSH keys with a passphrase**: during a run, passphrase-protected SSH keys are unlocked into an
  `ssh-agent` inside the container, so the execution environment image **must include
  `openssh-client`**. A wrong passphrase fails the run with `"The SSH key could not be unlocked"`.
- **SSH Git mirrors and host keys**: SSH host keys of external Git sources are **trusted on first
  use** (stored in `<data>/repos/known_hosts`, fingerprint shown on **Settings** and audited as
  `git.host-key-trusted`). If the remote host later presents a different key, syncing stops with an
  error until an administrator verifies why it changed and clicks **Accept the new host key**.
- Credentials in active use by a project or launch configuration cannot be deleted until detached.

## The master key

Stored secrets, sealed run inputs, TLS private keys, SMTP passwords and webhook signing keys are
encrypted with a 32-byte **master key** kept outside the database:

- By default, first startup generates `<data>/master.key` and logs its key ID. **Back this key up
  separately** — without it, encrypted credentials cannot be read, and the server refuses to start
  with a mismatched key.
- Stronger: store the key outside the data directory via `AFS_MASTER_KEY_FILE` or pass base64 bytes
  in `AFS_MASTER_KEY` (`openssl rand -base64 32`).

| CLI command      | Purpose                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `secrets status` | Verify which master key is active and that stored credentials decrypt cleanly             |
| `secrets rotate` | Generate a new master key and re-seal all stored secrets (stop the server before running) |

The [API reference](/docs/api) lists every `/api/v1/workspaces/:id/credentials` and
`/credentials/:id` call and who may make it.
