// The kinds of credentials and what each holds: fields anyone with access may see, and fields
// that are secret. Values only, no server code, so the pages read the same list (AFS-63).

export const KINDS = [
  'ssh_key',
  'login',
  'become',
  'vault',
  'git_token',
  'registry',
  'env',
] as const;
export type CredentialKind = (typeof KINDS)[number];

/** What each kind holds: fields anyone with access may see, and fields that are secret. */
export const SPEC: Record<
  CredentialKind,
  { fields: string[]; secret: string[]; required: string[] }
> = {
  // A private key to sign in to machines (or a git host) over SSH.
  ssh_key: { fields: ['username'], secret: ['privateKey', 'passphrase'], required: ['privateKey'] },
  // A login and its password, for machines and for a git host over HTTPS.
  login: { fields: ['username'], secret: ['password'], required: ['username', 'password'] },
  // The password to become another user on a machine (sudo and the like).
  become: { fields: ['method', 'username'], secret: ['password'], required: ['password'] },
  // The password of an Ansible vault.
  vault: { fields: ['vaultId'], secret: ['password'], required: ['password'] },
  // A token a git host gave out, used over HTTPS.
  git_token: { fields: ['username'], secret: ['token'], required: ['token'] },
  // The sign-in of a container registry.
  registry: {
    fields: ['host', 'username'],
    secret: ['password'],
    required: ['host', 'username', 'password'],
  },
  // Variables for a run's environment: the names are seen, the values are secret.
  env: { fields: [], secret: [], required: [] },
};

/** The kinds a project's git source can sign in with over HTTPS. */
export const GIT_KINDS: CredentialKind[] = ['git_token', 'login'];
