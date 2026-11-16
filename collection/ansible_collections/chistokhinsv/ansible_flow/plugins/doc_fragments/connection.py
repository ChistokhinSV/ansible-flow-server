# -*- coding: utf-8 -*-
# Copyright (c) 2026 Sergei Chistokhin
# MIT License (see https://opensource.org/license/mit)

from __future__ import annotations


class ModuleDocFragment(object):
    # How a module reaches Ansible Flow Server.
    DOCUMENTATION = r"""
options:
  url:
    description:
      - The address of the Ansible Flow Server, such as V(https://afs.example.net).
      - A trailing C(/api/v1) is ignored.
      - If not set, the value of the E(AFS_URL) environment variable is used.
    type: str
    required: true
  token:
    description:
      - "An access token of the server, sent as C(Authorization: Bearer <token>)."
      - Make one on the server's Tokens page, or for a service account as an administrator.
      - What the token's owner may do on the server is what the module may do.
      - If not set, the value of the E(AFS_TOKEN) environment variable is used.
      - The token is never logged or returned.
    type: str
    required: true
  validate_certs:
    description:
      - Whether to check the server's TLS certificate.
      - Set to V(false) only for a lab server with a self-signed certificate; prefer O(ca_path).
      - If not set, the value of the E(AFS_VALIDATE_CERTS) environment variable is used.
    type: bool
    default: true
  ca_path:
    description:
      - A PEM file of the certificate authority that signed the server's certificate.
      - If not set, the value of the E(AFS_CA_PATH) environment variable is used.
    type: path
  timeout:
    description:
      - Seconds to wait for each answer of the server.
    type: int
    default: 30
notes:
  - Set the connection once for every module of the collection with C(module_defaults) and the
    C(group/chistokhinsv.ansible_flow.afs) action group.
  - "The modules talk to the server over HTTPS from where they run; run them on the controller
    with C(delegate_to: localhost) or in a play on C(localhost)."
"""

    # The same options for a lookup plugin, which reads them as plugin options.
    LOOKUP = r"""
options:
  url:
    description:
      - The address of the Ansible Flow Server, such as V(https://afs.example.net).
    type: str
    required: true
    env:
      - name: AFS_URL
  token:
    description:
      - An access token of the server. Never logged or returned.
    type: str
    required: true
    env:
      - name: AFS_TOKEN
  validate_certs:
    description:
      - Whether to check the server's TLS certificate.
    type: bool
    default: true
    env:
      - name: AFS_VALIDATE_CERTS
  ca_path:
    description:
      - A PEM file of the certificate authority that signed the server's certificate.
    type: path
    env:
      - name: AFS_CA_PATH
  timeout:
    description:
      - Seconds to wait for the server's answer.
    type: int
    default: 30
"""
