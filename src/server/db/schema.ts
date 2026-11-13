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
  /** The credential the server signs in to the source with; null: none. */
  git_credential_id: string | null;
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

/** A credential of a workspace; its secret part is sealed with the master key. */
export interface CredentialTable {
  id: string;
  workspace_id: string;
  /** Unique in its workspace. */
  name: string;
  /** What it holds (secrets/credentials.ts). */
  kind: string;
  description: string | null;
  /** The part that is not secret, as JSON. */
  fields_json: string;
  /** The names of the secret parts it holds, as JSON. */
  has_json: string;
  /** The secret part: JSON, sealed (secrets/crypto.ts). */
  secret_enc: string;
  created_at: IsoTime;
  updated_at: IsoTime;
}

/** A flow of a project with what a run of it needs, saved under a name. */
export interface LaunchConfigTable {
  id: string;
  project_id: string;
  /** Unique in its project. */
  name: string;
  description: string | null;
  flow_file: string;
  /** Another branch than the project's; null: the project's. */
  git_ref: string | null;
  /** A pinned commit; null: the newest of the branch. */
  commit_id: string | null;
  inventory: string | null;
  ee_image: string | null;
  /** check or real. */
  mode: string;
  run_limit: string | null;
  /** Start values of the flow's inputs, as JSON. */
  inputs_json: string;
  created_at: IsoTime;
  updated_at: IsoTime;
}

/** A credential a launch configuration's runs get. */
export interface LaunchConfigCredentialTable {
  config_id: string;
  credential_id: string;
  /** The order they were named in. */
  position: number;
}

/** A run of a flow: what it is of, where it is in the queue, and how it ended. */
export interface RunTable {
  id: string;
  /** Counts the project's runs. */
  number: number;
  project_id: string;
  /** The launch configuration it came from; kept as text, the configuration may go. */
  config_id: string | null;
  config_name: string | null;
  commit_id: string;
  git_ref: string | null;
  flow_file: string;
  flow_key: string;
  flow_name: string;
  flow_version: number;
  mode: string;
  inventory: string | null;
  ee_image: string | null;
  run_limit: string | null;
  /** The inputs in full, as JSON, sealed with the master key (secrets/crypto.ts). */
  inputs_enc: string;
  /** The inputs with secret-looking values as ***, as JSON. */
  inputs_shown_json: string;
  targets_json: string;
  credentials_json: string;
  /** queued, running, waiting, succeeded, failed, cancelled, lost (runs/queue.ts). */
  state: string;
  requested_by: string;
  requested_login: string;
  created_at: IsoTime;
  updated_at: IsoTime;
  claimed_at: IsoTime | null;
  started_at: IsoTime | null;
  ended_at: IsoTime | null;
  /** How many times a worker took it. */
  attempts: number;
  /** The worker that has it, its lease's token, and until when. */
  lease_owner: string | null;
  lease_token: string | null;
  lease_until: IsoTime | null;
  cancel_requested: Flag;
  cancelled_by: string | null;
  error: string | null;
  /** How the run went, as the designer shows it (its RunView), as JSON. */
  view_json: string | null;
  /** The designer's folder of the run: its events. */
  run_dir: string | null;
}

export interface Schema {
  run: RunTable;
  launch_config: LaunchConfigTable;
  launch_config_credential: LaunchConfigCredentialTable;
  credential: CredentialTable;
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
