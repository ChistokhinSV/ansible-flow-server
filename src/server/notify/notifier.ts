// Notifications (AFS-29): what happens is told to whom it concerns.
//   approval.waiting       a run waits at an approval: its approvers (as the approval names them,
//                          else who holds the approve grant), and whom the approval's notify names
//   approval.decided       approved, rejected or timed out: who launched the run, and the notify list
//   run.ended              as a launch configuration says: when its runs fail, or whenever they end
//   certificate.expiring   the server certificate nears its end: the administrators, once per step
// Events are written to the outbox (store.ts) and sent from there by the channels, with tries again
// on failures that can pass. What happens never waits for its notification, and never fails
// because of one: an error here is logged.

import type { Kysely } from 'kysely';
import { waitingHosts } from '../approvals/gates';
import type { Schema } from '../db/schema';
import type { Logger } from '../log';
import { STATE_WORDS } from '../runs/words';
import type { CertificateInfo } from '../tls/certificates';
import type { Channel, Message } from './channels';
import {
  adminContacts,
  approverContacts,
  contactsOfNames,
  launcherContacts,
  placesOf,
} from './recipients';
import {
  enqueue,
  getDelivery,
  markFailed,
  markSent,
  type Outgoing,
  pruneDeliveries,
  shownTarget,
  takeDue,
} from './store';
import type { ChannelKind, Delivery, EventKind, RunNotify } from './types';

type Db = Kysely<Schema>;

/** The days before a certificate's end at which administrators are told; then once it ended. */
export const CERTIFICATE_STEPS = [30, 14, 7, 3, 1];

export interface NotifierOptions {
  /** Where links point (AFS_PUBLIC_URL); without it messages carry no links. */
  publicUrl?: string;
  /** Sent and given-up messages are kept this many days. */
  keepDays: number;
  /** How often the outbox is looked at. */
  everyMs?: number;
}

/** A time as a message says it: `2026-11-13 21:26 UTC` (the payload keeps the exact time). */
const readable = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

interface RunFacts {
  id: string;
  number: number;
  state: string;
  mode: string;
  flowFile: string;
  flowName: string;
  configId: string | null;
  configName: string | null;
  requestedBy: string;
  requestedLogin: string;
  /** AFS-146: who launched it, by display name (the login when they have none). */
  requestedName: string;
  /** The inputs, secret-looking values as ***. */
  inputs: Record<string, unknown>;
  error: string | null;
  project: { id: string; key: string; name: string };
  workspace: { id: string; key: string; name: string };
}

const ENDED = new Set(['succeeded', 'failed', 'cancelled', 'lost']);
const UNSUCCESSFUL = new Set(['failed', 'lost']);
/** AFS-143: how a run ended, in the words the pages use. */
const ENDED_WORDS = STATE_WORDS;

export class Notifier {
  private readonly channels: Map<ChannelKind, Channel>;
  private timer: NodeJS.Timeout | undefined;
  private going: Promise<void> = Promise.resolve();
  /** Work started by events: a server that stops waits for it. */
  private readonly pending = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(
    private readonly db: Db,
    channels: Channel[],
    private readonly log: Logger,
    private readonly options: NotifierOptions,
  ) {
    this.channels = new Map(channels.map((c) => [c.kind, c]));
  }

  start(): void {
    this.timer = setInterval(() => void this.deliver(), this.options.everyMs ?? 10_000);
    this.timer.unref();
    void this.deliver();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.pending]);
    await this.going;
  }

  /** Resolves once the events told so far are written and what was due is sent (for tests). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    await this.going;
  }

  /** Sends what is due, after whatever sending is going on now. */
  deliver(): Promise<void> {
    this.going = this.going
      .then(() => this.sendDue())
      .catch((e) => {
        this.log.error({ err: e }, 'Sending notifications failed');
      });
    return this.going;
  }

  private async sendDue(): Promise<void> {
    if (this.stopped) return;
    for (const taken of await takeDue(this.db)) {
      const channel = this.channels.get(taken.channel);
      const sent = channel
        ? await channel
            .send(taken.target, taken.message, { id: taken.id, event: taken.event })
            .catch((e: unknown): { ok: false; retry: boolean; error: string } => ({
              ok: false,
              retry: true,
              error: (e as Error).message?.slice(0, 300) ?? 'unknown error',
            }))
        : { ok: false as const, retry: false, error: `No ${taken.channel} channel` };
      if (sent.ok) {
        await markSent(this.db, taken.id);
        continue;
      }
      // A test is tried once: whoever sent it reads the answer now, not in hours.
      const next = await markFailed(
        this.db,
        taken,
        sent.error,
        sent.retry && taken.event !== 'test',
      );
      // Never the target in full: a webhook's address can be its secret.
      this.log.warn(
        {
          delivery: taken.id,
          event: taken.event,
          channel: taken.channel,
          to: shownTarget(taken.channel, taken.target),
          attempt: taken.attempts,
          why: sent.error,
        },
        next === 'retry'
          ? 'A notification was not sent: it is tried again'
          : 'A notification was given up on',
      );
    }
  }

  /** Removes sent and given-up messages past their keeping. */
  async prune(): Promise<number> {
    return pruneDeliveries(this.db, this.options.keepDays);
  }

  /** Runs an event's work in the background: logged when it fails, waited for by stop(). */
  private track(what: string, work: () => Promise<unknown>): void {
    if (this.stopped) return;
    const p = work()
      .then(() => this.deliver())
      .catch((e) => this.log.error({ err: e, event: what }, 'A notification could not be made'));
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private link(path: string): string | undefined {
    return this.options.publicUrl ? `${this.options.publicUrl}${path}` : undefined;
  }

  private async runFacts(id: string): Promise<RunFacts | undefined> {
    const row = await this.db
      .selectFrom('run')
      .innerJoin('project', 'project.id', 'run.project_id')
      .innerJoin('workspace', 'workspace.id', 'project.workspace_id')
      .select([
        'run.id',
        'run.number',
        'run.state',
        'run.mode',
        'run.flow_file',
        'run.flow_name',
        'run.config_id',
        'run.config_name',
        'run.requested_by',
        'run.requested_login',
        'run.inputs_shown_json',
        'run.error',
        'project.id as project_id',
        'project.key as project_key',
        'project.name as project_name',
        'workspace.id as workspace_id',
        'workspace.key as workspace_key',
        'workspace.name as workspace_name',
      ])
      .where('run.id', '=', id)
      .executeTakeFirst();
    if (!row) return undefined;
    const person = await this.db
      .selectFrom('user_account')
      .select('name')
      .where('id', '=', row.requested_by)
      .executeTakeFirst();
    let inputs: Record<string, unknown> = {};
    try {
      inputs = JSON.parse(row.inputs_shown_json) as Record<string, unknown>;
    } catch {
      // No inputs to tell.
    }
    return {
      id: row.id,
      number: row.number,
      state: row.state,
      mode: row.mode,
      flowFile: row.flow_file,
      flowName: row.flow_name,
      configId: row.config_id,
      configName: row.config_name,
      requestedBy: row.requested_by,
      requestedLogin: row.requested_login,
      requestedName: person?.name || row.requested_login,
      inputs,
      error: row.error,
      project: { id: row.project_id, key: row.project_key, name: row.project_name },
      workspace: { id: row.workspace_id, key: row.workspace_key, name: row.workspace_name },
    };
  }

  /** A run as a payload carries it: what it is, never its inputs. */
  private runPayload(run: RunFacts) {
    const link = this.link(`/runs/${run.id}`);
    return {
      id: run.id,
      number: run.number,
      state: run.state,
      mode: run.mode,
      flow: { file: run.flowFile, name: run.flowName },
      project: run.project,
      workspace: run.workspace,
      ...(run.configName ? { config: run.configName } : {}),
      requestedBy: run.requestedLogin,
      ...(run.error && run.state !== 'succeeded' ? { error: run.error } : {}),
      ...(link ? { link } : {}),
    };
  }

  private envelope(kind: EventKind, extra: Record<string, unknown>) {
    return {
      event: kind,
      at: new Date().toISOString(),
      server: this.options.publicUrl ?? null,
      ...extra,
    };
  }

  // AFS-143: a run as the pages name it (flow #number), its workspace and project by name.
  private where(run: RunFacts) {
    return `${run.flowName} #${run.number} (${run.workspace.name} / ${run.project.name})`;
  }

  /** Who a waiting approval asks (its approvers), and who it tells (its notify list). */
  private async asked(run: RunFacts, approval: { approvers?: string[]; notify?: string[] }) {
    const self = await this.db
      .selectFrom('workspace')
      .select('self_approve')
      .where('id', '=', run.workspace.id)
      .executeTakeFirst();
    const selfApprove = self?.self_approve === 1;
    // Who launched the run is not asked when they may not decide it (no self-approval).
    const approvers = approval.approvers?.length
      ? (
          await contactsOfNames(this.db, approval.approvers, {
            workspace: run.workspace.id,
            project: run.project.id,
            flowFile: run.flowFile,
          })
        ).filter((c) => self?.self_approve === 1 || c.label !== run.requestedLogin)
      : await approverContacts(
          this.db,
          { workspace: run.workspace.id, project: run.project.id, flowFile: run.flowFile },
          self?.self_approve === 1 ? undefined : run.requestedBy,
        );
    // AFS-145: a flow's approval lists, like a configuration's, reach only who may see the flow.
    const told = await contactsOfNames(this.db, approval.notify ?? [], {
      workspace: run.workspace.id,
      project: run.project.id,
      flowFile: run.flowFile,
    });
    return { approvers, told, selfApprove };
  }

  /**
   * AFS-185: the run stopped while its approval waited: who was asked is told it no longer
   * waits, so nobody goes to decide a run that has ended.
   */
  approvalCancelled(runId: string, gateId: string): void {
    this.track('approval.decided', async () => {
      const run = await this.runFacts(runId);
      const gate = await this.db
        .selectFrom('run_gate')
        .selectAll()
        .where('id', '=', gateId)
        .executeTakeFirst();
      if (!run || !gate || gate.status !== 'cancelled') return;
      const approval = (gate.approval_json ? JSON.parse(gate.approval_json) : {}) as {
        approvers?: string[];
        notify?: string[];
      };
      const { approvers, told } = await this.asked(run, approval);
      const by = gate.decided_by
        ? ((
            await this.db
              .selectFrom('user_account')
              .select('name')
              .where('login', '=', gate.decided_by)
              .executeTakeFirst()
          )?.name ?? gate.decided_by)
        : undefined;
      const link = this.link(`/runs/${run.id}`);
      const lines = [
        `"${gate.title}" of ${this.where(run)} no longer waits for a decision: the run was stopped${by ? ` by ${by}` : ''}.`,
        'Nothing is left to decide.',
        ...(link ? [link] : []),
      ];
      const message: Message = {
        subject: `Approval no longer waits: ${gate.title} - ${run.flowName} #${run.number}`,
        text: lines.join('\n'),
        payload: this.envelope('approval.decided', {
          run: this.runPayload(run),
          approval: {
            node: { id: gate.node_id, key: gate.node_key, title: gate.title },
            status: gate.status,
            ...(gate.decided_by ? { decidedBy: gate.decided_by } : {}),
            ...(gate.decided_at ? { decidedAt: gate.decided_at } : {}),
          },
          ...(link ? { link } : {}),
        }),
      };
      await enqueue(
        this.db,
        { kind: 'approval.decided', message, run: run.id },
        placesOf([...approvers, ...told]),
      );
    });
  }

  /** A run waits at an approval: its approvers are asked. */
  approvalWaiting(runId: string, gateId: string): void {
    this.track('approval.waiting', async () => {
      const run = await this.runFacts(runId);
      const gate = await this.db
        .selectFrom('run_gate')
        .selectAll()
        .where('id', '=', gateId)
        .executeTakeFirst();
      if (!run || !gate) return;
      const approval = (gate.approval_json ? JSON.parse(gate.approval_json) : {}) as {
        approvers?: string[];
        notify?: string[];
        message?: string;
        intent?: string;
      };
      const { approvers, told, selfApprove } = await this.asked(run, approval);
      // AFS-193: what is decided: the approval's message (else its step's intent) and the hosts.
      const about = approval.message?.trim() || approval.intent?.trim();
      const hosts = waitingHosts(gate.carried_json, gate.node_key) ?? [];
      const shownHosts =
        hosts.length > 20
          ? `${hosts.slice(0, 20).join(', ')} and ${hosts.length - 20} more`
          : hosts.join(', ');
      const link = this.link(`/runs/${run.id}`);
      // AFS-146: what the approver needs to decide: the run's inputs (secrets as ***), and
      // whether it changes anything.
      const inputs = Object.entries(run.inputs).map(
        ([name, value]) =>
          `  ${name} = ${(typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 200)}`,
      );
      const lines = [
        `${this.where(run)} waits for a decision at "${gate.title}".`,
        ...(about ? ['', about, ''] : []),
        ...(hosts.length
          ? [`${hosts.length === 1 ? 'Host' : `Hosts (${hosts.length})`} waiting: ${shownHosts}`]
          : []),
        // AFS-193: a list or group address reaches who launched it too: they do not decide it.
        `Launched by ${run.requestedName} (${run.mode === 'real' ? 'a real run' : 'a check run'})${selfApprove ? '' : `, who does not decide it`}.`,
        ...(inputs.length ? ['Inputs:', ...inputs] : []),
        ...(gate.deadline ? [`Nobody deciding by ${readable(gate.deadline)}: it times out.`] : []),
        link ? `Decide: ${link}` : 'Decide on the Approvals page of the server.',
      ];
      const message: Message = {
        subject: `Approval waits: ${gate.title} - ${run.flowName} #${run.number}`,
        text: lines.join('\n'),
        payload: this.envelope('approval.waiting', {
          run: this.runPayload(run),
          approval: {
            node: { id: gate.node_id, key: gate.node_key, title: gate.title },
            status: gate.status,
            approvers: approval.approvers ?? [],
            ...(approval.message ? { message: approval.message } : {}),
            ...(approval.intent ? { intent: approval.intent } : {}),
            ...(hosts.length ? { hosts } : {}),
            ...(gate.deadline ? { deadline: gate.deadline } : {}),
          },
          ...(link ? { link } : {}),
        }),
      };
      await enqueue(
        this.db,
        { kind: 'approval.waiting', message, run: run.id },
        placesOf([...approvers, ...told]),
      );
    });
  }

  /** An approval was decided (or timed out): who launched the run is told, and the notify list. */
  approvalDecided(runId: string, gateId: string): void {
    this.track('approval.decided', async () => {
      const run = await this.runFacts(runId);
      const gate = await this.db
        .selectFrom('run_gate')
        .selectAll()
        .where('id', '=', gateId)
        .executeTakeFirst();
      if (!run || !gate || gate.status === 'waiting' || gate.status === 'cancelled') return;
      const approval = (gate.approval_json ? JSON.parse(gate.approval_json) : {}) as {
        notify?: string[];
        next?: { approved?: string; rejected?: string; timeout?: string };
      };
      const link = this.link(`/runs/${run.id}`);
      // AFS-146: the decider by name; the hosts' next step by its title, as the flow names it.
      const decider = gate.decided_by
        ? ((
            await this.db
              .selectFrom('user_account')
              .select('name')
              .where('login', '=', gate.decided_by)
              .executeTakeFirst()
          )?.name ?? gate.decided_by)
        : undefined;
      const next =
        gate.status === 'approved'
          ? approval.next?.approved
          : gate.status === 'rejected'
            ? approval.next?.rejected
            : (approval.next?.timeout ?? approval.next?.rejected);
      const lines = [
        gate.status === 'timed out'
          ? `"${gate.title}" of ${this.where(run)} timed out: nobody decided in time.`
          : `"${gate.title}" of ${this.where(run)} was ${gate.status} by ${decider ?? 'nobody'}.`,
        ...(gate.comment && gate.status !== 'timed out' ? [`Comment: ${gate.comment}`] : []),
        gate.status === 'approved'
          ? `The run goes on with the approved hosts${next ? `, to "${next}"` : ''}.`
          : next
            ? `The hosts that waited go to "${next}", not on to the change.`
            : 'The hosts that waited go where the flow sends them, not on to the change.',
        ...(link ? [link] : []),
      ];
      const message: Message = {
        subject: `Approval ${gate.status}: ${gate.title} - ${run.flowName} #${run.number}`,
        text: lines.join('\n'),
        payload: this.envelope('approval.decided', {
          run: this.runPayload(run),
          approval: {
            node: { id: gate.node_id, key: gate.node_key, title: gate.title },
            status: gate.status,
            ...(gate.decided_by ? { decidedBy: gate.decided_by } : {}),
            ...(gate.decided_at ? { decidedAt: gate.decided_at } : {}),
            ...(gate.comment ? { comment: gate.comment } : {}),
          },
          ...(link ? { link } : {}),
        }),
      };
      await enqueue(
        this.db,
        { kind: 'approval.decided', message, run: run.id },
        placesOf([
          ...(await launcherContacts(this.db, run.requestedBy)),
          ...(await contactsOfNames(this.db, approval.notify ?? [], {
            workspace: run.workspace.id,
            project: run.project.id,
            flowFile: run.flowFile,
          })),
        ]),
      );
    });
  }

  /** A run ended: told as its launch configuration says. */
  runEnded(runId: string): void {
    this.track('run.ended', async () => {
      const run = await this.runFacts(runId);
      if (!run || !ENDED.has(run.state) || !run.configId) return;
      const config = await this.db
        .selectFrom('launch_config')
        .select('notify_json')
        .where('id', '=', run.configId)
        .executeTakeFirst();
      const notify = config?.notify_json
        ? (JSON.parse(config.notify_json) as RunNotify)
        : undefined;
      if (!notify?.to.length) return;
      if (notify.when === 'failed' && !UNSUCCESSFUL.has(run.state)) return;
      const link = this.link(`/runs/${run.id}`);
      const lines = [
        `${this.where(run)} ${ENDED_WORDS[run.state] ?? run.state}.`,
        ...(run.configName ? [`Launch configuration: ${run.configName}.`] : []),
        `Launched by ${run.requestedName}.`,
        ...(run.error && run.state !== 'succeeded' ? [`Why: ${run.error}`] : []),
        ...(link ? [link] : []),
      ];
      const message: Message = {
        subject: `Run ${ENDED_WORDS[run.state] ?? run.state}: ${run.flowName} #${run.number}`,
        text: lines.join('\n'),
        payload: this.envelope('run.ended', {
          run: this.runPayload(run),
          ...(link ? { link } : {}),
        }),
      };
      await enqueue(
        this.db,
        { kind: 'run.ended', message, run: run.id },
        // AFS-145: only who may see the flow's runs now, whatever the list said when saved.
        placesOf(
          await contactsOfNames(this.db, notify.to, {
            workspace: run.workspace.id,
            project: run.project.id,
            flowFile: run.flowFile,
          }),
        ),
      );
    });
  }

  /**
   * The server certificate as it is now. Administrators are told when it comes within 30, 14, 7,
   * 3 and 1 days of its end, and when it has ended: each step once, whatever restarts between.
   */
  certificate(info: CertificateInfo): void {
    const step =
      info.daysLeft < 0
        ? 'expired'
        : [...CERTIFICATE_STEPS].reverse().find((s) => info.daysLeft <= s);
    if (step === undefined) return;
    this.track('certificate.expiring', async () => {
      const expired = step === 'expired';
      const link = this.link('/');
      const subject = expired
        ? `The server certificate has expired (${readable(info.notAfter)})`
        : `The server certificate expires in ${info.daysLeft} ${info.daysLeft === 1 ? 'day' : 'days'}`;
      const lines = [
        `${subject}.`,
        `Subject: ${info.subject}`,
        `Names: ${info.names.join(', ')}`,
        `Not after: ${readable(info.notAfter)}`,
        'Replace it with the cert commands of the server (cert request, cert install).',
        ...(link ? [link] : []),
      ];
      const message: Message = {
        subject,
        text: lines.join('\n'),
        payload: this.envelope('certificate.expiring', {
          certificate: {
            subject: info.subject,
            names: info.names,
            notAfter: info.notAfter,
            daysLeft: info.daysLeft,
            fingerprint: info.fingerprint,
          },
        }),
      };
      await enqueue(
        this.db,
        {
          kind: 'certificate.expiring',
          message,
          dedupe: `certificate:${info.fingerprint}:${step}`,
        },
        placesOf(await adminContacts(this.db)),
      );
    });
  }

  /**
   * A test message to one place, sent now: resolves with how it went (also in the delivery log).
   */
  async test(channel: ChannelKind, target: string, by: string): Promise<Delivery | undefined> {
    const link = this.link('/admin/notifications');
    const message: Message = {
      subject: 'A test from Ansible Flow Server',
      text: [
        `${by} sent this test from the Notifications page. When you can read it, ${channel === 'email' ? 'email' : 'this webhook'} works.`,
        ...(link ? [link] : []),
      ].join('\n'),
      payload: this.envelope('test', { by }),
    };
    // Named by what the log may show: a webhook's address can be its secret.
    const place: Outgoing = { channel, recipient: shownTarget(channel, target), target };
    const [id] = await enqueue(this.db, { kind: 'test', message }, [place]);
    await this.deliver();
    return id ? getDelivery(this.db, id) : undefined;
  }
}
