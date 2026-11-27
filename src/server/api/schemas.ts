// AFS-245: what the API answers, as JSON Schema (2020-12, as OpenAPI 3.1 writes it). The main
// resources are named here and go into the OpenAPI document's components; a route says what it
// answers with `returns` in api/catalog.ts. Written by hand from the types the routes answer
// with; the route tests check every answer against them (test/unit/setup.ts), so a field added,
// renamed or dropped without its schema fails a test.
//
// These are not Fastify response schemas: those drop the fields they do not name, without a word.

export type JsonSchema = Record<string, unknown>;

/** What a route answers when it answers. */
export type Answer =
  /** JSON, with the status it answers with (200 unless said). */
  | { json: JsonSchema; status?: 200 | 201 | 202; description?: string; also?: 204 }
  /** Nothing: 204. */
  | { empty: true; description?: string }
  /** Text, of this media type. */
  | { text: string; description: string }
  /** Server-sent events. */
  | { events: string };

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

/** One of the named resources. */
export const one = (name: keyof typeof SCHEMAS, status?: 201 | 202): Answer => ({
  json: ref(name),
  ...(status ? { status } : {}),
});
/** A list of the named resources. */
export const list = (name: keyof typeof SCHEMAS): Answer => ({
  json: { type: 'array', items: ref(name) },
});
/** An answer of its own shape. */
export const json = (schema: JsonSchema, status?: 201 | 202): Answer => ({
  json: schema,
  ...(status ? { status } : {}),
});
export const EMPTY: Answer = { empty: true };
export const EVENTS = (what: string): Answer => ({ events: what });

// The pieces the schemas are made of.
const str = { type: 'string' } as const;
const time = { type: 'string', format: 'date-time' } as const;
const int = { type: 'integer' } as const;
const bool = { type: 'boolean' } as const;
const strings = { type: 'array', items: str } as const;
const anything = {} as const;
const values = { type: 'object', additionalProperties: true } as const;
const textMap = { type: 'object', additionalProperties: str } as const;
const of = (...items: string[]) => ({ type: 'string', enum: items });
const listOf = (items: JsonSchema) => ({ type: 'array', items });
const PLACE = obj({ id: str, key: str, name: str });

/** An object: the fields it always has, and those it may have. */
export function obj(
  always: Record<string, JsonSchema>,
  maybe: Record<string, JsonSchema> = {},
  description?: string,
): JsonSchema {
  return {
    type: 'object',
    ...(description ? { description } : {}),
    required: Object.keys(always),
    properties: { ...always, ...maybe },
  };
}
/** A named resource with more fields (written out: a closed check needs them in one object). */
function withFields(
  name: 'TokenInfo' | 'ActionToken',
  more: Record<string, JsonSchema>,
  description: string,
): JsonSchema {
  const base = BASES[name];
  return {
    ...base,
    description,
    required: [...(base.required as string[]), ...Object.keys(more)],
    properties: { ...(base.properties as object), ...more },
  };
}
const open = (schema: JsonSchema): JsonSchema => ({ ...schema, additionalProperties: true });

const mode = of('check', 'real');
const runState = of('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'lost');
const flowError = open(
  obj({ message: str }, { node: str, step: str, path: str, level: str, code: str }),
);
const lastRun = obj(
  { id: str, number: int, state: str, createdAt: time },
  { endedAt: time },
  'The newest run, of the runs the person asking may see',
);
const person = obj({ id: str, login: str }, { name: str });

/** Resources other answers add to. */
const BASES = {
  TokenInfo: obj(
    {
      id: str,
      name: str,
      hint: { ...str, description: 'Its last four characters' },
      readOnly: bool,
      mcpApprovals: bool,
      mcpRunControl: bool,
      createdAt: time,
    },
    {
      workspace: { ...str, description: 'The one workspace it reaches' },
      expiresAt: time,
      lastUsedAt: time,
    },
    'An access token, never the token itself',
  ),
  ActionToken: obj(
    { id: str, name: str, hint: str, createdAt: time, createdBy: str },
    { lastUsedAt: time },
    "A signed link's token (never the token itself)",
  ),
};

/** The named resources: components.schemas of the OpenAPI document. */
export const SCHEMAS = {
  Ok: obj({ ok: { const: true } }, {}, 'Done'),
  Meta: obj(
    {
      name: str,
      version: str,
      designer: obj(
        { version: str, format: int, formats: listOf(int) },
        { bundle: str },
        'The designer the pages carry',
      ),
      features: strings,
      api: { const: 'v1' },
      instance: str,
    },
    {},
    'What the server is',
  ),
  User: obj(
    {
      id: str,
      login: str,
      name: str,
      admin: bool,
      disabled: bool,
      service: bool,
      createdAt: time,
      groups: strings,
    },
    { email: str, webhookUrl: str, lastLoginAt: time, source: str, sources: strings },
    'A person, or a service account (a program that signs in with tokens only)',
  ),
  Group: obj(
    { id: str, name: str, members: { ...strings, description: 'The logins of its members' } },
    { email: str, webhookUrl: str, source: str },
    'A group of people',
  ),
  Credential: obj(
    {
      id: str,
      workspace: str,
      name: str,
      kind: str,
      fields: { ...textMap, description: 'The part that is not secret (a user name, a host)' },
      has: {
        ...strings,
        description: 'The names of the secret parts it holds, never their values',
      },
      usedBy: int,
      createdAt: time,
      updatedAt: time,
    },
    {
      description: str,
      uses: listOf(obj({ kind: of('project', 'launch'), project: str, name: str }, { id: str })),
      refs: {
        ...values,
        description:
          'The secret parts taken from a secret provider, by name: the provider, and the path for those who may see it',
      },
    },
    'A credential of a workspace: its secret parts are never shown',
  ),
  EnvironmentBuild: obj(
    {
      id: str,
      environment: str,
      number: int,
      state: of('queued', 'building', 'done', 'failed'),
      pruned: bool,
      by: str,
      createdAt: time,
    },
    {
      image: str,
      lock: obj({ baseImage: str, ansibleCore: str, collections: textMap }),
      catalog: obj({ ansibleCore: str, collections: textMap }),
      error: str,
      startedAt: time,
      endedAt: time,
    },
    "A build of an environment's image",
  ),
  Environment: obj(
    {
      id: str,
      workspace: str,
      name: str,
      kind: of('spec', 'image'),
      keep: int,
      usedBy: int,
      createdBy: str,
      createdAt: time,
      updatedAt: time,
    },
    {
      description: str,
      image: str,
      spec: open(obj({}, {}, 'What the image is built from')),
      current: str,
      latest: ref('EnvironmentBuild'),
      catalog: obj({ ansibleCore: str, collections: textMap }),
    },
    'An execution environment of a workspace: an image built from a spec, or one registered',
  ),
  Workspace: obj(
    { id: str, key: str, name: str, projects: int, selfApprove: bool },
    {
      operatorsDebug: { ...bool, description: 'AFS-179: operators may start debug runs' },
      description: str,
      level: {
        description: 'Read by its id: your own access level on it (admin: an administrator)',
        oneOf: [of('ro', 'operator', 'rw', 'admin'), { type: 'null' }],
      },
    },
    'A workspace: projects, credentials and access of one team',
  ),
  Project: obj(
    {
      id: str,
      workspace: str,
      key: str,
      name: str,
      hosted: bool,
      gitPath: str,
      gitRef: str,
      sync: obj({ state: of('never', 'ok', 'error') }, { at: time, error: str }),
      pollSeconds: int,
      hook: bool,
      hookSigned: bool,
      library: bool,
    },
    { gitUrl: str, gitCredential: str, commit: str, description: str },
    'A project: a git repository of flows',
  ),
  TokenInfo: BASES.TokenInfo,
  NewToken: withFields(
    'TokenInfo',
    { token: { ...str, description: 'afs_...: shown once' } },
    'A token just made: the token itself is in this answer only',
  ),
  Run: obj(
    {
      id: str,
      number: { ...int, description: "Counts the project's runs: 1, 2, 3..." },
      project: str,
      commit: str,
      flow: obj({ file: str, key: str, name: str, version: int }),
      mode,
      inputs: { ...values, description: 'The inputs, secret-looking values as ***' },
      targets: strings,
      credentials: strings,
      state: runState,
      requestedBy: person,
      createdAt: time,
      attempts: int,
      cancelRequested: bool,
    },
    {
      config: obj({ id: str, name: str }),
      ref: str,
      inventory: str,
      eeImage: str,
      limit: str,
      claimedAt: time,
      startedAt: time,
      endedAt: time,
      cancelledBy: str,
      worker: str,
      error: str,
      hosts: obj({ total: int, failed: int }, { unreachable: int }),
      dev: { const: true },
      schedule: str,
      action: str,
      decidedAgainst: of('rejected', 'timed out'),
      credentialNames: strings,
      environment: obj({ id: str, name: str, workspace: str }),
      skippedTargets: strings,
      serverDefault: { const: true },
      step: obj(
        { every: bool, points: { type: 'array' }, timeoutS: int },
        {
          pointsBy: str,
          debug: bool,
          pauseOnFailure: bool,
          failures: obj({}, { failed: bool, unreachable: bool }),
        },
      ),
      relaunchOf: obj(
        {
          id: str,
          number: int,
          hosts: of('all', 'not-ok', 'failed', 'unreachable', 'stopped', 'chosen'),
        },
        { count: int },
      ),
      hostLimit: obj({ count: int, hosts: strings }),
      pausedBefore: str,
      sent: {
        ...of('step', 'continue', 'pause', 'stop', 'retry'),
        description: 'The command just sent',
      },
    },
    'A run of a flow',
  ),
  Gate: obj(
    {
      id: str,
      run: str,
      node: obj({ id: str, key: str, title: str }),
      segment: str,
      status: of('waiting', 'approved', 'rejected', 'timed out', 'cancelled'),
      approvers: strings,
      notify: strings,
      createdAt: time,
    },
    {
      deadline: time,
      message: str,
      intent: str,
      decidedBy: str,
      decidedAt: time,
      comment: str,
      hosts: strings,
      decidedByName: str,
      deciders: strings,
      next: obj({}, { approved: str, rejected: str, timeout: str }),
      after: strings,
      evidence: obj(
        {},
        {
          checkRun: obj({ id: str, number: int, state: str, sameCommit: bool }, { endedAt: time }),
        },
      ),
      mayDecide: bool,
      why: str,
    },
    "An approval of a run: a step where the run waits for someone's decision",
  ),
  // AFS-212: Home's inbox (inbox/inbox.ts).
  Inbox: obj(
    {
      count: {
        ...int,
        description:
          "How many items need you: every item but your runs that wait for someone else's decision",
      },
      items: listOf(
        obj(
          {
            kind: of('approval', 'paused', 'failed', 'draft', 'certificate', 'request'),
            title: str,
            since: time,
            verbs: {
              ...listOf(
                of('review', 'open', 'step', 'continue', 'runAgain', 'openDraft', 'replace'),
              ),
              description:
                "What you may do from here, in the workspace's access; the first is the main one",
            },
          },
          {
            workspace: { ...PLACE, description: 'Absent: about the whole server' },
            project: PLACE,
            run: obj(
              {
                id: str,
                number: int,
                flow: obj({ file: str, name: str }),
                mode: of('check', 'real'),
              },
              {
                config: str,
                debug: bool,
                asRunner: {
                  ...bool,
                  description:
                    "You reach it only as an action's runner: it opens as the action's progress",
                },
              },
            ),
            approval: obj({ gate: str, step: str, requestedBy: str }, { deciders: strings }),
            pause: obj({ before: str }, { stopsAt: time }),
            failure: obj({}, { error: str, hosts: obj({ total: int, failed: int }), lost: bool }),
            draft: obj({ id: str, file: str, flow: str, others: strings, behind: bool }),
            certificate: obj({ notAfter: time, daysLeft: int, names: strings }),
          },
        ),
      ),
      today: obj(
        Object.fromEntries(
          [
            'runs',
            'real',
            'check',
            'succeeded',
            'failed',
            'rejected',
            'cancelled',
            'going',
            'waiting',
            'paused',
            'pausedDebug',
          ].map((k) => [k, int]),
        ),
      ),
      week: obj({ ended: int, succeeded: int }),
      runners: obj({ busy: int, slots: int, queued: int }),
    },
    {},
    "What needs you now, across the workspaces you may see, and the day's numbers",
  ),
  WaitingApproval: obj(
    {
      run: obj(
        {
          id: str,
          number: int,
          project: str,
          flow: obj({ file: str, name: str }),
        },
        {
          projectName: str,
          workspaceName: str,
          workspace: obj({ key: str, name: str }),
          mode,
          inputs: values,
        },
      ),
      requestedBy: str,
      gate: ref('Gate'),
      mayDecide: bool,
    },
    { requestedByName: str, why: str },
    'An approval as the inbox lists it',
  ),
  FlowSummary: obj(
    { file: str, ok: bool, errors: int, warnings: int },
    {
      problem: str,
      key: str,
      name: str,
      version: int,
      format: int,
      steps: int,
      lastRun,
    },
    'A flow file of a project: what it is, and whether it can run',
  ),
  FlowList: obj(
    { flows: listOf(ref('FlowSummary')) },
    { commit: str, more: bool },
    "A project's flows at a commit",
  ),
  LaunchConfig: obj(
    {
      id: str,
      project: str,
      name: str,
      flowFile: str,
      mode,
      inputs: { ...values, description: 'Values the inputs start with; never a secret' },
      credentials: strings,
      createdAt: time,
      updatedAt: time,
    },
    {
      description: str,
      gitRef: str,
      commit: str,
      inventory: str,
      eeImage: str,
      environment: str,
      limit: str,
      notify: obj({ when: of('failed', 'ended'), to: strings }),
      lastRun,
      credentialNames: strings,
      environmentInfo: obj({ name: str }, { image: str, why: str }),
      flowGone: str,
    },
    'A launch configuration: a flow of a project with what its runs start with',
  ),
  LaunchForm: obj(
    {
      commit: str,
      flow: obj({ file: str, key: str, name: str, version: int }),
      mode,
      fields: listOf(
        obj(
          { name: str, required: bool, secret: bool, text: str },
          { type: str, targets: bool, description: str },
        ),
      ),
    },
    {
      ref: str,
      inventory: str,
      eeImage: str,
      limit: str,
      origins: textMap,
      steps: strings,
      approvals: listOf(obj({ title: str, approvers: strings })),
    },
    'What a launch would run, as a form: the inputs with the values they start with',
  ),
  Schedule: obj(
    {
      id: str,
      config: str,
      name: str,
      kind: of('cron', 'once'),
      timezone: str,
      enabled: bool,
      inputs: textMap,
      missed: of('once', 'skip'),
      overlap: of('skip', 'queue'),
      owner: person,
      upcoming: listOf(time),
      createdBy: str,
      createdAt: time,
      updatedAt: time,
    },
    {
      cron: str,
      onceAt: time,
      offWhy: str,
      mode,
      commit: str,
      next: time,
      last: obj(
        { at: time, result: of('ok', 'skipped', 'refused', 'failed') },
        {
          detail: str,
          errors: listOf(flowError),
          run: str,
          runNumber: int,
          runState: str,
        },
      ),
    },
    'A schedule of a launch configuration',
  ),
  Action: obj(
    {
      id: str,
      title: str,
      summary: str,
      asked: listOf(
        obj(
          { name: str, label: str },
          { help: str, choices: strings, group: str, start: str, max: int },
        ),
      ),
      mode,
      confirm: bool,
      enabled: bool,
      updatedAt: time,
    },
    {
      runOnOpen: bool,
      reply: {
        oneOf: [
          { type: 'null' },
          obj({ system: of('netbox', 'zabbix'), credential: str, when: of('ended', 'failed') }),
        ],
      },
      owner: obj({ login: str, name: str }),
    },
    'An action: a launch configuration offered in plain words to the people who may run it',
  ),
  ActionCard: obj(
    {
      id: str,
      title: str,
      summary: str,
      mode,
      workspace: obj({ key: str, name: str }),
    },
    {
      lastRun: obj(
        { id: str, number: int, state: str, createdAt: time, words: str },
        { endedAt: time },
      ),
      off: str,
    },
    'An action on the Actions page',
  ),
  ActionForm: obj(
    {
      id: str,
      title: str,
      summary: str,
      mode,
      confirm: bool,
      fields: listOf(
        obj(
          { name: str, label: str, required: bool, text: str },
          { help: str, type: str, choices: strings, hosts: bool, group: str, max: int },
        ),
      ),
      happens: strings,
      ask: strings,
    },
    {
      blocked: str,
      configPage: str,
      editPage: str,
      runOnOpen: bool,
      replies: of('netbox', 'zabbix'),
    },
    "An action's form: the inputs it asks, and what will happen",
  ),
  ActionGrant: obj(
    {
      id: str,
      config: str,
      principal: obj({ type: of('user', 'group'), id: str, name: str }),
      createdAt: time,
      createdBy: str,
    },
    {
      action: obj(
        { title: str, config: str, project: str, projectKey: str },
        { workspaceKey: str },
      ),
    },
    'Someone who may run an action: a person or a group',
  ),
  ActionToken: BASES.ActionToken,
  ActionProgress: obj(
    {
      action: obj({ id: str, title: str }),
      run: obj(
        {
          id: str,
          number: int,
          state: str,
          createdAt: time,
          words: str,
          mode,
          startedBy: str,
        },
        { endedAt: time, startedAt: time },
      ),
      headline: str,
      steps: listOf(
        obj({
          id: str,
          title: str,
          state: of('done', 'running', 'waiting', 'failed', 'not run', 'to do'),
        }),
      ),
      done: int,
      total: int,
      ask: strings,
      inputs: listOf(obj({ label: str, value: str })),
    },
    {
      waiting: obj({ step: str, by: strings, since: time }),
      failed: str,
      runPage: str,
      again: str,
    },
    'How a run of an action goes, in words',
  ),
} satisfies Record<string, JsonSchema>;

export type SchemaName = keyof typeof SCHEMAS;

// Answers of one route each, kept here with the resources they are made of.
export const ANSWERS = {
  hostOutput: obj({ entries: listOf(open(obj({}))) }, {}, "One host's output in one step"),
  hostSteps: obj(
    { steps: listOf(obj({ node: str, step: str, entries: listOf(open(obj({}))) })) },
    {},
    "One host's results, step by step",
  ),
  runView: open(obj({}, {}, "The run as the canvas shows it (the designer's run view)")),
  watches: obj({ exprs: listOf(str) }, {}, "Your watch expressions on a flow (the web debugger's)"),
  pausePoints: obj(
    {
      points: {
        type: 'array',
        items: {
          anyOf: [
            str,
            obj({ node: str }, { condition: str, hits: int, log: str }, 'A point with settings'),
          ],
        },
      },
    },
    {
      every: bool,
      failures: obj({}, { failed: bool, unreachable: bool }, 'Which failures pause a debug run'),
    },
    "A flow's pause points: node ids, or (debug runs) points with a condition, a hit count or a log message",
  ),
  // AFS-179: a paused debug run's answer (ADR-0040 section 2): open, as the engine writes it.
  inspect: open(
    obj(
      {},
      {
        ms: int,
        error: str,
        refused: bool,
        timeout: bool,
        host: str,
        scopes: listOf(open(obj({ id: str, name: str }, { expensive: bool }))),
        children: listOf(open(obj({ name: anything, type: str }))),
        total: int,
        more: bool,
        value: anything,
        masked: of('vault', 'no_log', 'credential', 'external', 'name'),
        results: listOf(open(obj({ host: str, expr: str }))),
      },
      "A paused debug run's answer: scopes, variables, an evaluate's or watch's result, masked by the run (masked values say why, never their size)",
    ),
  ),
  debugKept: obj(
    {
      pauses: listOf(
        obj(
          {
            pause: str,
            node: str,
            entries: listOf(
              obj(
                { op: of('scopes', 'watch', 'vars'), answer: open(obj({})), at: time },
                { host: str, exprs: strings, scope: of('inputs', 'host', 'flow', 'facts') },
              ),
            ),
          },
          { play: str },
        ),
      ),
    },
    {},
    "What a debug run's pauses showed (scopes, scopes opened and watches, masked), kept with the run",
  ),
  launchCheck: obj(
    {
      launch: open(obj({ commit: str, flow: anything, mode, inputs: values, targets: strings })),
      form: ref('LaunchForm'),
    },
    {},
    'What a launch would run; nothing runs',
  ),
  facts: obj(
    { environment: str, commit: str },
    {
      facts: values,
      factsError: str,
      groups: strings,
      groupHosts: {
        type: 'object',
        additionalProperties: obj({ count: int, hosts: strings }),
      },
      limited: obj({ pattern: str, hosts: strings, count: int }),
      inventory: str,
      field: str,
      groupsError: str,
    },
    'The hosts a launch would touch, read from its inventory',
  ),
  environmentCheck: open(obj({}, {}, "Whether the configuration's image has what the flow needs")),
  scheduleTimes: obj(
    { times: listOf(time) },
    { problems: listOf(obj({ message: str }, { field: str })) },
    'The next times a schedule would fire; with check=1, also what is wrong with the cron or zone',
  ),
  actionLink: obj(
    {
      form: ref('ActionForm'),
      values: textMap,
      given: strings,
      missing: strings,
      problems: listOf(obj({ field: str, message: str })),
      ready: bool,
    },
    {
      refused: str,
      reply: str,
      replyNote: str,
      counts: { type: 'object', additionalProperties: int },
    },
    'What a link to an action gives',
  ),
  actionHosts: obj(
    { hosts: strings, groups: strings },
    {
      dynamic: bool,
      inGroup: { type: 'object', additionalProperties: strings },
      sizes: { type: 'object', additionalProperties: int },
      why: str,
    },
    'The inventory names a host list of an action offers',
  ),
  actionRunStarted: obj(
    {
      id: str,
      number: int,
      state: str,
      progress: { ...str, description: "The run's progress page" },
    },
    {},
    'The run the action started',
  ),
  newActionToken: withFields(
    'ActionToken',
    { token: str },
    "A signed link's token just made: the token itself is in this answer only",
  ),
  actionSettings: obj(
    { action: { oneOf: [{ type: 'null' }, ref('Action')] }, mayManage: bool },
    {
      grants: listOf(ref('ActionGrant')),
      people: obj({
        users: listOf(obj({ id: str, login: str, name: str })),
        groups: listOf(obj({ id: str, name: str })),
      }),
      tokens: listOf(ref('ActionToken')),
      place: obj({
        workspaceKey: str,
        workspaceName: str,
        projectKey: str,
        configName: str,
        flowFile: str,
      }),
    },
    "A launch configuration's action: none (null) or its settings, and for who may change it, who may run it",
  ),
  workspaceAction: obj({
    config: str,
    title: str,
    enabled: bool,
    configName: str,
    file: str,
    project: str,
    projectKey: str,
    projectName: str,
    grants: listOf(ref('ActionGrant')),
  }),
  flowHistory: listOf(open(obj({}, {}, 'A commit that changed the flow'))),
  flowAtCommit: open(obj({ commit: str }, {}, 'A flow as a commit left it')),
  flowView: open(
    obj({ commit: str, file: str, snapshot: anything }, {}, 'One flow as the designer shows it'),
  ),
  catalog: open(obj({}, {}, "The modules and roles a flow's steps may use")),
  librarySubflows: obj(
    { subflows: listOf(open(obj({}))) },
    {},
    "The library projects' subflows the person may read",
  ),
  librarySubflow: open(obj({})),
} satisfies Record<string, JsonSchema>;
