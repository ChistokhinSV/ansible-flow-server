// AFS-175: the words of actions, shared with the pages (which must not load the server's code).
// An action is a launch configuration marked as one: a plain title, a sentence, the inputs it
// asks in its runners' words, and who may run it. ADR-0036.

export type ActionMode = 'check' | 'real';

/** One input an action asks, in its runners' words. */
export interface ActionInput {
  /** The flow's input it fills. */
  name: string;
  /** What the form calls it ("Switch", not "devices"). */
  label: string;
  /** One line under the field, in plain words. */
  help?: string;
  /** Only these values; a host list: only these names (one or more). */
  choices?: string[];
}

/** An action's settings, as its configuration's Settings tab sets them. */
export interface ActionSettings {
  title: string;
  summary: string;
  asked: ActionInput[];
  mode: ActionMode;
  confirm: boolean;
  enabled: boolean;
}

/** An action's settings as read: with its owner (who set it last) and when. */
export interface Action extends ActionSettings {
  /** The launch configuration's id: one configuration, one action. */
  id: string;
  owner?: { login: string; name: string };
  updatedAt: string;
}

/** Someone who may run an action: a person or a group. */
export interface ActionGrant {
  id: string;
  config: string;
  principal: { type: 'user' | 'group'; id: string; name: string };
  createdAt: string;
  createdBy: string;
}

/** An action grant as the workspace's Access tab lists it: with the action's title. */
export interface WorkspaceActionGrant extends ActionGrant {
  action: { title: string; config: string; project: string; projectKey: string };
}

/** A run of an action, as a card or the progress view says it. */
export interface ActionRunLine {
  id: string;
  number: number;
  state: string;
  createdAt: string;
  endedAt?: string;
  /** The state in words: "went well", "failed", "waiting for approval". */
  words: string;
}

/** An action on the Actions page. */
export interface ActionCard {
  id: string;
  title: string;
  summary: string;
  mode: ActionMode;
  workspace: { key: string; name: string };
  /** The newest run of it that I started. */
  lastRun?: ActionRunLine;
}

/** One field of an action's form. */
export interface ActionField {
  name: string;
  label: string;
  help?: string;
  /** The flow's type of the input: host_list, string, integer, boolean, list, dict. */
  type?: string;
  required: boolean;
  choices?: string[];
  /** A host list without choices: its names can be picked from the inventory (hosts route). */
  hosts?: boolean;
  /** The value it starts with (the configuration's). */
  text: string;
}

/** An action's form: only the asked inputs, and what will happen in words. */
export interface ActionForm {
  id: string;
  title: string;
  summary: string;
  mode: ActionMode;
  confirm: boolean;
  fields: ActionField[];
  /** What will happen, a sentence each: the mode, the fixed values, the approvals on the way. */
  happens: string[];
  /** Whom to ask about it: its owner, then the administrators. */
  ask: string[];
  /** Why it cannot run now (its flow is gone, has errors): said instead of a form that fails. */
  blocked?: string;
  /** Who may also open its configuration (ro on the flow): the address of its page. */
  configPage?: string;
}

/** The inventory's names a host list of an action offers. */
export interface ActionHosts {
  hosts: string[];
  groups: string[];
  /** The inventory has a dynamic source: its hosts are known only when it runs. */
  dynamic?: boolean;
  /** Why there are no names to pick. */
  why?: string;
}

export type StepState = 'done' | 'running' | 'waiting' | 'failed' | 'not run' | 'to do';

/** How a run of an action goes, in words: what the progress view shows. */
export interface ActionProgress {
  action: { id: string; title: string };
  run: ActionRunLine & { mode: ActionMode; startedBy: string; startedAt?: string };
  /** One sentence: where it is now. */
  headline: string;
  /** `id`: the step's id, for a list's key only (never shown). */
  steps: { id: string; title: string; state: StepState }[];
  done: number;
  total: number;
  /** An approval it waits at: the step, and who may decide it. */
  waiting?: { step: string; by: string[]; since: string };
  /** Why it failed, in words. */
  failed?: string;
  /** Whom to ask: the action's owner, then the administrators. */
  ask: string[];
  /** The values it was asked for, by their labels; a secret-looking one as ***. */
  inputs: { label: string; value: string }[];
  /** The full run page, only for who may see the run. */
  runPage?: string;
  /** May run the action again (the form's address). */
  again?: string;
}
