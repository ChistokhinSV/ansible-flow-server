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
  'awx',
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
  // AFS-126: an AWX (or Automation Controller) address and a token, to import its templates.
  awx: { fields: ['url'], secret: ['token'], required: ['url', 'token'] },
};

/** The kinds a project's git source can sign in with over HTTPS. */
export const GIT_KINDS: CredentialKind[] = ['git_token', 'login'];

/** AFS-140: the become methods offered as choices; a collection's plugin is named in full. */
export const BECOME_METHODS = [
  'sudo',
  'su',
  'doas',
  'dzdo',
  'ksu',
  'machinectl',
  'pbrun',
  'pfexec',
  'pmrun',
  'runas',
  'sesu',
  'sudosu',
  'enable',
];

/**
 * AFS-140: what is wrong with a visible field's value, in words, or undefined. The pages check
 * with it before sending; the server checks with it again.
 */
export function fieldProblem(name: string, value: string): string | undefined {
  const v = value.trim();
  if (!v) return undefined;
  switch (name) {
    case 'method':
      // A plugin's name, short (sudo) or in full (community.general.doas).
      return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,2}$/.test(v)
        ? undefined
        : 'A become method is a name like sudo, su or doas.';
    case 'host':
      return /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/.test(v)
        ? undefined
        : 'A registry host is a name with a port if needed (registry.example.net:5000), without https:// or a path.';
    case 'url': {
      let url: URL | undefined;
      try {
        url = new URL(v);
      } catch {
        url = undefined;
      }
      return url && (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname
        ? undefined
        : 'An AWX address starts with https:// (https://awx.example.net).';
    }
    case 'vaultId':
      return /^[A-Za-z0-9_.-]{1,100}$/.test(v)
        ? undefined
        : 'A vault id is one word: letters, digits, dots, dashes and underscores.';
    default:
      return undefined;
  }
}

/** AFS-140: what is wrong with a private key's text, in words, or undefined. */
export const privateKeyProblem = (key: string): string | undefined =>
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(key)
    ? undefined
    : 'This is not a private key. Paste the whole key, from -----BEGIN to the -----END line.';
