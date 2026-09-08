import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { GitService } from './git-service';
import { tempDir } from '../../test-temp-dirs';

let repo: string;
let plain: string;
const svc = new GitService();

function sh(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

beforeAll(() => {
  // Both live for the whole FILE — every test shares this one repo — so there
  // is deliberately no `afterEach` sweep here (it would delete them under the
  // remaining tests). `test-setup.ts`'s `afterAll` net takes them (#213).
  repo = tempDir('sb-git-');
  plain = tempDir('sb-plain-');
  sh(repo, ['init', '-b', 'main']);
  sh(repo, ['config', 'user.email', 'test@test']);
  sh(repo, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  sh(repo, ['add', '.']);
  sh(repo, ['commit', '-m', 'init']);
  // 30 s rather than vitest's 10 s hook default: six git processes, and #512
  // is what git under a runner's load costs: 7123 ms for a test that runs
  // in well under a second locally.
}, 30_000);

describe('GitService.status', () => {
  it('is graceful for non-repos (the done-when)', async () => {
    const s = await svc.status(plain);
    expect(s).toEqual({ isRepo: false, files: [] });
  });

  it('parses branch, staged/unstaged/untracked', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\n'); // unstaged mod
    fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n'); // untracked
    fs.writeFileSync(path.join(repo, 'c.txt'), 'staged\n');
    sh(repo, ['add', 'c.txt']);

    const s = await svc.status(repo);
    expect(s.isRepo).toBe(true);
    expect(s.branch).toBe('main');
    const by = Object.fromEntries(s.files.map((f) => [f.path, f]));
    expect(by['a.txt']).toMatchObject({ unstaged: true, staged: false, untracked: false });
    expect(by['b.txt']).toMatchObject({ untracked: true });
    expect(by['c.txt']).toMatchObject({ staged: true, unstaged: false });
  });
  // Same ceiling as the hook, for the same reason (#512): every case in this
  // suite runs git in a child process.
}, 30_000);

describe('GitService.diff (P2-E11-01)', () => {
  it('is graceful for non-repos, like the rest of this service', async () => {
    expect(await svc.diff(plain)).toEqual({ isRepo: false, text: '' });
  });

  it('includes BOTH staged and unstaged changes, and excludes untracked files', async () => {
    // Leans on the state `status`' test above leaves behind, as `fileVersions`
    // already does: a.txt modified-unstaged, c.txt staged, b.txt untracked.
    const d = await svc.diff(repo);
    expect(d.isRepo).toBe(true);
    // `HEAD` rather than a bare `git diff` is the whole reason this passes:
    // a sibling agent asking "what have you changed" means everything not
    // committed, and plain `git diff` omits whatever the other session staged.
    expect(d.text).toContain('a.txt');
    expect(d.text).toContain('c.txt');
    // Untracked is NOT in a diff, and asserting the absence is the half that
    // would otherwise rot silently if someone reached for `--no-index` or added
    // an `--untracked` flag for convenience.
    expect(d.text).not.toContain('b.txt');
    expect(d.text).toContain('+TWO');
  });

  it('a repo with NO COMMITS reports its staged files, not a clean tree', async () => {
    // `git diff HEAD` in a repo with an unborn HEAD does not return nothing —
    // it fails with `fatal: ambiguous argument 'HEAD'`, which the first version
    // of `diff()` swallowed into `{ isRepo: true, text: '' }`. A session that
    // had just scaffolded a whole project and staged it answered "I have
    // changed nothing": a confident wrong answer, which is the one failure mode
    // this query path exists to avoid.
    const unborn = tempDir('sb-git-unborn-');
    sh(unborn, ['init', '-b', 'main']);
    sh(unborn, ['config', 'user.email', 'test@test']);
    sh(unborn, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(unborn, 'scaffold.txt'), 'a whole new project\n');
    sh(unborn, ['add', '.']);

    const d = await svc.diff(unborn);
    expect(d.isRepo).toBe(true);
    expect(d.text).toContain('scaffold.txt');
    expect(d.text).toContain('+a whole new project');
  });

  it('does NOT run a repo-configured external diff driver', async () => {
    // `--no-textconv` alone does not stop this — it disables textconv filters
    // only, and `diff.external` still executes. `--no-ext-diff` is the flag
    // that does. It matters here more than anywhere else in this service,
    // because #764 points this at a folder another agent controls.
    const hostile = tempDir('sb-git-hostile-');
    sh(hostile, ['init', '-b', 'main']);
    sh(hostile, ['config', 'user.email', 'test@test']);
    sh(hostile, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(hostile, 'f.txt'), 'one\n');
    sh(hostile, ['add', '.']);
    sh(hostile, ['commit', '-m', 'init']);
    fs.writeFileSync(path.join(hostile, 'f.txt'), 'two\n');
    sh(hostile, ['config', 'diff.external', 'sh -c "echo PWNED-EXTERNAL-DIFF-RAN"']);

    const d = await svc.diff(hostile);
    expect(d.text).not.toContain('PWNED');
    // and it is still a real diff, not merely empty
    expect(d.text).toContain('f.txt');
    expect(d.text).toContain('+two');
  });

  it('a clean repo yields isRepo:true with empty text — distinct from not-a-repo', async () => {
    const clean = tempDir('sb-git-clean-');
    sh(clean, ['init', '-b', 'main']);
    sh(clean, ['config', 'user.email', 'test@test']);
    sh(clean, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(clean, 'only.txt'), 'x\n');
    sh(clean, ['add', '.']);
    sh(clean, ['commit', '-m', 'init']);
    expect(await svc.diff(clean)).toEqual({ isRepo: true, text: '' });
  });
  // Same ceiling as the hook, for the same reason (#512): every case in this
  // suite runs git in a child process.
}, 30_000);

describe('GitService.fileVersions', () => {
  it('yields HEAD vs working contents for a modified file', async () => {
    const v = await svc.fileVersions(repo, 'a.txt');
    expect(v.original).toBe('one\ntwo\n');
    expect(v.modified).toBe('one\nTWO\n');
  });

  it('new file: empty original; deleted file: empty modified', async () => {
    const nv = await svc.fileVersions(repo, 'b.txt');
    expect(nv.original).toBe('');
    expect(nv.modified).toBe('new\n');
    const dv = await svc.fileVersions(repo, 'nope.txt');
    expect(dv.modified).toBe('');
  });
  // Same ceiling as the hook, for the same reason (#512): every case in this
  // suite runs git in a child process.
}, 30_000);
