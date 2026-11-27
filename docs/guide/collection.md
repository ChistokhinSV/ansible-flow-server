# Ansible collection

[The guide](README.md)

The [`chistokhinsv.ansible_flow`](https://galaxy.ansible.com/ui/repo/published/chistokhinsv/ansible_flow/)
collection lets Ansible playbooks launch and wait on flows, decide approvals, and manage server
workspaces, projects, credentials, launch configurations, schedules and grants as code.

```sh
ansible-galaxy collection install chistokhinsv.ansible_flow
```

```yaml
- hosts: localhost
  module_defaults:
    group/chistokhinsv.ansible_flow.afs:
      url: https://flows.example.com:8443
      token: "{{ afs_token }}"
  tasks:
    - name: Run edge baseline and wait for completion
      chistokhinsv.ansible_flow.run:
        workspace: network
        project: edge
        launch_config: Baseline edge switches
        mode: real
        wait: true
      register: edge_run
```

## Built into every run

Every container run automatically mounts the server's bundled `chistokhinsv.ansible_flow` collection
and sets `AFS_URL`, `AFS_TOKEN` and `AFS_VALIDATE_CERTS` (when `AFS_RUN_URL` or `AFS_PUBLIC_URL` is
configured). A flow step can therefore orchestrate child flows with zero connection boilerplate:

- The short-lived run token acts as the launcher within the run's workspace only, cannot decide
  approvals, and expires as soon as the run ends.
- In a **Check** run, child-launching modules honour check mode without starting child runs.
- If a flow calls `run` with `wait: true` on another flow in the _same_ project while
  `AFS_MAX_RUNS_PER_PROJECT` is `1`, it fails immediately with a clear explanation instead of
  deadlocking — place child flows in a separate project or raise the per-project limit.

## Returning flow outputs

Flows that define **Run outputs** in
[Ansible Flow Designer](https://github.com/ChistokhinSV/ansible-flow-designer) record up to 256 KB
of structured per-host output on the run: visible under **Details › Outputs** on the run page, and
returned in `outputs` by `run` (`wait: true`), `run_relaunch`, `run_info`, `GET /api/v1/runs/<id>/view`
and MCP `run_status`.

Full module reference:
[collection/ansible_collections/chistokhinsv/ansible_flow](../../collection/ansible_collections/chistokhinsv/ansible_flow/README.md).
