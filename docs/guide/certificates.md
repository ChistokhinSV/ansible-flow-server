# HTTPS and the certificate

[The guide](README.md)

The server speaks HTTPS out of the box. At first startup it generates a self-signed certificate so
traffic is never unencrypted; download `/api/v1/certificate.pem` if Git or scripts need to trust it
before you install a CA-signed certificate.

## Replace or manage the certificate

Administrators manage certificates on **Govern › Server › Server certificate** (`/admin/certificate`,
requires an interactive password session rather than a token) or via the CLI (`just cert …` /
`/usr/local/bin/ansible-flow-server cert …`):

| Command                                            | Action                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| `cert show`                                        | Show active certificate, previous certificate and pending CSR          |
| `cert request <names> [--org] [--out]`             | Generate a new private key and CSR (key stays sealed on server)        |
| `cert install <file.pem> [--key <file>]`           | Install a signed certificate (and chain)                               |
| `cert install <file.pfx> --passphrase-file <file>` | Install certificate, chain and key from a PKCS#12 (`.pfx`/`.p12`) file |
| `cert self-signed [names]`                         | Generate a new self-signed certificate                                 |
| `cert rollback`                                    | Revert immediately to the previous certificate                         |
| `cert history`                                     | List every certificate change and administrator                        |

- **Live reload and validation**: the server verifies key match, validity dates, chain order and
  `AFS_PUBLIC_URL` hostname before activating a certificate with zero downtime.
- **Sealed private keys**: private keys in `<data>/tls` are encrypted with the
  [master key](credentials.md#the-master-key).
- **Expiry warnings**: administrators receive banners and [notifications](notifications.md) starting
  30 days before expiry.
- **Behind a TLS proxy**: set `AFS_TLS=off` and `AFS_TRUSTED_PROXIES` to serve plain HTTP on `8080`
  behind a reverse proxy.
