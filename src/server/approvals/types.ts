// The words of approval gates (AFS-28), shared with the pages (which must not load the server's
// code).
export type GateStatus = 'waiting' | 'approved' | 'rejected' | 'timed out' | 'cancelled';

export interface Gate {
  id: string;
  run: string;
  node: { id: string; key: string; title: string };
  segment: string;
  status: GateStatus;
  /** When it times out. */
  deadline?: string;
  approvers: string[];
  notify: string[];
  message?: string;
  /**
   * AFS-193: the approval step's intent, for an approval without a message: what the approvers
   * read about what they decide.
   */
  intent?: string;
  decidedBy?: string;
  decidedAt?: string;
  comment?: string;
  /** AFS-133: the hosts that waited here, for whoever decides (from the carried host sets). */
  hosts?: string[];
  /** AFS-146: who decided, by display name (decidedBy is the login). */
  decidedByName?: string;
  /**
   * AFS-146: who may decide it, by name: the approval's approvers, else the people and groups
   * holding approve on the flow or its workspace (administrators may always).
   */
  deciders?: string[];
  /** AFS-146: the step each decision sends the waiting hosts to, by its title. */
  next?: { approved?: string; rejected?: string; timeout?: string };
  /**
   * AFS-271: the steps the hosts go through once approved, by title, in order (from the flow at
   * the run's commit), up to an end or a branch: what an approver lets happen.
   */
  after?: string[];
  /**
   * AFS-271: what a decider can weigh while it waits: the last check run of the same launch
   * configuration that had ended when this run was launched (none: an empty object). Absent for a
   * run of no configuration.
   */
  evidence?: { checkRun?: CheckRunEvidence };
  createdAt: string;
}

/** AFS-271: a check run a decider can weigh: how it went, when, and whether at the same commit. */
export interface CheckRunEvidence {
  id: string;
  number: number;
  state: string;
  endedAt?: string;
  sameCommit: boolean;
}

/**
 * AFS-146, AFS-211: who may decide a gate, as a phrase: "Sam Reyes", "Sam Reyes or change-board";
 * nobody named: an administrator (who always may).
 */
export function decidersWords(names: readonly string[]): string {
  if (!names.length) return 'An administrator';
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

/** A waiting gate as the inbox lists it. */
export interface WaitingApproval {
  run: {
    id: string;
    number: number;
    project: string;
    flow: { file: string; name: string };
    /** AFS-146: what the approver needs to decide (not on decided ones). */
    projectName?: string;
    workspaceName?: string;
    /** AFS-274: the workspace it is in, on every approval (decided ones too). */
    workspace?: { key: string; name: string };
    mode?: 'check' | 'real';
    /** The run's inputs, secret-looking values shown as ***. */
    inputs?: Record<string, unknown>;
  };
  requestedBy: string;
  /** AFS-146: who launched the run, by display name. */
  requestedByName?: string;
  gate: Gate;
  mayDecide: boolean;
  /** Why not, when not. */
  why?: string;
}
