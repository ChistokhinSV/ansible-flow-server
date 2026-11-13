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

/** A team's space: its projects, and later its credentials and who may do what in it. */
export interface WorkspaceTable {
  id: string;
  /** Its short name in addresses; lower case, unique. */
  key: string;
  name: string;
  description: string | null;
  created_at: IsoTime;
  updated_at: IsoTime;
}

/** How a project's mirror stands against its source. */
export type SyncState = 'never' | 'ok' | 'error';

/** A git repository whose flows the server runs. */
export interface ProjectTable {
  id: string;
  workspace_id: string;
  /** Its short name in addresses; unique in its workspace. */
  key: string;
  name: string;
  /**
   * Where the repository is fetched from. Never holds a password. Empty: the server hosts the
   * repository itself.
   */
  git_url: string;
  /** The branch whose commits may run. */
  git_ref: string;
  /** The commit that branch was at when the mirror was last brought up to date. */
  commit_id: string | null;
  sync_state: SyncState;
  /** Why the last attempt failed, in words for the project's page. */
  sync_error: string | null;
  /** When the source was last asked, whether it answered or not. */
  synced_at: IsoTime | null;
  /** Ask the source this often, in seconds; 0: only when told to. */
  poll_seconds: number;
  /** SHA-256 of the token a push hook must show; null: no hook. */
  hook_token_hash: string | null;
  created_at: IsoTime;
  updated_at: IsoTime;
}

/** A personal access token: a program acts as its owner with it. */
export interface ApiTokenTable {
  id: string;
  user_id: string;
  name: string;
  /** SHA-256 of the token, in hex. */
  token_hash: string;
  /** The token's last four characters, to tell one from another. */
  hint: string;
  read_only: Flag;
  created_at: IsoTime;
  last_used_at: IsoTime | null;
  expires_at: IsoTime | null;
}

/** One branch changed by one push through the server. */
export interface GitPushTable {
  id: string;
  project_id: string;
  /** Who pushed; kept as text too, for when the person is gone. */
  user_id: string;
  login: string;
  /** The branch, without refs/heads/. */
  ref: string;
  /** The commit before; null: the branch was made by this push. */
  old_commit: string | null;
  /** The commit after; null: the branch was deleted by this push. */
  new_commit: string | null;
  created_at: IsoTime;
}

export interface Schema {
  git_push: GitPushTable;
  setting: SettingTable;
  api_token: ApiTokenTable;
  workspace: WorkspaceTable;
  project: ProjectTable;
  user_account: UserAccountTable;
  user_group: UserGroupTable;
  group_member: GroupMemberTable;
  session: SessionTable;
}
