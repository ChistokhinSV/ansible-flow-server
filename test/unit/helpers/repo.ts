// A git repository for tests: a folder with commits, as a team's repository would be.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TestRepo {
  /** The folder; its address as a project's source. */
  dir: string;
  /** Writes files and commits them on the current branch; gives the commit. */
  commit(files: Record<string, string>, message?: string): string;
  /** Makes a branch at the current commit and moves to it. */
  branch(name: string): void;
  checkout(name: string): void;
  deleteBranch(name: string): void;
  remove(): void;
}

export function testRepo(
  first: Record<string, string> = { 'README.md': 'A test repository\n' },
): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), 'afs-repo-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        // The tests' commits are the same on every machine: nobody's own settings or name.
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(dir, '.git', 'test-config'),
        GIT_AUTHOR_NAME: 'Dana Whitfield',
        GIT_AUTHOR_EMAIL: 'dana@example.net',
        GIT_COMMITTER_NAME: 'Dana Whitfield',
        GIT_COMMITTER_EMAIL: 'dana@example.net',
      },
    }).trim();
  const repo: TestRepo = {
    dir,
    commit(files, message = 'Change') {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      git('add', '--all');
      git('commit', '--quiet', '--allow-empty', '-m', message);
      return git('rev-parse', 'HEAD');
    },
    branch: (name) => void git('checkout', '--quiet', '-b', name),
    checkout: (name) => void git('checkout', '--quiet', name),
    deleteBranch: (name) => void git('branch', '--quiet', '-D', name),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', dir]);
  // Files are committed byte for byte, whatever this machine's git would do with line ends.
  git('config', 'core.autocrlf', 'false');
  repo.commit(first, 'First commit');
  return repo;
}
