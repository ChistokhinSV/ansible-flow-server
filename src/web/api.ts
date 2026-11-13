// The server's API as the pages use it. One place knows about fetch, JSON and what a refusal
// looks like; a page asks for a thing and gets it or an ApiError with words fit to show.
import type { Grant, GrantLevel, Level } from '../server/access/types';
import type { AuditEntry, AuditFilter } from '../server/audit/store';
import type { TokenInfo } from '../server/auth/tokens';
import type { Group, User } from '../server/auth/users';
import type { LaunchConfig, LaunchConfigInput } from '../server/launch/configs';
import type { LaunchForm, LaunchRequest, PreparedLaunch, Problem } from '../server/launch/prepare';
import type { FlowList, FlowSummary } from '../server/projects/flows';
import type { Project, Push, Workspace } from '../server/projects/store';
import type { Run } from '../server/runs/queue';
import type { Credential } from '../server/secrets/credentials';

export type {
  AuditEntry,
  AuditFilter,
  Credential,
  FlowList,
  FlowSummary,
  Grant,
  GrantLevel,
  Group,
  LaunchConfig,
  LaunchConfigInput,
  LaunchForm,
  LaunchRequest,
  Level,
  PreparedLaunch,
  Problem,
  Project,
  Push,
  Run,
  TokenInfo,
  User,
  Workspace,
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The rest of the refusal: the field it is about, the problems of a launch. */
    readonly details: { field?: string; problems?: Problem[]; form?: LaunchForm } = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Called when the server says the session is gone, so the app can show sign-in. */
let onSignedOut: () => void = () => undefined;
export const setSignedOutHandler = (handler: () => void) => {
  onSignedOut = handler;
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let reply: Response;
  try {
    reply = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'unreachable', 'The server does not answer. Check your connection.');
  }
  if (reply.status === 204) return undefined as T;
  const data = await reply.json().catch(() => undefined);
  if (reply.ok) return data as T;
  // A session that ended while the page was open; not the answer to a wrong password.
  if (reply.status === 401 && path !== '/session') onSignedOut();
  throw new ApiError(
    reply.status,
    data?.error ?? 'error',
    data?.message ?? `The server answered ${reply.status}`,
    {
      ...(typeof data?.field === 'string' ? { field: data.field } : {}),
      ...(Array.isArray(data?.problems) ? { problems: data.problems } : {}),
      ...(data?.form ? { form: data.form } : {}),
    },
  );
}

export interface Meta {
  name: string;
  version: string;
  designer?: { version: string };
}
export type NewToken = TokenInfo & { token: string };

/** A filter as the query of an address. */
const queryOf = (filter: object) =>
  new URLSearchParams(
    Object.entries(filter)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();

/** Where the audit log is taken away from, with a filter, as CSV or JSON. */
export const auditExport = (filter: AuditFilter & { format: 'csv' | 'json' }) =>
  `/api/v1/audit/export?${queryOf(filter)}`;

/** What the person asking may do in a project (GET /projects/:id/access). */
export interface ProjectAccess {
  admin: boolean;
  workspace: Level | null;
  approve: boolean;
  flows: Record<string, Level | null>;
}

/** Who can do what in a workspace, as their grants come out. */
export interface WhoCan {
  user: { id: string; login: string; name: string };
  admin: boolean;
  disabled: boolean;
  service: boolean;
  workspace: Level | null;
  approve: boolean;
  flows: { project: string; file: string; level: Level | null }[];
  through: string[];
}

export const api = {
  meta: () => call<Meta>('GET', '/meta'),
  setupNeeded: () => call<{ needed: boolean }>('GET', '/setup'),
  setup: (input: { code: string; login: string; name: string; password: string }) =>
    call<User>('POST', '/setup', input),
  me: () => call<User>('GET', '/session'),
  signIn: (login: string, password: string) => call<User>('POST', '/session', { login, password }),
  signOut: () => call<void>('DELETE', '/session'),

  workspaces: () => call<Workspace[]>('GET', '/workspaces'),
  workspace: (key: string) => call<Workspace>('GET', `/workspaces/${encodeURIComponent(key)}`),
  addWorkspace: (input: { key: string; name: string; description?: string }) =>
    call<Workspace>('POST', '/workspaces', input),
  projects: (workspace: string) =>
    call<Project[]>('GET', `/workspaces/${encodeURIComponent(workspace)}/projects`),
  addProject: (
    workspace: string,
    input: { key: string; name: string; gitUrl?: string; gitRef?: string },
  ) => call<Project>('POST', `/workspaces/${encodeURIComponent(workspace)}/projects`, input),
  syncProject: (id: string) => call<Project>('POST', `/projects/${id}/sync`),
  branches: (id: string) => call<{ branches: string[] }>('GET', `/projects/${id}/branches`),
  pushes: (id: string) => call<Push[]>('GET', `/projects/${id}/pushes?limit=20`),
  flows: (id: string) => call<FlowList>('GET', `/projects/${id}/flows`),

  runs: (filter: { project?: string; state?: string; limit?: number } = {}) =>
    call<Run[]>(
      'GET',
      `/runs?${new URLSearchParams(
        Object.entries(filter).map(([k, v]) => [k, String(v)]),
      ).toString()}`,
    ),
  run: (id: string) => call<Run>('GET', `/runs/${encodeURIComponent(id)}`),
  cancelRun: (id: string) => call<Run>('POST', `/runs/${encodeURIComponent(id)}/cancel`),
  relaunchRun: (id: string) => call<Run>('POST', `/runs/${encodeURIComponent(id)}/relaunch`),

  audit: (filter: AuditFilter) =>
    call<{ entries: AuditEntry[]; next?: string }>('GET', `/audit?${queryOf(filter)}`),

  credentials: (workspace: string) =>
    call<Credential[]>('GET', `/workspaces/${encodeURIComponent(workspace)}/credentials`),

  launchConfigs: (project: string) =>
    call<LaunchConfig[]>('GET', `/projects/${project}/launch-configs`),
  launchConfig: (id: string) =>
    call<LaunchConfig>('GET', `/launch-configs/${encodeURIComponent(id)}`),
  addLaunchConfig: (project: string, input: LaunchConfigInput) =>
    call<LaunchConfig>('POST', `/projects/${project}/launch-configs`, input),
  changeLaunchConfig: (id: string, input: Partial<LaunchConfigInput>) =>
    call<LaunchConfig>('PATCH', `/launch-configs/${encodeURIComponent(id)}`, input),
  deleteLaunchConfig: (id: string) =>
    call<void>('DELETE', `/launch-configs/${encodeURIComponent(id)}`),
  launchForm: (id: string, query: { mode?: string; ref?: string; commit?: string } = {}) =>
    call<LaunchForm>('GET', `/launch-configs/${encodeURIComponent(id)}/form?${queryOf(query)}`),
  checkLaunch: (id: string, request: LaunchRequest) =>
    call<{ launch: PreparedLaunch; form: LaunchForm }>(
      'POST',
      `/launch-configs/${encodeURIComponent(id)}/check`,
      request,
    ),
  launch: (id: string, request: LaunchRequest) =>
    call<Run>('POST', `/launch-configs/${encodeURIComponent(id)}/launch`, request),

  projectAccess: (id: string) => call<ProjectAccess>('GET', `/projects/${id}/access`),
  grants: (workspace: string) =>
    call<Grant[]>('GET', `/workspaces/${encodeURIComponent(workspace)}/grants`),
  addGrant: (
    workspace: string,
    input: { user?: string; group?: string; level: GrantLevel; project?: string; flow?: string },
  ) => call<Grant>('POST', `/workspaces/${encodeURIComponent(workspace)}/grants`, input),
  removeGrant: (id: string) => call<void>('DELETE', `/grants/${encodeURIComponent(id)}`),
  whoCan: (workspace: string) =>
    call<WhoCan[]>('GET', `/workspaces/${encodeURIComponent(workspace)}/access`),
  users: () => call<User[]>('GET', '/users'),
  groups: () => call<Group[]>('GET', '/groups'),

  tokens: () => call<TokenInfo[]>('GET', '/tokens'),
  addToken: (input: {
    name: string;
    expiresInDays?: number;
    readOnly?: boolean;
    workspace?: string;
  }) => call<NewToken>('POST', '/tokens', input),
  revokeToken: (id: string) => call<void>('DELETE', `/tokens/${id}`),
};
