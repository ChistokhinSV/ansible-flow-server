// The ways a notification goes out (AFS-29). Each channel sends one message to one place and says
// whether it went, or why not and whether trying again could help. Telegram and a Slack app
// (AFS-41, AFS-42) will be channels of their own on the same interface.
import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { ChannelKind, SmtpSecurity } from './types';

/** What is sent: the same for every channel, each uses what it can. */
export interface Message {
  /** One line: an email's subject. */
  subject: string;
  /** Plain text: an email's body, and a chat message's `text`. */
  text: string;
  /** The event as data, for programs: a webhook's body. Never a secret value. */
  payload: Record<string, unknown>;
}

export type Sent = { ok: true } | { ok: false; retry: boolean; error: string };

export interface Channel {
  kind: ChannelKind;
  send(target: string, message: Message, delivery: { id: string; event: string }): Promise<Sent>;
}

/** Messages and errors are kept short, and on one line. */
const short = (text: string, max = 300) =>
  text.replace(/\s+/g, ' ').trim().slice(0, max) || 'unknown error';

export interface SmtpRelay {
  host: string;
  port: number;
  security: SmtpSecurity;
  user?: string;
  password?: string;
  from: string;
}

/** Errors of the network or a busy relay are worth trying again; a refusal (5xx) is not. */
function mailError(e: unknown): Sent {
  const err = e as { code?: string; responseCode?: number; message?: string };
  const code = err.responseCode;
  const retry = code === undefined || code < 500;
  return { ok: false, retry, error: short(`${code ? `${code} ` : ''}${err.message ?? String(e)}`) };
}

/**
 * Email through an SMTP relay. `relay` is read for each message, so a change of settings takes
 * effect at once; undefined: email is not set up.
 */
export function emailChannel(relay: () => Promise<SmtpRelay | undefined>): Channel {
  return {
    kind: 'email',
    async send(target, message) {
      const smtp = await relay();
      if (!smtp)
        return {
          ok: false,
          retry: false,
          error:
            'Email is not set up: an administrator sets the mail server on the Notifications page',
        };
      const transport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.security === 'tls',
        requireTLS: smtp.security === 'starttls',
        ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password ?? '' } } : {}),
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      });
      try {
        await transport.sendMail({
          from: smtp.from,
          to: target,
          subject: message.subject.replace(/[\r\n]+/g, ' '),
          text: message.text,
        });
        return { ok: true };
      } catch (e) {
        return mailError(e);
      } finally {
        transport.close();
      }
    },
  };
}

/** The signature a receiver checks: HMAC-SHA256 of `<timestamp>.<body>` with the shared key. */
export function signature(key: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex')}`;
}

/**
 * A webhook: the payload as JSON, with `text` for chat tools that show it (Slack, Mattermost and
 * Rocket.Chat incoming webhooks read `text`). Signed when the server has a key. Redirects are not
 * followed: the address is the one the administrator gave.
 */
export function webhookChannel(
  key: () => Promise<string | undefined>,
  agent: string,
  timeoutMs = 10_000,
): Channel {
  return {
    kind: 'webhook',
    async send(target, message, delivery) {
      const body = JSON.stringify({ text: message.text, ...message.payload });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signing = await key();
      let res: Response;
      try {
        res = await fetch(target, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            'content-type': 'application/json',
            'user-agent': agent,
            'x-afs-event': delivery.event,
            'x-afs-delivery': delivery.id,
            'x-afs-timestamp': timestamp,
            ...(signing ? { 'x-afs-signature': signature(signing, timestamp, body) } : {}),
          },
          body,
        });
      } catch (e) {
        // Never the address in the error: it can hold a secret.
        const why = (e as Error).name === 'TimeoutError' ? 'No answer in time' : 'Not reachable';
        const cause = (e as { cause?: { code?: string } }).cause?.code;
        return { ok: false, retry: true, error: cause ? `${why} (${cause})` : why };
      }
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return { ok: true };
      const retry = res.status === 408 || res.status === 429 || res.status >= 500;
      const what =
        res.status >= 300 && res.status < 400
          ? 'it redirects elsewhere: give the final address'
          : res.statusText || 'refused';
      return { ok: false, retry, error: short(`HTTP ${res.status}: ${what}`) };
    },
  };
}
