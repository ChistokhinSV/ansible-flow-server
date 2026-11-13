# ADR-0006: HTTPS by the server itself, and how its certificate is changed

- Status: accepted (2026-11-13, AFS-11; product-owner decision "HTTPS in version 1, a simple way
  to request and replace certificates")
- Context: the server will carry sign-ins, tokens and the secrets of runs. It must never be
  reachable in the clear, and a team without a proxy in front of it must still get HTTPS

## Decision

**The server ends TLS itself.** Port 8443 unless set.

- **First start:** it makes a self-signed certificate for the host of `AFS_PUBLIC_URL` (when set),
  the address it listens on, the machine's name and localhost. HTTPS works from the first minute;
  browsers warn until a certificate from an authority is installed.
- **Plain HTTP** is answered only on `AFS_HTTP_PORT`, when set, and only with a redirect to HTTPS
  (308). The redirect goes to the public address when the settings name it, else to the host that
  was asked for, and only when that reads as a host. This machine may ask `/healthz` there.
- **Behind a proxy** that does HTTPS: `AFS_TLS=off`. The server then speaks plain HTTP, makes no
  certificate, and takes the word of the proxies in `AFS_TRUSTED_PROXIES` for who asked.
- **Outgoing connections** also trust the authorities in `AFS_CA_FILE`, for a network with its
  own (git, sign-in, mail).

**The certificate** is in `<data folder>/tls` (`src/server/tls/store.ts`): the pair in use, the
pair before it, a waiting request with its key, where the pair came from, and a history.

- **Request:** the server makes the key and a certificate signing request. The key never leaves
  the folder; the request is what goes to the authority.
- **Install:** a certificate (its chain may follow in the same file) with its key; or with no key,
  as the answer to the waiting request; or with no key, as a renewal for the key in use.
- **Checked first, all at once** (`certificateProblems`): the key belongs to the certificate; it
  is valid now; it is a server's certificate, not an authority's; each certificate of the file is
  signed by the next; it is good for the public address's host; TLS accepts the pair. Nothing is
  written unless all pass, and every problem is named.
- **Going back:** the pair before is kept; `rollback` swaps the two.
- **No restart:** the running server watches the folder and gives new connections the new
  certificate (`setSecureContext`). A pair it cannot use is logged and the one in use stays.
- **Expiry:** a warning in the log at start and once a day from 30 days before the end.
- **History:** every change with its time, who made it and the certificate's subject and
  fingerprint, in `history.jsonl`. It joins the audit log when that exists (AFS-22).

**For now the actions are commands** (`cert show | request | install | self-signed | rollback |
history`), run by whoever administers the machine. The page and the REST API come with sign-in
(AFS-12) and the web application (AFS-15): changing the certificate is an administrator's action,
and there is no administrator to check yet. The commands and the page work on the same store.

**Keys** are ECDSA P-256 when the server makes them. An installed key may be RSA (2048 bits or
more) or ECDSA. Keys are files readable by the server's account only; they are not encrypted at
rest, which waits for the secrets key (AFS-17).

**Library:** `@peculiar/x509` makes certificates and requests (Node's own `crypto` reads and
checks them but cannot make them). It needs `reflect-metadata`.

## Alternatives considered

- **HTTPS only through a proxy.** Less code. But the plan's smallest install is one process, and
  "put nginx in front" is the step people skip.
- **Restart to change the certificate.** Simpler than watching. A server that runs flows should
  not stop for a certificate, and runs in flight would be cut.
- **An unauthenticated or loopback-only REST API for the certificate now.** A proxy on the same
  machine makes every request look local. Waiting for sign-in is safer.
- **ACME first.** The plan puts it after 1.0 (AFS-43): internal networks, where this server
  mostly lives, sign requests by hand or with their own authority.

## Consequences

- A person who can write to the data folder can replace the certificate. That is the same person
  who can read the database.
- On a machine whose antivirus answers TLS itself (Norton's Web/Mail Shield does, also for
  127.0.0.1), a client sees the antivirus's certificate, not the server's. The tests detect it and
  check what can still be seen; `cert show` always says what the server really serves.
- PFX files are not read yet; a certificate and key are PEM.
