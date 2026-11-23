<img src="https://raw.githubusercontent.com/ChistokhinSV/ansible-flow-server/main/media/icons/png/afs-icon-128.png" alt="" width="96" align="right" />

# chistokhinsv.ansible_flow

An Ansible collection that drives [Ansible Flow Server](https://github.com/ChistokhinSV/ansible-flow-server)
through its REST API:

- launch runs of launch configurations and gate a pipeline on how they end;
- read runs, and decide the approvals they wait at;
- keep workspaces, projects, credentials, launch configurations, schedules and grants as code, idempotently,
  with check mode and diff.

The modules need nothing but ansible-core 2.17 or newer: they use Python's standard library to talk to the
server over HTTPS.

## Install

```sh
ansible-galaxy collection install chistokhinsv.ansible_flow
```

Or in `requirements.yml`:

```yaml
collections:
  - name: chistokhinsv.ansible_flow
    version: ">=0.0.1"
```

## Connect to the server

Every module takes the same connection options:

| Option           | Environment variable | Default | What                                                    |
| ---------------- | -------------------- | ------- | ------------------------------------------------------- |
| `url`            | `AFS_URL`            |         | The server's address, such as `https://afs.example.net` |
| `token`          | `AFS_TOKEN`          |         | An access token (sent as `Authorization: Bearer`)       |
| `validate_certs` | `AFS_VALIDATE_CERTS` | `true`  | Check the server's TLS certificate                      |
| `ca_path`        | `AFS_CA_PATH`        |         | PEM file of the CA that signed the certificate          |
| `timeout`        |                      | `30`    | Seconds to wait for each answer                         |

Make a token on the server's Tokens page (or, as an administrator, one for a service account). The token can
do what its owner may: launching needs the operator level on the flow, deciding an approval the approve grant,
making workspaces, projects, credentials and grants an administrator. The token is never logged or returned.

Set the connection once for every module of the collection with the `afs` action group:

```yaml
- name: Work with Ansible Flow Server
  hosts: localhost
  gather_facts: false
  module_defaults:
    group/chistokhinsv.ansible_flow.afs:
      url: https://afs.example.net
      token: "{{ vault_afs_token }}"
  tasks:
    - name: Launch Patch edge
      chistokhinsv.ansible_flow.run:
        workspace: network
        project: edge
        launch_config: Patch edge
```

or export `AFS_URL` and `AFS_TOKEN` and leave the options out.

## In a flow on the server: no settings

A run on Ansible Flow Server has this collection, the version that came with the server, whatever
image it runs in, and `AFS_URL`, `AFS_TOKEN` and `AFS_VALIDATE_CERTS` set for it. The token acts as
whoever launched the run, on the run's workspace only, and ends with the run; it never decides an
approval. So a step of a flow can launch another flow and wait for it with no connection options:

```yaml
- name: Back up the edge switches first
  chistokhinsv.ansible_flow.run:
    workspace: network
    project: edge
    launch_config: Back up edge
    wait: true
```

A flow gives values back with its outputs (the designer's Run outputs): `run` with `wait: true`,
`run_relaunch` with `wait: true` and `run_info` return them per host as `outputs`:

```yaml
- name: Back up the edge switches first
  chistokhinsv.ansible_flow.run:
    workspace: network
    project: edge
    launch_config: Back up edge
    wait: true
  register: backup

- name: Use each switch's backup file
  ansible.builtin.debug:
    msg: "{{ backup.outputs[inventory_hostname].backup_file }}"
```

In a skeleton (check mode) run, `run` and `run_relaunch` launch nothing: Ansible's check mode asks
modules to change nothing.

## Launch a run and gate CI on it

```yaml
- name: Check the change, then make it
  hosts: localhost
  gather_facts: false
  module_defaults:
    group/chistokhinsv.ansible_flow.afs:
      url: "{{ lookup('env', 'AFS_URL') }}"
      token: "{{ lookup('env', 'AFS_TOKEN') }}"
  tasks:
    - name: A check run of Patch edge; fails the job unless it succeeds
      chistokhinsv.ansible_flow.run:
        workspace: network
        project: edge
        launch_config: Patch edge
        mode: check
        inputs:
          devices: [edge-r1, edge-r2]
        wait: true
        wait_timeout: 1800
      register: check

    - name: How each host ended
      ansible.builtin.debug:
        msg: "{{ check.url }}: {{ check.hosts }}"

    - name: The real run; returns when it waits for approval
      chistokhinsv.ansible_flow.run:
        workspace: network
        project: edge
        launch_config: Patch edge
        mode: real
        inputs:
          devices: [edge-r1, edge-r2]
        wait: true
      register: real

    - name: Tell the change channel where to approve it
      ansible.builtin.debug:
        msg: "Run {{ real.number }} waits for {{ real.approvals | map(attribute='node.title') | join(', ') }}: {{ real.url }}"
      when: real.state == 'waiting'
```

With `wait: true` the module fails when the run ends `failed`, `cancelled` or `lost` (unless
`fail_on_failure: false`), and when `wait_timeout` is up while the run still goes. `wait_for_approvals: true`
keeps waiting while someone decides. In Ansible check mode nothing is launched.

## Decide an approval

```yaml
- name: Approve the change of the real run
  chistokhinsv.ansible_flow.approval:
    run_id: "{{ real.id }}"
    node: approve-change
    decision: approved
    comment: Change window CHG-1042 is open
```

Deciding it again the same way changes nothing; an approval already decided the other way (or timed out) fails
and says who decided it.

## Read runs

```yaml
- name: A run with the last 50 lines of its output
  chistokhinsv.ansible_flow.run_info:
    run_id: "{{ real.id }}"
    output_lines: 50
  register: info

- name: The last five failed runs of Patch edge
  ansible.builtin.debug:
    msg: "{{ item.number }} {{ item.createdAt }} {{ item.error | default('') }}"
  loop: "{{ query('chistokhinsv.ansible_flow.runs', workspace='network', project='edge',
    config='Patch edge', state='failed', limit=5) }}"
```

## Bootstrap a server as code

```yaml
- name: The network workspace of Ansible Flow Server
  hosts: localhost
  gather_facts: false
  module_defaults:
    group/chistokhinsv.ansible_flow.afs:
      url: https://afs.example.net
      token: "{{ vault_afs_admin_token }}"
  tasks:
    - name: Workspace
      chistokhinsv.ansible_flow.workspace:
        key: network
        name: Network
        description: Routers, switches and firewalls of the edge

    - name: Token to read the repository
      chistokhinsv.ansible_flow.credential:
        workspace: network
        name: git-reader
        kind: git_token
        fields: { username: afs-reader }
        secret: { token: "{{ vault_git_token }}" }

    - name: The SSH key runs sign in with
      chistokhinsv.ansible_flow.credential:
        workspace: network
        name: netops-ssh
        kind: ssh_key
        fields: { username: netops }
        secret: { privateKey: "{{ lookup('file', 'files/netops_ed25519') }}" }

    - name: Project mirrored from git
      chistokhinsv.ansible_flow.project:
        workspace: network
        key: edge
        name: Edge
        git_url: https://git.example.net/netops/edge-flows.git
        git_credential: git-reader
        poll_seconds: 300
        sync: true

    - name: Launch configuration
      chistokhinsv.ansible_flow.launch_config:
        workspace: network
        project: edge
        name: Patch edge
        flow_file: flows/patch/patch.flow.yaml
        inventory: inventories/prod/hosts.yml
        mode: check
        credentials: [netops-ssh]
        notify: { when: failed, to: [dana, netops] }

    - name: Nightly check run
      chistokhinsv.ansible_flow.schedule:
        workspace: network
        project: edge
        launch_config: Patch edge
        name: Nightly check
        kind: cron
        cron: "0 3 * * 1-5"
        timezone: Europe/Berlin

    - name: The netops group operates the workspace
      chistokhinsv.ansible_flow.grant:
        workspace: network
        group: netops
        level: operator

    - name: Dana decides approvals of the patch flow
      chistokhinsv.ansible_flow.grant:
        workspace: network
        user: dana
        level: approve
        project: edge
        flow: flows/patch/patch.flow.yaml
```

Run it again and nothing changes. Only the options given are compared; an option set to `""` clears a
setting that can be empty (a description, a limit, a pinned commit). Run with `--check --diff` to see what
would change.

Credentials keep their secret sealed on the server and never give it back, so it cannot be compared: the
secret is sent when the credential is made (`update_secret: on_create`, the default). To rotate it, run with
`update_secret: always`, which sends it every time.

## Modules and plugins

| Name                                      | What                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `chistokhinsv.ansible_flow.run`           | Launch a launch configuration, optionally wait and gate on the result |
| `chistokhinsv.ansible_flow.run_info`      | Read a run: state, hosts, approvals, output tail                      |
| `chistokhinsv.ansible_flow.run_cancel`    | Stop a run, optionally wait until it has stopped                      |
| `chistokhinsv.ansible_flow.run_relaunch`  | Run a run again: all hosts, or those that did not go well; wait       |
| `chistokhinsv.ansible_flow.approval`      | Approve or reject an approval a run waits at                          |
| `chistokhinsv.ansible_flow.workspace`     | Workspaces                                                            |
| `chistokhinsv.ansible_flow.project`       | Projects: mirrors of a repository, or hosted (from a sample); sync    |
| `chistokhinsv.ansible_flow.credential`    | Credentials of a workspace (secrets are write-only)                   |
| `chistokhinsv.ansible_flow.launch_config` | Launch configurations of a project                                    |
| `chistokhinsv.ansible_flow.schedule`      | Schedules of a launch configuration                                   |
| `chistokhinsv.ansible_flow.grant`         | Access levels of users and groups in a workspace or on a flow         |
| `chistokhinsv.ansible_flow.runs` (lookup) | List runs by project, configuration, flow, state, who launched        |

`ansible-doc chistokhinsv.ansible_flow.<name>` shows every option and return value.

## Run the tests

The tests run with `ansible-test` from the collection's folder, which must sit under
`ansible_collections/chistokhinsv/ansible_flow` (as it does in the repository's `collection/` folder).

Unit tests (the HTTP layer is mocked):

```sh
cd collection/ansible_collections/chistokhinsv/ansible_flow
ansible-test units --python 3.12
```

Sanity tests:

```sh
ansible-test sanity --python 3.12 --requirements
```

Without a local Python with ansible-core, the same in Docker:

```sh
docker run --rm -v "$PWD/collection:/work" -w /work/ansible_collections/chistokhinsv/ansible_flow python:3.13 \
  bash -c "pip install -q ansible-core pytest pytest-xdist && ansible-test units --python 3.13 && ansible-test sanity --python 3.13 --requirements"
```

Integration tests talk to a real server, so they run only when asked (`--allow-unsupported`) and need an
administrator's token. They make a workspace with a unique name, a hosted project from the server's `hello`
sample, a credential, a launch configuration, a schedule and a grant, launch a check run on `localhost` and
wait for it, then remove all of it.

Give the server in `tests/integration/integration_config.yml` (git ignores it):

```yaml
afs_url: https://afs.example.net
afs_token: "<an administrator's token>"
afs_validate_certs: true
```

then:

```sh
ansible-test integration --allow-unsupported afs_resources afs_runs
```

`ansible-test` passes only some environment variables to the playbooks; when it passes `AFS_URL`,
`AFS_TOKEN` and `AFS_VALIDATE_CERTS`, those work too.

The run target needs a server whose runs can start (a worker and its execution environment image).

## License

MIT
