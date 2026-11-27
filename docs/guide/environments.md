# Execution environments

[The guide](README.md)

Every run executes inside an **execution environment** container image. Under **Build ›
Environments**, editors (`rw` on the workspace) manage two kinds of environments:

- **Built from a spec**: specify an `ansible-core` version (for example `2.19`), Galaxy collections
  (exact version, range like `>=8.0.0,<9`, or `latest`), Python packages (`pip`), Debian packages
  and extra CA certificates.
  - **Save and build** resolves versions against `AFS_GALAXY_URL` into a reproducible lock, builds
    the image on the container engine, indexes its installed collections, and keeps the newest
    builds (`3` by default).
  - Use **Add a collection** to search Galaxy (or your private hub), or **Add an empty row** when
    working offline with pinned versions.
- **Existing image**: point at a container image tag (`registry.example.com/ee/network:2`). Each
  **Pull** fetches and indexes its collections; private registries authenticate with a workspace
  `registry` [credential](credentials.md) on the launch configuration.

## Matching what a flow needs

A launch configuration checks the collections required by its flow's steps (and the repository's
`collections/requirements.yml`) against its environment's image:

- When every required collection is present at a compatible version, the table folds neatly under
  **Collections (N)**.
- When a collection is missing or mismatched, the table stays open and offers **Make an environment
  for this flow** (`rw`) to generate and build a matching spec in one click.

## Default image and AWX export

- **Server default image**: runs whose launch configuration names no environment use `AFS_EE_IMAGE`
  until an administrator opens a built environment and clicks **Make it the server's default**
  (**Go back to AFS_EE_IMAGE** resets it).
- **`ansible-builder` export**: every spec environment offers an `execution-environment.yml`
  (version 3) download with its locked collection versions, Python packages and CAs for AWX or Red
  Hat Ansible Automation Platform.
