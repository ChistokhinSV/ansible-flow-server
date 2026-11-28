# Labs for the end-to-end tests

Real services the server talks to, in containers on one Docker host (we use the GNS3 VM next to
staging). Each lab makes its own certificates and passwords in its `out/` (or `certs/`) folder on
that host; nothing it makes is committed. Fictional people and secrets only.

| Lab         | What runs                                                                                     | Ports on `LAB_HOST`                                            | Tests                                                                        |
| ----------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `secrets`   | HashiCorp Vault 2.2.2 (TLS), CyberArk Conjur OSS 1.27.0, LocalStack 4.14.0, a CCP mock (mTLS) | 18200, 18080, 14566, 18443                                     | `test/e2e/secretProviders.test.ts` (`secrets/on-vm.mjs`)                     |
| `streaming` | rsyslog 8 (UDP, TCP, TLS), OpenTelemetry collector, Jaeger                                    | 10514 (UDP and TCP), 6514 (TLS), 4317, 4318, 16686 (Jaeger UI) | `test/unit/streamContract.test.ts`                                           |
| `identity`  | Keycloak 26.8.1 (OIDC, https), OpenLDAP (osixia 1.5.0, ldaps:// and StartTLS)                 | 18843 (Keycloak), 10636 (ldaps), 10389 (StartTLS)              | `test/e2e/identity/signin.test.mjs` (`identity/on-vm.mjs`); release plan 2.6 |

## Start them

Copy this folder to the Docker host and start each lab with the address its ports are published
on. Every `up.sh` can run again at any time: it keeps what `out/` has and starts what is stopped
(after the host restarts, too).

```bash
tar cf - -C test/e2e labs | ssh gns3 'mkdir -p ~/afs-labs && tar xf - -C ~/afs-labs --strip-components=1'
ssh gns3 'cd ~/afs-labs && LAB_HOST=<host address> sh secrets/up.sh'
ssh gns3 'cd ~/afs-labs && LAB_HOST=<host address> sh streaming/up.sh'
ssh gns3 'cd ~/afs-labs && LAB_HOST=<host address> AFS_URLS="<server address> [<another>]" sh identity/up.sh'
```

`AFS_URLS` are the addresses of the servers that sign in with the identity lab, as their
`AFS_PUBLIC_URL` says (`https://host:port`): Keycloak accepts their OIDC callbacks. Each lab has a
`down.sh`, which removes its containers; `down.sh purge` also removes what it made.

## Make a server use them

- **Trust**: the server trusts the identity lab's CA with `AFS_CA_FILE` (the file
  `identity/out/certs/ca.pem`, copied where the server reads it, e.g. its data volume). Vault and
  syslog over TLS take their CA in the provider's or destination's own settings
  (`secrets/out/vault-ca.pem`, `streaming/certs/ca.pem`).
- **Secret providers**: a Vault provider with AppRole (`vault-role-id`, `vault-secret-id`) reads
  `secret/lab/switch`; `secret/lab/other` is denied (403).
- **Streaming**: a syslog destination to `LAB_HOST:6514` with the CA, or OTLP HTTP to
  `http://LAB_HOST:4318`. What arrives lands in `streaming/out/rsyslog/` and `streaming/out/otel/`.
- **Sign-in** (release plan 2.6): realm `afs-lab`, issuer `https://LAB_HOST:18843/realms/afs-lab`,
  confidential client `afs` (secret in `identity/out/oidc-client-secret`), groups in the `groups`
  claim. LDAP: `ldaps://LAB_HOST:10636`, bind `cn=admin,dc=example,dc=net`
  (`identity/out/ldap-admin-password`), people under `ou=people,dc=example,dc=net`, groups
  (`groupOfNames`) under `ou=groups,dc=example,dc=net` with the filter `(member={dn})`.

The identity lab's people sign in with the same password in both (`identity/out/people.txt`):

| Login        | Name       | Groups                  |
| ------------ | ---------- | ----------------------- |
| `sam.reyes`  | Sam Reyes  | `net-ops`               |
| `nora.lind`  | Nora Lind  | `change-board`          |
| `lee.okafor` | Lee Okafor | `afs-admins`, `net-ops` |

## Run the tests

A Windows machine with an antivirus that re-signs TLS (Norton) cannot reach the labs' TLS ports.
The `on-vm.mjs` runners run the test in a container on the lab's host instead.

```bash
AFS_SECRETS_LAB_HOST=<host address> node test/e2e/secrets/on-vm.mjs
AFS_URL=<server, as AFS_PUBLIC_URL> AFS_SESSION=<an administrator's session cookie> \
  AFS_SERVER_CA=<the server's certificate> node test/e2e/identity/on-vm.mjs
AFS_TEST_STREAM_LAB=<host address> AFS_TEST_STREAM_READ="ssh gns3 tail -n 2000 afs-labs/streaming/out" \
  npx vitest run test/unit/streamContract.test.ts
```

The identity test needs a session, not a token: the server takes sign-in settings only from a
session. It adds a provider, a directory and groups named `e2e-…` and removes them, with the
lab's people, when it ends. The streaming test's TLS cases (`AFS_TEST_STREAM_CA`) need a
machine whose TLS is not re-signed.
