// The server's certificate over HTTP (AFS-54), for administrators: the same store and actions as
// the `cert` commands.
//   GET  /api/v1/admin/certificate               in use, the one before, a waiting request
//   POST /api/v1/admin/certificate/request       a new key and request (the key stays here)
//   GET  /api/v1/admin/certificate/request.pem   the waiting request, as a file
//   POST /api/v1/admin/certificate/install       a signed certificate (chain may follow), key optional
//   POST /api/v1/admin/certificate/self-signed   a new self-signed certificate
//   POST /api/v1/admin/certificate/rollback      back to the one before
//   GET  /api/v1/admin/certificate/history       every change, newest first
// Changes need an administrator signed in with a password (a leaked token must not be able to
// put its own certificate in front of everyone). A running server serves the new certificate to
// new connections as soon as it sees the store's files change; no restart.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { administrator, inSession } from '../auth/guards';
import { CertificateRefused, type CertificateStore } from './store';
import type { CertificateState } from './types';

export type { CertificateState } from './types';

export interface CertificateDeps {
  store: CertificateStore;
  /** `off`: the server speaks plain HTTP behind a proxy; the certificate is kept but not served. */
  tls: 'on' | 'off';
  /** The host people use for the server: an installed certificate must be good for it. */
  host?: string;
  /** What a new self-signed certificate is made for when no names are given. */
  defaultNames: string[];
}

const PEM_MAX = 64 * 1024;
const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const names = { type: 'array', minItems: 1, maxItems: 50, items: text(253, 1) };

export function registerCertificate(app: FastifyInstance, deps: CertificateDeps): void {
  const { store } = deps;
  const state = (): CertificateState => {
    const current = store.current();
    const previous = store.previous();
    const request = store.pendingRequest();
    return {
      tls: deps.tls,
      ...(current ? { current: { source: current.source, info: current.info } } : {}),
      ...(previous ? { previous } : {}),
      ...(request ? { request } : {}),
      ...(deps.host ? { host: deps.host } : {}),
      defaultNames: deps.defaultNames,
    };
  };
  /** A change: refusals answer 422 with every reason. */
  const changing =
    <R extends FastifyRequest>(
      handler: (request: R, reply: FastifyReply, by: string) => Promise<unknown> | unknown,
    ) =>
    async (request: R, reply: FastifyReply) => {
      const me = inSession(request, reply, true);
      if (!me) return reply;
      try {
        return await handler(request, reply, me.login);
      } catch (e) {
        if (e instanceof CertificateRefused)
          return reply.code(422).send({
            error: 'refused',
            message: 'The certificate was not installed',
            problems: e.problems,
          });
        throw e;
      }
    };
  const changed = (request: FastifyRequest, what: string) => {
    const now = store.current();
    request.log.info(
      { subject: now?.info.subject, expires: now?.info.notAfter },
      `Server certificate: ${what}`,
    );
    return state();
  };

  app.get('/api/v1/admin/certificate', async (request, reply) =>
    administrator(request, reply) ? state() : reply,
  );

  app.get('/api/v1/admin/certificate/history', async (request, reply) =>
    administrator(request, reply) ? store.history().reverse() : reply,
  );

  app.get('/api/v1/admin/certificate/request.pem', async (request, reply) => {
    if (!administrator(request, reply)) return reply;
    const pem = store.pendingRequest();
    if (!pem) return reply.code(404).send({ error: 'not_found', message: 'No request waits' });
    return reply
      .type('application/pkcs10')
      .header('content-disposition', 'attachment; filename="server-certificate-request.pem"')
      .send(pem);
  });

  app.post<{ Body: { names: string[]; organization?: string } }>(
    '/api/v1/admin/certificate/request',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['names'],
          properties: { names, organization: text(200) },
        },
      },
    },
    changing(async (request, reply, by) => {
      const { names: asked, organization } = request.body;
      await store.request(
        { names: asked.map((n) => n.trim()), ...(organization?.trim() ? { organization } : {}) },
        { by },
      );
      request.log.info({ names: asked.join(',') }, 'Server certificate: request made');
      return reply.code(201).send(state());
    }),
  );

  app.post<{ Body: { certificate: string; key?: string } }>(
    '/api/v1/admin/certificate/install',
    {
      // A certificate with its chain and a key: far below the server's default body limit, held to
      // this so a mistake (a whole bundle of authorities) is said plainly.
      bodyLimit: 4 * PEM_MAX,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['certificate'],
          properties: { certificate: text(PEM_MAX, 1), key: text(PEM_MAX, 1) },
        },
      },
    },
    changing((request, _reply, by) => {
      store.install(request.body.certificate, {
        ...(request.body.key ? { key: request.body.key } : {}),
        ...(deps.host ? { host: deps.host } : {}),
        by,
      });
      return changed(request, 'installed');
    }),
  );

  app.post<{ Body: { names?: string[] } }>(
    '/api/v1/admin/certificate/self-signed',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { names },
        },
      },
    },
    changing(async (request, _reply, by) => {
      const asked = request.body?.names?.map((n) => n.trim()).filter(Boolean);
      await store.selfSigned(asked?.length ? asked : deps.defaultNames, { by });
      return changed(request, 'new self-signed');
    }),
  );

  app.post(
    '/api/v1/admin/certificate/rollback',
    changing((request, _reply, by) => {
      store.rollback({ by });
      return changed(request, 'rolled back');
    }),
  );
}
