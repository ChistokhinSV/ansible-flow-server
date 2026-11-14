// LDAP and Active Directory directories people sign in with (AFS-31). Types only, so the web
// application uses them without the server.

/** A directory group (its DN, or its name: the first RDN's value) and what it is here. */
export interface DirectoryMapping {
  value: string;
  /** A server group's id; absent: administrator. */
  group?: string;
  admin?: boolean;
}

export interface Directory {
  id: string;
  key: string;
  name: string;
  position: number;
  url: string;
  startTls: boolean;
  bindDn?: string;
  /** Whether a bind password is kept (it is never shown). */
  hasBindPassword: boolean;
  userBase: string;
  userFilter: string;
  idAttr: string;
  loginAttr: string;
  nameAttr: string;
  emailAttr: string;
  groupMode: 'memberof' | 'search';
  groupBase?: string;
  groupFilter?: string;
  adDisabled: boolean;
  /** Minutes between syncs; 0: only at sign-in. */
  syncMinutes: number;
  enabled: boolean;
  mappings: DirectoryMapping[];
  lastSyncAt?: string;
  lastSyncResult?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DirectoryInput {
  key: string;
  name: string;
  url: string;
  startTls?: boolean;
  bindDn?: string | null;
  /** A new bind password; null: none; absent on a change: kept. */
  bindPassword?: string | null;
  userBase: string;
  userFilter?: string;
  idAttr?: string;
  loginAttr?: string;
  nameAttr?: string;
  emailAttr?: string;
  groupMode?: 'memberof' | 'search';
  groupBase?: string | null;
  groupFilter?: string | null;
  adDisabled?: boolean;
  syncMinutes?: number;
  enabled?: boolean;
  position?: number;
  mappings?: DirectoryMapping[];
}

/** What a test of a directory found. */
export interface DirectoryTest {
  ok: boolean;
  message: string;
  /** With a login: the entry found, its groups and what they are here. */
  person?: {
    dn: string;
    login?: string;
    name?: string;
    email?: string;
    disabled: boolean;
    groups: string[];
    mapped: string[];
  };
}

/** Start values for the kinds of directory people have. */
export const PRESETS = {
  'active-directory': {
    userFilter: '(&(objectCategory=person)(objectClass=user)(sAMAccountName={login}))',
    idAttr: 'objectGUID',
    loginAttr: 'sAMAccountName',
    nameAttr: 'displayName',
    emailAttr: 'mail',
    groupMode: 'search',
    // Every group the person is in, nested ones too (LDAP_MATCHING_RULE_IN_CHAIN).
    groupFilter: '(&(objectClass=group)(member:1.2.840.113556.1.4.1941:={dn}))',
    adDisabled: true,
  },
  openldap: {
    userFilter: '(&(objectClass=inetOrgPerson)(uid={login}))',
    idAttr: 'entryUUID',
    loginAttr: 'uid',
    nameAttr: 'cn',
    emailAttr: 'mail',
    groupMode: 'search',
    groupFilter: '(&(objectClass=groupOfNames)(member={dn}))',
    adDisabled: false,
  },
} as const;
