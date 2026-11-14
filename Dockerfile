# Ansible Flow Server as a container (AFS-35). Runs go in sibling containers through the engine's
# socket the server is given (/var/run/docker.sock); the data folder is a volume. See
# deploy/compose/ and README "Run with docker compose".
#
#   docker build -t ansible-flow-server .
#
# The designer's packages come from npm (ADR-0002); the build takes whatever package.json names,
# so vendor/*.tgz of an unreleased designer works too.

ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY . .
RUN npm ci --no-fund --no-audit \
 && node scripts/build.mjs \
 && npm prune --omit=dev --no-fund --no-audit

FROM ${NODE_IMAGE}
# git for projects' repositories; openssh-client for ssh git sources; the docker CLI and buildx
# to start runs and build execution environments through the engine's socket.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg git openssh-client \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && . /etc/os-release \
 && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin \
 && apt-get purge -y gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/ansible-flow-server
COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY deploy/healthcheck.mjs ./healthcheck.mjs

# The server answers on all interfaces of its container; its data is the volume. It runs as root:
# the engine's socket is root's, and the run folders are given to each image's own user.
ENV AFS_HOST=0.0.0.0 \
    AFS_PORT=8443 \
    AFS_DATA_DIR=/var/lib/afs \
    NODE_ENV=production
VOLUME ["/var/lib/afs"]
EXPOSE 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "healthcheck.mjs"]

ENTRYPOINT ["node", "dist/server.js"]

LABEL org.opencontainers.image.title="Ansible Flow Server" \
      org.opencontainers.image.description="Runs Ansible Flow Designer flows for a team" \
      org.opencontainers.image.source="https://github.com/ChistokhinSV/ansible-flow-server" \
      org.opencontainers.image.licenses="MIT"
