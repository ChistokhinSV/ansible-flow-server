// AFS-67: the canvas's Run buttons open the designer's own launch dialog, backed by a launch
// configuration of the flow: its inputs start as the configuration's, the hosts are read from the
// inventory in the configuration's image, and Run launches it. With several configurations the
// person picks one first; with none, the canvas says where to add one.
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
  /** Picks one of several configurations; undefined: none (cancelled). */
  choose(configs: ConfigChoice[]): Promise<ConfigChoice | undefined>;
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
    if (mine.length === 0)
      return notify(
        'info',
        'This flow has no launch configuration yet: add one on the project page to run it here.',
      );
    const config = mine.length === 1 ? mine[0] : await deps.choose(mine);
    if (!config) return;
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

  return {
    run,
    check,
    launch,
    cancel: (token: string) => void open.delete(token),
  };
}

/**
 * Asks which configuration to launch, in a dialog styled as the designer's own; resolves with the
 * one picked, or undefined on Cancel or Escape.
 */
export function chooseConfig(configs: ConfigChoice[]): Promise<ConfigChoice | undefined> {
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
    const done = (picked: ConfigChoice | undefined) => {
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
