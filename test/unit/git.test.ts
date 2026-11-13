// The git layer against real repositories on this machine.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Git, GitError, gitUrlProblem, refProblem } from '../../src/server/projects/git';
import { type TestRepo, testRepo } from './helpers/repo';

describe('which addresses the server fetches from', () => {
  it('https, ssh and git@host:path', () => {
    for (const url of [
      'https://git.example.net/network/flows.git',
      'ssh://git@git.example.net:2222/network/flows.git',
      'git@git.example.net:network/flows.git',
    ])
      expect(gitUrlProblem(url, false), url).toBeUndefined();
  });

  it('never a password in the address, plain http, or something that reads as an option', () => {
    expect(gitUrlProblem('https://dana:s3cret@git.example.net/flows.git', false)).toMatch(
      /password/,
    );
    expect(gitUrlProblem('http://git.example.net/flows.git', false)).toMatch(/https or ssh/);
    expect(gitUrlProblem('--upload-pack=touch /tmp/x', false)).toBeTruthy();
    expect(gitUrlProblem('-oProxyCommand=x', false)).toMatch(/dash/);
    expect(gitUrlProblem('ext::sh -c whoami', false)).toBeTruthy();
    expect(gitUrlProblem('', false)).toBeTruthy();
    expect(gitUrlProblem('git.example.net/flows', false)).toBeTruthy();
  });

  it('a folder of this machine only when the settings allow it', () => {
    const folder = process.platform === 'win32' ? 'C:\\repos\\flows' : '/srv/repos/flows';
    expect(gitUrlProblem(folder, false)).toMatch(/AFS_GIT_LOCAL/);
    expect(gitUrlProblem(folder, true)).toBeUndefined();
    expect(gitUrlProblem('file:///srv/repos/flows', false)).toMatch(/AFS_GIT_LOCAL/);
    expect(gitUrlProblem('file:///srv/repos/flows', true)).toBeUndefined();
  });

  it('a branch name is a name, not an option or a range', () => {
    for (const ref of ['main', 'release/2026.11', 'feature_x-1'])
      expect(refProblem(ref)).toBeUndefined();
    for (const ref of ['', '-x', 'a..b', 'a b', 'main^{commit}', 'x.lock', 'a//b', 'a/'])
      expect(refProblem(ref), ref).toBeTruthy();
  });
});

describe('a mirror of a repository', () => {
  const reposDir = mkdtempSync(join(tmpdir(), 'afs-mirrors-'));
  const git = new Git({ reposDir, allowLocal: true });
  let repo: TestRepo;
  let first: string;

  beforeAll(() => {
    repo = testRepo({
      'README.md': 'Network automation\n',
      'flows/os-upgrade/os-upgrade.flow.yaml': 'schema_version: 2\r\nflow: {}\r\n',
      'inventory/lab.ini': '[edge]\nsw01\n',
    });
    first = repo.commit({}, 'Nothing new');
  });
  afterAll(() => {
    repo.remove();
    rmSync(reposDir, { recursive: true, force: true });
  });

  it('is made at the first look and says which commit the branch is at', async () => {
    expect(await git.sync('p1', repo.dir, 'main')).toBe(first);
    expect(existsSync(join(git.mirror('p1'), 'HEAD'))).toBe(true);
    expect(await git.branches('p1')).toEqual(['main']);
  });

  it('lists the files of a commit and reads one byte for byte', async () => {
    expect(await git.files('p1', first)).toEqual([
      'README.md',
      'flows/os-upgrade/os-upgrade.flow.yaml',
      'inventory/lab.ini',
    ]);
    const flow = await git.read('p1', first, 'flows/os-upgrade/os-upgrade.flow.yaml');
    // The line ends are the file's own.
    expect(flow?.toString('utf8')).toBe('schema_version: 2\r\nflow: {}\r\n');
    expect(await git.read('p1', first, 'no/such/file')).toBeUndefined();
    await expect(git.read('p1', first, '../outside')).rejects.toBeInstanceOf(GitError);
    await expect(git.read('p1', 'main', 'README.md')).rejects.toThrow(/Not a commit/);
    expect(await git.commitInfo('p1', first)).toMatchObject({
      author: 'Dana Whitfield',
      subject: 'Nothing new',
    });
  });

  it('follows new commits, new branches and deleted branches', async () => {
    const second = repo.commit({ 'README.md': 'Network automation, edited\n' }, 'Edit');
    expect(await git.sync('p1', repo.dir, 'main')).toBe(second);
    // The commit before is still readable: a run that pinned it can be read later.
    expect((await git.read('p1', first, 'README.md'))?.toString()).toBe('Network automation\n');
    expect((await git.read('p1', second, 'README.md'))?.toString()).toBe(
      'Network automation, edited\n',
    );

    repo.branch('staging');
    const staged = repo.commit({ 'staging.txt': 'x\n' }, 'On staging');
    repo.checkout('main');
    expect(await git.sync('p1', repo.dir, 'staging')).toBe(staged);
    expect(await git.branches('p1')).toEqual(['main', 'staging']);

    repo.deleteBranch('staging');
    await expect(git.sync('p1', repo.dir, 'staging')).rejects.toThrow(
      /no branch staging \(it has main\)/,
    );
    expect(await git.branches('p1')).toEqual(['main']);
  });

  it('says why a source cannot be read, without waiting for anyone to type', async () => {
    const missing = join(reposDir, 'not-a-repository');
    await expect(git.sync('p2', missing, 'main')).rejects.toBeInstanceOf(GitError);
    // An address the settings do not allow is refused before git is asked.
    const strict = new Git({ reposDir, allowLocal: false });
    await expect(strict.sync('p3', repo.dir, 'main')).rejects.toThrow(/AFS_GIT_LOCAL/);
    await expect(git.sync('p4', '--upload-pack=x', 'main')).rejects.toThrow(/dash/);
    await expect(git.sync('../p5', repo.dir, 'main')).rejects.toThrow(/Not a project id/);
  });

  it('does not use the settings of the machine or its user', async () => {
    // The file git is pointed at instead of them is empty.
    expect(readFileSync(join(reposDir, 'gitconfig'), 'utf8')).toBe('');
  });
});
