// The canvas's Run (AFS-67), with the server played by the test: no configuration says where to
// add one; one opens the designer's dialog with its fields and the hosts; typing asks for the
// hosts again; Run launches and shows the run; a refusal opens the dialog again with why.
import type { HostMessage } from '@ansible-flow/core/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askName, type ConfigChoice, chooseConfig, launcher } from '../../src/web/viewerLaunch';

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

const setUp = (
  configs: object[],
  choose = vi.fn(),
  askName = vi.fn(async (_s: string): Promise<string | undefined> => undefined),
) => {
  const sent: HostMessage[] = [];
  const launched: string[] = [];
  const went: string[] = [];
  routes = {
    'GET /projects/p1/launch-configs': () => ({ body: configs }),
    'GET /launch-configs/c1/form?mode=real': () => ({
      body: {
        flow: { name: 'Hello' },
        fields: FIELDS,
        inventory: 'inventory/prod/hosts.yaml',
        origins: { devices: 'Read by Ping.' },
      },
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
    askName,
    go: (to) => went.push(to),
  });
  return { l, sent, launched, went };
};
const config = (id: string, name: string, flowFile = 'flows/hello.flow.yaml') => ({
  id,
  name,
  flowFile,
  mode: 'check',
});

describe('Run on the canvas', () => {
  it('AFS-177: Run Step by Step ticks Step by step; Run launches every step with the pause points', async () => {
    const sent: HostMessage[] = [];
    setUp([config('c1', 'Edge')]);
    routes['POST /launch-configs/c1/launch'] = () => ({ status: 201, body: { id: 'r1' } });
    const l = launcher({
      project: 'p1',
      path: 'flows/hello.flow.yaml',
      send: (m) => sent.push(m),
      launched: () => undefined,
      choose: vi.fn(),
      askName: vi.fn(),
      go: () => undefined,
      stepPoints: () => ['01M6GPM99KC9TX091MCH61REQV'],
    });
    await l.run('real', true);
    const plan = (sent.find((m) => m.type === 'launch') as Extract<HostMessage, { type: 'launch' }>)
      .plan;
    expect(plan?.steps).toEqual({ on: true });
    await l.launch(plan?.token as string, { devices: ['fw-edge-01'] }, true);
    expect(asked.find((a) => a.key === 'POST /launch-configs/c1/launch')?.body).toMatchObject({
      mode: 'real',
      step: { every: true, points: ['01M6GPM99KC9TX091MCH61REQV'] },
    });
  });

  // AFS-264: a debug run with pause points ignored "Pause before the first step": it paused only
  // at the first point. Ticked, it pauses before step 1 too; unticked, only at the points.
  it.each([
    [true, true],
    [false, false],
    [undefined, false],
  ])(
    'AFS-264: Debug with pause points, tick %s: pauses before the first step: %s',
    async (tick, every) => {
      const sent: HostMessage[] = [];
      setUp([config('c1', 'Edge')]);
      routes['POST /launch-configs/c1/launch'] = () => ({ status: 201, body: { id: 'r1' } });
      const point = { node: '01M6GPM99KC9TX091MCH61REQV' };
      const l = launcher({
        project: 'p1',
        path: 'flows/hello.flow.yaml',
        send: (m) => sent.push(m),
        launched: () => undefined,
        choose: vi.fn(),
        askName: vi.fn(),
        go: () => undefined,
        stepPoints: () => [point],
        debugFailures: () => undefined,
      });
      await l.run('real', false, true);
      const plan = (
        sent.find((m) => m.type === 'launch') as Extract<HostMessage, { type: 'launch' }>
      ).plan;
      expect(plan?.steps).toEqual({ on: true, debug: true });
      await l.launch(plan?.token as string, { devices: ['fw-edge-01'] }, tick, true);
      expect(asked.find((a) => a.key === 'POST /launch-configs/c1/launch')?.body).toMatchObject({
        step: { every, points: [point], debug: true, pauseOnFailure: true },
      });
    },
  );

  it('AFS-179: Debug without pause points pauses before each step, ticked or not', async () => {
    const sent: HostMessage[] = [];
    setUp([config('c1', 'Edge')]);
    routes['POST /launch-configs/c1/launch'] = () => ({ status: 201, body: { id: 'r1' } });
    const l = launcher({
      project: 'p1',
      path: 'flows/hello.flow.yaml',
      send: (m) => sent.push(m),
      launched: () => undefined,
      choose: vi.fn(),
      askName: vi.fn(),
      go: () => undefined,
      stepPoints: () => [],
      debugFailures: () => undefined,
    });
    await l.run('real', false, true);
    const plan = (sent.find((m) => m.type === 'launch') as Extract<HostMessage, { type: 'launch' }>)
      .plan;
    await l.launch(plan?.token as string, { devices: ['fw-edge-01'] }, false, true);
    expect(asked.find((a) => a.key === 'POST /launch-configs/c1/launch')?.body).toMatchObject({
      step: { every: true, points: [], debug: true },
    });
  });

  it('AFS-177: a page that does not step (no pause points given) offers no tick', async () => {
    const { l, sent } = setUp([config('c1', 'Edge')]);
    await l.run('real', true);
    const plan = (sent.find((m) => m.type === 'launch') as Extract<HostMessage, { type: 'launch' }>)
      .plan;
    expect(plan?.steps).toBeUndefined();
  });

  it('without a configuration of the flow, offers a new one: its page, for this flow (AFS-97)', async () => {
    const choose = vi.fn(async () => 'new' as const);
    const { l, sent, went } = setUp([config('c9', 'Other', 'flows/other.flow.yaml')], choose);
    routes['GET /projects/p1'] = () => ({ body: { id: 'p1', key: 'edge', workspace: 'w1' } });
    routes['GET /workspaces/w1'] = () => ({ body: { id: 'w1', key: 'netops' } });
    await l.run('check');
    expect(choose).toHaveBeenCalledWith([]);
    expect(sent).toEqual([]);
    expect(went).toEqual(['/w/netops/edge/launch/new?flow=flows%2Fhello.flow.yaml&back=flow']);
  });

  it('Save as Launch Configuration: a copy of the chosen one with the mode and inputs (AFS-97)', async () => {
    const askName = vi.fn(async (_s: string) => 'Edge, core only' as string | undefined);
    const { l, sent } = setUp([config('c1', 'Edge')], vi.fn(), askName);
    routes['GET /launch-configs/c1'] = () => ({
      body: {
        id: 'c1',
        name: 'Edge',
        project: 'p1',
        flowFile: 'flows/hello.flow.yaml',
        inventory: 'inventory/prod/hosts.yaml',
        environment: 'e1',
        credentials: ['k1'],
        notify: { when: 'failed', to: ['network-oncall'] },
        mode: 'check',
        inputs: {},
      },
    });
    routes['POST /projects/p1/launch-configs'] = () => ({ status: 201, body: { id: 'c2' } });
    await l.run('real');
    const plan = (sent.find((m) => m.type === 'launch') as Extract<HostMessage, { type: 'launch' }>)
      .plan;
    expect(plan).toMatchObject({ canSave: true });
    await l.save(plan?.token as string, { devices: ['core'] });
    expect(askName).toHaveBeenCalledWith('Edge (copy)');
    expect(asked.at(-1)).toEqual({
      key: 'POST /projects/p1/launch-configs',
      body: {
        name: 'Edge, core only',
        flowFile: 'flows/hello.flow.yaml',
        gitRef: null,
        commit: null,
        inventory: 'inventory/prod/hosts.yaml',
        eeImage: null,
        environment: 'e1',
        limit: null,
        credentials: ['k1'],
        notify: { when: 'failed', to: ['network-oncall'] },
        mode: 'real',
        inputs: { devices: ['core'] },
      },
    });
    expect(sent.at(-1)).toMatchObject({
      level: 'info',
      text: expect.stringMatching(/Edge, core only/),
    });
    // Refused (a name taken): said, and the dialog stays as it is.
    routes['POST /projects/p1/launch-configs'] = () => ({
      status: 409,
      body: { message: 'A launch configuration named Edge, core only is there already' },
    });
    await l.save(plan?.token as string, { devices: ['core'] });
    expect(sent.at(-1)).toMatchObject({ level: 'error', text: expect.stringMatching(/already/) });
    // Cancelled: nothing is asked of the server.
    askName.mockResolvedValueOnce(undefined);
    const before = asked.length;
    await l.save(plan?.token as string, {});
    expect(asked.slice(before).map((a) => a.key)).toEqual(['GET /launch-configs/c1']);
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
      // AFS-191: where each input goes, as the launch form says it.
      origins: { devices: 'Read by Ping.' },
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

  it('a limit that leaves no host is asked about before Run launches; no reopens the dialog (AFS-191)', async () => {
    const { sent, launched } = setUp([config('c1', 'Edge')]);
    const facts = routes['POST /launch-configs/c1/facts'] as (b: unknown) => { body: object };
    routes['POST /launch-configs/c1/facts'] = (body) => ({
      body: { ...facts(body).body, limited: { pattern: 'nosuchhost', hosts: [], count: 0 } },
    });
    routes['POST /launch-configs/c1/launch'] = () => ({ status: 201, body: { id: 'r8' } });
    const questions: string[] = [];
    let yes = false;
    const asking = launcher({
      project: 'p1',
      path: 'flows/hello.flow.yaml',
      send: (m) => sent.push(m),
      launched: (id) => launched.push(id),
      choose: vi.fn(),
      askName: vi.fn(),
      go: vi.fn(),
      askYes: async (question) => {
        questions.push(question);
        return yes;
      },
    });
    await asking.run('real');
    const token = (sent.at(-1) as Extract<HostMessage, { type: 'launch' }>).plan?.token as string;
    await asking.launch(token, { devices: ['fw-edge-01'] });
    expect(questions).toEqual([
      "Launch anyway? No host would run: the limit nosuchhost leaves none of the targets' hosts.",
    ]);
    expect(asked.some((a) => a.key === 'POST /launch-configs/c1/launch')).toBe(false);
    expect((sent.at(-1) as Extract<HostMessage, { type: 'launch' }>).plan?.fields[0]?.text).toBe(
      'fw-edge-01',
    );
    yes = true;
    await asking.launch(token, { devices: ['fw-edge-01'] });
    expect(launched).toEqual(['r8']);
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
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Lab (check)',
      'New configuration…',
      'Cancel',
    ]);
    (buttons[2] as HTMLButtonElement).click();
    expect(await picker).toBeUndefined();
    expect(document.querySelector('[role=dialog]')).toBeNull();
    const fresh = chooseConfig([]);
    expect(document.querySelector('[role=dialog]')?.textContent).toMatch(
      /no launch configuration yet/,
    );
    (document.querySelector('.afs-choose-new') as HTMLButtonElement).click();
    expect(await fresh).toBe('new');
  });

  it('asks a name for the copy; Escape cancels', async () => {
    const asked1 = askName('Edge (copy)');
    const input = document.querySelector('#afs-ask-name') as HTMLInputElement;
    expect(input.value).toBe('Edge (copy)');
    input.value = '  Edge, core only ';
    (document.querySelector('[role=dialog]') as HTMLFormElement).requestSubmit();
    expect(await asked1).toBe('Edge, core only');
    const asked2 = askName('x');
    document
      .querySelector('[role=dialog]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await asked2).toBeUndefined();
  });
});
