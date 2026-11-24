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
  WorkspaceAction,
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

/**
 * Every action that is on, with where it is; with `withOff`, those switched off too (AFS-260: its
 * runner still finds it on Actions, said to be off).
 */
export async function enabledActions(
  db: Db,
  withOff = false,
): Promise<(Action & { place: ActionPlace })[]> {
  let query = db
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
    .orderBy('launch_action.title');
  if (!withOff) query = query.where('launch_action.enabled', '=', 1);
  const rows = await query.execute();
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
    // AFS-254: said by the label the form shows, not the input's name.
    const help = a.help?.trim() ? text(a.help, `The help of ${label}`, 200) : undefined;
    let group: string | undefined;
    if (a.group?.trim()) {
      if (field.type !== 'host_list')
        throw invalid(`${label} is not a host list: it takes no inventory group`, 'asked');
      if (a.choices?.length)
        throw invalid(`${label} has choices: a group narrows a host list without them`, 'asked');
      group = text(a.group, `The group of ${label}`, 200);
      if (/[\s,:]/.test(group)) throw invalid(`The group of ${label} is one group name`, 'asked');
    }
    let choices: string[] | undefined;
    if (a.choices?.length) {
      if (field.type === 'dict' || field.type === 'list')
        throw invalid(`${label} is a ${field.type}: it takes no list of choices`, 'asked');
      if (a.choices.length > 50) throw invalid(`At most 50 choices for ${label}`, 'asked');
      choices = [...new Set(a.choices.map((c) => text(c, `A choice of ${label}`, 200)))];
      if (field.type === 'host_list' && choices.some((c) => /[\s,]/.test(c)))
        throw invalid(`A choice of ${label} is one host or group name`, 'asked');
    }
    // AFS-207: a host list's own start value and how many hosts it takes.
    let start: string | undefined;
    let max: number | undefined;
    if (a.start?.trim()) {
      if (field.type !== 'host_list')
        throw invalid(
          `${label} is not a host list: it starts with the configuration's value`,
          'asked',
        );
      const picked = names(text(a.start, `The start value of ${label}`, 2000));
      const outside = choices && picked.find((n) => !choices?.includes(n));
      if (outside)
        throw invalid(
          `The start value of ${label}: ${outside.slice(0, 60)} is not one of its choices`,
          'asked',
        );
      start = picked.join(', ');
    }
    if (a.max !== undefined && a.max !== null) {
      if (field.type !== 'host_list')
        throw invalid(`${label} is not a host list: it takes no number of hosts`, 'asked');
      if (!Number.isInteger(a.max) || a.max < 1 || a.max > 1000)
        throw invalid(`The number of hosts of ${label} is a whole number from 1 to 1000`, 'asked');
      max = a.max;
      if (start && names(start).length > max)
        throw invalid(
          `The start value of ${label} names more than ${max === 1 ? 'one host' : `${max} hosts`}`,
          'asked',
        );
    }
    return {
      name: a.name,
      label,
      ...(help ? { help } : {}),
      ...(choices ? { choices } : {}),
      ...(group ? { group } : {}),
      ...(start ? { start } : {}),
      ...(max ? { max } : {}),
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

/**
 * AFS-206: the people and groups who already reach a workspace: a grant there (an access grant on
 * it or on one of its flows, or an action grant on one of its actions), their own or a group's.
 * Someone with rw on the workspace gives actions to these only; an administrator to anyone.
 */
export async function workspacePeople(
  db: Db,
  workspace: string,
): Promise<{
  users: { id: string; login: string; name: string }[];
  groups: { id: string; name: string }[];
}> {
  const access = await db
    .selectFrom('access_grant')
    .select(['principal_type', 'principal_id'])
    .where('workspace_id', '=', workspace)
    .execute();
  const actions = await db
    .selectFrom('action_grant')
    .innerJoin('launch_config', 'launch_config.id', 'action_grant.config_id')
    .innerJoin('project', 'project.id', 'launch_config.project_id')
    .select(['action_grant.principal_type', 'action_grant.principal_id'])
    .where('project.workspace_id', '=', workspace)
    .execute();
  const rows = [...access, ...actions];
  const groupIds = [
    ...new Set(rows.filter((r) => r.principal_type === 'group').map((r) => r.principal_id)),
  ];
  const members = groupIds.length
    ? await db
        .selectFrom('group_member')
        .select('user_id')
        .where('group_id', 'in', groupIds)
        .execute()
    : [];
  const userIds = [
    ...new Set([
      ...rows.filter((r) => r.principal_type === 'user').map((r) => r.principal_id),
      ...members.map((m) => m.user_id),
    ]),
  ];
  const users = userIds.length
    ? await db
        .selectFrom('user_account')
        .select(['id', 'login', 'name'])
        .where('id', 'in', userIds)
        .where('is_admin', '=', 0)
        .orderBy('login')
        .execute()
    : [];
  const groups = groupIds.length
    ? await db
        .selectFrom('user_group')
        .select(['id', 'name'])
        .where('id', 'in', groupIds)
        .orderBy('name')
        .execute()
    : [];
  return { users, groups };
}

/**
 * AFS-206: every action of a workspace, on or off, with who may run it through a grant: one access
 * table lists them all, those nobody was given yet too (operators of the flow and administrators
 * may run every one).
 */
export async function workspaceActions(db: Db, workspace: string): Promise<WorkspaceAction[]> {
  const actions = await db
    .selectFrom('launch_action')
    .innerJoin('launch_config', 'launch_config.id', 'launch_action.config_id')
    .innerJoin('project', 'project.id', 'launch_config.project_id')
    .select([
      'launch_action.config_id',
      'launch_action.title',
      'launch_action.enabled',
      'launch_config.name as config_name',
      'launch_config.flow_file',
      'project.id as project_id',
      'project.key as project_key',
      'project.name as project_name',
    ])
    .where('project.workspace_id', '=', workspace)
    .orderBy('launch_action.title')
    .execute();
  const grants = (await grantRows(db, { configs: actions.map((a) => a.config_id) })).map(grantOf);
  return actions.map((a) => ({
    config: a.config_id,
    title: a.title,
    enabled: a.enabled === 1,
    configName: a.config_name,
    file: a.flow_file,
    project: a.project_id,
    projectKey: a.project_key,
    projectName: a.project_name,
    grants: grants.filter((g) => g.config === a.config_id),
  }));
}

/** AFS-207: the actions a group may run, in every workspace: for the group's page. */
export async function groupActionGrants(db: Db, group: string): Promise<WorkspaceActionGrant[]> {
  const rows = await grantRows(db, {});
  const mine = rows.filter((r) => r.principal_type === 'group' && r.principal_id === group);
  if (!mine.length) return [];
  const actions = await db
    .selectFrom('launch_action')
    .innerJoin('launch_config', 'launch_config.id', 'launch_action.config_id')
    .innerJoin('project', 'project.id', 'launch_config.project_id')
    .innerJoin('workspace', 'workspace.id', 'project.workspace_id')
    .select([
      'launch_action.config_id',
      'launch_action.title',
      'project.id as project_id',
      'project.key as project_key',
      'workspace.key as workspace_key',
    ])
    .where(
      'launch_action.config_id',
      'in',
      mine.map((r) => r.config_id),
    )
    .execute();
  const byConfig = new Map(actions.map((a) => [a.config_id, a]));
  return mine.flatMap((r) => {
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
              workspaceKey: a.workspace_key,
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
  /**
   * AFS-206: for who is not an administrator, the workspace whose people they may name. Anyone
   * else is refused with the answer an unknown name gets, so the grant tells nothing of the
   * server's other logins and groups (which only administrators list).
   */
  among?: string,
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
  const type = input.user ? 'user' : 'group';
  if (among) {
    const people = await workspacePeople(db, among);
    const known = principal
      ? type === 'user'
        ? people.users.some((u) => u.id === principal.id)
        : people.groups.some((g) => g.id === principal.id)
      : false;
    if (!known)
      throw new ActionError(
        'not_found',
        `No ${type === 'user' ? 'person' : 'group'} ${input.user ?? input.group} with access to this workspace: name one who has, or ask an administrator to give it`,
        type,
      );
  }
  if (!principal)
    throw new ActionError(
      'not_found',
      input.user ? `No user ${input.user}` : `No group ${input.group}`,
    );
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
  return action.asked.flatMap((a): ActionField[] => {
    const f = byName.get(a.name);
    if (!f || f.secret) return [];
    // AFS-207: a host list starts with the action's own value, else empty: the configuration's
    // (a whole group, often) would run on all of it with one press of Run. The runner picks.
    if (f.type === 'host_list') {
      const start = names(a.start ?? '').filter((n) => !a.choices?.length || a.choices.includes(n));
      return [
        {
          name: a.name,
          label: a.label,
          ...(a.help ? { help: a.help } : {}),
          type: f.type,
          // Asked hosts are always picked: none would run on whatever the flow defaults to.
          required: true,
          ...(a.choices?.length ? { choices: a.choices } : { hosts: true }),
          ...(a.group && !a.choices?.length ? { group: a.group } : {}),
          ...(a.max ? { max: a.max } : {}),
          text: start.join(', '),
        },
      ];
    }
    return [
      {
        name: a.name,
        label: a.label,
        ...(a.help ? { help: a.help } : {}),
        ...(f.type ? { type: f.type } : {}),
        required: f.required,
        ...(a.choices?.length ? { choices: a.choices } : {}),
        // A start value outside the choices is not offered: the runner picks one.
        text: a.choices?.length ? (a.choices.includes(f.text.trim()) ? f.text.trim() : '') : f.text,
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

/** AFS-207: the inventory a host list is checked against: its hosts and groups. */
export interface InventoryNames {
  hosts: readonly string[];
  groups: Record<string, { parents: string[]; hosts: string[] }>;
  /** Some source finds its hosts when it runs: a name not written in the files may be one. */
  dynamic?: boolean;
  /** Not every file was read. */
  cut?: string;
}

/** Ansible knows these without an inventory. */
const IMPLICIT = new Set(['localhost', '127.0.0.1', '::1']);
/** A host pattern (sw-*, edge:&prod, !core), not a name: what it names is known when it runs. */
const PATTERN = /[*?:!&~[\]]/;

/**
 * AFS-207: the hosts a host list's value names: a group by its hosts (its children's too), "all"
 * by every host. Names the inventory does not have, and patterns, apart.
 */
export function hostsOf(
  text: string,
  inventory: InventoryNames,
): { hosts: string[]; unknown: string[]; patterns: string[] } {
  const hosts = new Set<string>();
  const unknown: string[] = [];
  const patterns: string[] = [];
  for (const n of names(text)) {
    if (n === 'all') for (const h of inventory.hosts) hosts.add(h);
    else if (inventory.groups[n])
      for (const h of groupHosts(inventory.groups, n) ?? []) hosts.add(h);
    else if (inventory.hosts.includes(n) || IMPLICIT.has(n)) hosts.add(n);
    else if (PATTERN.test(n)) patterns.push(n);
    else unknown.push(n);
  }
  return { hosts: [...hosts].sort(), unknown, patterns };
}

const hostWords = (n: number) => (n === 1 ? 'one host' : `${n} hosts`);

/**
 * AFS-207: what is wrong with a host list's value against the inventory: a name it does not have
 * (a static inventory read in full only), more hosts than the action takes (a group counted by
 * its hosts). Undefined when it is right.
 */
export function hostProblem(
  field: Pick<ActionField, 'name' | 'label' | 'max' | 'choices'>,
  text: string,
  inventory: InventoryNames,
): { field: string; message: string } | undefined {
  const got = hostsOf(text, inventory);
  const at = (message: string) => ({ field: field.name, message: `${field.label}: ${message}` });
  const unknown = got.unknown[0];
  // AFS-254: a choice is checked too: the inventory may not have it (or no longer).
  if (!inventory.dynamic && !inventory.cut && unknown !== undefined)
    return at(`${unknown.slice(0, 60)} is not a host or group of the inventory`);
  if (!field.max) return undefined;
  const pattern = got.patterns[0];
  if (pattern !== undefined)
    return at(
      `name ${field.max === 1 ? 'the host' : 'the hosts'}, not a pattern (${pattern.slice(0, 60)})`,
    );
  const count = got.hosts.length + got.unknown.length;
  if (count <= field.max) return undefined;
  // AFS-254: a list of names is said by its count alone; a group by its count and its hosts.
  const all = [...got.hosts, ...got.unknown];
  const listed = names(text).length === count;
  const shown = listed ? '' : all.slice(0, 4).join(', ') + (all.length > 4 ? ', …' : '');
  return at(
    `${text.trim().slice(0, 60)} is ${hostWords(count)}${shown ? ` (${shown})` : ''}: this action takes ${field.max === 1 ? 'one host. Pick one.' : `at most ${field.max} hosts.`}`,
  );
}

/** AFS-207: how many hosts each group of the inventory has (its children's too). */
export function groupSizes(groups: InventoryNames['groups']): Record<string, number> {
  return Object.fromEntries(
    Object.keys(groups)
      .filter((g) => g !== 'all' && g !== 'ungrouped')
      .map((g) => [g, groupHosts(groups, g)?.length ?? 0]),
  );
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
