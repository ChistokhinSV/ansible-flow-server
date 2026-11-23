// The words of access levels, shared with the pages (which must not load the server's code).
export const LEVELS = ['ro', 'operator', 'rw'] as const;
export type Level = (typeof LEVELS)[number];
export type GrantLevel = Level | 'approve';

/** AFS-152: a level as people say it, not its code (AFS-195: the audit log says it so too). */
export const LEVEL_NAME: Record<GrantLevel, string> = {
  ro: 'read only',
  operator: 'operator',
  rw: 'read and write',
  approve: 'approver',
};

export interface Grant {
  id: string;
  principal: { type: 'user' | 'group'; id: string; name: string };
  level: GrantLevel;
  workspace: string;
  /** Set for a grant on one flow. */
  flow?: { project: string; projectKey: string; file: string };
  createdAt: string;
  createdBy: string;
}

/** A workspace as a list across workspaces names it. */
export interface WorkspaceName {
  id: string;
  key: string;
  name: string;
}

/**
 * What a person reaches in one workspace, as their grants there come out: the level on the
 * workspace, the flows with a grant of their own, whether they approve, and whose grants gave it
 * (`user:omar`, `group:netops`).
 */
export interface Reach {
  level: Level | null;
  approve: boolean;
  /** `project` is the project's key; `projectId` its id (AFS-152: the pages read its flows' titles). */
  flows: { project: string; projectId: string; file: string; level: Level | null }[];
  /**
   * AFS-206: the actions an action grant lets them run (their own or a group's): one access
   * table says everything a person reaches (ADR-0036's grants are not levels, but are access).
   */
  actions: ReachedAction[];
  through: string[];
}

/** AFS-206: an action a person may run through an action grant, by its title. */
export interface ReachedAction {
  /** The action's id: its launch configuration's. */
  config: string;
  title: string;
  /** The project's key, for the address of the configuration's Settings. */
  projectKey: string;
  /** Whose grant gave it: `user:eve`, `group:change-board`. */
  through: string;
}

/** What one person reaches in a workspace: their row of its "who can do what", by its name. */
export type Reached = Reach & { workspace: WorkspaceName };

/** What one person reaches: a row per workspace; an administrator reaches all, without rows. */
export interface UserReach {
  admin: boolean;
  workspaces: Reached[];
  /**
   * AFS-206: an approve grant anywhere (on a workspace or a flow): who may decide approvals. Flows
   * may name approvers too; those are not counted here.
   */
  approves?: boolean;
}

/** AFS-152: one's own access (GET /session/access), with who gives access: the administrators. */
export interface MyAccess extends UserReach {
  administrators: string[];
}

/** A grant that names a group, with the workspace it is in. */
export type GroupGrant = Omit<Grant, 'principal' | 'workspace'> & { workspace: WorkspaceName };
