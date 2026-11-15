// The viewer follows its flow on the branch (AFS-75), with the server played by the test: someone
// changes the flow, a bar says who and how much; Update shows the new version; Show changes opens
// the Changes lens against the version shown before; the lens also compares with older commits.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlow } from '@ansible-flow/core/flow/document';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import type { HostMessage, Snapshot } from '@ansible-flow/core/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followFlow } from '../../src/web/viewerChanges';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const text = readFileSync(join(__dirname, '../fixtures/hello.flow.yaml'), 'utf8');
const before = parseFlow(text).doc as FlowDocument;
const after = parseFlow(text.replace('title: Say hello', 'title: Say hello to the team'))
  .doc as FlowDocument;
const snap = (doc: FlowDocument): Snapshot =>
  ({ docVersion: 1, doc, stale: false, findings: [], openPorts: [] }) as unknown as Snapshot;

let routes: Record<string, () => unknown>;
let streams: { url: string; on: Record<string, (e: MessageEvent) => void> }[];
beforeEach(() => {
  streams = [];
  vi.stubGlobal('fetch', async (url: string) => {
    const key = url.replace('/api/v1', '');
    const answer = routes[key];
    return { ok: !!answer, status: answer ? 200 : 404, json: async () => answer?.() } as Response;
  });
  vi.stubGlobal(
    'EventSource',
    class {
      on: Record<string, (e: MessageEvent) => void> = {};
      constructor(readonly url: string) {
        streams.push(this);
      }
      addEventListener(kind: string, listener: (e: MessageEvent) => void) {
        this.on[kind] = listener;
      }
      close() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the viewer follows its flow on the branch', () => {
  it('says who changed it and how much; Update and Show changes', async () => {
    routes = {
      [`/projects/p1/changes?from=${A}&to=${B}`]: () => ({
        from: A,
        to: B,
        flows: [{ file: 'hello.flow.yaml', change: 'changed', authors: ['Mia Ortega'] }],
      }),
      [`/projects/p1/flows/view?path=hello.flow.yaml&commit=${B}`]: () => ({
        commit: B,
        snapshot: snap(after),
      }),
      [`/projects/p1/flows/history?path=hello.flow.yaml&commit=${B}`]: () => [
        { commit: B, author: 'Mia Ortega', at: '2026-11-15T09:00:00Z', subject: 'Friendlier' },
        { commit: A, author: 'Dana Whitfield', at: '2026-11-14T09:00:00Z', subject: 'First' },
      ],
    };
    const sent: HostMessage[] = [];
    const bar = document.createElement('div');
    document.body.append(bar);
    bar.hidden = true;
    followFlow({
      project: 'p1',
      path: 'hello.flow.yaml',
      commit: A,
      snapshot: snap(before),
      send: (m) => sent.push(m),
      bar,
      live: true,
    });
    expect(streams[0]?.url).toBe('/api/v1/projects/p1/events');
    // At once the branch is where the page is: nothing to say.
    streams[0]?.on.commit?.({ data: JSON.stringify({ commit: A }) } as MessageEvent);
    await tick();
    expect(bar.hidden).toBe(true);

    streams[0]?.on.moved?.({ data: JSON.stringify({ from: A, to: B }) } as MessageEvent);
    await vi.waitFor(() => expect(bar.hidden).toBe(false));
    expect(bar.textContent).toContain('Mia Ortega changed this flow: 1 step.');

    const button = (name: string) =>
      [...bar.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement;
    button('Show changes').click();
    // The new version is shown, and the Changes lens compares it with the one shown before.
    expect(sent.find((m) => m.type === 'snapshot')).toMatchObject({
      snapshot: { docVersion: 2, doc: after },
    });
    expect(sent).toContainEqual({ type: 'setLens', lens: 'changes' });
    await vi.waitFor(() =>
      expect(sent.some((m) => m.type === 'lensFacts' && m.facts.compare?.state === 'ready')).toBe(
        true,
      ),
    );
    const ready = sent.findLast((m) => m.type === 'lensFacts') as Extract<
      HostMessage,
      { type: 'lensFacts' }
    >;
    expect(ready.facts.compare).toMatchObject({
      ref: A,
      label: `before Mia Ortega's change (${A.slice(0, 8)})`,
      base: before,
    });
    expect(bar.textContent).toContain("You see Mia Ortega's change.");
  });

  it('a flow removed from the branch is said so, and stays as it was', async () => {
    routes = {
      [`/projects/p1/changes?from=${A}&to=${B}`]: () => ({
        flows: [{ file: 'hello.flow.yaml', change: 'removed', authors: ['Omar Haddad'] }],
      }),
    };
    const sent: HostMessage[] = [];
    const bar = document.createElement('div');
    followFlow({
      project: 'p1',
      path: 'hello.flow.yaml',
      commit: A,
      snapshot: snap(before),
      send: (m) => sent.push(m),
      bar,
      live: true,
    });
    streams[0]?.on.moved?.({ data: JSON.stringify({ from: A, to: B }) } as MessageEvent);
    await vi.waitFor(() => expect(bar.textContent).toContain('Omar Haddad removed this flow'));
    expect(sent.some((m) => m.type === 'snapshot')).toBe(false);
  });

  it("a flow at a commit (a run's) does not follow the branch", () => {
    followFlow({
      project: 'p1',
      path: 'hello.flow.yaml',
      commit: A,
      snapshot: snap(before),
      send: () => undefined,
      bar: document.createElement('div'),
      live: false,
    });
    expect(streams).toEqual([]);
  });
});
