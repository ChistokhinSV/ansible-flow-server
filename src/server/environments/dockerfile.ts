// An environment's build files, and its ansible-builder v3 description (AFS-32). The image is made
// as the designer's afd-ee is (docker/afd-ee.Dockerfile): a Python base, system packages,
// ansible-core, collections in /usr/share/ansible/collections, a user `ansible` (uid 1000), host
// keys checked. Everything that goes into the file is checked first: a name or a package is
// never a way to run a command at build time.
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import type { EnvironmentSpec } from './types';

/** The Python image an environment starts from unless it says otherwise: the one afd-ee uses. */
export const DEFAULT_BASE =
  'python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90';
export const DEFAULT_CORE = '2.19';

const IMAGE = /^[A-Za-z0-9][\w.\-/:@]{0,299}$/;
const CORE = /^2\.\d{1,2}(\.\d{1,3})?$/;
/** A pip requirement as pip reads it: a name, extras, version specifiers; no options, no URLs. */
const PIP =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?\s*([<>=!~]=?\s*[A-Za-z0-9.*+!-]+\s*,?\s*)*$/;
/** A Debian package, optionally with `=version`. */
const DEB = /^[a-z0-9][a-z0-9.+-]*(=[A-Za-z0-9.+:~-]+)?$/;
const PEM = /^(-----BEGIN CERTIFICATE-----[\sA-Za-z0-9+/=]+-----END CERTIFICATE-----\s*)+$/;

/** Why a spec cannot be built, by field; empty when it can. */
export function specProblems(spec: EnvironmentSpec): { field: string; message: string }[] {
  const out: { field: string; message: string }[] = [];
  if (!IMAGE.test(spec.baseImage))
    out.push({ field: 'baseImage', message: 'Not the name of a container image' });
  if (!CORE.test(spec.ansibleCore))
    out.push({ field: 'ansibleCore', message: 'ansible-core as 2.19 or 2.19.3' });
  if (spec.collections.length > 200)
    out.push({ field: 'collections', message: 'At most 200 collections' });
  const seen = new Set<string>();
  for (const c of spec.collections) {
    if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(c.name))
      out.push({
        field: 'collections',
        message: `"${c.name.slice(0, 60)}" is not a collection name (namespace.name)`,
      });
    else if (seen.has(c.name))
      out.push({ field: 'collections', message: `${c.name} is there twice` });
    seen.add(c.name);
    const v = c.version.trim();
    if (
      v &&
      v !== 'latest' &&
      !/^(\*|[<>=!]=?\s*\d[\w.+-]*)(\s*,\s*[<>=!]=?\s*\d[\w.+-]*)*$|^\d[\w.+-]*$/.test(v)
    )
      out.push({
        field: 'collections',
        message: `${c.name}: "${v.slice(0, 40)}" is not a version, a range or latest`,
      });
  }
  for (const p of spec.python)
    if (!PIP.test(p.trim()))
      out.push({
        field: 'python',
        message: `"${p.slice(0, 60)}" is not a pip requirement (name and version only)`,
      });
  for (const p of spec.system)
    if (!DEB.test(p.trim()))
      out.push({ field: 'system', message: `"${p.slice(0, 60)}" is not a Debian package name` });
  if (spec.python.length > 200 || spec.system.length > 200)
    out.push({ field: 'python', message: 'At most 200 packages of each kind' });
  if (spec.caCertificates?.trim() && !PEM.test(spec.caCertificates.trim()))
    out.push({
      field: 'caCertificates',
      message: 'Certificates as PEM: BEGIN CERTIFICATE blocks only',
    });
  return out;
}

export interface Resolved {
  baseImage: string;
  ansibleCore: string;
  /** Collections at exact versions. */
  collections: Record<string, string>;
  python: string[];
  system: string[];
  caCertificates?: string;
}

/** The image's tag: the same resolved inputs make the same tag. */
export function specHash(r: Resolved): string {
  const sorted = {
    ...r,
    collections: Object.fromEntries(Object.entries(r.collections).sort()),
    python: [...r.python].sort(),
    system: [...r.system].sort(),
  };
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

/** The Dockerfile; `ca.pem` sits beside it when the environment has certificates. */
export function dockerfile(r: Resolved): string {
  const core = /^\d+\.\d+$/.test(r.ansibleCore) ? `${r.ansibleCore}.*` : r.ansibleCore;
  const system = ['openssh-client', 'sshpass', 'git', 'ca-certificates', ...r.system];
  const collections = Object.entries(r.collections).map(([n, v]) => `${n}:==${v}`);
  const lines = [
    '# Made by Ansible Flow Server from an environment spec. Rebuilt from the spec, not by hand.',
    `FROM ${r.baseImage}`,
    '',
  ];
  if (r.caCertificates?.trim())
    lines.push('COPY ca.pem /usr/local/share/ca-certificates/afs-extra.crt', '');
  lines.push(
    'RUN apt-get update \\',
    `    && apt-get install -y --no-install-recommends ${[...new Set(system)].join(' ')} \\`,
    ...(r.caCertificates?.trim() ? ['    && update-ca-certificates \\'] : []),
    '    && rm -rf /var/lib/apt/lists/*',
    '',
    ...(r.caCertificates?.trim()
      ? [
          '# pip and ansible-galaxy trust the same authorities as the system.',
          'ENV PIP_CERT=/etc/ssl/certs/ca-certificates.crt SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt',
          '',
        ]
      : []),
    `RUN pip install --no-cache-dir "ansible-core==${core}"${r.python.map((p) => ` "${p.trim()}"`).join('')} \\`,
    ...(collections.length
      ? [
          `    && ansible-galaxy collection install --collections-path /usr/share/ansible/collections ${collections.join(' ')} \\`,
        ]
      : []),
    '    && useradd --create-home --uid 1000 ansible',
    '',
    'USER ansible',
    'WORKDIR /work',
    'CMD ["ansible", "--version"]',
    '',
  );
  return lines.join('\n');
}

/** What ansible-builder builds on: it installs with dnf, so not the Debian Python image. */
export const BUILDER_BASE = 'quay.io/centos/centos:stream9';

/**
 * The environment as ansible-builder v3 reads it (`execution-environment.yml`), for AWX or AAP:
 * ansible-core, ansible-runner (AWX needs it), the collections and Python packages, on a base
 * ansible-builder can install into. Debian packages are named in a comment: their RPM names may
 * differ, so they are left for a person to write.
 */
export function builderFile(r: Resolved): string {
  const core = /^\d+\.\d+$/.test(r.ansibleCore) ? `${r.ansibleCore}.*` : r.ansibleCore;
  const doc = {
    version: 3,
    images: { base_image: { name: BUILDER_BASE } },
    dependencies: {
      python_interpreter: { package_system: 'python3.11', python_path: '/usr/bin/python3.11' },
      ansible_core: { package_pip: `ansible-core==${core}` },
      ansible_runner: { package_pip: 'ansible-runner' },
      galaxy: {
        collections: Object.entries(r.collections).map(([name, version]) =>
          version && version !== 'latest' && version !== '*' ? { name, version } : { name },
        ),
      },
      ...(r.python.length ? { python: r.python.map((p) => p.trim()) } : {}),
    },
    ...(r.caCertificates?.trim()
      ? {
          additional_build_files: [{ src: 'ca.pem', dest: 'certs' }],
          additional_build_steps: {
            prepend_base: [
              'COPY _build/certs/ca.pem /etc/pki/ca-trust/source/anchors/afs-extra.pem',
              'RUN update-ca-trust',
            ],
          },
        }
      : {}),
  };
  const notes = [
    '# ansible-builder v3, from an Ansible Flow Server environment: ansible-builder build -t <name>',
    `# The server builds it on ${r.baseImage}; ansible-builder needs a dnf-based base, so ${BUILDER_BASE}.`,
    ...(r.caCertificates?.trim() ? ['# Put the certificates in ca.pem beside this file.'] : []),
    ...(r.system.length
      ? [
          `# Debian packages in the environment: ${r.system.join(' ')}`,
          '# Add their RPM names under dependencies.system as `<name> [platform:rpm]`.',
        ]
      : []),
  ];
  return `${notes.join('\n')}\n${stringify(doc)}`;
}
