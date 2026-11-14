#!/usr/bin/env bash
# The native release bundle (AFS-36): the built server, its production dependencies and Node.js,
# per architecture, as ansible-flow-server-<version>-linux-<arch>.tar.gz with a .sha256 beside it.
# Run on Linux after `node scripts/build.mjs`:
#
#   scripts/bundle.sh [x64] [arm64]          default: both; into out/bundle/
#
# The server has no native modules (SQLite is Node's own), so one node_modules serves every
# architecture; only Node itself differs. Node is checked against its SHASUMS256.txt.
set -euo pipefail

NODE_VERSION=${NODE_VERSION:-24.22.3}
OUT=${OUT:-out/bundle}
ARCHES=("$@")
[ ${#ARCHES[@]} -gt 0 ] || ARCHES=(x64 arm64)
VERSION=$(node -p "require('./package.json').version")
[ -f dist/server.js ] || { echo "build first: node scripts/build.mjs" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT" "$WORK/app"
cp -r dist package.json package-lock.json "$WORK/app/"
(cd "$WORK/app" && npm ci --omit=dev --ignore-scripts --no-fund --no-audit >/dev/null)
# Source maps stay (stack traces); nothing else of the build is needed.

curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
for arch in "${ARCHES[@]}"; do
  name="ansible-flow-server-$VERSION-linux-$arch"
  dir="$WORK/$name"
  node_tar="node-v$NODE_VERSION-linux-$arch.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$node_tar" -o "$WORK/$node_tar"
  (cd "$WORK" && grep " $node_tar\$" SHASUMS256.txt | sha256sum -c - >/dev/null)
  mkdir -p "$dir/node" "$dir/deploy"
  tar -xJf "$WORK/$node_tar" -C "$dir/node" --strip-components=1 \
    "node-v$NODE_VERSION-linux-$arch/bin/node" "node-v$NODE_VERSION-linux-$arch/LICENSE"
  cp -r "$WORK/app" "$dir/app"
  cp deploy/native/install.sh "$dir/"
  cp deploy/native/ansible-flow-server.service deploy/native/afs.env deploy/native/ansible-flow-server \
    "$dir/deploy/"
  cp LICENSE README.md CHANGELOG.md "$dir/"
  chmod 0755 "$dir/install.sh" "$dir/deploy/ansible-flow-server"
  echo "$VERSION" >"$dir/VERSION"
  echo "$arch" >"$dir/ARCH"
  tar -czf "$OUT/$name.tar.gz" -C "$WORK" --owner=0 --group=0 "$name"
  (cd "$OUT" && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
  echo "$OUT/$name.tar.gz"
done
