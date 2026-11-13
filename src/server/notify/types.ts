// What notifications look like from outside the server (AFS-29): the pages import these, so this
// file imports nothing of the server.

export const EVENTS = [
  'approval.waiting',
  'approval.decided',
  'run.ended',
  'certificate.expiring',
  'test',
] as const;
export type EventKind = (typeof EVENTS)[number];

export const CHANNELS = ['email', 'webhook'] as const;
export type ChannelKind = (typeof CHANNELS)[number];

export type DeliveryStatus = 'pending' | 'sent' | 'failed';

/** One message to one place, as the delivery log shows it. */
export interface Delivery {
  id: string;
  event: EventKind;
  channel: ChannelKind;
  /** Who it is for: a login, a group's name, or the address itself. */
  recipient: string;
  /** Where to: the email address, or the webhook's address without its path (it can hold a secret). */
  target: string;
  subject: string;
  run?: string;
  status: DeliveryStatus;
  attempts: number;
  /** When it is tried again, while it is pending. */
  nextAt?: string;
  lastError?: string;
  createdAt: string;
  sentAt?: string;
}

/** When a launch configuration's runs tell, and whom. */
export interface RunNotify {
  /** failed: when a run did not succeed (failed, lost); ended: every run that ends. */
  when: 'failed' | 'ended';
  /** Logins and group names. */
  to: string[];
}

export type SmtpSecurity = 'tls' | 'starttls' | 'none';

/** How the server sends email; the password is never shown, only whether there is one. */
export interface SmtpSettings {
  host: string;
  port: number;
  /** tls: TLS from the start (465); starttls: must upgrade (587); none: as the relay allows. */
  security: SmtpSecurity;
  user?: string;
  /** The sender: `Flow Server <flows@example.net>`. */
  from: string;
  hasPassword: boolean;
}

export interface NotifySettings {
  /** Absent: the server sends no email. */
  smtp?: SmtpSettings;
  /** Webhooks are signed with a key the receivers check; whether there is one yet. */
  webhookKey: boolean;
  /** Where links point; absent: messages carry no links (AFS_PUBLIC_URL is not set). */
  publicUrl?: string;
}
