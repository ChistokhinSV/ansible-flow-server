// The collection server (AFS-32, AFS-33): Galaxy, or an Automation Hub or private Galaxy named by
// AFS_GALAXY_URL. Asked for a collection's versions, to settle `latest` and ranges into a lock.
// Only GET requests, with a time limit; nothing is sent but the collection's name.
import { satisfies } from '@ansible-flow/core/lens/requirements';

export const DEFAULT_GALAXY = 'https://galaxy.ansible.com';
const NAME = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const EXACT = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

export class GalaxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GalaxyError';
  }
}

/** A collection as a search finds it (AFS-33). */
export interface FoundCollection {
  name: string;
  /** Its newest version. */
  version: string;
  description?: string;
  /** The ansible-core it says it needs. */
  requiresAnsible?: string;
}

export interface Galaxy {
  /** Every published version, newest first. */
  versions(name: string): Promise<string[]>;
  /** Collections whose name or description has the words, newest versions, not deprecated. */
  search?(words: string, limit?: number): Promise<FoundCollection[]>;
}

/** A collection's name as Ansible writes it: `namespace.collection`, lower case. */
export const collectionName = (name: string) => NAME.test(name);
/** A version given exactly, needing no collection server. */
export const exactVersion = (version: string) => EXACT.test(version.replace(/^==/, ''));

export function galaxyClient(base = DEFAULT_GALAXY, timeoutMs = 20_000): Galaxy {
  const root = base.replace(/\/+$/, '');
  const get = async (path: string): Promise<unknown> => {
    let reply: Response;
    try {
      reply = await fetch(`${root}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new GalaxyError(`${root} cannot be reached (${(e as Error).message})`);
    }
    if (reply.status === 404) throw new GalaxyError('not found');
    if (!reply.ok) throw new GalaxyError(`${root} answered ${reply.status}`);
    return reply.json();
  };
  return {
    async versions(name) {
      if (!NAME.test(name)) throw new GalaxyError(`"${name}" is not a collection name`);
      const [namespace, collection] = name.split('.');
      const out: string[] = [];
      let path: string | null =
        `/api/v3/plugin/ansible/content/published/collections/index/${namespace}/${collection}/versions/?limit=100`;
      // At most five pages: the newest 500 versions are more than any range needs.
      for (let page = 0; path && page < 5; page++) {
        const body = (await get(path).catch((e: GalaxyError) => {
          throw e.message === 'not found'
            ? new GalaxyError(`${root} has no collection ${name}`)
            : e;
        })) as { data?: { version: string }[]; links?: { next?: string | null } };
        out.push(...(body.data ?? []).map((v) => v.version));
        path = body.links?.next ?? null;
      }
      return out;
    },
    async search(words, limit = 20) {
      const text = words.trim().toLowerCase().slice(0, 100);
      const size = Math.min(Math.max(limit, 1), 50);
      const ask = async (filter: Record<string, string>): Promise<FoundCollection[]> => {
        const q = new URLSearchParams({
          ...filter,
          is_highest: 'true',
          is_deprecated: 'false',
          limit: String(size),
        });
        const body = (await get(`/api/v3/plugin/ansible/search/collection-versions/?${q}`)) as {
          data?: {
            collection_version?: {
              namespace?: string;
              name?: string;
              version?: string;
              description?: string;
              requires_ansible?: string;
            };
          }[];
        };
        return (body.data ?? []).flatMap((d) => {
          const c = d.collection_version;
          if (!c?.namespace || !c.name || !c.version) return [];
          return [
            {
              name: `${c.namespace}.${c.name}`,
              version: c.version,
              ...(c.description ? { description: c.description.slice(0, 300) } : {}),
              ...(c.requires_ansible ? { requiresAnsible: c.requires_ansible } : {}),
            },
          ];
        });
      };
      // Galaxy's keywords are a full-text search over names, descriptions and tags, in no order of
      // match, and a dotted name is one word to it that matches nothing. So a full name is also
      // looked up by namespace and name, a single word also as a collection name, and the results
      // are put in order here.
      const lookups = [ask({ keywords: text.replace(/\./g, ' ') })];
      if (NAME.test(text)) {
        const [namespace = '', name = ''] = text.split('.');
        lookups.push(ask({ namespace, name }));
      } else if (/^[a-z0-9_]+$/.test(text)) lookups.push(ask({ name: text }));
      const settled = await Promise.allSettled(lookups);
      const found = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed && found.length === 0) throw failed.reason;
      return rankCollections(text, found).slice(0, size);
    },
  };
}

/**
 * Found collections, each once, best match first: the name as typed, then a collection or
 * namespace named by one of the words, then names holding every word, then the rest (matched in a
 * description or tags). Within a rank, the collection server's order stays.
 */
export function rankCollections(text: string, found: FoundCollection[]): FoundCollection[] {
  const words = text
    .toLowerCase()
    .split(/[\s.]+/)
    .filter(Boolean);
  const rank = (full: string) => {
    if (full === text.toLowerCase()) return 0;
    const [namespace = '', name = ''] = full.split('.');
    if (words.includes(name)) return 1;
    if (words.includes(namespace)) return 2;
    if (words.length > 0 && words.every((w) => full.includes(w))) return 3;
    return 4;
  };
  const seen = new Set<string>();
  const unique = found.filter((c) => !seen.has(c.name) && Boolean(seen.add(c.name)));
  return unique
    .map((c, i) => ({ c, i, r: rank(c.name) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

/** Stable releases only, unless asked for one that is not. */
const stable = (v: string) => !/-/.test(v);

/**
 * The exact version a wish settles to: as given when exact, else the newest stable version that
 * satisfies it (`latest`: the newest stable). Asks the collection server only when it has to.
 */
export async function resolveVersion(galaxy: Galaxy, name: string, want: string): Promise<string> {
  const wish = want.trim() || 'latest';
  if (exactVersion(wish)) return wish.replace(/^==/, '');
  let all: string[];
  try {
    all = await galaxy.versions(name);
  } catch (e) {
    throw new GalaxyError(
      `${name} ${wish}: ${(e as Error).message}. Pin an exact version, or set AFS_GALAXY_URL to a server that can be reached`,
    );
  }
  const found = all.filter(stable).find((v) => wish === 'latest' || satisfies(v, wish));
  if (!found) throw new GalaxyError(`${name}: no published version is ${wish}`);
  return found;
}
