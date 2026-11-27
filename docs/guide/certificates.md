# HTTPS and the certificate

[The guide](README.md)

The server speaks HTTPS out of the box. At first startup it generates a self-signed certificate so
traffic is never unencrypted; download `/api/v1/certificate.pem` if Git or scripts need to trust it
before you install a CA-signed certificate.

## Replace or manage the certificate

Administrators manage certificates on **Govern › Server › Server certificate** (`/admin/certificate`,
requires an interactive password session rather than a token) or via the CLI (`docker compose exec
server node dist/server.js cert …` on Compose, or `sudo /usr/local/bin/ansible-flow-server cert …`
on a Linux service):

| Command                                            | Action                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| `cert show`                                        | Show active certificate, previous certificate and pending CSR          |
| `cert request <names> [--org] [--out]`             | Generate a new private key and CSR (key stays sealed on the server)    |
| `cert install <file.pem> [--key <file>]`           | Install a signed certificate and chain                                 |
| `cert install <file.pfx> --passphrase-file <file>` | Install certificate, chain and key from a PKCS#12 (`.pfx`/`.p12`) file |
| `cert self-signed [names]`                         | Generate a new self-signed certificate                                 |
| `cert rollback`                                    | Revert immediately to the previous certificate                         |
| `cert history`                                     | List every certificate change and administrator                        |

## Rules and security notes

- **Live reload and validation**: the server verifies key match, validity dates, chain order and
  `AFS_PUBLIC_URL` hostname before activating a certificate with zero downtime. PFX passphrases are
  read from `--passphrase-file` (never command-line arguments) and discarded immediately.
- **Sealed private keys**: private keys in `<data>/tls` (`*.sealed`) are encrypted with the
  [master key](credentials.md#the-master-key) and re-sealed on `secrets rotate`. **This protects a
  copied data folder only when the master key is stored elsewhere** (`AFS_MASTER_KEY`, or
  `AFS_MASTER_KEY_FILE` outside the data folder); if `master.key` stays inside the data folder, a
  copy of the folder holds both.
- **Expiry warnings**: administrators see a banner on every page and receive
  [notifications](notifications.md) starting 30 days before expiry.
- **Behind a TLS proxy**: set `AFS_TLS=off` and `AFS_TRUSTED_PROXIES`. On a standalone start
  `AFS_TLS=off` listens on plain HTTP port `8080` by default; on Docker Compose,
  `deploy/compose/compose.yaml` sets `AFS_PORT=8443` explicitly, so the container stays on plain
  HTTP port `8443` unless you change `AFS_PORT` / `AFS_PUBLISH_PORT`.

The [API reference](/docs/api) lists every `/api/v1/admin/certificate` call and who may make it.
