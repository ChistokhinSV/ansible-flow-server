#!/usr/bin/env bash
# Installs, upgrades or removes Ansible Flow Server as a systemd service (AFS-36). Run it as root
# from the unpacked release bundle:
#
#   sudo ./install.sh                     install, or upgrade an installed server to this release
#   sudo ./install.sh --engine docker     runs with docker instead of rootless podman
#   sudo ./install.sh --uninstall         remove the service and the program; data and settings stay
#   sudo ./install.sh --uninstall --purge also the data, the settings and the service user
#
# Other options: --prefix DIR (/opt/ansible-flow-server), --data DIR (/var/lib/ansible-flow-server),
# --user NAME (afs), --no-start, --keep N (releases kept for going back, 3).
set -euo pipefail

PREFIX=/opt/ansible-flow-server
DATA=/var/lib/ansible-flow-server
CONF=/etc/ansible-flow-server
USER_NAME=afs
ENGINE=podman
ENGINE_SET=0
START=1
KEEP=3
ACTION=install
PURGE=0
UNIT=/etc/systemd/system/ansible-flow-server.service
WRAPPER=/usr/local/bin/ansible-flow-server
HERE=$(cd "$(dirname "$0")" && pwd)

say() { printf '%s\n' "$*"; }
die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
  --engine) ENGINE=${2:?--engine needs podman or docker}; ENGINE_SET=1; shift 2 ;;
  --prefix) PREFIX=${2:?}; shift 2 ;;
  --data) DATA=${2:?}; shift 2 ;;
  --user) USER_NAME=${2:?}; shift 2 ;;
  --keep) KEEP=${2:?}; shift 2 ;;
  --no-start) START=0; shift ;;
  --uninstall) ACTION=uninstall; shift ;;
  --purge) PURGE=1; shift ;;
  -h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "unknown option $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run it as root (sudo)"
command -v systemctl >/dev/null || die "this needs systemd"

if [ "$ACTION" = uninstall ]; then
  systemctl disable --now ansible-flow-server.service 2>/dev/null || true
  rm -f "$UNIT" "$WRAPPER"
  systemctl daemon-reload
  rm -rf "$PREFIX"
  say "Removed the service and $PREFIX."
  if [ "$PURGE" = 1 ]; then
    loginctl disable-linger "$USER_NAME" 2>/dev/null || true
    # The user's containers and images (rootless podman) go with its home, the data folder.
    if command -v podman >/dev/null && id "$USER_NAME" >/dev/null 2>&1; then
      runuser -u "$USER_NAME" -- podman system reset --force >/dev/null 2>&1 || true
    fi
    rm -rf "$DATA" "$CONF"
    userdel "$USER_NAME" 2>/dev/null || true
    if command -v semanage >/dev/null 2>&1; then
      semanage fcontext -d "$DATA/.local/share/containers" 2>/dev/null || true
      semanage fcontext -d "$DATA(/.*)?" 2>/dev/null || true
    fi
    say "Removed $DATA, $CONF and the user $USER_NAME."
  else
    say "Kept $DATA (data, master key), $CONF (settings) and the user $USER_NAME; --purge removes them."
  fi
  exit 0
fi

# --- what is being installed ---------------------------------------------------------------
[ -x "$HERE/node/bin/node" ] && [ -f "$HERE/app/dist/server.js" ] ||
  die "run it from the unpacked release bundle (node/ and app/ beside it)"
VERSION=$(cat "$HERE/VERSION")
ARCH=$(uname -m)
case "$ARCH" in x86_64) ARCH=x64 ;; aarch64 | arm64) ARCH=arm64 ;; esac
[ "$(cat "$HERE/ARCH")" = "$ARCH" ] || die "this bundle is for linux-$(cat "$HERE/ARCH"), the machine is $ARCH"
"$HERE/node/bin/node" --version >/dev/null || die "the bundled Node.js does not run here"
command -v git >/dev/null || die "git is needed (apt install git / dnf install git)"
case "$ENGINE" in
podman)
  command -v podman >/dev/null ||
    die "podman is needed for runs (apt install podman uidmap / dnf install podman), or --engine docker"
  command -v newuidmap >/dev/null || die "rootless podman needs newuidmap (apt install uidmap / dnf install shadow-utils)"
  ;;
docker) command -v docker >/dev/null || die "docker is not installed" ;;
*) die "--engine is podman or docker" ;;
esac

# --- the service user ----------------------------------------------------------------------
# Rootless podman: a user of its own, with no rights beyond its containers. Docker: root, since
# the engine's socket is root's anyway, and a root server gives each run folder to its image's
# user (as the container image does); an unprivileged user in the docker group would be root
# in all but name.
if [ "$ENGINE" = podman ]; then RUN_AS=$USER_NAME; else RUN_AS=root; fi
if [ "$RUN_AS" != root ] && ! id "$RUN_AS" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin \
    --user-group "$RUN_AS"
  say "Made the service user $RUN_AS."
fi
USER_ID=$(id -u "$RUN_AS")
install -d -m 0750 -o "$RUN_AS" -g "$RUN_AS" "$DATA"
# The data of an install that used the other engine belongs to the user the service runs as
# now; rootless podman's own storage and settings stay its user's.
find "$DATA" -mindepth 1 -maxdepth 1 ! -name .local ! -name .config -exec chown -R "$RUN_AS:$RUN_AS" {} +

if [ "$ENGINE" = podman ]; then
  # Rootless podman maps a range of ids for the containers' users: the system user has none.
  for f in /etc/subuid /etc/subgid; do
    touch "$f"
    if ! grep -q "^$USER_NAME:" "$f"; then
      start=$(awk -F: 'BEGIN{m=100000} {e=$2+$3; if (e>m) m=e} END{print m}' "$f")
      echo "$USER_NAME:$start:65536" >>"$f"
    fi
  done
  # Its runtime folder (/run/user/<id>) stays while it has no session.
  loginctl enable-linger "$USER_NAME"
  # A system service has no user session: cgroupfs and file events, not systemd's.
  install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$DATA/.config" "$DATA/.config/containers"
  if [ ! -f "$DATA/.config/containers/containers.conf" ]; then
    printf '[engine]\ncgroup_manager = "cgroupfs"\nevents_logger = "file"\n' \
      >"$DATA/.config/containers/containers.conf"
    chown "$USER_NAME:$USER_NAME" "$DATA/.config/containers/containers.conf"
  fi
  # SELinux (RHEL family): the data folder is mounted into run containers, so it is container
  # content; the user's image storage is labelled as the system's own (/var/lib/containers).
  # Without these, containers cannot run or read their mounts (found on Rocky 10).
  if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then
    command -v semanage >/dev/null ||
      die "SELinux is on: semanage is needed (dnf install policycoreutils-python-utils)"
    semanage fcontext -a -t container_file_t "$DATA(/.*)?" 2>/dev/null ||
      semanage fcontext -m -t container_file_t "$DATA(/.*)?"
    semanage fcontext -a -e /var/lib/containers "$DATA/.local/share/containers" 2>/dev/null || true
    restorecon -R "$DATA"
    say "SELinux: $DATA labelled for containers."
  fi
  for _ in $(seq 1 20); do [ -d "/run/user/$USER_ID" ] && break; sleep 0.5; done
  runuser -u "$USER_NAME" -- env XDG_RUNTIME_DIR="/run/user/$USER_ID" podman system migrate >/dev/null 2>&1 || true
else
  say "With docker the service runs as root (the engine's socket is root's)."
fi

# --- the program ---------------------------------------------------------------------------
UPGRADE=0
[ -L "$PREFIX/current" ] && UPGRADE=1
RELEASE="$PREFIX/releases/$VERSION"
install -d -m 0755 "$PREFIX/releases"
rm -rf "$RELEASE.new"
# Not cp -a: the bundle's own labels (unpacked in /tmp) would come along, and SELinux keeps
# systemd from running a program labelled as a temporary file (found on Rocky 10).
cp -R --preserve=mode,timestamps "$HERE" "$RELEASE.new"
rm -rf "$RELEASE"
mv "$RELEASE.new" "$RELEASE"
chown -R root:root "$RELEASE"
if command -v restorecon >/dev/null 2>&1; then restorecon -R "$PREFIX" "$DATA" 2>/dev/null || true; fi
ln -sfn "$RELEASE" "$PREFIX/current.new" && mv -T "$PREFIX/current.new" "$PREFIX/current"

fill() {
  sed -e "s|@USER@|$RUN_AS|g" -e "s|@UID@|$USER_ID|g" -e "s|@PREFIX@|$PREFIX|g" \
    -e "s|@DATA@|$DATA|g" -e "s|@ENGINE@|$ENGINE|g" "$1"
}
install -d -m 0750 -o root -g "$RUN_AS" "$CONF"
if [ ! -f "$CONF/afs.env" ]; then
  fill "$HERE/deploy/afs.env" >"$CONF/afs.env"
  chown root:"$RUN_AS" "$CONF/afs.env"
  chmod 0640 "$CONF/afs.env"
  say "Wrote $CONF/afs.env."
else
  say "Kept $CONF/afs.env."
  # An upgrade keeps the settings; an engine named on the command line is the one runs use.
  if [ "$ENGINE_SET" = 1 ]; then
    sed -i "s/^AFS_CONTAINER_ENGINE=.*/AFS_CONTAINER_ENGINE=$ENGINE/" "$CONF/afs.env"
    say "Runs use $ENGINE."
  fi
fi
fill "$HERE/deploy/ansible-flow-server.service" >"$UNIT"
fill "$HERE/deploy/ansible-flow-server" >"$WRAPPER"
chmod 0755 "$WRAPPER"
systemctl daemon-reload
systemctl enable ansible-flow-server.service >/dev/null

# Releases kept for going back (the database is changed forward only: see the README).
ls -1dt "$PREFIX"/releases/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  [ "${old%/}" = "$RELEASE" ] || rm -rf "$old"
done

if [ "$START" = 0 ]; then
  say "Installed $VERSION. Start it: systemctl start ansible-flow-server"
  exit 0
fi
systemctl stop ansible-flow-server.service 2>/dev/null || true
if [ "$ENGINE" = podman ]; then
  # Rootless podman keeps a pause process with its namespaces, made under whatever limits the
  # service had then: a new one is made under this release's unit (found on Ubuntu 24.04).
  (cd / && runuser -u "$USER_NAME" -- env XDG_RUNTIME_DIR="/run/user/$USER_ID" podman system migrate >/dev/null 2>&1) || true
fi
systemctl start ansible-flow-server.service
PORT=$(sed -n 's/^AFS_PORT=//p' "$CONF/afs.env" | tail -1)
TLS=$(sed -n 's/^AFS_TLS=//p' "$CONF/afs.env" | tail -1)
SCHEME=https
[ "${TLS,,}" = off ] && SCHEME=http
for _ in $(seq 1 60); do
  if "$PREFIX/current/node/bin/node" -e "
    const m = require('$SCHEME');
    m.get({ host: '127.0.0.1', port: ${PORT:-8443}, path: '/healthz', rejectUnauthorized: false },
      (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1));
  " 2>/dev/null; then
    if [ "$UPGRADE" = 1 ]; then say "Upgraded to $VERSION; the server answers."; else
      say "Installed $VERSION; the server answers on port ${PORT:-8443}."
      # The full path: sudo's secure_path leaves /usr/local/bin out on RHEL-family systems.
      say "Make the first administrator: sudo $WRAPPER user add <login> --admin"
      say "  (or open the address and use the setup code: journalctl -u ansible-flow-server | grep setup)"
    fi
    exit 0
  fi
  sleep 1
done
die "the server did not answer in a minute: journalctl -u ansible-flow-server"
