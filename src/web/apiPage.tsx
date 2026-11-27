// The API reference (AFS-199): the server's own OpenAPI document (/api/v1/openapi.json), read and
// tried in Scalar. Scalar is a page of its own (apidocs.html, its own policy), shown here in a
// frame under the application's bar, as the designer is; it is loaded on this page only.
import { useEffect, useRef } from 'react';
import { HASH_MESSAGE, placeOf, THEME_MESSAGE } from './apidocsTry';
import type { ThemeChoice } from './theme';
import { HelpButton, PageHead } from './ui';

/** What the frame is told: `auto` follows the device there too. */
const asked = (theme: ThemeChoice) => (theme === 'system' ? 'auto' : theme);

export function ApiDocs({ theme }: { theme: ThemeChoice }) {
  const frame = useRef<HTMLIFrameElement>(null);
  // The first theme is in the address; a change is a message, so the page and a pasted token stay.
  const first = useRef(asked(theme)).current;
  // AFS-255: a link to an operation (/docs/api#tag/runs/GET/api/v1/runs) opens it in the frame,
  // and the operation shown is kept in this page's address.
  const place = useRef(placeOf(window.location.hash)).current;
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow)
        return;
      const data = event.data as { type?: string; hash?: string } | null;
      if (data?.type !== HASH_MESSAGE) return;
      const hash = placeOf(data.hash ?? '');
      if (hash !== window.location.hash)
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${hash}`);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage(
      { type: THEME_MESSAGE, theme: asked(theme) },
      window.location.origin,
    );
  }, [theme]);
  return (
    <div className="api-page">
      <PageHead title="API reference">
        <a className="button" href="/api/v1/openapi.json">
          OpenAPI document
        </a>
        <HelpButton page="api-and-mcp.md" about="API reference" />
      </PageHead>
      <iframe
        ref={frame}
        className="api-frame"
        src={`/apidocs.html?theme=${first}${place}`}
        title="The API reference: every address, its parameters and answers, and Try it"
      />
    </div>
  );
}
