// AFS-67: the canvas's Run buttons open the designer's own launch dialog, backed by a launch
// configuration of the flow: its inputs start as the configuration's, the hosts are read from the
// inventory in the configuration's image, and Run launches it. With several configurations the
// person picks one first; the picker also offers a new one (AFS-97), as it does when there is none.
// Save as Launch Configuration in the dialog keeps its inputs as a new configuration like the one
// chosen (AFS-97, designer AFD-300).
import type { HostMessage } from '@ansible-flow/core/protocol';
import { inputText, type LaunchField, type LaunchPlan } from '@ansible-flow/core/run/launch';
import type { FactsReply } from '../server/launch/facts';

export interface ConfigChoice {
  id: string;
  name: string;
  description?: string;
  mode: 'check' | 'real';
}

interface Form {
  flow: { name: string };
  fields: LaunchField[];
  inventory?: string;
  eeImage?: string;
}

export interface LauncherDeps {
  project: string;
  /** The flow's file in the repository. */
  path: string;
  send(message: HostMessage): void;
  /** A run was launched: show it on the canvas, and the run list again. */
  launched(runId: string): void;
  /** Picks one of several configurations, or a new one; undefined: none (cancelled). */
  choose(configs: ConfigChoice[]): Promise<ConfigChoice | 'new' | undefined>;
  /** The name for a configuration saved from the dialog; undefined: cancelled. */
  askName(suggested: string): Promise<string | undefined>;
  /** Goes to a page of the server (the whole window, not the canvas's frame). */
  go(to: string): void;
  /** AFS-135: the person may add launch configurations (rw on the flow); default true. */
  mayAddConfig?: boolean;
}

type Reply = { ok: boolean; status: number; data: unknown };
const call = (url: string, body?: unknown): Promise<Reply> =>
  fetch(url, {
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  }).then(async (reply) => ({
    ok: reply.ok,
    status: reply.status,
    data: await reply.json().catch(() => undefined),
  }));

/** The dialog's values as the server reads typed inputs: text per input. */
const texts = (inputs: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(inputs).map(([name, value]) => [name, inputText(value)]));

const why = (reply: Reply, fallback: string): string =>
  reply.status === 403
    ? 'You may not launch this flow: that needs operator on it'
    : ((reply.data as { message?: string } | undefined)?.message ?? fallback);

export function launcher(deps: LauncherDeps) {
  /** The dialogs open now, by token: their configuration and plan. */
  const open = new Map<string, { config: string; plan: LaunchPlan }>();
  let next = 0;
  const notify = (level: 'info' | 'error', text: string) =>
    deps.send({ type: 'notify', level, text });
  const facts = (config: string, body: Record<string, unknown>) =>
    call(`/api/v1/launch-configs/${encodeURIComponent(config)}/facts`, body);

  /** Run on the canvas: the configuration, then the dialog with its fields and the hosts. */
  async function run(mode: 'check' | 'real'): Promise<void> {
    const list = await call(
      `/api/v1/projects/${encodeURIComponent(deps.project)}/launch-configs`,
    ).catch(() => undefined);
    if (!list?.ok) return notify('error', 'The launch configurations could not be read');
    const mine = (list.data as (ConfigChoice & { flowFile: string })[]).filter(
      (c) => c.flowFile === deps.path,
    );
    const config = mine.length === 1 ? mine[0] : await deps.choose(mine);
    if (!config) return;
    if (config === 'new') return newConfig();
    const id = encodeURIComponent(config.id);
    const form = await call(`/api/v1/launch-configs/${id}/form?mode=${mode}`).catch(
      () => undefined,
    );
    if (!form?.ok)
      return notify('error', form ? why(form, 'The launch form could not be read') : 'No answer');
    const { flow, fields, inventory, eeImage } = form.data as Form;
    notify('info', 'Reading the hosts from the inventory…');
    const start = Object.fromEntries(fields.filter((f) => !f.secret).map((f) => [f.name, f.text]));
    const read = await facts(config.id, { mode, groups: true, inputs: start }).catch(
      () => undefined,
    );
    if (!read?.ok)
      return notify('error', read ? why(read, 'The inventory could not be read') : 'No answer');
    const answer = read.data as FactsReply;
    const token = `afs-${Date.now().toString(36)}-${next++}`;
    const plan: LaunchPlan = {
      token,
      mode,
      flow: `${flow.name} · ${config.name}`,
      fields,
      groups: answer.groups ?? [],
      ...(answer.groupHosts ? { groupHosts: answer.groupHosts } : {}),
      ...(answer.facts ? { facts: answer.facts } : {}),
      ...(answer.factsError ? { factsError: answer.factsError } : {}),
      // A vault password comes from the configuration's credentials, never typed here.
      vault: false,
      environment: answer.environment || eeImage || 'the server’s image',
      ...((answer.inventory ?? inventory) ? { inventory: answer.inventory ?? inventory } : {}),
      // AFS-97: Save as Launch Configuration (a designer without it leaves it out).
      canSave: deps.mayAddConfig !== false,
    };
    open.set(token, { config: config.id, plan });
    deps.send({ type: 'launch', plan });
  }

  /** The dialog's inputs changed: the hosts for them. */
  async function check(token: string, inputs: Record<string, unknown>): Promise<void> {
    const dialog = open.get(token);
    if (!dialog) return;
    const read = await facts(dialog.config, {
      mode: dialog.plan.mode,
      inputs: texts(inputs),
    }).catch(() => undefined);
    const answer = read?.ok ? (read.data as FactsReply) : undefined;
    deps.send({
      type: 'launchFacts',
      token,
      ...(answer?.facts ? { facts: answer.facts } : {}),
      ...(answer
        ? answer.factsError
          ? { error: answer.factsError }
          : {}
        : { error: read ? why(read, 'The inventory could not be read') : 'No answer' }),
    });
  }

  /** Run in the dialog: the configuration is launched with these inputs. */
  async function launch(token: string, inputs: Record<string, unknown>): Promise<void> {
    const dialog = open.get(token);
    if (!dialog) return;
    const typed = texts(inputs);
    const reply = await call(`/api/v1/launch-configs/${encodeURIComponent(dialog.config)}/launch`, {
      mode: dialog.plan.mode,
      inputs: typed,
    }).catch(() => undefined);
    if (reply?.ok) {
      open.delete(token);
      deps.send({ type: 'launch', plan: null });
      deps.launched((reply.data as { id: string }).id);
      return;
    }
    // The dialog again, with what was typed (secrets typed again) and why it did not start.
    const plan: LaunchPlan = {
      ...dialog.plan,
      fields: dialog.plan.fields.map((f) =>
        f.secret || typed[f.name] === undefined ? f : { ...f, text: typed[f.name] ?? '' },
      ),
    };
    dialog.plan = plan;
    deps.send({
      type: 'launch',
      plan,
      notice: reply ? why(reply, 'The run did not start') : 'The server does not answer',
    });
  }

  /** The page that adds a configuration of this flow, in its workspace and project. */
  async function newConfig(): Promise<void> {
    const project = await call(`/api/v1/projects/${encodeURIComponent(deps.project)}`).catch(
      () => undefined,
    );
    const p = project?.ok ? (project.data as { key: string; workspace: string }) : undefined;
    const space = p
      ? await call(`/api/v1/workspaces/${encodeURIComponent(p.workspace)}`).catch(() => undefined)
      : undefined;
    const w = space?.ok ? (space.data as { key: string }) : undefined;
    if (!p || !w) return notify('error', 'The project could not be read');
    deps.go(
      `/w/${encodeURIComponent(w.key)}/${encodeURIComponent(p.key)}/launch/new?flow=${encodeURIComponent(deps.path)}`,
    );
  }

  /**
   * Save as Launch Configuration in the dialog: a new configuration like the one the dialog was
   * opened with (inventory, image, credentials, branch, whom it tells), with the dialog's mode and
   * its inputs as typed (the designer leaves secrets out). The dialog stays open.
   */
  async function save(token: string, inputs: Record<string, unknown>): Promise<void> {
    const dialog = open.get(token);
    if (!dialog) return;
    const read = await call(`/api/v1/launch-configs/${encodeURIComponent(dialog.config)}`).catch(
      () => undefined,
    );
    if (!read?.ok) return notify('error', 'The launch configuration could not be read');
    const from = read.data as {
      name: string;
      project: string;
      flowFile: string;
      description?: string;
      gitRef?: string;
      commit?: string;
      inventory?: string;
      eeImage?: string;
      environment?: string;
      limit?: string;
      credentials: string[];
      notify?: unknown;
    };
    const name = await deps.askName(`${from.name} (copy)`);
    if (!name) return;
    const reply = await call(
      `/api/v1/projects/${encodeURIComponent(from.project)}/launch-configs`,
      {
        name,
        ...(from.description ? { description: from.description } : {}),
        flowFile: from.flowFile,
        gitRef: from.gitRef ?? null,
        commit: from.commit ?? null,
        inventory: from.inventory ?? null,
        eeImage: from.eeImage ?? null,
        environment: from.environment ?? null,
        limit: from.limit ?? null,
        credentials: from.credentials,
        notify: from.notify ?? null,
        mode: dialog.plan.mode,
        inputs,
      },
    ).catch(() => undefined);
    if (reply?.ok) return notify('info', `Saved as the launch configuration "${name}".`);
    notify(
      'error',
      reply?.status === 403
        ? 'You may not add launch configurations: that needs rw on this flow'
        : reply
          ? why(reply, 'The launch configuration was not saved')
          : 'The server does not answer',
    );
  }

  return {
    run,
    check,
    launch,
    save,
    cancel: (token: string) => void open.delete(token),
  };
}

/**
 * Asks which configuration to launch, in a dialog styled as the designer's own; resolves with the
 * one picked, or undefined on Cancel or Escape.
 */
export function chooseConfig(configs: ConfigChoice[]): Promise<ConfigChoice | 'new' | undefined> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'afd-modal-backdrop';
    const box = document.createElement('div');
    box.className = 'afd-modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'afs-choose-title');
    const title = document.createElement('h2');
    title.id = 'afs-choose-title';
    title.textContent = 'Which launch configuration?';
    const list = document.createElement('div');
    list.className = 'afs-choose';
    const done = (picked: ConfigChoice | 'new' | undefined) => {
      backdrop.remove();
      resolve(picked);
    };
    for (const c of configs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = `${c.name} (${c.mode})`;
      if (c.description) button.title = c.description;
      button.addEventListener('click', () => done(c));
      list.append(button);
    }
    // AFS-97: a configuration of its own for this flow, on the page that adds one.
    if (configs.length === 0) {
      const none = document.createElement('p');
      none.className = 'muted';
      none.textContent = 'This flow has no launch configuration yet.';
      list.append(none);
    }
    const fresh = document.createElement('button');
    fresh.type = 'button';
    fresh.className = 'secondary afs-choose-new';
    fresh.textContent = 'New configuration…';
    fresh.title = 'Add a launch configuration for this flow';
    fresh.addEventListener('click', () => done('new'));
    list.append(fresh);
    const actions = document.createElement('div');
    actions.className = 'afd-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => done(undefined));
    actions.append(cancel);
    box.append(title, list, actions);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(undefined);
      }
    });
    backdrop.append(box);
    document.body.append(backdrop);
    (list.querySelector('button') as HTMLButtonElement | null)?.focus();
  });
}

/** Asks for a name, in a dialog styled as the designer's own; undefined on Cancel or Escape. */
export function askName(suggested: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'afd-modal-backdrop afs-ask';
    const box = document.createElement('form');
    box.className = 'afd-modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'afs-ask-title');
    const title = document.createElement('h2');
    title.id = 'afs-ask-title';
    title.textContent = 'Save as launch configuration';
    const label = document.createElement('label');
    label.htmlFor = 'afs-ask-name';
    label.textContent = 'Name';
    const input = document.createElement('input');
    input.id = 'afs-ask-name';
    input.className = 'afd-input';
    input.value = suggested;
    input.required = true;
    input.maxLength = 100;
    const help = document.createElement('p');
    help.className = 'muted';
    help.textContent =
      'Like the configuration this dialog runs, with this mode and these inputs. Secret inputs are never kept.';
    const actions = document.createElement('div');
    actions.className = 'afd-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.textContent = 'Save';
    actions.append(cancel, ok);
    const done = (name: string | undefined) => {
      backdrop.remove();
      resolve(name);
    };
    cancel.addEventListener('click', () => done(undefined));
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (name) done(name);
    });
    box.addEventListener('keydown', (e) => {
      // The launch dialog under this one must not take the keys.
      e.stopPropagation();
      if (e.key === 'Escape') done(undefined);
    });
    box.append(title, label, input, help, actions);
    backdrop.append(box);
    document.body.append(backdrop);
    input.focus();
    input.select();
  });
}
