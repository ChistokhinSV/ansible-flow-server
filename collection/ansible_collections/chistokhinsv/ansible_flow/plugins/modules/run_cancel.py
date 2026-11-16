#!/usr/bin/python
# -*- coding: utf-8 -*-
# Copyright (c) 2026 Sergei Chistokhin
# MIT License (see https://opensource.org/license/mit)

from __future__ import annotations

DOCUMENTATION = r"""
module: run_cancel
short_description: Stop a run of Ansible Flow Server
description:
  - Stops a run of Ansible Flow Server, as its Stop button does. A run that waits in the queue or for an
    approval stops at once; a running one at its worker's next look, its container stopped.
  - A run that has ended, or was asked to stop already, is left as it is (C(changed=false)).
  - Needs C(operator) or more on the run's flow.
author:
  - Sergei Chistokhin (@ChistokhinSV)
extends_documentation_fragment:
  - chistokhinsv.ansible_flow.connection
  - ansible.builtin.action_common_attributes
attributes:
  check_mode:
    support: full
  diff_mode:
    support: N/A
  platform:
    platforms: all
options:
  run_id:
    description:
      - The run's id, as RV(chistokhinsv.ansible_flow.run#module:id) returns it.
    type: str
    required: true
    aliases: [id, run]
  wait:
    description:
      - Wait for the run to end.
    type: bool
    default: false
  wait_timeout:
    description:
      - Seconds to wait at most; the task fails when the time is up (the run goes on).
    type: int
    default: 300
  poll_interval:
    description:
      - Seconds between looks at the run while waiting.
    type: int
    default: 5
seealso:
  - module: chistokhinsv.ansible_flow.run
  - module: chistokhinsv.ansible_flow.run_relaunch
"""

EXAMPLES = r"""
- name: Stop a run and wait until it has stopped
  chistokhinsv.ansible_flow.run_cancel:
    url: https://afs.example.net
    token: "{{ afs_token }}"
    run_id: "{{ patch.id }}"
    wait: true
"""

RETURN = r"""
id:
  description: The run's id.
  returned: success
  type: str
  sample: 9b2e4f60-1c3d-4a5b-8e7f-0a1b2c3d4e5f
number:
  description: The run's number in its project.
  returned: success
  type: int
  sample: 42
state:
  description: The run's state.
  returned: success
  type: str
  sample: cancelled
url:
  description: The run's page on the server.
  returned: success
  type: str
  sample: https://afs.example.net/runs/9b2e4f60-1c3d-4a5b-8e7f-0a1b2c3d4e5f
hosts:
  description: How each host ended (C(status) V(ok), V(failed) or V(unreachable); C(reason) for a failed one).
  returned: success
  type: dict
  sample: {edge-r1: {status: ok}}
summary:
  description: The run's summary from its view; null before the run started.
  returned: success
  type: dict
approvals:
  description: The approvals the run waits at, when it waits.
  returned: success
  type: list
  elements: dict
error:
  description: Why the run failed, was stopped or was lost.
  returned: when the run has an error
  type: str
run:
  description: The run's record as the server answers it.
  returned: success
  type: dict
timed_out:
  description: The wait ended before the run did.
  returned: when O(wait=true)
  type: bool
"""

from ansible.module_utils.basic import AnsibleModule
from ansible.module_utils.common.text.converters import to_native

from ansible_collections.chistokhinsv.ansible_flow.plugins.module_utils.afs import (
    FINAL_STATES,
    AFSClient,
    AFSError,
    connection_argument_spec,
    run_result,
    seg,
    wait_for_run,
)


def main():
    spec = connection_argument_spec()
    spec.update(
        run_id=dict(type="str", required=True, aliases=["id", "run"]),
        wait=dict(type="bool", default=False),
        wait_timeout=dict(type="int", default=300),
        poll_interval=dict(type="int", default=5),
    )
    module = AnsibleModule(argument_spec=spec, supports_check_mode=True)
    p = module.params
    client = AFSClient.from_module(module)
    timed_out = None
    try:
        run = client.run(p["run_id"])
        # Ended, or asked to stop already: nothing to do (a wait still waits for the stop).
        changed = run.get("state") not in FINAL_STATES and not run.get("cancelRequested")
        if changed and not module.check_mode:
            run = client.post("/runs/%s/cancel" % seg(run["id"]))
        if p["wait"] and not module.check_mode and run.get("state") not in FINAL_STATES:
            # A run asked to stop waits for nobody: it goes on to its end.
            run, timed_out = wait_for_run(client, run["id"], p["wait_timeout"], p["poll_interval"],
                                          through_approvals=True)
        result = run_result(client, run)
        result["changed"] = changed
        if timed_out is not None:
            result["timed_out"] = timed_out
    except AFSError as e:
        module.fail_json(msg=to_native(e), status=e.status, error=e.error)
    if timed_out:
        module.fail_json(msg="Run %s is still %s after %s seconds: %s" % (
            result["number"], result["state"], p["wait_timeout"], result["url"]), **result)
    module.exit_json(**result)


if __name__ == "__main__":
    main()
