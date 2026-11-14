// OIDC sign-in providers (AFS-30). Types only, so the web application uses them without the
// server.

/** A claim value and what it is here: a server group, or administrator. */
export interface Mapping {
  value: string;
  /** A server group's id; absent: administrator. */
  group?: string;
  admin?: boolean;
}

export interface Provider {
  id: string;
  key: string;
  name: string;
  issuer: string;
  clientId: string;
  /** Whether a client secret is kept (it is never shown). */
  hasSecret: boolean;
  scopes: string;
  groupsClaim: string;
  loginClaim: string;
  enabled: boolean;
  mappings: Mapping[];
  createdAt: string;
  updatedAt: string;
  /** Where the provider sends people back: registered at the provider. */
  redirectUri?: string;
}

export interface ProviderInput {
  key: string;
  name: string;
  issuer: string;
  clientId: string;
  /** A new secret; null: none (a public client); absent on a change: kept. */
  clientSecret?: string | null;
  scopes?: string;
  groupsClaim?: string;
  loginClaim?: string;
  enabled?: boolean;
  mappings?: Mapping[];
}

/** How people may sign in, as the sign-in page asks. */
export interface SignInMethods {
  /** Passwords for everyone, or administrators only. */
  local: 'all' | 'admins';
  providers: { key: string; name: string }[];
}

export interface ProviderTest {
  ok: boolean;
  message?: string;
  issuer?: string;
  authorizationEndpoint?: string;
  userinfo?: boolean;
  pkce?: boolean;
}
