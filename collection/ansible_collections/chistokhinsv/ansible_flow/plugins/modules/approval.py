#!/usr/bin/python
# -*- coding: utf-8 -*-
# Copyright (c) 2026 Sergei Chistokhin
# MIT License (see https://opensource.org/license/mit)

from __future__ import annotations

DOCUMENTATION = r"""
module: approval
short_description: Decide an approval of an Ansible Flow Server run
description:
  - Approves or rejects an approval step a run of Ansible Flow Server waits at. The run then goes on
    along the way the decision picks.
  - Idempotent - an approval already decided the same way is left as it is (C(changed=false)); one
    decided the other way, or timed out, fails with who decided it.
author:
  - Sergei Chistokhin (@ChistokhinSV)
extends_documentation_fragment:
  - chistokhinsv.ansible_flow.connection
  - ansible.builtin.action_common_attributes
attributes:
  check_mode:
    support: full
  diff_mode:
    support: none
  platform:
    platforms: all
options:
  run_id:
    description:
      - The id of the run that waits.
    type: str
    required: true
    aliases: [run]
  node:
    description:
      - The approval step - its key in the flow (such as V(approve-change)) or its node id.
    type: str
    required: true
    aliases: [approval]
  decision:
    description:
      - V(approved) lets the run go on along the approval's approved way; V(rejected) along its rejected way.
    type: str
    required: true
    choices: [approved, rejected]
  comment:
    description:
      - What the decider says, shown with the decision on the run's page.
    type: str
notes:
  - Deciding needs the approve grant on the flow (administrators may always decide), and the token's owner
    must be one of the approval's approvers when it names some. Who launched the run may decide only where
    the workspace allows it.
  - A token is personal; deciding with a service account's token records the service account as the decider.
seealso:
  - module: chistokhinsv.ansible_flow.run
  - module: chistokhinsv.ansible_flow.run_info
"""

EXAMPLES = r"""
- name: Approve the change of run 42
  chistokhinsv.ansible_flow.approval:
    url: https://afs.example.net
    token: "{{ dana_token }}"
    run_id: "{{ real_run.id }}"
    node: approve-change
    decision: approved
    comment: Change window CHG-1042 is open

- name: Reject every approval that waits on a run
  chistokhinsv.ansible_flow.approval:
    run_id: "{{ real_run.id }}"
    node: "{{ item.node.key }}"
    decision: rejected
    comment: Outside the change window
  loop: "{{ real_run.approvals | selectattr('status', 'equalto', 'waiting') }}"
"""

RETURN = r"""
approval:
  description: The approval after the decision (in check mode, as it would be).
  returned: success
  type: dict
  sample:
    node: {id: 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3, key: approve-change, title: Approve the change}
    status: approved
    decidedBy: dana
    decidedAt: "2026-11-16T09:44:37.000Z"
    comment: Change window CHG-1042 is open
url:
  description: The run's page on the server.
  returned: success
  type: str
  sample: https://afs.example.net/runs/9b2e4f60-1c3d-4a5b-8e7f-0a1b2c3d4e5f
"""

from ansible.module_utils.basic import AnsibleModule
from ansible.module_utils.common.text.converters import to_native

from ansible_collections.chistokhinsv.ansible_flow.plugins.module_utils.afs import (
    AFSClient,
    AFSError,
    connection_argument_spec,
    decide_approval,
)


def main():
    spec = connection_argument_spec()
    spec.update(
        run_id=dict(type="str", required=True, aliases=["run"]),
        node=dict(type="str", required=True, aliases=["approval"]),
        decision=dict(type="str", required=True, choices=["approved", "rejected"]),
        comment=dict(type="str"),
    )
    module = AnsibleModule(argument_spec=spec, supports_check_mode=True)
    p = module.params
    client = AFSClient.from_module(module)
    try:
        changed, gate = decide_approval(client, p["run_id"], p["node"], p["decision"], p["comment"],
                                        check_mode=module.check_mode)
    except AFSError as e:
        module.fail_json(msg=to_native(e), status=e.status, error=e.error)
    module.exit_json(changed=changed, approval=gate, url=client.run_url(p["run_id"]))


if __name__ == "__main__":
    main()
