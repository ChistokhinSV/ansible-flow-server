// Signing in with an OIDC provider (AFS-30): the authorization code flow with PKCE, state and
// nonce (openid-client). The person is found by their identity at the provider (its subject), or
// made at their first sign-in; then the provider's groups claim sets the server groups and the
// administrator right it maps to. What was given here by hand is not touched.
import type { Kysely } from 'kysely';
import * as client from 'openid-client';
import type { Schema } from '../../db/schema';
import type { Logger } from '../../log';
import type { MasterKey } from '../../secrets/masterKey';
import { applySource, ExternalError, makeAccount } from '../external';
import { getProvider, type Provider, providerSecret } from './providers';

type Db = Kysely<Schema>;
const LOGIN_MINUTES = 10;
const CONFIG_MS = 10 * 60 * 1000;

export class SignInError extends Error {}

/** Where the provider sends the person back. */
export const redirectUri = (base: string, key: string) =>
  `${base.replace(/\/+$/, '')}/api/v1/auth/oidc/${encodeURIComponent(key)}/callback`;

/** A path of this server to go to after signing in; anything else is the start page. */
export function safeReturn(to: string | undefined): string {
  return to && /^\/(?![/\\])[^\s]*$/.test(to) && !to.startsWith('/api/') ? to : '/';
}

/** The values a groups claim holds, as strings (an array, or one value). */
export function claimValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  return typeof value === 'string' && value ? [value] : [];
}

export { loginFrom } from '../external';

export class OidcSignIn {
  private readonly configs = new Map<
    string,
    { at: number; stamp: string; config: client.Configuration }
  >();

  constructor(private readonly deps: { db: Db; key: MasterKey; log: Logger }) {}

  /** The provider's configuration, found from its issuer and kept ten minutes. */
  async configOf(provider: Provider): Promise<client.Configuration> {
    const kept = this.configs.get(provider.id);
    if (kept && kept.stamp === provider.updatedAt && Date.now() - kept.at < CONFIG_MS)
      return kept.config;
    const secret = await providerSecret(this.deps.db, this.deps.key, provider.id);
    const issuer = new URL(provider.issuer);
    const config = await client.discovery(
      issuer,
      provider.clientId,
      secret ? { client_secret: secret } : undefined,
      secret ? client.ClientSecretPost(secret) : client.None(),
      // http only for a provider on this machine (issuerProblem allows nothing else).
      issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : undefined,
    );
    this.configs.set(provider.id, { at: Date.now(), stamp: provider.updatedAt, config });
    return config;
  }

  /** The address to send the person to; what it must come back with is kept here. */
  async start(providerKey: string, base: string, returnTo: string | undefined): Promise<URL> {
    const provider = await getProvider(this.deps.db, providerKey);
    if (!provider?.enabled) throw new SignInError('No such sign-in provider');
    const config = await this.configOf(provider);
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    await this.deps.db
      .deleteFrom('oidc_login')
      .where('expires_at', '<', new Date().toISOString())
      .execute();
    await this.deps.db
      .insertInto('oidc_login')
      .values({
        state,
        provider_id: provider.id,
        verifier,
        nonce,
        return_to: safeReturn(returnTo),
        expires_at: new Date(Date.now() + LOGIN_MINUTES * 60_000).toISOString(),
      })
      .execute();
    return client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri(base, provider.key),
      scope: provider.scopes,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
  }

  /**
   * The person back from the provider: the code is exchanged, the ID token checked (signature,
   * issuer, audience, nonce), the person found or made. Resolves with who, and where to go.
   */
  async finish(
    providerKey: string,
    base: string,
    query: URLSearchParams,
  ): Promise<{ userId: string; login: string; returnTo: string; provider: Provider }> {
    const provider = await getProvider(this.deps.db, providerKey);
    if (!provider?.enabled) throw new SignInError('No such sign-in provider');
    const state = query.get('state') ?? '';
    const login = await this.deps.db
      .selectFrom('oidc_login')
      .selectAll()
      .where('state', '=', state)
      .where('provider_id', '=', provider.id)
      .executeTakeFirst();
    // Used once, whatever happens next.
    await this.deps.db.deleteFrom('oidc_login').where('state', '=', state).execute();
    if (!login || login.expires_at < new Date().toISOString())
      throw new SignInError('This sign-in has expired or was already used: start again');
    const error = query.get('error');
    if (error)
      throw new SignInError(
        `${provider.name} did not sign you in: ${query.get('error_description') ?? error}`,
      );
    const config = await this.configOf(provider);
    const current = new URL(redirectUri(base, provider.key));
    current.search = query.toString();
    const tokens = await client.authorizationCodeGrant(config, current, {
      pkceCodeVerifier: login.verifier,
      expectedState: login.state,
      expectedNonce: login.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new SignInError(`${provider.name} sent no ID token`);
    let all: Record<string, unknown> = { ...claims };
    // Groups (and a name) may be only in the userinfo answer.
    if (!(provider.groupsClaim in all) && config.serverMetadata().userinfo_endpoint) {
      try {
        const info = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
        all = { ...info, ...all };
      } catch (e) {
        this.deps.log.warn(
          { err: e, provider: provider.key },
          'The userinfo answer could not be read',
        );
      }
    }
    const user = await this.personOf(provider, claims.sub, all);
    return { ...user, returnTo: login.return_to, provider };
  }

  /** Finds or makes the person, then sets what the provider's groups claim says. */
  async personOf(
    provider: Provider,
    subject: string,
    claims: Record<string, unknown>,
  ): Promise<{ userId: string; login: string }> {
    const db = this.deps.db;
    const at = new Date().toISOString();
    const str = (name: string) =>
      typeof claims[name] === 'string' ? (claims[name] as string) : undefined;
    const name = str('name') ?? [str('given_name'), str('family_name')].filter(Boolean).join(' ');
    const email = claims.email_verified === false ? undefined : str('email');
    return db.transaction().execute(async (trx) => {
      const known = await trx
        .selectFrom('user_identity')
        .innerJoin('user_account', 'user_account.id', 'user_identity.user_id')
        .select([
          'user_account.id',
          'user_account.login',
          'user_account.disabled',
          'user_account.service',
        ])
        .where('user_identity.provider_id', '=', provider.id)
        .where('user_identity.subject', '=', subject)
        .executeTakeFirst();
      let userId: string;
      let login: string;
      if (known) {
        if (known.disabled || known.service)
          throw new SignInError('This account is disabled here: ask an administrator');
        userId = known.id;
        login = known.login;
        await trx
          .updateTable('user_identity')
          .set({ last_at: at })
          .where('provider_id', '=', provider.id)
          .where('subject', '=', subject)
          .execute();
        await trx
          .updateTable('user_account')
          .set({
            ...(name ? { name } : {}),
            ...(email ? { email } : {}),
            last_login_at: at,
            updated_at: at,
          })
          .where('id', '=', userId)
          .execute();
      } else {
        // A new person: a login from the claim, made unique; no password (they sign in there).
        try {
          ({ userId, login } = await makeAccount(trx, {
            login: str(provider.loginClaim) ?? str('email') ?? subject,
            ...(name ? { name } : {}),
            ...(email ? { email } : {}),
          }));
        } catch (e) {
          if (e instanceof ExternalError) throw new SignInError(e.message);
          throw e;
        }
        await trx
          .insertInto('user_identity')
          .values({
            provider_id: provider.id,
            subject,
            user_id: userId,
            created_at: at,
            last_at: at,
          })
          .execute();
        this.deps.log.info(
          { login, provider: provider.key },
          'A person signed in for the first time',
        );
      }

      // Groups and the administrator right, as the claim says now.
      const values = new Set(claimValues(claims[provider.groupsClaim]));
      const wantGroups = new Set(
        provider.mappings
          .filter((m) => m.group && values.has(m.value))
          .map((m) => m.group as string),
      );
      const admin = provider.mappings.some((m) => m.admin && values.has(m.value));
      await applySource(trx, userId, provider.id, wantGroups, admin);
      return { userId, login };
    });
  }
}
