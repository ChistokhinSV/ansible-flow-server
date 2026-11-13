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
  decidedBy?: string;
  decidedAt?: string;
  comment?: string;
  createdAt: string;
}

/** A waiting gate as the inbox lists it. */
export interface WaitingApproval {
  run: { id: string; number: number; project: string; flow: { file: string; name: string } };
  requestedBy: string;
  gate: Gate;
  mayDecide: boolean;
  /** Why not, when not. */
  why?: string;
}
