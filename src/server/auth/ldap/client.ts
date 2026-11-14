// The directory as the server talks to it (AFS-31): connect (ldaps://, or ldap:// with StartTLS),
// bind, search. One small interface, so the sign-in and the sync are tested with a directory the
// test plays; the real one is ldapts. Certificates are checked against the system's authorities
// and AFS_CA_FILE (set as Node's default authorities at start).
import { Client, EqualityFilter, InvalidCredentialsError } from 'ldapts';

export interface DirectoryEntry {
  dn: string;
  /** Each attribute's values as text (a binary id as hex). */
  attrs: Record<string, string[]>;
}

export interface DirectoryConnection {
  /** Rejects with BadCredentials when the DN or the password is wrong. */
  bind(dn: string, password: string): Promise<void>;
  search(
    base: string,
    filter: string,
    attributes: string[],
    options?: { scope?: 'base' | 'sub'; binary?: string[]; limit?: number },
  ): Promise<DirectoryEntry[]>;
  close(): Promise<void>;
}

export type Connect = (where: { url: string; startTls: boolean }) => Promise<DirectoryConnection>;

export class BadCredentials extends Error {}

/** A value in a search filter (RFC 4515): the characters that mean something, escaped. */
export function escapeFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** A filter for an id: a binary one (objectGUID, kept as hex) byte by byte. */
export function idFilter(attr: string, id: string, binary: boolean): string {
  const value = binary ? (id.match(/../g) ?? []).map((b) => `\\${b}`).join('') : escapeFilter(id);
  return `(${attr}=${value})`;
}

/** Attributes that come as bytes. */
export const BINARY = new Set(['objectguid', 'objectsid']);

/**
 * An id filter on a binary attribute as ldapts must send it: its string filters turn each escaped
 * byte above 0x7f into a character and send that as UTF-8, so `(objectGUID=\b3...)` would never
 * match. Anything else stays the string it was.
 */
export function binaryEquality(filter: string, binary: string[]): string | EqualityFilter {
  const m = /^\(([A-Za-z][\w-]*)=((?:\\[0-9a-fA-F]{2})+)\)$/.exec(filter);
  if (!m || !binary.some((b) => b.toLowerCase() === m[1]?.toLowerCase())) return filter;
  return new EqualityFilter({
    attribute: m[1] as string,
    value: Buffer.from((m[2] as string).replaceAll('\\', ''), 'hex'),
  });
}

const TIMEOUT_MS = 15_000;

export const ldapConnect: Connect = async ({ url, startTls }) => {
  const client = new Client({ url, timeout: TIMEOUT_MS, connectTimeout: TIMEOUT_MS });
  if (startTls) await client.startTLS({});
  return {
    async bind(dn, password) {
      try {
        await client.bind(dn, password);
      } catch (e) {
        if (e instanceof InvalidCredentialsError) throw new BadCredentials('Wrong DN or password');
        throw e;
      }
    },
    async search(base, filter, attributes, options = {}) {
      const binary = options.binary ?? [];
      const { searchEntries } = await client.search(base, {
        scope: options.scope ?? 'sub',
        filter: binaryEquality(filter, binary),
        attributes,
        explicitBufferAttributes: binary,
        sizeLimit: options.limit ?? 0,
        paged: options.limit ? false : { pageSize: 500 },
      });
      return searchEntries.map((e) => {
        const attrs: Record<string, string[]> = {};
        for (const [name, raw] of Object.entries(e)) {
          if (name === 'dn') continue;
          const values = Array.isArray(raw) ? raw : [raw];
          attrs[name.toLowerCase()] = values.map((v) =>
            Buffer.isBuffer(v) ? v.toString('hex') : String(v),
          );
        }
        return { dn: e.dn, attrs };
      });
    },
    async close() {
      await client.unbind().catch(() => undefined);
    },
  };
};
