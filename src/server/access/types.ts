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
