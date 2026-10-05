import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'child_process';

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
// The guards themselves, so the pathspec cases can run git WITH them and WITHOUT
// them in one file — a guard test that cannot fail without the guard proves
// nothing, which is the lesson the #776 hostile-driver tests learned the hard way.
import { guardArgs } from './repo-config-guard';
import { patchFor } from './git-hunks';
// `DIFF_BUDGET_MS`'s place in the bus's deadline cascade is pinned in
// `bus-tools.test.ts`, beside the rest of the cascade.
import { tempDir } from '../../test-temp-dirs';

let repo: string;
let plain: string;
const svc = new GitService();

/**
 * Wait, in REAL time, for something a child process does — usable while the
 * test holds a fake clock (#1025).
 *
 * The cases that need git to run out of budget used to hand it a small real
 * one (250 ms, 400 ms) and hope the stand-in's earlier invocations fitted
 * inside it. Each of those is a `node` start, and on a loaded Windows machine
 * two of them do not fit in 250 ms — so the budget ran out one step EARLY and
 * the test got a different, equally correct refusal. They now give git a budget
 * nothing real can spend, wait here until the stand-in says it has reached the
 * step that matters, and then move the clock themselves.
 *
 * Captured at import, before any test can install a fake `setTimeout`.
 */
const realSetTimeout = setTimeout;
async function reached(what: string, check: () => boolean, ms = 20_000): Promise<void> {
  const until = performance.now() + ms;
  while (!check()) {
    if (performance.now() > until) throw new Error(`the stand-in never reached: ${what}`);
    await new Promise((r) => realSetTimeout(r, 10));
  }
}

/**
 * A path git can put in a config value it will EXECUTE.
 *
 * git runs these through a shell, where a Windows backslash is an escape
 * character — so `C:\Program Files\nodejs\node.exe` arrives with `\n` read as a
 * newline and the command is nonsense. The hostile-driver tests below depend on
 * the fake driver actually being runnable: a driver that could not start would
 * pass a test whose whole point is that it never ran.
 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

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

    // It throws — the fact this test owns — and since #785 the throw carries
    // git's own account of the corruption rather than a generic shrug. Both
    // asserted: the generic message would still be a pass on the first half.
    await expect(svc.diff(broken)).rejects.toThrow();
    await expect(svc.diff(broken)).rejects.toThrow(/inflate|loose object|corrupt|invalid/i);
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
    //
    // ⚠️ **AND NOT ONLY \`-c\` PAIRS (E24 Git v2 item 10).** This loop used to
    // consume exactly those, so when \`guardArgs()\` gained the FLAG
    // \`--literal-pathspecs\` the stand-in stopped recognising its own
    // subcommand: \`args[0]\` was the flag, every \`args[0] === 'rev-parse'\`
    // branch missed, and two bounded-diff tests failed with "git could not tell
    // whether that folder is a repository". The failure was in the harness and
    // looked exactly like a failure in the subject. Consuming ANY leading option
    // is what real git does and is what this has to do.
    const args = raw.slice();
    while (args.length && args[0].startsWith('-')) {
      if (args[0] === '-c') args.splice(0, 2);
      else args.splice(0, 1);
    }
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
    //
    // The sentence names the VERSION since #785. It used to be the same "could
    // not read the repository's own configuration" a damaged repo gets, and the
    // two are different problems with different answers — this one is a
    // supported platform telling you to upgrade git, not a broken checkout.
    await expect(echoGit('old-git').diff(tempDir('sb-776-echo-repo-'))).rejects.toThrow(
      /too old .*git 2\.31 or newer/
    );
  });

  it('a config we could NOT read refuses the read, and says which it was', async () => {
    // "No repo-authored driver" and "we could not find out" must never be the
    // same answer, and there is no partial guard to fall back to — the
    // attribute-level switch that used to sit here was measured NOT to cover
    // `.git/info/attributes`. So the read does not happen.
    await expect(echoGit('broken').diff(tempDir('sb-776-echo-repo-'))).rejects.toThrow(
      /could not enumerate this repository's own configuration/
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
      /could not enumerate this repository's own configuration/
    );
  });

  it('the two refusals are DIFFERENT sentences, not one message reached twice (#785)', async () => {
    // The point of splitting them. Both used to read "could not read the
    // repository's own configuration", so a user on Ubuntu 20.04 was told their
    // repository might be damaged — and the thing to actually do, upgrade git,
    // appeared nowhere. Asserted as a pair because either regex alone stays
    // green if the other message is changed to match it.
    const old = await echoGit('old-git').diff(tempDir('sb-785-old-')).catch((e: Error) => e.message);
    const bad = await echoGit('broken').diff(tempDir('sb-785-bad-')).catch((e: Error) => e.message);
    expect(old).not.toBe(bad);
    expect(old).toMatch(/too old/);
    expect(bad).not.toMatch(/too old/);
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
    // ⚠️ THIS TEST ASSERTED `isRepo: false` UNTIL #785, and the assertion was
    // the ticket: a failed `status` was indistinguishable from a folder under
    // no version control, and the pane drew both as "Not a git repository". It
    // is REAL git, failing a REAL read, which makes it the best witness in this
    // file for #785's status branch — so it is asserted here rather than
    // restaged with a stand-in next door.
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

    const s = await svc.status(dir);
    // `rev-parse` already said this IS a work tree, so saying otherwise would
    // be a second wrong answer bolted onto the first.
    expect(s.isRepo).toBe(true);
    // git's own account of the refusal, quoted. Asserted as a REGEX over git's
    // wording rather than an exact string: the sentence is git's to change
    // between versions, and what this test owns is that the reason arrives at
    // all and names the driver.
    expect(s.unreadable).toMatch(/filter|onlylocal/i);
    // …and the two states that would each be a lie here.
    expect(s.files).toEqual([]);
    // The bus gets the SAME reason the pane does (#785 review). It refused with
    // a bare "git could not produce the diff" until then — the half that tells
    // the model (and through it, the user) which filter failed was thrown away
    // at the last line of `diff()` while `status()` was already quoting it.
    await expect(svc.diff(dir)).rejects.toThrow(/onlylocal/);
  });
}, 60_000);
// ---------------------------------------------------------------------------
// #785: a failed `git status` used to render as "Not a git repository" — every
// failure looked like the same one, and the one it looked like was a confident
// claim about the user's project.
//
// Real git wherever real git can reach the case, which is most of them: the
// finding this whole suite turns on is what GIT says, and a stand-in that
// pretended would only prove that the stand-in pretends.
// ---------------------------------------------------------------------------
describe('a git switchboard could not READ is not a folder without git (#785)', () => {
  /**
   * ⚠️ **THE MEASUREMENT THE DISCRIMINATOR RESTS ON.** A folder that is not a
   * repository and a repository whose `.git` file points at nothing BOTH exit
   * 128 and BOTH say "not a git repository" — so a match on that phrase calls
   * the damaged one healthy. Only the benign message carries the parenthesis.
   *
   * This is one test rather than two because the fact is the PAIR: either half
   * alone stays green under a `saysNotARepo` that always answers the same way.
   */
  it('THE DISCRIMINATION: both say "not a git repository", and only one is unreadable', async () => {
    const damaged = tempDir('sb-785-gitfile-');
    fs.writeFileSync(path.join(damaged, '.git'), 'gitdir: /definitely/not/there\n');

    const bad = await svc.status(damaged);
    const good = await svc.status(plain);

    // The witness that the fixture really did produce the confusable message —
    // without it this passes against a damaged repo that failed some other way
    // entirely, and the finding would go untested.
    expect(bad.unreadable).toContain('not a git repository');
    expect(bad.isRepo).toBe(false);
    // …and the common case stays plain. No reason, no alarm, nothing for the
    // pane to draw but "Not a git repository", which is TRUE here.
    expect(good.unreadable).toBeUndefined();
    expect(good).toEqual({ isRepo: false, files: [] });
  });

  it('a `.git` git cannot parse at all is reported in git’s own words', async () => {
    const dir = tempDir('sb-785-gitfile-format-');
    fs.writeFileSync(path.join(dir, '.git'), 'this is not a gitdir line\n');
    const s = await svc.status(dir);
    expect(s.unreadable).toContain('invalid gitfile format');
    // `fatal: ` is git's prefix for a terminal, not a sentence fragment for a
    // 200px pane — the pane's own copy already says something went wrong.
    expect(s.unreadable).not.toContain('fatal:');
  });

  it('a config git cannot parse is a damaged repository, not an absent one', async () => {
    const dir = tempDir('sb-785-badconfig-');
    sh(dir, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(dir, '.git', 'config'), '[core\nbroken');
    const s = await svc.status(dir);
    expect(s.unreadable).toContain('bad config');
  });

  it('A FOLDER THAT IS GONE DOES NOT BECOME "git is not installed"', async () => {
    // ⚠️ MEASURED, and the reason this branch exists: `execFile('git', …, {
    // cwd })` with a cwd that does not exist fails with `ENOENT` and
    // `syscall: 'spawn git'` — byte for byte the error a machine with no git
    // produces. Reading "git is not installed" off that would have swapped one
    // confident wrong answer for another, on a surface that exists to stop
    // exactly that.
    const gone = path.join(tempDir('sb-785-gone-'), 'never-created');
    const s = await svc.status(gone);
    expect(s.unreadable).toContain('no longer exists');
    expect(s.unreadable).not.toMatch(/installed|PATH/);
  });

  it('…and a git that will not start, in a folder that IS there, says so', async () => {
    // The other side of the same ENOENT. `plain` exists, so the only thing
    // missing is git. The `GitCommand` seam is the only portable way in: this
    // machine has git, which is the point of the test.
    const noGit = new GitService({ file: 'sb-785-definitely-not-git', prefixArgs: [] });
    const s = await noGit.status(plain);
    expect(s.unreadable).toMatch(/not be installed|PATH/);
    expect(s.unreadable).not.toContain('no longer exists');
    expect(s.isRepo).toBe(false);
  });

  it('a bare repository is still an honest "not a working tree", not a failure', async () => {
    // `rev-parse` answers cleanly here — exit 0, stdout `false` — and that is a
    // fact about the folder, not something we failed to find out. A third state
    // that swallowed this would be noise on every bare clone.
    const bare = path.join(tempDir('sb-785-bare-'), 'x.git');
    execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
    expect(await svc.status(bare)).toEqual({ isRepo: false, files: [] });
  });

  /**
   * A git that gets past `rev-parse` and then fails in one of the three ways
   * `status()` has to tell apart.
   *
   * - `status-fails` — the read itself dies, noisily, the way a real fatal
   *   does (`warning:` above, `hint:` below).
   * - `config-broken` — #776's guard cannot enumerate the config.
   * - `old-git` — the repo DOES name a driver, and this git ignores
   *   `GIT_CONFIG_KEY_<n>` (pre-2.31), so the guard refuses to run at all.
   *
   * The last two are `diff()`'s `echoGit` cases asked of `status()` instead,
   * and they are here rather than borrowed because a mutation pass found this
   * branch of `status()` untested — `isRepo: false, no reason` survived.
   */
  function fakeGit(mode: 'status-fails' | 'config-broken' | 'old-git'): GitService {
    const dir = tempDir('sb-785-fake-');
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
        if (sub === 'rev-parse') return process.stdout.write('true\\n');
        if (sub === 'ls-files') return;            // no submodules
        if (sub === 'config') {
          // The guard's capability probe, answered as any git >= 2.31 does.
          if (args.includes('--get') && args.includes('switchboard.guardprobe')) {
            if (mode === 'old-git') return process.exit(1); // never heard of them
            const count = Number(process.env.GIT_CONFIG_COUNT || 0);
            for (let i = 0; i < count; i++) {
              if (process.env['GIT_CONFIG_KEY_' + i] === 'switchboard.guardprobe') {
                return process.stdout.write(process.env['GIT_CONFIG_VALUE_' + i] + '\\n');
              }
            }
            return process.exit(1);
          }
          if (mode === 'config-broken') return process.exit(1);
          // old-git needs something worth guarding, or the probe above is
          // never asked and the guard succeeds for want of anything to do.
          if (mode === 'old-git') {
            return process.stdout.write('local' + NUL + 'filter.x.clean\\ntouch pwned' + NUL);
          }
          return;                                  // no repo-authored driver
        }
        if (sub === 'status') {
          process.stderr.write('warning: unable to access .git/info/attributes\\n');
          process.stderr.write('fatal: unable to read index file .git/index\\n');
          process.stderr.write('hint: run git status to see the rest of this\\n');
          // exitCode, NOT process.exit: on Windows a pipe write is async and
          // exiting on top of it loses the very stderr this fixture is for.
          process.exitCode = 128;
        }
      })();`
    );
    return new GitService({ file: process.execPath, prefixArgs: [script, mode] });
  }

  it('#776’s refusal reaches the PANE with its reason, not as "not a repository"', async () => {
    // The failure mode the manual had to describe as "will be reported as not
    // being a git repository": the guard declines to run git, and every trace
    // of why was dropped on the floor. Both refusals, because they are separate
    // sentences since #785 and a test of one is not a test of the other.
    const badConfig = await fakeGit('config-broken').status(tempDir('sb-785-guard-cfg-'));
    expect(badConfig.isRepo).toBe(true);
    expect(badConfig.unreadable).toMatch(/could not enumerate/);

    const tooOld = await fakeGit('old-git').status(tempDir('sb-785-guard-old-'));
    expect(tooOld.isRepo).toBe(true);
    expect(tooOld.unreadable).toMatch(/too old/);

    expect(badConfig.unreadable).not.toBe(tooOld.unreadable);
  });

  it('a `status` that fails keeps isRepo TRUE, and carries the line that matters', async () => {
    const s = await fakeGit('status-fails').status(tempDir('sb-785-statusfail-'));
    // `rev-parse` said this IS a work tree. Answering `false` because a later
    // command failed is the original bug, stated exactly.
    expect(s.isRepo).toBe(true);
    // The `fatal:` line, stripped — not the `warning:` above it and not the
    // `hint:` below. A real `detected dubious ownership` comes wrapped in four
    // lines of terminal advice, and this pane is 200px wide.
    expect(s.unreadable).toBe('unable to read index file .git/index');
    expect(s.files).toEqual([]);
  });

  it('the pane is never told a repository it could not read is CLEAN', async () => {
    // `unreadable` rides with `files: []` and `isRepo: true` — which is exactly
    // the shape of a clean tree. The renderer's ordering is what keeps them
    // apart (`lib/git-status`); this is the main-side half of that promise,
    // asserting the shape the renderer has to cope with rather than assuming it.
    const s = await fakeGit('status-fails').status(tempDir('sb-785-cleanshape-'));
    expect({ isRepo: s.isRepo, files: s.files }).toEqual({ isRepo: true, files: [] });
    expect(s.unreadable).toBeTruthy();
  });

  it('`diff` stopped telling a MODEL the same lie', async () => {
    // The bus path, where the reader is an agent that will act on it.
    // `renderDiff` turns `isRepo: false` into "it is not working inside a git
    // repository" — stated flatly, with no qualification, for a machine with no
    // git. A refusal it can report is the honest answer; the plain non-repo
    // below is the control that says the quiet branch still exists.
    const noGit = new GitService({ file: 'sb-785-definitely-not-git', prefixArgs: [] });
    await expect(noGit.diff(plain)).rejects.toThrow(/not be installed|PATH/);

    const damaged = tempDir('sb-785-diff-damaged-');
    fs.writeFileSync(path.join(damaged, '.git'), 'this is not a gitdir line\n');
    await expect(svc.diff(damaged)).rejects.toThrow(/invalid gitfile format/);

    expect(await svc.diff(plain)).toEqual({ isRepo: false, text: '' });
  });

  /**
   * A git whose `rev-parse` fails with exactly the stderr it is handed.
   *
   * ⚠️ **REAL GIT CANNOT DRIVE THESE TWO PORTABLY, AND CI IS WHERE THAT WAS
   * MEASURED.** The first cut used a real `.git` file naming a hostile gitdir,
   * because git echoes that path straight back into "not a git repository:
   * <path>" — measured on the dev machine, git 2.51.0.windows.2. **Both CI
   * runners print `(null)` / `(NULL)` for the identical fixture**, ubuntu and
   * windows alike, so this is a git BUILD difference and not a platform one,
   * and the assumption that it was platform-shaped was wrong twice over. The
   * bait never reached the parser there, and the tests failed on the runners
   * while passing locally.
   *
   * The vector is real on at least one shipping git, and `detected dubious
   * ownership in repository at '<path>'` echoes an attacker-writable path on
   * every one of them — so the defence stays, and it is asserted against the
   * PARSER with a message we control rather than against whichever phrasing the
   * local git happens to use. That is the right level anyway: what is being
   * tested is `saysNotARepo`, not git's wording.
   */
  function stderrGit(message: string): GitService {
    const dir = tempDir('sb-785-stderr-');
    const script = path.join(dir, 'fake-git.js');
    fs.writeFileSync(
      script,
      `(() => {
        process.stderr.write(process.argv[2] + '\\n');
        process.exitCode = 128;
      })();`
    );
    return new GitService({ file: process.execPath, prefixArgs: [script, message] });
  }

  it('A REPOSITORY CANNOT TALK ITS WAY BACK INTO "not a git repository"', async () => {
    // ⚠️ #785 REVIEW. `saysNotARepo` searched the whole of stderr, and part of
    // that text is echoed from files a session — or, per #776's threat model, a
    // sibling agent — can write. Text naming the benign phrase reclassified a
    // damaged repository as a healthy one and restored the original lie on
    // demand. Anchored at position 0, the echoed half can never reach it.
    const bait = await stderrGit(
      "fatal: not a git repository: /tmp/not a git repository (or any of the parent directories)"
    ).status(tempDir('sb-785-hostile-'));
    expect(bait.unreadable).toBeTruthy();
    // The witness that the bait really did arrive — without it this passes
    // against a fixture whose message never reached the parser at all, which is
    // exactly how the first version of this test failed on Linux only.
    expect(bait.unreadable).toContain('not a git repository (or any');

    // THE CONTROL: the same phrase at position 0 is git's real benign message
    // and must still be quiet. Either assertion alone survives a `saysNotARepo`
    // that always answers the same way.
    const benign = await stderrGit(
      'fatal: not a git repository (or any of the parent directories): .git'
    ).status(tempDir('sb-785-benign-'));
    expect(benign).toEqual({ isRepo: false, files: [] });
  });

  it('a reason is capped and stripped of control characters before it is shown', async () => {
    // The same attacker-written text lands in a 200px pane and, through
    // `diff()`, in another model's context as unfenced prose. A 4 KB path is a
    // wall in one and a budget in the other; a control character has no
    // business in either.
    const s = await stderrGit(
      `fatal: not a git repository: /tmp/${'x'.repeat(400)}`
    ).status(tempDir('sb-785-longbait-'));
    expect(s.unreadable!.length).toBeLessThanOrEqual(201); // 200 + the ellipsis
    expect(s.unreadable).toContain('…');
    // The witness: the fixture really did produce an over-long message.
    expect(s.unreadable).toContain('xxxxxxxx');
  });

  it('⚠️ AN `execFile` THAT THROWS INSTEAD OF CALLING BACK IS STILL AN ANSWER', async () => {
    // ⚠️ FOUND BY CI, ON LINUX ONLY, INSIDE #785's OWN NEW CASE. Handing
    // `execFile` a `cwd` that is a FILE raises `spawn ENOTDIR` SYNCHRONOUSLY on
    // Linux, where the same call on Windows delivers `ENOENT` to the callback.
    // `status()` therefore REJECTED rather than returning a `GitStatus`, and the
    // pane's `.then` never ran at all — which breaks "our breakage never blocks
    // a session" on the one code path whose entire subject is folders that have
    // gone wrong. Pre-existing; #785's folder cases are what reached it.
    //
    // Driven through the `GitCommand` seam rather than by platform, so it is
    // the same test everywhere: a NUL in the file name is rejected by Node's
    // own argument validation, synchronously, before any spawn is attempted.
    // (Built from a code point — a typed escape would land in this file as a
    // literal NUL byte and `npm run lint` would reject it.)
    const throwing = new GitService({ file: `git${String.fromCharCode(0)}x`, prefixArgs: [] });
    const s = await throwing.status(plain);
    expect(s.isRepo).toBe(false);
    expect(s.unreadable).toMatch(/not be installed|PATH/);
    // …and `diff()` refuses rather than rejecting with a raw Node error.
    await expect(throwing.diff(plain)).rejects.toThrow(/not be installed|PATH/);
  });

  it('a path that is a FILE is not reported as a missing git', async () => {
    // Third wrong answer in the same branch (#785 review): a `cwd` pointing at a
    // file fails with the same ENOENT-shaped spawn error, and "git may not be
    // installed" is nonsense on a machine where git is fine.
    const file = path.join(tempDir('sb-785-file-'), 'a-file.txt');
    fs.writeFileSync(file, 'not a folder\n');
    const s = await svc.status(file);
    expect(s.unreadable).toContain('not a folder');
    expect(s.unreadable).not.toMatch(/installed|PATH/);
  });

  it('⚠️ A STALLED CAPABILITY PROBE IS NOT "your git is too old", AND IS NOT REMEMBERED', async () => {
    // ⚠️ THE BLOCKER #785's REVIEW FOUND, inside #785's own fix. The probe's
    // answer was memoised as `r.ok && …`, and `r.ok` is false for a probe that
    // TIMED OUT — which says nothing about this git's version. On the app-wide
    // service that cached `false` then told the user, for EVERY project until
    // restart, that their git was too old and to upgrade it. #785 is what made
    // the sentence specific enough for that to be a lie worth stopping.
    //
    // The repo names a driver, so the probe is actually reached.
    //
    // ⚠️ ON A CLOCK THE TEST MOVES, NOT A 250 ms BUDGET (#1025). The guard's
    // budget is SHARED: the config read and the submodule read spend it before
    // the probe gets what is left. Each is a `node` start, so under load — and,
    // measured, sometimes ALONE on a pristine `main` — they outlasted 250 ms,
    // the budget ran out on the config read, and the refusal was the other
    // correct sentence ("could not enumerate"). The test was racing its own
    // stand-in. Now the budget is one no real work can spend, the stand-in says
    // when it is IN the stall, and only then does the clock jump past it.
    const { svc: svcSlow, stalled } = hangingProbeGit();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const reading = svcSlow.status(tempDir('sb-785-hang-a-'), 60_000);
    await reached('the capability probe', () => fs.existsSync(stalled));
    vi.advanceTimersByTime(60_000);
    const first = await reading;
    vi.useRealTimers();
    expect(first.unreadable).toMatch(/could not check/);
    expect(first.unreadable).not.toMatch(/too old/);

    // ⚠️ **AND IT WAS FORGOTTEN — the half that made the defect app-wide.** The
    // stand-in stalls ONCE and answers properly from then on, which is what a
    // transient hiccup looks like. A remembered `false` (or a remembered
    // `null`) refuses this read too, for the life of the process, on every
    // project. It has to come back clean.
    const second = await svcSlow.status(tempDir('sb-785-hang-b-'));
    expect(second.unreadable).toBeUndefined();
    expect(second.isRepo).toBe(true);
  });

  /**
   * A git that names a repo-authored driver and HANGS on the capability probe
   * the FIRST time it is asked, then answers normally — a slow or network
   * checkout having one bad moment, which is the shape the review blocker
   * turned into a permanent verdict.
   */
  function hangingProbeGit(): { svc: GitService; stalled: string } {
    const dir = tempDir('sb-785-hangprobe-');
    const script = path.join(dir, 'fake-git.js');
    const stalled = path.join(dir, 'stalled-once');
    fs.writeFileSync(
      script,
      `(() => {
        const fs = require('fs');
        const NUL = String.fromCharCode(0);
        const once = process.argv[2];
        const args = process.argv.slice(3);
        let sub = '';
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '-c') { i++; continue; }
          if (args[i].startsWith('-')) continue;
          sub = args[i];
          break;
        }
        if (sub === 'rev-parse') return process.stdout.write('true\\n');
        if (sub === 'ls-files') return;
        if (sub === 'config') {
          if (args.includes('--get') && args.includes('switchboard.guardprobe')) {
            if (!fs.existsSync(once)) {
              fs.writeFileSync(once, 'x');
              return setInterval(() => {}, 60000);   // the one bad moment
            }
            // …and afterwards it is an ordinary git >= 2.31.
            const count = Number(process.env.GIT_CONFIG_COUNT || 0);
            for (let i = 0; i < count; i++) {
              if (process.env['GIT_CONFIG_KEY_' + i] === 'switchboard.guardprobe') {
                return process.stdout.write(process.env['GIT_CONFIG_VALUE_' + i] + '\\n');
              }
            }
            return process.exit(1);
          }
          return process.stdout.write('local' + NUL + 'filter.x.clean\\ntouch pwned' + NUL);
        }
        if (sub === 'status') return process.stdout.write('# branch.head main\\n');
      })();`
    );
    return { svc: new GitService({ file: process.execPath, prefixArgs: [script, stalled] }), stalled };
  }

  it('git or the folder vanishing MID-READ keeps its diagnosis', async () => {
    // Reachable only between the probe and the read itself (review nit): a
    // folder deleted after `rev-parse` said it was a work tree. Without the
    // `no-exec` branch on the status call, the answer is "git status did not
    // succeed, and said nothing about why" — true, and useless, when the actual
    // diagnosis is still available.
    //
    // The stand-in deletes its own working directory once the guard's last read
    // is done, which is exactly the case: an unplugged drive, mid-read.
    const dir = tempDir('sb-785-vanish-');
    const holder = tempDir('sb-785-vanish-script-');
    const script = path.join(holder, 'fake-git.js');
    fs.writeFileSync(
      script,
      `(() => {
        const fs = require('fs');
        const os = require('os');
        const args = process.argv.slice(2);
        let sub = '';
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '-c') { i++; continue; }
          if (args[i].startsWith('-')) continue;
          sub = args[i];
          break;
        }
        if (sub === 'rev-parse') return process.stdout.write('true\\n');
        if (sub === 'config') return;
        if (sub === 'ls-files') {
          // The guard is finished with this folder; take it away before the
          // read. chdir first — Windows will not remove a live process's cwd.
          const doomed = process.cwd();
          process.chdir(os.tmpdir());
          try { fs.rmSync(doomed, { recursive: true, force: true }); } catch {}
          return;
        }
      })();`
    );
    const vanishing = new GitService({ file: process.execPath, prefixArgs: [script] });

    const s = await vanishing.status(dir);
    // The witness that the fixture really did what it claims — otherwise this
    // asserts against a folder that was never removed.
    expect(fs.existsSync(dir)).toBe(false);
    expect(s.isRepo).toBe(true); // `rev-parse` had already said so
    expect(s.unreadable).toContain('no longer exists');
    expect(s.unreadable).not.toMatch(/said nothing about why/);
  });

  it('git’s messages are asked for in a pinned locale, or the discrimination is a coin toss', async () => {
    // git translates through gettext, and `saysNotARepo` reads one of those
    // messages: under a translated git, "not a git repository (or any" never
    // matches and EVERY ordinary folder comes back unreadable. So the service
    // pins the locale on every invocation.
    //
    // Asserted by asking the child what it was HANDED, not by running a
    // translated git — this machine has no French git catalogue, so a test that
    // set LANGUAGE and checked the answer was still English would pass against
    // a service that pinned nothing at all. LANGUAGE is checked too because
    // gettext consults it before LC_ALL.
    const dir = tempDir('sb-785-locale-');
    const script = path.join(dir, 'echo-locale.js');
    fs.writeFileSync(
      script,
      `(() => {
        process.stderr.write('fatal: LC_ALL=[' + process.env.LC_ALL + '] LANGUAGE=[' + process.env.LANGUAGE + ']\\n');
        process.exitCode = 128;
      })();`
    );
    const echoing = new GitService({ file: process.execPath, prefixArgs: [script] });
    const saved = { lc: process.env.LC_ALL, lang: process.env.LANGUAGE };
    process.env.LC_ALL = 'fr_FR.UTF-8';
    process.env.LANGUAGE = 'fr_FR';
    try {
      const s = await echoing.status(dir);
      expect(s.unreadable).toBe('LC_ALL=[C] LANGUAGE=[]');
    } finally {
      if (saved.lc === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = saved.lc;
      if (saved.lang === undefined) delete process.env.LANGUAGE;
      else process.env.LANGUAGE = saved.lang;
    }
  });
  // Real git in a child process, several times per case (#512).
}, 60_000);

// The other half of E24 Git v2 item 1. `git-log.test.ts` owns the FRAMING,
// against fixture bytes; this suite owns the one thing fixtures cannot prove —
// that real git still emits bytes of that shape, and that every way the
// invocation can fail lands in the right field.
describe('GitService.log (E24 Git v2 item 1)', () => {
  /** A repository with every shape of commit the parser has a branch for. */
  let hist: string;

  beforeAll(() => {
    hist = tempDir('sb-git-log-');
    sh(hist, ['init', '-b', 'main']);
    sh(hist, ['config', 'user.email', 'log@test']);
    sh(hist, ['config', 'user.name', 'Log Tester']);
    fs.writeFileSync(path.join(hist, 'a.txt'), 'one\n');
    sh(hist, ['add', '.']);
    sh(hist, ['commit', '-m', 'root commit']);
    sh(hist, ['tag', 'v1']);
    // An EMPTY commit: the case that prints no diffstat and abuts the next sha.
    sh(hist, ['commit', '--allow-empty', '-m', 'empty commit']);
    sh(hist, ['checkout', '-b', 'side']);
    fs.writeFileSync(path.join(hist, 's.txt'), 's\n');
    sh(hist, ['add', '.']);
    sh(hist, ['commit', '-m', 'on the side branch']);
    sh(hist, ['checkout', 'main']);
    fs.writeFileSync(path.join(hist, 'm.txt'), 'm\n');
    sh(hist, ['add', '.']);
    sh(hist, ['commit', '-m', 'on main']);
    // A MERGE, with a body that is nothing but newlines — this repository's own
    // commit shape, and the reason `-z` is in the command.
    sh(hist, ['merge', '--no-ff', 'side', '-m', 'merge side\n\nwith a body\n\nand blank lines']);
  }, 60_000);

  it('is graceful for non-repos, like the rest of this service (the done-when)', async () => {
    expect(await svc.log(plain)).toEqual({ isRepo: false, commits: [] });
  });

  it('reads the history real git emits, in the shape the parser expects', async () => {
    const l = await svc.log(hist);
    expect(l.isRepo).toBe(true);
    expect(l.unreadable).toBeUndefined();
    // five commits: root, empty, side, main, merge
    expect(l.commits).toHaveLength(5);
    const subjects = l.commits.map((c) => c.subject);
    expect(subjects).toContain('merge side');
    expect(subjects).toContain('root commit');
    expect(l.commits[0].author).toBe('Log Tester');
    expect(l.commits[0].authorEmail).toBe('log@test');
    // Real seconds-since-epoch, not NaN from a misread field.
    expect(Number.isInteger(l.commits[0].timestamp)).toBe(true);
    expect(l.commits[0].timestamp).toBeGreaterThan(1_600_000_000);
  });

  it('a BODY OF BLANK LINES survives a round trip through real git', async () => {
    const l = await svc.log(hist);
    const merge = l.commits.find((c) => c.subject === 'merge side');
    expect(merge).toBeDefined();
    expect(merge?.message).toContain('with a body');
    expect(merge?.message).toContain('and blank lines');
    // Two parents, which is what item 3's lane allocator draws the fork from.
    expect(merge?.parentIds).toHaveLength(2);
    // `--diff-merges=first-parent` is what gives it a diffstat at all.
    expect(merge?.stats).not.toBeNull();
  });

  it('the ROOT COMMIT has no parents and still carries a diffstat', async () => {
    const l = await svc.log(hist);
    const root = l.commits.find((c) => c.subject === 'root commit');
    expect(root?.parentIds).toEqual([]);
    expect(root?.stats).toEqual({ files: 1, insertions: 1, deletions: 0 });
  });

  it('an EMPTY COMMIT reports NO diffstat, and does not swallow its neighbour', async () => {
    // The measured edge case: `<fields>NUL<next sha>` with no line between. The
    // second assertion is the one that would fail if the parser ate the next
    // record — the count above would drop and this subject would vanish.
    const l = await svc.log(hist);
    const empty = l.commits.find((c) => c.subject === 'empty commit');
    expect(empty).toBeDefined();
    expect(empty?.stats).toBeNull();
    expect(l.commits.map((c) => c.subject)).toContain('on main');
  });

  it('decorates with FULL refnames, so a branch and a tag are distinguishable', async () => {
    const l = await svc.log(hist);
    const head = l.commits.find((c) => c.references.some((r) => r.isHead));
    expect(head?.references.some((r) => r.kind === 'branch' && r.name === 'main')).toBe(true);
    const tagged = l.commits.find((c) => c.subject === 'root commit');
    expect(tagged?.references).toEqual(
      expect.arrayContaining([{ kind: 'tag', name: 'v1', full: 'refs/tags/v1' }])
    );
  });

  it('honours the limit and pages with skip', async () => {
    const two = await svc.log(hist, { limit: 2 });
    expect(two.commits).toHaveLength(2);
    const skipped = await svc.log(hist, { limit: 2, skip: 2 });
    expect(skipped.commits).toHaveLength(2);
    expect(skipped.commits[0].id).not.toBe(two.commits[0].id);
    // Paging must not overlap, or the tab's "load more" duplicates rows.
    const ids = new Set([...two.commits, ...skipped.commits].map((c) => c.id));
    expect(ids.size).toBe(4);
  });

  it('filters to one path when asked, which is what item 10 is built on', async () => {
    const l = await svc.log(hist, { path: 's.txt' });
    const subjects = l.commits.map((c) => c.subject);
    // The commit that created the file, and nothing that did not touch it.
    expect(subjects).toContain('on the side branch');
    expect(subjects).not.toContain('on main');
    expect(subjects).not.toContain('root commit');
    // ⚠️ AND THE MERGE IS IN THERE, WHICH IS `--diff-merges=first-parent`'s DOING
    // — measured, not expected. That flag suppresses the history simplification
    // which would otherwise hide a merge that is TREESAME to one parent, so a
    // path-filtered log lists both the commit that made the change and the merge
    // that brought it to this branch. Asserted rather than worked around: it is
    // correct for the main history (an "evil merge" that really did change the
    // file must not be invisible) and it is item 10's decision whether a
    // per-file timeline wants the merge row. Pinning it here is what stops item
    // 10 discovering it by surprise.
    expect(subjects).toContain('merge side');
  });

  it('`stats: false` still reads the history — it only drops the numbers', async () => {
    // The cost switch, and the half of it a fixture cannot prove: that the lean
    // query is still a WORKING query. `--shortstat` is 95% of the wall time
    // (measured, 1,331 ms of 1,395 ms over 100 commits), so a surface that draws
    // no numbers should be able to skip it — but not by asking a different
    // question.
    const lean = await svc.log(hist, { stats: false });
    expect(lean.isRepo).toBe(true);
    expect(lean.unreadable).toBeUndefined();
    expect(lean.commits).toHaveLength(5);
    expect(lean.commits.map((c) => c.subject)).toContain('merge side');
    // Every one of them reports `null`, which is the same shape an empty commit
    // reports — "we did not ask" and "git said nothing" are indistinguishable to
    // a consumer, and that is fine because both mean "do not draw a number".
    expect(lean.commits.every((c) => c.stats === null)).toBe(true);
    // Refs and parents are metadata, not diff, so they survive — this is what
    // makes the lean query usable by item 3's lane allocator.
    const merge = lean.commits.find((c) => c.subject === 'merge side');
    expect(merge?.parentIds).toHaveLength(2);
  });

  it('a ref that could be read as a FLAG never reaches argv', async () => {
    // `git-log.test.ts` pins the guard against the args; this pins that the
    // guard's fallback produces a WORKING read rather than a git error — the
    // whole point of dropping to HEAD instead of passing the ref through.
    const l = await svc.log(hist, { refs: ['--all'] });
    expect(l.isRepo).toBe(true);
    expect(l.unreadable).toBeUndefined();
    expect(l.commits.length).toBeGreaterThan(0);
  });

  it('a repo with NO COMMITS says so — it is UNBORN, not unreadable', async () => {
    // With the explicit `HEAD` that `logArgs` always passes, git answers
    // `fatal: bad revision 'HEAD'` — byte-identical to a typo'd ref (measured).
    // Matching on that message would report a fresh `git init` as broken. The
    // distinction is made by asking `rev-parse` after the failure.
    const unborn = tempDir('sb-git-log-unborn-');
    sh(unborn, ['init', '-b', 'main']);
    sh(unborn, ['config', 'user.email', 'test@test']);
    sh(unborn, ['config', 'user.name', 'test']);
    const l = await svc.log(unborn);
    expect(l).toEqual({ isRepo: true, unborn: true, commits: [] });
    expect(l.unreadable).toBeUndefined();
  });

  it('a CORRUPT branch ref is not reported as a fresh repository (review)', async () => {
    // ⚠️ THE BUG THIS PINS, found in review and measured. `rev-parse --verify -q
    // HEAD` fails for an unborn HEAD AND for a zero-byte `.git/refs/heads/main` —
    // the classic post-crash corruption, and a file an edit-only agent can write.
    // With that as the only test, a damaged repository was reported as a brand-new
    // `git init`: the same shape of confident wrong answer #785 was filed for.
    // `symbolic-ref -q HEAD` is the positive discriminator — exit 0 on a fresh
    // init, exit 128 here (measured).
    const corrupt = tempDir('sb-git-log-corruptref-');
    sh(corrupt, ['init', '-b', 'main']);
    sh(corrupt, ['config', 'user.email', 'test@test']);
    sh(corrupt, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(corrupt, 'f.txt'), 'hello\n');
    sh(corrupt, ['add', '.']);
    sh(corrupt, ['commit', '-m', 'init']);
    // Zero-byte the ref. `git gc` may have packed it, so write the loose file
    // either way — a zero-byte loose ref shadows a packed one.
    fs.mkdirSync(path.join(corrupt, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(corrupt, '.git', 'refs', 'heads', 'main'), '');

    const l = await svc.log(corrupt);
    expect(l.isRepo).toBe(true);
    // The fact this test owns: NOT unborn.
    expect(l.unborn).toBeUndefined();
    expect(l.unreadable).toBeTruthy();
  });

  it('⚠️ a repo config cannot make `git log` SPAWN A PROGRAM (review, #776 class)', async () => {
    // MEASURED IN REVIEW, and it was a live hole. `log` is the first command in
    // this service that reads COMMIT objects, and a commit can carry a `gpgsig`
    // header. Two repo-local keys — both inside #776's threat model — then make
    // git launch anything:
    //
    //     [log] showSignature = true
    //     [gpg] program = <any path>
    //
    // One spawn per signed commit, `git log` EXITS 0, and stdout parses
    // perfectly, so nothing in the answer records that it happened. Neither
    // `guardArgs()` (fsmonitor + hooksPath) nor `guardEnv()` (filter drivers)
    // closes it. `--no-show-signature` does.
    //
    // The commit object is FORGED rather than signed, because that needs no gpg
    // on the machine running the test — git does not check that the signature is
    // real before trying to verify it.
    const signed = tempDir('sb-git-log-gpg-');
    sh(signed, ['init', '-b', 'main']);
    sh(signed, ['config', 'user.email', 'test@test']);
    sh(signed, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(signed, 'f.txt'), 'one\n');
    sh(signed, ['add', '.']);
    sh(signed, ['commit', '-m', 'init']);
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: signed, encoding: 'utf8' }).trim();
    const parent = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: signed, encoding: 'utf8' }).trim();
    const object =
      `tree ${tree}\nparent ${parent}\n` +
      'author t <t@t> 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\n' +
      'gpgsig -----BEGIN PGP SIGNATURE-----\n \n forged\n -----END PGP SIGNATURE-----\n' +
      '\nsigned commit\n';
    const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
      cwd: signed,
      input: object,
      encoding: 'utf8',
    }).trim();
    sh(signed, ['update-ref', 'refs/heads/main', sha]);
    // The evidence is git's own stderr. ⚠️ **A SENTINEL FILE WRITTEN BY A FAKE
    // GPG WAS TRIED FIRST AND DOES NOT WORK** — measured: `gpg.program` is
    // spawned directly rather than through a shell, so neither
    // `"<node.exe> <script.js>"` nor a `.bat` ever runs, and a test built on one
    // would report "it never ran" for a repository where git tried its hardest.
    // That is the vacuous-verdict trap `spike/findings` keeps recording (#760), so
    // the assertion is on the thing git demonstrably does say: *"cannot spawn"*.
    const program = toPosix(path.join(signed, 'definitely-not-a-real-program'));
    sh(signed, ['config', 'log.showSignature', 'true']);
    sh(signed, ['config', 'gpg.program', program]);

    /**
     * git's stderr for one log invocation.
     *
     * `spawnSync`, not `execFileSync`: **git EXITS 0 here** — the spawn failure is
     * a warning, not an error, which is the whole reason this hole was silent —
     * and `execFileSync` returns only stdout on success, so a first attempt at
     * this helper read an empty string and reported the control as having passed.
     */
    const stderrOf = (args: string[]): string =>
      String(spawnSync('git', args, { cwd: signed, encoding: 'utf8' }).stderr ?? '');

    // ⚠️ **THE POSITIVE CONTROL FIRST, BECAUSE WITHOUT IT THIS TEST IS VACUOUS.**
    // A fixture whose forged `gpgsig` header did not take, or a git that ignored
    // the config key, would sail through the real assertion below while proving
    // nothing at all. So the hole is DEMONSTRATED — same argv, minus the one flag
    // — and only then shown to be closed.
    //
    // ⚠️ **MATCHED ON THE PROGRAM'S OWN NAME, NOT ON GIT'S WORDING (found by CI).**
    // The first version asserted `'cannot spawn'`, which is what git says on
    // Windows; Linux says `fatal: cannot exec '<path>'`. The claim this test owns
    // is "git reached for the program", and the program's name is the part of the
    // sentence that is the same everywhere.
    const unguarded = stderrOf(['log', '--format=%H', '-n', '1', 'HEAD']);
    expect(unguarded).toContain('definitely-not-a-real-program');
    const guarded = stderrOf(['log', '--no-show-signature', '--format=%H', '-n', '1', 'HEAD']);
    expect(guarded).not.toContain('definitely-not-a-real-program');

    // And the service, whose argv carries the flag (pinned in `git-log.test.ts`),
    // reads the signed commit without git reaching for the program at all.
    const l = await svc.log(signed);
    expect(l.isRepo).toBe(true);
    expect(l.unreadable).toBeUndefined();
    expect(l.commits.map((c) => c.subject)).toContain('signed commit');
  });

  it('⚠️ a repo config cannot turn the history into "no commits yet" (review)', async () => {
    // MEASURED IN REVIEW. `i18n.logOutputEncoding = UTF-16LE` re-encodes
    // everything git writes — every byte followed by a NUL — so the parser finds
    // no record anywhere while git exits 0. Without `--encoding=UTF-8` the tab
    // would have drawn "this project has no commits yet" about a repository with
    // a full history: a confident wrong answer about the user's project.
    const utf16 = tempDir('sb-git-log-utf16-');
    sh(utf16, ['init', '-b', 'main']);
    sh(utf16, ['config', 'user.email', 'test@test']);
    sh(utf16, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(utf16, 'f.txt'), 'one\n');
    sh(utf16, ['add', '.']);
    sh(utf16, ['commit', '-m', 'a real commit']);
    sh(utf16, ['config', 'i18n.logOutputEncoding', 'UTF-16LE']);

    const l = await svc.log(utf16);
    expect(l.isRepo).toBe(true);
    expect(l.unborn).toBeUndefined();
    expect(l.commits.map((c) => c.subject)).toEqual(['a real commit']);
  });

  it('does NOT pay the #776 config guard — measured, `--shortstat` runs no driver', async () => {
    // `status()` and `diff()` both read the repository's config and enumerate its
    // submodules first, because both were measured to RUN a repo-configured
    // driver. `log --shortstat` was measured not to: it uses git's internal
    // diffstat machinery and never materialises a blob through a filter. This
    // test is the standing proof of that measurement — a hostile repository with
    // all three kinds of driver configured, whose output must be a clean log.
    //
    // If somebody adds `-p` or `--numstat` to the command, THIS is the test that
    // goes red, and the fix is to pay the guard rather than to relax the test.
    const hostile = tempDir('sb-git-log-hostile-');
    sh(hostile, ['init', '-b', 'main']);
    sh(hostile, ['config', 'user.email', 'test@test']);
    sh(hostile, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(hostile, 'f.txt'), 'one\n');
    sh(hostile, ['add', '.']);
    sh(hostile, ['commit', '-m', 'init']);
    fs.writeFileSync(path.join(hostile, 'f.txt'), 'two\n');
    sh(hostile, ['add', '.']);
    sh(hostile, ['commit', '-m', 'second']);

    // ⚠️ **EACH DRIVER WRITES A SENTINEL FILE, AND THE FIRST VERSION OF THIS TEST
    // ONLY CHECKED STDOUT (found in review).** `expect(output).not.toContain
    // ('PWNED')` proves the ANSWER was not polluted, which is not the claim — a
    // driver that writes a file, deletes something or dials out passes it
    // unchanged. #776's threat is execution, so the assertion has to be about
    // execution.
    //
    // ⚠️ **AND THE CONFIG GOES IN *AFTER* THE COMMITS, WHICH IS WHAT CI CAUGHT.**
    // It used to be set before `git add`, and `git add` RUNS `filter.clean` — so
    // on Linux the sentinel was written by this test's own fixture and the
    // assertion failed against a service that had done nothing wrong. On Windows
    // the same fixture wrote no sentinel at all, for a third reason (the writer
    // command was not runnable there), so the test was simultaneously broken and
    // vacuous on the two platforms. Nothing below this line runs git except the
    // controls and the subject.
    const ran = (name: string): string => path.join(hostile, `${name}-ran.txt`);
    // `sh -c`, because that is how git invokes a config-supplied command on BOTH
    // platforms — git for Windows bundles `sh`. A `<node.exe> <script.js>` pair is
    // not runnable there, which is exactly how the Windows arm of this test came
    // to prove nothing.
    const writer = (name: string): string => `sh -c "echo ran > '${toPosix(ran(name))}'; cat"`;
    fs.writeFileSync(path.join(hostile, '.gitattributes'), '*.txt filter=hostile diff=hostile\n');
    sh(hostile, ['config', 'diff.external', writer('extdiff')]);
    sh(hostile, ['config', 'diff.hostile.textconv', writer('textconv')]);
    sh(hostile, ['config', 'filter.hostile.clean', writer('clean')]);

    // ⚠️ **POSITIVE CONTROLS, BECAUSE "NOTHING RAN" IS THE EASIEST RESULT IN THE
    // WORLD TO GET FOR THE WRONG REASON.** A writer that cannot start, an
    // attribute that does not match, a config key spelled wrong: each produces an
    // untouched sentinel and a green test. So each driver is first shown to be
    // live on THIS machine, through a git command that is known to reach it, and
    // only then is `log` shown not to.
    fs.writeFileSync(path.join(hostile, 'f.txt'), 'three\n');
    sh(hostile, ['add', 'f.txt']); // runs filter.clean
    expect(fs.existsSync(ran('clean'))).toBe(true);
    // Plain `git diff`, with none of our flags: `diff.external` wins over
    // textconv, so this proves the external driver and leaves textconv's own
    // control to the absence of `--no-textconv` below.
    execFileSync('git', ['diff', 'HEAD~1', 'HEAD'], { cwd: hostile, stdio: 'ignore' });
    expect(fs.existsSync(ran('extdiff'))).toBe(true);
    execFileSync('git', ['--no-pager', 'diff', '--no-ext-diff', 'HEAD~1', 'HEAD'], {
      cwd: hostile,
      stdio: 'ignore',
    });
    expect(fs.existsSync(ran('textconv'))).toBe(true);

    // Clean slate, and put the worktree back where the commits left it so `log`
    // sees the repository the controls did.
    for (const name of ['extdiff', 'textconv', 'clean']) fs.unlinkSync(ran(name));
    sh(hostile, ['reset', '--hard', 'HEAD']);
    for (const name of ['extdiff', 'textconv', 'clean']) {
      // `reset --hard` runs `smudge`, not these three — asserted rather than
      // assumed, so a surprise there is attributed to `reset` and not to `log`.
      expect(fs.existsSync(ran(name))).toBe(false);
    }

    const l = await svc.log(hostile);
    expect(l.isRepo).toBe(true);
    expect(l.commits.map((c) => c.subject)).toEqual(['second', 'init']);
    for (const name of ['extdiff', 'textconv', 'clean']) {
      expect(fs.existsSync(ran(name))).toBe(false);
    }
  });

  it('a TIMEOUT says it timed out, not that the repository is unreadable for another reason', async () => {
    // The seam the rest of this file uses for the kill paths: a process that
    // never exits where git would be. `isRepo` stays false because the probe
    // itself is what timed out — we never got as far as being told it is a repo.
    const hanging = tempDir('sb-git-log-hang-');
    const script = path.join(hanging, 'hang.js');
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
    const stuck = new GitService({ file: process.execPath, prefixArgs: [script] });
    const l = await stuck.log(hanging, {}, 300);
    expect(l.unreadable).toMatch(/did not finish reading the history/);
    expect(l.commits).toEqual([]);
  });

  it('a BROKEN repository carries git own account of why', async () => {
    // Same fixture shape as `diff()`'s: a corrupt loose object makes the log
    // command fail while `rev-parse --is-inside-work-tree` still succeeds. The
    // answer must not be `unborn` — `rev-parse --verify HEAD` succeeds here, and
    // calling a damaged repository "has no commits yet" is the confident wrong
    // answer this service keeps being corrected for.
    const broken = tempDir('sb-git-log-broken-');
    sh(broken, ['init', '-b', 'main']);
    sh(broken, ['config', 'user.email', 'test@test']);
    sh(broken, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(broken, 'f.txt'), 'hello\n');
    sh(broken, ['add', '.']);
    sh(broken, ['commit', '-m', 'init']);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: broken, encoding: 'utf8' }).trim();
    const objectPath = path.join(broken, '.git', 'objects', commit.slice(0, 2), commit.slice(2));
    fs.chmodSync(objectPath, 0o666);
    fs.writeFileSync(objectPath, 'not a git object');

    const l = await svc.log(broken);
    expect(l.isRepo).toBe(true);
    expect(l.unborn).toBeUndefined();
    expect(l.unreadable).toBeTruthy();
  });

  it('a BARE repository is not a work tree, and says so plainly', async () => {
    // It has a history, but no working tree to show it beside. A clean answer,
    // and not a failure — the same branch `status()` takes.
    const bare = tempDir('sb-git-log-bare-');
    sh(bare, ['init', '--bare', '-b', 'main']);
    const l = await svc.log(bare);
    expect(l).toEqual({ isRepo: false, commits: [] });
  });
  // Real git in a child process, several times per case (#512).
}, 60_000);

// The per-file `+/−` against REAL git (E24 Git v2 item 7). `git-numstat.test.ts`
// owns the framing against fixture bytes; this owns the half fixtures cannot
// prove — that real git still emits that shape, and that the numbers ride on the
// status snapshot rather than on a second one that could disagree with it.
describe('GitService.status with stats (E24 Git v2 item 7)', () => {
  it('⚠️ asks for NOTHING extra unless told to, which is the whole cost argument', async () => {
    // `status()` is the card header's changed-count poll, for every card,
    // repeatedly — and that surface draws no numbers at all. `undefined` is not
    // `{}`: it says the caller did not pay, where `{}` would say it asked and
    // nothing has changed.
    const plainStatus = await svc.status(repo);
    expect(plainStatus.stats).toBeUndefined();
  });

  it('counts the two sides SEPARATELY, because the groups draw them separately', async () => {
    const both = tempDir('sb-git-numstat-');
    sh(both, ['init', '-b', 'main']);
    sh(both, ['config', 'user.email', 'test@test']);
    sh(both, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(both, 'f.txt'), 'a\nb\nc\n');
    sh(both, ['add', '.']);
    sh(both, ['commit', '-m', 'init']);
    // staged: one line changed. then unstaged on TOP of that: one more line.
    fs.writeFileSync(path.join(both, 'f.txt'), 'a\nB\nc\n');
    sh(both, ['add', 'f.txt']);
    fs.writeFileSync(path.join(both, 'f.txt'), 'a\nB\nc\nd\n');

    const s = await svc.status(both, undefined, true);
    expect(s.stats?.['f.txt']?.staged).toEqual({ insertions: 1, deletions: 1 });
    expect(s.stats?.['f.txt']?.unstaged).toEqual({ insertions: 1, deletions: 0 });
  });

  it('⚠️ a RENAME is ONE row, under its NEW name', async () => {
    // The measured framing case: `0\t0\t\0old\0new\0` — an empty path field and
    // two more NUL fields after it. A parser that read each NUL chunk as a record
    // would produce three wrong rows and say nothing. `git mv` is a thing agents
    // do constantly.
    const moved = tempDir('sb-git-rename-');
    sh(moved, ['init', '-b', 'main']);
    sh(moved, ['config', 'user.email', 'test@test']);
    sh(moved, ['config', 'user.name', 'test']);
    fs.writeFileSync(
      path.join(moved, 'old-name.ts'),
      Array.from({ length: 20 }, (_, i) => `export const k${i} = ${i};`).join('\n') + '\n'
    );
    sh(moved, ['add', '.']);
    sh(moved, ['commit', '-m', 'init']);
    sh(moved, ['mv', 'old-name.ts', 'new-name.ts']);

    const s = await svc.status(moved, undefined, true);
    expect(s.stats?.['new-name.ts']).toBeDefined();
    // The old name is not a row of its own, and there is no nameless row either.
    expect(s.stats?.['old-name.ts']).toBeUndefined();
    expect(Object.keys(s.stats ?? {})).toEqual(['new-name.ts']);
  });

  it('⚠️ a BINARY file reports binary, not `+0 −0`', async () => {
    const bin = tempDir('sb-git-binary-');
    sh(bin, ['init', '-b', 'main']);
    sh(bin, ['config', 'user.email', 'test@test']);
    sh(bin, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(bin, 'blob.dat'), Buffer.from([0, 1, 2, 0, 3, 4]));
    sh(bin, ['add', '.']);
    sh(bin, ['commit', '-m', 'init']);
    fs.writeFileSync(path.join(bin, 'blob.dat'), Buffer.from([0, 9, 9, 9, 9, 9, 0, 7]));

    const s = await svc.status(bin, undefined, true);
    expect(s.stats?.['blob.dat']?.unstaged?.binary).toBe(true);
  });

  it('an UNTRACKED file has a status row and NO stats, which is correct', async () => {
    // `git diff` does not see an untracked file at all. The row exists (porcelain
    // reports it) and has no numbers, so the renderer draws none — rather than a
    // zero that would read as "this new file is empty".
    const fresh = tempDir('sb-git-untracked-');
    sh(fresh, ['init', '-b', 'main']);
    sh(fresh, ['config', 'user.email', 'test@test']);
    sh(fresh, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(fresh, 'committed.txt'), 'x\n');
    sh(fresh, ['add', '.']);
    sh(fresh, ['commit', '-m', 'init']);
    fs.writeFileSync(path.join(fresh, 'brand-new.txt'), 'hello\n');

    const s = await svc.status(fresh, undefined, true);
    expect(s.files.map((f) => f.path)).toContain('brand-new.txt');
    expect(s.stats?.['brand-new.txt']).toBeUndefined();
  });

  it('⚠️ the stats come from the SAME snapshot as the file list', async () => {
    // One call, one guard, one moment. Two round trips would be two snapshots —
    // the file list from one and the numbers from another, drawn in the SAME ROW
    // — and a row reading `+12 −3` beside a file that is no longer changed is the
    // confident wrong answer this surface exists to stop giving. Asserted as the
    // invariant it implies: every path with stats is a path in the list.
    const s = await svc.status(repo, undefined, true);
    const listed = new Set(s.files.map((f) => f.path));
    for (const p of Object.keys(s.stats ?? {})) {
      expect(listed.has(p), `${p} has stats but is not in the file list`).toBe(true);
    }
  });

  it('⚠️ a stats read that FAILS costs the numbers, never the list', async () => {
    // The fail-open rule pointing the opposite way from where it points on the
    // status read itself: `status` is the answer and these are a decoration on
    // it. A repository whose `diff` cannot run (a corrupt blob) must still list
    // its files.
    const broken = tempDir('sb-git-numstat-broken-');
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

    const s = await svc.status(broken, undefined, true);
    expect(s.isRepo).toBe(true);
    expect(s.unreadable).toBeUndefined();
    expect(s.files.map((f) => f.path)).toContain('f.txt');
    // asked for, so present — and empty, because the read could not answer
    expect(s.stats).toEqual({});
  });
  // Real git in a child process, several times per case (#512).
}, 60_000);

describe('GitService.status and a MERGE CONFLICT (E24 Git v2 item 6)', () => {
  it('⚠️ lists a conflicted file at all — it used to be invisible', async () => {
    // THE PRE-EXISTING BUG THIS PINS. porcelain v2 reports an unmerged entry on
    // its own `u ` line, and the parser matched only `1 `, `2 ` and `? ` — so a
    // file in a merge conflict was **not listed in the Changes tab and not
    // counted in the card header's badge**. The one moment a user most needs to
    // see which files are in trouble, and the surface said nothing at all.
    const conflict = tempDir('sb-git-conflict-');
    sh(conflict, ['init', '-b', 'main']);
    sh(conflict, ['config', 'user.email', 'test@test']);
    sh(conflict, ['config', 'user.name', 'test']);
    sh(conflict, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(conflict, 'c.txt'), 'base\n');
    sh(conflict, ['add', '.']);
    sh(conflict, ['commit', '-m', 'base']);
    sh(conflict, ['checkout', '-b', 'side']);
    fs.writeFileSync(path.join(conflict, 'c.txt'), 'side\n');
    sh(conflict, ['commit', '-am', 'side']);
    sh(conflict, ['checkout', 'main']);
    fs.writeFileSync(path.join(conflict, 'c.txt'), 'main\n');
    sh(conflict, ['commit', '-am', 'main']);
    // The merge FAILS, which is the point — `sh` would throw on a non-zero exit.
    try {
      sh(conflict, ['merge', 'side']);
    } catch {
      /* expected: a conflict */
    }

    const s = await svc.status(conflict);
    const row = s.files.find((f) => f.path === 'c.txt');
    expect(row, 'a conflicted file is not in the list at all').toBeDefined();
    expect(row?.conflicted).toBe(true);
    // Both sides true, and neither is a guess: a conflict HAS content in the
    // index and differs from it in the worktree. So every consumer that asks one
    // of those two questions gets the honest answer without knowing about
    // conflicts at all.
    expect(row?.staged).toBe(true);
    expect(row?.unstaged).toBe(true);
    expect(row?.untracked).toBe(false);
    // `UU` — both sides modified, which is what the sidebar's Merge group reads.
    expect(row?.xy).toBe('UU');
  });

  it('an ordinary modification is NOT marked conflicted', async () => {
    // The other half, so the flag cannot be satisfied by setting it everywhere.
    const s = await svc.status(repo);
    expect(s.files.length).toBeGreaterThan(0);
    expect(s.files.every((f) => !f.conflicted)).toBe(true);
  });
  // Real git in a child process, several times per case (#512).
}, 60_000);

describe('GitService.status from a SUBDIRECTORY (E24 Git v2 item 7)', () => {
  it('⚠️ the stats still match their rows — two commands, two path bases', async () => {
    // ⚠️ **THE BUG THIS PINS, AND NOTHING IN THIS SUITE COULD HAVE CAUGHT IT**
    // because every other fixture points at a repository ROOT. Measured on git
    // 2.51.0.windows.2, both run with `cwd` = the session folder:
    //
    //   | run from      | status --porcelain=v2 | diff --numstat   |
    //   |---------------|-----------------------|------------------|
    //   | the repo root | sub/deep/f.txt        | sub/deep/f.txt   |
    //   | `sub/`        | **deep/f.txt**        | **sub/deep/f.txt** |
    //
    // `status` honours `status.relativePaths` (default TRUE) so its paths are
    // CWD-relative; `diff` is repo-root-relative unless told otherwise. They agree
    // only when the folder IS the top level. For a session rooted in a monorepo
    // package — an ordinary shape here — every `stats` key missed every row, so
    // **every row drew nothing and the totals bar called everything uncounted**,
    // with no reason anywhere. The only symptom was absence.
    //
    // Both sides are pinned now (`--relative` on the diffs, `status.relativePaths`
    // on the status) rather than left to config, because both keys are
    // repo-writable and either one flipping would break the match again.
    const mono = tempDir('sb-git-mono-');
    sh(mono, ['init', '-b', 'main']);
    sh(mono, ['config', 'user.email', 'test@test']);
    sh(mono, ['config', 'user.name', 'test']);
    fs.mkdirSync(path.join(mono, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(mono, 'sub', 'deep', 'f.txt'), 'a\nb\n');
    fs.writeFileSync(path.join(mono, 'root.txt'), 'r\n');
    sh(mono, ['add', '.']);
    sh(mono, ['commit', '-m', 'init']);
    fs.writeFileSync(path.join(mono, 'sub', 'deep', 'f.txt'), 'a\nB\nc\n');

    // THE SESSION FOLDER IS THE SUBDIRECTORY, not the repo root.
    const s = await svc.status(path.join(mono, 'sub'), undefined, true);
    expect(s.isRepo).toBe(true);
    // status reports it relative to the folder…
    expect(s.files.map((f) => f.path)).toEqual(['deep/f.txt']);
    // …and the numbers are keyed the SAME way, which is the whole assertion.
    expect(s.stats?.['deep/f.txt']).toEqual({ unstaged: { insertions: 2, deletions: 1 } });
    // Mutation-proof: the old behaviour keyed them `sub/deep/f.txt`, so asserting
    // the absence of that spelling is what makes this test fail against it.
    expect(s.stats?.['sub/deep/f.txt']).toBeUndefined();
    // And every stats key is a row, which is the invariant the sidebar relies on.
    const listed = new Set(s.files.map((f) => f.path));
    for (const p of Object.keys(s.stats ?? {})) expect(listed.has(p)).toBe(true);
  });

  it('⚠️ a repo-authored `status.relativePaths` cannot break the match', async () => {
    // Both keys are repo-writable — #776's threat model pointed at a number
    // rather than at a command. `status.relativePaths=false` would make status
    // report root-relative paths while the diffs stayed folder-relative, and every
    // row would silently lose its numbers again.
    const hostile = tempDir('sb-git-relpath-');
    sh(hostile, ['init', '-b', 'main']);
    sh(hostile, ['config', 'user.email', 'test@test']);
    sh(hostile, ['config', 'user.name', 'test']);
    fs.mkdirSync(path.join(hostile, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(hostile, 'sub', 'g.txt'), 'one\n');
    sh(hostile, ['add', '.']);
    sh(hostile, ['commit', '-m', 'init']);
    fs.writeFileSync(path.join(hostile, 'sub', 'g.txt'), 'two\n');
    sh(hostile, ['config', 'status.relativePaths', 'false']);
    sh(hostile, ['config', 'diff.relative', 'false']);

    const s = await svc.status(path.join(hostile, 'sub'), undefined, true);
    expect(s.files.map((f) => f.path)).toEqual(['g.txt']);
    expect(s.stats?.['g.txt']).toBeDefined();
  });
  // Real git in a child process, several times per case (#512).
}, 60_000);

// What one commit changed, against REAL git (E24 Git v2 item 4).
// `git-commit-files.test.ts` owns the framing against fixture bytes; this owns
// the half fixtures cannot prove — that real git still emits those two shapes,
// and that the ROOT COMMIT, which has no parent, is not an empty list.
describe('GitService.commitFiles (E24 Git v2 item 4)', () => {
  let hist: string;
  let head: { id: string; parentIds: string[] };
  let root: { id: string; parentIds: string[] };

  beforeAll(() => {
    hist = tempDir('sb-git-commitfiles-');
    sh(hist, ['init', '-b', 'main']);
    sh(hist, ['config', 'user.email', 'test@test']);
    sh(hist, ['config', 'user.name', 'test']);
    sh(hist, ['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(hist, 'd'), { recursive: true });
    fs.writeFileSync(path.join(hist, 'f.txt'), 'a\nb\n');
    fs.writeFileSync(path.join(hist, 'gone.txt'), 'x\n');
    fs.writeFileSync(
      path.join(hist, 'd', 'old.txt'),
      Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n'
    );
    sh(hist, ['add', '.']);
    sh(hist, ['commit', '-m', 'one']);
    const rootSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: hist, encoding: 'utf8' }).trim();
    root = { id: rootSha, parentIds: [] };
    // every shape in one commit: a modification, a deletion, a rename, an addition
    fs.writeFileSync(path.join(hist, 'f.txt'), 'a\nB\nc\n');
    fs.rmSync(path.join(hist, 'gone.txt'));
    sh(hist, ['mv', 'd/old.txt', 'd/new.txt']);
    fs.writeFileSync(path.join(hist, 'added.txt'), 'n\n');
    sh(hist, ['add', '-A']);
    sh(hist, ['commit', '-m', 'two']);
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: hist, encoding: 'utf8' }).trim();
    head = { id: headSha, parentIds: [rootSha] };
  }, 60_000);

  it('reads every shape of change in one commit, with its numbers (the done-when)', async () => {
    const { files, unreadable } = await svc.commitFiles(hist, head);
    expect(unreadable).toBeUndefined();
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(by['f.txt']).toMatchObject({ letter: 'M', insertions: 2, deletions: 1 });
    expect(by['added.txt']).toMatchObject({ letter: 'A', insertions: 1, deletions: 0 });
    expect(by['gone.txt']).toMatchObject({ letter: 'D', deletions: 1 });
    // ⚠️ THE RENAME IS ONE ROW, under its NEW name, and it REMEMBERS where it came
    // from — two paths in one record on both sides of the read.
    expect(by['d/new.txt']).toMatchObject({ letter: 'R', from: 'd/old.txt' });
    expect(by['d/old.txt']).toBeUndefined();
  });

  it('⚠️ THE ROOT COMMIT lists every file as an addition, not an empty list', async () => {
    // THE CASE THAT FAILS SILENTLY. A root commit has no parent, so without the
    // empty-tree substitution `git diff <nothing> <sha>` is not an error that
    // surfaces — it is an empty answer, and the repository's FIRST commit shows
    // "changed no files" with nothing anywhere to say why.
    const { files, unreadable } = await svc.commitFiles(hist, root);
    expect(unreadable).toBeUndefined();
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.letter === 'A')).toBe(true);
    expect(files.map((f) => f.path).sort()).toEqual(['d/old.txt', 'f.txt', 'gone.txt']);
  });

  it('an EMPTY commit really has no files, and says so by being empty', async () => {
    // `--allow-empty` is a thing, and "no files" is the honest answer rather than
    // a failure. The renderer draws a sentence for it rather than an empty box.
    const empty = tempDir('sb-git-emptycommit-');
    sh(empty, ['init', '-b', 'main']);
    sh(empty, ['config', 'user.email', 'test@test']);
    sh(empty, ['config', 'user.name', 'test']);
    sh(empty, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(empty, 'f.txt'), 'x\n');
    sh(empty, ['add', '.']);
    sh(empty, ['commit', '-m', 'init']);
    sh(empty, ['commit', '--allow-empty', '-m', 'nothing']);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: empty, encoding: 'utf8' }).trim();
    const parent = execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: empty, encoding: 'utf8' }).trim();
    const { files, unreadable } = await svc.commitFiles(empty, { id: sha, parentIds: [parent] });
    expect(unreadable).toBeUndefined();
    expect(files).toEqual([]);
  });

  it('⚠️ a BINARY file in a commit reports binary, not zeroes', async () => {
    const bin = tempDir('sb-git-commitbin-');
    sh(bin, ['init', '-b', 'main']);
    sh(bin, ['config', 'user.email', 'test@test']);
    sh(bin, ['config', 'user.name', 'test']);
    sh(bin, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(bin, 'b.dat'), Buffer.from([0, 1, 2, 0, 3]));
    sh(bin, ['add', '.']);
    sh(bin, ['commit', '-m', 'init']);
    fs.writeFileSync(path.join(bin, 'b.dat'), Buffer.from([0, 9, 9, 0, 7, 7]));
    sh(bin, ['commit', '-am', 'change it']);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: bin, encoding: 'utf8' }).trim();
    const parent = execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: bin, encoding: 'utf8' }).trim();
    const { files } = await svc.commitFiles(bin, { id: sha, parentIds: [parent] });
    expect(files[0]).toMatchObject({ path: 'b.dat', letter: 'M', binary: true });
  });

  it('a commit we could not read says so, rather than claiming it changed nothing', async () => {
    const { files, unreadable } = await svc.commitFiles(hist, {
      id: '0'.repeat(40),
      parentIds: ['1'.repeat(40)],
    });
    expect(files).toEqual([]);
    expect(unreadable).toBeTruthy();
  });
  // Real git in a child process, several times per case (#512).
}, 60_000);

describe('GitService.fileVersionsAt (E24 Git v2 item 4)', () => {
  it('returns both sides of a file at two revisions', async () => {
    const two = tempDir('sb-git-fva-');
    sh(two, ['init', '-b', 'main']);
    sh(two, ['config', 'user.email', 'test@test']);
    sh(two, ['config', 'user.name', 'test']);
    sh(two, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(two, 'f.txt'), 'before\n');
    sh(two, ['add', '.']);
    sh(two, ['commit', '-m', 'one']);
    fs.writeFileSync(path.join(two, 'f.txt'), 'after\n');
    sh(two, ['commit', '-am', 'two']);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: two, encoding: 'utf8' }).trim();
    const parent = execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: two, encoding: 'utf8' }).trim();

    const v = await svc.fileVersionsAt(two, 'f.txt', parent, sha);
    expect(v.original).toContain('before');
    expect(v.modified).toContain('after');
  });

  it('⚠️ an ADDED file has an EMPTY "before", which is what Monaco needs', async () => {
    // A file added in this commit does not exist at `left`, so `git show` fails —
    // and empty is exactly what renders as an addition. Which is also why a
    // failure here cannot be told from an absence, and why neither is an error:
    // the name-status letter beside it already says which it is.
    const added = tempDir('sb-git-fva-added-');
    sh(added, ['init', '-b', 'main']);
    sh(added, ['config', 'user.email', 'test@test']);
    sh(added, ['config', 'user.name', 'test']);
    sh(added, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(added, 'first.txt'), 'x\n');
    sh(added, ['add', '.']);
    sh(added, ['commit', '-m', 'one']);
    fs.writeFileSync(path.join(added, 'new.txt'), 'brand new\n');
    sh(added, ['add', '.']);
    sh(added, ['commit', '-m', 'two']);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: added, encoding: 'utf8' }).trim();
    const parent = execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: added, encoding: 'utf8' }).trim();

    const v = await svc.fileVersionsAt(added, 'new.txt', parent, sha);
    expect(v.original).toBe('');
    expect(v.modified).toContain('brand new');
  });

  it('⚠️ a ROOT commit reads against the EMPTY TREE and every line is an addition', async () => {
    const r = tempDir('sb-git-fva-root-');
    sh(r, ['init', '-b', 'main']);
    sh(r, ['config', 'user.email', 'test@test']);
    sh(r, ['config', 'user.name', 'test']);
    sh(r, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(r, 'f.txt'), 'the very first line\n');
    sh(r, ['add', '.']);
    sh(r, ['commit', '-m', 'root']);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r, encoding: 'utf8' }).trim();

    const v = await svc.fileVersionsAt(r, 'f.txt', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', sha);
    expect(v.original).toBe('');
    expect(v.modified).toContain('the very first line');
  });
  // Real git in a child process, several times per case (#512).
}, 60_000);

// A FILENAME IS NOT A PATTERN (found in review of E24 Git v2 item 10).
//
// ⚠️ **A git pathspec is WILDCARD-MATCHED BY DEFAULT**, so the ⏱ gesture on an
// everyday filename listed commits that never touched it, under a chip saying it
// was showing only that one file. `--literal-pathspecs` rides in `guardArgs()`
// now; `repo-config-guard.test.ts` pins that it is in the list, and this pins
// what it does to REAL git — including a positive control proving the hole was
// real, because a guard test that cannot fail without the guard proves nothing.
describe('a filename is not a pattern (E24 Git v2 item 10)', () => {
  let globby: string;

  beforeAll(() => {
    globby = tempDir('sb-git-glob-');
    sh(globby, ['init', '-b', 'main']);
    sh(globby, ['config', 'user.email', 'glob@test']);
    sh(globby, ['config', 'user.name', 'Glob Tester']);
    sh(globby, ['config', 'commit.gpgsign', 'false']);
    // Two files whose names a GLOB cannot tell apart: `file[1].txt` as a pattern
    // is the character class `[1]`, which matches `file1.txt`.
    fs.writeFileSync(path.join(globby, 'file1.txt'), 'plain\n');
    sh(globby, ['add', '.']);
    sh(globby, ['commit', '-m', 'TOUCHED_file1']);
    fs.writeFileSync(path.join(globby, 'file[1].txt'), 'bracketed\n');
    sh(globby, ['add', '.']);
    sh(globby, ['commit', '-m', 'TOUCHED_bracket']);
  }, 60_000);

  it('⚠️ `file[1].txt` GETS ITS OWN HISTORY, not another file’s', async () => {
    const l = await svc.log(globby, { path: 'file[1].txt', follow: true });
    expect(l.unreadable).toBeUndefined();
    expect(l.commits.map((c) => c.subject)).toEqual(['TOUCHED_bracket']);
    // …and the answer SAYS what it filtered by, so the chip cannot overclaim.
    expect(l.filteredBy).toBe('file[1].txt');
    expect(l.pathRefused).toBeUndefined();
  });

  it('⚠️ THE POSITIVE CONTROL: the same repository, read as a glob, gives the wrong answer', () => {
    // Without this the test above would pass on a git that had never globbed.
    // Run directly, with no guard, so the hole is demonstrated rather than
    // asserted — and if a future git stops globging by default this test is what
    // tells us, rather than the fix silently becoming decoration.
    const asGlob = execFileSync('git', ['log', '--format=%s', '--follow', '--', 'file[1].txt'], {
      cwd: globby,
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    expect(asGlob).toContain('TOUCHED_file1');
    expect(asGlob.length).toBeGreaterThan(1);
  });

  it('⚠️ A FILE NAMED `*` DOES NOT BECOME THE WHOLE REPOSITORY', () => {
    // The #776 reading: under that threat model the filename is attacker-chosen,
    // so this is the shape that turns ⏱ into "every commit". As a literal
    // pathspec it matches nothing, because no file is named that.
    const literal = execFileSync(
      'git',
      [...guardArgs(), 'log', '--format=%s', '--', '*'],
      { cwd: globby, encoding: 'utf8' }
    ).trim();
    expect(literal).toBe('');
    // …and the control, again: as a glob it is the entire history.
    const asGlob = execFileSync('git', ['log', '--format=%s', '--', '*'], {
      cwd: globby,
      encoding: 'utf8',
    }).trim();
    expect(asGlob.split('\n').length).toBe(2);
  });

  it('⚠️ A PATH THE SERVICE WOULD NOT PASS SAYS SO, rather than widening in silence', async () => {
    // `safePath` refuses pathspec magic, and a filename beginning with `:` is
    // legal on macOS and Linux — so this is reachable by clicking ⏱ there. The
    // list really is the whole history; what matters is that the answer admits
    // it, because the chip is drawn from this field.
    const l = await svc.log(globby, { path: ':notes.md', follow: true });
    expect(l.pathRefused).toBe(true);
    expect(l.filteredBy).toBeUndefined();
    // the WHOLE history came back, which is exactly why it has to be flagged
    expect(l.commits).toHaveLength(2);
  });

  it('no path asked for is neither filtered nor refused', async () => {
    const l = await svc.log(globby);
    expect(l.filteredBy).toBeUndefined();
    expect(l.pathRefused).toBeUndefined();
  });
  // Real git in a child process, several times per case (#512).
}, 60_000);

// The write half against REAL git (E24 Git v2 item 12).
//
// `git-write.test.ts` owns the argv and the classification against fixtures. This
// owns the half a fixture cannot prove: that these commands really do what the
// measurements said, on a real repository, including the destructive one — and
// that a refusal really leaves the tree alone.
describe('GitService write half (E24 Git v2 item 12)', () => {
  /** A repo with one of each shape: modified, deleted, untracked, staged. */
  function dirty(): string {
    const dir = tempDir('sb-git-write-');
    sh(dir, ['init', '-b', 'main']);
    sh(dir, ['config', 'user.email', 'w@test']);
    sh(dir, ['config', 'user.name', 'Write Tester']);
    sh(dir, ['config', 'commit.gpgsign', 'false']);
    // ⚠️ **`core.autocrlf=false`, AND IT IS THE FIXTURE BEING HONEST RATHER THAN
    // THE SUBJECT BEING WRONG.** On Windows git converts LF to CRLF on checkout
    // by default, so `restore` brings a file back with different BYTES than the
    // test wrote — and the assertions below are about whether the right CONTENT
    // came back, not about line endings. Pinned rather than normalised at each
    // comparison, so the test says the same thing on all three platforms.
    sh(dir, ['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(dir, 'mod.txt'), 'one\n');
    fs.writeFileSync(path.join(dir, 'del.txt'), 'bye\n');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep\n');
    sh(dir, ['add', '.']);
    sh(dir, ['-c', 'core.hooksPath=', 'commit', '-m', 'base']);
    fs.writeFileSync(path.join(dir, 'mod.txt'), 'one\ntwo\n');
    fs.rmSync(path.join(dir, 'del.txt'));
    fs.writeFileSync(path.join(dir, 'new.txt'), 'brand new\n');
    return dir;
  }

  /** The porcelain XY for one path, or undefined if it is not listed. */
  async function xy(dir: string, p: string): Promise<string | undefined> {
    const s = await svc.status(dir);
    return s.files.find((f) => f.path === p)?.xy;
  }

  it('stages a modification, a DELETION and an UNTRACKED file in one call (the done-when)', async () => {
    const dir = dirty();
    const r = await svc.stage(dir, ['mod.txt', 'del.txt', 'new.txt']);
    expect(r).toEqual({ ok: true, applied: 3 });
    // All three moved to the INDEX column, which is what the measurement said a
    // plain `add --` does — no `-A` needed.
    expect(await xy(dir, 'mod.txt')).toBe('M.');
    expect(await xy(dir, 'del.txt')).toBe('D.');
    expect(await xy(dir, 'new.txt')).toBe('A.');
  });

  it('⚠️ UNSTAGE IS THE EXACT UNDO, for all three shapes', async () => {
    const dir = dirty();
    await svc.stage(dir, ['mod.txt', 'del.txt', 'new.txt']);
    const r = await svc.unstage(dir, ['mod.txt', 'del.txt', 'new.txt']);
    expect(r.ok).toBe(true);
    expect(await xy(dir, 'mod.txt')).toBe('.M');
    expect(await xy(dir, 'del.txt')).toBe('.D');
    // …and the new file goes back to UNTRACKED rather than vanishing.
    expect(await xy(dir, 'new.txt')).toBe('??');
    expect(fs.existsSync(path.join(dir, 'new.txt'))).toBe(true);
  });

  it('⚠️ DISCARD IS TWO COMMANDS AND DOES BOTH JOBS — restore and delete', async () => {
    // Measured: `git restore` REFUSES an untracked path outright, so a mixed
    // batch fails entirely unless it is classified first. This is that claim on a
    // real repository.
    const dir = dirty();
    const r = await svc.discard(dir, ['mod.txt', 'del.txt', 'new.txt']);
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(3);
    // the modification is gone…
    expect(fs.readFileSync(path.join(dir, 'mod.txt'), 'utf8')).toBe('one\n');
    // …the deleted file is BACK…
    expect(fs.existsSync(path.join(dir, 'del.txt'))).toBe(true);
    // …and the untracked file is really gone from disk.
    expect(fs.existsSync(path.join(dir, 'new.txt'))).toBe(false);
    const s = await svc.status(dir);
    expect(s.files).toEqual([]);
  });

  it('⚠️ DISCARDING A WORKING-TREE CHANGE LEAVES A STAGED ONE ALONE', async () => {
    // `restore` with no `--source` restores from the INDEX, which is the correct
    // meaning of discarding one ROW rather than the whole file. Staged-and-edited
    // is exactly the case the Changes tab draws twice.
    const dir = dirty();
    await svc.stage(dir, ['mod.txt']);
    fs.writeFileSync(path.join(dir, 'mod.txt'), 'one\ntwo\nthree\n');
    const r = await svc.discard(dir, ['mod.txt']);
    expect(r.ok).toBe(true);
    // back to what was STAGED, not back to HEAD
    expect(fs.readFileSync(path.join(dir, 'mod.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(await xy(dir, 'mod.txt')).toBe('M.');
  });

  it('⚠️ REFUSES TO DISCARD A CONFLICTED FILE, by name, and changes nothing', async () => {
    const dir = tempDir('sb-git-conflict-');
    sh(dir, ['init', '-b', 'main']);
    sh(dir, ['config', 'user.email', 'w@test']);
    sh(dir, ['config', 'user.name', 'Write Tester']);
    sh(dir, ['config', 'commit.gpgsign', 'false']);
    const commit = (...args: string[]): void => sh(dir, ['-c', 'core.hooksPath=', 'commit', ...args]);
    fs.writeFileSync(path.join(dir, 'c.txt'), 'base\n');
    sh(dir, ['add', '.']);
    commit('-m', 'base');
    sh(dir, ['checkout', '-b', 'side']);
    fs.writeFileSync(path.join(dir, 'c.txt'), 'theirs\n');
    commit('-am', 'theirs');
    sh(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'c.txt'), 'ours\n');
    commit('-am', 'ours');
    // the merge is EXPECTED to fail
    try {
      sh(dir, ['merge', 'side']);
    } catch {
      /* a conflict is the point */
    }
    expect(await xy(dir, 'c.txt')).toMatch(/U/);

    const before = fs.readFileSync(path.join(dir, 'c.txt'), 'utf8');
    const r = await svc.discard(dir, ['c.txt']);
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(0);
    expect(r.reason).toContain('merge conflict');
    expect(r.reason).toContain('c.txt');
    // ⚠️ AND THE FILE IS BYTE-IDENTICAL: a refusal that had half-acted would be
    // the worst outcome available on the one file where being wrong costs most.
    expect(fs.readFileSync(path.join(dir, 'c.txt'), 'utf8')).toBe(before);
  });

  it('⚠️ A PATH THAT LEAVES THE FOLDER IS REFUSED AND NOTHING ELSE IN THE BATCH RUNS', async () => {
    const dir = dirty();
    const r = await svc.discard(dir, ['mod.txt', '../escape.txt']);
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(0);
    // the GOOD path in the same batch was not acted on either
    expect(fs.readFileSync(path.join(dir, 'mod.txt'), 'utf8')).toBe('one\ntwo\n');
  });

  it('a path git does not know needed nothing done, and is not counted', async () => {
    const dir = dirty();
    const r = await svc.discard(dir, ['keep.txt']);
    expect(r).toEqual({ ok: true, applied: 0 });
    expect(fs.existsSync(path.join(dir, 'keep.txt'))).toBe(true);
  });

  it('a folder that is not a repository says so rather than throwing', async () => {
    expect(await svc.stage(plain, ['a.txt'])).toMatchObject({ ok: false, applied: 0 });
    const d = await svc.discard(plain, ['a.txt']);
    expect(d.ok).toBe(false);
    expect(d.reason).toBeTruthy();
  });

  it('⚠️ QUOTES GIT when git refuses, rather than inventing a sentence', async () => {
    const dir = dirty();
    // `restore --staged` on a path with nothing staged is fine; ask git to do
    // something it really will not: unstage a path that does not exist at all.
    const r = await svc.unstage(dir, ['nope-does-not-exist.txt']);
    expect(r.ok).toBe(false);
    // git's own words, not ours — the message has to be actionable and we do not
    // know every reason a repository can refuse.
    expect(r.reason).toMatch(/pathspec|did not match/i);
  });

  it('⚠️ THE #776 GUARDS STILL RIDE ON A WRITE — a repo cannot make `add` run a program', async () => {
    // The threat model does not soften because we asked for a change rather than
    // an answer: a repository that can make `status` run a program can make `add`
    // run one too, and `add` is the command that actually reads file CONTENTS
    // through a filter driver.
    const dir = dirty();
    const sentinel = path.join(dir, 'RAN');
    sh(dir, ['config', 'filter.evil.clean', `sh -c "echo ran > '${toPosix(sentinel)}'; cat"`]);
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'mod.txt filter=evil\n');
    // THE CONTROL: plain git really does run it.
    sh(dir, ['add', 'mod.txt']);
    expect(fs.existsSync(sentinel)).toBe(true);
    fs.rmSync(sentinel);
    sh(dir, ['restore', '--staged', 'mod.txt']);
    // …and ours does not.
    const r = await svc.stage(dir, ['mod.txt']);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(false);
  });
  // Real git in a child process, several times per case (#512).
}, 60_000);

// Making a commit, against REAL git (E24 Git v2 item 13).
//
// ⚠️ **TWO CLAIMS HERE CANNOT BE MADE ANY OTHER WAY, and both were measured
// before the code was written.**
//
//  1. **The message travels on STDIN and arrives byte-exact.** The design record
//     §2.1 chose `commit --file=-` over `-m` because *"a multi-line body with
//     quotes in it is a Windows quoting bug waiting to happen"* — so the test
//     that matters is a message full of exactly the characters that would break
//     a command line.
//  2. ⚠️⚠️ **THE USER'S HOOKS RUN.** This is the only place in the service that
//     lifts a #776 guard, and it is lifted on purpose: a commit that silently
//     skipped somebody's `pre-commit` would be switchboard reimplementing `git
//     commit`. A control proves the guard really does suppress a hook, so the
//     relaxation is shown to be doing something rather than asserted to.
describe('GitService.commit (E24 Git v2 item 13)', () => {
  /** A repo with something staged and ready to commit. */
  function staged(): string {
    const dir = tempDir('sb-git-commit-');
    sh(dir, ['init', '-b', 'main']);
    sh(dir, ['config', 'user.email', 'c@test']);
    sh(dir, ['config', 'user.name', 'Commit Tester']);
    sh(dir, ['config', 'commit.gpgsign', 'false']);
    sh(dir, ['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'first\n');
    sh(dir, ['add', '.']);
    sh(dir, ['-c', 'core.hooksPath=', 'commit', '-m', 'base']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'second\n');
    sh(dir, ['add', '.']);
    return dir;
  }

  const body = (dir: string): string =>
    execFileSync('git', ['log', '-1', '--format=%B'], { cwd: dir, encoding: 'utf8' });

  it('commits what is staged (the done-when)', async () => {
    const dir = staged();
    const r = await svc.commit(dir, 'a plain subject');
    expect(r).toEqual({ ok: true, applied: 1 });
    expect(body(dir)).toContain('a plain subject');
    // …and the tree is clean afterwards, which is the only proof it really landed
    expect((await svc.status(dir)).files).toEqual([]);
  });

  it('⚠️ A MESSAGE FULL OF SHELL METACHARACTERS ARRIVES BYTE-EXACT', async () => {
    // The whole reason the design record chose stdin over `-m`. Every character
    // here is one that would need quoting on a command line, and on Windows the
    // quoting rules differ from POSIX — which is the bug that was being avoided
    // rather than discovered.
    const dir = staged();
    const message = [
      'A subject with "double quotes" and a $dollar',
      '',
      "A body with 'single quotes', 100% percent, a `backtick`,",
      'a semicolon; an ampersand & a pipe | and a caret ^.',
      '',
      'And a trailing line.',
    ].join('\n');
    const r = await svc.commit(dir, message);
    expect(r.ok).toBe(true);
    const landed = body(dir);
    for (const fragment of [
      '"double quotes"',
      '$dollar',
      "'single quotes'",
      '100% percent',
      '`backtick`',
      'a semicolon; an ampersand & a pipe | and a caret ^.',
      'And a trailing line.',
    ]) {
      expect(landed, `lost: ${fragment}`).toContain(fragment);
    }
  });

  it('⚠️⚠️ THE REPOSITORY’S OWN `pre-commit` HOOK RUNS — with a control that proves the guard suppresses it', async () => {
    // ⚠️ **THE DECISION THIS PINS.** Everywhere else in the service, a repo's
    // hooks are suppressed: `status` and `diff` run unbidden and a repository
    // must not get to execute a program because switchboard glanced at it. A
    // COMMIT is a button the user pressed, and one that skipped their formatter
    // or their tests would not be a commit.
    //
    // ⚠️ **AND THE CONTROL IS NOT OPTIONAL.** This machine has a GLOBAL
    // `core.hooksPath`, which masks `.git/hooks` entirely — the first attempt at
    // this measurement was inconclusive for that reason. So the hook is installed
    // AND pointed at explicitly, and the suppressed case is demonstrated first.
    const dir = staged();
    const hooks = path.join(dir, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const ran = path.join(dir, 'HOOK-RAN');
    fs.writeFileSync(
      path.join(hooks, 'pre-commit'),
      `#!/bin/sh\necho ran > "${toPosix(ran)}"\nexit 0\n`
    );
    fs.chmodSync(path.join(hooks, 'pre-commit'), 0o755);
    // A repo-local `core.hooksPath` so the machine's global one cannot mask it.
    sh(dir, ['config', 'core.hooksPath', '.git/hooks']);

    // THE CONTROL: with the guard's empty hooks path, it does NOT run.
    expect(fs.existsSync(ran)).toBe(false);
    sh(dir, ['-c', `core.hooksPath=${toPosix(path.join(dir, 'no-hooks-here'))}`, 'commit', '-m', 'guarded']);
    expect(fs.existsSync(ran)).toBe(false);

    // …and through our commit, which lifts exactly that one guard, it DOES.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'third\n');
    await svc.stage(dir, ['a.txt']);
    const r = await svc.commit(dir, 'hooks please');
    expect(r.ok).toBe(true);
    expect(fs.existsSync(ran), 'the pre-commit hook did not run').toBe(true);
  });

  it('⚠️ A FAILING HOOK STOPS THE COMMIT, and its own words come back', async () => {
    // Which is the point of letting hooks run at all: a `pre-commit` that says no
    // is the repository's own policy, and the user has to see what it said.
    const dir = staged();
    const hooks = path.join(dir, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(
      path.join(hooks, 'pre-commit'),
      '#!/bin/sh\necho "LINT FAILED: two problems" >&2\nexit 1\n'
    );
    fs.chmodSync(path.join(hooks, 'pre-commit'), 0o755);
    sh(dir, ['config', 'core.hooksPath', '.git/hooks']);
    const r = await svc.commit(dir, 'should not land');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('LINT FAILED');
    // …and nothing was committed.
    expect(body(dir)).toContain('base');
  });

  it('…and `--no-verify` is what gets past it, which is why the option exists', async () => {
    const dir = staged();
    const hooks = path.join(dir, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    fs.chmodSync(path.join(hooks, 'pre-commit'), 0o755);
    sh(dir, ['config', 'core.hooksPath', '.git/hooks']);
    expect((await svc.commit(dir, 'blocked')).ok).toBe(false);
    const r = await svc.commit(dir, 'through anyway', { noVerify: true });
    expect(r.ok).toBe(true);
    expect(body(dir)).toContain('through anyway');
  });

  it('amends the last commit, message and all, with NOTHING staged', async () => {
    // The commonest reason to reach for amend: fixing a message you just wrote.
    // Measured to succeed with an empty index.
    const dir = staged();
    await svc.commit(dir, 'first try');
    const r = await svc.commit(dir, 'second thoughts', { amend: true });
    expect(r.ok).toBe(true);
    expect(body(dir)).toContain('second thoughts');
    expect(body(dir)).not.toContain('first try');
    // and it is still ONE commit on top of base, not two
    const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    expect(count).toBe('2');
  });

  it('adds a sign-off trailer when asked', async () => {
    const dir = staged();
    const r = await svc.commit(dir, 'signed', { signoff: true });
    expect(r.ok).toBe(true);
    expect(body(dir)).toContain('Signed-off-by:');
  });

  it('⚠️ AN EMPTY MESSAGE IS REFUSED BEFORE GIT IS EVEN RUN', async () => {
    // git refuses it too — measured, "Aborting commit due to empty commit
    // message" — so this is not the only line of defence. It exists so the BUTTON
    // can be disabled rather than live and then failing.
    const dir = staged();
    for (const empty of ['', '   ', '\n\n', undefined, null, 42]) {
      const r = await svc.commit(dir, empty);
      expect(r.ok, `${JSON.stringify(empty)} was accepted`).toBe(false);
      expect(r.reason).toContain('needs a message');
    }
    // nothing was committed by any of them
    expect(body(dir)).toContain('base');
  });

  it('⚠️ NOTHING STAGED IS GIT’S OWN REFUSAL, passed through', async () => {
    const dir = staged();
    await svc.commit(dir, 'takes the staged change');
    const r = await svc.commit(dir, 'and now there is nothing');
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('a folder that is not a repository says so rather than throwing', async () => {
    const r = await svc.commit(plain, 'nope');
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });
  // Real git in a child process, several times per case (#512).
}, 60_000);

// Partial staging against REAL git (E24 Git v2 item 14).
//
// ⚠️ **THE ONLY THING THAT PROVES A SYNTHESISED PATCH IS RIGHT IS GIT ACCEPTING
// IT.** `git-hunks.test.ts` asserts the arithmetic; this drives the bytes through
// `git apply --cached` and then checks the three facts that matter:
//
//   1. the INDEX holds exactly the chosen change,
//   2. the WORKING TREE is untouched,
//   3. the REST of the change is still unstaged.
//
// A patch whose counts are merely *off* can land at an offset rather than being
// refused — and then the index holds something the user never chose, silently.
// Nothing but real `apply` can rule that out.
describe('GitService partial staging (E24 Git v2 item 14)', () => {
  /** Ten numbered lines committed, with the first and last changed on disk. */
  function twoHunks(): string {
    const dir = tempDir('sb-git-hunk-');
    sh(dir, ['init', '-b', 'main']);
    sh(dir, ['config', 'user.email', 'h@test']);
    sh(dir, ['config', 'user.name', 'Hunk Tester']);
    sh(dir, ['config', 'commit.gpgsign', 'false']);
    sh(dir, ['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(
      path.join(dir, 'f.txt'),
      'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n'
    );
    sh(dir, ['add', '.']);
    sh(dir, ['-c', 'core.hooksPath=', 'commit', '-m', 'base']);
    fs.writeFileSync(
      path.join(dir, 'f.txt'),
      'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n'
    );
    return dir;
  }

  const cached = (dir: string): string =>
    execFileSync('git', ['diff', '--cached', '--no-color', '--', 'f.txt'], {
      cwd: dir,
      encoding: 'utf8',
    });

  it('reads the file’s hunks (the done-when)', async () => {
    const dir = twoHunks();
    const h = await svc.hunks(dir, 'f.txt');
    expect(h.unreadable).toBeUndefined();
    expect(h.hunks).toHaveLength(2);
    expect(h.hunks[0].lines).toContain('+ONE');
    expect(h.hunks[1].lines).toContain('+TEN');
    // the header a patch needs came back with them
    expect(h.header?.some((l) => l.startsWith('diff --git'))).toBe(true);
  });

  it('⚠️⚠️ STAGES ONE HUNK: the index gets it, the WORKING TREE IS UNTOUCHED, the rest stays unstaged', async () => {
    const dir = twoHunks();
    const h = await svc.hunks(dir, 'f.txt');
    const patch = patchFor({ header: h.header ?? [], hunks: h.hunks }, [h.hunks[0]]);
    const r = await svc.applyPatch(dir, patch);
    expect(r).toEqual({ ok: true, applied: 1 });

    // 1. the INDEX holds the first change and NOT the second
    const staged = cached(dir);
    expect(staged).toContain('+ONE');
    expect(staged).not.toContain('+TEN');

    // 2. ⚠️ THE WORKING TREE IS EXACTLY AS THE USER LEFT IT — the entire safety
    //    story of this item, and the reason it needs no confirm.
    const onDisk = fs.readFileSync(path.join(dir, 'f.txt'), 'utf8');
    expect(onDisk.startsWith('ONE\n')).toBe(true);
    expect(onDisk.trimEnd().endsWith('TEN')).toBe(true);

    // 3. the rest is still unstaged: `MM` is staged-AND-further-modified
    const s = await svc.status(dir);
    expect(s.files.find((f) => f.path === 'f.txt')?.xy).toBe('MM');
  });

  it('⚠️ AND REVERSE-APPLYING THE SAME PATCH UNSTAGES IT AGAIN', async () => {
    const dir = twoHunks();
    const h = await svc.hunks(dir, 'f.txt');
    const patch = patchFor({ header: h.header ?? [], hunks: h.hunks }, [h.hunks[0]]);
    expect((await svc.applyPatch(dir, patch)).ok).toBe(true);
    expect((await svc.applyPatch(dir, patch, { reverse: true })).ok).toBe(true);
    expect(cached(dir)).toBe('');
    // …and the working tree STILL has both changes
    expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8').startsWith('ONE\n')).toBe(true);
  });

  // ⚠️⚠️ **A LINE-LEVEL SELECTION TEST USED TO BE HERE, AND REMOVING IT IS THE
  // POINT RATHER THAN A GAP.** It drove a hand-built sub-hunk through real `git
  // apply`; the patch was ACCEPTED and the index came out holding `two/ONE/three`
  // for a selection that asked for `ONE/two/three`. The algorithm is structurally
  // wrong, not nearly right — `git-hunks.test.ts` keeps the counter-example and
  // names the mechanism selection actually needs (per-line zero-context hunks).
  // Shipping whole-hunk staging without it is a deliberate scope reduction.

  it('⚠️ A PATCH THAT CANNOT APPLY LEAVES THE INDEX BYTE-IDENTICAL, and quotes git', async () => {
    // git's own guarantee rather than ours — but asserted, because the design
    // record asks for it and because "the index is untouched" is the claim a user
    // has to be able to rely on after a failure.
    const dir = twoHunks();
    await svc.stage(dir, ['f.txt']);
    const before = cached(dir);
    const nonsense = [
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,2 +1,2 @@',
      '-this line is not in the file',
      '+replacement',
      ' two',
      '',
    ].join('\n');
    const r = await svc.applyPatch(dir, nonsense);
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(0);
    // git's words, not ours
    expect(r.reason).toMatch(/does not apply|patch failed/i);
    expect(cached(dir)).toBe(before);
  });

  it('an empty or whitespace patch is refused before git is run', async () => {
    const dir = twoHunks();
    for (const nothing of ['', '   ', '\n']) {
      const r = await svc.applyPatch(dir, nothing);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('nothing to apply');
    }
  });

  it('a file with nothing unstaged has NO hunks, which is a fact and not a failure', async () => {
    const dir = twoHunks();
    await svc.stage(dir, ['f.txt']);
    const h = await svc.hunks(dir, 'f.txt');
    expect(h.unreadable).toBeUndefined();
    expect(h.hunks).toEqual([]);
  });

  it('⚠️ REFUSES A PATH IT WOULD NOT ACT ON, with the same rule as every other write', async () => {
    const dir = twoHunks();
    const h = await svc.hunks(dir, '../escape.txt');
    expect(h.unreadable).toBeTruthy();
    expect(h.hunks).toEqual([]);
  });

  it('⚠️ THE #776 GUARDS RIDE ON `apply` TOO — a repo cannot make it run a program', async () => {
    // `apply --cached` writes blobs into the object store, so it is a clean-filter
    // path exactly as `add` is. Same control shape as item 12's.
    const dir = twoHunks();
    const sentinel = path.join(dir, 'RAN');
    sh(dir, ['config', 'filter.evil.clean', `sh -c "echo ran > '${toPosix(sentinel)}'; cat"`]);
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'f.txt filter=evil\n');
    // THE CONTROL: plain git really does run it.
    sh(dir, ['add', 'f.txt']);
    expect(fs.existsSync(sentinel)).toBe(true);
    fs.rmSync(sentinel);
    sh(dir, ['restore', '--staged', 'f.txt']);

    const h = await svc.hunks(dir, 'f.txt');
    const patch = patchFor({ header: h.header ?? [], hunks: h.hunks }, [h.hunks[0]]);
    const r = await svc.applyPatch(dir, patch);
    expect(r.ok, `apply refused: ${r.reason}`).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(false);
  });
  // Real git in a child process, several times per case (#512).
}, 60_000);

// Branch and sync against REAL git, with a REAL remote (E24 Git v2 item 15).
//
// ⚠️ **THE REMOTE IS A BARE REPOSITORY ON DISK, and that is what makes push and
// pull testable at all.** A network remote would make this suite depend on
// somebody else's server; a bare repo in a temp directory is a real remote by
// every definition git uses — it has refs, it accepts a push, it can be ahead —
// and it needs no credentials, so the measurement is about OUR commands rather
// than about a connection.
describe('GitService branch and sync (E24 Git v2 item 15)', () => {
  /** A clone with a real upstream, plus the bare remote it came from. */
  function cloned(): { work: string; bare: string } {
    const bare = tempDir('sb-git-bare-');
    sh(bare, ['init', '--bare', '-b', 'main']);
    const seed = tempDir('sb-git-seed-');
    sh(seed, ['init', '-b', 'main']);
    sh(seed, ['config', 'user.email', 's@test']);
    sh(seed, ['config', 'user.name', 'Sync Tester']);
    sh(seed, ['config', 'commit.gpgsign', 'false']);
    sh(seed, ['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(seed, 'a.txt'), 'first\n');
    sh(seed, ['add', '.']);
    sh(seed, ['-c', 'core.hooksPath=', 'commit', '-m', 'first']);
    sh(seed, ['remote', 'add', 'origin', toPosix(bare)]);
    sh(seed, ['push', '-u', 'origin', 'main']);

    const work = tempDir('sb-git-work-');
    // clone INTO an existing empty directory, which is what `tempDir` hands back
    sh(work, ['clone', toPosix(bare), '.']);
    sh(work, ['config', 'user.email', 's@test']);
    sh(work, ['config', 'user.name', 'Sync Tester']);
    sh(work, ['config', 'commit.gpgsign', 'false']);
    sh(work, ['config', 'core.autocrlf', 'false']);
    return { work, bare };
  }

  const branchOf = (dir: string): string =>
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  it('fetches, and says nothing happened by succeeding (the done-when)', async () => {
    const { work } = cloned();
    expect(await svc.fetch(work)).toEqual({ ok: true, applied: 1 });
  });

  it('⚠️ A REPOSITORY WITH NO REMOTE IS A SUCCESS, not a failure', async () => {
    // Measured: `git fetch` with nothing configured exits 0 and says nothing. A
    // surface that reported that as an error would be wrong about every ordinary
    // local-only project.
    const solo = tempDir('sb-git-solo-');
    sh(solo, ['init', '-b', 'main']);
    sh(solo, ['config', 'user.email', 's@test']);
    sh(solo, ['config', 'user.name', 'Sync Tester']);
    sh(solo, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(solo, 'a.txt'), 'x\n');
    sh(solo, ['add', '.']);
    sh(solo, ['-c', 'core.hooksPath=', 'commit', '-m', 'only']);
    expect((await svc.fetch(solo)).ok).toBe(true);
  });

  it('⚠️⚠️ PUSHES A REAL COMMIT TO A REAL REMOTE, and the remote has it afterwards', async () => {
    const { work, bare } = cloned();
    fs.writeFileSync(path.join(work, 'a.txt'), 'second\n');
    await svc.stage(work, ['a.txt']);
    expect((await svc.commit(work, 'a second commit')).ok).toBe(true);
    const r = await svc.push(work);
    expect(r, `push failed: ${r.reason}`).toEqual({ ok: true, applied: 1 });
    // ⭐ THE REMOTE'S OWN LOG, which is the only proof the push landed.
    const remoteLog = execFileSync('git', ['log', '--format=%s', '-1', 'main'], {
      cwd: bare,
      encoding: 'utf8',
    }).trim();
    expect(remoteLog).toBe('a second commit');
  });

  it('⚠️ PULLS A COMMIT MADE ELSEWHERE, fast-forward only', async () => {
    const { work, bare } = cloned();
    // a second clone stands in for "somebody else"
    const other = tempDir('sb-git-other-');
    sh(other, ['clone', toPosix(bare), '.']);
    sh(other, ['config', 'user.email', 'o@test']);
    sh(other, ['config', 'user.name', 'Other']);
    sh(other, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(other, 'b.txt'), 'theirs\n');
    sh(other, ['add', '.']);
    sh(other, ['-c', 'core.hooksPath=', 'commit', '-m', 'from somebody else']);
    sh(other, ['push']);

    expect(fs.existsSync(path.join(work, 'b.txt'))).toBe(false);
    const r = await svc.pull(work);
    expect(r, `pull failed: ${r.reason}`).toEqual({ ok: true, applied: 1 });
    expect(fs.existsSync(path.join(work, 'b.txt'))).toBe(true);
  });

  it('⚠️ AND REFUSES RATHER THAN STARTING A MERGE IT CANNOT FINISH', async () => {
    // ⚠️ **THE WHOLE DESIGN OF THE PULL BUTTON.** With diverged history a plain
    // `pull` would merge or rebase — and either can stop halfway with a conflict,
    // leaving a one-click button having started something the user must now
    // finish with no surface for it. `--ff-only` either works completely or
    // changes nothing, and git says which.
    const { work, bare } = cloned();
    const other = tempDir('sb-git-other2-');
    sh(other, ['clone', toPosix(bare), '.']);
    sh(other, ['config', 'user.email', 'o@test']);
    sh(other, ['config', 'user.name', 'Other']);
    sh(other, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(other, 'theirs.txt'), 'theirs\n');
    sh(other, ['add', '.']);
    sh(other, ['-c', 'core.hooksPath=', 'commit', '-m', 'theirs']);
    sh(other, ['push']);
    // …and OURS diverges
    fs.writeFileSync(path.join(work, 'ours.txt'), 'ours\n');
    sh(work, ['add', '.']);
    sh(work, ['-c', 'core.hooksPath=', 'commit', '-m', 'ours']);

    const before = branchOf(work);
    const r = await svc.pull(work);
    expect(r.ok).toBe(false);
    // git's own words, which are the useful ones here
    expect(r.reason).toMatch(/fast-forward|diverge/i);
    // ⚠️ AND NOTHING WAS STARTED: no merge in progress, same branch, their file
    // still absent.
    expect(branchOf(work)).toBe(before);
    expect(fs.existsSync(path.join(work, 'theirs.txt'))).toBe(false);
    expect(fs.existsSync(path.join(work, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('⚠️ A PUSH WITH NO UPSTREAM QUOTES GIT, which tells the user the fix', async () => {
    // Measured: exit 128, "The current branch ... has no upstream branch".
    const { work } = cloned();
    expect((await svc.createBranch(work, 'brand-new')).ok).toBe(true);
    const r = await svc.push(work);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/upstream/i);
    // …and `setUpstream` is what gets it there
    const up = await svc.push(work, { setUpstream: true });
    expect(up, `push -u failed: ${up.reason}`).toEqual({ ok: true, applied: 1 });
  });

  it('creates a branch and switches to it', async () => {
    const { work } = cloned();
    expect(await svc.createBranch(work, 'feature/1052-sync')).toEqual({ ok: true, applied: 1 });
    expect(branchOf(work)).toBe('feature/1052-sync');
  });

  it('⚠️ AND CREATES ONE AT A COMMIT THE GRAPH POINTED AT — the design record’s own words', async () => {
    const { work } = cloned();
    fs.writeFileSync(path.join(work, 'a.txt'), 'second\n');
    sh(work, ['add', '.']);
    sh(work, ['-c', 'core.hooksPath=', 'commit', '-m', 'second']);
    const first = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: work, encoding: 'utf8' }).trim();
    expect((await svc.createBranch(work, 'from-the-graph', first)).ok).toBe(true);
    expect(branchOf(work)).toBe('from-the-graph');
    // …at THAT commit, not at HEAD
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
    expect(head).toBe(first);
  });

  it('switches branches, and carries an uncommitted change across', async () => {
    // Measured: `checkout` only refuses when the switch would CLOBBER the change,
    // so it is not the destructive operation it looks like.
    const { work } = cloned();
    await svc.createBranch(work, 'side');
    fs.writeFileSync(path.join(work, 'scratch.txt'), 'wip\n');
    expect(await svc.checkout(work, 'main')).toEqual({ ok: true, applied: 1 });
    expect(branchOf(work)).toBe('main');
    expect(fs.existsSync(path.join(work, 'scratch.txt'))).toBe(true);
  });

  it('⚠️ REFUSES A BRANCH NAME THAT COULD BE A FLAG, before git is run', async () => {
    const { work } = cloned();
    const before = branchOf(work);
    for (const bad of ['--all', '-D', 'main..side', 'has space', '']) {
      const r = await svc.checkout(work, bad);
      expect(r.ok, `${bad} was accepted`).toBe(false);
      expect(r.reason).toContain('branch name');
    }
    for (const bad of ['--force', 'a..b']) {
      expect((await svc.createBranch(work, bad)).ok).toBe(false);
    }
    // …and the branch is exactly where it was
    expect(branchOf(work)).toBe(before);
  });

  it('⚠️ AND REFUSES A BAD SOURCE REV for a new branch', async () => {
    const { work } = cloned();
    const r = await svc.createBranch(work, 'fine-name', '--all');
    expect(r.ok).toBe(false);
    expect(branchOf(work)).toBe('main');
  });

  it('a checkout git itself refuses quotes git', async () => {
    const { work } = cloned();
    const r = await svc.checkout(work, 'no-such-branch');
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(branchOf(work)).toBe('main');
  });
  // Real git in a child process, several times per case (#512).
}, 120_000);
