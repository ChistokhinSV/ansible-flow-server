// AFS-212: what `GET /api/v1/inbox` answers (inbox.ts). Kept apart, with no imports, so the
// pages' build reads the types without the server's code.
export type InboxKind = 'approval' | 'paused' | 'failed' | 'draft' | 'certificate' | 'request';
export type InboxVerb =
  | 'review'
  | 'open'
  | 'step'
  | 'continue'
  | 'runAgain'
  | 'openDraft'
  | 'replace';

export interface InboxPlace {
  id: string;
  key: string;
  name: string;
}

export interface InboxRun {
  id: string;
  number: number;
  flow: { file: string; name: string };
  mode: 'check' | 'real';
  /** The launch configuration's name, as it was then. */
  config?: string;
  /** A debug run (its pauses are a debugger's). */
  debug?: true;
  /** The asker reaches it only as a runner of an action: it opens as the action's progress. */
  asRunner?: true;
}

export interface InboxItem {
  kind: InboxKind;
  /** Absent: about the whole server (the certificate). */
  workspace?: InboxPlace;
  project?: InboxPlace;
  /** What it is, in words, for a client that does not know the kind. */
  title: string;
  /** Since when it waits. */
  since: string;
  /** What the asker may do from here, in the workspace's access: the first is the main one. */
  verbs: InboxVerb[];
  run?: InboxRun;
  /** An approval: the step that asks, who launched the run, who may decide. */
  approval?: { gate: string; step: string; requestedBy: string; deciders?: string[] };
  /** A paused run: the step it waits before, and when it stops by itself. */
  pause?: { before: string; stopsAt?: string };
  /** A failed run: why, in words, and its hosts. */
  failure?: { error?: string; hosts?: { total: number; failed: number }; lost?: true };
  /** A draft the asker changed and nobody saved: whether the flow moved on since it began. */
  draft?: { id: string; file: string; flow: string; others: string[]; behind: boolean };
  certificate?: { notAfter: string; daysLeft: number; names: string[] };
}

export interface InboxDay {
  runs: number;
  real: number;
  check: number;
  succeeded: number;
  /** Failed for another reason than a decision, or lost. */
  failed: number;
  /** Failed because its approval was rejected or not decided in time. */
  rejected: number;
  cancelled: number;
  /** Queued, or running and not paused. */
  going: number;
  /** Waiting for a decision. */
  waiting: number;
  /** Paused step by step; `pausedDebug` of them debug runs. */
  paused: number;
  pausedDebug: number;
}

export interface Inbox {
  /** How many items need the asker: every item but their own runs that wait for others. */
  count: number;
  items: InboxItem[];
  /** The runs made since the start of the asker's day (`since`), of what they may see. */
  today: InboxDay;
  /** The runs of the last seven days that ended, and how many of those went well. */
  week: { ended: number; succeeded: number };
  /** The whole server's: runs going at once (`busy`), at most `slots`, and those in the queue. */
  runners: { busy: number; slots: number; queued: number };
}
