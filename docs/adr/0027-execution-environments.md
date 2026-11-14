# ADR-0027: Execution environments

- Status: accepted (2026-11-14, AFS-32). Builds on ADR-0014 (launch configurations), ADR-0016
  (the executor), ADR-0020 (access levels)
- Context: runs need an image with the collections and packages a flow uses. Until now a launch
  configuration named an image by hand, or got `AFS_EE_IMAGE`. Teams need to describe an
  environment once, have the server build it reproducibly, see what it holds, and use it in AWX too

## Decision

**Per workspace, two kinds.** An environment is a spec the server builds, or a registered image
(an image that exists already). `ro` on the workspace reads them; `rw` sets them up and builds
(product owner, 2026-11-14).

**The image is made like afd-ee.** The server renders its own Dockerfile from the spec, in the
shape of the designer's `docker/afd-ee.Dockerfile`: a Python base (the same pinned
`python:3.13-slim` by default), Debian packages, `pip install ansible-core==<x.y>.*` and pip
packages, `ansible-galaxy collection install` into `/usr/share/ansible/collections`, user
`ansible` (uid 1000), host keys checked. ansible-builder is not used for the server's own builds:
it installs with dnf and needs its own toolchain on the server; the spec is exported for it instead.
Nothing in a spec reaches a shell unchecked: collection names, versions, pip requirements and
Debian package names are matched against strict patterns; certificates must be PEM blocks.

**A lock per build.** `latest` and ranges are settled against a collection server
(`AFS_GALAXY_URL`, Galaxy by default; an Automation Hub or private Galaxy otherwise): `latest` is
the newest stable version, a range its newest stable match, an exact version needs no lookup.
The lock (base, the ansible-core the image has, collections at exact versions) is kept with the
build. The image is tagged by a hash of the resolved inputs, so the same lock gives the same tag.

**What it really holds.** After a build (or a pull of a registered image; a local image without a
registry is used as the engine has it) the server runs the image once to read ansible-core's
version and `ansible-galaxy collection list --format json`: the catalog the flow checks of AFS-33
compare against.

**Builds go one at a time** on the run engine (docker or podman), with a log per build and a time
limit (`AFS_BUILD_TIMEOUT_MINUTES`); a server that stops during a build marks it failed at start.
After a good build, images beyond the environment's `keep` newest good builds are removed.

**Launch configurations choose an environment.** A launch gets the environment's newest good
build; none yet is a problem at the `environment` field. The run records the exact image. A
configuration's own image and `AFS_EE_IMAGE` stay for configurations without an environment.

**Export for AWX/AAP.** `execution-environment.yml` (ansible-builder version 3) with ansible-core,
ansible-runner, the newest build's collection versions, Python packages and certificates, on
`quay.io/centos/centos:stream9`; Debian package names are left in a comment for a person.

**Not in this version** (product owner): pushing images to a registry, and scheduled rebuilds of
`latest`; separate tickets.

## Consequences

- An environment is described once, built the same way each time, and checked for what it holds.
- Builds use the server's engine and its network: Galaxy, PyPI and Debian mirrors must be reachable
  from it (or a private Galaxy with `AFS_GALAXY_URL` and certificates in the spec).
- Images live on the engine of this server; remote execution agents (AFS-50) will need the push.
