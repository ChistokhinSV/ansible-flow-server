# ADR-0029: Native install as a systemd service

- Status: accepted (2026-11-14, AFS-36)
- Builds on: ADR-0016 (the executor), ADR-0028 (the container image)

## Context

Some teams run the server on a Linux machine without containers for the server itself; runs
still go in execution environment containers. Distributions do not ship Node.js 24 (Debian 13
has 20, RHEL 10 has 22). Rootless podman is what a service should run containers with when it
can: no root, and no socket that is root's.

## Decision

- **A bundle per architecture** (`linux-x64`, `linux-arm64`), made by `scripts/bundle.sh` and
  attached to each GitHub release by `.github/workflows/release.yml`: the built server, its
  production `node_modules` (no native modules: SQLite is Node's own), the official Node.js 24
  binary checked against its SHASUMS256, and `install.sh`. A SHA-256 is beside each.
- **`install.sh`** installs and upgrades the same way: the release goes to
  `/opt/ansible-flow-server/releases/<v>`, `current` points to it, three are kept; the settings
  (`/etc/ansible-flow-server/afs.env`) and the data (`/var/lib/ansible-flow-server`) are kept;
  the service is stopped, podman's pause process reset, and started; the installer waits for
  `/healthz`. `--uninstall` keeps data, settings and the user; `--purge` removes them.
- **Rootless podman by default:** a system user `afs` (home: the data folder), subordinate ids,
  lingering (its runtime folder lives without a session), cgroupfs and file events (a system
  service has no user session). Each run's image user is mapped to `afs` with
  `--userns=keep-id:uid=,gid=` (the executor), so the run folder stays the server's.
- **Docker when asked, as root:** an unprivileged user in the docker group is root in all but
  name, and a root server gives each run folder to its image's user (ADR-0016), as the container
  image does. Switching engine on an upgrade changes the data's owner (podman's own storage
  excepted).
- **The unit's limits:** `ProtectSystem=full`; not `NoNewPrivileges` (newuidmap is setuid) nor
  `ProtectKernelTunables` (crun sets sysctls in each container's /proc/sys; a pause process made
  under it kept failing every container until reset).
- **SELinux:** the data folder is labelled `container_file_t` (it is mounted into runs) and the
  user's image storage as `/var/lib/containers`; files are copied without their labels from the
  unpacked bundle (`user_tmp_t` would keep systemd from running Node); `semanage` is required.
- **The command line** `/usr/local/bin/ansible-flow-server` runs the server's commands as the
  service's user with its settings; its full path is used with sudo (RHEL's `secure_path`).

## Consequences

- One bundle is about 56 MB; the Node.js version is the one tested.
- Downgrades are by hand (the database changes forward only): point `current` back and restore
  the data taken before the upgrade.
- The images runs use live in `afs`'s own podman storage (in the data folder).

## Alternatives considered

- **System Node.js:** smaller, but no distribution ships 24 yet; a NodeSource repository would
  be one more thing to install and trust.
- **An arbitrary user in the image (`--user`) with docker:** Ansible then signs in to devices as
  that user by default, and has no home for its temporary files; rejected.
- **Packages (.deb, .rpm):** later, built from the same bundle.
