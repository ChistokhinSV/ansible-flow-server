// AFS-76: the module catalog the designer searches while a flow is edited in the pages, read from
// an image: the designer's probe runs in the image and writes each collection's plugin docs; the
// designer's own index is built from them (in a worker, beside the main thread). One index per
// image, kept in the data folder: built once, then opened.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { Manifest } from '@ansible-flow/core/catalog/types';
import { CONTAINER, insidePaths, probeProcess } from '@ansible-flow/core/run/command';
import type { Environment } from '@ansible-flow/core/run/environment';
import {
  CatalogIndex,
  INDEX_SCHEMA,
  sqliteAvailable,
} from '@ansible-flow/node/catalog/catalogIndex';
import type { BuildResult } from '@ansible-flow/node/catalog/catalogWorker';
import { checkedManifest } from '@ansible-flow/node/catalog/dumpFiles';
import { ProbeClient } from '@ansible-flow/node/env/probeClient';
import type { Logger } from '../log';
import type { Engine } from './executor';
import { rewriteMounts, type ToHost } from './hostPaths';

/** Reading every collection's docs takes a while for a large image. */
const DUMP_MS = 15 * 60_000;
const INDEX_MS = 10 * 60_000;

export type CatalogState =
  | { state: 'ready'; index: CatalogIndex; image: string }
  | { state: 'loading'; image: string }
  | { state: 'error'; image: string; error: string };

export interface CatalogsOptions {
  engine: () => Engine | undefined;
  toHost?: () => ToHost;
  /** The designer's probe files, where containers can mount them. */
  probeDir: string;
  /** Where the indexes and the collections' docs are kept. */
  dir: string;
  labels: string[];
  log: Logger;
}

export class ModuleCatalogs {
  private readonly ready = new Map<string, CatalogIndex>();
  private readonly building = new Map<string, Promise<void>>();
  private readonly failed = new Map<string, string>();

  constructor(private readonly options: CatalogsOptions) {}

  private folderOf(image: string): string {
    return join(this.options.dir, createHash('sha256').update(image).digest('hex').slice(0, 24));
  }

  /** The image's index: ready, being built (started now if not yet), or why there is none. */
  get(image: string): CatalogState {
    const index = this.ready.get(image);
    if (index) return { state: 'ready', index, image };
    const folder = this.folderOf(image);
    const path = join(folder, `index-${INDEX_SCHEMA}.sqlite`);
    if (existsSync(path)) {
      const opened = CatalogIndex.open(path);
      if (opened) {
        this.ready.set(image, opened);
        return { state: 'ready', index: opened, image };
      }
    }
    if (!this.building.has(image)) {
      if (!sqliteAvailable())
        return { state: 'error', image, error: 'This Node.js has no SQLite (22.13 or later)' };
      const failed = this.failed.get(image);
      if (failed) return { state: 'error', image, error: failed };
      const job = this.build(image, folder, path)
        .catch((e: Error) => {
          this.failed.set(image, e.message);
          this.options.log.warn({ image, err: e }, 'The module catalog could not be built');
        })
        .finally(() => this.building.delete(image));
      this.building.set(image, job);
    }
    return { state: 'loading', image };
  }

  /** Tries an image whose catalog failed again (Rebuild). */
  retry(image: string): void {
    this.failed.delete(image);
  }

  private async build(image: string, folder: string, path: string): Promise<void> {
    const engine = this.options.engine();
    if (!engine) throw new Error('No container engine answers on this server');
    const cache = join(folder, 'docs');
    mkdirSync(cache, { recursive: true });
    const root = await mkdtemp(join(this.options.dir, 'root-'));
    const label = `${image} (${engine})`;
    let client: ProbeClient | undefined;
    try {
      const env: Environment = {
        kind: 'container',
        engine,
        image,
        options: this.options.labels.flatMap((l) => ['--label', l]),
        mounts: [],
        source: 'afd',
        label,
      };
      const paths = { root, probe: this.options.probeDir, cache };
      const spec = probeProcess(env, paths, `afs-catalog-${Date.now().toString(36)}`);
      if (this.options.toHost) spec.args = rewriteMounts(spec.args, this.options.toHost());
      client = new ProbeClient(spec, root, CONTAINER.root, (line) =>
        this.options.log.debug({ catalog: image }, line),
      );
      await client.start();
      this.options.log.info(
        { image },
        'Reading the plugin docs of an image for the module catalog',
      );
      const manifest = checkedManifest(
        await client.call<Manifest>(
          'catalog',
          { cache: insidePaths(env, paths).cache, jobs: 8 },
          DUMP_MS,
        ),
        cache,
      );
      const files = manifest.collections
        .filter((c) => !c.error && c.file)
        .map((c) => join(cache, c.file as string));
      const built = await this.index(files, path);
      if (!built.ok) throw new Error(built.error);
      const index = CatalogIndex.open(path);
      if (!index) throw new Error('The catalog index could not be opened');
      this.ready.set(image, index);
      this.options.log.info({ image, ...index.stats() }, 'Module catalog ready');
    } finally {
      client?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }

  /** The designer's index builder, in a worker thread. */
  private index(files: string[], out: string): Promise<BuildResult> {
    const script = fileURLToPath(import.meta.resolve('@ansible-flow/node/catalog/catalogWorker'));
    return new Promise((resolve) => {
      const worker = new Worker(script, { workerData: { files, out } });
      const timer = setTimeout(() => {
        void worker.terminate();
        resolve({ ok: false, error: 'Indexing took too long: stopped' });
      }, INDEX_MS);
      worker.once('message', (r: BuildResult) => {
        clearTimeout(timer);
        resolve(r);
        void worker.terminate();
      });
      worker.once('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: e.message });
      });
    });
  }

  close(): void {
    for (const index of this.ready.values()) index.close();
    this.ready.clear();
  }
}
