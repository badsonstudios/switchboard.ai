import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execFileSync, spawn } from 'child_process';

// `spawn` is the REAL one unless a test says otherwise for one call — it is
// only how `killTree` reaches `taskkill`, and the fallbacks for a taskkill that
// cannot start or fails are otherwise unreachable (#772 review, round 2).
// `execFile` is untouched: git itself always runs for real.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return { ...real, spawn: vi.fn(real.spawn) };
});
import fs from 'fs';
import path from 'path';
import { GitService } from './git-service';
// `DIFF_BUDGET_MS`'s place in the bus's deadline cascade is pinned in
// `bus-tools.test.ts`, beside the rest of the cascade.
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

  it('THROWS when git fails, rather than reporting a clean tree (#764 review)', async () => {
    // ⚠️ THE BUG THIS PINS. `text: r.ok ? r.out : ''` collapsed every failure of
    // the diff command into `{ isRepo: true, text: '' }`, which the bus renders
    // to a language model as "has no uncommitted changes". It is the same
    // swallow the unborn-HEAD case above records fixing one line higher, and
    // the likeliest way to reach it — `git` exceeding `execFile`'s 32 MB
    // `maxBuffer` — happens precisely when the sibling has done the MOST work.
    // So the tool got less truthful the more there was to say.
    //
    // A corrupt loose object is the portable way to make the diff command fail
    // while the two probes above it still succeed. (`chmod` first: git writes
    // loose objects read-only, which is also why this suite's temp dirs go
    // through the registry.)
    const broken = tempDir('sb-git-broken-');
    sh(broken, ['init', '-b', 'main']);
    sh(broken, ['config', 'user.email', 'test@test']);
    sh(broken, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(broken, 'f.txt'), 'hello\n');
    sh(broken, ['add', '.']);
    sh(broken, ['commit', '-m', 'init']);
    const blob = execFileSync('git', ['rev-parse', 'HEAD:f.txt'], { cwd: broken, encoding: 'utf8' }).trim();
    const objectPath = path.join(broken, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
    fs.chmodSync(objectPath, 0o666);
    fs.writeFileSync(objectPath, 'not a git object');
    fs.writeFileSync(path.join(broken, 'f.txt'), 'changed\n');

    await expect(svc.diff(broken)).rejects.toThrow(/could not produce the diff/);
  });

  it('never WRITES the index — the sibling’s own `git add` must not collide with our read (#772)', async () => {
    // ⚠️ MEASURED IN #772: porcelain `git diff` refreshes the index when files
    // have new timestamps and unchanged contents — what an editor or formatter
    // leaves behind — and takes `.git/index.lock` to do it. While a sibling
    // was reading this session's changes, this session's own `git add` could
    // fail with "index.lock: File exists". `diff-index` never refreshes.
    const repo2 = tempDir('sb-git-index-');
    sh(repo2, ['init', '-b', 'main']);
    sh(repo2, ['config', 'user.email', 'test@test']);
    sh(repo2, ['config', 'user.name', 'test']);
    const files = ['a.txt', 'b.txt', 'c.txt'].map((f) => path.join(repo2, f));
    for (const f of files) fs.writeFileSync(f, `${path.basename(f)}\n`);
    sh(repo2, ['add', '.']);
    sh(repo2, ['commit', '-m', 'init']);
    // Stat-dirty, content-clean. Timestamps set into the past rather than
    // waited for, so this does not race git's racy-timestamp window.
    const past = new Date('2020-01-01T00:00:00Z');
    for (const f of files) fs.utimesSync(f, past, past);
    fs.writeFileSync(files[0], 'changed\n');
    const index = path.join(repo2, '.git', 'index');
    const before = fs.readFileSync(index);

    const d = await svc.diff(repo2);
    expect(d.text).toContain('+changed');
    expect(fs.readFileSync(index).equals(before)).toBe(true);
  });

  it('reports a staged rename AS a rename, as porcelain did', async () => {
    // Plumbing does not detect renames unless told `-M`; porcelain does by
    // default. Without it a sibling's `git mv` reads as deleting one file and
    // adding another — twice the text, and the wrong story.
    const repo3 = tempDir('sb-git-rename-');
    sh(repo3, ['init', '-b', 'main']);
    sh(repo3, ['config', 'user.email', 'test@test']);
    sh(repo3, ['config', 'user.name', 'test']);
    fs.writeFileSync(
      path.join(repo3, 'old-name.ts'),
      Array.from({ length: 20 }, (_, i) => `export const k${i} = ${i};`).join('\n') + '\n'
    );
    sh(repo3, ['add', '.']);
    sh(repo3, ['commit', '-m', 'init']);
    sh(repo3, ['mv', 'old-name.ts', 'new-name.ts']);

    const d = await svc.diff(repo3);
    expect(d.text).toContain('rename from old-name.ts');
    expect(d.text).toContain('rename to new-name.ts');
    expect(d.text).not.toContain('deleted file mode');
  });
  // Same ceiling as the hook, for the same reason (#512): every case in this
  // suite runs git in a child process.
}, 30_000);

describe('GitService.diff is BOUNDED (#772)', () => {
  // A stand-in for git, because the only portable way to make real git hang
  // is to break a filesystem. Behaviour by mode: answer the two `rev-parse`
  // probes like a healthy repo, then do the mode's thing on the one that
  // matters. Its PID goes to a file so the test can check it is really gone.
  const FAKE_GIT = `
    const fs = require('fs');
    const [mode, pidFile, ...args] = process.argv.slice(2);
    fs.writeFileSync(pidFile, String(process.pid));
    const hang = () => setInterval(() => {}, 60000);
    if (mode === 'hang-probe') return hang();
    if (args[0] === 'rev-parse') {
      const answer = () => process.stdout.write(args.includes('--is-inside-work-tree') ? 'true\\n' : 'deadbeef\\n');
      if (mode === 'slow-probes') return setTimeout(answer, 600);
      return answer();
    }
    if (mode === 'holder-hang' || mode === 'holder-exit') {
      // Something git started that outlives it and HOLDS ITS STDOUT — a hook,
      // a filter. Started through an intermediate that exits at once, so the
      // holder is orphaned out of any tree kill, as a real escapee would be.
      require('child_process').spawn(process.execPath,
        [require('path').join(require('path').dirname(pidFile), 'intermediate.js')], { stdio: 'inherit' });
      if (mode === 'holder-hang') return hang();
      return; // exit 0, with the pipe still held
    }
    if (mode === 'hang-diff' || mode === 'slow-probes') return hang();
    if (mode === 'huge') {
      const chunk = 'x'.repeat(1024 * 1024);
      for (let i = 0; i < 40; i++) process.stdout.write(chunk);
    }
  `;

  /** How long a `holder-*` descendant keeps git's stdout open. */
  const HOLDER_MS = 4000;

  function fakeGit(mode: string): { svc: GitService; pidFile: string } {
    const dir = tempDir('sb-git-fake-');
    const script = path.join(dir, 'fake-git.js');
    fs.writeFileSync(script, `(() => {${FAKE_GIT}})();`);
    const pidFile = path.join(dir, 'pid');
    // The pipe-holder for the `holder-*` modes: it inherits stdout and lives
    // HOLDER_MS, then exits on its own so no test leaves it behind.
    fs.writeFileSync(
      path.join(dir, 'intermediate.js'),
      `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${HOLDER_MS})'],
         { stdio: 'inherit', detached: true, windowsHide: true }).unref();`
    );
    return { svc: new GitService({ file: process.execPath, prefixArgs: [script, mode, pidFile] }), pidFile };
  }

  /** Resolves true once `pid` no longer exists; false if it outlives `ms`. */
  async function gone(pid: number, ms = 3000): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  it('KILLS a git that runs past the budget and says so — the work ends, not just the wait', async () => {
    const { svc: slow, pidFile } = fakeGit('hang-diff');
    const t0 = Date.now();
    await expect(slow.diff(plain, 400)).rejects.toThrow(/did not finish reading the changes within/);
    expect(Date.now() - t0).toBeLessThan(5000);
    // The point of a kill over an abandonment: the process is GONE. Without
    // `timeout` on the invocation the promise would still reject at the host's
    // deadline, one layer up, and this git would still be running.
    expect(await gone(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(true);
  });

  it.runIf(process.platform === 'win32')(
    'kills the WHOLE TREE — a launcher’s child dies too, not just the launcher (#772 review)',
    async () => {
      // ⚠️ THE BUG THIS PINS. On Windows the `git` an app launched from
      // Explorer resolves to is `cmd\git.exe`, a LAUNCHER that runs the real
      // git as its child. `execFile`'s own `timeout` killed the launcher and
      // left the real git running — one orphan per retry, the thing the budget
      // exists to stop. The test above could not see it: its fake is ONE
      // process. This one is a launcher with a hanging grandchild, which is
      // the shape that matters. Windows-only because the launcher is.
      //
      // `detached` IS LOAD-BEARING, and the first version of this test lacked
      // it and survived the mutant it exists for. Node on Windows puts every
      // child in a job object that dies with its parent, so a Node "launcher"
      // took its child down on its own and the tree kill was never needed.
      // Git for Windows' launcher does no such thing; `detached` breaks the
      // grandchild away from the job, which is the real shape.
      const dir = tempDir('sb-git-launcher-');
      const grandchildPid = path.join(dir, 'grandchild.pid');
      const launcher = path.join(dir, 'launcher.js');
      fs.writeFileSync(
        launcher,
        `const { spawn } = require('child_process');
         const c = spawn(process.execPath, ['-e',
           "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 60000)",
           ${JSON.stringify(grandchildPid)}], { stdio: 'ignore', detached: true, windowsHide: true });
         c.on('exit', (code) => process.exit(code ?? 1));`
      );
      const slow = new GitService({ file: process.execPath, prefixArgs: [launcher] });
      const settled = slow.diff(plain, 600).catch((e: unknown) => e);
      // wait for the grandchild to exist before judging whether it died
      const until = Date.now() + 5000;
      while (!fs.existsSync(grandchildPid) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      expect(String(await settled)).toMatch(/did not finish/);
      expect(await gone(Number(fs.readFileSync(grandchildPid, 'utf8')))).toBe(true);
    }
  );

  describe.runIf(process.platform === 'win32')('when the tree kill itself fails', () => {
    // Each of these would leave git running AND the diff waiting for ever —
    // the pipes are closed, but `execFile` still waits for the process to exit
    // — if the fallback to killing the one process we hold were missing. And
    // `killTree` runs in a timer in Electron main, so a throw is a crash.
    it('taskkill that cannot even START (a synchronous throw) falls back, and does not throw', async () => {
      vi.mocked(spawn).mockImplementationOnce(() => {
        throw new Error('spawn ENOMEM');
      });
      const { svc: slow, pidFile } = fakeGit('hang-diff');
      await expect(slow.diff(plain, 400)).rejects.toThrow(/did not finish/);
      expect(await gone(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(true);
    });

    it('taskkill that starts and FAILS ("Access is denied") falls back', async () => {
      const real = (await vi.importActual<typeof import('child_process')>('child_process')).spawn;
      vi.mocked(spawn).mockImplementationOnce(() =>
        real(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' })
      );
      const { svc: slow, pidFile } = fakeGit('hang-diff');
      await expect(slow.diff(plain, 400)).rejects.toThrow(/did not finish/);
      expect(await gone(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(true);
    });
  });

  it('the budget holds even when something git started keeps its OUTPUT open (review, round 2)', async () => {
    // A kill alone does not end the wait: `execFile` answers only once stdout
    // and stderr CLOSE, and a descendant that inherited them — outside the
    // tree kill's reach — keeps them open. `execFile`'s own timeout closed our
    // end of the pipes; the first version of the replacement timer did not,
    // and a 400 ms budget became the holder's whole lifetime.
    const { svc: slow } = fakeGit('holder-hang');
    const t0 = Date.now();
    await expect(slow.diff(plain, 400)).rejects.toThrow(/did not finish/);
    expect(Date.now() - t0).toBeLessThan(HOLDER_MS - 1500);
  });

  it('…and when git EXITED but its output is still held, it is a timeout after a short grace — not a wait for ever', async () => {
    // Git is gone, so nothing to kill; the pipes are held by what it left
    // behind. The grace lets a genuinely finished git's output drain; past it
    // the pipes are closed and the answer is a timeout, because what came
    // back may be cut short.
    const { svc: slow } = fakeGit('holder-exit');
    const t0 = Date.now();
    await expect(slow.diff(plain, 400)).rejects.toThrow(/did not finish/);
    expect(Date.now() - t0).toBeLessThan(HOLDER_MS - 1500);
  });

  it('a timed-out PROBE is a timeout — not "not a repository"', async () => {
    // `rev-parse --is-inside-work-tree` failing is how this method answers
    // "not a repo", and a kill is a failure. Reported that way, a slow disk
    // would tell a model its sibling is not in a repository at all.
    const { svc: slow } = fakeGit('hang-probe');
    await expect(slow.diff(plain, 400)).rejects.toThrow(/did not finish/);
  });

  it('ONE budget across the three calls, not one each', async () => {
    // Three budgets would be three times the bound `DIFF_BUDGET_MS` sets —
    // and would put the third call past the host's own deadline.
    // The probes each take 600 ms here, so the split is visible: shared, the
    // diff gets what is LEFT of 1.5 s and the call ends near 1.5 s; one budget
    // per call would be 0.6 + 0.6 + 1.5 = 2.7 s.
    const { svc: slow } = fakeGit('slow-probes');
    const t0 = Date.now();
    await expect(slow.diff(plain, 1500)).rejects.toThrow(/did not finish/);
    expect(Date.now() - t0).toBeLessThan(2300);
  });

  it('a diff too large to read says THAT, not that git broke', async () => {
    const { svc: big } = fakeGit('huge');
    await expect(big.diff(plain, 20_000)).rejects.toThrow(/larger than the 32 MB/);
  });
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
