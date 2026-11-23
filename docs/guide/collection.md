# Ansible collection

[The guide](README.md)

The collection [`chistokhinsv.ansible_flow`](https://galaxy.ansible.com/ui/repo/published/chistokhinsv/ansible_flow/)
drives the server from playbooks through the API: launch a run and gate on it (CI, or a flow
that launches another), decide an approval, and keep workspaces, projects, launch
configurations, credentials, schedules and grants as code.

```bash
ansible-galaxy collection install chistokhinsv.ansible_flow
```

```yaml
- hosts: localhost
  module_defaults:
    group/chistokhinsv.ansible_flow.afs:
      url: https://afs.example.net
      token: "{{ afs_token }}"
  tasks:
    - name: Patch the edge switches and wait for the run
      chistokhinsv.ansible_flow.run:
        workspace: network
        project: edge
        launch_config: Patch edge
        mode: real
        wait: true
```

**In every run.** A run has the collection that came with the server (mounted into its container,
whatever the image), and `AFS_URL`, `AFS_TOKEN` and `AFS_VALIDATE_CERTS` set: a step of a flow can
launch another flow, wait for it or read a run with no connection options. The token acts as whoever
launched the run, on the run's workspace only, decides no approval, is in nobody's list of tokens and
ends with the run (a run that waits for a person gets a new one when it goes on). The address is
`AFS_RUN_URL`, else `AFS_PUBLIC_URL` (without either, runs get no address and no token); the
certificate is checked unless it is the server's own self-signed one (`AFS_RUN_VERIFY_TLS` decides
otherwise). In a skeleton run, launching modules launch nothing (Ansible's check mode).

A run that launches another flow of its own project holds one of the project's places
(`AFS_MAX_RUNS_PER_PROJECT`, 1 by default) while the other run waits for one. `run` with
`wait: true` then fails at once and says why, instead of waiting until `wait_timeout`: launch it
in another project, or let the project run more at once.

**Values back from a flow.** A flow gives values back with its outputs (the designer's Run outputs:
a step's output, per host). The run keeps them (at most 256 KB) and shows them on its page under
**Outputs**; `run` and `run_relaunch` with `wait: true` and `run_info` return them as `outputs`,
the API in the run's view (`GET /api/v1/runs/<id>/view`, `summary.outputs`) and MCP in
`run_status`. A flow that launched another can give back what it got in turn.

Its modules, options and tests: [collection/ansible_collections/chistokhinsv/ansible_flow](../../collection/ansible_collections/chistokhinsv/ansible_flow/README.md).
It is published to Ansible Galaxy by the Release workflow.
