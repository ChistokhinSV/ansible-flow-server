#!/usr/bin/python
# -*- coding: utf-8 -*-
# Copyright (c) 2026 Sergei Chistokhin
# MIT License (see https://opensource.org/license/mit)

from __future__ import annotations

DOCUMENTATION = r"""
module: schedule
short_description: Manage schedules of Ansible Flow Server launch configurations
description:
  - Creates, changes and deletes a schedule of an Ansible Flow Server launch configuration - when the server
    launches it by itself, on a cron or once.
  - Idempotent - only the options given are compared, and only what differs is changed.
  - A new schedule belongs to the token's owner; its runs are launched as that person.
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
  project:
    description:
      - The key (or id) of the project.
    type: str
    required: true
  launch_config:
    description:
      - The launch configuration (its name or id) the schedule launches.
    type: str
    required: true
  name:
    description:
      - The schedule's name, which tells it from the configuration's other schedules.
    type: str
    required: true
  kind:
    description:
      - V(cron) fires on O(cron); V(once) fires once at O(once_at). Required to create one.
    type: str
    choices: [cron, once]
  cron:
    description:
      - A cron expression, such as V(0 3 * * 1-5), in O(timezone).
    type: str
  timezone:
    description:
      - The time zone O(cron) is read in, such as V(Europe/Berlin). The server uses V(UTC) when it is not given.
    type: str
  once_at:
    description:
      - For V(once), when - an ISO 8601 time with its offset, such as V(2026-12-01T02:00:00Z).
    type: str
  enabled:
    description:
      - Whether the schedule fires. A new schedule is enabled unless this says otherwise.
    type: bool
  mode:
    description:
      - V(check) or V(real) runs; V("") for the launch configuration's mode.
    type: str
    choices: ["", check, real]
  inputs:
    description:
      - Input values over the launch configuration's start values. Each is sent as text; lists and dicts as JSON.
      - Never a secret - the server refuses secret-looking inputs here.
    type: dict
  commit:
    description:
      - Pin the runs to one commit; V("") for the newest of the configuration's branch when it fires.
    type: str
  missed:
    description:
      - What happens to a time the server was down for - V(once) runs it once when back, V(skip) skips it.
    type: str
    choices: [once, skip]
  overlap:
    description:
      - What happens when the time comes while the last run still goes - V(skip) it, or V(queue) a new run.
    type: str
    choices: [skip, queue]
  state:
    description:
      - V(present) makes the schedule as described; V(absent) deletes it.
    type: str
    choices: [present, absent]
    default: present
notes:
  - Making and changing a schedule needs rw on the launch configuration's flow.
  - Handing a schedule to a service account is done on the server's pages; this module does not change the owner.
"""

EXAMPLES = r"""
- name: Check the edge every weekday night
  chistokhinsv.ansible_flow.schedule:
    url: https://afs.example.net
    token: "{{ afs_token }}"
    workspace: network
    project: edge
    launch_config: Patch edge
    name: Nightly check
    kind: cron
    cron: "0 3 * * 1-5"
    timezone: Europe/Berlin
    mode: check
    overlap: skip

- name: Patch once in the change window
  chistokhinsv.ansible_flow.schedule:
    workspace: network
    project: edge
    launch_config: Patch edge
    name: CHG-1042
    kind: once
    once_at: "2026-12-01T02:00:00Z"
    mode: real
    inputs:
      devices: [edge-r1]

- name: Pause the nightly check
  chistokhinsv.ansible_flow.schedule:
    workspace: network
    project: edge
    launch_config: Patch edge
    name: Nightly check
    enabled: false
"""

RETURN = r"""
schedule:
  description: The schedule as the server answers it (in check mode, as it would be); null after V(absent).
  returned: success
  type: dict
  sample:
    id: 5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b
    config: 4d1c2a8e-5b7f-4e0a-9c3d-2f6b8a1e7c90
    name: Nightly check
    kind: cron
    cron: "0 3 * * 1-5"
    timezone: Europe/Berlin
    enabled: true
    mode: check
    inputs: {}
    missed: once
    overlap: skip
    owner: {id: 1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e, login: dana}
    next: "2026-11-17T02:00:00.000Z"
"""

from datetime import datetime

from ansible.module_utils.basic import AnsibleModule
from ansible.module_utils.common.text.converters import to_native

from ansible_collections.chistokhinsv.ansible_flow.plugins.module_utils.afs import (
    AFSClient,
    AFSError,
    connection_argument_spec,
    ensure_absent,
    ensure_present,
    input_texts,
    seg,
)


def _instant(text):
    """A time as a comparable instant, so 2026-12-01T02:00:00Z equals 2026-12-01T02:00:00.000Z."""
    if not text:
        return None
    try:
        value = text.strip().replace("Z", "+00:00")
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        return text


def main():
    spec = connection_argument_spec()
    spec.update(
        workspace=dict(type="str", required=True),
        project=dict(type="str", required=True),
        launch_config=dict(type="str", required=True),
        name=dict(type="str", required=True),
        kind=dict(type="str", choices=["cron", "once"]),
        cron=dict(type="str"),
        timezone=dict(type="str"),
        once_at=dict(type="str"),
        enabled=dict(type="bool"),
        mode=dict(type="str", choices=["", "check", "real"]),
        inputs=dict(type="dict"),
        commit=dict(type="str"),
        missed=dict(type="str", choices=["once", "skip"]),
        overlap=dict(type="str", choices=["skip", "queue"]),
        state=dict(type="str", default="present", choices=["present", "absent"]),
    )
    module = AnsibleModule(
        argument_spec=spec,
        supports_check_mode=True,
        required_if=[("kind", "cron", ("cron",)), ("kind", "once", ("once_at",))],
    )
    p = module.params
    client = AFSClient.from_module(module)
    try:
        workspace = client.need_workspace(p["workspace"])
        project = client.need_project(workspace["id"], p["project"])
        config = client.need_launch_config(project["id"], p["launch_config"],
                                           " in %s/%s" % (p["workspace"], p["project"]))
        base = "/launch-configs/%s/schedules" % seg(config["id"])
        current = None
        for s in client.get(base) or []:
            if p["name"] in (s.get("name"), s.get("id")):
                current = s
                break
        if p["state"] == "absent":
            changed, diff = ensure_absent(module.check_mode, current,
                                          lambda: client.delete("%s/%s" % (base, seg(current["id"]))))
            module.exit_json(changed=changed, diff=diff, schedule=None)

        if current is None and not p["kind"]:
            module.fail_json(msg="Schedule %s does not exist: give its kind to create it" % p["name"])

        wanted = dict(
            name=p["name"], kind=p["kind"], cron=p["cron"], timezone=p["timezone"], onceAt=p["once_at"],
            enabled=p["enabled"], mode=p["mode"], inputs=None if p["inputs"] is None else input_texts(p["inputs"]),
            commit=p["commit"], missed=p["missed"], overlap=p["overlap"],
        )
        compared = current
        if current is not None and p["once_at"] and _instant(p["once_at"]) == _instant(current.get("onceAt")):
            # The same time written another way is the same time.
            compared = dict(current, onceAt=p["once_at"])

        def create():
            body = dict((k, v) for k, v in wanted.items() if v is not None and v != "")
            return client.post(base, body)

        changed, schedule, diff = ensure_present(
            module.check_mode, compared, wanted, create,
            lambda changes: client.patch("%s/%s" % (base, seg(current["id"])), changes),
            nullable=("mode", "commit"),
        )
    except AFSError as e:
        module.fail_json(msg=to_native(e), status=e.status, error=e.error)
    module.exit_json(changed=changed, diff=diff, schedule=schedule)


if __name__ == "__main__":
    main()
