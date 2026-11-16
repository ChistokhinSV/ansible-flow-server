#!/usr/bin/python
# -*- coding: utf-8 -*-
# Copyright (c) 2026 Sergei Chistokhin
# MIT License (see https://opensource.org/license/mit)

from __future__ import annotations

DOCUMENTATION = r"""
module: grant
short_description: Manage access grants of Ansible Flow Server
description:
  - Gives and takes back the access level of a user or a group in an Ansible Flow Server workspace,
    or on one flow of a project.
  - Levels - V(ro) sees, V(operator) also launches, V(rw) also changes; V(approve) may decide approvals and
    comes on top of a level.
  - A user or group has one level (V(ro), V(operator) or V(rw)) on a place; giving another level replaces
    it (the server has no change of a grant - the old one is taken back and the new one given).
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
  workspace:
    description:
      - The key (or id) of the workspace.
    type: str
    required: true
  user:
    description:
      - The user (login or id) the grant is for.
    type: str
  group:
    description:
      - The group (name or id) the grant is for.
    type: str
  level:
    description:
      - The level. Required with O(state=present).
      - With O(state=absent), only a grant of this level is taken back; without it, every grant of the
        user or group on the place.
    type: str
    choices: [ro, operator, rw, approve]
  project:
    description:
      - For a grant on one flow - the key (or id) of its project. Give O(flow) too.
    type: str
  flow:
    description:
      - For a grant on one flow - its file in the repository, such as V(flows/patch/patch.flow.yaml).
    type: str
  state:
    description:
      - V(present) gives the grant; V(absent) takes it back.
    type: str
    choices: [present, absent]
    default: present
notes:
  - Grants are an administrator's to give.
"""

EXAMPLES = r"""
- name: The netops group operates the network workspace
  chistokhinsv.ansible_flow.grant:
    url: https://afs.example.net
    token: "{{ afs_admin_token }}"
    workspace: network
    group: netops
    level: operator

- name: Dana may decide approvals of the patch flow
  chistokhinsv.ansible_flow.grant:
    workspace: network
    user: dana
    level: approve
    project: edge
    flow: flows/patch/patch.flow.yaml

- name: Take back everything the contractors group has in the workspace
  chistokhinsv.ansible_flow.grant:
    workspace: network
    group: contractors
    state: absent
"""

RETURN = r"""
grant:
  description: The grant as the server answers it (in check mode, as it would be); null after V(absent).
  returned: success
  type: dict
  sample:
    id: 3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f
    principal: {type: group, id: 6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d, name: netops}
    level: operator
    workspace: 0f5c1e2d-3b4a-4c5d-8e6f-7a8b9c0d1e2f
removed:
  description: The grants taken back.
  returned: success
  type: list
  elements: dict
"""

from ansible.module_utils.basic import AnsibleModule
from ansible.module_utils.common.text.converters import to_native

from ansible_collections.chistokhinsv.ansible_flow.plugins.module_utils.afs import (
    AFSClient,
    AFSError,
    connection_argument_spec,
    seg,
)


def _on_place(grant, principal_type, who, project_id, flow):
    p = grant.get("principal") or {}
    if p.get("type") != principal_type or who not in (p.get("id"), p.get("name")):
        return False
    place = grant.get("flow")
    if project_id is None:
        return not place
    return bool(place) and place.get("project") == project_id and place.get("file") == flow


def main():
    spec = connection_argument_spec()
    spec.update(
        workspace=dict(type="str", required=True),
        user=dict(type="str"),
        group=dict(type="str"),
        level=dict(type="str", choices=["ro", "operator", "rw", "approve"]),
        project=dict(type="str"),
        flow=dict(type="str"),
        state=dict(type="str", default="present", choices=["present", "absent"]),
    )
    module = AnsibleModule(
        argument_spec=spec,
        supports_check_mode=True,
        required_one_of=[("user", "group")],
        mutually_exclusive=[("user", "group")],
        required_together=[("project", "flow")],
        required_if=[("state", "present", ("level",))],
    )
    p = module.params
    client = AFSClient.from_module(module)
    principal_type = "user" if p["user"] else "group"
    who = p["user"] or p["group"]
    try:
        workspace = client.need_workspace(p["workspace"])
        project_id = None
        if p["project"]:
            project_id = client.need_project(workspace["id"], p["project"])["id"]
        grants = [g for g in client.get("/workspaces/%s/grants" % seg(workspace["id"])) or []
                  if _on_place(g, principal_type, who, project_id, p["flow"])]
        level = p["level"]

        if p["state"] == "absent":
            gone = [g for g in grants if level is None or g.get("level") == level]
            if not module.check_mode:
                for g in gone:
                    client.delete("/grants/%s" % seg(g["id"]))
            module.exit_json(changed=bool(gone), grant=None, removed=gone,
                             diff=dict(before=dict(grants=gone), after=dict(grants=[])))

        # approve sits beside a level; ro, operator and rw replace each other.
        same_kind = [g for g in grants if (g.get("level") == "approve") == (level == "approve")]
        for g in same_kind:
            if g.get("level") == level:
                module.exit_json(changed=False, grant=g, removed=[], diff=dict(before={}, after={}))
        body = dict(level=level)
        body[principal_type] = who
        if project_id:
            body.update(project=project_id, flow=p["flow"])
        diff = dict(before=dict(levels=[g.get("level") for g in same_kind]), after=dict(levels=[level]))
        if module.check_mode:
            shown = dict(principal=dict(type=principal_type, name=who), level=level, workspace=workspace["id"])
            module.exit_json(changed=True, grant=shown, removed=same_kind, diff=diff)
        for g in same_kind:
            client.delete("/grants/%s" % seg(g["id"]))
        grant = client.post("/workspaces/%s/grants" % seg(workspace["id"]), body)
    except AFSError as e:
        module.fail_json(msg=to_native(e), status=e.status, error=e.error)
    module.exit_json(changed=True, grant=grant, removed=same_kind, diff=diff)


if __name__ == "__main__":
    main()
