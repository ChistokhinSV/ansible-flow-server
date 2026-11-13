// The database's tables, as the query builder knows them. One schema for SQLite and PostgreSQL
// (ADR-0005): times are ISO 8601 text in UTC, truth values are 0 or 1, structured values are JSON
// text, ids are text. Nothing here depends on a type only one of the two databases has.

/** A time as text: `2026-11-13T08:44:37.512Z`. Sorts as it reads. */
export type IsoTime = string;

/** What the server knows about itself: one row per name. */
export interface SettingTable {
  name: string;
  value: string;
  updated_at: IsoTime;
}

/** 0 or 1. */
export type Flag = number;

/** A person who signs in, or (later) a service account. */
export interface UserAccountTable {
  id: string;
  /** What they sign in with; lower case, unique. */
  login: string;
  name: string;
  /** Where a notification for this person goes. */
  email: string | null;
  webhook_url: string | null;
  /** An argon2id hash; null for an account that cannot sign in with a password. */
  password_hash: string | null;
  is_admin: Flag;
  disabled: Flag;
  created_at: IsoTime;
  updated_at: IsoTime;
  last_login_at: IsoTime | null;
}

/** People who are given access together, and notified together. */
export interface UserGroupTable {
  id: string;
  name: string;
  email: string | null;
  webhook_url: string | null;
  created_at: IsoTime;
  updated_at: IsoTime;
}

export interface GroupMemberTable {
  group_id: string;
  user_id: string;
}

/** A sign-in that is still good. The cookie holds a token; this holds its hash. */
export interface SessionTable {
  /** SHA-256 of the token, in hex: reading the table gives nobody a session. */
  id: string;
  user_id: string;
  created_at: IsoTime;
  last_seen_at: IsoTime;
  /** The end of the session whatever happens. */
  expires_at: IsoTime;
  ip: string | null;
  user_agent: string | null;
}

export interface Schema {
  setting: SettingTable;
  user_account: UserAccountTable;
  user_group: UserGroupTable;
  group_member: GroupMemberTable;
  session: SessionTable;
}
