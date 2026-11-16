#!/usr/bin/python
# -*- coding: utf-8 -*-
# Copyright (c) 2026 Sergei Chistokhin
# MIT License (see https://opensource.org/license/mit)

from __future__ import annotations

DOCUMENTATION = r"""
module: workspace
short_description: Manage workspaces of Ansible Flow Server
description:
  - Creates, changes and deletes a workspace of Ansible Flow Server - the place that holds projects,
    credentials, execution environments and the grants of who may do what.
  - Idempotent - only the options given are compared, and only what differs is changed.
author:
  - Sergei Chistokhin (@ChistokhinSV)
extends_documentation_fragment:
  - chistokhinsv.ansible_flow.connection
  - ansible.builtin.action_common_attributes
attributes:
  check_mode:
    support: full
  diff_mode:
    support: full
  platform:
    platforms: all
options:
  key:
    description:
      - The workspace's key, a short lowercase slug used in addresses, such as V(network). It cannot change.
    type: str
    required: true
  name:
    description:
      - The workspace's name as people read it. Required to create one.
    type: str
  description:
    description:
      - What the workspace is for. V("") clears it.
    type: str
  self_approve:
    description:
      - Whether who launched a run may also decide its approvals.
    type: bool
  state:
    description:
      - V(present) makes the workspace as described; V(absent) deletes it.
      - The server deletes only an empty workspace - delete its projects and credentials first.
    type: str
    choices: [present, absent]
    default: present
notes:
  - Making, changing and deleting workspaces needs an administrator's token.
"""

EXAMPLES = r"""
- name: Make the network workspace
  chistokhinsv.ansible_flow.workspace:
    url: https://afs.example.net
    token: "{{ afs_admin_token }}"
    key: network
    name: Network
    description: Routers, switches and firewalls of the edge
    self_approve: false

- name: Delete the lab workspace
  chistokhinsv.ansible_flow.workspace:
    key: lab
    state: absent
"""

RETURN = r"""
workspace:
  description: The workspace as the server answers it (in check mode, as it would be); null after V(absent).
  returned: success
  type: dict
  sample:
    id: 0f5c1e2d-3b4a-4c5d-8e6f-7a8b9c0d1e2f
    key: network
    name: Network
    description: Routers, switches and firewalls of the edge
    projects: 2
    selfApprove: false
"""

from ansible.module_utils.basic import AnsibleModule
from ansible.module_utils.common.text.converters import to_native

from ansible_collections.chistokhinsv.ansible_flow.plugins.module_utils.afs import (
    AFSClient,
    AFSError,
    connection_argument_spec,
    ensure_absent,
    ensure_present,
    seg,
)


def main():
    spec = connection_argument_spec()
    spec.update(
        key=dict(type="str", required=True, no_log=False),
        name=dict(type="str"),
        description=dict(type="str"),
        self_approve=dict(type="bool"),
        state=dict(type="str", default="present", choices=["present", "absent"]),
    )
    module = AnsibleModule(argument_spec=spec, supports_check_mode=True)
    p = module.params
    client = AFSClient.from_module(module)
    key = p["key"].strip().lower()
    try:
        current = client.workspace(key)
        if p["state"] == "absent":
            changed, diff = ensure_absent(module.check_mode, current,
                                          lambda: client.delete("/workspaces/%s" % seg(current["id"])))
            module.exit_json(changed=changed, diff=diff, workspace=None)

        wanted = dict(name=p["name"], description=p["description"], selfApprove=p["self_approve"])

        def create():
            if not p["name"]:
                raise AFSError("Workspace %s does not exist: give its name to create it" % key)
            body = dict(key=key, name=p["name"])
            if p["description"]:
                body["description"] = p["description"]
            made = client.post("/workspaces", body)
            # Making one does not take selfApprove: it is set after.
            if p["self_approve"] is not None and made.get("selfApprove") != p["self_approve"]:
                made = client.patch("/workspaces/%s" % seg(made["id"]), dict(selfApprove=p["self_approve"]))
            return made

        if current is None and not p["name"]:
            module.fail_json(msg="Workspace %s does not exist: give its name to create it" % key)
        changed, workspace, diff = ensure_present(
            module.check_mode, current, wanted, create,
            lambda changes: client.patch("/workspaces/%s" % seg(current["id"]), changes),
            nullable=("description",),
        )
    except AFSError as e:
        module.fail_json(msg=to_native(e), status=e.status, error=e.error)
    module.exit_json(changed=changed, diff=diff, workspace=workspace)


if __name__ == "__main__":
    main()
