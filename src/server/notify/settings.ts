// How the server sends notifications (AFS-29), kept in the database's settings: the SMTP relay
// (its password sealed with the master key) and the key webhooks are signed with (sealed too).
// Administrators change them on the Notifications page or over the API.
import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { getSetting, setSetting } from '../db/settings';
import { open, seal } from '../secrets/crypto';
import type { MasterKey } from '../secrets/masterKey';
import type { SmtpSecurity, SmtpSettings } from './types';

type Db = Kysely<Schema>;

const SMTP = 'notify.smtp';
const SMTP_PASSWORD = 'notify.smtp.password';
const WEBHOOK_KEY = 'notify.webhook.key';
/** The settings that hold a sealed value: `secrets rotate` seals them again. */
export const SEALED_SETTINGS = [SMTP_PASSWORD, WEBHOOK_KEY];
/** A sealed setting is bound to its name. */
export const settingContext = (name: string) => `setting:${name}`;

export class SettingsError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

interface StoredSmtp {
  host: string;
  port: number;
  security: SmtpSecurity;
  user?: string;
  from: string;
}

export async function smtpSettings(db: Db): Promise<SmtpSettings | undefined> {
  const text = await getSetting(db, SMTP);
  if (!text) return undefined;
  const stored = JSON.parse(text) as StoredSmtp;
  return { ...stored, hasPassword: !!(await getSetting(db, SMTP_PASSWORD)) };
}

/** The relay with its password, to send with. Never log or show this. */
export async function smtpForSending(
  db: Db,
  key: MasterKey,
): Promise<(StoredSmtp & { password?: string }) | undefined> {
  const text = await getSetting(db, SMTP);
  if (!text) return undefined;
  const sealed = await getSetting(db, SMTP_PASSWORD);
  return {
    ...(JSON.parse(text) as StoredSmtp),
    ...(sealed ? { password: open(key, sealed, settingContext(SMTP_PASSWORD)) } : {}),
  };
}

export interface SmtpInput {
  host: string;
  port?: number;
  security?: SmtpSecurity;
  user?: string | null;
  /** Absent: the password stays as it is; null or empty: none. */
  password?: string | null;
  from: string;
}

/** An address in a From line: `name@example.net` or `Name <name@example.net>`. */
const FROM = /^([^<>\r\n]{0,100}<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/;

export async function setSmtp(db: Db, key: MasterKey, input: SmtpInput): Promise<SmtpSettings> {
  const host = input.host.trim();
  if (!/^[A-Za-z0-9.-]{1,253}$|^\[[0-9a-fA-F:]+\]$/.test(host))
    throw new SettingsError('Not the name or address of a mail server', 'host');
  const security = input.security ?? 'starttls';
  if (!['tls', 'starttls', 'none'].includes(security))
    throw new SettingsError('Security is tls, starttls or none', 'security');
  const port = input.port ?? (security === 'tls' ? 465 : 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new SettingsError('A port is a number from 1 to 65535', 'port');
  const from = input.from.trim();
  if (!FROM.test(from))
    throw new SettingsError('The sender is an address, or a name and <an address>', 'from');
  const user = input.user?.trim() || undefined;
  if (user && (user.length > 320 || /[\r\n]/.test(user)))
    throw new SettingsError('Not a user name for the mail server', 'user');
  const stored: StoredSmtp = { host, port, security, ...(user ? { user } : {}), from };
  await setSetting(db, SMTP, JSON.stringify(stored));
  if (input.password !== undefined) {
    if (input.password)
      await setSetting(db, SMTP_PASSWORD, seal(key, input.password, settingContext(SMTP_PASSWORD)));
    else await db.deleteFrom('setting').where('name', '=', SMTP_PASSWORD).execute();
  }
  return (await smtpSettings(db)) as SmtpSettings;
}

/** The server sends no email any more. */
export async function clearSmtp(db: Db): Promise<void> {
  await db.deleteFrom('setting').where('name', 'in', [SMTP, SMTP_PASSWORD]).execute();
}

export async function hasWebhookKey(db: Db): Promise<boolean> {
  return !!(await getSetting(db, WEBHOOK_KEY));
}

/**
 * The key webhooks are signed with. Undefined until an administrator makes one (it is shown to
 * them once, to give to the receivers); until then webhooks go unsigned.
 */
export async function webhookKey(db: Db, key: MasterKey): Promise<string | undefined> {
  const sealed = await getSetting(db, WEBHOOK_KEY);
  return sealed ? open(key, sealed, settingContext(WEBHOOK_KEY)) : undefined;
}

/** A new key for signing webhooks; the old one stops working. Shown once, by the caller. */
export async function newWebhookKey(db: Db, key: MasterKey): Promise<string> {
  const made = `afs_whk_${randomBytes(32).toString('base64url')}`;
  await setSetting(db, WEBHOOK_KEY, seal(key, made, settingContext(WEBHOOK_KEY)));
  return made;
}
