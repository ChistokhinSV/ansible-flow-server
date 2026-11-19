// The draft's frame (AFS-149): told someone is saving (the same person in another tab too), it
// leaves the field being typed in, waits for the edit that sends to reach the server, and then
// says it is done, so the save takes the typing in; what others did is said in a few words.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Transport = {
  post(message: Record<string, unknown>): void;
  subscribe?(listener: (message: Record<string, unknown>) => void): void;
};
let transport: Transport | undefined;
vi.mock('@ansible-flow/designer', () => ({
  mount: (_root: HTMLElement, options: { transport: Transport }) => {
    transport = options.transport;
  },
}));

const { editDraft, editWords } = await import('../../src/web/viewerDraft');

class FakeSource {
  static last: FakeSource | undefined;
  readonly listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.last = this;
  }
  addEventListener(kind: string, listener: (e: MessageEvent) => void) {
    this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), listener]);
  }
  emit(kind: string, data: unknown) {
    for (const l of this.listeners.get(kind) ?? [])
      l(new MessageEvent(kind, { data: JSON.stringify(data) }));
  }
  close() {}
}

let calls: { at: number; key: string; body: unknown }[];
let commandDone: () => void;
beforeEach(() => {
  calls = [];
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push({
      at: calls.length,
      key,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (key.endsWith('/commands'))
      await new Promise<void>((resolve) => {
        commandDone = resolve;
      });
    return { ok: true, status: 200, json: async () => ({ revision: 2 }) } as Response;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe("the draft's frame", () => {
  it('sends what is being typed when this person saves in another tab, then says it is done', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    editDraft({ root, draft: 'd1', me: 'dana', theme: 'dark', stateKey: 'k', tab: 'tab-b' });
    const source = FakeSource.last as FakeSource;
    expect(source.url).toBe('/api/v1/drafts/d1/events?tab=tab-b');
    expect(calls.find((c) => c.key.endsWith('/here'))?.body).toEqual({ tab: 'tab-b' });
    // A field being typed in commits when it is left: the designer sends its command then.
    const field = document.createElement('input');
    root.append(field);
    field.addEventListener('blur', () =>
      transport?.post({ type: 'command', reqId: 1, command: { kind: 'updateFlow' } }),
    );
    field.focus();
    source.emit('saving', {
      by: { login: 'dana', name: 'Dana Whitfield' },
      flush: 'f1',
      stream: 's2',
    });
    expect(document.activeElement).not.toBe(field);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Not done while the edit is on its way.
    expect(calls.some((c) => c.key.endsWith('/flushed'))).toBe(false);
    commandDone();
    await vi.waitFor(() => expect(calls.some((c) => c.key.endsWith('/flushed'))).toBe(true));
    const keys = calls.map((c) => c.key);
    expect(keys.indexOf('POST /api/v1/drafts/d1/commands')).toBeLessThan(
      keys.indexOf('POST /api/v1/drafts/d1/flushed'),
    );
    expect(calls.find((c) => c.key.endsWith('/flushed'))?.body).toEqual({
      flush: 'f1',
      stream: 's2',
    });
  });

  it('selects the step it was opened at once the flow shows (AFS-164)', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    editDraft({ root, draft: 'd1', me: 'dana', theme: 'dark', stateKey: 'k', reveal: 'n7' });
    const heard: Record<string, unknown>[] = [];
    transport?.subscribe?.((m) => heard.push(m));
    transport?.post({ type: 'ready' });
    (FakeSource.last as FakeSource).emit('draft', { snapshot: { doc: { nodes: [] } } });
    (FakeSource.last as FakeSource).emit('draft', { snapshot: { doc: { nodes: [] } } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const types = heard.map((m) => m.type).filter((t) => t === 'snapshot' || t === 'reveal');
    // Once, after the first flow it shows.
    expect(types).toEqual(['snapshot', 'reveal', 'snapshot']);
    expect(heard.find((m) => m.type === 'reveal')).toEqual({ type: 'reveal', node: 'n7' });
  });

  it('says what an edit did in a few words', () => {
    expect(editWords({ changes: [{ step: 'a2 ping', kind: 'removed', fields: [] }] })).toBe(
      'removed a2 ping',
    );
    expect(
      editWords({
        changes: [{ step: 'Backup', kind: 'changed', fields: ['title', 'settings.timeout'] }],
      }),
    ).toBe('changed Backup (title, timeout)');
    expect(editWords({ changes: [{ kind: 'changed', fields: ['goal'] }] })).toBe(
      "changed the flow's goal",
    );
    expect(editWords({ changes: [], wires: 1 })).toBe('changed the wires');
  });
});
