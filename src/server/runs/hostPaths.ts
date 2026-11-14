// AFS-35: when the server itself runs in a container, the run and probe containers it starts are
// its siblings: the engine mounts paths of its own machine, not of the server's container. A
// folder of the data volume is `/var/lib/afs/work/...` to the server and, say,
// `/var/lib/docker/volumes/afs_data/_data/work/...` to the engine. The server finds its own
// mounts once (docker inspect of itself), or is told where the data folder is on the engine's
// machine (AFS_ENGINE_DATA_DIR), and rewrites the sources of the mounts it asks for.
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';

export interface Mount {
  /** Where it is on the engine's machine. */
  source: string;
  /** Where the server sees it. */
  destination: string;
}

/** A path as the engine's machine sees it; unchanged when no mount holds it. */
export type ToHost = (path: string) => string;

export const sameAs: ToHost = (path) => path;

/** Maps a path under the deepest mount that holds it. */
export function mapperOf(mounts: readonly Mount[]): ToHost {
  const sorted = [...mounts]
    .map((m) => ({ ...m, destination: m.destination.replace(/\/+$/, '') || '/' }))
    .sort((a, b) => b.destination.length - a.destination.length);
  return (path) => {
    for (const m of sorted) {
      if (m.destination === '/') return posix.join(m.source, path);
      if (path === m.destination) return m.source;
      if (path.startsWith(`${m.destination}/`))
        return posix.join(m.source, path.slice(m.destination.length + 1));
    }
    return path;
  };
}

/**
 * The engine's words with every mount's source as the engine's machine sees it: `-v src:dest`,
 * `--volume src:dest[:options]`, `--mount type=bind,source=...`. Only absolute sources (a named
 * volume stays a name).
 */
export function rewriteMounts(args: readonly string[], toHost: ToHost): string[] {
  if (toHost === sameAs) return [...args];
  const out = [...args];
  for (let i = 0; i < out.length - 1; i++) {
    const flag = out[i];
    const value = out[i + 1] as string;
    if (flag === '-v' || flag === '--volume') {
      const at = value.indexOf(':');
      if (value.startsWith('/') && at > 0)
        out[i + 1] = `${toHost(value.slice(0, at))}${value.slice(at)}`;
      i++;
    } else if (flag === '--mount') {
      out[i + 1] = value
        .split(',')
        .map((part) => {
          const m = /^(source|src)=(\/.*)$/.exec(part);
          return m ? `${m[1]}=${toHost(m[2] as string)}` : part;
        })
        .join(',');
      i++;
    }
  }
  return out;
}

/** This process's container id, when it runs in one docker can name; undefined otherwise. */
export async function ownContainerId(): Promise<string | undefined> {
  // The engine mounts the container's own hostname and resolv.conf from its folder.
  const info = await readFile('/proc/self/mountinfo', 'utf8').catch(() => '');
  const found = /\/containers\/([0-9a-f]{64})\/(?:hostname|resolv\.conf|hosts)/.exec(info);
  return found?.[1];
}

/**
 * How this server's paths look to the engine. `engineDataDir` (AFS_ENGINE_DATA_DIR) names the
 * data folder there; else the server asks the engine about its own container; else (not in a
 * container, or the engine does not know it) paths are the same.
 */
export async function hostPaths(options: {
  dataDir: string;
  engineDataDir?: string;
  inspect: (id: string) => Promise<string>;
  containerId?: () => Promise<string | undefined>;
}): Promise<{ toHost: ToHost; mounts: Mount[]; how: 'setting' | 'inspect' | 'none' }> {
  if (options.engineDataDir) {
    const mounts = [{ source: options.engineDataDir, destination: options.dataDir }];
    return { toHost: mapperOf(mounts), mounts, how: 'setting' };
  }
  const id = await (options.containerId ?? ownContainerId)();
  if (!id) return { toHost: sameAs, mounts: [], how: 'none' };
  let mounts: Mount[];
  try {
    const listed = JSON.parse(await options.inspect(id)) as {
      Source?: string;
      Destination?: string;
    }[];
    mounts = (listed ?? [])
      .filter((m) => m.Source && m.Destination)
      .map((m) => ({ source: m.Source as string, destination: m.Destination as string }));
  } catch {
    return { toHost: sameAs, mounts: [], how: 'none' };
  }
  // Only what holds the data folder, or lies in it, matters: runs mount nothing else of the
  // server's (the engine's socket, a CA file).
  const data = options.dataDir.replace(/\/+$/, '');
  const relevant = mounts.filter((m) => {
    const d = m.destination.replace(/\/+$/, '');
    return d === data || data.startsWith(`${d}/`) || d.startsWith(`${data}/`);
  });
  if (relevant.length === 0) return { toHost: sameAs, mounts: [], how: 'none' };
  return { toHost: mapperOf(relevant), mounts: relevant, how: 'inspect' };
}
