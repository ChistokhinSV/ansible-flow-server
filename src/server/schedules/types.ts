// What a schedule looks like to the API and the pages (AFS-34). Types only, so the web
// application uses them without the server's code.

import type { FlowError } from '../flowErrors';

export type ScheduleKind = 'cron' | 'once';
export type MissedPolicy = 'once' | 'skip';
export type OverlapPolicy = 'skip' | 'queue';
export type FireResult = 'ok' | 'skipped' | 'refused' | 'failed';

export interface Schedule {
  id: string;
  config: string;
  name: string;
  kind: ScheduleKind;
  cron?: string;
  timezone: string;
  /** For a one-time schedule: when. */
  onceAt?: string;
  enabled: boolean;
  /** Absent: the configuration's mode. */
  mode?: 'check' | 'real';
  /** Input values, as typed, over the configuration's start values. Never a secret. */
  inputs: Record<string, string>;
  /** A pinned commit; absent: the newest on the configuration's branch when it fires. */
  commit?: string;
  missed: MissedPolicy;
  overlap: OverlapPolicy;
  /** AFS-153: `name` is the owner's name, for the pages to show (absent when they have none). */
  owner: { id: string; login: string; name?: string };
  /** When it fires next; absent while disabled or after a one-time schedule fired. */
  next?: string;
  /** The next few times, for people to check the cron reads as they meant. */
  upcoming: string[];
  last?: {
    at: string;
    result: FireResult;
    detail?: string;
    /** AFS-170: a flow that could not run: its errors, each with the step it is on. */
    errors?: FlowError[];
    run?: string;
    /** AFS-139: the run it launched as it stands now (its number and state), while it is kept. */
    runNumber?: number;
    runState?: string;
  };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleInput {
  name: string;
  kind: ScheduleKind;
  cron?: string;
  timezone?: string;
  onceAt?: string;
  enabled?: boolean;
  mode?: 'check' | 'real' | null;
  inputs?: Record<string, string>;
  commit?: string | null;
  missed?: MissedPolicy;
  overlap?: OverlapPolicy;
}
