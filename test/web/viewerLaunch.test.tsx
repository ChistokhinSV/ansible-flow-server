// The canvas's Run (AFS-67), with the server played by the test: no configuration says where to
// add one; one opens the designer's dialog with its fields and the hosts; typing asks for the
// hosts again; Run launches and shows the run; a refusal opens the dialog again with why.
import type { HostMessage } from '@ansible-flow/core/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConfigChoice, chooseConfig, launcher } from '../../src/web/viewerLaunch';

const FIELDS = [
  { name: 'devices', type: 'host_list', required: true, secret: false, text: 'fw-edge-01' },
  { name: 'api_password', type: 'string', required: false, secret: true, text: '' },
];
const FACTS = {
  sources: ['inventory/prod/hosts.yaml'],
  count: 1,
  hosts: ['fw-edge-01'],
  unknown: [],
  uses: [],
  prod: [],
  vault: false,
  environment: 'ee:1 (docker)',
};

let routes: Record<string, (body: unknown) => { status?: number; body?: unknown }>;
let asked: { key: string; body: unknown }[];
beforeEach(() => {
  asked = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    asked.push({ key, body });
    const answer = routes[key]?.(body) ?? { status: 404, body: { message: key } };
    const status = answer.status ?? 200;
    return { ok: status < 300, status, json: async () => answer.body } as Response;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const setUp = (configs: object[], choose = vi.fn()) => {
  const sent: HostMessage[] = [];
  const launched: string[] = [];
  routes = {
    'GET /projects/p1/launch-configs': () => ({ body: configs }),
    'GET /launch-configs/c1/form?mode=real': () => ({
      body: { flow: { name: 'Hello' }, fields: FIELDS, inventory: 'inventory/prod/hosts.yaml' },
    }),
    'POST /launch-configs/c1/facts': (body) => {
      const devices = (body as { inputs: Record<string, string> }).inputs.devices;
      return {
        body: devices
          ? { facts: FACTS, groups: ['edge'], environment: 'ee:1 (docker)', commit: 'a'.repeat(40) }
          : { factsError: 'devices is required', environment: 'ee:1 (docker)' },
      };
    },
  };
  const l = launcher({
    project: 'p1',
    path: 'flows/hello.flow.yaml',
    send: (m) => sent.push(m),
    launched: (id) => launched.push(id),
    choose,
  });
  return { l, sent, launched };
};
const config = (id: string, name: string, flowFile = 'flows/hello.flow.yaml') => ({
  id,
  name,
  flowFile,
  mode: 'check',
});

describe('Run on the canvas', () => {
  it('without a configuration of the flow, says where to add one', async () => {
    const { l, sent } = setUp([config('c9', 'Other', 'flows/other.flow.yaml')]);
    await l.run('check');
    expect(sent).toEqual([
      expect.objectContaining({ type: 'notify', text: expect.stringMatching(/add one/) }),
    ]);
  });

  it("opens the designer's dialog, asks for hosts as typed, launches, and says a refusal", async () => {
    const { l, sent, launched } = setUp([config('c1', 'Edge')]);
    await l.run('real');
    const opened = sent.find((m) => m.type === 'launch') as Extract<
      HostMessage,
      { type: 'launch' }
    >;
    const plan = opened.plan;
    expect(plan).toMatchObject({
      mode: 'real',
      flow: 'Hello · Edge',
      groups: ['edge'],
      facts: { count: 1 },
      vault: false,
      inventory: 'inventory/prod/hosts.yaml',
      environment: 'ee:1 (docker)',
    });
    // The first ask is for groups too, with the start values and no secret.
    expect(asked.find((a) => a.key === 'POST /launch-configs/c1/facts')?.body).toEqual({
      mode: 'real',
      groups: true,
      inputs: { devices: 'fw-edge-01' },
    });

    // The dialog's values arrive parsed: the server takes them as text.
    await l.check(plan?.token as string, { devices: [] });
    expect(sent.at(-1)).toEqual({
      type: 'launchFacts',
      token: plan?.token,
      error: 'devices is required',
    });

    // Refused: the dialog again with what was typed (not the secret) and why.
    routes['POST /launch-configs/c1/launch'] = () => ({
      status: 422,
      body: { message: 'The project has no commit yet' },
    });
    await l.launch(plan?.token as string, {
      devices: ['fw-edge-01', 'fw-edge-02'],
      api_password: 'S3CR3T',
    });
    const again = sent.at(-1) as Extract<HostMessage, { type: 'launch' }>;
    expect(again.notice).toBe('The project has no commit yet');
    expect(again.plan?.fields.map((f) => f.text)).toEqual(['fw-edge-01, fw-edge-02', '']);
    expect(asked.at(-1)?.body).toEqual({
      mode: 'real',
      inputs: { devices: 'fw-edge-01, fw-edge-02', api_password: 'S3CR3T' },
    });

    routes['POST /launch-configs/c1/launch'] = () => ({ status: 201, body: { id: 'r7' } });
    await l.launch(plan?.token as string, { devices: ['fw-edge-01'] });
    expect(sent.at(-1)).toEqual({ type: 'launch', plan: null });
    expect(launched).toEqual(['r7']);
    // A token is used once.
    await l.launch(plan?.token as string, { devices: ['fw-edge-01'] });
    expect(launched).toEqual(['r7']);
  });

  it('who may not launch is told so, and no dialog opens', async () => {
    const { l, sent } = setUp([config('c1', 'Edge')]);
    routes['POST /launch-configs/c1/facts'] = () => ({ status: 403, body: {} });
    await l.run('real');
    expect(sent.some((m) => m.type === 'launch')).toBe(false);
    expect(sent.at(-1)).toMatchObject({ level: 'error', text: expect.stringMatching(/operator/) });
  });

  it('with several configurations, the person picks one; Cancel opens nothing', async () => {
    const choose = vi.fn(async (list: ConfigChoice[]) => list[1]);
    const { l, sent } = setUp([config('c0', 'Lab'), config('c1', 'Edge')], choose);
    await l.run('real');
    expect(choose.mock.calls[0]?.[0].map((c: ConfigChoice) => c.name)).toEqual(['Lab', 'Edge']);
    expect(sent.some((m) => m.type === 'launch')).toBe(true);

    const picker = chooseConfig([config('c0', 'Lab') as ConfigChoice]);
    const buttons = [...document.querySelectorAll('[role=dialog] button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Lab (check)', 'Cancel']);
    (buttons[1] as HTMLButtonElement).click();
    expect(await picker).toBeUndefined();
    expect(document.querySelector('[role=dialog]')).toBeNull();
  });
});
