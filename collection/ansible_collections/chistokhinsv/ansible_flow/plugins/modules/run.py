#!/usr/bin/python
# -*- coding: utf-8 -*-
# Copyright (c) 2026 Sergei Chistokhin
# MIT License (see https://opensource.org/license/mit)

from __future__ import annotations

DOCUMENTATION = r"""
module: run
short_description: Launch a run of an Ansible Flow Server launch configuration
description:
  - Launches a launch configuration of Ansible Flow Server, as its Launch button does, and puts the run
    in the server's queue.
  - Optionally waits for the run to end and fails when it did not succeed, so a pipeline can gate on it.
  - A run of a flow with approvals stops in state V(waiting) until someone decides; the module returns
    then, or keeps waiting with O(wait_for_approvals=true).
author:
  - Sergei Chistokhin (@ChistokhinSV)
extends_documentation_fragment:
  - chistokhinsv.ansible_flow.connection
  - ansible.builtin.action_common_attributes
attributes:
  check_mode:
    support: full
    details:
      - In check mode the launch configuration is looked up but nothing is launched; the result is changed.
  diff_mode:
    support: none
  platform:
    platforms: all
options:
  launch_config:
    description:
      - The launch configuration to launch.
      - Its name when O(workspace) and O(project) are given, else its id.
    type: str
    required: true
    aliases: [config]
  workspace:
    description:
      - The key (or id) of the workspace of O(project).
    type: str
  project:
    description:
      - The key (or id) of the project of the launch configuration.
    type: str
  inputs:
    description:
      - Values of the flow's inputs for this run, over the start values of the launch configuration.
      - Each value is sent as text, as the launch form takes it; lists and dicts are sent as JSON.
    type: dict
    default: {}
  secret_inputs:
    description:
      - Inputs whose values are secret, such as a password the flow takes at launch.
      - Merged with O(inputs); never logged. The server shows secret-looking inputs of a run as C(***).
    type: dict
    default: {}
  mode:
    description:
      - V(check) for a check run (Ansible check mode), V(real) for a run that changes the hosts.
      - If not set, the launch configuration's mode is used; a new configuration is V(check) unless set otherwise.
    type: str
    choices: [check, real]
  ref:
    description:
      - Another branch to run the newest commit of than the one the configuration names.
      - Needs rw on the flow, not only operator.
    type: str
  commit:
    description:
      - One commit (40 hex characters) to run. Needs rw on the flow.
    type: str
  limit:
    description:
      - Ansible's C(--limit) for this run.
    type: str
  wait:
    description:
      - Wait for the run to end (or to wait for an approval) before returning.
    type: bool
    default: false
  wait_timeout:
    description:
      - Seconds to wait at most with O(wait=true). When the time is up the module fails; the run goes on.
    type: int
    default: 3600
  poll_interval:
    description:
      - Seconds between two looks at the run while waiting.
    type: int
    default: 5
  wait_for_approvals:
    description:
      - With O(wait=true), keep waiting while the run waits for an approval, until someone decides and
        the run ends.
      - If V(false), the module returns as soon as the run waits, with RV(state=waiting) and the
        approvals in RV(approvals).
    type: bool
    default: false
  fail_on_failure:
    description:
      - With O(wait=true), fail when the run ended V(failed), V(cancelled) or V(lost).
    type: bool
    default: true
notes:
  - Launching needs the operator level on the flow (or rw, for O(ref), O(commit)); a token of an operator
    or a service account with that grant is enough.
seealso:
  - module: chistokhinsv.ansible_flow.run_info
  - module: chistokhinsv.ansible_flow.approval
  - plugin: chistokhinsv.ansible_flow.runs
    plugin_type: lookup
"""

EXAMPLES = r"""
- name: Launch Patch edge as a check run and wait for it
  chistokhinsv.ansible_flow.run:
    url: https://afs.example.net
    token: "{{ afs_token }}"
    workspace: network
    project: edge
    launch_config: Patch edge
    inputs:
      devices: [edge-r1, edge-r2]
      maintenance_window: 30
    wait: true
    wait_timeout: 1800
  register: patch
  delegate_to: localhost

- name: Show how each host ended
  ansible.builtin.debug:
    var: patch.hosts

- name: Launch a real run, return when it waits for approval
  chistokhinsv.ansible_flow.run:
    workspace: network
    project: edge
    launch_config: Patch edge
    mode: real
    secret_inputs:
      enable_password: "{{ vault_enable_password }}"
    wait: true
  register: real_run

- name: Launch by the configuration's id and do not fail on a failed run
  chistokhinsv.ansible_flow.run:
    launch_config: 4d1c2a8e-5b7f-4e0a-9c3d-2f6b8a1e7c90
    wait: true
    fail_on_failure: false
"""

RETURN = r"""
id:
  description: The run's id.
  returned: success, not in check mode
  type: str
  sample: 9b2e4f60-1c3d-4a5b-8e7f-0a1b2c3d4e5f
number:
  description: The run's number in its project.
  returned: success, not in check mode
  type: int
  sample: 42
state:
  description:
    - The run's state when the module returned.
    - One of V(queued), V(running), V(waiting), V(succeeded), V(failed), V(cancelled), V(lost).
  returned: success, not in check mode
  type: str
  sample: succeeded
url:
  description: The run's page on the server.
  returned: success, not in check mode
  type: str
  sample: https://afs.example.net/runs/9b2e4f60-1c3d-4a5b-8e7f-0a1b2c3d4e5f
hosts:
  description:
    - How each host ended, from the run's view; empty before the run started.
    - Each value has C(status) (V(ok), V(failed) or V(unreachable)) and, for a failed host, C(reason).
  returned: success, not in check mode
  type: dict
  sample:
    edge-r1:
      status: ok
    edge-r2:
      status: failed
      reason: "open port fail of [backup]"
outputs:
  description:
    - What the run gave back, per host - the flow's outputs (the designer's Run outputs) - once it ended. A host
      without a value is left out; empty while the run goes on, and for a flow that gives nothing back.
  returned: success
  type: dict
  sample: {edge-r1: {backup_file: /backups/edge-r1-2026-11-16.cfg}}
summary:
  description: The run's summary as the server keeps it (per step and port, the hosts that left through it).
  returned: success, not in check mode
  type: dict
approvals:
  description: The run's approvals, when it waits for one.
  returned: success, not in check mode
  type: list
  elements: dict
  sample:
    - node: {id: 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3, key: approve-change, title: Approve the change}
      status: waiting
      approvers: [netops]
      mayDecide: true
error:
  description: Why the run failed or was lost, as the server says it.
  returned: when the run has an error
  type: str
run:
  description: The run's record as the server answers it.
  returned: success, not in check mode
  type: dict
launch_config:
  description: The launch configuration that was (or, in check mode, would be) launched.
  returned: success
  type: dict
  sample: {id: 4d1c2a8e-5b7f-4e0a-9c3d-2f6b8a1e7c90, name: Patch edge, flowFile: flows/patch/patch.flow.yaml, mode: check}
timed_out:
  description: The wait ended because O(wait_timeout) was up.
  returned: when O(wait=true)
  type: bool
"""

from ansible.module_utils.basic import AnsibleModule
from ansible.module_utils.common.text.converters import to_native

from ansible_collections.chistokhinsv.ansible_flow.plugins.module_utils.afs import (
    FAILED_STATES,
    AFSClient,
    AFSError,
    connection_argument_spec,
    input_texts,
    run_result,
    seg,
    wait_for_run,
)


def main():
    spec = connection_argument_spec()
    spec.update(
        launch_config=dict(type="str", required=True, aliases=["config"]),
        workspace=dict(type="str"),
        project=dict(type="str"),
        inputs=dict(type="dict", default={}),
        secret_inputs=dict(type="dict", default={}, no_log=True),
        mode=dict(type="str", choices=["check", "real"]),
        ref=dict(type="str"),
        commit=dict(type="str"),
        limit=dict(type="str"),
        wait=dict(type="bool", default=False),
        wait_timeout=dict(type="int", default=3600),
        poll_interval=dict(type="int", default=5),
        wait_for_approvals=dict(type="bool", default=False),
        fail_on_failure=dict(type="bool", default=True),
    )
    module = AnsibleModule(
        argument_spec=spec,
        supports_check_mode=True,
        required_together=[("workspace", "project")],
        mutually_exclusive=[("ref", "commit")],
    )
    p = module.params
    client = AFSClient.from_module(module)
    try:
        config = client.resolve_config(p["launch_config"], p["workspace"], p["project"])
        shown_config = dict((k, config.get(k)) for k in ("id", "name", "project", "flowFile", "mode"))
        if module.check_mode:
            module.exit_json(changed=True, launch_config=shown_config)

        inputs = dict(p["inputs"] or {})
        inputs.update(p["secret_inputs"] or {})
        body = dict(inputs=input_texts(inputs))
        for option in ("mode", "ref", "commit", "limit"):
            if p[option] is not None:
                body[option] = p[option]
        run = client.post("/launch-configs/%s/launch" % seg(config["id"]), body)

        timed_out = None
        # The server says the run waits for the place the run calling this module holds: waiting
        # for it would last until wait_timeout, so the module says why at once.
        held = run.pop("heldByLauncher", None)
        if p["wait"] and held:
            module.fail_json(msg="Run %s cannot start while this run goes. %s." % (
                run.get("number"), held), run=run, id=run.get("id"), number=run.get("number"),
                state=run.get("state"), url=client.run_url(run["id"]), changed=True)
        if p["wait"]:
            run, timed_out = wait_for_run(client, run["id"], p["wait_timeout"], p["poll_interval"],
                                          through_approvals=p["wait_for_approvals"])
        result = run_result(client, run, with_view=bool(p["wait"]))
        result.update(changed=True, launch_config=shown_config)
        if timed_out is not None:
            result["timed_out"] = timed_out
    except AFSError as e:
        module.fail_json(msg=to_native(e), status=e.status, error=e.error)

    if timed_out:
        module.fail_json(msg="Run %s is still %s after %s seconds: it goes on, see %s" % (
            result["number"], result["state"], p["wait_timeout"], result["url"]), **result)
    if p["wait"] and p["fail_on_failure"] and result["state"] in FAILED_STATES:
        module.fail_json(msg="Run %s ended %s%s: %s" % (
            result["number"], result["state"], " (%s)" % result["error"] if result.get("error") else "",
            result["url"]), **result)
    module.exit_json(**result)


if __name__ == "__main__":
    main()
