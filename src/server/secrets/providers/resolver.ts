// Reading the secrets credentials take from providers (AFS-241). One resolver per run (or per
// use of a credential outside a run, such as a git fetch): each provider is signed in to once,
// each reference read once, the values kept in memory for as long as the resolver lives and never
// written anywhere. `close()` gives back what it signed in with: a Vault token from AppRole is
// revoked.
import type { Kysely } from 'kysely';
import { recordAudit } from '../../audit/store';
import type { Schema } from '../../db/schema';
import type { MasterKey } from '../masterKey';
import { type Caller, type Client, type Connection, clientOf } from './clients';
import { SecretReadError } from './http';
import { connectionOf } from './store';
import { PROVIDER_KIND_NAME, refProblem, type SecretRef } from './types';

export interface ResolverLog {
  warn(object: Record<string, unknown>, message: string): void;
}

export interface ResolverOptions {
  /** The server's log: a provider's own text goes there, never to a run's output. */
  log?: ResolverLog;
  /** The run the values are for: each read is audited with it. */
  run?: { id: string; number: number };
  /** Replaces the HTTP call (tests). */
  caller?: Caller;
}

/** The credential a value is read for. */
export interface ReadFor {
  id: string;
  name: string;
  workspace: string;
}

/** The leaves of a JSON secret, so a secret given whole is hidden value by value too. */
export function jsonLeaves(text: string): string[] {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'number') out.push(String(v));
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(parsed);
  return out;
}

export class SecretResolver {
  private readonly clients = new Map<
    string,
    Promise<{ conn: Connection & { id: string; workspaces: string[] }; client: Client }>
  >();
  private readonly cache = new Map<string, Promise<string>>();
  private readonly read: string[] = [];

  constructor(
    private readonly db: Kysely<Schema>,
    private readonly key: MasterKey,
    private readonly options: ResolverOptions = {},
  ) {}

  private clientFor(providerKey: string) {
    let found = this.clients.get(providerKey);
    if (!found) {
      found = connectionOf(this.db, this.key, providerKey).then((conn) => {
        if (!conn)
          throw new SecretReadError(
            'not_allowed',
            `there is no secret provider "${providerKey}" any more`,
          );
        return { conn, client: clientOf(conn, this.options.caller) };
      });
      this.clients.set(providerKey, found);
      found.catch(() => this.clients.delete(providerKey));
    }
    return found;
  }

  /**
   * The value of one secret field of a credential. Throws a SecretReadError whose message names
   * the credential, the provider and what went wrong, never the path.
   */
  async value(credential: ReadFor, field: string, ref: SecretRef): Promise<string> {
    const id = JSON.stringify([ref.provider, ...Object.entries(ref).sort()]);
    let found = this.cache.get(id);
    if (!found) {
      found = this.fetch(credential, field, ref);
      this.cache.set(id, found);
    }
    try {
      return await found;
    } catch (e) {
      // A failed read is not kept: a Test read after a fix tries again.
      this.cache.delete(id);
      throw e;
    }
  }

  private async fetch(credential: ReadFor, field: string, ref: SecretRef): Promise<string> {
    const said = `the credential "${credential.name}" (${field})`;
    let provider: { key: string; name: string; id?: string } = {
      key: ref.provider,
      name: ref.provider,
    };
    try {
      const { conn, client } = await this.clientFor(ref.provider);
      provider = { key: conn.key, name: conn.name, id: conn.id };
      if (!conn.workspaces.includes(credential.workspace))
        throw new SecretReadError(
          'not_allowed',
          `the secret provider "${conn.name}" is not open to this workspace: an administrator allows it in Administration, Secret providers`,
        );
      const problem = refProblem(conn.kind, ref);
      if (problem)
        throw new SecretReadError(
          'not_allowed',
          `its reference to ${PROVIDER_KIND_NAME[conn.kind]} is not complete (${problem})`,
        );
      const value = await client.read(ref);
      if (!value)
        throw new SecretReadError(
          'not_found',
          `${PROVIDER_KIND_NAME[conn.kind]} gave an empty value`,
        );
      this.read.push(value);
      await this.audit(credential, provider, 'ok');
      return value;
    } catch (e) {
      const err =
        e instanceof SecretReadError
          ? e
          : new SecretReadError(
              'unreachable',
              'the secret provider could not be asked',
              0,
              String(e),
            );
      this.options.log?.warn(
        {
          ...(this.options.run ? { run: this.options.run.id } : {}),
          provider: provider.key,
          credential: credential.name,
          field,
          code: err.code,
          status: err.status,
          // The provider's own words, which may name the path: the server's log only.
          ...(err.detail ? { detail: err.detail } : {}),
        },
        'A secret could not be read from its provider',
      );
      await this.audit(credential, provider, err.code);
      throw new SecretReadError(
        err.code,
        `Cannot read ${said}: ${err.message}`,
        err.status,
        err.detail,
      );
    }
  }

  private async audit(
    credential: ReadFor,
    provider: { key: string; name: string; id?: string },
    outcome: string,
  ): Promise<void> {
    const run = this.options.run;
    if (!run) return;
    // One record per read: the run, the credential, the provider and how it went; no path.
    await recordAudit(this.db, {
      actor: null,
      source: 'server',
      action: 'secret-provider.read',
      object: {
        type: 'secret-provider',
        ...(provider.id ? { id: provider.id } : {}),
        name: provider.name,
      },
      result: outcome === 'ok' ? 'ok' : 'failed',
      detail: { run: run.id, runNumber: run.number, credential: credential.name, outcome },
    }).catch(() => undefined);
  }

  /** Every value read, and the leaves of the JSON ones: what the run hides from its output. */
  hidden(): string[] {
    const out = new Set<string>();
    for (const v of this.read) {
      out.add(v);
      for (const leaf of jsonLeaves(v)) out.add(leaf);
    }
    return [...out].filter((v) => v.length >= 4);
  }

  /** Whether anything was read. */
  get used(): boolean {
    return this.read.length > 0;
  }

  /** Gives back what the providers were signed in with (Vault tokens are revoked). */
  async close(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    this.cache.clear();
    await Promise.allSettled(
      all.map(async (p) => {
        const { client } = await p;
        await client.close();
      }),
    );
  }
}
