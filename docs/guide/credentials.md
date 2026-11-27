# Credentials

[The guide](README.md)

Credentials hold the secrets that runs, Git mirrors and integrations sign in with. Administrators
manage them per workspace under **Build › Credentials**.

Secrets are write-only — once saved, neither the pages nor the API ever return a secret value. Each
secret field can be **Stored here** (encrypted with the server's master key) or fetched at run start
from an external [secret provider](secret-providers.md) (Vault, CyberArk or AWS Secrets Manager).

## Credential kinds

| Kind                | Visible fields       | Secret fields              | Used for                                                                                                        |
| ------------------- | -------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ssh_key`           | `username`           | `privateKey`, `passphrase` | Target hosts over SSH (unlocked via `ssh-agent`), or SSH Git mirrors                                            |
| `login`             | `username`           | `password`                 | Target hosts, or HTTPS Git mirrors                                                                              |
| `become`            | `method`, `username` | `password`                 | Privilege escalation (`sudo`, `su`, `doas`, …)                                                                  |
| `vault`             | `vaultId`            | `password`                 | Decrypting Ansible Vault files and variables                                                                    |
| `env`               | Variable names       | Variable values            | Environment variables injected into runs and dynamic inventories                                                |
| `registry`          | `host`, `username`   | `password`                 | Pulling execution environment images from private registries                                                    |
| `git_token`         | `username`           | `token`                    | Reading and pushing to private HTTPS Git repositories                                                           |
| `awx`               | `url`                | `token`                    | [Importing AWX templates](import-playbooks.md#import-from-awx-or-automation-controller) (never exposed to runs) |
| `netbox` / `zabbix` | `address`            | `token`                    | Posting [action](actions.md) results back to NetBox or Zabbix                                                   |

All credential values injected into a run are automatically masked in terminal output, events and
the [debugger](debugging.md). Credentials in active use by a project or launch configuration cannot
be deleted until detached.

## The master key

Stored secrets, sealed run inputs, TLS private keys, SMTP passwords and webhook signing keys are
encrypted with a 32-byte **master key** kept outside the database:

- By default, first startup generates `<data>/master.key` and logs its key ID. **Back this key up
  separately** — without it, encrypted credentials cannot be read, and the server refuses to start
  with a mismatched key.
- In production, store it outside the data directory via `AFS_MASTER_KEY_FILE` or pass base64 bytes
  in `AFS_MASTER_KEY` (`openssl rand -base64 32`).

| CLI command      | Purpose                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `secrets status` | Verify which master key is active and that stored credentials decrypt cleanly             |
| `secrets rotate` | Generate a new master key and re-seal all stored secrets (stop the server before running) |
