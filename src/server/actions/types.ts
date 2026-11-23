// AFS-175: the words of actions, shared with the pages (which must not load the server's code).
// An action is a launch configuration marked as one: a plain title, a sentence, the inputs it
// asks in its runners' words, and who may run it. ADR-0036.

export type ActionMode = 'check' | 'real';

/** AFS-176: the systems a run started from a link can tell how it ended (ADR-0037). */
export const ACTION_SYSTEMS = ['netbox', 'zabbix'] as const;
export type ActionSystem = (typeof ACTION_SYSTEMS)[number];
export const SYSTEM_NAME: Record<ActionSystem, string> = { netbox: 'NetBox', zabbix: 'Zabbix' };

/**
 * AFS-176: the query name of a link that says where a run's result goes back to (a NetBox object,
 * a Zabbix problem). Not an input: it never reaches the flow.
 */
export const REPLY_PARAM = '_reply';

/**
 * AFS-176: what a link's `_reply` names, by system: a NetBox object (`dcim.device:1`) or a Zabbix
 * event (`event:2048`). Undefined when it is not one.
 */
export function replyObject(
  system: ActionSystem,
  value: string,
): { type: string; id: string } | undefined {
  const m =
    system === 'netbox'
      ? /^([a-z][a-z0-9_]{0,40}\.[a-z][a-z0-9_]{0,40}):(\d{1,12})$/.exec(value.trim())
      : /^(event):(\d{1,20})$/.exec(value.trim());
  return m?.[1] && m[2] ? { type: m[1], id: m[2] } : undefined;
}

/** AFS-176: where a run started from a link tells how it ended: a system, its credential, when. */
export interface ActionReply {
  system: ActionSystem;
  /** A credential of the workspace, of the system's kind (its address and token). */
  credential: string;
  /** failed: only when a run did not succeed; ended: every run that ends. */
  when: 'ended' | 'failed';
}

/** AFS-176: a signed link's token, as its action's Settings list it (never the token itself). */
export interface ActionToken {
  id: string;
  name: string;
  /** Its last four characters, to tell one from another. */
  hint: string;
  createdAt: string;
  createdBy: string;
  lastUsedAt?: string;
}

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
  /** AFS-176: a host list without choices: only the hosts of this inventory group. */
  group?: string;
  /**
   * AFS-207: a host list: the value the form starts with. None: it starts empty and the runner
   * picks (never the configuration's value, which may be a whole group).
   */
  start?: string;
  /** AFS-207: a host list: at most this many hosts (1: one host), a group counted by its hosts. */
  max?: number;
}

/** An action's settings, as its configuration's Settings tab sets them. */
export interface ActionSettings {
  title: string;
  summary: string;
  asked: ActionInput[];
  mode: ActionMode;
  confirm: boolean;
  enabled: boolean;
  /**
   * AFS-176: a link with every value runs when its page opens (by the page's own POST; a GET
   * never runs anything). Off by default.
   */
  runOnOpen?: boolean;
  /** AFS-176: where a run started from a link tells how it ended; none when absent. */
  reply?: ActionReply | null;
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
  action: {
    title: string;
    config: string;
    project: string;
    projectKey: string;
    /** AFS-207: on a group's page, which lists them across workspaces. */
    workspaceKey?: string;
  };
}

/** AFS-206: an action of a workspace as its Access tab lists it: with who may run it. */
export interface WorkspaceAction {
  /** The action's id: its launch configuration's. */
  config: string;
  title: string;
  enabled: boolean;
  configName: string;
  /** The flow it runs (its file). */
  file: string;
  project: string;
  projectKey: string;
  projectName: string;
  /** Who may run it through a grant; operators of the flow and administrators may too. */
  grants: ActionGrant[];
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
  /** AFS-176: the inventory group its hosts are picked from. */
  group?: string;
  /** AFS-207: a host list takes at most this many hosts (1: one host). */
  max?: number;
  /** The value it starts with: the configuration's; a host list's, the action's own (AFS-207). */
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
  /** AFS-176: a link with every value runs as its page opens. */
  runOnOpen?: boolean;
  /** AFS-176: the system a run started from a link tells how it ended. */
  replies?: ActionSystem;
}

/**
 * AFS-176: what a link to an action gives (`/a/<action>?<input>=<value>`): its form, the values,
 * and whether it is ready to run (every asked value there and right) or a short form is needed.
 */
export interface ActionLink {
  form: ActionForm;
  /** Every asked input's value: the link's, else its start value. */
  values: Record<string, string>;
  /** The names the link gave a value for. */
  given: string[];
  /** Required inputs still empty. */
  missing: string[];
  /** Values that are not right, at their names, in the form's words. */
  problems: { field: string; message: string }[];
  /** Ready: every asked value is there and right; the page only confirms. */
  ready: boolean;
  /** The link names something the action does not ask: said in words, nothing to fill. */
  refused?: string;
  /** Where the result goes back (`_reply`), when the action tells a system and the link says it. */
  reply?: string;
  /** Why the result does not go back, when the link tried to say where and could not. */
  replyNote?: string;
  /** AFS-207: how many hosts each host list's value names (a group by its hosts), when known. */
  counts?: Record<string, number>;
}

/** The inventory's names a host list of an action offers. */
export interface ActionHosts {
  hosts: string[];
  groups: string[];
  /** The inventory has a dynamic source: its hosts are known only when it runs. */
  dynamic?: boolean;
  /** AFS-176: the hosts of each group the action narrows a host list to. */
  inGroup?: Record<string, string[]>;
  /** AFS-207: how many hosts each group offered has (its children's too). */
  sizes?: Record<string, number>;
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
