// What a launch would touch, as the inventory has it (AFS-67): the designer's probe, run in the
// launch's image over the repository at the launch's commit, reads the inventory the way the run
// will (ansible-inventory with the image's plugins, the variables credentials give). The launch
// dialog asks again while someone types, so a probe stays up for a while after its last answer.

import { join } from 'node:path';
import { CONTAINER, probeProcess } from '@ansible-flow/core/run/command';
import type { Environment } from '@ansible-flow/core/run/environment';
import { ProbeClient } from '@ansible-flow/node/env/probeClient';
import { inventoryGroups, launchFacts } from '@ansible-flow/node/run/facts';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import type { InventoryAnswer, InventoryQuestion } from '../launch/facts';
import type { Logger } from '../log';
import type { MasterKey } from '../secrets/masterKey';
import { inventoryEnv, registrySignIn } from './credentials';
import type { Engine } from './executor';
import { rewriteMounts, type ToHost } from './hostPaths';
import { pullWithSignIn } from './registry';
import type { Workdir, Workdirs } from './workdir';

export type { InventoryAnswer, InventoryQuestion };

interface Probe {
  client: ProbeClient;
  label: string;
  workdir: Workdir;
  timer?: NodeJS.Timeout;
  usedAt: number;
}

export interface ProbesOptions {
  engine: () => Engine | undefined;
  /** AFS-35: a data folder path as the engine's machine has it. */
  toHost?: () => ToHost;
  /** The designer's probe files, where containers can mount them. */
  probeDir: string;
  workdirs: Workdirs;
  db: Kysely<Schema>;
  key: MasterKey;
  /** Every container gets it, so a stopped server's are found and removed. */
  labels: string[];
  /** Where a registry sign-in keeps its files for a moment. */
  secretsDir: string;
  log: Logger;
  idleMs?: number;
  max?: number;
}

export class InventoryProbes {
  private readonly probes = new Map<string, Promise<Probe>>();
  private next = 0;

  constructor(private readonly options: ProbesOptions) {}

  /** The facts for these inputs, and the groups when asked; never throws. */
  async ask(q: InventoryQuestion): Promise<InventoryAnswer> {
    const environment = `${q.image} (${this.options.engine() ?? 'no container engine'})`;
    let probe: Probe;
    try {
      probe = await this.probeFor(q);
    } catch (e) {
      return {
        factsError: `The hosts could not be read from the inventory: ${(e as Error).message}`,
        ...(q.groups ? { groups: [], groupHosts: {} } : {}),
        environment,
      };
    }
    const runProbe = { client: probe.client, label: probe.label };
    try {
      const [found, groups] = await Promise.all([
        launchFacts(q.doc, q.inputs, runProbe, q.inventory),
        q.groups ? inventoryGroups(runProbe, q.inventory) : undefined,
      ]);
      return {
        ...(found.ok ? { facts: found.facts } : { factsError: found.error }),
        ...(groups ? { groups: groups.groups, groupHosts: groups.hosts } : {}),
        environment: probe.label,
      };
    } finally {
      this.idle(this.keyOf(q), probe);
    }
  }

  /** Ends every probe (the server stops). */
  async stop(): Promise<void> {
    const all = [...this.probes.keys()];
    await Promise.allSettled(all.map((key) => this.end(key)));
  }

  private keyOf(q: InventoryQuestion): string {
    return JSON.stringify([q.project, q.commit, q.image, q.inventory ?? '', [...q.credentials]]);
  }

  private probeFor(q: InventoryQuestion): Promise<Probe> {
    const key = this.keyOf(q);
    let found = this.probes.get(key);
    if (!found) {
      found = this.open(q);
      this.probes.set(key, found);
      // A probe that did not start is not kept: the next question tries again.
      found.catch(() => this.probes.delete(key));
      void this.trim(key);
    }
    return found.then((p) => {
      clearTimeout(p.timer);
      p.usedAt = Date.now();
      return p;
    });
  }

  private async open(q: InventoryQuestion): Promise<Probe> {
    const engine = this.options.engine();
    if (!engine) throw new Error('no container engine answers on this server');
    const id = `probe-${Date.now().toString(36)}-${(this.next++).toString(36)}`;
    const signIn = await registrySignIn(this.options.db, this.options.key, q.credentials);
    if (signIn)
      await pullWithSignIn(
        engine,
        q.image,
        signIn,
        join(this.options.secretsDir, `${id}-registry`),
      );
    const workdir = await this.options.workdirs.checkout(q.project, q.commit, false, id);
    try {
      // A dynamic inventory may need the run's variables (a token for its source): those only.
      const vars = await inventoryEnv(this.options.db, this.options.key, q.credentials);
      const options = this.options.labels.flatMap((l) => ['--label', l]);
      const env: Environment = {
        kind: 'container',
        engine,
        image: q.image,
        options: [...options, ...vars.options],
        mounts: [],
        source: 'afd',
        label: `${q.image} (${engine})`,
      };
      const spec = probeProcess(
        env,
        { root: workdir.dir, probe: this.options.probeDir },
        `afs-${id}`,
      );
      spec.env = { ...spec.env, ...vars.processEnv };
      if (this.options.toHost) spec.args = rewriteMounts(spec.args, this.options.toHost());
      const client = new ProbeClient(spec, workdir.dir, CONTAINER.root, (line) =>
        this.options.log.debug({ probe: id }, line),
      );
      await client.start();
      return { client, label: env.label, workdir, usedAt: Date.now() };
    } catch (e) {
      await workdir.release();
      throw e;
    }
  }

  private idle(key: string, probe: Probe): void {
    clearTimeout(probe.timer);
    probe.timer = setTimeout(() => void this.end(key), this.options.idleMs ?? 120_000);
    probe.timer.unref();
  }

  /** Keeps at most `max` probes: the one used longest ago goes. */
  private async trim(keep: string): Promise<void> {
    const max = this.options.max ?? 4;
    if (this.probes.size <= max) return;
    const ready = await Promise.all(
      [...this.probes].map(async ([key, p]) => [key, await p.catch(() => undefined)] as const),
    );
    const oldest = ready
      .filter(([key, p]) => key !== keep && p)
      .sort(([, a], [, b]) => (a?.usedAt ?? 0) - (b?.usedAt ?? 0))[0];
    if (oldest) await this.end(oldest[0]);
  }

  private async end(key: string): Promise<void> {
    const found = this.probes.get(key);
    this.probes.delete(key);
    const probe = await found?.catch(() => undefined);
    if (!probe) return;
    clearTimeout(probe.timer);
    probe.client.dispose();
    await probe.workdir.release();
  }
}
