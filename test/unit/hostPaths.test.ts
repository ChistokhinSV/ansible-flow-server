// AFS-35: the server in a container hands its run containers the data folder's paths as the
// engine's machine has them.
import { describe, expect, it } from 'vitest';
import { hostPaths, mapperOf, rewriteMounts, sameAs } from '../../src/server/runs/hostPaths';

const VOLUME = '/var/lib/docker/volumes/afs_data/_data';

describe('paths as the engine has them', () => {
  it('maps a path under the deepest mount that holds it, and leaves others', () => {
    const toHost = mapperOf([
      { source: VOLUME, destination: '/var/lib/afs' },
      { source: '/srv/afs-runs', destination: '/var/lib/afs/runs/' },
    ]);
    expect(toHost('/var/lib/afs')).toBe(VOLUME);
    expect(toHost('/var/lib/afs/work/p1/run-7')).toBe(`${VOLUME}/work/p1/run-7`);
    expect(toHost('/var/lib/afs/runs/p1/x')).toBe('/srv/afs-runs/p1/x');
    // A sibling whose name only starts the same is not under it.
    expect(toHost('/var/lib/afs-other/x')).toBe('/var/lib/afs-other/x');
    expect(toHost('/tmp/x')).toBe('/tmp/x');
  });

  it('rewrites the sources of -v, --volume and --mount; names and the rest stay', () => {
    const toHost = mapperOf([{ source: VOLUME, destination: '/var/lib/afs' }]);
    expect(
      rewriteMounts(
        [
          'run',
          '--rm',
          '-v',
          '/var/lib/afs/work/p1/branch:/work:ro',
          '--volume',
          '/var/lib/afs/probe:/afd:ro',
          '-v',
          'afs_cache:/afd-cache',
          '--mount',
          'type=bind,source=/var/lib/afs/secrets-tmp/r1,target=/afd-cred,readonly',
          '-w',
          '/var/lib/afs/not-a-mount',
          'afd-ee:2.19',
        ],
        toHost,
      ),
    ).toEqual([
      'run',
      '--rm',
      '-v',
      `${VOLUME}/work/p1/branch:/work:ro`,
      '--volume',
      `${VOLUME}/probe:/afd:ro`,
      '-v',
      'afs_cache:/afd-cache',
      '--mount',
      `type=bind,source=${VOLUME}/secrets-tmp/r1,target=/afd-cred,readonly`,
      '-w',
      '/var/lib/afs/not-a-mount',
      'afd-ee:2.19',
    ]);
    expect(rewriteMounts(['-v', '/a:/b'], sameAs)).toEqual(['-v', '/a:/b']);
  });

  it("finds the data folder's mount from the server's own container, or is told it", async () => {
    const inspect = async () =>
      JSON.stringify([
        { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' },
        { Type: 'volume', Source: VOLUME, Destination: '/var/lib/afs' },
      ]);
    const found = await hostPaths({
      dataDir: '/var/lib/afs',
      inspect,
      containerId: async () => 'c'.repeat(64),
    });
    expect(found.how).toBe('inspect');
    expect(found.mounts).toEqual([{ source: VOLUME, destination: '/var/lib/afs' }]);
    expect(found.toHost('/var/lib/afs/probe')).toBe(`${VOLUME}/probe`);

    // Not in a container: the same paths.
    const outside = await hostPaths({
      dataDir: '/var/lib/afs',
      inspect,
      containerId: async () => undefined,
    });
    expect(outside.how).toBe('none');
    expect(outside.toHost('/var/lib/afs/x')).toBe('/var/lib/afs/x');
    // In one, but the data folder is not mounted (it would be lost with the container): same.
    const unmounted = await hostPaths({
      dataDir: '/data',
      inspect,
      containerId: async () => 'c'.repeat(64),
    });
    expect(unmounted.how).toBe('none');
    // The engine does not know the container: same paths, no failure.
    const unknown = await hostPaths({
      dataDir: '/var/lib/afs',
      inspect: async () => {
        throw new Error('No such object');
      },
      containerId: async () => 'c'.repeat(64),
    });
    expect(unknown.how).toBe('none');

    // AFS_ENGINE_DATA_DIR wins, without asking.
    const told = await hostPaths({
      dataDir: '/var/lib/afs',
      engineDataDir: '/srv/afs',
      inspect: async () => {
        throw new Error('not asked');
      },
    });
    expect(told.how).toBe('setting');
    expect(told.toHost('/var/lib/afs/work')).toBe('/srv/afs/work');
  });
});
