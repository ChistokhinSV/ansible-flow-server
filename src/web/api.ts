// The server's API as the pages use it. One place knows about fetch, JSON and what a refusal
// looks like; a page asks for a thing and gets it or an ApiError with words fit to show.

import type { RunView } from '@ansible-flow/core/protocol';
import type { OutputEntry } from '@ansible-flow/core/run/events';
import type { StepCommand } from '@ansible-flow/core/run/step';
import type {
  Grant,
  GrantLevel,
  GroupGrant,
  Level,
  MyAccess,
  ReachedAction,
  UserReach,
} from '../server/access/types';
import type {
  Action,
  ActionCard,
  ActionField,
  ActionForm,
  ActionGrant,
  ActionHosts,
  ActionLink,
  ActionProgress,
  ActionSettings,
  ActionToken,
  WorkspaceAction,
  WorkspaceActionGrant,
} from '../server/actions/types';
import type { Gate, WaitingApproval } from '../server/approvals/types';
import type { AuditRef } from '../server/audit/refs';
import type { AuditEntry, AuditFilter } from '../server/audit/store';
import type { Directory, DirectoryInput, DirectoryTest } from '../server/auth/ldap/types';
import type {
  Provider,
  ProviderInput,
  ProviderTest,
  SignInMethods,
} from '../server/auth/oidc/types';
import type { TokenInfo } from '../server/auth/tokens';
import type { Group, User } from '../server/auth/users';
import type { ServerDefault } from '../server/environments/serverDefault';
import type {
  Environment,
  EnvironmentBuild,
  EnvironmentInput,
  EnvironmentSpec,
  FlowCheck,
} from '../server/environments/types';
import type { FlowError } from '../server/flowErrors';
import type { LaunchConfig, LaunchConfigInput } from '../server/launch/configs';
import type { FactsReply } from '../server/launch/facts';
import type {
  LaunchForm,
  LaunchRequest,
  PreparedLaunch,
  Problem,
  StepRequest,
} from '../server/launch/prepare';
import type {
  Delivery,
  NotifySettings,
  RunNotify,
  SmtpSecurity,
  SmtpSettings,
} from '../server/notify/types';
import type { Branch } from '../server/projects/branches';
import type { FileChange, FileEntry } from '../server/projects/files';
import type { FlowList, FlowSummary } from '../server/projects/flows';
import type { LibrarySubflow } from '../server/projects/library';
import type { Project, Push, Workspace } from '../server/projects/store';
import type { LastRun } from '../server/runs/cursor';
import type { Run } from '../server/runs/queue';
import type { Schedule, ScheduleInput } from '../server/schedules/types';
import type { SearchHit } from '../server/search/types';
import type { Credential } from '../server/secrets/credentials';
import type { CertificateInfo, CertificateState } from '../server/tls/types';
import { answerWords } from './answer';

/** Where a list of runs goes on after a run: what `before` takes for the next page. */
export { runCursor } from '../server/runs/cursor';
export type {
  Action,
  ActionCard,
  ActionField,
  ActionForm,
  ActionGrant,
  ActionHosts,
  ActionLink,
  ActionProgress,
  ActionSettings,
  ActionToken,
  AuditEntry,
  AuditFilter,
  Branch,
  CertificateInfo,
  CertificateState,
  Credential,
  Delivery,
  Environment,
  EnvironmentBuild,
  EnvironmentInput,
  EnvironmentSpec,
  FileChange,
  FileEntry,
  FlowCheck,
  FlowList,
  FlowSummary,
  Gate,
  Grant,
  GrantLevel,
  Group,
  GroupGrant,
  LastRun,
  LaunchConfig,
  LaunchConfigInput,
  LaunchForm,
  LaunchRequest,
  Level,
  LibrarySubflow,
  MyAccess,
  NotifySettings,
  PreparedLaunch,
  Problem,
  Project,
  Push,
  ReachedAction,
  Run,
  RunNotify,
  Schedule,
  ScheduleInput,
  SearchHit,
  ServerDefault,
  SmtpSecurity,
  SmtpSettings,
  TokenInfo,
  User,
  UserReach,
  WaitingApproval,
  Workspace,
  WorkspaceAction,
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The rest of the refusal: the field it is about, the problems of a launch. */
    readonly details: {
      field?: string;
      problems?: Problem[];
      form?: LaunchForm;
      /** AFS-76: a Save the branch's changes stand in the way of. */
      conflicts?: { id: string; label: string; draft?: string | null; branch?: string | null }[];
      /** AFS-78: the files the branch changed since a change set began. */
      files?: string[];
      /** AFS-164: the errors of a flow that cannot run, with the step each is on. */
      errors?: FlowError[];
    } = {},
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

/** The lists of projects being asked for, by workspace, until they are answered. */
const projectsAsked = new Map<string, Promise<Project[]>>();

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  extra?: Record<string, string>,
): Promise<T> {
  let reply: Response;
  try {
    reply = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      // AFS-58: a file (an archive) goes as it is, typed by its name.
      headers:
        body === undefined
          ? { ...extra }
          : {
              ...extra,
              'content-type':
                body instanceof Blob
                  ? /\.zip$/i.test((body as File).name ?? '')
                    ? 'application/zip'
                    : 'application/gzip'
                  : 'application/json',
            },
      ...(body === undefined ? {} : { body: body instanceof Blob ? body : JSON.stringify(body) }),
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
    data?.message ?? answerWords(reply.status),
    {
      ...(typeof data?.field === 'string' ? { field: data.field } : {}),
      ...(Array.isArray(data?.problems) ? { problems: data.problems } : {}),
      ...(data?.form ? { form: data.form } : {}),
      ...(Array.isArray(data?.conflicts) ? { conflicts: data.conflicts } : {}),
      ...(Array.isArray(data?.files) ? { files: data.files } : {}),
      ...(Array.isArray(data?.errors) ? { errors: data.errors } : {}),
    },
  );
}

/** The part of a flow the pages read: its nodes, with shared subflows' sources (AFS-79). */
export interface FlowNodeLike {
  id: string;
  key: string;
  title: string;
  type?: string;
  ref?: { from: string; version: number; commit?: string };
  subflow?: { nodes?: FlowNodeLike[] };
}
export interface FlowDocLike {
  nodes?: FlowNodeLike[];
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
  /**
   * AFS-206: their grants here are on some flows only (no level on the workspace): the pages show
   * those flows and their runs, nothing else of the project.
   */
  flowOnly?: boolean;
}

/** Who can do what in a workspace, as their grants come out. */
export interface WhoCan {
  user: { id: string; login: string; name: string };
  admin: boolean;
  disabled: boolean;
  service: boolean;
  workspace: Level | null;
  approve: boolean;
  flows: { project: string; projectId: string; file: string; level: Level | null }[];
  /** AFS-206: the actions an action grant lets them run. */
  actions: ReachedAction[];
  through: string[];
}

/** What a list of runs is narrowed to. */
export interface RunsFilter {
  state?: string;
  project?: string;
  flow?: string;
  /** A launch configuration's id: its runs. */
  config?: string;
  /** A login: the runs that person asked for. */
  by?: string;
  /** AFS-147: words in the flow's or configuration's name, a login, or a run's number. */
  q?: string;
  limit?: number;
  /** The next page: `runCursor` of the last run shown (a time, a run's `createdAt`, works too). */
  before?: string;
}

export const api = {
  meta: () => call<Meta>('GET', '/meta'),
  setupNeeded: () => call<{ needed: boolean }>('GET', '/setup'),
  setup: (input: { code: string; login: string; name: string; password: string }) =>
    call<User>('POST', '/setup', input),
  /**
   * Who is signed in; undefined: nobody. AFS-144: asked as optional, so the server answers 204
   * rather than 401 and a signed-out visit logs no error in the browser's console.
   */
  me: () => call<User | undefined>('GET', '/session', undefined, { 'x-afs-session': 'optional' }),
  signIn: (login: string, password: string) => call<User>('POST', '/session', { login, password }),
  signOut: () => call<void>('DELETE', '/session'),
  /** AFS-104: your own password; your other sessions end. */
  changePassword: (current: string, password: string) =>
    call<void>('PUT', '/session/password', { current, password }),
  changeMe: (input: { name?: string; email?: string | null; webhookUrl?: string | null }) =>
    call<User>('PATCH', '/session', input),

  workspaces: () => call<Workspace[]>('GET', '/workspaces'),
  /** AFS-32: with the caller's own level on it. */
  workspace: (key: string) =>
    call<Workspace & { level?: Level | 'admin' | null }>(
      'GET',
      `/workspaces/${encodeURIComponent(key)}`,
    ),
  addWorkspace: (input: { key: string; name: string; description?: string }) =>
    call<Workspace>('POST', '/workspaces', input),
  projects: (workspace: string) => {
    // AFS-195: a page and its breadcrumb ask at the same moment: one request, one answer (and
    // one refusal in the console for a project not shared).
    let asked = projectsAsked.get(workspace);
    if (!asked) {
      asked = call<Project[]>('GET', `/workspaces/${encodeURIComponent(workspace)}/projects`);
      projectsAsked.set(workspace, asked);
      const done = () => projectsAsked.delete(workspace);
      asked.then(done, done);
    }
    return asked;
  },
  /** AFS-171: a repository's address read before a project mirrors it (nothing is kept). */
  checkSource: (workspace: string, input: { gitUrl: string; gitCredential?: string }) =>
    call<{ ok: boolean; message?: string; branches?: string[] }>(
      'POST',
      `/workspaces/${workspace}/projects/check`,
      input,
    ),
  addProject: (
    workspace: string,
    input: {
      key: string;
      name: string;
      gitUrl?: string;
      gitRef?: string;
      gitCredential?: string;
      sample?: string;
    },
  ) => call<Project>('POST', `/workspaces/${encodeURIComponent(workspace)}/projects`, input),
  /** AFS-58: the sample projects a hosted project can start from. */
  samples: () => call<{ key: string; name: string; description: string }[]>('GET', '/samples'),
  /** AFS-58: an empty hosted project's first commit: a sample, or an archive (zip, tar.gz). */
  startProject: (id: string, from: { sample: string } | File) =>
    call<Project>('POST', `/projects/${id}/start`, from),
  /** `gitCredential: null`: the source is read without signing in. */
  changeProject: (
    id: string,
    input: {
      gitCredential?: string | null;
      gitRef?: string;
      gitUrl?: string;
      name?: string;
      description?: string | null;
    },
  ) => call<Project>('PATCH', `/projects/${id}`, input),
  syncProject: (id: string) => call<Project>('POST', `/projects/${id}/sync`),
  /** A push hook for the git host: its token (the secret GitHub signs with) is shown once. */
  makeHook: (id: string) =>
    call<{ token: string; url: string; headers: string[]; signature?: string }>(
      'POST',
      `/projects/${id}/hook`,
    ),
  removeHook: (id: string) => call<void>('DELETE', `/projects/${id}/hook`),
  /** AFS-60: the SSH host key trusted for an ssh source. */
  hostKey: (id: string) =>
    call<{ host?: string; keys: string[] }>('GET', `/projects/${id}/host-key`),
  /** AFS-60: forget it (a change that was expected) and look again, trusting the key found. */
  forgetHostKey: (id: string) => call<Project>('POST', `/projects/${id}/host-key/forget`),
  branches: (id: string) =>
    call<{ branches: string[]; details?: Branch[] }>('GET', `/projects/${id}/branches`),
  /** AFS-59: a branch from a branch or a commit. */
  createBranch: (id: string, input: { name: string; from: string }) =>
    call<{ name: string; commit: string }>('POST', `/projects/${id}/branches`, input),
  /** AFS-59: `force` for a branch with commits that are not on the project's branch. */
  deleteBranch: (id: string, name: string, force = false) =>
    call<{ name: string; commit: string }>(
      'DELETE',
      `/projects/${id}/branches?name=${encodeURIComponent(name)}${force ? '&force=true' : ''}`,
    ),
  pushes: (id: string) => call<Push[]>('GET', `/projects/${id}/pushes?limit=20`),
  /** AFS-78: the files of the project's branch, or of `branch`. */
  files: (id: string, branch?: string) =>
    call<{ branch: string; commit?: string; files: FileEntry[] }>(
      'GET',
      `/projects/${id}/files${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`,
    ),
  /** AFS-78: the commits that changed a file or folder, newest first. */
  fileHistory: (id: string, commit: string, path: string) =>
    call<{ commit: string; author: string; at: string; subject: string }[]>(
      'GET',
      `/projects/${id}/files/history?commit=${commit}&path=${encodeURIComponent(path)}&limit=5`,
    ),
  /**
   * AFS-123: a page of the project's commits (of `branch`, or up to `commit`), newest first; `q`
   * keeps those with its words; `path` a flow's commits. `next`: the `skip` of the next page.
   */
  commits: (
    id: string,
    query: {
      branch?: string;
      commit?: string;
      path?: string;
      q?: string;
      skip?: number;
      limit?: number;
    },
  ) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== '') q.set(k, String(v));
    return call<CommitPage>('GET', `/projects/${id}/commits${q.size ? `?${q}` : ''}`);
  },
  /** AFS-123: one commit with the files it changed. */
  commit: (id: string, commit: string) =>
    call<CommitDetails>('GET', `/projects/${id}/commits/${encodeURIComponent(commit)}`),
  /** AFS-123: what a commit did to a flow, for the flow at that commit. */
  flowAtCommit: (id: string, path: string, commit: string) =>
    call<FlowAtCommit>(
      'GET',
      `/projects/${id}/flows/commit?path=${encodeURIComponent(path)}&commit=${encodeURIComponent(commit)}`,
    ),
  /** AFS-78: one commit with the change set. */
  saveFiles: (
    id: string,
    input: {
      branch: string;
      base?: string;
      message?: string;
      changes: FileChange[];
      /** AFS-210: launch configurations of a moved flow run it from its new file. */
      repoint?: boolean;
    },
  ) =>
    call<{
      branch: string;
      commit: string;
      files: string[];
      unchanged?: boolean;
      repointed?: { id: string; name: string; from: string; to: string }[];
      turnedOff?: { id: string; name: string; why: string }[];
    }>('POST', `/projects/${id}/files`, input),
  flows: (id: string) => call<FlowList>('GET', `/projects/${id}/flows`),
  /** AFS-109: a file's text at a commit (a flow to copy). */
  fileText: async (id: string, path: string, commit: string): Promise<string> => {
    const reply = await fetch(
      `/api/v1/projects/${encodeURIComponent(id)}/files/content?commit=${commit}&path=${encodeURIComponent(path)}`,
      { credentials: 'same-origin' },
    );
    if (!reply.ok) throw new Error(`The file could not be read (${reply.status})`);
    return reply.text();
  },
  /** AFS-76: the project's drafts (flows being edited in the pages). */
  drafts: (id: string) => call<Draft[]>('GET', `/projects/${id}/drafts`),
  /** AFS-76: the flow's draft, started from the project's commit when there is none. */
  openDraft: (id: string, path: string) =>
    call<Draft>('POST', `/projects/${id}/drafts?path=${encodeURIComponent(path)}`),
  /**
   * AFS-149: `choices` keeps a side per clashing place; `answerConflicts` has clashes answered
   * (`conflicts`, nothing saved) rather than refused.
   */
  saveDraft: (
    id: string,
    input: {
      message?: string;
      force?: boolean;
      choices?: Record<string, 'draft' | 'branch'>;
      /** AFS-186: the draft's revision the choices were made at. */
      seen?: number;
      tab?: string;
      answerConflicts?: boolean;
    },
  ) =>
    call<
      | {
          commit: string;
          unchanged?: boolean;
          coAuthors?: string[];
          /** AFS-173: the files a start from a sample added with the flow. */
          added?: string[];
          conflicts?: undefined;
        }
      | {
          saved: false;
          message: string;
          conflicts: { id: string; label: string; draft: string | null; branch: string | null }[];
          /** AFS-186: the draft's revision the places were read at. */
          revision?: number;
          commit?: undefined;
          unchanged?: undefined;
          coAuthors?: undefined;
          added?: undefined;
        }
    >('POST', `/drafts/${id}/save`, input),
  /** AFS-186: `tab`: this page, whose typing is not waited for. */
  discardDraft: (id: string, tab?: string) =>
    call<void>('DELETE', `/drafts/${id}${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`),
  /** AFS-186: a draft discarded a moment ago, back (the flow's draft again, a new id). */
  restoreDraft: (project: string, path: string, draft: string) =>
    call<Draft>('POST', `/projects/${project}/drafts/restore?path=${encodeURIComponent(path)}`, {
      draft,
    }),
  /** AFS-186: what the draft changes against its commit, and who changed each place. */
  draftSummary: (id: string) => call<DraftSummary>('GET', `/drafts/${id}/summary`),
  /** AFS-186: Stop editing: a draft that changes nothing, with nobody else in it, is dropped. */
  leaveDraft: (id: string, tab: string) =>
    call<{ dropped: boolean }>('POST', `/drafts/${id}/leave`, { tab }),
  /** AFS-171: this page opened (or closed) Save: the others in the draft are told. */
  draftSaving: (id: string, tab: string, saving: boolean) =>
    call<unknown>('POST', `/drafts/${id}/here`, { tab, saving }),
  /** AFS-186: this page asks whether to discard the draft (or no longer): the others are told. */
  draftDiscarding: (id: string, tab: string, discarding: boolean) =>
    call<unknown>('POST', `/drafts/${id}/here`, { tab, discarding }),
  /** AFS-79: the draft and its flow as the designer shows it. */
  draft: (id: string) =>
    call<{ draft: Draft; snapshot: { doc?: FlowDocLike } }>('GET', `/drafts/${id}`),
  /** AFS-79: one of the designer's commands, applied to the draft. */
  draftCommand: (id: string, command: Record<string, unknown>) =>
    call<{ created?: string }>('POST', `/drafts/${id}/commands`, { command }),
  /** AFS-126: what an empty flow's draft can start from. */
  draftStartFrom: (id: string) =>
    call<{
      samples: { key: string; name: string; description: string }[];
      playbooks: string[];
      awx: { id: string; name: string; url: string }[];
    }>('GET', `/drafts/${id}/start-from`),
  /** AFS-126: the workflow and job templates of an AWX credential's AWX. */
  draftAwxTemplates: (id: string, credential: string) =>
    call<{
      templates: { kind: 'workflow' | 'job'; id: number; name: string; description?: string }[];
    }>('GET', `/drafts/${id}/start-from/awx?credential=${encodeURIComponent(credential)}`),
  /** AFS-126: the draft's (empty) flow made from a sample, a playbook or an AWX template. */
  draftStart: (
    id: string,
    body:
      | { sample: string }
      | { playbook: string }
      | { awx: { credential: string; kind: 'workflow' | 'job'; id: number } },
  ) =>
    call<{ revision: number; steps: number; notes: string[] }>(
      'POST',
      `/drafts/${id}/start-from`,
      body,
    ),
  /** AFS-79: a flow at the project's commit, as the designer shows it. */
  flowView: (id: string, path: string) =>
    call<{ commit: string; snapshot: { doc?: FlowDocLike } }>(
      'GET',
      `/projects/${id}/flows/view?path=${encodeURIComponent(path)}`,
    ),
  /** AFS-79: the subflows of the server's library you may read. */
  library: () => call<{ subflows: LibrarySubflow[] }>('GET', '/library/subflows'),
  /** AFS-79: one library subflow as it is now, to copy. */
  librarySubflow: (from: string) =>
    call<LibrarySubflow & { node: Record<string, unknown> }>(
      'GET',
      `/library/subflow?from=${encodeURIComponent(from)}`,
    ),
  /** AFS-79: make a project a library, or not (administrators). */
  setLibrary: (id: string, library: boolean) =>
    call<Project>('PATCH', `/projects/${id}`, { library }),
  /** AFS-75: the flows that differ between `from` and the project's commit (or `to`). */
  changes: (id: string, from: string, to?: string) =>
    call<FlowChanges>('GET', `/projects/${id}/changes?from=${from}${to ? `&to=${to}` : ''}`),

  runs: (filter: RunsFilter = {}) =>
    call<Run[]>(
      'GET',
      `/runs?${new URLSearchParams(
        Object.entries(filter).map(([k, v]) => [k, String(v)]),
      ).toString()}`,
    ),
  run: (id: string) => call<Run>('GET', `/runs/${encodeURIComponent(id)}`),
  cancelRun: (id: string) => call<Run>('POST', `/runs/${encodeURIComponent(id)}/cancel`),
  relaunchRun: (id: string) => call<Run>('POST', `/runs/${encodeURIComponent(id)}/relaunch`),
  /** AFS-177: Step, Continue, Pause or Stop for a step-by-step run; or new pause points. */
  stepRun: (id: string, ask: { command?: StepCommand; points?: string[] }) =>
    call<Run>('POST', `/runs/${encodeURIComponent(id)}/step`, ask),
  /** AFS-177: your pause points on a flow, and keeping new ones. */
  pausePoints: (project: string, path: string) =>
    call<{ points: string[] }>(
      'GET',
      `/projects/${encodeURIComponent(project)}/pause-points?path=${encodeURIComponent(path)}`,
    ),
  setPausePoints: (project: string, path: string, points: string[]) =>
    call<{ points: string[] }>(
      'PUT',
      `/projects/${encodeURIComponent(project)}/pause-points?path=${encodeURIComponent(path)}`,
      { points },
    ),
  /** How the run went, as the canvas shows it (its hosts and where they left each step). */
  runView: (id: string) => call<RunView>('GET', `/runs/${encodeURIComponent(id)}/view`),
  /** AFS-170: what one host did in the run, step by step. */
  runHost: (id: string, host: string) =>
    call<{ steps: { node: string; step: string; entries: OutputEntry[] }[] }>(
      'GET',
      `/runs/${encodeURIComponent(id)}/hosts/${encodeURIComponent(host)}`,
    ),

  audit: (filter: AuditFilter) =>
    call<{
      entries: AuditEntry[];
      next?: string;
      refs?: Record<string, AuditRef>;
      people?: Record<string, string>;
    }>('GET', `/audit?${queryOf(filter)}`),

  credentials: (workspace: string) =>
    call<Credential[]>('GET', `/workspaces/${encodeURIComponent(workspace)}/credentials`),
  /** AFS-97: whom a launch configuration can tell (rw on the workspace). */
  recipients: (workspace: string) =>
    call<{ name: string; kind: 'user' | 'group'; label?: string }[]>(
      'GET',
      `/workspaces/${encodeURIComponent(workspace)}/recipients`,
    ),
  addCredential: (
    workspace: string,
    input: {
      name: string;
      kind: string;
      description?: string;
      fields?: Record<string, string>;
      secret: Record<string, string>;
    },
  ) => call<Credential>('POST', `/workspaces/${encodeURIComponent(workspace)}/credentials`, input),
  /** `secret`, when given, replaces the whole secret part; left out, it stays. */
  changeCredential: (
    id: string,
    input: {
      name?: string;
      description?: string | null;
      fields?: Record<string, string>;
      secret?: Record<string, string>;
    },
  ) => call<Credential>('PATCH', `/credentials/${encodeURIComponent(id)}`, input),
  deleteCredential: (id: string) => call<void>('DELETE', `/credentials/${encodeURIComponent(id)}`),

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
  /** AFS-100: administrators delete a project (refused while its runs go) or an empty workspace. */
  deleteProject: (id: string) => call<void>('DELETE', `/projects/${encodeURIComponent(id)}`),
  deleteWorkspace: (id: string) => call<void>('DELETE', `/workspaces/${encodeURIComponent(id)}`),
  launchForm: (id: string, query: { mode?: string; ref?: string; commit?: string } = {}) =>
    call<LaunchForm>('GET', `/launch-configs/${encodeURIComponent(id)}/form?${queryOf(query)}`),
  checkLaunch: (id: string, request: LaunchRequest) =>
    call<{ launch: PreparedLaunch; form: LaunchForm }>(
      'POST',
      `/launch-configs/${encodeURIComponent(id)}/check`,
      request,
    ),
  // AFS-67: the hosts a launch would touch, read from the inventory in its image.
  launchFacts: (id: string, request: LaunchRequest) =>
    call<FactsReply>('POST', `/launch-configs/${encodeURIComponent(id)}/facts`, request),
  // Execution environments (AFS-32).
  environments: (workspace: string) =>
    call<Environment[]>('GET', `/workspaces/${encodeURIComponent(workspace)}/environments`),
  environment: (id: string) => call<Environment>('GET', `/environments/${encodeURIComponent(id)}`),
  addEnvironment: (workspace: string, input: EnvironmentInput) =>
    call<Environment>('POST', `/workspaces/${encodeURIComponent(workspace)}/environments`, input),
  changeEnvironment: (id: string, input: Partial<EnvironmentInput>) =>
    call<Environment>('PATCH', `/environments/${encodeURIComponent(id)}`, input),
  deleteEnvironment: (id: string) =>
    call<void>('DELETE', `/environments/${encodeURIComponent(id)}`),
  environmentBuilds: (id: string) =>
    call<EnvironmentBuild[]>('GET', `/environments/${encodeURIComponent(id)}/builds`),
  buildEnvironment: (id: string) =>
    call<EnvironmentBuild>('POST', `/environments/${encodeURIComponent(id)}/builds`),
  /** A build's log, as text. */
  buildLog: async (id: string, build: string) => {
    const reply = await fetch(
      `/api/v1/environments/${encodeURIComponent(id)}/builds/${encodeURIComponent(build)}/log`,
      { credentials: 'same-origin' },
    );
    return reply.ok ? reply.text() : '';
  },

  /** AFS-69: what the words name, among what the caller may see. */
  search: (q: string) => call<SearchHit[]>('GET', `/search?${queryOf({ q })}`),

  // What a flow needs from its environment (AFS-33).
  /** AFS-163: the server's default image, and the environment picked for it. */
  defaultEnvironment: () => call<ServerDefault>('GET', '/default-environment'),
  setDefaultEnvironment: (environment: string | null) =>
    call<ServerDefault>('PUT', '/default-environment', { environment }),
  galaxySearch: (q: string) =>
    call<{ name: string; version: string; description?: string; requiresAnsible?: string }[]>(
      'GET',
      `/galaxy/search?${queryOf({ q })}`,
    ),
  environmentCheck: (config: string, environment?: string) =>
    call<FlowCheck>(
      'GET',
      `/launch-configs/${encodeURIComponent(config)}/environment-check${environment ? `?${queryOf({ environment })}` : ''}`,
    ),
  environmentForFlow: (config: string, name: string) =>
    call<Environment>('POST', `/launch-configs/${encodeURIComponent(config)}/environment`, {
      name,
    }),

  // Schedules of a launch configuration (AFS-34).
  schedules: (config: string) =>
    call<Schedule[]>('GET', `/launch-configs/${encodeURIComponent(config)}/schedules`),
  addSchedule: (config: string, input: ScheduleInput) =>
    call<Schedule>('POST', `/launch-configs/${encodeURIComponent(config)}/schedules`, input),
  changeSchedule: (
    config: string,
    id: string,
    input: Partial<ScheduleInput> & { owner?: string },
  ) =>
    call<Schedule>(
      'PATCH',
      `/launch-configs/${encodeURIComponent(config)}/schedules/${encodeURIComponent(id)}`,
      input,
    ),
  deleteSchedule: (config: string, id: string) =>
    call<void>(
      'DELETE',
      `/launch-configs/${encodeURIComponent(config)}/schedules/${encodeURIComponent(id)}`,
    ),
  scheduleTimes: (cron: string, timezone: string) =>
    call<{ times: string[]; problems?: { field?: string; message: string }[] }>(
      'GET',
      `/schedule-times?${queryOf({ cron, timezone, check: '1' })}`,
    ),
  launch: (id: string, request: LaunchRequest & { step?: StepRequest }) =>
    call<Run>('POST', `/launch-configs/${encodeURIComponent(id)}/launch`, request),

  // AFS-175: actions, for whoever may run them.
  actions: () => call<ActionCard[]>('GET', '/actions'),
  action: (id: string) => call<ActionForm>('GET', `/actions/${encodeURIComponent(id)}`),
  actionHosts: (id: string) => call<ActionHosts>('GET', `/actions/${encodeURIComponent(id)}/hosts`),
  runAction: (
    id: string,
    inputs: Record<string, string>,
    from?: { link: true; reply?: string | undefined },
  ) =>
    call<{ id: string; number: number; state: string; progress: string }>(
      'POST',
      `/actions/${encodeURIComponent(id)}/run`,
      { inputs, ...(from ? { link: true, ...(from.reply ? { reply: from.reply } : {}) } : {}) },
    ),
  /** AFS-176: what a link to an action gives (its query as the link has it). Nothing runs. */
  actionLink: (id: string, query: string) =>
    call<ActionLink>(
      'GET',
      `/actions/${encodeURIComponent(id)}/link${query.startsWith('?') ? query : query ? `?${query}` : ''}`,
    ),
  actionProgress: (run: string) =>
    call<ActionProgress>('GET', `/actions/runs/${encodeURIComponent(run)}`),
  /** AFS-175: a configuration's action (null: none), and who may run it (for who may change it). */
  configAction: (config: string) =>
    call<{
      action: Action | null;
      grants?: ActionGrant[];
      tokens?: ActionToken[];
      /** AFS-206: whom it may be given to: the workspace's people and groups. */
      people?: {
        users: { id: string; login: string; name: string }[];
        groups: { id: string; name: string }[];
      };
      mayManage: boolean;
    }>('GET', `/launch-configs/${encodeURIComponent(config)}/action`),
  setConfigAction: (config: string, settings: ActionSettings) =>
    call<Action>('PUT', `/launch-configs/${encodeURIComponent(config)}/action`, settings),
  removeConfigAction: (config: string) =>
    call<void>('DELETE', `/launch-configs/${encodeURIComponent(config)}/action`),
  grantAction: (config: string, who: { user: string } | { group: string }) =>
    call<ActionGrant>('POST', `/launch-configs/${encodeURIComponent(config)}/action/grants`, who),
  ungrantAction: (config: string, grant: string) =>
    call<void>(
      'DELETE',
      `/launch-configs/${encodeURIComponent(config)}/action/grants/${encodeURIComponent(grant)}`,
    ),
  /** AFS-176: a signed link for a system with no person: its token, shown this once. */
  createActionToken: (config: string, name: string) =>
    call<ActionToken & { token: string }>(
      'POST',
      `/launch-configs/${encodeURIComponent(config)}/action/tokens`,
      { name },
    ),
  revokeActionToken: (config: string, token: string) =>
    call<void>(
      'DELETE',
      `/launch-configs/${encodeURIComponent(config)}/action/tokens/${encodeURIComponent(token)}`,
    ),
  /** AFS-206: every action of a workspace, with who may run it. */
  workspaceActions: (workspace: string) =>
    call<WorkspaceAction[]>('GET', `/workspaces/${encodeURIComponent(workspace)}/actions`),
  workspaceActionGrants: (workspace: string) =>
    call<WorkspaceActionGrant[]>(
      'GET',
      `/workspaces/${encodeURIComponent(workspace)}/action-grants`,
    ),

  approvals: () => call<WaitingApproval[]>('GET', '/approvals'),
  /** AFS-133: the newest decided approvals this person may see. */
  decidedApprovals: () => call<WaitingApproval[]>('GET', '/approvals?decided=1'),
  runApprovals: (run: string) =>
    call<(Gate & { mayDecide: boolean; why?: string })[]>(
      'GET',
      `/runs/${encodeURIComponent(run)}/approvals`,
    ),
  decide: (run: string, node: string, decision: 'approved' | 'rejected', comment?: string) =>
    call<Gate>('POST', `/runs/${encodeURIComponent(run)}/approvals/${encodeURIComponent(node)}`, {
      decision,
      ...(comment?.trim() ? { comment: comment.trim() } : {}),
    }),
  setSelfApprove: (workspace: string, selfApprove: boolean) =>
    call<Workspace>('PATCH', `/workspaces/${encodeURIComponent(workspace)}`, { selfApprove }),
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
  /** AFS-152: one's own access, workspace by workspace, and who gives access. */
  myAccess: () => call<MyAccess>('GET', '/session/access'),
  /** What one person reaches, workspace by workspace (administrators). */
  userAccess: (id: string) => call<UserReach>('GET', `/users/${encodeURIComponent(id)}/access`),
  /** The grants that name a group, in every workspace (administrators). */
  groupGrants: (id: string) =>
    call<GroupGrant[]>('GET', `/groups/${encodeURIComponent(id)}/grants`),
  users: () => call<User[]>('GET', '/users'),
  groups: () => call<Group[]>('GET', '/groups'),

  // Sign-in with OIDC providers (AFS-30).
  signInMethods: () => call<SignInMethods>('GET', '/auth/methods'),
  oidcProviders: () => call<Provider[]>('GET', '/admin/oidc-providers'),
  addOidcProvider: (input: ProviderInput) => call<Provider>('POST', '/admin/oidc-providers', input),
  changeOidcProvider: (id: string, input: Partial<ProviderInput>) =>
    call<Provider>('PATCH', `/admin/oidc-providers/${encodeURIComponent(id)}`, input),
  deleteOidcProvider: (id: string) =>
    call<void>('DELETE', `/admin/oidc-providers/${encodeURIComponent(id)}`),
  testOidcProvider: (id: string) =>
    call<ProviderTest>('POST', `/admin/oidc-providers/${encodeURIComponent(id)}/test`),
  localSignIn: () => call<{ local: 'all' | 'admins' }>('GET', '/admin/sign-in'),
  setLocalSignIn: (local: 'all' | 'admins') =>
    call<{ local: 'all' | 'admins' }>('PUT', '/admin/sign-in', { local }),

  // LDAP and Active Directory directories (AFS-31).
  directories: () => call<Directory[]>('GET', '/admin/ldap-directories'),
  addDirectory: (input: DirectoryInput) =>
    call<Directory>('POST', '/admin/ldap-directories', input),
  changeDirectory: (id: string, input: Partial<DirectoryInput>) =>
    call<Directory>('PATCH', `/admin/ldap-directories/${encodeURIComponent(id)}`, input),
  deleteDirectory: (id: string) =>
    call<void>('DELETE', `/admin/ldap-directories/${encodeURIComponent(id)}`),
  testDirectory: (id: string, login?: string) =>
    call<DirectoryTest>('POST', `/admin/ldap-directories/${encodeURIComponent(id)}/test`, {
      ...(login ? { login } : {}),
    }),
  syncDirectory: (id: string) =>
    call<{ checked: number; disabled: number; message: string }>(
      'POST',
      `/admin/ldap-directories/${encodeURIComponent(id)}/sync`,
    ),

  // People and groups (administrators, AFS-56).
  user: (id: string) => call<User>('GET', `/users/${encodeURIComponent(id)}`),
  addUser: (input: {
    login: string;
    name?: string;
    password?: string;
    email?: string;
    admin?: boolean;
    service?: boolean;
  }) => call<User>('POST', '/users', input),
  changeUser: (
    id: string,
    input: {
      name?: string;
      email?: string | null;
      webhookUrl?: string | null;
      admin?: boolean;
      disabled?: boolean;
    },
  ) => call<User>('PATCH', `/users/${encodeURIComponent(id)}`, input),
  setUserPassword: (id: string, password: string) =>
    call<void>('PUT', `/users/${encodeURIComponent(id)}/password`, { password }),
  deleteUser: (id: string) => call<void>('DELETE', `/users/${encodeURIComponent(id)}`),
  userTokens: (id: string) => call<TokenInfo[]>('GET', `/users/${encodeURIComponent(id)}/tokens`),
  addUserToken: (
    id: string,
    input: {
      name: string;
      expiresInDays?: number;
      readOnly?: boolean;
      workspace?: string;
      mcpApprovals?: boolean;
      mcpRunControl?: boolean;
    },
  ) => call<NewToken>('POST', `/users/${encodeURIComponent(id)}/tokens`, input),
  revokeUserToken: (id: string, token: string) =>
    call<void>('DELETE', `/users/${encodeURIComponent(id)}/tokens/${encodeURIComponent(token)}`),
  group: (id: string) => call<Group>('GET', `/groups/${encodeURIComponent(id)}`),
  addGroup: (input: { name: string; email?: string; webhookUrl?: string }) =>
    call<Group>('POST', '/groups', input),
  changeGroup: (
    id: string,
    input: { name?: string; email?: string | null; webhookUrl?: string | null },
  ) => call<Group>('PATCH', `/groups/${encodeURIComponent(id)}`, input),
  /** `users`: their ids. */
  setMembers: (id: string, users: string[]) =>
    call<Group>('PUT', `/groups/${encodeURIComponent(id)}/members`, { users }),
  deleteGroup: (id: string) => call<void>('DELETE', `/groups/${encodeURIComponent(id)}`),

  notifySettings: () => call<NotifySettings>('GET', '/notifications/settings'),
  setSmtp: (input: {
    host: string;
    port?: number;
    security: SmtpSecurity;
    user?: string | null;
    password?: string;
    from: string;
  }) => call<NotifySettings>('PUT', '/notifications/smtp', input),
  clearSmtp: () => call<void>('DELETE', '/notifications/smtp'),
  newWebhookKey: async () =>
    (await call<{ key: string }>('POST', '/notifications/webhook-key')).key,
  testNotification: (channel: 'email' | 'webhook', to?: string) =>
    call<Delivery>('POST', '/notifications/test', { channel, ...(to ? { to } : {}) }),
  deliveries: (filter: { status?: string; run?: string } = {}) =>
    call<Delivery[]>('GET', `/notifications?${queryOf(filter)}`),
  retryDelivery: (id: string) =>
    call<void>('POST', `/notifications/${encodeURIComponent(id)}/retry`),

  // The server certificate (administrators, AFS-54).
  certificate: () => call<CertificateState>('GET', '/admin/certificate'),
  certificateHistory: () =>
    call<
      {
        at: string;
        action: string;
        by: string;
        subject?: string;
        fingerprint?: string;
        notAfter?: string;
      }[]
    >('GET', '/admin/certificate/history'),
  certificateRequest: (names: string[], organization?: string) =>
    call<CertificateState>('POST', '/admin/certificate/request', {
      names,
      ...(organization ? { organization } : {}),
    }),
  installCertificate: (certificate: string, key?: string) =>
    call<CertificateState>('POST', '/admin/certificate/install', {
      certificate,
      ...(key ? { key } : {}),
    }),
  /** A PFX (PKCS#12) file, as base64, with its passphrase. */
  installPfx: (pfx: string, passphrase: string) =>
    call<CertificateState>('POST', '/admin/certificate/install', { pfx, passphrase }),
  selfSignedCertificate: () => call<CertificateState>('POST', '/admin/certificate/self-signed', {}),
  rollbackCertificate: () => call<CertificateState>('POST', '/admin/certificate/rollback'),

  tokens: () => call<TokenInfo[]>('GET', '/tokens'),
  addToken: (input: {
    name: string;
    expiresInDays?: number;
    readOnly?: boolean;
    workspace?: string;
    mcpApprovals?: boolean;
    mcpRunControl?: boolean;
  }) => call<NewToken>('POST', '/tokens', input),
  revokeToken: (id: string) => call<void>('DELETE', `/tokens/${id}`),
};

/** AFS-75: what happened to which flows between two commits, and who did it. */
export interface FlowChanges {
  from: string;
  to: string;
  flows: {
    file: string;
    change: 'added' | 'changed' | 'removed';
    authors: string[];
    at?: string;
    commit?: string;
  }[];
}

/** AFS-76: a flow being edited in the pages: who has edited it, and from which commit. */
/** AFS-186: what a draft changes against its commit (a step, a note, or the flow's fields). */
export interface DraftSummary {
  changed: boolean;
  changes: {
    step?: string;
    note?: string;
    kind: 'added' | 'removed' | 'changed';
    fields: string[];
    by: string[];
  }[];
  wires: number;
}

export interface Draft {
  id: string;
  project: string;
  file: string;
  baseCommit: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  editors: { id: string; login: string; name: string }[];
}

/** AFS-123: a commit as the History lists show it. */
export interface CommitSummary {
  commit: string;
  parents: string[];
  author: string;
  at: string;
  subject: string;
  /** In a flow's history: which of its files the commit changed. */
  files?: { file: string; change: 'added' | 'changed' | 'removed' }[];
}
export interface CommitPage {
  branch: string;
  /** The commit the walk started from (the branch's, when the page was read). */
  commit?: string;
  commits: CommitSummary[];
  /** The `skip` of the next page, when there is one. */
  next?: number;
}
export interface CommitDetails extends Omit<CommitSummary, 'files'> {
  body: string;
  files: {
    file: string;
    /** AFS-190: `renamed`: moved from `from` (perhaps changed a little too). */
    change: 'added' | 'changed' | 'removed' | 'renamed';
    from?: string;
    flow?: boolean;
    title?: string;
  }[];
  /** How many more files it changed than are listed. */
  more?: number;
}
export interface FlowAtCommit extends CommitSummary {
  body: string;
  path: string;
  change: 'added' | 'changed' | 'removed' | 'unchanged';
  /** The commit to compare with (the parent), when it had the flow. */
  before?: string;
  /** A removal: the last commit that changed the flow. */
  last?: string;
  /** AFS-190: whether the project's branch has the commit; if not, the branches that do. */
  onBranch?: boolean;
  branches?: string[];
}
