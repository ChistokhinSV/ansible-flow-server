// AFS-199: the API reference, interactive: Scalar over the server's own OpenAPI document. A page
// of its own (its own policy allows the inline styles Scalar needs; the application's pages keep
// theirs), shown in a frame at /docs/api (apiPage.tsx).
//   /apidocs.html?theme=light|dark|auto
// Nothing leaves the server: no fonts, telemetry, AI agent or MCP of Scalar's. "Try it" uses the
// person's session, or a token they paste (kept by Scalar in memory only, never stored), and
// asks before a request that may change something (apidocsTry.ts).
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@scalar/api-reference/style.css';
import './apidocs.css';
import { createApiReference } from '@scalar/api-reference';
import {
  HASH_MESSAGE,
  holdableClock,
  kindOf,
  placeOf,
  quietConsole,
  THEME_MESSAGE,
  tryFetch,
} from './apidocsTry';
import { ask } from './confirm';

quietConsole(console);
// AFS-258: Scalar's request time leaves out the time the question before a send was open.
const clock = holdableClock(performance);
const asked = new URLSearchParams(window.location.search).get('theme');
const light = window.matchMedia?.('(prefers-color-scheme: light)');
let wanted = asked;
const kind = () => kindOf(wanted, !!light?.matches);

const config = () =>
  ({
    url: '/api/v1/openapi.json',
    // AFS-255: the document says "/" (wherever it is reached); Scalar joins that to each path as
    // "origin//api/...". This page's origin, without the slash, is the same server.
    servers: [{ url: window.location.origin, description: 'This server' }] as {
      url: string;
      description: string;
    }[],
    theme: 'none',
    withDefaultFonts: false,
    telemetry: false,
    agent: { disabled: true },
    mcp: { disabled: true },
    // A pasted token stays in this page's memory: a reload forgets it.
    persistAuth: false,
    authentication: { preferredSecurityScheme: 'session' },
    hideClientButton: true,
    hideDarkModeToggle: true,
    showDeveloperTools: 'never',
    // The addresses in the side list; what each does is its heading.
    operationTitleSource: 'path',
    // The page around has the document's own link.
    documentDownloadType: 'none',
    forceDarkModeState: kind(),
    customFetch: tryFetch({
      fetch: (input, init) => window.fetch(input, init),
      ask: (question) => ask(question, { yes: 'Send', danger: true }),
      origin: window.location.origin,
      hold: () => clock.hold(),
    }),
  }) as const;

const apply = () => {
  const now = kind();
  document.documentElement.dataset.theme = now;
  // Scalar takes its forced mode at start only: a later change is its classes, set here.
  document.body.classList.toggle('dark-mode', now === 'dark');
  document.body.classList.toggle('light-mode', now === 'light');
};
apply();
createApiReference('#api', config());
// Only the classes change: the page, what was typed and a pasted token stay.
const retheme = apply;
light?.addEventListener('change', () => {
  if (wanted !== 'light' && wanted !== 'dark') retheme();
});
// AFS-255: the operation shown is told to the application, which keeps it in its own address,
// so the address can be shared and opens there again. Scalar moves by the history API.
let told = '';
const tell = () => {
  const hash = placeOf(window.location.hash);
  if (hash === told || window.parent === window) return;
  told = hash;
  window.parent.postMessage({ type: HASH_MESSAGE, hash }, window.location.origin);
};
for (const method of ['pushState', 'replaceState'] as const) {
  const original = history[method].bind(history);
  history[method] = (...args: Parameters<History['pushState']>) => {
    original(...args);
    tell();
  };
}
window.addEventListener('hashchange', tell);
window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) return;
  const data = event.data as { type?: string; theme?: string } | null;
  if (data?.type !== THEME_MESSAGE) return;
  wanted = data.theme ?? null;
  retheme();
});
