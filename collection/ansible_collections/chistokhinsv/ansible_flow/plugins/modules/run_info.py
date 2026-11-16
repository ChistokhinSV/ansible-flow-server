#!/usr/bin/python
# -*- coding: utf-8 -*-
# Copyright (c) 2026 Sergei Chistokhin
# MIT License (see https://opensource.org/license/mit)

from __future__ import annotations

DOCUMENTATION = r"""
module: run_info
short_description: Read a run of Ansible Flow Server
description:
  - Reads one run of Ansible Flow Server - its state, how each host ended, its approvals - and, if asked,
    the end of its output.
  - Changes nothing.
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
  output_lines:
    description:
      - How many of the last lines of the run's output to return in RV(output); V(0) for none.
      - The output is plain text, with values of secret inputs hidden by the server.
    type: int
    default: 0
seealso:
  - module: chistokhinsv.ansible_flow.run
  - plugin: chistokhinsv.ansible_flow.runs
    plugin_type: lookup
"""

EXAMPLES = r"""
- name: Read a run and the last 50 lines of its output
  chistokhinsv.ansible_flow.run_info:
    url: https://afs.example.net
    token: "{{ afs_token }}"
    run_id: "{{ patch.id }}"
    output_lines: 50
  register: info

- name: Wait until the run ends
  chistokhinsv.ansible_flow.run_info:
    run_id: "{{ patch.id }}"
  register: info
  until: info.state in ['succeeded', 'failed', 'cancelled', 'lost']
  retries: 60
  delay: 10
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
  sample: waiting
url:
  description: The run's page on the server.
  returned: success
  type: str
  sample: https://afs.example.net/runs/9b2e4f60-1c3d-4a5b-8e7f-0a1b2c3d4e5f
finished:
  description: The run has ended (V(succeeded), V(failed), V(cancelled) or V(lost)).
  returned: success
  type: bool
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
  description: All the approvals the run reached, decided or not, with whether the token's owner may decide each.
  returned: success
  type: list
  elements: dict
error:
  description: Why the run failed or was lost.
  returned: when the run has an error
  type: str
output:
  description: The last O(output_lines) lines of the run's output.
  returned: when O(output_lines) is more than 0
  type: list
  elements: str
  sample: ["PLAY RECAP *****", "edge-r1 : ok=3 changed=0 unreachable=0 failed=0"]
run:
  description: The run's record as the server answers it.
  returned: success
  type: dict
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
)


def main():
    spec = connection_argument_spec()
    spec.update(
        run_id=dict(type="str", required=True, aliases=["id", "run"]),
        output_lines=dict(type="int", default=0),
    )
    module = AnsibleModule(argument_spec=spec, supports_check_mode=True)
    p = module.params
    client = AFSClient.from_module(module)
    try:
        run = client.run(p["run_id"])
        result = run_result(client, run)
        # Every approval it reached, not only one that waits.
        result["approvals"] = client.run_approvals(run["id"])
        result["finished"] = run.get("state") in FINAL_STATES
        if p["output_lines"] > 0:
            text = client.text("/runs/%s/output" % seg(run["id"])) or ""
            result["output"] = text.splitlines()[-p["output_lines"]:]
    except AFSError as e:
        module.fail_json(msg=to_native(e), status=e.status, error=e.error)
    module.exit_json(changed=False, **result)


if __name__ == "__main__":
    main()
