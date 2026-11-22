# Execution environments

[The guide](README.md)

The image a run happens in. A workspace keeps its own **execution environments**: built by the
server from a spec, or an image that exists already. A launch configuration chooses one, and each
launch gets that environment's newest good build (the run records the exact image). Without one, a
launch configuration's own image, else the server's default image, is used.

**The server's default image** is what runs get when their launch configuration names no
environment or image. It starts as `AFS_EE_IMAGE`. An administrator can make an environment the
default instead (**Make it the server's default** on its page; **Go back to AFS_EE_IMAGE** undoes
it): build one with the collections the team always needs, and runs without an environment get its
newest good image. While the environment picked has no image yet, `AFS_EE_IMAGE` is used. The
environments list and each environment's page say which image is the default; a run's **What ran**
names the image it got, marked as the server's default. The default environment cannot be deleted
until another is picked.

- **A spec**: ansible-core (`2.19` is the newest 2.19.x), collections each with a version, a range
  as `requirements.yml` writes it (`>=8.0.0,<9`) or `latest`, Python packages (pip requirements),
  Debian packages and extra certificate authorities. The base is a Python image, by default the
  one the designer's `afd-ee` image uses, and the image is made the same way: collections in
  `/usr/share/ansible/collections`, user `ansible` (uid 1000), SSH host keys checked.
- **A build**: `latest` and ranges are settled against `AFS_GALAXY_URL` into a lock (exact
  versions, kept with the build); the image is built on the server's container engine, tagged
  `afs-ee/<workspace>-<environment>:<hash of what went in>`, then asked what it holds (ansible-core
  and its collections). Builds go one at a time; each has a log. Collection server out of reach:
  pin exact versions, or point `AFS_GALAXY_URL` at one that can be reached.
- **An existing image** is pulled (or, when it has no registry, the engine's copy is used) and
  read the same way. Its page calls each try a pull (**Pulls**, "Pull 2 failed"), and the launch
  configuration's picker marks one whose last pull failed "(could not be pulled)".
- Images of builds beyond an environment's newest few (`keep`, 3) are removed from the engine.
- The **ansible-builder file** (`execution-environment.yml`, version 3) describes the same
  environment for AWX or AAP: ansible-core, ansible-runner, the collections at the versions the
  newest build settled, Python packages, certificates. It builds on `quay.io/centos/centos:stream9`
  (ansible-builder installs with dnf); Debian package names are listed for a person to translate.
- `ro` on the workspace reads environments, builds and logs; `rw` adds, changes, builds and deletes
  them. An environment a launch configuration uses cannot be deleted.

| Address (under `/api/v1`)                         | Does                                                                           | Who                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------- |
| `GET`, `POST /workspaces/:id/environments`        | A workspace's environments; add one (`kind`: `spec` or `image`)                | `ro`, `rw` on the workspace |
| `GET`, `PATCH`, `DELETE /environments/:id`        | One environment: what runs get now (`current`), what it holds (`catalog`)      | `ro`, `rw`                  |
| `GET`, `POST /environments/:id/builds`            | Its builds (state, image, lock, catalog); build now                            | `ro`, `rw`                  |
| `GET /environments/:id/builds/:build/log`         | A build's log                                                                  | `ro`                        |
| `GET /environments/:id/execution-environment.yml` | The ansible-builder file                                                       | `ro`                        |
| `GET /default-environment`                        | The server's default image, and the environment picked for it                  | signed in                   |
| `PUT /default-environment`                        | `{"environment": id}` makes it the default; `null` goes back to `AFS_EE_IMAGE` | administrators              |

```json
{
  "name": "net-tools",
  "kind": "spec",
  "spec": {
    "ansibleCore": "2.19",
    "collections": [
      { "name": "cisco.ios", "version": "latest" },
      { "name": "ansible.netcommon", "version": ">=8.0.0,<9" }
    ],
    "python": ["netaddr>=1.3"],
    "system": ["iputils-ping"]
  }
}
```

**What a flow needs.** A launch configuration's page compares what its flow needs with what its
environment's image holds: the collections its steps run (a module or role named by its full name;
a step chosen from the designer's module catalog asks for at least the version it was made against)
and the project's `collections/requirements.yml`, which wins. Each collection is in the image at a
fitting version, at another, or missing. **Make an environment for this flow** adds one whose spec
is exactly those needs and builds it. In a spec, the collections are a table of names and versions; **Add a collection** searches
`AFS_GALAXY_URL` (collections already in the spec are not offered; one removed is offered again),
and **Add an empty row** is for typing a name and version (also when the collection server cannot
be reached). The base image and extra certificate authorities are folded under the packages.
**Save the spec** and **Build** sit together at the bottom of the spec and stay in sight while it is
long; with changes not saved, **Save and build** saves them first. **Delete the environment** is
the last section of the page.

| Address (under `/api/v1`)                   | Does                                                                   | Who                                |
| ------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------- |
| `GET /launch-configs/:id/environment-check` | The flow's needs against its environment, or another (`?environment=`) | `ro` on the flow                   |
| `POST /launch-configs/:id/environment`      | `{"name"}`: an environment from the flow's needs, built                | `rw` on the flow and the workspace |
| `GET /galaxy/search?q=`                     | Collections on the collection server: newest version, description      | signed in                          |

Not there yet: pushing images to a registry, and rebuilding on a schedule.
