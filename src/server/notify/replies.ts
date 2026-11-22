// AFS-176 (ADR-0037): a run started from a NetBox or Zabbix link tells that system how it ended: a
// journal entry on the NetBox object, an acknowledgement message on the Zabbix problem. They go
// through the outbox like every notification (tries again, the delivery log), as channels whose
// target is `<credential id>|<object>`: the address and token are read from the credential when
// the message is sent, so neither is ever kept in the outbox.
import type { Channel, Message, Sent } from './channels';
import { unreachable } from './channels';

/** A credential's address and token, read when a message is sent. */
export type ReplyCredential = (
  id: string,
) => Promise<{ address: string; token: string } | undefined>;

/** What the outbox keeps as a reply's target: the credential and the object, never a secret. */
export const replyTarget = (credential: string, object: string) => `${credential}|${object}`;

/** A reply's target as the delivery log shows it: the object only. */
export const shownReply = (target: string) => target.slice(target.indexOf('|') + 1);

const short = (text: string, max = 300) =>
  text.replace(/\s+/g, ' ').trim().slice(0, max) || 'unknown error';

const split = (target: string) => {
  const at = target.indexOf('|');
  return at < 0 ? undefined : { credential: target.slice(0, at), object: target.slice(at + 1) };
};

/** A refusal by status: busy and server errors may pass; the rest stays until changed. */
const refused = (status: number, what: string): Sent => ({
  ok: false,
  retry: status === 408 || status === 429 || status >= 500,
  error: short(`HTTP ${status}: ${what}`),
});

const base = (address: string) => address.trim().replace(/\/+$/, '');

/**
 * NetBox: a journal entry on the object (`dcim.device:1`). The kind follows the run's end
 * (success, danger, warning). A v2 token (nbt_…) is a bearer token; an older one is `Token`.
 */
export function netboxChannel(
  credential: ReplyCredential,
  agent: string,
  timeoutMs = 10_000,
): Channel {
  return {
    kind: 'netbox',
    async send(target, message: Message): Promise<Sent> {
      const to = split(target);
      const object = to && /^([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*):(\d+)$/.exec(to.object);
      if (!to || !object)
        return { ok: false, retry: false, error: 'Not a NetBox object to write to' };
      const cred = await credential(to.credential);
      if (!cred) return { ok: false, retry: false, error: 'The NetBox credential is gone' };
      const kind = typeof message.payload.kind === 'string' ? message.payload.kind : 'info';
      let res: Response;
      try {
        res = await fetch(`${base(cred.address)}/api/extras/journal-entries/`, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'user-agent': agent,
            authorization: cred.token.startsWith('nbt_')
              ? `Bearer ${cred.token}`
              : `Token ${cred.token}`,
          },
          body: JSON.stringify({
            assigned_object_type: object[1],
            assigned_object_id: Number(object[2]),
            kind,
            comments: message.text,
          }),
        });
      } catch (e) {
        return unreachable(e, timeoutMs);
      }
      const body = await res.text().catch(() => '');
      if (res.ok) return { ok: true };
      // NetBox says why in its JSON (a field, the token): its words, never the token.
      let why = res.statusText || 'refused';
      try {
        const said = JSON.parse(body) as Record<string, unknown>;
        why = short(
          typeof said.detail === 'string' ? said.detail : JSON.stringify(said).slice(0, 200),
          200,
        );
      } catch {}
      return refused(res.status, why);
    },
  };
}

/**
 * Zabbix: a message on the problem (`event:2048`) with `event.acknowledge` (action 4, add a
 * message), over JSON-RPC with the API token as a bearer (Zabbix 7.2 and later).
 */
export function zabbixChannel(
  credential: ReplyCredential,
  agent: string,
  timeoutMs = 10_000,
): Channel {
  return {
    kind: 'zabbix',
    async send(target, message: Message): Promise<Sent> {
      const to = split(target);
      const event = to && /^event:(\d+)$/.exec(to.object);
      if (!to || !event)
        return { ok: false, retry: false, error: 'Not a Zabbix problem to write to' };
      const cred = await credential(to.credential);
      if (!cred) return { ok: false, retry: false, error: 'The Zabbix credential is gone' };
      const address = base(cred.address);
      let res: Response;
      try {
        res = await fetch(address.endsWith('.php') ? address : `${address}/api_jsonrpc.php`, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            'content-type': 'application/json-rpc',
            'user-agent': agent,
            authorization: `Bearer ${cred.token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'event.acknowledge',
            // Zabbix keeps a message of at most 2048 characters.
            params: { eventids: [event[1]], action: 4, message: message.text.slice(0, 2048) },
            id: 1,
          }),
        });
      } catch (e) {
        return unreachable(e, timeoutMs);
      }
      const body = await res.text().catch(() => '');
      if (!res.ok) return refused(res.status, res.statusText || 'refused');
      try {
        const said = JSON.parse(body) as {
          result?: unknown;
          error?: { message?: string; data?: string };
        };
        if (said.error)
          return {
            ok: false,
            retry: false,
            error: short(`Zabbix: ${said.error.message ?? ''} ${said.error.data ?? ''}`, 300),
          };
        return said.result
          ? { ok: true }
          : { ok: false, retry: true, error: 'Zabbix gave no answer' };
      } catch {
        return { ok: false, retry: true, error: 'Zabbix did not answer in JSON-RPC' };
      }
    },
  };
}
