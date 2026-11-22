// AFS-175: actions (ADR-0036). A launch configuration marked as an action, the people and groups
// who may run it, and what a value given for it means (the fill seam AFS-176's links use).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { LaunchField } from '@ansible-flow/core/run/launch';
import type { Kysely } from 'kysely';
import { type Access, atLeast } from '../access/grants';
import type { Schema } from '../db/schema';
import type {
  Action,
  ActionField,
  ActionGrant,
  ActionInput,
  ActionMode,
  ActionReply,
  ActionSettings,
  ActionToken,
  WorkspaceActionGrant,
} from './types';
import { ACTION_SYSTEMS } from './types';

type Db = Kysely<Schema>;
type Row = Schema['launch_action'];

export class ActionError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'taken',
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ActionError';
  }
}

const invalid = (message: string, field?: string) => new ActionError('invalid', message, field);
const now = () => new Date().toISOString();

/** Where an action is: its configuration, flow, project and workspace. */
export interface ActionPlace {
  config: string;
  configName: string;
  project: string;
  projectKey: string;
  file: string;
  workspace: string;
  workspaceKey: string;
  workspaceName: string;
}

async function ownerNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db
    .selectFrom('user_account')
    .select(['id', 'name', 'login'])
    .where('id', 'in', ids)
    .execute();
  return new Map(rows.map((r) => [r.id, r.name || r.login]));
}

function actionOf(row: Row, names: Map<string, string>): Action {
  return {
    id: row.config_id,
    title: row.title,
    summary: row.summary,
    asked: JSON.parse(row.asked_json) as ActionInput[],
    mode: row.mode as ActionMode,
    confirm: row.confirm === 1,
    enabled: row.enabled === 1,
    runOnOpen: row.run_on_open === 1,
    reply: row.reply_json ? (JSON.parse(row.reply_json) as ActionReply) : null,
    ...(row.owner_login
      ? {
          owner: {
            login: row.owner_login,
            name: (row.owner_id && names.get(row.owner_id)) || row.owner_login,
          },
        }
      : {}),
    updatedAt: row.updated_at,
  };
}

export async function getAction(db: Db, config: string): Promise<Action | undefined> {
  const row = await db
    .selectFrom('launch_action')
    .selectAll()
    .where('config_id', '=', config)
    .executeTakeFirst();
  if (!row) return undefined;
  return actionOf(row, await ownerNames(db, row.owner_id ? [row.owner_id] : []));
}

/** Every action that is on, with where it is. */
export async function enabledActions(db: Db): Promise<(Action & { place: ActionPlace })[]> {
  const rows = await db
    .selectFrom('launch_action')
    .innerJoin('launch_config', 'launch_config.id', 'launch_action.config_id')
    .innerJoin('project', 'project.id', 'launch_config.project_id')
    .innerJoin('workspace', 'workspace.id', 'project.workspace_id')
    .selectAll('launch_action')
    .select([
      'launch_config.name as config_name',
      'launch_config.flow_file',
      'project.id as project_id',
      'project.key as project_key',
      'workspace.id as workspace_id',
      'workspace.key as workspace_key',
      'workspace.name as workspace_name',
    ])
    .where('launch_action.enabled', '=', 1)
    .orderBy('launch_action.title')
    .execute();
  const names = await ownerNames(db, [
    ...new Set(rows.map((r) => r.owner_id).filter((id): id is string => !!id)),
  ]);
  return rows.map((row) => ({
    ...actionOf(row, names),
    place: {
      config: row.config_id,
      configName: row.config_name,
      project: row.project_id,
      projectKey: row.project_key,
      file: row.flow_file,
      workspace: row.workspace_id,
      workspaceKey: row.workspace_key,
      workspaceName: row.workspace_name,
    },
  }));
}

/** Where a configuration is, for its action. */
export async function placeOf(db: Db, config: string): Promise<ActionPlace | undefined> {
  const row = await db
    .selectFrom('launch_config')
    .innerJoin('project', 'project.id', 'launch_config.project_id')
    .innerJoin('workspace', 'workspace.id', 'project.workspace_id')
    .select([
      'launch_config.id',
      'launch_config.name',
      'launch_config.flow_file',
      'project.id as project_id',
      'project.key as project_key',
      'workspace.id as workspace_id',
      'workspace.key as workspace_key',
      'workspace.name as workspace_name',
    ])
    .where('launch_config.id', '=', config)
    .executeTakeFirst();
  return row
    ? {
        config: row.id,
        configName: row.name,
        project: row.project_id,
        projectKey: row.project_key,
        file: row.flow_file,
        workspace: row.workspace_id,
        workspaceKey: row.workspace_key,
        workspaceName: row.workspace_name,
      }
    : undefined;
}

const text = (value: unknown, field: string, max: number, min = 1): string => {
  const t = typeof value === 'string' ? value.trim() : '';
  if (t.length < min || t.length > max || /[\0\r\n]/.test(t))
    throw invalid(
      min ? `${field} is one line of 1 to ${max} characters` : `${field} is at most ${max}`,
      field,
    );
  return t;
};

/**
 * An action's settings, checked against its flow's inputs (`fields`, as the launch form has them):
 * only inputs the flow has, never a secret-looking one, labels and choices in plain words.
 */
export function checkSettings(
  input: ActionSettings,
  fields: readonly LaunchField[],
): ActionSettings {
  const title = text(input.title, 'title', 100);
  const summary = text(input.summary, 'summary', 300);
  if (input.mode !== 'check' && input.mode !== 'real')
    throw invalid('An action runs in check or real mode', 'mode');
  if (!Array.isArray(input.asked) || input.asked.length > 20)
    throw invalid('An action asks at most 20 inputs', 'asked');
  const byName = new Map(fields.map((f) => [f.name, f]));
  const seen = new Set<string>();
  const asked: ActionInput[] = input.asked.map((a) => {
    const field = byName.get(a.name);
    if (!field) throw invalid(`The flow has no input ${String(a.name).slice(0, 60)}`, 'asked');
    if (field.secret)
      throw invalid(
        `${a.name} looks like a secret: an action does not ask for it. Use a credential`,
        'asked',
      );
    if (seen.has(a.name)) throw invalid(`${a.name} is asked twice`, 'asked');
    seen.add(a.name);
    const label = text(a.label, `The label of ${a.name}`, 80);
    const help = a.help?.trim() ? text(a.help, `The help of ${a.name}`, 200) : undefined;
    let group: string | undefined;
    if (a.group?.trim()) {
      if (field.type !== 'host_list')
        throw invalid(`${a.name} is not a host list: it takes no inventory group`, 'asked');
      if (a.choices?.length)
        throw invalid(`${a.name} has choices: a group narrows a host list without them`, 'asked');
      group = text(a.group, `The group of ${a.name}`, 200);
      if (/[\s,:]/.test(group)) throw invalid(`The group of ${a.name} is one group name`, 'asked');
    }
    let choices: string[] | undefined;
    if (a.choices?.length) {
      if (field.type === 'dict' || field.type === 'list')
        throw invalid(`${a.name} is a ${field.type}: it takes no list of choices`, 'asked');
      if (a.choices.length > 50) throw invalid(`At most 50 choices for ${a.name}`, 'asked');
      choices = [...new Set(a.choices.map((c) => text(c, `A choice of ${a.name}`, 200)))];
      if (field.type === 'host_list' && choices.some((c) => /[\s,]/.test(c)))
        throw invalid(`A choice of ${a.name} is one host or group name`, 'asked');
    }
    return {
      name: a.name,
      label,
      ...(help ? { help } : {}),
      ...(choices ? { choices } : {}),
      ...(group ? { group } : {}),
    };
  });
  let reply: ActionReply | null = null;
  if (input.reply) {
    if (!ACTION_SYSTEMS.includes(input.reply.system))
      throw invalid('A result goes back to NetBox or Zabbix', 'reply');
    if (input.reply.when !== 'ended' && input.reply.when !== 'failed')
      throw invalid('A result goes back when a run ends, or when it failed', 'reply');
    reply = {
      system: input.reply.system,
      credential: text(input.reply.credential, 'The credential', 64),
      when: input.reply.when,
    };
  }
  return {
    title,
    summary,
    asked,
    mode: input.mode,
    confirm: !!input.confirm,
    enabled: input.enabled !== false,
    runOnOpen: !!input.runOnOpen,
    reply,
  };
}

/** Sets a configuration's action (makes it one, or changes it); who sets it is its owner. */
export async function setAction(
  db: Db,
  config: string,
  settings: ActionSettings,
  by: { id: string; login: string },
): Promise<Action> {
  const at = now();
  const columns = {
    title: settings.title,
    summary: settings.summary,
    asked_json: JSON.stringify(settings.asked),
    mode: settings.mode,
    confirm: settings.confirm ? 1 : 0,
    enabled: settings.enabled ? 1 : 0,
    run_on_open: settings.runOnOpen ? 1 : 0,
    reply_json: settings.reply ? JSON.stringify(settings.reply) : null,
    owner_id: by.id,
    owner_login: by.login,
    updated_at: at,
  };
  const had = await db
    .selectFrom('launch_action')
    .select('config_id')
    .where('config_id', '=', config)
    .executeTakeFirst();
  if (had)
    await db.updateTable('launch_action').set(columns).where('config_id', '=', config).execute();
  else
    await db
      .insertInto('launch_action')
      .values({ config_id: config, ...columns, created_at: at })
      .execute();
  return (await getAction(db, config)) as Action;
}

/** Removes an action and who may run it; the configuration stays. False: it was none. */
export async function removeAction(db: Db, config: string): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    await trx.deleteFrom('action_grant').where('config_id', '=', config).execute();
    // AFS-176: its signed links stop with it.
    await trx.deleteFrom('action_token').where('config_id', '=', config).execute();
    const done = await trx
      .deleteFrom('launch_action')
      .where('config_id', '=', config)
      .executeTakeFirst();
    return Number(done.numDeletedRows) > 0;
  });
}

// --- who may run an action

async function grantRows(db: Db, where: { config?: string; configs?: string[] }) {
  let query = db
    .selectFrom('action_grant')
    .leftJoin('user_account', (j) =>
      j
        .onRef('user_account.id', '=', 'action_grant.principal_id')
        .on('action_grant.principal_type', '=', 'user'),
    )
    .leftJoin('user_group', (j) =>
      j
        .onRef('user_group.id', '=', 'action_grant.principal_id')
        .on('action_grant.principal_type', '=', 'group'),
    )
    .select([
      'action_grant.id',
      'action_grant.config_id',
      'action_grant.principal_type',
      'action_grant.principal_id',
      'action_grant.created_at',
      'action_grant.created_by',
      'user_account.login',
      'user_account.name as person',
      'user_group.name as group_name',
    ])
    .orderBy('action_grant.created_at')
    .orderBy('action_grant.id');
  if (where.config) query = query.where('action_grant.config_id', '=', where.config);
  if (where.configs) {
    if (!where.configs.length) return [];
    query = query.where('action_grant.config_id', 'in', where.configs);
  }
  return query.execute();
}

const grantOf = (r: Awaited<ReturnType<typeof grantRows>>[number]): ActionGrant => ({
  id: r.id,
  config: r.config_id,
  principal: {
    type: r.principal_type as 'user' | 'group',
    id: r.principal_id,
    name: (r.principal_type === 'user' ? r.person || r.login : r.group_name) ?? '(gone)',
  },
  createdAt: r.created_at,
  createdBy: r.created_by,
});

export async function actionGrants(db: Db, config: string): Promise<ActionGrant[]> {
  return (await grantRows(db, { config })).map(grantOf);
}

/** AFS-175: the action grants of a workspace, for its Access tab. */
export async function workspaceActionGrants(
  db: Db,
  workspace: string,
): Promise<WorkspaceActionGrant[]> {
  const actions = await db
    .selectFrom('launch_action')
    .innerJoin('launch_config', 'launch_config.id', 'launch_action.config_id')
    .innerJoin('project', 'project.id', 'launch_config.project_id')
    .select([
      'launch_action.config_id',
      'launch_action.title',
      'project.id as project_id',
      'project.key as project_key',
    ])
    .where('project.workspace_id', '=', workspace)
    .execute();
  const byConfig = new Map(actions.map((a) => [a.config_id, a]));
  return (await grantRows(db, { configs: [...byConfig.keys()] })).flatMap((r) => {
    const a = byConfig.get(r.config_id);
    return a
      ? [
          {
            ...grantOf(r),
            action: {
              title: a.title,
              config: a.config_id,
              project: a.project_id,
              projectKey: a.project_key,
            },
          },
        ]
      : [];
  });
}

/** Gives a user or a group "may run this action". A second for the same one is refused. */
export async function grantAction(
  db: Db,
  config: string,
  input: { user?: string; group?: string },
  by: string,
): Promise<ActionGrant> {
  if (!!input.user === !!input.group)
    throw invalid('A grant is for a user or for a group: name one');
  const principal = input.user
    ? await db
        .selectFrom('user_account')
        .select('id')
        .where((eb) =>
          eb.or([eb('id', '=', input.user as string), eb('login', '=', input.user as string)]),
        )
        .executeTakeFirst()
    : await db
        .selectFrom('user_group')
        .select('id')
        .where((eb) =>
          eb.or([eb('id', '=', input.group as string), eb('name', '=', input.group as string)]),
        )
        .executeTakeFirst();
  if (!principal)
    throw new ActionError(
      'not_found',
      input.user ? `No user ${input.user}` : `No group ${input.group}`,
    );
  const type = input.user ? 'user' : 'group';
  const same = await db
    .selectFrom('action_grant')
    .select('id')
    .where('config_id', '=', config)
    .where('principal_type', '=', type)
    .where('principal_id', '=', principal.id)
    .executeTakeFirst();
  if (same) throw new ActionError('taken', 'They may run this action already');
  const id = randomUUID();
  await db
    .insertInto('action_grant')
    .values({
      id,
      config_id: config,
      principal_type: type,
      principal_id: principal.id,
      created_at: now(),
      created_by: by,
    })
    .execute();
  return (await actionGrants(db, config)).find((g) => g.id === id) as ActionGrant;
}

export async function ungrantAction(db: Db, config: string, id: string): Promise<boolean> {
  const done = await db
    .deleteFrom('action_grant')
    .where('id', '=', id)
    .where('config_id', '=', config)
    .executeTakeFirst();
  return Number(done.numDeletedRows) > 0;
}

/** The configurations whose action this person has a grant on (themself or a group). */
export async function grantedActions(db: Db, user: string): Promise<Set<string>> {
  const groups = await db
    .selectFrom('group_member')
    .select('group_id')
    .where('user_id', '=', user)
    .execute();
  const rows = await db
    .selectFrom('action_grant')
    .select('config_id')
    .where((eb) =>
      eb.or([
        eb.and([eb('principal_type', '=', 'user'), eb('principal_id', '=', user)]),
        ...(groups.length
          ? [
              eb.and([
                eb('principal_type', '=', 'group'),
                eb(
                  'principal_id',
                  'in',
                  groups.map((g) => g.group_id),
                ),
              ]),
            ]
          : []),
      ]),
    )
    .execute();
  return new Set(rows.map((r) => r.config_id));
}

/**
 * Whether a person may run an action: an administrator, operator or more on its flow, or a grant
 * of the action. `granted`: the person's action grants, read once for a list.
 */
export function mayRun(
  access: Access,
  place: Pick<ActionPlace, 'config' | 'workspace' | 'project' | 'file'>,
  granted: ReadonlySet<string>,
): boolean {
  return (
    access.admin ||
    atLeast(access.onFlow(place.workspace, place.project, place.file), 'operator') ||
    granted.has(place.config)
  );
}

const names = (text: string) =>
  text
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);

// --- the fill seam

/**
 * The form's fields of an action: its asked inputs, as the launch form has them (`fields`), in
 * the action's words. An asked input the flow no longer has is left out.
 */
export function actionFields(action: Action, fields: readonly LaunchField[]): ActionField[] {
  const byName = new Map(fields.map((f) => [f.name, f]));
  return action.asked.flatMap((a) => {
    const f = byName.get(a.name);
    if (!f || f.secret) return [];
    return [
      {
        name: a.name,
        label: a.label,
        ...(a.help ? { help: a.help } : {}),
        ...(f.type ? { type: f.type } : {}),
        required: f.required,
        ...(a.choices?.length ? { choices: a.choices } : {}),
        ...(f.type === 'host_list' && !a.choices?.length ? { hosts: true } : {}),
        ...(a.group && f.type === 'host_list' && !a.choices?.length ? { group: a.group } : {}),
        // A start value outside the choices is not offered: the runner picks one.
        text: a.choices?.length
          ? f.type === 'host_list'
            ? names(f.text)
                .filter((n) => a.choices?.includes(n))
                .join(', ')
            : a.choices.includes(f.text.trim())
              ? f.text.trim()
              : ''
          : f.text,
      },
    ];
  });
}

/**
 * AFS-175, for AFS-176 too: values given for an action, by input name (a form's fields, a link's
 * query): only the inputs it asks, and within their choices. The texts of every asked input (the
 * given one, else its start value), and the required ones still empty; or the first value
 * refused, at its name.
 */
export function fillAction(
  fields: readonly ActionField[],
  given: Record<string, string>,
): { texts: Record<string, string>; missing: string[] } | { field: string; error: string } {
  const byName = new Map(fields.map((f) => [f.name, f]));
  for (const name of Object.keys(given))
    if (!byName.has(name))
      return {
        field: name,
        error: `This action does not ask for ${name.slice(0, 60)}: it runs with its own value`,
      };
  const texts: Record<string, string> = {};
  const missing: string[] = [];
  for (const f of fields) {
    const value = (given[f.name] ?? f.text).trim();
    if (value && f.choices?.length) {
      const picked = f.type === 'host_list' ? names(value) : [value];
      const outside = picked.find((p) => !f.choices?.includes(p));
      if (outside !== undefined)
        return {
          field: f.name,
          error: `${f.label}: ${outside.slice(0, 60)} is not one of the choices (${f.choices.slice(0, 5).join(', ')}${f.choices.length > 5 ? ', …' : ''})`,
        };
    }
    if (f.required && !value) missing.push(f.name);
    texts[f.name] = value;
  }
  return { texts, missing };
}

/**
 * AFS-176: the hosts of an inventory group, with those of its child groups: what a host list
 * narrowed to the group offers and takes. Undefined: the inventory has no such group.
 */
export function groupHosts(
  groups: Record<string, { parents: string[]; hosts: string[] }>,
  group: string,
): string[] | undefined {
  if (!groups[group]) return undefined;
  const found = new Set<string>();
  const seen = new Set<string>();
  const walk = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const host of groups[name]?.hosts ?? []) found.add(host);
    for (const [child, g] of Object.entries(groups)) if (g.parents.includes(name)) walk(child);
  };
  walk(group);
  return [...found].sort();
}

/**
 * AFS-176: a host list narrowed to a group takes only that group's hosts (or the group itself).
 * The first name outside it, at its field; undefined when all are in.
 */
export function outsideGroup(
  field: Pick<ActionField, 'name' | 'label' | 'group'>,
  text: string,
  hosts: readonly string[],
): { field: string; message: string } | undefined {
  if (!field.group) return undefined;
  const outside = names(text).find((n) => n !== field.group && !hosts.includes(n));
  return outside === undefined
    ? undefined
    : {
        field: field.name,
        message: `${field.label}: ${outside.slice(0, 60)} is not in ${field.group}`,
      };
}

// --- signed links (AFS-176): a token per action, for systems with no person

/** What every action token starts with: never taken for a person's token (afs_). */
export const ACTION_TOKEN_PREFIX = 'afsl_';
export const ACTION_TOKEN_LIMIT = 20;
const TOUCH_MS = 60_000;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const looksLikeActionToken = (text: string) => /^afsl_[A-Za-z0-9_-]{43}$/.test(text);

type TokenRow = Schema['action_token'];
const tokenOf = (row: TokenRow): ActionToken => ({
  id: row.id,
  name: row.name,
  hint: row.hint,
  createdAt: row.created_at,
  createdBy: row.created_login,
  ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
});

export async function actionTokens(db: Db, config: string): Promise<ActionToken[]> {
  const rows = await db
    .selectFrom('action_token')
    .selectAll()
    .where('config_id', '=', config)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map(tokenOf);
}

/** Makes a signed link's token for an action: resolves with it (this once) and what is kept. */
export async function createActionToken(
  db: Db,
  config: string,
  name: string,
  by: { id: string; login: string },
): Promise<{ token: string; info: ActionToken }> {
  const named = text(name, 'name', 100);
  const count = await db
    .selectFrom('action_token')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('config_id', '=', config)
    .executeTakeFirstOrThrow();
  if (Number(count.n) >= ACTION_TOKEN_LIMIT)
    throw invalid(`An action has at most ${ACTION_TOKEN_LIMIT} signed links: revoke one first`);
  const token = `${ACTION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const row: TokenRow = {
    id: randomUUID(),
    config_id: config,
    name: named,
    token_hash: tokenHash(token),
    hint: token.slice(-4),
    created_by: by.id,
    created_login: by.login,
    created_at: now(),
    last_used_at: null,
  };
  await db.insertInto('action_token').values(row).execute();
  return { token, info: tokenOf(row) };
}

export async function revokeActionToken(db: Db, config: string, id: string): Promise<boolean> {
  const done = await db
    .deleteFrom('action_token')
    .where('id', '=', id)
    .where('config_id', '=', config)
    .executeTakeFirst();
  return Number(done.numDeletedRows) > 0;
}

/**
 * The action token a request carries, when it is one of this action's: its id, name and who
 * made it (the run is theirs). Using it is noted (at most once a minute).
 */
export async function actionTokenOf(
  db: Db,
  config: string,
  token: string,
): Promise<{ id: string; name: string; by: string } | undefined> {
  if (!looksLikeActionToken(token)) return undefined;
  const row = await db
    .selectFrom('action_token')
    .selectAll()
    .where('token_hash', '=', tokenHash(token))
    .executeTakeFirst();
  if (!row || row.config_id !== config) return undefined;
  const at = new Date();
  if (!row.last_used_at || at.getTime() - Date.parse(row.last_used_at) > TOUCH_MS)
    await db
      .updateTable('action_token')
      .set({ last_used_at: at.toISOString() })
      .where('id', '=', row.id)
      .execute();
  return { id: row.id, name: row.name, by: row.created_by };
}

/** AFS-176: notes that a run started from a link tells a system how it ended. */
export async function noteReply(
  db: Db,
  reply: { run: string; config: string; system: string; object: string },
): Promise<void> {
  await db
    .insertInto('action_reply')
    .values({
      run_id: reply.run,
      config_id: reply.config,
      system: reply.system,
      object: reply.object,
      created_at: now(),
    })
    .execute();
}
