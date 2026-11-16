// The words of access levels, shared with the pages (which must not load the server's code).
export const LEVELS = ['ro', 'operator', 'rw'] as const;
export type Level = (typeof LEVELS)[number];
export type GrantLevel = Level | 'approve';

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
  flows: { project: string; file: string; level: Level | null }[];
  through: string[];
}

/** What one person reaches in a workspace: their row of its "who can do what", by its name. */
export type Reached = Reach & { workspace: WorkspaceName };

/** What one person reaches: a row per workspace; an administrator reaches all, without rows. */
export interface UserReach {
  admin: boolean;
  workspaces: Reached[];
}

/** A grant that names a group, with the workspace it is in. */
export type GroupGrant = Omit<Grant, 'principal' | 'workspace'> & { workspace: WorkspaceName };
