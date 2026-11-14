// What a launch would touch, as its inventory has it (AFS-67). Types only, so the web
// application uses them without the server.
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import type { LaunchFacts } from '@ansible-flow/core/run/launch';

/** What the launch dialog needs to know of a launch's inventory. */
export interface InventoryAnswer {
  facts?: LaunchFacts;
  /** Why there are no facts: the targets are empty, nothing matches, the image did not answer. */
  factsError?: string;
  /** The inventory's groups and what each holds (only when asked). */
  groups?: string[];
  groupHosts?: Record<string, { count: number; hosts: string[] }>;
  /** The image the inventory was read in, as the run's log names it. */
  environment: string;
}

/** The facts route's answer: the inventory's, with the launch's inventory file and commit. */
export interface FactsReply extends InventoryAnswer {
  inventory?: string;
  commit: string;
  /** The input that does not read yet, when that is why there are no facts. */
  field?: string;
}

/** What a launch's inventory is read with. */
export interface InventoryQuestion {
  project: string;
  commit: string;
  doc: FlowDocument;
  inputs: Record<string, unknown>;
  inventory?: string;
  image: string;
  credentials: string[];
  /** Also the inventory's groups (the dialog opening), not only the facts. */
  groups?: boolean;
}
