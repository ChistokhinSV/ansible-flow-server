# HTTPS and the certificate

[The guide](README.md)

The server speaks HTTPS itself. At its first start it makes a self-signed certificate, so nothing
is ever sent in the clear; browsers warn about it until you install one from a certificate
authority. The `--insecure` above is for that first certificate only.

```sh
just cert show
just cert request flows.example.net --org "Example Ltd" --out flows.csr
# have your certificate authority sign flows.csr, then (the chain may follow in the same file):
just cert install flows.pem
```

```text
Installed
  Subject      CN=flows.example.net, O=Example Ltd
  Names        flows.example.net
  Issuer       CN=Example Issuing CA
  Valid        2026-11-13T08:40:00.000Z to 2027-02-11T08:40:00.000Z (89 days left)
  Fingerprint  4E:1B:…
  Chain        1 more certificate
A running server serves it to new connections from now on.
```

| Command                                            | Does                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `cert show`                                        | The certificate in use, the one before it, a waiting request                                 |
| `cert request <names> [--org] [--out]`             | A new key and a request to sign; the key stays with the server                               |
| `cert install <file> [--key <file>]`               | Installs a certificate; without `--key` it answers the request, or renews for the key in use |
| `cert install <file.pfx> --passphrase-file <file>` | Installs the certificate, chain and key of a PFX (PKCS#12) file                              |
| `cert self-signed [names]`                         | A new self-signed certificate                                                                |
| `cert rollback`                                    | Back to the certificate that was in use before                                               |
| `cert history`                                     | Every change: when, what, by whom, which certificate                                         |

- A certificate is checked before anything changes: its key belongs to it, it is valid now, its
  chain is in order, and it is good for the host of `AFS_PUBLIC_URL`. Every problem is named.
- A running server needs no restart: new connections get the new certificate within a moment.
- The server warns in its log when the certificate has 30 days or fewer left.
- Keys and certificates are in `<data folder>/tls`. Back that folder up with the rest. The
  private keys (in use, the one before it, a waiting request's) are sealed with the master key
  (`*.sealed`): a copy of the folder gives them away only with the master key. A plain `key.pem`
  from an older server is sealed at its next start; `secrets rotate` seals them again with the
  new key. This protects them only when the master key is kept elsewhere: give it as
  `AFS_MASTER_KEY`, or point `AFS_MASTER_KEY_FILE` outside the data folder (another disk, a
  secret mount). With `master.key` in the data folder, a copy of the folder has both.
- Behind a proxy that does HTTPS: `AFS_TLS=off` and `AFS_TRUSTED_PROXIES`.

A PFX file (`.pfx`, `.p12`), as Windows certificate authorities and many appliances export one,
holds the certificate, its chain and its key. Its passphrase is read from a file, never given as an
argument, where the process list and the shell's history would show it:

```sh
just cert install flows.pfx --passphrase-file pfx-pass.txt   # an empty file: no passphrase
```

The file is taken apart and goes through the same checks. Modern (AES-256) and older (3DES, RC2)
files are read, with RSA or EC keys; a file with more than one key is refused (export one
certificate). The passphrase is used once and kept nowhere.

The same actions are on the **Server certificate** page (Administration) and over the API, for
administrators. A change needs a sign-in with a password, not a token: a leaked token must not be
able to put its own certificate in front of everyone. The history names the administrator, and the
audit log has every change (`certificate.*`). While the certificate has 30 days or fewer left,
every page shows administrators a banner.

| Address (under `/api/v1/admin/certificate`) | Does                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET` (the address itself)                  | In use, the one before it, a waiting request, whether TLS is on                     |
| `POST /request`                             | `{"names":[…],"organization"}`: a new key and a request; the key stays here         |
| `GET /request.pem`                          | The waiting request, as a file for the certificate authority                        |
| `POST /install`                             | `{"certificate","key"?}`: install; refused with `422` and every reason (`problems`) |
| `POST /install` (a PFX)                     | `{"pfx","passphrase"}`: the file as base64; the same checks and refusals            |
| `POST /self-signed`                         | `{"names"?}`: a new self-signed certificate                                         |
| `POST /rollback`                            | Back to the certificate before                                                      |
| `GET /history`                              | Every change, newest first                                                          |

Not there yet: automatic certificates (ACME).
