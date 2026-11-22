// `GitService.commonDir` and `worktreeList` against a REAL git (E42 step 1,
// #1637): the primary checkout and a linked worktree must answer the same
// common dir (that is the whole project key), paths come back native, and a
// folder outside any repo answers null rather than throwing.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { GitService } from './git-service';
import { pathKey } from '../../shared/projects';
import { tempDir } from '../../test-temp-dirs';

const svc = new GitService();
let repo: string;
let linked: string;
let plain: string;

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
};

beforeAll(() => {
  const root = tempDir('sb-wtread-');
  repo = path.join(root, 'repo');
  linked = path.join(root, 'repo-wt');
  plain = tempDir('sb-plain-');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', linked);
});

describe('GitService worktree reads', () => {
  it('gives the primary checkout and a linked worktree the same common dir', async () => {
    const a = await svc.commonDir(repo);
    const b = await svc.commonDir(linked);
    fs.mkdirSync(path.join(linked, 'src'), { recursive: true });
    const sub = await svc.commonDir(path.join(linked, 'src')); // and from inside it
    expect(a).not.toBeNull();
    expect(pathKey(a!)).toBe(pathKey(b!));
    expect(pathKey(sub!)).toBe(pathKey(a!));
    expect(path.isAbsolute(a!)).toBe(true);
  });

  it('lists both worktrees, primary first, in native path form', async () => {
    const list = await svc.worktreeList(linked);
    expect(list).not.toBeNull();
    // git answers the LONG spelling of a folder; the runner's temp dir is an
    // 8.3 short name (`RUNNER~1`), so compare against the real path
    const real = (p: string): string => pathKey(fs.realpathSync.native(p));
    expect(list!.map((w) => pathKey(w.path))).toEqual([real(repo), real(linked)]);
    expect(list![0]).toMatchObject({ primary: true, branch: 'main' });
    expect(list![1]).toMatchObject({ primary: false, branch: 'feat/x' });
    if (process.platform === 'win32') expect(list![0].path).not.toContain('/');
  });

  it('answers null outside any repo', async () => {
    expect(await svc.commonDir(plain)).toBeNull();
    expect(await svc.worktreeList(plain)).toBeNull();
  });
});
