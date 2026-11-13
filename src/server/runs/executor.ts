// The server's own worker: takes runs from the queue and runs them with Ansible in an execution
// environment container, through the designer's own run pipeline (runFlow), so a run here does
// what the same run does from VS Code.
//
// For each run: check out the commit, generate the flow's code fresh, hand over the
// credentials, start the run, keep the lease alive (and stop when someone cancels, the lease is
// lost or the run takes too long), say how it ended, clean up.
import { execFile } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { chown, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineFor } from '@ansible-flow/core/engine/engines';
import { parseFlow } from '@ansible-flow/core/flow/document';
import { validateFlow } from '@ansible-flow/core/flow/validate';
import type { RunView } from '@ansible-flow/core/protocol';
import { stripAnsi } from '@ansible-flow/core/run/ansi';
import type { Environment } from '@ansible-flow/core/run/environment';
import { REDACTED } from '@ansible-flow/core/run/redact';
import { startProcess } from '@ansible-flow/node/run/exec';
import { stamp } from '@ansible-flow/node/run/ids';
import { runsDir } from '@ansible-flow/node/run/pastRuns';
import { type RunFlowHooks, type RunFlowRequest, runFlow } from '@ansible-flow/node/run/runFlow';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { schemaIssues } from '../flows';
import type { Logger } from '../log';
import type { Git } from '../projects/git';
import { getProject } from '../projects/store';
import type { ProjectSync } from '../projects/sync';
import type { MasterKey } from '../secrets/masterKey';
import { CredentialProblem, runCredentials } from './credentials';
import type { RunHub } from './hub';
import type { Job, Outcome, RunQueue } from './queue';
import { rootFromGenerated, Workdirs, writeGenerated } from './workdir';

/** How often the worker says it still has a run. */
export const HEARTBEAT_MS = 15_000;
/** How often it looks for queued runs. */
const POLL_MS = 2_000;
/** A run's output is kept up to this size. */
const MAX_OUTPUT = 20 * 1024 * 1024;
/** The image when neither the launch nor the settings name one: what the designer proposes. */
export const DEFAULT_IMAGE = 'ghcr.io/ansible/community-ansible-dev-tools:latest';

export type Engine = 'docker' | 'podman';

export interface ExecutorOptions {
  dataDir: string;
  /** The container engine; `auto` finds docker, else podman; `off` runs nothing. */
  engine: Engine | 'auto' | 'off';
  /** The image a run uses unless it names its own. */
  image: string;
  /** This worker's name in the queue (a server's instance id). */
  worker: string;
  /** Runs at once on this worker. */
  slots: number;
  /** A run that takes longer is stopped. */
  timeoutMs: number;
  /** Tests: what runs the flow instead of the designer's pipeline. */
  runner?: (request: RunFlowRequest, hooks: RunFlowHooks) => Promise<RunView>;
  /** Tests: how often the lease is kept alive. */
  heartbeatMs?: number;
  pollMs?: number;
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
}

/** Why a run was stopped from outside. */
type Stop = 'cancel' | 'lost' | 'timeout' | 'shutdown';

const run = (command: string, args: string[], timeoutMs = 15_000) =>
  new Promise<string>((resolve, reject) =>
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    ),
  );

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
  private readonly workdirs: Workdirs;
  private readonly probeDir: string;
  private readonly outputDir: string;
  /** The user each image runs as, found once. */
  private readonly owners = new Map<string, Promise<{ uid: number; gid: number } | undefined>>();

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly options: ExecutorOptions,
  ) {
    this.workdirs = new Workdirs(join(options.dataDir, 'work'), deps.git, deps.sync);
    this.probeDir = join(options.dataDir, 'probe');
    this.outputDir = join(options.dataDir, 'output');
  }

  /**
   * The user an image runs as, when the server may give files to it (it runs as root): what the
   * run's key file must belong to. Undefined otherwise.
   */
  private ownerOf(image: string): Promise<{ uid: number; gid: number } | undefined> {
    if (this.options.runner || process.getuid?.() !== 0 || !this.engine)
      return Promise.resolve(undefined);
    let found = this.owners.get(image);
    if (!found) {
      const engine = this.engine;
      found = Promise.all([
        run(engine, ['run', '--rm', '--entrypoint', 'id', image, '-u'], 120_000),
        run(engine, ['run', '--rm', '--entrypoint', 'id', image, '-g'], 120_000),
      ]).then(
        ([u, g]) =>
          /^\d+$/.test(u) && /^\d+$/.test(g) ? { uid: Number(u), gid: Number(g) } : undefined,
        () => undefined,
      );
      this.owners.set(image, found);
    }
    return found;
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
    // Containers mount files from the data folder only: when the server itself runs in a
    // container, that folder is the one shared with the engine at the same path.
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
  }

  private async handle(job: Job, stopped: Promise<Stop>): Promise<void> {
    const { queue, log } = this.deps;
    const { run: r, token } = job;
    const say = log.child({ run: r.id, number: r.number });
    let why: Stop | undefined;
    const controller = new AbortController();
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
    const line = (text: string) => {
      if (!output) return;
      if (written > MAX_OUTPUT) return;
      // Plain text: colours are for a terminal, and the page shows its own.
      const shown = `${hide(stripAnsi(text), hidden)}\n`;
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
      const done = await queue.finish(r.id, token, outcome, error, new Date(), view);
      this.deps.hub?.ended(r.id);
      if (!done) say.warn('The lease ran out before the run could be recorded');
      say.info({ outcome, ...(error ? { why: error } : {}) }, 'Run ended');
    };
    const stoppedWhy = (): [Outcome, string] => {
      if (why === 'cancel') return ['cancelled', 'Stopped on request'];
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

      const engine = this.engine as Engine;
      const env: Environment = {
        kind: 'container',
        engine,
        image,
        options: ['--label', this.label, '--label', `afs.run=${r.id}`, ...creds.options],
        mounts: creds.mounts,
        source: 'afd',
        label: `${image} (${engine})`,
      };
      line(`Environment: ${env.label}`);
      if (controller.signal.aborted) return await finish(...stoppedWhy());
      let last: RunView | undefined;
      const runner = this.options.runner ?? runFlow;
      const runId = `${stamp()}-${r.number}`;
      const storage = join(this.options.dataDir, 'runs', project.id);
      if (
        !(await queue.start(r.id, token, new Date(), join(runsDir(storage, doc.flow.id), runId)))
      ) {
        why ??= 'lost';
        return;
      }
      this.deps.hub?.publish(r.id, { kind: 'state' });
      const view = await runner(
        {
          id: runId,
          startedAt: new Date().toISOString(),
          mode: r.mode,
          doc,
          code,
          env,
          environment: env.label,
          root: workdir.dir,
          probeDir: this.probeDir,
          playbook,
          ...(r.inventory ? { inventory: r.inventory } : {}),
          storage,
          keepRuns: 1000,
          inputs,
          ...(creds.vaultPassword !== undefined ? { vaultPassword: creds.vaultPassword } : {}),
          signal: controller.signal,
        },
        {
          report: (v) => {
            last = v;
            this.deps.hub?.publish(r.id, { kind: 'view', view: v });
          },
          log: line,
          // The engine gets the container's variables in its own environment, not as arguments.
          execute: async (spec, processEnv) => {
            // Ansible in the image writes its events into the run's folder: as its own user,
            // which is not the server's when the server runs as root (found on the lab VM).
            if (owner)
              await chown(join(runsDir(storage, doc.flow.id), runId), owner.uid, owner.gid);
            return startProcess(spec, { ...processEnv, ...creds.processEnv }, line);
          },
        },
      );
      last = view;
      if (why) return await finish(...stoppedWhy(), view);
      // Without events nothing says what the flow did: that is not a success, whatever the code.
      if (view.state === 'done' && view.rc === 0 && !view.error)
        return await finish('succeeded', undefined, view);
      if (view.state === 'done' && view.error) return await finish('failed', view.error, view);
      if (view.state === 'done') {
        const failedHosts = Object.keys(view.summary?.outcome ?? {}).length;
        return await finish(
          'failed',
          `ansible-playbook ended with ${view.rc}${failedHosts ? `; ${failedHosts} host(s) failed` : ''}`,
          view,
        );
      }
      return await finish('failed', view.error ?? 'The run could not be started', last);
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
      await cleanup?.().catch(() => undefined);
      await workdir?.release().catch(() => undefined);
      await new Promise<void>((resolve) => (output ? output.end(resolve) : resolve()));
    }
  }
}
