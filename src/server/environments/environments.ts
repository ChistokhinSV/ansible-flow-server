// Execution environments (AFS-32): per workspace, a spec the server builds into an image, or an
// image it is told about. Builds go one at a time on the server's container engine:
//   1. `latest` and ranges are settled against the collection server into a lock;
//   2. a Dockerfile is written from the lock (dockerfile.ts) and built, tagged by the lock's hash;
//   3. the image is asked what it holds: ansible-core and its collections (the catalog);
//   4. the environment's images beyond its `keep` newest builds are removed from the engine.
// For a registered image a "build" pulls it and reads its catalog. A build's output is kept in a
// log file; a server that stops during a build marks it failed when it starts again.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import type { Logger } from '../log';
import { getWorkspace } from '../projects/store';
import { type Engine, findEngine } from '../runs/executor';
import {
  builderFile,
  DEFAULT_BASE,
  DEFAULT_CORE,
  dockerfile,
  type Resolved,
  specHash,
  specProblems,
} from './dockerfile';
import { type Galaxy, GalaxyError, resolveVersion } from './galaxy';
import type {
  BuildState,
  Environment,
  EnvironmentBuild,
  EnvironmentInput,
  EnvironmentKind,
  EnvironmentSpec,
  ImageCatalog,
} from './types';

type Db = Kysely<Schema>;
type Row = Schema['environment'];
type BuildRow = Schema['environment_build'];

export class EnvironmentError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'taken' | 'in_use',
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

const invalid = (message: string, field?: string) =>
  new EnvironmentError('invalid', message, field);
const now = () => new Date().toISOString();
const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const IMAGE = /^[A-Za-z0-9][\w.\-/:@]{0,299}$/;
/** A build log is read back at most this long, its end. */
const LOG_MAX = 1024 * 1024;

/** Runs a command, its output going to `log`; resolves with its exit code (or a kill). */
export type Runner = (
  command: string,
  args: string[],
  options: { log?: (chunk: string) => void; timeoutMs: number },
) => Promise<{ code: number; stdout: string }>;

const spawnRunner: Runner = (command, args, { log, timeoutMs }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    const timer = setTimeout(() => {
      log?.(`\nStopped after ${Math.round(timeoutMs / 60_000)} minutes.\n`);
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => {
      const text = b.toString('utf8');
      if (stdout.length < LOG_MAX) stdout += text;
      log?.(text);
    });
    child.stderr.on('data', (b: Buffer) => log?.(b.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      log?.(`\n${e.message}\n`);
      resolve({ code: 127, stdout });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 137, stdout });
    });
  });

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60) || 'env';

/** The spec as given, with defaults filled in and text tidied. */
function tidy(spec: Partial<EnvironmentSpec> | undefined): EnvironmentSpec {
  const lines = (list?: string[]) => (list ?? []).map((l) => l.trim()).filter(Boolean);
  return {
    baseImage: spec?.baseImage?.trim() || DEFAULT_BASE,
    ansibleCore: spec?.ansibleCore?.trim() || DEFAULT_CORE,
    collections: (spec?.collections ?? [])
      .map((c) => ({ name: c.name.trim().toLowerCase(), version: c.version?.trim() || 'latest' }))
      .filter((c) => c.name),
    python: lines(spec?.python),
    system: lines(spec?.system),
    ...(spec?.caCertificates?.trim() ? { caCertificates: spec.caCertificates.trim() } : {}),
  };
}

/** A catalog's text from the image: the ansible-core version, then `ansible-galaxy collection list` as JSON. */
export function readCatalog(output: string): ImageCatalog {
  const [first, ...rest] = output.trim().split('\n');
  const collections: Record<string, string> = {};
  try {
    const byPath = JSON.parse(rest.join('\n') || '{}') as Record<
      string,
      Record<string, { version: string }>
    >;
    // ansible-core's own internals (ansible._protomatter) are not collections a flow uses.
    for (const found of Object.values(byPath))
      for (const [name, info] of Object.entries(found))
        if (!name.startsWith('ansible._')) collections[name] ??= info.version;
  } catch {
    throw new Error('The image did not list its collections');
  }
  return { ansibleCore: (first ?? '').trim(), collections };
}

export interface EnvironmentDeps {
  db: Db;
  log: Logger;
  galaxy: Galaxy;
  /** Where build contexts and logs are kept. */
  dir: string;
  engine: Engine | 'auto' | 'off';
  timeoutMs: number;
  runner?: Runner;
}

export class Environments {
  private readonly run: Runner;
  private engine?: Engine;
  private building?: Promise<void>;
  private stopped = false;

  constructor(private readonly deps: EnvironmentDeps) {
    this.run = deps.runner ?? spawnRunner;
  }

  private get db(): Db {
    return this.deps.db;
  }

  /** The collection server builds settle versions against (AFS-33 searches it too). */
  get galaxy(): Galaxy {
    return this.deps.galaxy;
  }

  // --- the environments

  private async rows(where: { workspace?: string; id?: string }): Promise<Row[]> {
    let q = this.db.selectFrom('environment').selectAll();
    if (where.workspace) q = q.where('workspace_id', '=', where.workspace);
    if (where.id) q = q.where('id', '=', where.id);
    return q.orderBy('name').execute();
  }

  private buildOf(row: BuildRow): EnvironmentBuild {
    return {
      id: row.id,
      environment: row.environment_id,
      number: row.number,
      state: row.state as BuildState,
      ...(row.image ? { image: row.image } : {}),
      ...(row.lock_json ? { lock: JSON.parse(row.lock_json) } : {}),
      ...(row.catalog_json ? { catalog: JSON.parse(row.catalog_json) as ImageCatalog } : {}),
      ...(row.error ? { error: row.error } : {}),
      pruned: row.pruned === 1,
      by: row.by_login,
      createdAt: row.created_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.ended_at ? { endedAt: row.ended_at } : {}),
    };
  }

  /** The newest good build whose image is still there. */
  private async usable(environmentId: string): Promise<BuildRow | undefined> {
    return this.db
      .selectFrom('environment_build')
      .selectAll()
      .where('environment_id', '=', environmentId)
      .where('state', '=', 'done')
      .where('pruned', '=', 0)
      .orderBy('number', 'desc')
      .executeTakeFirst();
  }

  private async of(row: Row): Promise<Environment> {
    const latest = await this.db
      .selectFrom('environment_build')
      .selectAll()
      .where('environment_id', '=', row.id)
      .orderBy('number', 'desc')
      .executeTakeFirst();
    const good = await this.usable(row.id);
    const used = await this.db
      .selectFrom('launch_config')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('environment_id', '=', row.id)
      .executeTakeFirst();
    const current = row.kind === 'image' ? (row.image ?? undefined) : (good?.image ?? undefined);
    return {
      id: row.id,
      workspace: row.workspace_id,
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      kind: row.kind as EnvironmentKind,
      ...(row.image ? { image: row.image } : {}),
      ...(row.spec_json ? { spec: JSON.parse(row.spec_json) as EnvironmentSpec } : {}),
      keep: row.keep,
      ...(current ? { current } : {}),
      ...(latest ? { latest: this.buildOf(latest) } : {}),
      ...(good?.catalog_json ? { catalog: JSON.parse(good.catalog_json) as ImageCatalog } : {}),
      usedBy: Number(used?.n ?? 0),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async list(workspaceId: string): Promise<Environment[]> {
    return Promise.all((await this.rows({ workspace: workspaceId })).map((r) => this.of(r)));
  }

  async get(id: string): Promise<Environment | undefined> {
    const [row] = await this.rows({ id });
    return row ? this.of(row) : undefined;
  }

  /** The image a launch in this environment gets now; undefined: none yet (with why). */
  async imageFor(id: string): Promise<{ image?: string; why?: string }> {
    const [row] = await this.rows({ id });
    if (!row) return { why: 'The environment is gone' };
    if (row.kind === 'image') return { image: row.image ?? undefined };
    const good = await this.usable(id);
    return good?.image
      ? { image: good.image }
      : { why: `The environment ${row.name} has no successful build yet: build it first` };
  }

  private checked(input: EnvironmentInput, before?: Row) {
    const name = input.name.trim().toLowerCase();
    if (!NAME.test(name))
      throw invalid(
        'A name of lower-case letters, digits, dots, dashes and underscores, up to 63',
        'name',
      );
    const kind = input.kind ?? before?.kind;
    if (kind !== 'spec' && kind !== 'image')
      throw invalid('An environment is a spec or an image', 'kind');
    const keep = input.keep ?? before?.keep ?? 3;
    if (!Number.isInteger(keep) || keep < 1 || keep > 50)
      throw invalid('Keep 1 to 50 images', 'keep');
    if (kind === 'image') {
      const image = input.image?.trim() ?? '';
      if (!IMAGE.test(image)) throw invalid('Not the name of a container image', 'image');
      return { name, kind, keep, image, spec_json: null };
    }
    const spec = tidy(input.spec ?? (before?.spec_json ? JSON.parse(before.spec_json) : undefined));
    const problem = specProblems(spec)[0];
    if (problem) throw invalid(problem.message, problem.field);
    return { name, kind, keep, image: null, spec_json: JSON.stringify(spec) };
  }

  async create(workspaceId: string, input: EnvironmentInput, by: string): Promise<Environment> {
    const c = this.checked(input);
    const row: Row = {
      id: randomUUID(),
      workspace_id: workspaceId,
      name: c.name,
      description: input.description?.trim() || null,
      kind: c.kind,
      image: c.image,
      spec_json: c.spec_json,
      keep: c.keep,
      created_by: by,
      created_at: now(),
      updated_at: now(),
    };
    try {
      await this.db.insertInto('environment').values(row).execute();
    } catch (e) {
      if (/unique|duplicate/i.test(String((e as Error).message)))
        throw new EnvironmentError(
          'taken',
          `The workspace has an environment ${c.name} already`,
          'name',
        );
      throw e;
    }
    return this.of(row);
  }

  async update(id: string, change: Partial<EnvironmentInput>): Promise<Environment> {
    const [before] = await this.rows({ id });
    if (!before) throw new EnvironmentError('not_found', 'No such environment');
    const c = this.checked(
      {
        name: change.name ?? before.name,
        kind: (change.kind ?? before.kind) as EnvironmentKind,
        ...(change.image !== undefined
          ? { image: change.image }
          : before.image
            ? { image: before.image }
            : {}),
        ...(change.spec ? { spec: change.spec } : {}),
        ...(change.keep !== undefined ? { keep: change.keep } : {}),
      },
      before,
    );
    try {
      await this.db
        .updateTable('environment')
        .set({
          name: c.name,
          kind: c.kind,
          image: c.image,
          spec_json: c.spec_json,
          keep: c.keep,
          ...(change.description !== undefined
            ? { description: change.description?.trim() || null }
            : {}),
          updated_at: now(),
        })
        .where('id', '=', id)
        .execute();
    } catch (e) {
      if (/unique|duplicate/i.test(String((e as Error).message)))
        throw new EnvironmentError(
          'taken',
          `The workspace has an environment ${c.name} already`,
          'name',
        );
      throw e;
    }
    return (await this.get(id)) as Environment;
  }

  /** Deletes an environment no launch configuration uses, its builds and their images. */
  async remove(id: string): Promise<void> {
    const env = await this.get(id);
    if (!env) throw new EnvironmentError('not_found', 'No such environment');
    if (env.usedBy)
      throw new EnvironmentError(
        'in_use',
        `${env.usedBy} launch configuration${env.usedBy === 1 ? ' runs' : 's run'} in it: give ${env.usedBy === 1 ? 'it' : 'them'} another first`,
      );
    const builds = await this.db
      .selectFrom('environment_build')
      .selectAll()
      .where('environment_id', '=', id)
      .execute();
    if (builds.some((b) => b.state === 'building' || b.state === 'queued'))
      throw new EnvironmentError('in_use', 'A build of it is going: wait for it to end');
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('environment_build').where('environment_id', '=', id).execute();
      await trx.deleteFrom('environment').where('id', '=', id).execute();
    });
    if (env.kind === 'spec')
      for (const b of builds.filter((b) => b.image && !b.pruned))
        await this.removeImage(b.image as string);
    for (const b of builds) rmSync(this.buildDir(b.id), { recursive: true, force: true });
  }

  /** The workspace an environment is in (for the catalog's access check). */
  async workspaceOf(id: string): Promise<string | undefined> {
    return (await this.rows({ id }))[0]?.workspace_id;
  }

  // --- builds

  private buildDir(id: string): string {
    return join(this.deps.dir, 'builds', id);
  }

  async builds(environmentId: string, limit = 20): Promise<EnvironmentBuild[]> {
    const rows = await this.db
      .selectFrom('environment_build')
      .selectAll()
      .where('environment_id', '=', environmentId)
      .orderBy('number', 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => this.buildOf(r));
  }

  async build(id: string): Promise<EnvironmentBuild | undefined> {
    const row = await this.db
      .selectFrom('environment_build')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.buildOf(row) : undefined;
  }

  /** The end of a build's log. */
  log(id: string): string {
    const file = join(this.buildDir(id), 'build.log');
    try {
      const size = statSync(file).size;
      const text = readFileSync(file, 'utf8');
      return size > LOG_MAX ? `…\n${text.slice(-LOG_MAX)}` : text;
    } catch {
      return '';
    }
  }

  /** Puts a build of the environment in the queue; it starts when the engine is free. */
  async queue(environmentId: string, by: { id: string; login: string }): Promise<EnvironmentBuild> {
    const env = await this.get(environmentId);
    if (!env) throw new EnvironmentError('not_found', 'No such environment');
    const going = await this.db
      .selectFrom('environment_build')
      .select('number')
      .where('environment_id', '=', environmentId)
      .where('state', 'in', ['queued', 'building'])
      .executeTakeFirst();
    if (going) throw new EnvironmentError('in_use', `Build ${going.number} of it is going`);
    const last = await this.db
      .selectFrom('environment_build')
      .select((eb) => eb.fn.max('number').as('n'))
      .where('environment_id', '=', environmentId)
      .executeTakeFirst();
    const row: BuildRow = {
      id: randomUUID(),
      environment_id: environmentId,
      number: Number(last?.n ?? 0) + 1,
      state: 'queued',
      image: null,
      lock_json: null,
      catalog_json: null,
      error: null,
      pruned: 0,
      by_id: by.id,
      by_login: by.login,
      created_at: now(),
      started_at: null,
      ended_at: null,
    };
    await this.db.insertInto('environment_build').values(row).execute();
    this.kick();
    return this.buildOf(row);
  }

  /** Finds the engine, fails builds a stopped server left going, and starts the queue. */
  async start(): Promise<Engine | undefined> {
    // A runner of its own (tests) is the engine named, as it is.
    this.engine =
      this.deps.engine === 'off'
        ? undefined
        : this.deps.runner && this.deps.engine !== 'auto'
          ? this.deps.engine
          : await findEngine(this.deps.engine);
    await this.db
      .updateTable('environment_build')
      .set({ state: 'failed', error: 'The server stopped during the build', ended_at: now() })
      .where('state', '=', 'building')
      .execute();
    if (!this.engine) this.deps.log.warn('No container engine answers: environments are not built');
    this.kick();
    return this.engine;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.building?.catch(() => undefined);
  }

  /** Builds what is queued, one at a time, until nothing is. */
  private kick(): void {
    if (this.building || this.stopped || !this.engine) return;
    this.building = (async () => {
      for (;;) {
        if (this.stopped) return;
        const next = await this.db
          .selectFrom('environment_build')
          .selectAll()
          .where('state', '=', 'queued')
          .orderBy('created_at')
          .executeTakeFirst();
        if (!next) return;
        await this.go(next).catch((e) =>
          this.deps.log.error({ err: e }, 'An environment build failed to end'),
        );
      }
    })().finally(() => {
      this.building = undefined;
    });
  }

  /** Waits for the queue to empty (for tests and a stopping server). */
  async idle(): Promise<void> {
    while (this.building) await this.building;
  }

  private async go(b: BuildRow): Promise<void> {
    const engine = this.engine as Engine;
    const [env] = await this.rows({ id: b.environment_id });
    const dir = this.buildDir(b.id);
    mkdirSync(dir, { recursive: true });
    const out = createWriteStream(join(dir, 'build.log'));
    const log = (text: string) => out.write(text);
    const end = async (state: 'done' | 'failed', set: Partial<BuildRow>) => {
      await this.db
        .updateTable('environment_build')
        .set({ state, ended_at: now(), ...set })
        .where('id', '=', b.id)
        .execute();
      await new Promise((r) => out.end(r));
      this.deps.log.info(
        { environment: env?.name, build: b.number, state },
        'Environment build ended',
      );
    };
    await this.db
      .updateTable('environment_build')
      .set({ state: 'building', started_at: now() })
      .where('id', '=', b.id)
      .execute();
    if (!env) return end('failed', { error: 'The environment is gone' });
    const timeoutMs = this.deps.timeoutMs;
    try {
      let image: string;
      let lock: Resolved | undefined;
      if (env.kind === 'image') {
        image = env.image as string;
        log(`$ ${engine} pull ${image}\n`);
        const pulled = await this.run(engine, ['pull', image], { log, timeoutMs });
        if (pulled.code !== 0) {
          // An image made on this engine has no registry to come from: the engine's copy will do.
          const here = await this.run(engine, ['image', 'inspect', '--format', '{{.Id}}', image], {
            timeoutMs: 60_000,
          });
          if (here.code !== 0)
            return end('failed', {
              error: `The image could not be pulled (exit ${pulled.code}), and the engine has no copy of it`,
            });
          log('\nNot pulled: the engine has the image already, and that copy is used.\n');
        }
      } else {
        const spec = JSON.parse(env.spec_json as string) as EnvironmentSpec;
        log('Settling collection versions…\n');
        const collections: Record<string, string> = {};
        for (const c of spec.collections) {
          collections[c.name] = await resolveVersion(this.deps.galaxy, c.name, c.version);
          log(`  ${c.name} ${c.version} -> ${collections[c.name]}\n`);
        }
        lock = {
          baseImage: spec.baseImage,
          ansibleCore: spec.ansibleCore,
          collections,
          python: spec.python,
          system: spec.system,
          ...(spec.caCertificates ? { caCertificates: spec.caCertificates } : {}),
        };
        const ws = await getWorkspace(this.db, env.workspace_id);
        image = `afs-ee/${slug(ws?.key ?? 'ws')}-${slug(env.name)}:${specHash(lock)}`;
        const context = join(dir, 'context');
        mkdirSync(context, { recursive: true });
        writeFileSync(join(context, 'Dockerfile'), dockerfile(lock));
        if (lock.caCertificates) writeFileSync(join(context, 'ca.pem'), `${lock.caCertificates}\n`);
        log(`\n$ ${engine} build -t ${image} .\n`);
        const built = await this.run(
          engine,
          [
            'build',
            '-t',
            image,
            '--label',
            `afs.environment=${env.id}`,
            '--label',
            `afs.build=${b.id}`,
            context,
          ],
          { log, timeoutMs },
        );
        rmSync(context, { recursive: true, force: true });
        if (built.code !== 0)
          return end('failed', {
            error: `The build failed (exit ${built.code}): see its log`,
            lock_json: JSON.stringify({
              baseImage: lock.baseImage,
              ansibleCore: lock.ansibleCore,
              collections,
            }),
          });
      }
      log('\nReading what the image holds…\n');
      const asked = await this.run(
        engine,
        [
          'run',
          '--rm',
          '--entrypoint',
          'sh',
          image,
          '-c',
          'python3 -c "import ansible.release as r; print(r.__version__)" && ansible-galaxy collection list --format json',
        ],
        { timeoutMs: 5 * 60_000 },
      );
      if (asked.code !== 0)
        return end('failed', {
          image,
          error: 'The image did not say what it holds (no ansible-core?)',
        });
      const catalog = readCatalog(asked.stdout);
      log(
        `  ansible-core ${catalog.ansibleCore}, ${Object.keys(catalog.collections).length} collections\n`,
      );
      await end('done', {
        image,
        catalog_json: JSON.stringify(catalog),
        ...(lock
          ? {
              lock_json: JSON.stringify({
                baseImage: lock.baseImage,
                ansibleCore: catalog.ansibleCore,
                collections: lock.collections,
              }),
            }
          : {}),
      });
      if (env.kind === 'spec') await this.prune(env);
    } catch (e) {
      const why =
        e instanceof GalaxyError ? e.message : `The build failed: ${(e as Error).message}`;
      log(`\n${why}\n`);
      await end('failed', { error: why });
    }
  }

  private async removeImage(image: string): Promise<void> {
    if (!this.engine) return;
    const done = await this.run(this.engine, ['rmi', image], { timeoutMs: 120_000 });
    if (done.code !== 0)
      this.deps.log.warn({ image }, 'An old environment image could not be removed (in use?)');
  }

  /** Removes the images of builds beyond the environment's `keep` newest good ones. */
  private async prune(env: Row): Promise<void> {
    const good = await this.db
      .selectFrom('environment_build')
      .selectAll()
      .where('environment_id', '=', env.id)
      .where('state', '=', 'done')
      .where('pruned', '=', 0)
      .orderBy('number', 'desc')
      .execute();
    const kept = new Set(good.slice(0, env.keep).map((b) => b.image));
    for (const b of good.slice(env.keep)) {
      // The same spec builds the same tag: a kept build may share it.
      if (b.image && !kept.has(b.image)) await this.removeImage(b.image);
      await this.db
        .updateTable('environment_build')
        .set({ pruned: 1 })
        .where('id', '=', b.id)
        .execute();
    }
  }

  /** The environment as ansible-builder v3 reads it: the newest good build's lock, else its spec. */
  async builderFile(id: string): Promise<string> {
    const [row] = await this.rows({ id });
    if (!row) throw new EnvironmentError('not_found', 'No such environment');
    if (row.kind !== 'spec' || !row.spec_json)
      throw invalid('A registered image has no spec to describe', 'kind');
    const spec = JSON.parse(row.spec_json) as EnvironmentSpec;
    const good = await this.usable(id);
    const lock = good?.lock_json
      ? (JSON.parse(good.lock_json) as { collections: Record<string, string>; ansibleCore: string })
      : undefined;
    return builderFile({
      baseImage: spec.baseImage,
      ansibleCore: lock?.ansibleCore ?? spec.ansibleCore,
      collections:
        lock?.collections ?? Object.fromEntries(spec.collections.map((c) => [c.name, c.version])),
      python: spec.python,
      system: spec.system,
      ...(spec.caCertificates ? { caCertificates: spec.caCertificates } : {}),
    });
  }
}
