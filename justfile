# Ansible Flow Server task runner. Every build, test and run command goes through here.
set windows-shell := ["pwsh.exe", "-NoLogo", "-NoProfile", "-Command"]
set shell := ["bash", "-cu"]

# List recipes
default:
    @just --list

# Install exact dependencies from package-lock.json
install:
    npm ci --no-fund --no-audit

# Until the Ansible Flow Designer packages are on npm: pack them in a checkout of the designer and
# install the tarballs from vendor/ (default checkout: ../123.Ansible_Studio_VSCODE, or AFD_REPO)
afd-packages:
    node scripts/afd-packages.mjs

# Build the server into dist/
build:
    node scripts/build.mjs

# Type-check (TypeScript 7) and lint/format check (Biome)
check:
    npx --no-install tsc -p tsconfig.json
    npx --no-install biome check .

# Apply Biome formatting and safe lint fixes
fmt:
    npx --no-install biome check --write .

# Unit tests (Vitest); extra args go to vitest
test *args:
    npx --no-install vitest run {{ args }}

# Build, then say what this server is and which flows it reads: `just start`, or with flow files
# `just start path/to/os-upgrade.flow.yaml`
start *flows: build
    node dist/server.js {{ flows }}

# Remove build output
clean:
    node -e "require('node:fs').rmSync('dist', { recursive: true, force: true })"
