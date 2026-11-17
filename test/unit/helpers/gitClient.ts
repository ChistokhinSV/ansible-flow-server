// AFS-81: the git client of the tests, as a person runs it at their own machine (none of this
// machine's settings), bounded so that a slow server fails one test and leaves nothing behind.
//
// Under a loaded machine a clone or push could outlast the test (30 s) while the client waited up
// to 60 s. The test failed, its client went on, and on Windows killing `git.exe` left its
// `git-remote-http` child holding the connection: the server's close waited for it, and the
// file's later tests failed in teardown. Now the client gives up before the test does, a stalled
// transfer ends by itself (git's low-speed limit), and a timeout ends the whole process tree.
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';

/** Below the server project's test timeout (vitest.config.ts), so the test sees why. */
export const CLIENT_TIMEOUT_MS = 25_000;

export interface ClientResult {
  ok: boolean;
  out: string;
  err: string;
}

/** Ends a process and every process it started (`git` runs `git-remote-http` and others). */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32')
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
}

/**
 * `git <args>` in `cwd` as Lena Brandt, with no credential helper or prompt; `configDir` holds
 * the client's own global config file.
 */
export function gitClient(
  configDir: string,
  cwd: string,
  ...args: string[]
): Promise<ClientResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-c', 'credential.helper=', '-c', 'core.autocrlf=false', ...args],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: join(configDir, 'client-config'),
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
          GCM_INTERACTIVE: 'never',
          // A transfer under 1 KB/s for 15 s ends (git's own check, in git-remote-http).
          GIT_HTTP_LOW_SPEED_LIMIT: '1000',
          GIT_HTTP_LOW_SPEED_TIME: '15',
          GIT_AUTHOR_NAME: 'Lena Brandt',
          GIT_AUTHOR_EMAIL: 'lena@example.net',
          GIT_COMMITTER_NAME: 'Lena Brandt',
          GIT_COMMITTER_EMAIL: 'lena@example.net',
        },
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        resolve({
          ok: !error,
          out: stdout.trim(),
          err: timedOut ? `git ${args[0]} took over ${CLIENT_TIMEOUT_MS} ms` : stderr.trim(),
        });
      },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, CLIENT_TIMEOUT_MS);
  });
}
