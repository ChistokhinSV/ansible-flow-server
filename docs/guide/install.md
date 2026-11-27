# Install and first setup

[The guide](README.md)

## Run with Docker Compose

Published multi-arch images (`amd64`, `arm64`) are available at
`ghcr.io/chistokhinsv/ansible-flow-server` and `chistokhinsv/ansible-flow-server` (see
[deploy/compose](../../deploy/compose)):

```sh
mkdir flow-server && cd flow-server
curl -fsSLO https://raw.githubusercontent.com/ChistokhinSV/ansible-flow-server/main/deploy/compose/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/ChistokhinSV/ansible-flow-server/main/deploy/compose/.env.example
# Edit .env: set AFS_PUBLIC_URL (for example https://flows.example.com:8443)
docker compose up -d
docker compose logs server | grep -i "setup code"
```

- **First administrator and CLI commands**: open the setup URL printed in the log, or run CLI
  commands inside the container:
  `docker compose exec server node dist/server.js user add dana --name "Dana Whitfield" --admin`.
- **Data and master key**: `afs-data` stores SQLite, Git repositories, run outputs, TLS certificates
  and `master.key`. Keep a copy of `master.key` (or set `AFS_MASTER_KEY`) outside the volume —
  stored [credentials](credentials.md) cannot be decrypted without it.
- **PostgreSQL**: set `AFS_DB_PASSWORD` and
  `AFS_DATABASE_URL=postgres://afs:${AFS_DB_PASSWORD}@postgres:5432/afs` in `.env`, then run
  `docker compose --profile postgres up -d`.
- **Container engine and security**: runs start as sibling containers through `AFS_ENGINE_SOCKET`
  (default `/var/run/docker.sock`; rootless Docker: `/run/user/<uid>/docker.sock`). **Whoever can
  use that socket controls the host machine**, and the server runs as `root` inside its container to
  reach it. Set `AFS_ENGINE_DATA_DIR` only if the server cannot auto-detect the host path of its
  data volume.
- **Behind an HTTPS reverse proxy**: set `AFS_TLS=off` and `AFS_TRUSTED_PROXIES` in `.env`. On a
  standalone start `AFS_TLS=off` defaults to port `8080`, whereas `deploy/compose/compose.yaml` sets
  `AFS_PORT=8443` explicitly, so the Compose container continues listening on plain HTTP port `8443`
  unless you change `AFS_PORT` / `AFS_PUBLISH_PORT` (see [HTTPS and the certificate](certificates.md)).
- **Upgrade**: update `AFS_VERSION` **in `.env`**, then run `docker compose pull && docker compose up
  -d` (see [Operations](operations.md)).

## Install as a Linux service

Each [GitHub release](https://github.com/ChistokhinSV/ansible-flow-server/releases) ships standalone
`linux-x64` and `linux-arm64` tarballs bundling the server and Node.js 24 for systemd with rootless
Podman (default) or Docker (tested on Ubuntu 24.04 and Rocky Linux 10 with SELinux enforcing):

```sh
# Debian / Ubuntu: sudo apt install podman uidmap git
# RHEL / Rocky / Alma: sudo dnf install podman git policycoreutils-python-utils

V=1.2.0; A=x64
curl -fsSLO https://github.com/ChistokhinSV/ansible-flow-server/releases/download/v$V/ansible-flow-server-$V-linux-$A.tar.gz
curl -fsSLO https://github.com/ChistokhinSV/ansible-flow-server/releases/download/v$V/ansible-flow-server-$V-linux-$A.tar.gz.sha256
sha256sum -c ansible-flow-server-$V-linux-$A.tar.gz.sha256
tar xzf ansible-flow-server-$V-linux-$A.tar.gz && cd ansible-flow-server-$V-linux-$A
sudo ./install.sh
sudo /usr/local/bin/ansible-flow-server user add dana --name "Dana Whitfield" --admin
```

| Path                                              | Purpose                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `/opt/ansible-flow-server/releases/<v>`           | Installed release (`current` symlink; newest 3 releases kept)    |
| `/etc/ansible-flow-server/afs.env`                | `AFS_*` [configuration](configuration.md), preserved on upgrades |
| `/var/lib/ansible-flow-server`                    | Database, repositories, runs, TLS and `master.key`               |
| `/etc/systemd/system/ansible-flow-server.service` | Systemd unit (`systemctl status ansible-flow-server`)            |
| `/usr/local/bin/ansible-flow-server`              | CLI (`user`, `cert`, `secrets`, `backup`, `restore`)             |

- **Rootless Podman vs Docker**: by default the service runs unprivileged as user `afs` with
  rootless Podman (subordinate IDs and lingering enabled; SELinux labels configured via `semanage`).
  Passing `--engine docker` runs the service as `root`, because access to the Docker socket grants
  root-equivalent control over the machine.
- **RHEL-family `sudo` path**: `sudo`'s `secure_path` omits `/usr/local/bin` on RHEL, Rocky and Alma
  Linux — always pass the full path `sudo /usr/local/bin/ansible-flow-server …`.
- **Upgrade and uninstall**: unpack a new bundle and re-run `sudo ./install.sh`. Run
  `sudo ./install.sh --uninstall` to remove the service while keeping data and settings, or add
  `--purge` to remove data, settings, user and SELinux labels too.

## First project

1. **Create the first administrator**: open the one-time setup URL printed in the startup log
   (`https://flows.example.com:8443/setup?code=…`), or run `docker compose exec server node
   dist/server.js user add dana --name "Dana Whitfield" --admin` (Compose) /
   `sudo /usr/local/bin/ansible-flow-server user add dana --name "Dana Whitfield" --admin` (Linux
   service).
2. **Create a workspace and sample project**: open **All workspaces › Add workspace** (`network`),
   then **Add project** (`firewalls`), set **Start with** to **Firewall firmware upgrade**, and
   click **Start**.
3. **Run a check run**: open the sample launch configuration **Firewalls on localhost**, keep mode
   **Check**, and press **Launch check run** to watch the flow execute on the canvas.
4. **Try a real approval**: grant a colleague `approve` under **Govern › Access**, launch again in
   **Real** mode, and approve or reject the waiting gate from **Inbox** or **Approvals**.

Next: [Edit flows](edit-flows.md), [Import playbooks](import-playbooks.md), and
[Run playbooks](runs.md).

## Compatibility with the designer

Ansible Flow Server embeds the packages (`@ansible-flow/*`) and canvas of
[Ansible Flow Designer](https://github.com/ChistokhinSV/ansible-flow-designer). Major versions match
(`1.x` server runs `1.x` designer flows), and clients inspect `GET /api/v1/meta` for the API
version, supported flow format versions (`designer.formats`), bundled canvas version and enabled
`features`. Flows written in a newer format show _Upgrade the server_ and are not run.

To validate flow files offline without starting the server, run `node dist/server.js check
path/to/flow.flow.yaml` (exits `1` if unreadable). The [API reference](/docs/api) lists `/api/v1/meta`,
`/api/v1/setup` and who may call every endpoint.
