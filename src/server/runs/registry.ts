// A run's image from a private registry (AFS-66): before the run, the engine signs in with the
// run's registry credential and pulls the image, with a configuration folder of the run's own
// (docker `--config`, podman `--authfile`), removed right after. The password goes to the engine
// on its input, never as an argument; the engine's own stored sign-ins are not touched.
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Engine } from './executor';

export interface RegistrySignIn {
  name: string;
  host: string;
  username: string;
  password: string;
}

/** The registry an image comes from: its first part when that names a host; else Docker Hub. */
export function registryOf(image: string): string {
  const first = image.split('/')[0] ?? '';
  return image.includes('/') && (/[.:]/.test(first) || first === 'localhost') ? first : 'docker.io';
}

/** Runs the engine with `input` on its standard input; resolves with its code and what it said. */
function engine(
  command: Engine,
  args: string[],
  input: string | undefined,
  timeoutMs: number,
): Promise<{ code: number; said: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let said = '';
    const keep = (b: Buffer) => {
      if (said.length < 4000) said += b.toString('utf8');
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, said: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 137, said });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });
}

/**
 * Signs in to the image's registry with `signIn` and pulls the image. Resolves with a line for the
 * run's log; rejects with why it could not, the password never in it.
 */
export async function pullWithSignIn(
  command: Engine,
  image: string,
  signIn: RegistrySignIn,
  dir: string,
  timeoutMs = 30 * 60_000,
): Promise<string> {
  const host = registryOf(image);
  const wanted = signIn.host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (wanted !== host && !(host === 'docker.io' && /(^|\.)docker\.io$/.test(wanted)))
    return `registry "${signIn.name}" is for ${wanted}; the image is from ${host}: not used`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const clean = (text: string) =>
    text.split(signIn.password).join('***').trim().split('\n').at(-1) ?? '';
  try {
    const where = command === 'podman' ? ['--authfile', join(dir, 'auth.json')] : ['--config', dir];
    // docker takes --config before the command; podman takes --authfile after it.
    const login =
      command === 'podman'
        ? ['login', ...where, '--username', signIn.username, '--password-stdin', wanted]
        : [...where, 'login', '--username', signIn.username, '--password-stdin', wanted];
    const signedIn = await engine(command, login, signIn.password, 120_000);
    if (signedIn.code !== 0)
      throw new Error(
        `Signing in to ${wanted} as ${signIn.username} failed: ${clean(signedIn.said)}`,
      );
    const pull = command === 'podman' ? ['pull', ...where, image] : [...where, 'pull', image];
    const pulled = await engine(command, pull, undefined, timeoutMs);
    if (pulled.code !== 0) throw new Error(`The image could not be pulled: ${clean(pulled.said)}`);
    return `registry "${signIn.name}": signed in to ${wanted} as ${signIn.username}, image pulled`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
