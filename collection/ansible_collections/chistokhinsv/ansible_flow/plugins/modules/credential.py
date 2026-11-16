#!/usr/bin/python
# -*- coding: utf-8 -*-
# Copyright (c) 2026 Sergei Chistokhin
# MIT License (see https://opensource.org/license/mit)

from __future__ import annotations

DOCUMENTATION = r"""
module: credential
short_description: Manage credentials of Ansible Flow Server
description:
  - Creates, changes and deletes a credential of an Ansible Flow Server workspace - what a run, or a look
    at a repository, signs in with.
  - The server keeps the secret part sealed and never gives it back. So the module cannot compare it - an
    existing credential's secret is replaced only with O(update_secret=always); with the default
    O(update_secret=on_create) it is sent only when the credential is made, and later runs stay idempotent.
  - The other options are compared, and only what differs is changed.
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
    details:
      - Secret values are never shown in the diff.
  platform:
    platforms: all
options:
  workspace:
    description:
      - The key (or id) of the workspace.
    type: str
    required: true
  name:
    description:
      - The credential's name, unique in the workspace.
    type: str
    required: true
  kind:
    description:
      - What the credential holds. Required to create one; it cannot change.
      - V(ssh_key) - fields C(username); secret C(privateKey) (required), C(passphrase).
      - V(login) - fields C(username) (required); secret C(password) (required).
      - V(become) - fields C(method), C(username); secret C(password) (required).
      - V(vault) - fields C(vaultId); secret C(password) (required).
      - V(git_token) - fields C(username); secret C(token) (required). For a project's repository, not a run.
      - V(registry) - fields C(host), C(username) (both required); secret C(password) (required).
      - V(env) - no fields; secret - environment variables of a run, by name.
    type: str
    choices: [ssh_key, login, become, vault, git_token, registry, env]
  description:
    description:
      - What the credential is for. V("") clears it.
    type: str
  fields:
    description:
      - The part of the credential that is not secret, such as C(username). Compared with the server's.
    type: dict
  secret:
    description:
      - The secret part, such as C(password) or C(privateKey); for V(env), the variables.
      - Required to create a credential. Write-only - see O(update_secret).
    type: dict
  update_secret:
    description:
      - V(on_create) sends O(secret) only when the credential is made.
      - V(always) sends it every time, replacing what the server keeps; the result is then always changed.
    type: str
    choices: [on_create, always]
    default: on_create
  state:
    description:
      - V(present) makes the credential as described; V(absent) deletes it.
      - The server refuses to delete a credential a project or launch configuration uses.
    type: str
    choices: [present, absent]
    default: present
notes:
  - Making, changing and deleting credentials needs an administrator's token.
"""

EXAMPLES = r"""
- name: The SSH key runs of the network workspace sign in with
  chistokhinsv.ansible_flow.credential:
    url: https://afs.example.net
    token: "{{ afs_admin_token }}"
    workspace: network
    name: netops-ssh
    kind: ssh_key
    description: Automation account on edge routers
    fields:
      username: netops
    secret:
      privateKey: "{{ lookup('ansible.builtin.file', 'files/netops_ed25519') }}"

- name: Rotate the enable password
  chistokhinsv.ansible_flow.credential:
    workspace: network
    name: edge-enable
    kind: become
    fields:
      method: enable
    secret:
      password: "{{ vault_enable_password }}"
    update_secret: always

- name: Variables for the runs' environment
  chistokhinsv.ansible_flow.credential:
    workspace: network
    name: netbox-api
    kind: env
    secret:
      NETBOX_URL: https://netbox.example.net
      NETBOX_TOKEN: "{{ vault_netbox_token }}"
"""

RETURN = r"""
credential:
  description:
    - The credential as the server answers it, without its secret (in check mode, as it would be); null after V(absent).
    - C(has) names the secret parts it holds.
  returned: success
  type: dict
  sample:
    id: 7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f
    workspace: 0f5c1e2d-3b4a-4c5d-8e6f-7a8b9c0d1e2f
    name: netops-ssh
    kind: ssh_key
    fields: {username: netops}
    has: [privateKey]
    usedBy: 2
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

KINDS = ["ssh_key", "login", "become", "vault", "git_token", "registry", "env"]


def _texts(values):
    return None if values is None else dict((k, "" if v is None else str(v)) for k, v in values.items())


def main():
    spec = connection_argument_spec()
    spec.update(
        workspace=dict(type="str", required=True),
        name=dict(type="str", required=True),
        kind=dict(type="str", choices=KINDS),
        description=dict(type="str"),
        fields=dict(type="dict"),
        secret=dict(type="dict", no_log=True),
        update_secret=dict(type="str", default="on_create", choices=["on_create", "always"], no_log=False),
        state=dict(type="str", default="present", choices=["present", "absent"]),
    )
    module = AnsibleModule(argument_spec=spec, supports_check_mode=True)
    p = module.params
    client = AFSClient.from_module(module)
    fields = _texts(p["fields"])
    secret = _texts(p["secret"])
    try:
        workspace = client.need_workspace(p["workspace"])
        current = client.credential(workspace["id"], p["name"])
        if p["state"] == "absent":
            changed, diff = ensure_absent(module.check_mode, current,
                                          lambda: client.delete("/credentials/%s" % seg(current["id"])))
            module.exit_json(changed=changed, diff=diff, credential=None)

        if current is None:
            if not p["kind"] or secret is None:
                module.fail_json(msg="Credential %s does not exist: give its kind and secret to create it" % p["name"])
        elif p["kind"] and p["kind"] != current.get("kind"):
            module.fail_json(msg="Credential %s is a %s: a kind cannot change; delete it and make it again" % (
                p["name"], current.get("kind")))

        wanted = dict(name=p["name"], kind=p["kind"] if current is None else None,
                      description=p["description"], fields=fields)
        force = None
        if current is not None and p["update_secret"] == "always" and secret is not None:
            force = dict(secret=secret)

        def create():
            body = dict(name=p["name"], kind=p["kind"], secret=secret)
            if p["description"]:
                body["description"] = p["description"]
            if fields is not None:
                body["fields"] = fields
            return client.post("/workspaces/%s/credentials" % seg(workspace["id"]), body)

        changed, credential, diff = ensure_present(
            module.check_mode, current, wanted, create,
            lambda changes: client.patch("/credentials/%s" % seg(current["id"]), changes),
            nullable=("description",), hidden=("secret",), force=force,
        )
        if current is None:
            diff["after"]["secret"] = "********"
    except AFSError as e:
        module.fail_json(msg=to_native(e), status=e.status, error=e.error)
    module.exit_json(changed=changed, diff=diff, credential=credential)


if __name__ == "__main__":
    main()
