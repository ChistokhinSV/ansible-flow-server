// Notifications over HTTP (AFS-29), for administrators:
//   GET    /api/v1/notifications                 the delivery log, newest first
//   POST   /api/v1/notifications/:id/retry       try a message given up on again
//   GET    /api/v1/notifications/settings        how the server sends
//   PUT    /api/v1/notifications/smtp            set the mail server
//   DELETE /api/v1/notifications/smtp            send no email
//   POST   /api/v1/notifications/webhook-key     a new key webhooks are signed with (shown once)
//   POST   /api/v1/notifications/test            send a test message now
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { administrator, inSession } from '../auth/guards';
import { contactProblem, getUser } from '../auth/users';
import type { Schema } from '../db/schema';
import { SealError } from '../secrets/crypto';
import type { MasterKey } from '../secrets/masterKey';
import type { Notifier } from './notifier';
import {
  clearSmtp,
  hasWebhookKey,
  newWebhookKey,
  SettingsError,
  type SmtpInput,
  setSmtp,
  smtpSettings,
} from './settings';
import { type DeliveryFilter, listDeliveries, retryNow } from './store';
import { CHANNELS, type ChannelKind, EVENTS, type NotifySettings } from './types';

export interface NotifyDeps {
  db: Kysely<Schema>;
  key: MasterKey;
  notifier: Notifier;
  publicUrl?: string;
}

const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });

export function registerNotifications(app: FastifyInstance, deps: NotifyDeps): void {
  const { db, key, notifier } = deps;
  const answering =
    <R extends FastifyRequest>(handler: (request: R, reply: FastifyReply) => Promise<unknown>) =>
    async (request: R, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (e) {
        if (e instanceof SettingsError)
          return reply.code(400).send({
            error: 'invalid',
            message: e.message,
            ...(e.field ? { field: e.field } : {}),
          });
        if (e instanceof SealError) {
          request.log.error({ why: e.message }, 'A stored secret could not be opened');
          return reply
            .code(500)
            .send({ error: 'sealed', message: 'A stored secret could not be opened' });
        }
        throw e;
      }
    };

  const settings = async (): Promise<NotifySettings> => {
    const smtp = await smtpSettings(db);
    return {
      ...(smtp ? { smtp } : {}),
      webhookKey: await hasWebhookKey(db),
      ...(deps.publicUrl ? { publicUrl: deps.publicUrl } : {}),
    };
  };

  app.get<{ Querystring: DeliveryFilter }>(
    '/api/v1/notifications',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['pending', 'sent', 'failed'] },
            event: { type: 'string', enum: [...EVENTS] },
            run: text(64, 1),
            before: text(40, 1),
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      },
    },
    async (request, reply) =>
      administrator(request, reply) ? listDeliveries(db, request.query) : reply,
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/notifications/:id/retry',
    { schema: { params: { type: 'object', properties: { id: text(64, 1) }, required: ['id'] } } },
    async (request, reply) => {
      if (!administrator(request, reply)) return reply;
      if (!(await retryNow(db, request.params.id)))
        return reply
          .code(409)
          .send({ error: 'not_failed', message: 'Only a message given up on is tried again' });
      void notifier.deliver();
      return reply.code(204).send();
    },
  );

  app.get('/api/v1/notifications/settings', async (request, reply) =>
    administrator(request, reply) ? settings() : reply,
  );

  app.put<{ Body: SmtpInput }>(
    '/api/v1/notifications/smtp',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['host', 'from'],
          properties: {
            host: text(255, 1),
            port: { type: 'integer', minimum: 1, maximum: 65535 },
            security: { type: 'string', enum: ['tls', 'starttls', 'none'] },
            user: { anyOf: [text(320), { type: 'null' }] },
            password: { anyOf: [text(1000), { type: 'null' }] },
            from: text(320, 3),
          },
        },
      },
    },
    answering(async (request, reply) => {
      // A password goes in with a session: a leaked token must not point mail elsewhere.
      if (!inSession(request, reply, true)) return reply;
      await setSmtp(db, key, request.body);
      return settings();
    }),
  );

  app.delete('/api/v1/notifications/smtp', async (request, reply) => {
    if (!inSession(request, reply, true)) return reply;
    await clearSmtp(db);
    return reply.code(204).send();
  });

  app.post(
    '/api/v1/notifications/webhook-key',
    answering(async (request, reply) => {
      if (!inSession(request, reply, true)) return reply;
      // In this answer and nowhere else: the receivers are given it to check signatures.
      return reply.code(201).send({ key: await newWebhookKey(db, key) });
    }),
  );

  app.post<{ Body: { channel: ChannelKind; to?: string } }>(
    '/api/v1/notifications/test',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['channel'],
          properties: { channel: { type: 'string', enum: [...CHANNELS] }, to: text(2000, 1) },
        },
      },
    },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const { channel } = request.body;
      // To the address given, else to the administrator's own.
      const own = await getUser(db, me.id);
      const to = request.body.to?.trim() ?? (channel === 'email' ? own?.email : own?.webhookUrl);
      if (!to)
        return reply.code(400).send({
          error: 'invalid',
          message: `Give an address: you have no ${channel === 'email' ? 'email address' : 'webhook'} of your own`,
          field: 'to',
        });
      const problem = contactProblem(channel === 'email' ? { email: to } : { webhookUrl: to });
      if (problem) return reply.code(400).send({ error: 'invalid', message: problem, field: 'to' });
      return notifier.test(channel, to, me.login);
    }),
  );
}
