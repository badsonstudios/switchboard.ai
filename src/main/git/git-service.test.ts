import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
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
    const [mode, pidFile, ...raw] = process.argv.slice(2);
    fs.writeFileSync(pidFile, String(process.pid));
    // Real git consumes its own pre-subcommand options; so must the stand-in,
    // now that every invocation carries \`-c core.fsmonitor=false\` (#776).
    const args = raw.slice();
    while (args.length && args[0] === '-c') args.splice(0, 2);
    const hang = () => setInterval(() => {}, 60000);
    if (mode === 'hang-probe') return hang();
    // The #776 guard's config read: hanging in one mode, and otherwise
    // answered like a repo that configures no filter driver of its own.
    if (args[0] === 'config') { if (mode === 'hang-config') return hang(); return; }
    // The guard's submodule enumeration: a repo with no gitlinks.
    if (args[0] === 'ls-files') return;
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

  it('ONE budget across every call, not one each', async () => {
    // A budget each would be several times the bound `DIFF_BUDGET_MS` sets —
    // and would put the last call past the host's own deadline. The two
    // `rev-parse` probes take 600 ms each here (the #776 guard's config read is
    // instant), so the split is visible: shared, the diff gets what is LEFT of
    // 1.5 s and the call ends near 1.5 s; one budget per call would be
    // 0.6 + 0.6 + 1.5 = 2.7 s.
    const { svc: slow } = fakeGit('slow-probes');
    const t0 = Date.now();
    await expect(slow.diff(plain, 1500)).rejects.toThrow(/did not finish/);
    // 3300 rather than 2300: the discriminator is 1.5 s versus 2.7 s, and the
    // margin has to hold on a loaded CI runner spawning real processes (#512:
    // 7 s there for a case that is well under a second here). Tight enough to
    // fail the bug, loose enough not to fail the machine.
    expect(Date.now() - t0).toBeLessThan(3300);
  });

  it('a diff too large to read says THAT, not that git broke', async () => {
    const { svc: big } = fakeGit('huge');
    await expect(big.diff(plain, 20_000)).rejects.toThrow(/larger than the 32 MB/);
  });

  it('THE GUARD SPENDS THE SAME BUDGET, not one per invocation (#776 review)', async () => {
    // The #776 guard makes several git calls of its own, and it was handed
    // `left()` — a number computed once — rather than `left` itself, so each of
    // them got the WHOLE remaining budget. With `config` hanging, the guard
    // alone tries the scoped listing, then `--local`, then `--worktree`: three
    // full budgets before `diff-index` has been reached at all. Sharing the
    // deadline, the first one consumes it and the rest fail immediately.
    const { svc: slow } = fakeGit('hang-config');
    const t0 = Date.now();
    // 1200, not 400: the two numbers to separate are "one budget" and "one per
    // hanging call", and at 400 they are 0.4 s against 1.2 s — close enough
    // that widening the assertion for a loaded runner (#512) swallowed the
    // mutant whole. At 1200 they are 1.2 s against 3.6 s.
    await expect(slow.diff(plain, 1200)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2600);
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

// ---------------------------------------------------------------------------
// #776 — the repository's OWN config must not make us run a command.
//
// Every case here drives REAL git, because the whole finding is about what git
// does with a config file, and a stand-in that pretended would only prove that
// the stand-in pretends. The argument-building is covered off-line in
// `repo-config-guard.test.ts`; this is where git is asked to agree.
// ---------------------------------------------------------------------------
describe('a repo cannot make us RUN a command while we read it (#776)', () => {
  let marks: string;
  let markCount = 0;

  beforeAll(() => {
    marks = tempDir('sb-776-marks-');
  });

  /** git runs a filter through its own shell, so a POSIX path works on Windows too. */
  const posix = (p: string): string => p.replace(/\\/g, '/');

  /**
   * A repo whose config, if we let it, runs a command that leaves a marker file
   * OUTSIDE the repo — inside, it would show up as an untracked file and change
   * the very answer under test.
   *
   * `a.txt` is left **stat-dirty and content-clean**: the state a formatter or
   * an editor leaves behind, and the only one that makes git re-hash a working
   * file (with different CONTENT git compares sizes and never hashes, so the
   * filter never runs — measured, and it is the first trap in writing this
   * test). The mtime is pushed forward rather than slept past; 1.5 s of real
   * waiting per case bought nothing.
   *
   * The dangerous config is armed **after** the initial commit — the second
   * trap. Set before it, `git add` runs the driver itself and leaves the marker
   * for reasons that have nothing to do with the code under test, which passed
   * the control and failed everything else.
   */
  function armedRepo(arm: { attributes?: string; configure: (dir: string, marker: string) => void }): {
    repo: string;
    ran: () => boolean;
  } {
    const dir = tempDir('sb-776-');
    const marker = posix(path.join(marks, `m${++markCount}`));
    sh(dir, ['init', '-b', 'main']);
    sh(dir, ['config', 'user.email', 'test@test']);
    sh(dir, ['config', 'user.name', 'test']);
    sh(dir, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    if (arm.attributes) fs.writeFileSync(path.join(dir, '.gitattributes'), arm.attributes);
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-m', 'init']);
    arm.configure(dir, marker);
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'hello\n');
    const ahead = new Date(Date.now() + 20_000);
    fs.utimesSync(file, ahead, ahead);
    return { repo: dir, ran: () => fs.existsSync(marker) };
  }

  /**
   * Every way a repository can get a command run during one of our reads.
   *
   * As a TABLE, so each one gets its own control. Only the clean filter had one
   * before, and if arming were to stop working on some runner — an older git,
   * no `sh`, a `touch` that cannot take a `C:/…` path — the other vectors would
   * all have gone green for the wrong reason.
   */
  const VECTORS: {
    name: string;
    attributes?: string;
    configure: (dir: string, marker: string) => void;
    /** hooks fire on the index refresh `status` does and `diff-index` does not */
    diffToo: boolean;
  }[] = [
    {
      name: 'core.fsmonitor',
      diffToo: true,
      configure: (dir, marker) => sh(dir, ['config', 'core.fsmonitor', `touch '${marker}'; false`]),
    },
    {
      name: 'a clean filter',
      attributes: 'a.txt filter=probe\n',
      diffToo: true,
      configure: (dir, marker) => sh(dir, ['config', 'filter.probe.clean', `sh -c "touch '${marker}'; cat"`]),
    },
    {
      name: 'a process filter (what git-lfs actually uses)',
      attributes: 'a.txt filter=probe\n',
      diffToo: true,
      configure: (dir, marker) => sh(dir, ['config', 'filter.probe.process', `sh -c "touch '${marker}'; exit 1"`]),
    },
    {
      name: 'a driver named so it cannot go on a command line',
      // `[filter "x.clean=touch <marker>"]` makes the key
      // `filter.x.clean=touch <marker>.clean`; as `-c <key>=` that parses on
      // the FIRST `=` and sets `filter.x.clean` to a command git then runs.
      // The env-var form has no such shape, so this is guarded like any other.
      attributes: 'a.txt filter=x\n',
      diffToo: true,
      configure: (dir, marker) => {
        sh(dir, ['config', `filter.x.clean=touch '${marker}'.clean`, 'harmless']);
        sh(dir, ['config', 'filter.x.clean', `sh -c "touch '${marker}'; cat"`]);
      },
    },
    {
      name: 'a filter selected by .git/info/attributes, not by .gitattributes',
      // The file that proved the old attribute-level fallback was not blanket:
      // `--attr-source` replaces only the WORKING-TREE attributes, and this one
      // still selected the driver. Neutralising the DRIVER covers every source.
      diffToo: true,
      configure: (dir, marker) => {
        fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '* filter=probe\n');
        sh(dir, ['config', 'filter.probe.clean', `sh -c "touch '${marker}'; cat"`]);
      },
    },
    {
      name: 'a filter selected by core.attributesFile',
      diffToo: true,
      configure: (dir, marker) => {
        fs.writeFileSync(path.join(dir, 'my-attrs'), '* filter=probe\n');
        sh(dir, ['config', 'core.attributesFile', posix(path.join(dir, 'my-attrs'))]);
        sh(dir, ['config', 'filter.probe.clean', `sh -c "touch '${marker}'; cat"`]);
      },
    },
    {
      name: 'a HOOK',
      // `status` refreshes the index for a stat-dirty file, writes it, and
      // fires `post-index-change`. On a default install nothing but the written
      // file is needed — no `.git/config` edit, no `.gitattributes`, and on
      // Windows not even an execute bit.
      //
      // `core.hooksPath` is pinned here so the CONTROL is not at the mercy of
      // the developer's own global config: this machine has a global
      // `core.hooksPath`, which sends git looking somewhere else entirely and
      // made the control silently unable to fail. Pinning it locally models the
      // default machine, and is anyway something an agent that can write
      // `.git/config` would simply do.
      diffToo: false,
      configure: (dir, marker) => {
        sh(dir, ['config', 'core.hooksPath', posix(path.join(dir, '.git', 'hooks'))]);
        fs.writeFileSync(path.join(dir, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\ntouch '${marker}'\n`, {
          mode: 0o755,
        });
      },
    },
  ];

  for (const vector of VECTORS) {
    it(`THE CONTROL for ${vector.name}: plain git really does run it`, () => {
      // Without this, the case below would pass just as happily against a setup
      // that armed nothing — and so against a guard that does nothing.
      const armed = armedRepo(vector);
      try {
        sh(armed.repo, ['status', '--porcelain=v2']);
      } catch {
        /* the command's exit code is not the point; whether it ran is */
      }
      expect(armed.ran()).toBe(true);
    });

    it(`${vector.name} does not run during status`, async () => {
      const armed = armedRepo(vector);
      const s = await svc.status(armed.repo);
      expect(armed.ran()).toBe(false);
      // The read must still WORK. Without this the case is green whenever git
      // fails for any reason at all — including a guard git rejects outright.
      expect(s.isRepo).toBe(true);
    });

    if (vector.diffToo) {
      it(`${vector.name} does not run during diff — the folder a SIBLING reads`, async () => {
        const armed = armedRepo(vector);
        const d = await svc.diff(armed.repo);
        expect(armed.ran()).toBe(false);
        expect(d.isRepo).toBe(true);
      });
    }
  }

  it('status does not WRITE the sibling’s index — the other half of GIT_OPTIONAL_LOCKS', async () => {
    // #772 stopped `diff` refreshing another session's index (and taking
    // `.git/index.lock` while that session might be staging); `status` was
    // never given the same treatment and does it on exactly the same trigger.
    // The lock is also what fires `post-index-change`, so one setting covers
    // both — this is the half that can be observed directly.
    const armed = armedRepo({ configure: () => {} });
    const index = path.join(armed.repo, '.git', 'index');
    const before = fs.readFileSync(index);
    const s = await svc.status(armed.repo);
    expect(s.isRepo).toBe(true);
    expect(fs.readFileSync(index).equals(before)).toBe(true);
  });

  it('a submodule config that is not a regular FILE is skipped, not read', async () => {
    // `git config --file` follows a symlink, so a link named `config` would
    // have us read (say) the user's real global config and stamp every key in
    // it repo-authored — neutralising their genuine LFS driver. A directory is
    // the portable stand-in for "not a regular file"; symlinks need elevation
    // on Windows.
    const dir = tempDir('sb-776-oddcfg-');
    sh(dir, ['init', '-b', 'main']);
    sh(dir, ['config', 'user.email', 'test@test']);
    sh(dir, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-m', 'init']);
    fs.mkdirSync(path.join(dir, '.git', 'modules', 'sub', 'config'), { recursive: true });

    const s = await svc.status(dir);
    expect(s.isRepo).toBe(true); // not refused, and not handed to `git config --file`
  });

  it('A SUBMODULE cannot do it either — its own config runs during OUR read', async () => {
    // Measured: reading a superproject recurses into each initialised
    // submodule, and a driver in `.git/modules/<name>/config` RAN during both
    // `status` and `diff-index`. That file is a plain file an edit-only agent
    // can write in ANY repository that already has a submodule — no `git
    // submodule add` required. The override reaches it (git exports `-c` to
    // the child git); only the NAME had to be gone and fetched.
    const marker = posix(path.join(marks, `sub${++markCount}`));
    const outer = superprojectWithArmedSubmodule(marker);

    fs.rmSync(marker, { force: true });
    bumpSubmoduleFile(outer);
    try {
      sh(outer, ['status', '--porcelain=v2']);
    } catch {
      /* exit code is not the point; whether it ran is */
    }
    expect(fs.existsSync(marker)).toBe(true); // THE CONTROL

    fs.rmSync(marker, { force: true });
    bumpSubmoduleFile(outer);
    const s = await svc.status(outer);
    expect(fs.existsSync(marker)).toBe(false);
    expect(s.isRepo).toBe(true);
  });

  /**
   * Superproject with one initialised submodule whose OWN config is armed.
   * `arm` overrides how — it is handed the submodule working directory and the
   * path of the config file git will actually read.
   */
  function superprojectWithArmedSubmodule(
    marker: string,
    arm?: (subDir: string, configPath: string) => void
  ): string {
    const inner = tempDir('sb-776-inner-');
    sh(inner, ['init', '-b', 'main']);
    sh(inner, ['config', 'user.email', 'test@test']);
    sh(inner, ['config', 'user.name', 'test']);
    sh(inner, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(inner, '.gitattributes'), 's.txt filter=inner\n');
    fs.writeFileSync(path.join(inner, 's.txt'), 'hello\n');
    sh(inner, ['add', '-A']);
    sh(inner, ['commit', '-m', 'init']);

    const outer = tempDir('sb-776-outer-');
    sh(outer, ['init', '-b', 'main']);
    sh(outer, ['config', 'user.email', 'test@test']);
    sh(outer, ['config', 'user.name', 'test']);
    sh(outer, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(outer, 'top.txt'), 'top\n');
    sh(outer, ['add', '-A']);
    sh(outer, ['commit', '-m', 'init']);
    // `protocol.file.allow` is off by default since CVE-2022-39253.
    sh(outer, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', posix(inner), 'sub']);
    sh(outer, ['commit', '-m', 'add sub']);
    // Armed in the SUBMODULE's config, after everything is committed.
    const subDir = path.join(outer, 'sub');
    if (arm) arm(subDir, path.join(outer, '.git', 'modules', 'sub', 'config'));
    else sh(subDir, ['config', 'filter.inner.clean', `sh -c "touch '${marker}'; cat"`]);
    return outer;
  }

  /**
   * Make the submodule's file stat-dirty and content-clean.
   *
   * The mtime ONLY — deliberately not rewriting the bytes, unlike `armedRepo`.
   * A submodule is populated by a real checkout, so `core.autocrlf` may have
   * put CRLF on disk; writing `hello\n` back over it changes the file's SIZE,
   * and git then answers "modified" from the stat alone and never hashes, so
   * the filter never runs and the control cannot fail.
   */
  function bumpSubmoduleFile(worktree: string): void {
    const file = path.join(worktree, 'sub', 's.txt');
    const ahead = new Date(Date.now() + 20_000);
    fs.utimesSync(file, ahead, ahead);
  }

  it('a submodule that hides its driver behind include.path is still guarded', async () => {
    // `git config --file X --list` defaults to --no-includes, so an enumeration
    // that reads the submodule's config file directly sees NOTHING while git
    // itself expands the include and runs the driver. Measured as a working
    // bypass of the first submodule enumeration — two lines in a file.
    const marker = posix(path.join(marks, `inc${++markCount}`));
    const outer = superprojectWithArmedSubmodule(marker, (subDir, cfgPath) => {
      const hidden = path.join(path.dirname(cfgPath), 'hidden.cfg');
      // Written BY git: a value containing `"` has to be escaped in the file,
      // and hand-writing it produces a command that cannot run — which made an
      // early version of this probe report "held" for the wrong reason.
      sh(subDir, ['config', '--file', hidden, 'filter.inner.clean', `sh -c "touch '${marker}'; cat"`]);
      sh(subDir, ['config', 'include.path', 'hidden.cfg']);
    });

    fs.rmSync(marker, { force: true });
    bumpSubmoduleFile(outer);
    try {
      sh(outer, ['status', '--porcelain=v2']);
    } catch {
      /* exit code is not the point */
    }
    expect(fs.existsSync(marker)).toBe(true); // THE CONTROL

    fs.rmSync(marker, { force: true });
    bumpSubmoduleFile(outer);
    const s = await svc.status(outer);
    expect(fs.existsSync(marker)).toBe(false);
    expect(s.isRepo).toBe(true);
  });

  it('a submodule whose .git file POINTS SOMEWHERE ELSE is still guarded', async () => {
    // `sub/.git` is a plain text file. Repoint it at an ordinary folder in the
    // working tree and an enumeration that opens `<gitdir>/modules/<name>` by
    // name finds an empty directory — measured as a working bypass of both
    // `status` and `diff-index`. Asking git for the gitlink and then asking
    // `git -C <path>` resolves wherever it really lives.
    const marker = posix(path.join(marks, `redir${++markCount}`));
    const outer = superprojectWithArmedSubmodule(marker);
    const moved = path.join(outer, 'tools', 'cache', 'gd');
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(path.join(outer, '.git', 'modules', 'sub'), moved);
    const dotGit = path.join(outer, 'sub', '.git');
    fs.rmSync(dotGit, { force: true });
    fs.writeFileSync(dotGit, `gitdir: ${posix(path.relative(path.join(outer, 'sub'), moved))}\n`);

    fs.rmSync(marker, { force: true });
    bumpSubmoduleFile(outer);
    try {
      sh(outer, ['status', '--porcelain=v2']);
    } catch {
      /* exit code is not the point */
    }
    expect(fs.existsSync(marker)).toBe(true); // THE CONTROL

    fs.rmSync(marker, { force: true });
    bumpSubmoduleFile(outer);
    const s = await svc.status(outer);
    expect(fs.existsSync(marker)).toBe(false);
    expect(s.isRepo).toBe(true);

    fs.rmSync(marker, { force: true });
    bumpSubmoduleFile(outer);
    const d = await svc.diff(outer);
    expect(fs.existsSync(marker)).toBe(false);
    expect(d.isRepo).toBe(true);
  });

  it('A LINKED WORKTREE has its OWN submodule git dir, and that one counts too', async () => {
    // `$GIT_DIR` and `$GIT_COMMON_DIR` differ in a linked worktree, and a
    // submodule can live under either — measured: `submodule update --init` run
    // inside the worktree puts it at `<common>/worktrees/<wt>/modules/<name>`,
    // with a config of its own, and that is the one this worktree's reads use.
    // Asking git for only one of the two roots left the other unguarded.
    // Worktrees are how this project runs its own parallel work.
    const marker = posix(path.join(marks, `wt${++markCount}`));
    const outer = superprojectWithArmedSubmodule(marker);
    const linked = path.join(outer, '..', `${path.basename(outer)}-linked`);
    sh(outer, ['worktree', 'add', '-q', linked]);
    sh(linked, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q']);
    // Disarm the COMMON copy and arm only the worktree's own, so the driver's
    // name exists in exactly one place. Armed in both, the name is discoverable
    // from either root and searching one of them would look like enough.
    sh(path.join(outer, 'sub'), ['config', '--unset', 'filter.inner.clean']);
    sh(path.join(linked, 'sub'), ['config', 'filter.inner.clean', `sh -c "touch '${marker}'; cat"`]);

    fs.rmSync(marker, { force: true });
    bumpSubmoduleFile(linked);
    try {
      sh(linked, ['status', '--porcelain=v2']);
    } catch {
      /* exit code is not the point; whether it ran is */
    }
    expect(fs.existsSync(marker)).toBe(true); // THE CONTROL

    fs.rmSync(marker, { force: true });
    bumpSubmoduleFile(linked);
    const s = await svc.status(linked);
    expect(fs.existsSync(marker)).toBe(false);
    expect(s.isRepo).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The two paths real git on this machine cannot reach: a `git config` that
  // does not understand `--show-scope` (Ubuntu 20.04 still ships 2.25.1, one
  // release below it) and one that fails outright. A stand-in is the only way
  // in, and it earns its keep by echoing the arguments the guard chose.
  // -------------------------------------------------------------------------
  function echoGit(
    configMode: 'unsupported' | 'broken' | 'submodule-unreadable' | 'old-git' | 'nested'
  ): GitService {
    const dir = tempDir('sb-776-echo-');
    const script = path.join(dir, 'fake-git.js');
    fs.writeFileSync(
      script,
      `(() => {
        const NUL = String.fromCharCode(0);
        const mode = process.argv[2];
        const args = process.argv.slice(3);
        let sub = '';
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '-c') { i++; continue; }
          if (args[i].startsWith('-')) continue;
          sub = args[i];
          break;
        }
        if (sub === 'rev-parse') {
          return process.stdout.write(args.includes('--is-inside-work-tree') ? 'true\\n' : 'deadbeef\\n');
        }
        const cwd = process.cwd().replace(/\\\\/g, '/');
        if (sub === 'ls-files') {
          // One gitlink in the modes that need one; otherwise no submodules.
          if (mode === 'submodule-unreadable') return process.stdout.write('160000 abc123 0\\tsub' + NUL);
          if (mode === 'nested') {
            if (cwd.endsWith('/deep')) return; // bottom of the nest
            return process.stdout.write('160000 abc123 0\\t' + (cwd.endsWith('/sub') ? 'deep' : 'sub') + NUL);
          }
          return;
        }
        if (sub === 'config') {
          // Honour GIT_CONFIG_KEY_<n>, as any git >= 2.31 does: this is what
          // the guard's capability probe asks.
          if (args.includes('--get') && args.includes('switchboard.guardprobe')) {
            if (mode === 'old-git') return process.exit(1); // pre-2.31: never heard of them
            const count = Number(process.env.GIT_CONFIG_COUNT || 0);
            for (let i = 0; i < count; i++) {
              if (process.env['GIT_CONFIG_KEY_' + i] === 'switchboard.guardprobe') {
                return process.stdout.write(process.env['GIT_CONFIG_VALUE_' + i] + '\\n');
              }
            }
            return process.exit(1);
          }
          if (mode === 'submodule-unreadable') {
            // The superproject's config reads fine; the SUBMODULE's does not.
            if (cwd.endsWith('/sub')) return process.exit(1);
            return process.stdout.write('local' + NUL + 'core.bare\\nfalse' + NUL);
          }
          if (mode === 'nested') {
            // The driver is named ONLY by the submodule two levels down.
            const key = cwd.endsWith('/deep') ? 'filter.deepdriver.clean' : 'core.bare';
            return process.stdout.write('local' + NUL + key + '\\nvalue' + NUL);
          }
          if (args.includes('--show-scope')) return process.exit(1);
          if (mode === 'broken') return process.exit(1);
          if (args.includes('--local')) {
            return process.stdout.write('filter.x.clean\\ntouch pwned' + NUL + 'core.bare\\nfalse' + NUL);
          }
          return process.exit(1); // --worktree: extensions.worktreeConfig is off
        }
        if (sub === 'diff-index') {
          // The overrides live in the ENVIRONMENT now, so that is what has to
          // be observable. Echo the whole GIT_CONFIG_* set back as the "diff".
          const seen = [];
          const count = Number(process.env.GIT_CONFIG_COUNT || 0);
          for (let i = 0; i < count; i++) {
            seen.push(process.env['GIT_CONFIG_KEY_' + i] + '=' + process.env['GIT_CONFIG_VALUE_' + i]);
          }
          return process.stdout.write(args.join(' ') + '\\n' + seen.join('\\n'));
        }
      })();`
    );
    return new GitService({ file: process.execPath, prefixArgs: [script, configMode] });
  }

  it('a git too old for --show-scope still guards, from the local scope alone', async () => {
    // Ubuntu 20.04 ships git 2.25.1, one release below `--show-scope`, and is
    // supported to 2030 — so this is a live platform, not a museum piece.
    const d = await echoGit('unsupported').diff(tempDir('sb-776-echo-repo-'));
    // The exact PAIR. `toContain('filter.x.clean=')` alone is also satisfied by
    // `filter.x.clean=touch pwned`, so a mutant that passed the hostile value
    // through instead of blanking it would survive on this path.
    expect(d.text.split('\n')).toContain('filter.x.clean=');
  });

  it('a driver named only by a submodule OF a submodule is still guarded', async () => {
    // Submodules nest, and only the deepest one names this driver — so a guard
    // that reads the first level and stops sends no override for it at all.
    const repoDir = tempDir('sb-776-nested-');
    const deep = path.join(repoDir, 'sub', 'deep');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'sub', '.git'), 'gitdir: ../.git/modules/sub\n');
    fs.writeFileSync(path.join(deep, '.git'), 'gitdir: ../../.git/modules/sub/modules/deep\n');

    const d = await echoGit('nested').diff(repoDir);
    expect(d.text.split('\n')).toContain('filter.deepdriver.clean=');
  });

  it('a git that IGNORES the overrides refuses, instead of guarding nothing', async () => {
    // `GIT_CONFIG_KEY_<n>` is git >= 2.31; Ubuntu 20.04 has 2.25.1 and Debian 11
    // has 2.30.2. Those gits read the config, ignore our environment entirely,
    // and run the driver — with nothing to show that anything was skipped. The
    // capability is asked of git itself rather than read off `--version`.
    await expect(echoGit('old-git').diff(tempDir('sb-776-echo-repo-'))).rejects.toThrow(
      /could not read the repository's own configuration/
    );
  });

  it('a config we could NOT read refuses the read, and says which it was', async () => {
    // "No repo-authored driver" and "we could not find out" must never be the
    // same answer, and there is no partial guard to fall back to — the
    // attribute-level switch that used to sit here was measured NOT to cover
    // `.git/info/attributes`. So the read does not happen.
    await expect(echoGit('broken').diff(tempDir('sb-776-echo-repo-'))).rejects.toThrow(
      /could not read the repository's own configuration/
    );
  });

  it("a SUBMODULE's config we could not read refuses the read too", async () => {
    // The submodule half of the same rule. Its config always holds at least
    // `core.repositoryformatversion`, so a failure reading it means "could not
    // read", never "nothing to read" — and skipping it would leave whatever
    // driver it names running.
    const repoDir = tempDir('sb-776-echo-sub-');
    // A populated submodule: the gitlink comes from the index, and `.git`
    // existing is what tells us git will recurse into it.
    fs.mkdirSync(path.join(repoDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'sub', '.git'), 'gitdir: ../.git/modules/sub\n');
    await expect(echoGit('submodule-unreadable').diff(repoDir)).rejects.toThrow(
      /could not read the repository's own configuration/
    );
  });
  // Real git in a child process, several times per case (#512).
}, 60_000);

describe('#776 leaves a legitimately configured filter working', () => {
  /**
   * The LFS shape without LFS: the index holds a short pointer, the working
   * tree holds the real content, and the clean filter is the only reason they
   * agree. `git lfs install` writes this to the GLOBAL config — which is what
   * makes scope a usable discriminator in the first place.
   */
  const POINTER_CLEAN = 'sh -c "cat >/dev/null; echo POINTER"';
  let saved: string | undefined;

  beforeAll(() => {
    const cfg = path.join(tempDir('sb-776-global-'), 'gitconfig');
    fs.writeFileSync(cfg, `[filter "fake"]\n\tclean = ${POINTER_CLEAN}\n\trequired = true\n`);
    saved = process.env.GIT_CONFIG_GLOBAL;
    // Inherited by `sh` AND by the `execFile` inside GitService, which is the
    // only way to put a driver in a scope this process does not own.
    process.env.GIT_CONFIG_GLOBAL = cfg;
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  });

  /** index holds POINTER, working tree holds the real bytes, stat-dirty. */
  function lfsShapedRepo(configure?: (dir: string) => void): string {
    const dir = tempDir('sb-776-lfs-');
    sh(dir, ['init', '-b', 'main']);
    sh(dir, ['config', 'user.email', 'test@test']);
    sh(dir, ['config', 'user.name', 'test']);
    sh(dir, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'big.bin filter=fake\n');
    fs.writeFileSync(path.join(dir, 'big.bin'), 'REAL-CONTENT-XXXXXXXX\n');
    configure?.(dir);
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-m', 'init']);
    const file = path.join(dir, 'big.bin');
    fs.writeFileSync(file, 'REAL-CONTENT-XXXXXXXX\n');
    const ahead = new Date(Date.now() + 20_000);
    fs.utimesSync(file, ahead, ahead);
    return dir;
  }

  it('does not touch a GLOBALLY installed driver — status stays right', async () => {
    // The failure this pins: a blanket "disable clean filters" reports every
    // LFS file as modified, and the bus hands that list to another agent as
    // fact. `required = true` would also turn the read into a hard error.
    const s = await svc.status(lfsShapedRepo());
    expect(s.isRepo).toBe(true);
    expect(s.files).toEqual([]);
  });

  it('puts the GLOBAL value back when the repo shadows the driver', async () => {
    const marker = path.join(tempDir('sb-776-shadow-'), 'ran').replace(/\\/g, '/');
    const dir = lfsShapedRepo((d) => {
      sh(d, ['config', 'filter.fake.clean', `sh -c "touch '${marker}'; cat >/dev/null; echo POINTER"`]);
    });
    // Setting up the repo ran the repo's own driver, which is the repo's
    // business. OUR read is the one that must not.
    fs.rmSync(marker, { force: true });
    const s = await svc.status(dir);
    expect(fs.existsSync(marker)).toBe(false); // the local command was blocked
    // BOTH assertions, and `isRepo` is the load-bearing one: the global driver
    // is `required`, so a guard that neutralised it to empty instead of putting
    // it back makes git fail the read — and a failed read is `files: []` too.
    // Without this line the mutant passes.
    expect(s.isRepo).toBe(true);
    expect(s.files).toEqual([]); // and the global driver still did its job
  });

  it('THE KNOWN REGRESSION: a required driver defined ONLY in the repo fails the read', async () => {
    // `git lfs install --local` on a machine with no global LFS. There is no
    // trusted value to put back, so the driver is neutralised, and because the
    // repository declared it `required` git refuses rather than reporting every
    // large file as modified. That is the honest outcome and it is deliberate —
    // but it is the one user-visible regression this change knowingly ships, so
    // it is pinned here rather than left to be rediscovered.
    //
    // ⚠️ `isRepo: false` is what a failed `status` has always returned, and the
    // pane draws it as "Not a git repository" — a lie, now slightly easier to
    // reach. Pre-existing and filed separately; the manual says `git lfs
    // install` (without `--local`) is the fix.
    const dir = tempDir('sb-776-localreq-');
    sh(dir, ['init', '-b', 'main']);
    sh(dir, ['config', 'user.email', 'test@test']);
    sh(dir, ['config', 'user.name', 'test']);
    sh(dir, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'big.bin filter=onlylocal\n');
    fs.writeFileSync(path.join(dir, 'big.bin'), 'REAL-CONTENT-XXXXXXXX\n');
    sh(dir, ['config', 'filter.onlylocal.clean', POINTER_CLEAN]);
    sh(dir, ['config', 'filter.onlylocal.required', 'true']);
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-m', 'init']);
    const file = path.join(dir, 'big.bin');
    const ahead = new Date(Date.now() + 20_000);
    fs.utimesSync(file, ahead, ahead);

    expect((await svc.status(dir)).isRepo).toBe(false);
    // The bus is the surface that gets this right: a reason, not a shrug.
    await expect(svc.diff(dir)).rejects.toThrow(/git could not produce the diff/);
  });
}, 60_000);
