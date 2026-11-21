# Launch configurations

[The guide](README.md)

![A launch configuration's Launch tab](images/launch.png)

A launch configuration is a flow of a project with what a run of it needs, saved under a name.
A launch settles it into a run and puts the run in the queue ([Runs](runs.md)).

```sh
curl ... -X POST https://flows.example.net:8443/api/v1/projects/<project id>/launch-configs \
  -d '{"name":"Upgrade edge firewalls","flowFile":"flows/firewall-upgrade.flow.yaml",
       "inventory":"inventory/hosts.yaml","mode":"check",
       "inputs":{"devices":["fw-edge-01","fw-edge-02"]},"credentials":["<credential id>"]}'
curl ... -X POST https://flows.example.net:8443/api/v1/launch-configs/<id>/check \
  -d '{"mode":"real","inputs":{"target_version":"7.4.1"}}'
```

```json
{
  "launch": {
    "config": "0f3d6f0e-6a53-4d4e-8a55-9d2f0c1b7e21",
    "project": "2a968c91-1ac7-4654-94c8-2eb24a28b10b",
    "commit": "59b2575163b54f0c8a1e7d9b3f2a6c8e1d0b5741",
    "ref": "main",
    "flow": {
      "file": "flows/firewall-upgrade.flow.yaml",
      "key": "firewall-upgrade",
      "name": "Firewall firmware upgrade",
      "version": 1
    },
    "mode": "real",
    "inventory": "inventory/hosts.yaml",
    "inputs": {
      "devices": ["fw-edge-01", "fw-edge-02"],
      "target_version": "7.4.1",
      "backup_dir": "/srv/backups"
    },
    "targets": ["fw-edge-01", "fw-edge-02"],
    "credentials": ["7b1f6c0a-3c1e-4c58-9f0e-2f6a1d4b8e90"]
  }
}
```

| Setting       | Means                                                                       |
| ------------- | --------------------------------------------------------------------------- |
| `flowFile`    | The flow's file in the repository                                           |
| `gitRef`      | Another branch than the project's to take the newest commit of              |
| `commit`      | One commit, always (a pin): 7 to 40 hex digits. Not together with `gitRef`  |
| `inventory`   | The inventory's path in the repository; left out: what `ansible.cfg` names  |
| `eeImage`     | The execution environment's image; left out: the server's default           |
| `mode`        | `check` (a skeleton run, the default) or `real`                             |
| `limit`       | Ansible's limit, for fewer hosts than the flow targets                      |
| `inputs`      | Start values of the flow's inputs. Never one that looks like a secret       |
| `credentials` | Credentials of the workspace a run gets (not a git token)                   |
| `notify`      | Whom its runs tell: `{"when": "failed" or "ended", "to": [logins, groups]}` |

| Address (under `/api/v1`)         | Does                                                       | Who                                  |
| --------------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| `/projects/:id/launch-configs`    | List, each with its `lastRun`; add                         | read: `ro`; change: `rw` on the flow |
| `/launch-configs/:id`             | One, with its `lastRun`; change; delete                    | as above                             |
| `GET /launch-configs/:id/form`    | The flow's inputs as a form, with the start values         | `ro`                                 |
| `POST /launch-configs/:id/check`  | What a launch would run, or 422 with everything in its way | `ro`                                 |
| `POST /launch-configs/:id/facts`  | The hosts it would touch, as the inventory has them        | `operator`                           |
| `POST /launch-configs/:id/launch` | The same, and the run goes in the queue (201 with the run) | `operator`                           |

`lastRun` is the configuration's newest run among the runs you may see: `id`, `number`, `state`,
`createdAt`, and `endedAt` once it has ended. A configuration that has not run has none. A
project's list of flows says the same of each flow.

- **Saved when its settings are there:** the flow, the inventory, the branch or commit, each
  start value and each credential are checked; a refusal names the setting (`field`). An
  environment is picked only when it has an image or a build of it is going ("The environment
  net-tools has no successful build yet: build it first" otherwise). One that has none at launch
  (its build failed, its images were removed) is refused by the launch, and the configuration's
  page says why; the configuration's other settings can still be changed. The hosts the targets reach are checked at
  launch.
- **A flow with errors does not run.** The refusal names the first few (the step and what is
  wrong) and how many more; the answer lists them all (`errors`: each with `step`, the step's
  title, and `node`, its id). On the pages each is a link to the step on the flow's page,
  selected, and opened for editing when you may edit the flow.
- **Read by id**, a configuration also says its credentials by name (`credentialNames`) and its
  environment by name with the image a launch gets now, or why there is none
  (`environmentInfo`). In the list and by id, `flowGone` says that its flow is not on the
  project's branch any more: the project's page does not offer to launch it.
- **Which commit runs:** what the launch names (`ref` or `commit`), else what the configuration
  names, else the newest commit of the project's branch, after a look at the source.
- **At launch** a person may give `mode`, `ref` or `commit`, `limit`, and `inputs` as typed
  text (`"fw-edge-01, fw-edge-02"` is a host list). A secret-looking input is given here and is
  not repeated in the answer.
- **The limit** is Ansible's `--limit`: the run touches only the targeted hosts it matches. On
  the launch page, a moment after the targets or the limit change, the fields say what the
  inventory makes of them: targets it does not have, targets that match no host, and how many
  hosts the limit leaves (none: the run would stop at once). **What would run** says the same.
  A real launch asks first; a launch with targets the inventory does not have names them first.

**On the pages:** a project's page lists its launch configurations. A configuration's page
shows its settings and the launch form:

- Check or real, and another branch or a commit; the form shows the flow's inputs at that
  commit, starting with the configuration's values.
- Secret-looking inputs are typed hidden and never kept.
- Under each input, one line says where it goes: the steps that read it, its default, and what it
  wins over. A flow input reaches the run as an extra var, so it beats a step input of the same
  name and every place in the repository that sets the name (the configuration's inventory,
  `group_vars/`, `host_vars/`, ...), each named with its file and line. The repository's part is
  shown to who may read the project's files.

  ```text
  ntp_server · string
  Read by Set NTP (as server), Check time; default 192.0.2.1; wins over group_vars of edge
  (inventory/group_vars/edge.yml:1), group_vars of all (inventory/group_vars/all.yml:1).
  ```
- **What would run** shows the commit, the inputs as the flow gets them (secrets as `***`), the
  hosts it starts on, the inventory, image and credentials; what stands in the way is shown at
  its field.
- **Launch** (`operator` on the flow) queues the run and opens its page; another branch or
  commit than the configuration's needs `rw`.
- **Keep as start values** (`rw` on the flow) saves the typed values that are not secret as the
  configuration's.
- **Hosts in the inventory** (`operator`): under What would run, the hosts the targets match,
  the names the inventory does not have, and production-looking groups and hosts. Under a host
  list, the inventory's groups are buttons that add or take out a group, each with its number of
  hosts.
- **The header** names the inventory, the environment (with its image, or why it has none), the
  limit, the credentials, and whom its runs tell.

**The hosts, as the inventory has them** (`facts`): the server reads the inventory in the
launch's image, at the launch's commit, with the configuration's environment-variable
credentials (a dynamic source may need a token), the way the run will. It takes the same body as
`check`, and `"groups": true` adds the inventory's groups. Inputs that do not read yet are left
out; only a host list that does not read holds the hosts back.

```json
{
  "facts": {
    "sources": ["inventory/hosts.yaml"],
    "count": 2,
    "hosts": ["fw-edge-01", "fw-edge-02"],
    "unknown": ["fw-lab-09"],
    "uses": [],
    "prod": ["prod"],
    "vault": false,
    "environment": "registry.example.net/ee/network:2 (docker)"
  },
  "groups": ["edge", "lab", "prod"],
  "groupHosts": { "edge": { "count": 2, "hosts": ["fw-edge-01", "fw-edge-02"] } },
  "environment": "registry.example.net/ee/network:2 (docker)",
  "inventory": "inventory/hosts.yaml",
  "commit": "59b2575163b54f0c8a1e7d9b3f2a6c8e1d0b5741"
}
```

Without facts, `factsError` says why (no host typed, nothing matches, the image did not answer).
The image's container stays up two minutes after its last answer, so the next question is
quick; at most four are kept, and a stopping server removes them.
