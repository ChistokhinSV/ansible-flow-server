// AFS-80: what a run keeps of the repository's Ansible config, read as the run will see it: the
// designer's probe runs for a moment in the run's image over the run's checkout and says which
// callbacks the config enables and which module, module_utils and plugin paths it gives (its
// `run_config`). The run then adds the repository's own library/, module_utils/ and plugin folders
// after those, and loads the root's group_vars/host_vars (designer AFD-291), as a run from VS Code
// does. Without an answer the run goes on as before: its callback alone, no added paths.
import type { RepositoryConfig } from '@ansible-flow/core/run/command';
import { CONTAINER, probeProcess } from '@ansible-flow/core/run/command';
import type { Environment } from '@ansible-flow/core/run/environment';
import { ProbeClient } from '@ansible-flow/node/env/probeClient';
import { repositoryCallbacks } from '@ansible-flow/node/run/facts';
import type { Logger } from '../log';
import type { Engine } from './executor';
import { rewriteMounts, type ToHost } from './hostPaths';

export interface RepoConfigOptions {
  engine: Engine;
  image: string;
  /** The run's checkout on this machine. */
  root: string;
  probeDir: string;
  /** Labels every container of the server gets, so a stopped server's are found. */
  options: string[];
  toHost?: ToHost;
  log: Logger;
  name: string;
}

/** The repository's config as the run's image reads it; undefined when the probe does not answer. */
export async function repositoryConfig(
  o: RepoConfigOptions,
): Promise<RepositoryConfig | undefined> {
  const env: Environment = {
    kind: 'container',
    engine: o.engine,
    image: o.image,
    // No credential reaches it: the config is read, nothing is run against hosts.
    options: o.options,
    mounts: [],
    source: 'afd',
    label: `${o.image} (${o.engine})`,
  };
  const spec = probeProcess(env, { root: o.root, probe: o.probeDir }, o.name);
  if (o.toHost) spec.args = rewriteMounts(spec.args, o.toHost);
  const client = new ProbeClient(spec, o.root, CONTAINER.root, (line) =>
    o.log.debug({ probe: o.name }, line),
  );
  try {
    await client.start();
    return await repositoryCallbacks({ client, label: env.label });
  } catch (e) {
    o.log.warn(
      { image: o.image, why: (e as Error).message },
      "The repository's Ansible config could not be read: the run adds none of its folders",
    );
    return undefined;
  } finally {
    client.dispose();
  }
}
