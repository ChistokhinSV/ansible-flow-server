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
          // AFS-146: a bare address gets the server's name, so the mail says who sends it.
          from: smtp.from.includes('<')
            ? smtp.from
            : { name: 'Ansible Flow Server', address: smtp.from.trim() },
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

/** Network error codes, in words. */
const REACH: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'the connection was closed',
  EPIPE: 'the connection was closed',
  UND_ERR_SOCKET: 'the connection was closed',
  ETIMEDOUT: 'connection timed out',
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  ENOTFOUND: 'the host name is not found (DNS)',
  EAI_AGAIN: 'the host name could not be looked up (DNS)',
  EAI_NONAME: 'the host name is not found (DNS)',
  EHOSTUNREACH: 'no route to the host',
  ENETUNREACH: 'no route to the network',
  CERT_HAS_EXPIRED: 'its certificate has expired',
  ERR_TLS_CERT_ALTNAME_INVALID: 'its certificate is for another name',
};

/**
 * AFS-169: why a webhook could not be reached, named: connection refused, timed out, the
 * certificate, DNS. Never the address or the error's own message: the address can hold a secret.
 * A certificate or a port web requests may not use stays wrong until it is changed: not tried
 * again.
 */
export function unreachable(e: unknown, timeoutMs: number): Sent {
  if ((e as Error).name === 'TimeoutError')
    return {
      ok: false,
      retry: true,
      error: `Timed out: no answer in ${Math.round(timeoutMs / 1000)} s`,
    };
  const cause = (e as { cause?: { code?: string; message?: string; errors?: { code?: string }[] } })
    .cause;
  // Undici gives an AggregateError when a name has several addresses (IPv4 and IPv6).
  const code = cause?.code ?? cause?.errors?.find((x) => x.code)?.code;
  if (code && REACH[code]) {
    const certificate = code.includes('CERT');
    return { ok: false, retry: !certificate, error: `Not reachable: ${REACH[code]}` };
  }
  if (code && /CERT|SELF_SIGNED|UNABLE_TO_(VERIFY|GET_ISSUER)/.test(code))
    return {
      ok: false,
      retry: false,
      error: `Not reachable: its certificate is not trusted (${code})`,
    };
  if (cause?.message === 'bad port')
    return { ok: false, retry: false, error: 'Not reachable: web requests may not use that port' };
  return { ok: false, retry: true, error: code ? `Not reachable (${code})` : 'Not reachable' };
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
        return unreachable(e, timeoutMs);
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
