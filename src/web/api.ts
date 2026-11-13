// The server's API as the pages use it. One place knows about fetch, JSON and what a refusal
// looks like; a page asks for a thing and gets it or an ApiError with words fit to show.
import type { TokenInfo } from '../server/auth/tokens';
import type { User } from '../server/auth/users';
import type { Project, Push, Workspace } from '../server/projects/store';

export type { Project, Push, TokenInfo, User, Workspace };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
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
  );
}

export interface Meta {
  name: string;
  version: string;
  designer?: { version: string };
}
export type NewToken = TokenInfo & { token: string };

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

  tokens: () => call<TokenInfo[]>('GET', '/tokens'),
  addToken: (input: { name: string; expiresInDays?: number; readOnly?: boolean }) =>
    call<NewToken>('POST', '/tokens', input),
  revokeToken: (id: string) => call<void>('DELETE', `/tokens/${id}`),
};
