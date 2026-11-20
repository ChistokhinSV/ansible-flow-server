// AFS-118: a step's module docs on the viewer's canvas, from the catalog of the flow's image. The
// flow page and the flow at a commit (AFS-123) answer the designer's `catalog` the same way.
import type { HostMessage, WebviewMessage } from '@ansible-flow/core/protocol';

type CatalogAsk = Extract<WebviewMessage, { type: 'catalog' }>;

export function answerCatalog(
  project: string,
  path: string,
  message: CatalogAsk,
  send: (message: HostMessage) => void,
): void {
  const reqId = message.reqId;
  void fetch(
    `/api/v1/projects/${encodeURIComponent(project)}/flows/catalog?path=${encodeURIComponent(path)}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: message.request }),
    },
  ).then(
    async (reply) => {
      const data = await reply.json().catch(() => undefined);
      if (reply.status === 202 || !reply.ok)
        send({
          type: 'catalogReply',
          reqId,
          ok: false,
          error: data?.status?.message ?? String(data?.message ?? 'The catalog is not ready'),
        } as HostMessage);
      else
        send({
          type: 'catalogReply',
          reqId,
          ok: true,
          result: (data?.result ?? data?.status) as never,
        } as HostMessage);
    },
    () =>
      send({
        type: 'catalogReply',
        reqId,
        ok: false,
        error: 'The server does not answer',
      } as HostMessage),
  );
}
