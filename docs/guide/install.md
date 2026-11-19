# Install

[The guide](README.md)

## Run with docker compose

The server image (`ghcr.io/chistokhinsv/ansible-flow-server`, also on Docker Hub as
`chistokhinsv/ansible-flow-server`; amd64 and arm64) is published for each release. It runs flows
in sibling containers through the engine's socket. The files are in
[deploy/compose](../../deploy/compose).

```sh
mkdir flow-server && cd flow-server
curl -fsSLO https://raw.githubusercontent.com/ChistokhinSV/ansible-flow-server/main/deploy/compose/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/ChistokhinSV/ansible-flow-server/main/deploy/compose/.env.example
# change .env: AFS_PUBLIC_URL at least
docker compose up -d
docker compose logs server | grep -i "setup code"
```

```text
server-1  | [09:44:37 13.11.2026] WARN  Made a master key. Keep a copy somewhere safe: stored credentials cannot be read without it file=/var/lib/afs/master.key key=3fa1c2d4
server-1  | [09:44:37 13.11.2026] WARN  No user yet. Make the first administrator with this setup code: open https://flows.example.net:8443/setup?code=Jq3vN0c4TzWk (or POST /api/v1/setup, or: user add --admin) setup=Jq3vN0c4TzWk
```

- **The first administrator:** open the address in the log line (the setup page under
  `AFS_PUBLIC_URL`, with the code filled in), or
  `docker compose exec server node dist/server.js user add dana --name "Dana Whitfield" --admin`
  (the password is asked).
- **Data:** the `afs-data` volume holds the database (SQLite), repositories, runs, the
  certificate and the master key. Back it up whole; keep a copy of `master.key` (or set
  `AFS_MASTER_KEY`) outside it: without the key, stored credentials cannot be read.
- **PostgreSQL:** set `AFS_DB_PASSWORD` and
  `AFS_DATABASE_URL=postgres://afs:${AFS_DB_PASSWORD}@postgres:5432/afs` in `.env`, then
  `docker compose --profile postgres up -d`. Its data is the `afs-db` volume.
- **HTTPS:** the server makes a self-signed certificate at first start; request or install yours
  on the Server certificate page (see [HTTPS and the certificate](certificates.md)).
  Behind a proxy that does HTTPS: `AFS_TLS=off` (the server then answers plain HTTP on 8080:
  publish that port instead).
- **Runs:** the server starts them with the docker command in its image, through
  `AFS_ENGINE_SOCKET` (default `/var/run/docker.sock`; rootless docker:
  `/run/user/<uid>/docker.sock`). Whoever can use that socket controls the machine: the server
  runs as root in its container for it. It finds where its data volume is on the engine's machine
  by itself; when it cannot (it logs nothing about "The data folder as the engine's machine has
  it"), set `AFS_ENGINE_DATA_DIR`.
- **Upgrade:** set `AFS_VERSION` to the new release, then `docker compose pull && docker compose
  up -d`. The database is changed at start.
- **Build the image yourself:** `docker compose build` from `deploy/compose` in a checkout.

Every `AFS_*` setting ([Configuration](configuration.md)) can go in `.env`.

## Install as a Linux service

Each release has a bundle per architecture (`linux-x64`, `linux-arm64`) on its
[GitHub release](https://github.com/ChistokhinSV/ansible-flow-server/releases): the server, its
dependencies and Node.js 24, with a SHA-256 beside it. It needs systemd, git, and for runs rootless
podman (or docker). Checked on Ubuntu 24.04 and Rocky Linux 10 (SELinux enforcing).

```sh
# Debian, Ubuntu
sudo apt install podman uidmap git
# RHEL, Rocky, Alma
sudo dnf install podman git policycoreutils-python-utils

V=1.0.0; A=x64
curl -fsSLO https://github.com/ChistokhinSV/ansible-flow-server/releases/download/v$V/ansible-flow-server-$V-linux-$A.tar.gz
curl -fsSLO https://github.com/ChistokhinSV/ansible-flow-server/releases/download/v$V/ansible-flow-server-$V-linux-$A.tar.gz.sha256
sha256sum -c ansible-flow-server-$V-linux-$A.tar.gz.sha256
tar xzf ansible-flow-server-$V-linux-$A.tar.gz && cd ansible-flow-server-$V-linux-$A
sudo ./install.sh
sudo /usr/local/bin/ansible-flow-server user add dana --name "Dana Whitfield" --admin
```

```text
Made the service user afs.
SELinux: /var/lib/ansible-flow-server labelled for containers.
Wrote /etc/ansible-flow-server/afs.env.
Installed 1.0.0; the server answers on port 8443.
Make the first administrator: sudo /usr/local/bin/ansible-flow-server user add <login> --admin
```

| Where                                             | What                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| `/opt/ansible-flow-server/releases/<v>`           | The release; `current` points to the one in use (3 are kept)            |
| `/etc/ansible-flow-server/afs.env`                | The settings (any `AFS_*`); kept by upgrades                            |
| `/var/lib/ansible-flow-server`                    | The data: database, repositories, runs, certificate, `master.key`       |
| `/etc/systemd/system/ansible-flow-server.service` | The service: `systemctl status`, `journalctl -u ansible-flow-server`    |
| `/usr/local/bin/ansible-flow-server`              | The command line (`user`, `cert`, `secrets`), run as the service's user |

- **Runs:** with rootless podman (the default) the service runs as the user `afs`, who gets a
  range of subordinate ids and stays logged in (lingering) for its podman. Each run's image user
  is mapped to `afs`, so what a run writes stays the server's. With `--engine docker` the service
  runs as root: the docker socket is root's anyway, and an unprivileged user in the docker group
  would be root in all but name.
- **SELinux** (RHEL family): the installer labels the data folder as container content, and the
  user's image storage as `/var/lib/containers` is labelled; it needs `semanage`.
- **The command line** needs its full path with `sudo` on RHEL-family systems (sudo's
  `secure_path` leaves `/usr/local/bin` out).
- **Upgrade:** unpack the new bundle and run `sudo ./install.sh` again. Settings and data are kept;
  the database is changed at start, forward only. To go back, point `current` to the previous
  release and restart, with a backup of the data taken before the upgrade. `--engine` on an
  upgrade switches the engine runs use.
- **Remove:** `sudo ./install.sh --uninstall` removes the service and the program and keeps the
  data, the settings and the user; `--uninstall --purge` removes them too (and the SELinux
  labels).
- Other options: `--prefix`, `--data`, `--user`, `--keep N`, `--no-start` (`./install.sh --help`).
