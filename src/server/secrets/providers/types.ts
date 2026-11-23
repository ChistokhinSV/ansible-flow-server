// Secret providers (AFS-241, AFS-242): the kinds, what each keeps open and sealed, and the shape
// of a reference to a secret in one. Values and checks only, no server code: the pages read the
// same lists.

export const PROVIDER_KINDS = ['vault', 'conjur', 'ccp', 'aws'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Each kind's name, as the pages and the run's output say it. */
export const PROVIDER_KIND_NAME: Record<ProviderKind, string> = {
  vault: 'HashiCorp Vault',
  conjur: 'CyberArk Conjur',
  ccp: 'CyberArk CCP',
  aws: 'AWS Secrets Manager',
};

/** The open settings of a provider: what each kind uses of them is in SETTINGS. */
export interface ProviderSettings {
  /** https://vault.example.net:8200; for AWS, an endpoint other than the region's (optional). */
  address?: string;
  /** A certificate authority (PEM) trusted for this provider only, beside the server's. */
  ca?: string;
  /** Seconds to wait for a connection and its answer (default 10). */
  timeoutS?: number;
  /** Vault: approle or token. */
  auth?: 'approle' | 'token';
  /** Vault: where the AppRole sign-in is mounted (default approle). */
  authMount?: string;
  /** Vault Enterprise: the namespace. */
  namespace?: string;
  /** Vault: the KV version 2 mount a reference reads by default (default secret). */
  kvMount?: string;
  /** Conjur: the account. */
  account?: string;
  /** Conjur: the host's login (host/afs). */
  login?: string;
  /** CCP: the application id. */
  appId?: string;
  /** CCP: the client certificate (PEM); its key is in the secret part. */
  clientCert?: string;
  /** AWS: the region (eu-central-1). */
  region?: string;
}

/** The open settings each kind takes; `address` is required where it is listed first. */
export const SETTINGS: Record<ProviderKind, (keyof ProviderSettings)[]> = {
  vault: ['address', 'ca', 'timeoutS', 'auth', 'authMount', 'namespace', 'kvMount'],
  conjur: ['address', 'ca', 'timeoutS', 'account', 'login'],
  ccp: ['address', 'ca', 'timeoutS', 'appId', 'clientCert'],
  aws: ['region', 'address', 'ca', 'timeoutS'],
};

/** The secret parts each kind takes (sealed; never shown again). */
export const SECRETS: Record<ProviderKind, string[]> = {
  vault: ['roleId', 'secretId', 'token'],
  conjur: ['apiKey'],
  ccp: ['clientKey'],
  aws: ['accessKeyId', 'secretAccessKey', 'sessionToken'],
};

/** Labels of settings and secret parts, for the pages. */
export const SETTING_LABEL: Record<string, string> = {
  address: 'Address',
  ca: 'Certificate authority (PEM)',
  timeoutS: 'Timeout (seconds)',
  auth: 'Sign in with',
  authMount: 'AppRole mount',
  namespace: 'Namespace',
  kvMount: 'KV mount',
  account: 'Account',
  login: 'Host login',
  appId: 'Application id (AppID)',
  clientCert: 'Client certificate (PEM)',
  region: 'Region',
  roleId: 'Role id',
  secretId: 'Secret id',
  token: 'Token',
  apiKey: 'API key',
  clientKey: 'Client certificate key (PEM)',
  accessKeyId: 'Access key id',
  secretAccessKey: 'Secret access key',
  sessionToken: 'Session token',
};

/** What a provider is, as the API answers (never its secret part). */
export interface SecretProvider {
  id: string;
  key: string;
  name: string;
  kind: ProviderKind;
  settings: ProviderSettings;
  /** The names of the secret parts it keeps. */
  has: string[];
  /** The workspaces (ids) whose credentials may read from it. */
  workspaces: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SecretProviderInput {
  key: string;
  name: string;
  kind: ProviderKind;
  settings: ProviderSettings;
  /** Replaces the secret part, whole; left out on a change: kept. */
  secret?: Record<string, string>;
  workspaces: string[];
}

/** A provider as a credential form lists it: no settings. */
export interface ProviderChoice {
  key: string;
  name: string;
  kind: ProviderKind;
}

/**
 * Where a secret is in a provider: `provider` is the provider's key, the rest is the kind's
 * (REF_FIELDS). Not secret, but shown only to the workspace's administrators: a path tells
 * where to look.
 */
export interface SecretRef {
  provider: string;
  [part: string]: string;
}

/** A reference as a credential's answer carries it: the path only for whoever may see it. */
export interface RefShown {
  provider: string;
  /** The provider's name and kind, for "from HashiCorp Vault "corp-vault"". */
  providerName?: string;
  kind?: ProviderKind;
  /** The rest of the reference (REF_FIELDS); left out for those who may not see paths. */
  path?: Record<string, string>;
}

export interface RefField {
  name: string;
  label: string;
  required: boolean;
  hint?: string;
}

/** The parts of a reference, per kind. */
export const REF_FIELDS: Record<ProviderKind, RefField[]> = {
  vault: [
    { name: 'mount', label: 'KV mount', required: false, hint: "The provider's KV mount if empty" },
    { name: 'path', label: 'Path', required: true, hint: 'network/switches (without data/)' },
    { name: 'field', label: 'Field', required: true, hint: 'password' },
    { name: 'version', label: 'Version', required: false, hint: 'The latest if empty' },
  ],
  conjur: [
    { name: 'variable', label: 'Variable', required: true, hint: 'network/switches/password' },
  ],
  ccp: [
    { name: 'safe', label: 'Safe', required: true },
    { name: 'folder', label: 'Folder', required: false, hint: 'Root if empty' },
    { name: 'object', label: 'Object', required: true },
    { name: 'field', label: 'Field', required: false, hint: 'Content (the password) if empty' },
  ],
  aws: [
    { name: 'secretId', label: 'Secret name or ARN', required: true },
    {
      name: 'jsonKey',
      label: 'JSON key',
      required: false,
      hint: 'For a JSON secret: the key to take; empty takes all of it',
    },
    { name: 'versionStage', label: 'Version stage', required: false, hint: 'AWSCURRENT if empty' },
  ],
};

export const PROVIDER_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** What is wrong with a reference for a provider of this kind, in words, or undefined. */
export function refProblem(kind: ProviderKind, ref: Record<string, unknown>): string | undefined {
  const fields = REF_FIELDS[kind];
  for (const name of Object.keys(ref)) {
    if (name === 'provider') continue;
    if (!fields.some((f) => f.name === name))
      return `A reference to ${PROVIDER_KIND_NAME[kind]} has no part "${name.slice(0, 40)}"`;
    const v = ref[name];
    if (typeof v !== 'string' || v.length > 500) return `${name} must be text of up to 500`;
  }
  for (const f of fields) {
    const v = typeof ref[f.name] === 'string' ? (ref[f.name] as string).trim() : '';
    if (f.required && !v) return `${f.label} is needed`;
  }
  if (kind === 'vault') {
    if (ref.version && !/^\d{1,9}$/.test(String(ref.version))) return 'Version is a number';
    if (/(^|\/)\.\.(\/|$)/.test(String(ref.path ?? ''))) return 'Path may not hold ".."';
  }
  return undefined;
}

/** A reference's path on one line, for those who may see it: secret/network/switches#password. */
export function refPath(kind: ProviderKind, path: Record<string, string>): string {
  switch (kind) {
    case 'vault':
      return `${path.mount ? `${path.mount}/` : ''}${path.path ?? ''}#${path.field ?? ''}${path.version ? ` (version ${path.version})` : ''}`;
    case 'conjur':
      return path.variable ?? '';
    case 'ccp':
      return `${path.safe ?? ''}/${path.folder ? `${path.folder}/` : ''}${path.object ?? ''}${path.field ? `#${path.field}` : ''}`;
    case 'aws':
      return `${path.secretId ?? ''}${path.jsonKey ? `#${path.jsonKey}` : ''}${path.versionStage ? ` (${path.versionStage})` : ''}`;
  }
}

/** "HashiCorp Vault "corp-vault"": a provider as the run's output names it. */
export const providerWords = (kind: ProviderKind, name: string) =>
  `${PROVIDER_KIND_NAME[kind]} "${name}"`;
