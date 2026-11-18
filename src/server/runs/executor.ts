// The server's own worker: takes runs from the queue and runs them with Ansible in an execution
// environment container, through the designer's own run pipeline (runFlow), so a run here does
// what the same run does from VS Code.
//
// For each run: check out the commit, generate the flow's code fresh, hand over the
// credentials, start the run, keep the lease alive (and stop when someone cancels, the lease is
// lost or the run takes too long), say how it ended, clean up.
import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, type WriteStream } from 'node:fs';
import { chown, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineFor } from '@ansible-flow/core/engine/engines';
import { parseFlow } from '@ansible-flow/core/flow/document';
import { durationSeconds } from '@ansible-flow/core/flow/duration';
import { validateFlow } from '@ansible-flow/core/flow/validate';
import type { RunView } from '@ansible-flow/core/protocol';
import { stripAnsi } from '@ansible-flow/core/run/ansi';
import type { Environment } from '@ansible-flow/core/run/environment';
import { REDACTED } from '@ansible-flow/core/run/redact';
import { startProcess } from '@ansible-flow/node/run/exec';
import { stamp } from '@ansible-flow/node/run/ids';
import { runsDir } from '@ansible-flow/node/run/pastRuns';
import { type RunFlowHooks, type RunFlowRequest, runFlow } from '@ansible-flow/node/run/runFlow';
import {
  type GateDecision,
  nextSegment,
  segmentInputs,
  segmentOutcome,
  segmentsSummary,
} from '@ansible-flow/node/run/segments';
import type { Kysely } from 'kysely';
import { approvalsOf, gatesOf, lastGate, openGate } from '../approvals/gates';
import { createRunToken, revokeRunTokens } from '../auth/tokens';
import type { Schema } from '../db/schema';
import { schemaIssues } from '../flows';
import type { Logger } from '../log';
import type { MetricsSink } from '../ops/metrics';
import type { Git } from '../projects/git';
import { getProject } from '../projects/store';
import type { ProjectSync } from '../projects/sync';
import type { MasterKey } from '../secrets/masterKey';
import { type CatalogState, ModuleCatalogs } from './catalogs';
import { AGENT_FAILURES, CredentialProblem, registrySignIn, runCredentials } from './credentials';
import { hostPaths, rewriteMounts, sameAs, type ToHost } from './hostPaths';
import type { RunHub } from './hub';
import { withLimit } from './limit';
import { type InventoryAnswer, InventoryProbes, type InventoryQuestion } from './probes';
import type { Job, Outcome, RunQueue } from './queue';
import { pullWithSignIn } from './registry';
import { repositoryConfig } from './repoConfig';
import { failedWhy, NO_HOSTS, noHostWhy, skippedTarget, titleOf } from './words';
import { rootFromGenerated, Workdirs, writeGenerated } from './workdir';

/** How often the worker says it still has a run. */
export const HEARTBEAT_MS = 15_000;
/** What runFlow says when Ansible wrote no event. */
const NO_EVENTS = 'The run produced no events';
/**
 * An output line that says why a container or Ansible could not start ("[ERROR]: Specified
 * inventory, host pattern and/or --limit leaves us with no hosts to target." is Ansible's own).
 */
const ERROR_LINE =
  /^(\[?error\]?|\[?fatal\]?|docker:|podman:|Error response)|\b(no such host|not found|denied|unauthorized|manifest unknown)\b/i;
/** A finished view in which no host did anything. */
const noHostRan = (view: RunView) => view.summary !== undefined && view.summary.hosts.length === 0;

/** How often it looks for queued runs. */
const POLL_MS = 2_000;
/** A run's output is kept up to this size. */
const MAX_OUTPUT = 20 * 1024 * 1024;
/** The image when neither the launch nor the settings name one: what the designer proposes. */
export const DEFAULT_IMAGE = 'ghcr.io/ansible/community-ansible-dev-tools:latest';

export type Engine = 'docker' | 'podman';

/**
 * The designer's name of a run (and of a segment of it): its folder and its container's name. Its
 * start time first, so run folders sort by time; then the run's number and, AFS-120, the start of
 * its id: two projects' runs with the same number starting in the same second had the same
 * container name, and the second one failed ("The container name is already in use").
 */
export function runName(r: { id: string; number: number }, segment?: string, now = new Date()) {
  return `${stamp(now)}-${r.number}-${r.id.slice(0, 8)}${segment ? `-${segment}` : ''}`;
}

/** AFS-118: the version of the collection in `dir` (its galaxy.yml); none without one. */
export function collectionVersion(dir: string): string | undefined {
  try {
    return /^version:\s*['"]?([^'"\s]+)/m.exec(readFileSync(join(dir, 'galaxy.yml'), 'utf8'))?.[1];
  } catch {
    return undefined;
  }
}

/** AFS-116: the collection's folder, under a collections path, and where runs find it. */
const COLLECTION_PATH = ['ansible_collections', 'chistokhinsv', 'ansible_flow'];
const COLLECTION_DEST =
  '/usr/share/ansible/collections/ansible_collections/chistokhinsv/ansible_flow';

export interface ExecutorOptions {
  dataDir: string;
  /** The container engine; `auto` finds docker, else podman; `off` runs nothing. */
  engine: Engine | 'auto' | 'off';
  /** The image a run uses unless it names its own. */
  image: string;
  /** AFS-35: the data folder as the engine's machine sees it (AFS_ENGINE_DATA_DIR). */
  engineDataDir?: string;
  /** This worker's name in the queue (a server's instance id). */
  worker: string;
  /** Runs at once on this worker. */
  slots: number;
  /** A run that takes longer is stopped. */
  timeoutMs: number;
  /** Tests: what runs the flow instead of the designer's pipeline. */
  runner?: (request: RunFlowRequest, hooks: RunFlowHooks) => Promise<RunView>;
  /** Tests: how the repository's Ansible config is read (AFS-80); with a runner, by default not. */
  repoConfig?: typeof repositoryConfig;
  /** Tests: how often the lease is kept alive. */
  heartbeatMs?: number;
  pollMs?: number;
  /**
   * AFS-116: where runs reach this server, asked for each run (the certificate may change); none:
   * runs get no address and no token.
   */
  server?: () => { url: string; verifyTls: boolean } | undefined;
  /**
   * AFS-116: the Ansible collection chistokhinsv.ansible_flow this server carries (dist/collection);
   * it is mounted into every run. Default: beside the server's bundle; missing: not mounted.
   */
  collectionDir?: string;
}

export interface ExecutorDeps {
  db: Kysely<Schema>;
  git: Git;
  sync: ProjectSync;
  queue: RunQueue;
  key: MasterKey;
  log: Logger;
  /** Where what a going run says is heard by those who watch it. */
  hub?: RunHub;
  /** AFS-29: told when a run starts to wait at an approval. */
  approvalWaiting?: (run: string, gate: string) => void;
  /** AFS-37: told how long each run took. */
  metrics?: MetricsSink;
}

/** Why a run was stopped from outside. */
type Stop = 'cancel' | 'lost' | 'timeout' | 'shutdown';

const run = (command: string, args: string[], timeoutMs = 15_000) =>
  new Promise<string>((resolve, reject) =>
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    ),
  );

/**
 * AFS-36: the user namespace of a run with rootless podman: the server's own user becomes the
 * image's user (keep-id), so what the run writes into the run folder is the server's to read.
 * Nothing for docker, for a server that is root, or an image that runs as root (then the image's
 * root already is the server's user).
 */
export function usernsOptions(
  engine: Engine,
  serverUid: number,
  imageUser: { uid: number; gid: number } | undefined,
): string[] {
  if (engine !== 'podman' || serverUid === 0 || !imageUser || imageUser.uid === 0) return [];
  return ['--userns', `keep-id:uid=${imageUser.uid},gid=${imageUser.gid}`];
}

/** The container engine that answers, when there is one. */
export async function findEngine(wanted: ExecutorOptions['engine']): Promise<Engine | undefined> {
  if (wanted === 'off') return undefined;
  for (const engine of wanted === 'auto' ? (['docker', 'podman'] as const) : [wanted]) {
    const answered = await run(engine, ['version', '--format', '{{.Server.Version}}']).then(
      (v) => v.length > 0,
      () => false,
    );
    if (answered) return engine;
  }
  return undefined;
}

/** The files the run's container needs from the designer (the probe and the event callback). */
const assetsProbe = () =>
  fileURLToPath(new URL('./probe', import.meta.resolve('@ansible-flow/assets/package.json')));

/** A line of output with every secret value replaced, as written and as JSON would write it. */
export function hide(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join(REDACTED);
    const quoted = JSON.stringify(secret).slice(1, -1);
    if (quoted !== secret) out = out.split(quoted).join(REDACTED);
  }
  return out;
}

export class Executor {
  private readonly active = new Map<string, { abort(why: Stop): void; done: Promise<void> }>();
  private timer: NodeJS.Timeout | undefined;
  private filling = false;
  private stopping = false;
  private engine: Engine | undefined;
  /** AFS-76: module catalogs read from images, for editing in the pages. */
  private readonly catalogs: ModuleCatalogs;
  private readonly workdirs: Workdirs;
  private readonly probeDir: string;
  private readonly outputDir: string;
  private readonly probes: InventoryProbes;
  /** AFS-35: a path of the data folder as the engine's machine has it (found at start). */
  private toHost: ToHost = sameAs;
  /** AFS-116: the Ansible collection in the data folder (where run containers can mount it). */
  private collection?: Promise<string | undefined>;
  /** The user each image runs as, found once. */
  private readonly owners = new Map<string, Promise<{ uid: number; gid: number } | undefined>>();

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly options: ExecutorOptions,
  ) {
    this.workdirs = new Workdirs(join(options.dataDir, 'work'), deps.git, deps.sync);
    // AFS-131: a stop asked on this server stops the run at once, not at the next heartbeat.
    deps.queue.onStopAsked = (id) => this.active.get(id)?.abort('cancel');
    this.probeDir = join(options.dataDir, 'probe');
    this.outputDir = join(options.dataDir, 'output');
    const version = collectionVersion(this.collectionSource());
    this.catalogs = new ModuleCatalogs({
      engine: () => (this.options.runner ? undefined : this.engine),
      toHost: () => this.toHost,
      probeDir: this.probeDir,
      dir: join(options.dataDir, 'catalogs'),
      labels: [this.label],
      log: deps.log,
      ...(version
        ? { collection: { version, dir: () => this.collectionMount(), dest: COLLECTION_DEST } }
        : {}),
    });
    this.probes = new InventoryProbes({
      engine: () => (this.options.runner ? undefined : this.engine),
      toHost: () => this.toHost,
      probeDir: this.probeDir,
      workdirs: this.workdirs,
      db: deps.db,
      key: deps.key,
      labels: [this.label],
      secretsDir: join(options.dataDir, 'secrets-tmp'),
      log: deps.log,
    });
  }

  /**
   * AFS-116: the collection this server carries, copied once per start into the data folder: the
   * engine mounts paths of the data folder (a sibling container sees the host's), not the
   * server's own files. Missing (a development build): runs get none.
   */
  private collectionSource(): string {
    return (
      this.options.collectionDir ??
      join(dirname(fileURLToPath(import.meta.url)), 'collection', ...COLLECTION_PATH)
    );
  }

  private collectionMount(): Promise<string | undefined> {
    this.collection ??= (async () => {
      const from = this.collectionSource();
      if (!existsSync(join(from, 'galaxy.yml'))) return undefined;
      const to = join(this.options.dataDir, 'collection', ...COLLECTION_PATH);
      await rm(to, { recursive: true, force: true });
      await cp(from, to, { recursive: true });
      return to;
    })().catch((e) => {
      this.deps.log.warn({ err: e }, 'The Ansible collection could not be readied for runs');
      return undefined;
    });
    return this.collection;
  }

  /** AFS-76: the module catalog of an image (the server's default without one). */
  catalog(image?: string): CatalogState {
    return this.catalogs.get(image ?? this.options.image);
  }

  /** AFS-76: Rebuild in the designer: a catalog that failed is tried again. */
  retryCatalog(image?: string): void {
    this.catalogs.retry(image ?? this.options.image);
  }

  /**
   * AFS-67: what a launch would touch, as the inventory has it: read by the designer's probe in
   * the launch's image (else this server's), over the repository at the launch's commit.
   */
  inventory(q: Omit<InventoryQuestion, 'image'> & { image?: string }): Promise<InventoryAnswer> {
    return this.probes.ask({ ...q, image: q.image ?? this.options.image });
  }

  /**
   * The user an image runs as, when the server may give files to it (it runs as root): what the
   * run's key file must belong to. Undefined otherwise.
   */
  private ownerOf(image: string): Promise<{ uid: number; gid: number } | undefined> {
    if (this.options.runner || process.getuid?.() !== 0 || !this.engine)
      return Promise.resolve(undefined);
    return this.imageUser(image);
  }

  /**
   * AFS-36: with rootless podman (the native install), the image's own user is mapped to the
   * server's: it writes the run's events into the run folder, which is the server's.
   */
  private async usernsOf(image: string): Promise<string[]> {
    if (this.options.runner || !this.engine) return [];
    const serverUid = process.getuid?.() ?? 0;
    if (this.engine !== 'podman' || serverUid === 0) return [];
    return usernsOptions(this.engine, serverUid, await this.imageUser(image));
  }

  /** The user an image runs as, found once. */
  private imageUser(image: string): Promise<{ uid: number; gid: number } | undefined> {
    let found = this.owners.get(image);
    if (!found) {
      const engine = this.engine as Engine;
      found = Promise.all([
        run(engine, ['run', '--rm', '--entrypoint', 'id', image, '-u'], 120_000),
        run(engine, ['run', '--rm', '--entrypoint', 'id', image, '-g'], 120_000),
      ]).then(
        ([u, g]) =>
          /^\d+$/.test(u) && /^\d+$/.test(g) ? { uid: Number(u), gid: Number(g) } : undefined,
        () => undefined,
      );
      this.owners.set(image, found);
      // An image that could not be asked (not pulled yet, the engine not ready) is asked again
      // next time: kept, the miss would last as long as the server (found on Rocky 10).
      const asked = found;
      void asked.then((user) => {
        if (!user && this.owners.get(image) === asked) this.owners.delete(image);
      });
    }
    return found;
  }

  /** AFS-37: the engine runs use now; undefined while none answers (/readyz). */
  get engineName(): string | undefined {
    return this.options.runner ? 'test' : this.engine;
  }

  /** Where a run's output is kept. */
  outputFile(runId: string): string {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(runId)) throw new Error('Not a run id');
    return join(this.outputDir, `${runId}.log`);
  }

  /** The label every container of this worker has, to find what a stopped server left. */
  private get label(): string {
    return `afs.worker=${this.options.worker}`;
  }

  /**
   * Finds the engine, puts the designer's files where containers can mount them, removes what a
   * stopped server left (containers, folders), and starts taking runs. Resolves with the engine,
   * or undefined when there is none: then nothing is taken and runs wait in the queue.
   */
  async start(): Promise<Engine | undefined> {
    this.engine = this.options.runner ? 'docker' : await findEngine(this.options.engine);
    if (!this.engine) {
      this.deps.log.warn(
        { engine: this.options.engine },
        'No container engine answers: runs wait in the queue',
      );
      return undefined;
    }
    // Containers mount files from the data folder only. AFS-35: when the server itself runs in a
    // container, the engine knows that folder by another path: found once, used for every mount.
    if (!this.options.runner) {
      const engine = this.engine;
      const found = await hostPaths({
        dataDir: this.options.dataDir,
        ...(this.options.engineDataDir ? { engineDataDir: this.options.engineDataDir } : {}),
        inspect: (id) => run(engine, ['inspect', '--format', '{{json .Mounts}}', id]),
      });
      this.toHost = found.toHost;
      if (found.how !== 'none')
        this.deps.log.info(
          {
            how: found.how,
            data: this.options.dataDir,
            engine: found.toHost(this.options.dataDir),
          },
          "The data folder as the engine's machine has it",
        );
    }
    await rm(this.probeDir, { recursive: true, force: true });
    await cp(assetsProbe(), this.probeDir, { recursive: true });
    await mkdir(this.outputDir, { recursive: true });
    if (!this.options.runner) {
      const left = await run(this.engine, ['ps', '-aq', '--filter', `label=${this.label}`]).catch(
        () => '',
      );
      const ids = left.split(/\s+/).filter(Boolean);
      if (ids.length) await run(this.engine, ['rm', '-f', ...ids]).catch(() => undefined);
      if (ids.length)
        this.deps.log.warn({ containers: ids.length }, 'Removed containers a stopped server left');
    }
    const folders = await this.workdirs.sweep();
    if (folders) this.deps.log.info({ folders }, 'Removed run folders a stopped server left');
    this.timer = setInterval(() => void this.fill(), this.options.pollMs ?? POLL_MS);
    this.timer.unref();
    void this.fill();
    this.deps.log.info(
      { engine: this.engine, image: this.options.image, slots: this.options.slots },
      'Taking runs',
    );
    return this.engine;
  }

  /** Takes queued runs while there is room. */
  async fill(): Promise<void> {
    if (this.filling || this.stopping || !this.engine) return;
    this.filling = true;
    try {
      while (!this.stopping && this.active.size < this.options.slots) {
        const job = await this.deps.queue.claim(this.options.worker);
        if (!job) break;
        let abort: (why: Stop) => void = () => undefined;
        const stopped = new Promise<Stop>((resolve) => {
          abort = resolve;
        });
        const done = this.handle(job, stopped).finally(() => this.active.delete(job.run.id));
        this.active.set(job.run.id, { abort, done });
      }
    } catch (e) {
      this.deps.log.error({ err: e }, 'Taking a run from the queue failed');
    } finally {
      this.filling = false;
    }
  }

  /** Stops taking runs and stops the ones going: they fail, saying the server stopped. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    for (const going of this.active.values()) going.abort('shutdown');
    await Promise.allSettled([...this.active.values()].map((g) => g.done));
    await this.probes.stop();
  }

  private async handle(job: Job, stopped: Promise<Stop>): Promise<void> {
    const { queue, log } = this.deps;
    const { run: r, token } = job;
    const say = log.child({ run: r.id, number: r.number });
    let why: Stop | undefined;
    const controller = new AbortController();
    const handled = Date.now();
    void stopped.then((s) => {
      why ??= s;
      controller.abort();
    });
    const heartbeat = setInterval(() => {
      void queue.heartbeat(r.id, token).then(
        (beat) => {
          if (!beat.ok) {
            why ??= 'lost';
            controller.abort();
          } else if (beat.cancel) {
            why ??= 'cancel';
            controller.abort();
          }
        },
        (e) => say.warn({ err: e }, 'A heartbeat failed'),
      );
    }, this.options.heartbeatMs ?? HEARTBEAT_MS);
    const timeout = setTimeout(() => {
      why ??= 'timeout';
      controller.abort();
    }, this.options.timeoutMs);

    let output: WriteStream | undefined;
    let written = 0;
    let hidden: string[] = [];
    // AFS-132: the last lines that read as an error, for a run that ends before Ansible says why.
    const errorLines: string[] = [];
    // AFS-147: targets Ansible ignored because the inventory does not have them.
    const skipped = new Set<string>();
    /** The flow's steps, once it is read: a stopped or failed run names its step. */
    let steps: Parameters<typeof titleOf>[0] = [];
    const line = (text: string) => {
      if (!output) return;
      const said = hide(stripAnsi(text), hidden).trim();
      const target = skippedTarget(said);
      if (target) skipped.add(target);
      if (ERROR_LINE.test(said)) {
        errorLines.push(said.slice(0, 300));
        if (errorLines.length > 3) errorLines.shift();
      }
      if (written > MAX_OUTPUT) return;
      // Ansible's colours are kept for the run page's terminal (AFS-96); the text download and
      // agents get plain text. A line with a secret in it is kept plain, so that no colour code
      // splitting the secret can let it through.
      const plain = stripAnsi(text);
      const safe = hide(plain, hidden);
      const shown = `${safe === plain ? text : safe}\n`;
      written += shown.length;
      const kept = written > MAX_OUTPUT ? '… the output is longer than is kept\n' : shown;
      output.write(kept);
      this.deps.hub?.publish(r.id, { kind: 'output', text: kept });
    };
    const finish = async (outcome: Outcome, error?: string, view?: RunView) => {
      if (why === 'lost') {
        say.warn('The run was given to another worker or lost: its end is not recorded here');
        return;
      }
      const ended = new Date();
      // AFS-147: the step a stopped run was in (the canvas marks it), and the targets it skipped.
      const at = outcome === 'cancelled' ? this.deps.hub?.live(r.id)?.summary?.running : undefined;
      const kept =
        view && (at || skipped.size)
          ? {
              ...view,
              ...(at ? { stoppedAt: at } : {}),
              ...(skipped.size ? { skippedTargets: [...skipped] } : {}),
            }
          : view;
      // AFS-147: a stopped run's output ends saying who stopped it and where, as its page does.
      if (outcome === 'cancelled') {
        const step = titleOf(steps, at);
        const by = (await queue.get(r.id).catch(() => undefined))?.cancelledBy;
        line(`Stopped${by ? ` by ${by}` : ' on request'}${step ? ` during ${step}` : ''}`);
      }
      const done = await queue.finish(r.id, token, outcome, error, ended, kept);
      this.deps.hub?.ended(r.id);
      // AFS-37: from the run's first start (a run that waited for approval spans several).
      const began = r.startedAt ? Date.parse(r.startedAt) : handled;
      this.deps.metrics?.runEnded(r.mode, outcome, (ended.getTime() - began) / 1000);
      if (!done) say.warn('The lease ran out before the run could be recorded');
      say.info({ outcome, ...(error ? { why: error } : {}) }, 'Run ended');
    };
    const stoppedWhy = (): [Outcome, string] => {
      if (why === 'cancel') {
        const step = titleOf(steps, this.deps.hub?.live(r.id)?.summary?.running);
        return ['cancelled', `Stopped on request${step ? ` during ${step}` : ''}`];
      }
      if (why === 'timeout')
        return [
          'failed',
          `Stopped: the run took longer than ${Math.round(this.options.timeoutMs / 60_000)} minutes`,
        ];
      return ['failed', 'The server stopped during the run'];
    };

    let workdir: Awaited<ReturnType<Workdirs['checkout']>> | undefined;
    let cleanup: (() => Promise<void>) | undefined;
    try {
      output = createWriteStream(this.outputFile(r.id), { flags: 'a', mode: 0o600 });
      const project = await getProject(this.deps.db, r.project);
      if (!project) return await finish('failed', 'The project is gone');
      line(
        `Run ${r.number} of ${r.flow.name} (${r.flow.file}) at ${r.commit.slice(0, 12)}, ${r.mode}`,
      );

      // The commit's files: the project's own folder for its branch, else one for this run.
      const lasting = r.ref === project.gitRef && r.commit === project.commit;
      workdir = await this.workdirs.checkout(project.id, r.commit, lasting, r.id);
      if (controller.signal.aborted) return await finish(...stoppedWhy());

      // The flow's code, generated fresh: the run does what the flow says at this commit.
      const text = await readFile(join(workdir.dir, ...r.flow.file.split('/')), 'utf8');
      const doc = parseFlow(text).doc;
      if (!doc) return await finish('failed', `${r.flow.file} is not a flow at this commit`);
      steps = doc.nodes;
      const errors = validateFlow(doc, schemaIssues(doc)).findings.filter(
        (f) => f.severity === 'error',
      );
      if (errors.length)
        return await finish('failed', `The flow has errors: ${errors[0]?.message}`);
      const source = posix.basename(r.flow.file);
      const code = engineFor(doc).generate(doc, { source, root: rootFromGenerated(r.flow.file) });
      if (!code.ok) {
        const first = code.findings.find((f) => f.severity === 'error');
        return await finish(
          'failed',
          `The flow's code cannot be generated: ${first?.message ?? 'see its problems'}`,
        );
      }
      const playbook = await writeGenerated(workdir.dir, r.flow.file, code);

      // Credentials: variables, the vault password, a key file, the container's environment.
      const image = r.eeImage ?? this.options.image;
      // AFS-66: a registry credential signs in and pulls the image first; reading the image's
      // user (below) already needs the image.
      const signIn = await registrySignIn(this.deps.db, this.deps.key, r.credentials);
      if (signIn && this.engine && !this.options.runner) {
        try {
          line(
            `Credential: ${await pullWithSignIn(
              this.engine,
              image,
              signIn,
              join(this.options.dataDir, 'secrets-tmp', `${r.id}-registry`),
            )}`,
          );
        } catch (e) {
          return await finish('failed', (e as Error).message);
        }
      }
      const owner = await this.ownerOf(image);
      const creds = await runCredentials(
        this.deps.db,
        this.deps.key,
        r.credentials,
        join(this.options.dataDir, 'secrets-tmp', r.id),
        owner,
      );
      cleanup = creds.cleanup;
      const inputs = { ...job.inputs, ...creds.vars };
      hidden = [
        ...creds.secrets,
        ...Object.entries(inputs)
          .filter(([name]) => /pass|secret|token|key/i.test(name))
          .map(([, v]) => String(v))
          .filter((v) => v.length >= 4),
      ];
      for (const note of creds.notes) line(`Credential: ${note}`);

      // AFS-116: the Ansible collection chistokhinsv.ansible_flow, and this server's address with a
      // token of this run (as whoever launched it, on this workspace, deciding no approval), so a
      // flow can launch or wait for another flow with no settings. Gone when the run stops.
      const collection = this.options.runner ? undefined : await this.collectionMount();
      const server = this.options.server?.();
      const serverEnv: Record<string, string> = {};
      if (server) {
        const token = await createRunToken(
          this.deps.db,
          { id: r.id, number: r.number, by: r.requestedBy.id, workspace: project.workspace },
          new Date(Date.now() + this.options.timeoutMs + 15 * 60_000),
        );
        serverEnv.AFS_URL = server.url;
        serverEnv.AFS_TOKEN = token;
        serverEnv.AFS_VALIDATE_CERTS = server.verifyTls ? 'true' : 'false';
        hidden.push(token);
        line(
          `Server for the Ansible collection: ${server.url}${server.verifyTls ? '' : ' (certificate not checked)'}, with a token of this run`,
        );
      }

      const engine = this.engine as Engine;
      const env: Environment = {
        kind: 'container',
        engine,
        image,
        options: [
          '--label',
          this.label,
          '--label',
          `afs.run=${r.id}`,
          ...creds.options,
          ...Object.keys(serverEnv).flatMap((name) => ['-e', name]),
          ...(await this.usernsOf(image)),
        ],
        mounts: [
          ...creds.mounts,
          ...(collection ? [{ src: collection, dest: COLLECTION_DEST, options: 'ro' }] : []),
        ],
        source: 'afd',
        label: `${image} (${engine})`,
      };
      line(`Environment: ${env.label}`);
      if (controller.signal.aborted) return await finish(...stoppedWhy());
      // AFS-80: the repository's Ansible config as the run's image reads it, so the run keeps its
      // callbacks and adds its library/, module_utils/, plugin folders and root group_vars.
      const readConfig =
        this.options.repoConfig ?? (this.options.runner ? undefined : repositoryConfig);
      const repoConfig = !readConfig
        ? undefined
        : await readConfig({
            engine,
            image,
            root: workdir.dir,
            probeDir: this.probeDir,
            options: ['--label', this.label, '--label', `afs.run=${r.id}`],
            ...(this.toHost ? { toHost: this.toHost } : {}),
            log: this.deps.log,
            name: `afs-config-${r.id.slice(0, 12)}-${Date.now().toString(36)}`,
          });
      if (controller.signal.aborted) return await finish(...stoppedWhy());
      const runner = this.options.runner ?? runFlow;
      const storage = join(this.options.dataDir, 'runs', project.id);
      const folder = (runId: string) => join(runsDir(storage, doc.flow.id), runId);
      const root = workdir.dir;
      let agentFailure: string | undefined;
      /** Runs one playbook of the flow: the whole flow, or one of its segments (AFS-28). */
      const runOnce = (
        runId: string,
        playbookPath: string,
        runInputs: Record<string, unknown>,
        shown: (v: RunView) => RunView,
      ) =>
        runner(
          {
            id: runId,
            startedAt: new Date().toISOString(),
            mode: r.mode,
            doc,
            code,
            env,
            environment: env.label,
            root,
            probeDir: this.probeDir,
            playbook: playbookPath,
            ...(repoConfig ? { callbacks: repoConfig } : {}),
            ...(r.inventory ? { inventory: r.inventory } : {}),
            storage,
            keepRuns: 1000,
            inputs: runInputs,
            ...(creds.vaultPassword !== undefined ? { vaultPassword: creds.vaultPassword } : {}),
            signal: controller.signal,
          },
          {
            report: (v) => this.deps.hub?.publish(r.id, { kind: 'view', view: shown(v) }),
            log: line,
            // The engine gets the container's variables in its own environment, not as arguments.
            execute: async (spec, processEnv) => {
              // Ansible in the image writes its events into the run's folder: as its own user,
              // which is not the server's when the server runs as root (found on the lab VM).
              if (owner) await chown(folder(runId), owner.uid, owner.gid);
              // The key's agent script says why it stopped before Ansible: that is the run's error.
              const said = (text: string) => {
                const failure = AGENT_FAILURES.find((f) => text.includes(f));
                if (failure) agentFailure = failure;
                line(text);
              };
              return startProcess(
                { ...spec, args: withLimit(rewriteMounts(spec.args, this.toHost), r.limit) },
                { ...processEnv, ...creds.processEnv, ...serverEnv },
                said,
              );
            },
          },
        );
      /** How a run that has ended is recorded, from the view of how it went. */
      const ended = async (view: RunView, whole = false, decided?: string) => {
        if (why) return await finish(...stoppedWhy(), view);
        // AFS-133: hosts that failed after a rejection (or a timeout) failed because of it: the
        // run says who decided and what they said, not Ansible's exit code.
        if (decided && !(view.state === 'done' && view.rc === 0 && !view.error))
          return await finish('failed', decided, view);
        if (agentFailure) return await finish('failed', agentFailure, view);
        // AFS-132: no events, and the container said why (an image that cannot be pulled, an
        // engine error): that is the reason, not "no events".
        // AFS-147: no host to target says which targets or limit left none, not Ansible's words.
        if (view.error === NO_EVENTS && errorLines.some((l) => NO_HOSTS.test(l)))
          return await finish('failed', noHostWhy({ ...r, skipped: [...skipped] }), view);
        if (view.error === NO_EVENTS && errorLines.length)
          return await finish('failed', `${NO_EVENTS}: ${errorLines.at(-1)}`, view);
        // AFS-132: a run that reached no host did nothing: not a success.
        if (view.state === 'done' && view.rc === 0 && !view.error && whole && noHostRan(view))
          return await finish('failed', noHostWhy({ ...r, skipped: [...skipped] }), view);
        // Without events nothing says what the flow did: that is not a success, whatever the code.
        if (view.state === 'done' && view.rc === 0 && !view.error)
          return await finish('succeeded', undefined, view);
        if (view.state === 'done' && view.error) return await finish('failed', view.error, view);
        // AFS-147: "1 of 4 hosts failed at Pre-checks", not the exit code.
        if (view.state === 'done')
          return await finish('failed', failedWhy(view, steps, view.rc), view);
        return await finish('failed', view.error ?? 'The run could not be started', view);
      };

      // AFS-111: a check (skeleton) run changes nothing, so it asks nobody: the whole playbook
      // runs once and its approvals pass by themselves, as a skeleton run in VS Code does.
      const check = r.mode === 'check';
      if (check && hasApproval(doc.nodes))
        line('Check run: approvals pass by themselves; a real run waits for the approvers');
      const segments = check ? [] : (code.segments ?? []);
      // A flow with approvals that cannot be split would run with every approval passed by
      // itself, as a local run does: here a person must decide, so it does not run.
      if (!check && segments.length === 0 && hasApproval(doc.nodes)) {
        const why = code.findings.find((f) => f.code === 'codegen-segments');
        return await finish(
          'failed',
          `The flow's approvals cannot wait for a person: ${why?.message ?? 'they are not on the top level, one at a time'}`,
        );
      }
      if (segments.length === 0) {
        const runId = runName(r);
        if (!(await queue.start(r.id, token, new Date(), folder(runId)))) {
          why ??= 'lost';
          return;
        }
        this.deps.hub?.publish(r.id, { kind: 'state' });
        return await ended(await runOnce(runId, playbook, inputs, (v) => v), true);
      }

      // AFS-28: a flow with approvals runs segment by segment. Where this run is: at the start,
      // or after the gate decided last (a resumed run).
      const gate = await lastGate(this.deps.db, r.id);
      if (gate?.status === 'waiting') {
        // Taken while it still waits (it should not be): it goes back to waiting.
        await queue.wait(r.id, token);
        return;
      }
      const decision: GateDecision | undefined = !gate
        ? undefined
        : gate.status === 'approved'
          ? 'approved'
          : gate.status === 'timed out'
            ? 'timeout'
            : 'rejected';
      let segment = gate
        ? nextSegment(segments, gate.segment, decision as GateDecision)
        : segments.find((g) => g.name === 'start');
      let segInputs = gate ? segmentInputs(inputs, gate.carried, decision) : inputs;
      let decidedAgainst: string | undefined;
      if (gate) {
        const by = gate.decidedBy ? ` by ${gate.decidedBy}` : '';
        const said = gate.comment ? `: ${gate.comment}` : '';
        line(`Approval ${gate.node.title}: ${gate.status}${by}${said}`);
        if (gate.status === 'rejected')
          decidedAgainst = `Rejected at ${gate.node.title}${by}${said}`;
        else if (gate.status === 'timed out')
          decidedAgainst = `Nobody decided ${gate.node.title} in time`;
      }
      const generated = posix.dirname(playbook);
      const eventsOf = async (dirs: string[]) =>
        Promise.all(dirs.map((d) => readFile(join(d, 'events.jsonl'), 'utf8').catch(() => '')));
      const before = await queue.segments(r.id);
      while (segment) {
        const current = segment;
        const runId = runName(r, current.name);
        if (!(await queue.addSegment(r.id, token, { name: current.name, dir: folder(runId) }))) {
          why ??= 'lost';
          return;
        }
        this.deps.hub?.publish(r.id, { kind: 'state' });
        line(`Segment ${current.name}`);
        const earlier = segmentsSummary(await eventsOf(before.map((b) => b.dir)), code.routes);
        const approvals = approvalsOf(await gatesOf(this.deps.db, r.id));
        const withApprovals = Object.keys(approvals).length ? { approvals } : {};
        // What the canvas shows while a segment runs: the segments before it, and this one.
        // AFS-132: until the segment has a summary of its own, the earlier ones' stays shown.
        const view = await runOnce(runId, `${generated}/${current.file}`, segInputs, (v) => ({
          ...v,
          summary: v.summary ? mergeSummaries(earlier, v.summary) : earlier,
          ...withApprovals,
        }));
        before.push({ name: current.name, dir: folder(runId) });
        const text = (await eventsOf([folder(runId)]))[0] ?? '';
        const outcome = segmentOutcome(current, text);
        const whole: RunView = {
          ...view,
          summary: segmentsSummary(await eventsOf(before.map((b) => b.dir)), code.routes),
          ...withApprovals,
        };
        if (why) return await finish(...stoppedWhy(), whole);
        if (current.gate && outcome.empty) {
          line('No host reached the approval: it is skipped');
          segment = nextSegment(segments, current.name, 'empty');
          segInputs = segmentInputs(inputs, outcome.carried);
          continue;
        }
        if (current.gate && outcome.waiting) {
          const node = doc.nodes.find((n) => n.id === current.gate);
          const seconds = durationSeconds(node?.settings?.timeout);
          const opened = await openGate(this.deps.db, {
            run: r.id,
            node: {
              id: current.gate,
              key: node?.key ?? current.gate,
              title: node?.title ?? 'Approval',
            },
            segment: current.name,
            carried: outcome.carried,
            ...(seconds ? { deadline: new Date(Date.now() + seconds * 1000) } : {}),
            ...(node?.approval ? { approval: node.approval } : {}),
          });
          const waiting: RunView = {
            ...whole,
            state: 'running',
            approvals: approvalsOf(await gatesOf(this.deps.db, r.id)),
          };
          await queue.saveView(r.id, waiting);
          if (!(await queue.wait(r.id, token))) {
            why ??= 'lost';
            return;
          }
          const until = opened.deadline ? ` (until ${opened.deadline})` : '';
          line(`Waiting for approval: ${opened.node.title}${until}`);
          this.deps.hub?.publish(r.id, { kind: 'view', view: waiting });
          // AFS-147: the run is not going here any more: its view is the record's from now on,
          // so a stop while it waits (which writes the record) is what the canvas shows.
          this.deps.hub?.ended(r.id);
          say.info({ gate: opened.node.key }, 'Run waits for approval');
          this.deps.approvalWaiting?.(r.id, opened.id);
          return;
        }
        if (current.gate)
          return await finish(
            'failed',
            view.error ?? `The segment ${current.name} ended before its hosts reached the approval`,
            whole,
          );
        return await ended(whole, false, decidedAgainst);
      }
      return await finish('failed', 'The flow has no segment to run next');
    } catch (e) {
      const message =
        e instanceof CredentialProblem || e instanceof Error
          ? e.message
          : 'The run could not be prepared';
      line(`Error: ${message}`);
      say.error({ err: e }, 'A run failed before Ansible ran');
      await finish(...(why ? stoppedWhy() : (['failed', message] as [Outcome, string]))).catch(
        (f) => say.error({ err: f }, 'Recording the run failed'),
      );
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      // AFS-116: the run's token ends with this turn (a run waiting for a person gets a new one).
      await revokeRunTokens(this.deps.db, r.id).catch(() => undefined);
      await cleanup?.().catch(() => undefined);
      await workdir?.release().catch(() => undefined);
      await new Promise<void>((resolve) => (output ? output.end(resolve) : resolve()));
    }
  }
}

/** A live segment's summary added to what the segments before it did. */
function mergeSummaries(
  earlier: NonNullable<RunView['summary']>,
  live: NonNullable<RunView['summary']>,
): NonNullable<RunView['summary']> {
  const nodes: typeof earlier.nodes = structuredClone(earlier.nodes);
  for (const [node, ports] of Object.entries(live.nodes))
    for (const [port, hosts] of Object.entries(ports)) {
      nodes[node] ??= {};
      const into = nodes[node] as Record<string, string[]>;
      into[port] = [...new Set([...(into[port] ?? []), ...hosts])];
    }
  return {
    ...live,
    nodes,
    hosts: [...new Set([...earlier.hosts, ...live.hosts])],
    failures: [...earlier.failures, ...live.failures],
    outcome: { ...earlier.outcome, ...live.outcome },
    unreachable: [...new Set([...earlier.unreachable, ...live.unreachable])],
  };
}

/** True when the flow has an approval anywhere, inner levels included. */
function hasApproval(nodes: readonly { type: string; subflow?: { nodes?: unknown[] } }[]): boolean {
  return nodes.some(
    (n) =>
      n.type === 'approval' ||
      hasApproval((n.subflow?.nodes ?? []) as { type: string; subflow?: { nodes?: unknown[] } }[]),
  );
}
