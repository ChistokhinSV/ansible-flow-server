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
    npx --no-install tsc -p tsconfig.web.json
    npx --no-install biome check .

# Apply Biome formatting and safe lint fixes
fmt:
    npx --no-install biome check --write .

# Unit tests (Vitest); extra args go to vitest. The database tests run on SQLite, and on
# PostgreSQL too when AFS_TEST_POSTGRES_URL names a database they may empty
test *args:
    npx --no-install vitest run {{ args }}

# Build, then start the server (settings from the environment and .env; Ctrl+C stops it)
start: build
    node dist/server.js

# Build, then read flow files and say what they are: `just check-flows path/to/a.flow.yaml`
check-flows *flows: build
    node dist/server.js check {{ flows }}

# The server's certificate: `just cert show`, request, install, self-signed, rollback, history
cert *args: build
    node dist/server.js cert {{ args }}

# The people who sign in: `just user list`, add, password, enable, disable, admin
user *args: build
    node dist/server.js user {{ args }}

# The web application with live reload, against a server on port 8080 (`just start` in another terminal)
web-dev:
    npx --no-install vite --config vite.config.mts

# The master key and what is sealed with it: `just secrets status`, rotate (stop the server first)
secrets *args: build
    node dist/server.js secrets {{ args }}

# Remove build output
clean:
    node -e "require('node:fs').rmSync('dist', { recursive: true, force: true })"
