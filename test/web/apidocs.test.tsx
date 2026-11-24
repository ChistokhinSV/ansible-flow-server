// AFS-199: the API reference: Scalar's page in a frame of the application (apiPage.tsx), and what
// that page does around Scalar (apidocsTry.ts): the theme, and how Try it sends.
import { readFileSync } from 'node:fs';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HASH_MESSAGE,
  holdableClock,
  kindOf,
  NotSent,
  placeOf,
  quiet,
  quietConsole,
  THEME_MESSAGE,
  tryFetch,
} from '../../src/web/apidocsTry';
import { App } from '../../src/web/app';

const omar = { id: 'u2', login: 'omar', name: 'Omar Haddad', admin: false, groups: [] };

describe('the API reference page', () => {
  beforeEach(() => {
    window.scrollTo = () => undefined;
    vi.stubGlobal('fetch', async (url: string) => {
      const body = url === '/api/v1/session' ? omar : undefined;
      return { ok: !!body, status: body ? 200 : 404, json: async () => body } as Response;
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("shows Scalar's page in a frame, in the application's theme; a new theme is a message", async () => {
    window.history.replaceState(null, '', '/docs/api');
    render(<App />);
    await screen.findByRole('heading', { name: 'API reference' });
    const frame = document.querySelector('iframe.api-frame') as HTMLIFrameElement;
    expect(new URL(frame.src).pathname).toBe('/apidocs.html');
    expect(new URL(frame.src).searchParams.get('theme')).toBe('dark');
    expect(screen.getByRole('link', { name: 'OpenAPI document' }).getAttribute('href')).toBe(
      '/api/v1/openapi.json',
    );
    const sent: unknown[] = [];
    vi.spyOn(frame.contentWindow as Window, 'postMessage').mockImplementation((m) => {
      sent.push(m);
    });
    // Dark, light, as the device: the frame is told, and stays the same page.
    await act(async () => screen.getByRole('button', { name: /^Theme/ }).click());
    await act(async () => screen.getByRole('button', { name: /^Theme/ }).click());
    expect(sent).toEqual([
      { type: THEME_MESSAGE, theme: 'light' },
      { type: THEME_MESSAGE, theme: 'auto' },
    ]);
    expect(document.querySelector('iframe.api-frame')).toBe(frame);
    expect(new URL(frame.src).searchParams.get('theme')).toBe('dark');
  });

  it('takes the theme asked for, else the device', () => {
    expect(kindOf('light', false)).toBe('light');
    expect(kindOf('dark', true)).toBe('dark');
    expect(kindOf('auto', true)).toBe('light');
    expect(kindOf(null, false)).toBe('dark');
  });

  it("has the pages' colours (apidocs.css says what styles.css says)", () => {
    const pages = readFileSync('src/web/styles.css', 'utf8');
    const mine = readFileSync('src/web/apidocs.css', 'utf8');
    const block = (css: string, selector: string) => {
      const start = css.indexOf(`${selector} {`);
      return css.slice(start, css.indexOf('}', start));
    };
    for (const [selector, theirs] of [
      [':root[data-theme="dark"]', ':root[data-theme="dark"]'],
      [':root[data-theme="light"]', ':root[data-theme="light"]'],
    ] as const) {
      const vars = [...block(mine, selector).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)];
      expect(vars.length).toBeGreaterThan(10);
      for (const [, name, value] of vars)
        expect(block(pages, theirs), `${selector} ${name}`).toContain(`${name}: ${value};`);
    }
  });
});

describe('Try it', () => {
  const origin = 'https://afs.example.test';
  const setup = (yes = true) => {
    const sent: Request[] = [];
    const asked: string[] = [];
    const send = tryFetch({
      fetch: async (input) => {
        sent.push(input as Request);
        return new Response('{}', { status: 200 });
      },
      ask: async (question) => {
        asked.push(question);
        return yes;
      },
      origin,
    });
    return { send, sent, asked };
  };

  it('reads with the session, without asking', async () => {
    const { send, sent, asked } = setup();
    await send(`${origin}/api/v1/runs?limit=5`);
    expect(asked).toEqual([]);
    expect(sent[0]?.credentials).toBe('same-origin');
    expect(sent[0]?.headers.has('authorization')).toBe(false);
  });

  it('with a pasted token, sends no cookie: the server would answer as the session', async () => {
    const { send, sent } = setup();
    await send(`${origin}/api/v1/tokens`, { headers: { Authorization: 'Bearer afs_example' } });
    expect(sent[0]?.credentials).toBe('omit');
    expect(sent[0]?.headers.get('authorization')).toBe('Bearer afs_example');
  });

  it('an empty bearer is no token: the session is used', async () => {
    const { send, sent } = setup();
    await send(`${origin}/api/v1/tokens`, { headers: { Authorization: 'Bearer ' } });
    expect(sent[0]?.credentials).toBe('same-origin');
    expect(sent[0]?.headers.has('authorization')).toBe(false);
  });

  it('asks before anything but a read; no is not sent', async () => {
    const yes = setup(true);
    await yes.send(`${origin}/api/v1/runs/r1/cancel`, { method: 'POST', body: '{}' });
    expect(yes.asked[0]).toMatch(/^Send POST \/api\/v1\/runs\/r1\/cancel\? .* as you/);
    expect(yes.sent).toHaveLength(1);
    const no = setup(false);
    await expect(
      no.send(`${origin}/api/v1/tokens/t1`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer afs_example' },
      }),
    ).rejects.toBeInstanceOf(NotSent);
    expect(no.asked[0]).toMatch(/as the pasted token/);
    expect(no.sent).toEqual([]);
  });

  it('AFS-258: the time of a request leaves out the question before it', async () => {
    let real = 1000;
    const clock = { now: () => real };
    const held = holdableClock(clock);
    const send = tryFetch({
      fetch: async () => {
        real += 40;
        return new Response('{}', { status: 200 });
      },
      ask: async () => {
        // The person reads the question for 6 s.
        real += 6000;
        expect(clock.now()).toBe(1000);
        return true;
      },
      origin,
      hold: () => held.hold(),
    });
    const start = clock.now();
    await send(`${origin}/api/v1/runs/r1/cancel`, { method: 'POST', body: '{}' });
    expect(clock.now() - start).toBe(40);
  });

  it('sends to this server only', async () => {
    const { send, sent } = setup();
    await expect(send('https://elsewhere.example.test/api/v1/runs')).rejects.toThrow(
      /this server only/,
    );
    expect(sent).toEqual([]);
  });
});

describe('the frame around Scalar (AFS-255)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("leaves Scalar's cookie warning and a request not sent out of the console", () => {
    const said: unknown[][] = [];
    const target = {
      warn: (...a: unknown[]) => said.push(a),
      error: (...a: unknown[]) => said.push(a),
    };
    quietConsole(target);
    target.warn("We're trying to add a Cookie header, but browsers often omit them");
    target.error(new NotSent('POST', '/api/v1/runs/r1/cancel'));
    target.warn('something else');
    expect(said).toEqual([['something else']]);
    expect(quiet([new Error('boom')])).toBe(false);
  });

  it('a link to an operation opens it in the frame; the frame keeps it in the address', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const body = url === '/api/v1/session' ? omar : undefined;
      return { ok: !!body, status: body ? 200 : 404, json: async () => body } as Response;
    });
    window.history.replaceState(null, '', '/docs/api#tag/runs/GET/api/v1/runs');
    render(<App />);
    await screen.findByRole('heading', { name: 'API reference' });
    const frame = document.querySelector('iframe.api-frame') as HTMLIFrameElement;
    expect(new URL(frame.src).hash).toBe('#tag/runs/GET/api/v1/runs');
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: frame.contentWindow,
          data: { type: HASH_MESSAGE, hash: '#tag/runs/POST/api/v1/runs/{id}/cancel' },
        }),
      );
    });
    expect(window.location.pathname + window.location.hash).toBe(
      '/docs/api#tag/runs/POST/api/v1/runs/{id}/cancel',
    );
    expect(placeOf('#tag/x"><script>')).toBe('');
  });
});
