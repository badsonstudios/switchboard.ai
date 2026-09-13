// GitService (P1-E5-01): status + diff via the system git binary, parsed
// models, graceful everywhere — a session folder that isn't a repo yields
// { isRepo: false }, never an error dialog.
//
// GRACEFUL IS NOT THE SAME AS SILENT (#785). "A machine without git" used to be
// in that sentence, alongside a damaged repository, a permission error and
// #776's deliberate refusal, and all of them came back as `{ isRepo: false }`
// and drew as "Not a git repository". `status()` now carries `unreadable` for
// the cases where we could not find out; only the folder that really is not a
// repository answers plainly.
import { ChildProcess, execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  CONFIG_LIST_SCOPED,
  EMPTY_TREE,
  type ScopedConfigEntry,
  configListForScope,
  filterGuardOverrides,
  gitlinkPaths,
  guardArgs,
  overrideEnv,
  parseScopedConfig,
  parseUnscopedConfig,
} from './repo-config-guard';

export interface GitFileStatus {
  path: string;
  /** porcelain XY, e.g. "M.", ".M", "??" (untracked) */
  xy: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  /**
   * Why this answer is not a reading of the working tree (#785).
   *
   * ⚠️ **PRESENT ONLY WHEN WE COULD NOT FIND OUT.** Never on a successful read,
   * and never on an honest "this folder is not a repository".
   *
   * ⚠️ **BUT A CONSUMER READING `isRepo` ALONE IS NOW WRONG, AND THAT IS THE
   * POINT (#785 review).** This note used to claim the opposite — "every
   * consumer that has only ever read `isRepo` keeps exactly the meaning it had"
   * — which is false, deliberately, and by design: a damaged repository used to
   * answer `isRepo: false` and now answers `true`. `isRepo: false` still means
   * "not a repository" ONLY when `unreadable` is absent, and `isRepo: true`
   * with `unreadable` set is the exact shape of a clean checkout. Every reader
   * has to check. `GitContext` needed a new clause for precisely this, and the
   * comment asserting nobody did was the thing that would have hidden the next
   * one. Readers today: `lib/git-status`'s `gitPaneState`, `GitContext`, and
   * `SessionGrid`'s changed-file badge.
   *
   * Before this field, `status()` answered `{ isRepo: false, files: [] }` for
   * git missing, a damaged repository, a permission error, a `required` filter
   * that could not run and #776's deliberate refusal alike, and the pane drew
   * every one of them as **"Not a git repository"** — a confident wrong answer
   * about the user's project, which is the failure mode this codebase keeps
   * filing tickets about. `diff()` has thrown a reason since #764; this is
   * `status()` finally getting somewhere to put one.
   *
   * `isRepo` stays as honest as it can be beside it: `true` when `rev-parse`
   * had already answered `true` before the failure, `false` when we never got
   * that far. It is NOT a claim that the tree was read.
   *
   * The text is English and deliberately un-localized — half of these are git's
   * own message quoted back, and a translation invented for a sentence we are
   * quoting is a lie of a different kind. The renderer's one i18n string wraps
   * it; see `diff.unreadable`.
   */
  unreadable?: string;
  branch?: string;
  ahead?: number;
  behind?: number;
  files: GitFileStatus[];
}

export interface FileVersions {
  /** content at HEAD (empty for new files) */
  original: string;
  /** working-tree content (empty for deletions) */
  modified: string;
}

/**
 * How long `diff()` gives git — all three invocations together — before it
 * KILLS it (#772).
 *
 * Bounds the WORK, where `ANSWER_DEADLINE_MS` (12 s) only bounds how long the
 * bus waits for it. Before this, a `git` that never finished was abandoned by
 * the answer deadline and left running — and every retry started another. It
 * sits INSIDE that deadline on purpose: git dies first, so the refusal that
 * reaches the model says what really happened ("git did not finish") rather
 * than the host's generic "gave up waiting", and the bus's in-flight slot is
 * given back when the answer is. `bus-tools.test.ts` pins the ordering.
 *
 * Killing is safe only because of the plumbing command below, which never
 * takes `.git/index.lock` — killed mid-write, porcelain `git diff` would have
 * left the lock behind and broken every git command in the sibling's repo.
 * And it is a kill of the whole TREE (`killTree`), because on Windows the
 * process we spawn is usually a launcher with the real git beneath it.
 *
 * Measured, #772: the largest diff that can be answered at all (just under the
 * 32 MB `maxBuffer`) takes ~2 s on a 20,000-file repository. Ten seconds is
 * five times that, and reached only by a filesystem that has stopped answering.
 */
export const DIFF_BUDGET_MS = 10_000;

/**
 * How long the #776 config guard gets on the `status` path, where there is no
 * outer deadline to sit inside.
 *
 * It bounds only OUR added work — reading config, listing the submodule git
 * directories — never `git status` itself, which is left unbounded because a
 * huge repository being slow must not be reported as not being a repository.
 * Generous because exceeding it refuses the read: this is the "something is
 * badly wrong" bound, not a latency target. The reads it covers measure at
 * ~12 ms each.
 */
export const GUARD_BUDGET_MS = 15_000;

/** How much output one git invocation may produce before it is killed. */
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;

/**
 * What "git" means to this service. Always the system git in production; a
 * seam so a test can put a process that never exits where git would be, which
 * is the only portable way to exercise the kill (#772).
 */
export interface GitCommand {
  file: string;
  prefixArgs: readonly string[];
}

const SYSTEM_GIT: GitCommand = { file: 'git', prefixArgs: [] };

/**
 * Why a git invocation did not succeed, when the difference matters.
 *
 * `no-exec` means git never ran at all — the spawn itself failed. ⚠️ **THAT IS
 * NOT THE SAME AS "git is not installed" (measured, #785).** A `cwd` that does
 * not exist produces the byte-identical `ENOENT`, down to `syscall: 'spawn
 * git'`, so a session folder that has been deleted or sits on a disconnected
 * drive looks exactly like a machine with no git. `spawnReason` is where that
 * is separated; the two are not distinguishable from the error alone.
 */
type GitFailure = 'timeout' | 'too-large' | 'failed' | 'no-exec';

interface GitRun {
  ok: boolean;
  out: string;
  /**
   * git's stderr — what it SAID about the failure, which until #785 was thrown
   * away. It is the only place git distinguishes "this folder is not a
   * repository" from "this repository is damaged" or "I refuse to touch a
   * repository owned by somebody else": both exit 128 (measured).
   */
  err: string;
  failure: GitFailure | null;
}

function git(
  command: GitCommand,
  folder: string,
  args: string[],
  timeoutMs = 0,
  env?: NodeJS.ProcessEnv
): Promise<GitRun> {
  return new Promise((resolve) => {
    // OUR timer, not `execFile`'s `timeout` — see `killTree` for why.
    let abandoned = false;
    let timer: NodeJS.Timeout | null = null;
    let grace: NodeJS.Timeout | null = null;
    let child: ChildProcess;
    try {
      child = execFile(
        command.file,
        [...command.prefixArgs, ...guardArgs(), ...args],
        {
          cwd: folder,
          encoding: 'utf8',
          maxBuffer: MAX_GIT_OUTPUT,
          windowsHide: true,
          // GIT_OPTIONAL_LOCKS=0 suppresses the index refresh `status` would
          // otherwise write — which is what fires `post-index-change`, and
          // which also took `.git/index.lock` in a folder another agent may be
          // `git add`-ing (#772 fixed that for `diff` and never for `status`).
          // Measured: status output is byte-identical with and without.
          //
          // LC_ALL/LANGUAGE (#785): git translates its messages through
          // gettext, and since #785 we READ one of them to tell "not a
          // repository" apart from "damaged repository" — both of which exit
          // 128. Under a translated git that match would fail and every
          // ordinary non-repo folder would be reported as unreadable. Nothing
          // we parse on stdout is localized (porcelain=v2, rev-parse,
          // `config --list -z`), so pinning the locale costs nothing and makes
          // the one message we read a constant. LANGUAGE is set too because
          // gettext consults it FIRST, and empty is how it is spelled "unset".
          env: { ...(env ?? process.env), GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', LANGUAGE: '' },
        },
        (err, stdout, stderr) => {
          if (timer) clearTimeout(timer);
          if (grace) clearTimeout(grace);
          // Abandoned means we closed the pipes ourselves, so whatever came
          // back may be cut short: a timeout, whatever the exit code said.
          const failure = abandoned ? 'timeout' : err ? failureOf(err) : null;
          resolve({ ok: !err && !abandoned, out: stdout ?? '', err: stderr ?? '', failure });
        }
      );
    } catch {
      // ⚠️ **`execFile` CAN THROW RATHER THAN CALL BACK, AND LINUX IS WHERE IT
      // DOES (#785, found by CI).** Handing it a `cwd` that is a FILE raises
      // `spawn ENOTDIR` synchronously on Linux, where the same call on Windows
      // delivers `ENOENT` to the callback — so `status()` REJECTED instead of
      // returning a `GitStatus`, and the pane's `.then` never ran. That breaks
      // "our breakage never blocks a session" on a path whose whole subject is
      // folders that have gone wrong. Pre-existing; #785's new case is what
      // reached it. Every synchronous failure is the same fact — git never ran
      // — so it is the same `no-exec` the callback would have reported.
      resolve({ ok: false, out: '', err: '', failure: 'no-exec' });
      return;
    }
    // CLOSE OUR END OF ITS PIPES, which `execFile`'s own timeout does and a
    // bare kill does not (#772 review, round 2). The callback above waits for
    // stdout AND stderr to close, and anything git started — a hook, a filter,
    // an orphan that escaped the tree kill — can hold them open after git is
    // gone. Measured: a descendant holding the pipe for 3 s turned an 800 ms
    // budget into a 3.2 s wait; one that never exits would make it for ever.
    const abandon = (): void => {
      abandoned = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          // Git has EXITED and its output is still draining. Not a runaway —
          // so no kill (and on Windows a kill by PID of a process that is
          // gone could land on whatever reuses the number). A short grace for
          // the pipes to close on their own, then close them: a success that
          // lands inside it is still a success.
          grace = setTimeout(abandon, 250);
          return;
        }
        killTree(child);
        abandon();
      }, timeoutMs);
    }
  });
}

/**
 * End a git invocation AND everything it started.
 *
 * ⚠️ ON WINDOWS `git` IS USUALLY A LAUNCHER (#772 review). An app started from
 * Explorer inherits the machine PATH, which carries `Git\cmd` — Git for
 * Windows' `cmd\git.exe`, a small program that starts the real
 * `mingw64\bin\git.exe` as a CHILD and waits. `execFile`'s `timeout` kills the
 * process it spawned, i.e. the launcher, and the real git runs on: measured
 * with a git busy on something other than stdin, one `git.exe` survived every
 * kill through the launcher and none survived the direct binary. (The first
 * probe used a git blocked on stdin, which exits by itself when the dead
 * launcher's pipe closes — it passed for the wrong reason, and a git stuck on
 * a slow disk is not reading stdin.) `taskkill /T` takes the tree.
 *
 * POSIX has no launcher layer: `git` is the binary, and `kill` ends it. What it
 * does not end is anything git itself started — an fsmonitor hook, a clean
 * filter — which is #776's subject: those should not be running at all.
 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    // EVERY failure of the tree kill falls back to killing the one process we
    // hold — the launcher at least goes, as it did before — and none of them
    // may throw: this runs in a timer callback in Electron main (review, round
    // 2). `spawn` reports some failures as an 'error' event and THROWS others
    // (ENOMEM and friends); taskkill can also start and then fail ("Access is
    // denied", a partial tree).
    //
    // A PID-reuse window remains and is accepted: the caller checked the
    // process had not exited, but taskkill opens the PID tens of milliseconds
    // later, and Node may have reaped it in between. Narrowing that would mean
    // matching image names, for odds that are very small.
    const fallback = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', fallback);
      killer.on('exit', (code) => {
        if (code !== 0) fallback();
      });
    } catch {
      fallback();
    }
    return;
  }
  child.kill();
}

function failureOf(err: unknown): GitFailure | null {
  if (!err) return null;
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'too-large';
  // `syscall` is what separates "the spawn failed" from "git ran and exited
  // non-zero": an exit-code error has no `syscall` and its `code` is the NUMBER
  // git exited with, while a spawn failure carries `spawn <file>` and an errno
  // string. Matching on `ENOENT` alone would also catch nothing else useful —
  // EACCES and EPERM are the same class of "git never ran".
  if (typeof e.syscall === 'string' && e.syscall.startsWith('spawn')) return 'no-exec';
  return 'failed';
}

/**
 * Git's own account of a failure, as a sentence fragment — or `null` when it
 * said nothing.
 *
 * The FIRST line only, and `fatal: ` taken off the front: git leads with the
 * thing that went wrong and then, for some failures, adds paragraphs of advice
 * ("To add an exception for this directory, call…") that belong in a terminal
 * and not in a 200px pane. `hint:` and `warning:` lines are dropped for the
 * same reason.
 */
function gitSaid(stderr: string): string | null {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('hint:') && !l.startsWith('warning:'));
  if (!line) return null;
  return clampReason(line.replace(/^fatal:\s*/, ''));
}

/**
 * ⚠️ **SOME OF THIS TEXT IS WRITTEN BY THE REPOSITORY (#785 review).** git
 * echoes a `.git` file's `gitdir:` line straight back into "not a git
 * repository: <path>", and a `.git` file is a plain text file a session — or,
 * per #776's threat model, a sibling agent — can write. The result goes two
 * places that both mind: a 200px pane, where a 4 KB line is a wall, and (via
 * `diff()`'s throw) another model's context as unfenced prose.
 *
 * So it is cut to a length a pane can hold and stripped of control characters,
 * which have no business in either destination.
 */
function clampReason(text: string): string {
  const clean = text.replace(CONTROL_CHARS, ' ').trim();
  return clean.length > REASON_CAP ? `${clean.slice(0, REASON_CAP)}…` : clean;
}

/** As much of git's sentence as a 200px pane can hold without becoming a wall. */
const REASON_CAP = 200;

/**
 * C0, DEL and C1 — BUILT FROM CODE POINTS, not typed into a literal.
 *
 * A control character typed into a regex literal lands in the source file as a
 * raw byte: the file becomes binary to every tool that reads it, and the change
 * is invisible in review. It happened while writing this very function.
 */
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`,
  'g'
);

/**
 * git's benign "I walked up from here and found no repository".
 *
 * ⚠️ **MEASURED, AND NARROWER THAN IT LOOKS (#785).** git says *"not a git
 * repository"* for a damaged repository too — a `.git` file pointing at a
 * directory that is not there answers `fatal: not a git repository:
 * /nonexistent/xyz`, exit 128, exactly like the ordinary folder that simply
 * is not one. So the match is on the PARENTHESIS, which only the two benign
 * variants carry (`(or any of the parent directories): .git` and `(or any
 * parent up to mount point …)`), and everything else is treated as a
 * repository we could not read.
 *
 * Getting this backwards is the whole bug: a folder that is genuinely not a
 * repository must keep saying so, plainly, because that is the common case and
 * it is not an error.
 *
 * ⚠️ **ANCHORED, BECAUSE PART OF THAT MESSAGE IS ATTACKER-WRITTEN (#785
 * review).** This took the whole of stderr and searched it, and the damaged-repo
 * message it exists to catch echoes the `.git` file's `gitdir:` line back
 * verbatim — a plain text file a session can write. `gitdir: ../not a git
 * repository (or any` would have reclassified a damaged repository as a benign
 * one and restored the original lie on demand. Taking `gitSaid`'s extracted
 * line and anchoring at position 0 puts the phrase somewhere the echoed text
 * can never reach.
 */
function saysNotARepo(said: string | null): boolean {
  return said !== null && /^not a git repository \(or any/i.test(said);
}

/**
 * Which of the two `ENOENT`s this was.
 *
 * Measured (#785): `execFile('git', …, { cwd })` with a `cwd` that does not
 * exist fails with `code: 'ENOENT'`, `syscall: 'spawn git'` — the same error,
 * field for field, as a machine with no git on its PATH. So the error cannot
 * answer it and the filesystem is asked instead. A folder deleted in the
 * microsecond between is reported as "git could not be started", which is the
 * vaguer of the two and therefore the right way to be wrong.
 *
 * ⚠️ **ASYNC, AND THAT IS NOT A STYLE CHOICE (#785 review).** This was
 * `fs.existsSync`, in the Electron MAIN process, on the code path whose headline
 * case is a disconnected network drive — where a synchronous stat is an SMB
 * timeout of seconds, with every session's IPC and every terminal write stalled
 * behind it. "Our breakage never blocks a session" is a hard constraint, and a
 * fail-open path that freezes the app is the worst shape a failure can take.
 *
 * It asks whether the folder is a DIRECTORY, not merely whether something is
 * there: a `cwd` pointing at a file fails the same way, and telling that user
 * git might not be installed is a third wrong answer in the same branch.
 */
async function spawnReason(folder: string): Promise<string> {
  try {
    const st = await fs.promises.stat(folder);
    if (!st.isDirectory()) return 'that path is not a folder, so there is nothing to run git in';
  } catch {
    return 'that folder no longer exists, or is not reachable';
  }
  return 'git could not be started — it may not be installed, or not on the PATH';
}

export class GitService {
  constructor(private readonly command: GitCommand = SYSTEM_GIT) {}

  private run(
    folder: string,
    args: string[],
    timeoutMs?: number,
    env?: NodeJS.ProcessEnv
  ): Promise<GitRun> {
    return git(this.command, folder, args, timeoutMs, env);
  }

  /**
   * The environment that stops this repository's own config from executing a
   * command while we read its working tree (#776). Used by `status` and `diff`
   * — the two reads measured to run a repo-configured filter. `rev-parse` and
   * `git show HEAD:<path>` were measured NOT to, and get only the guards every
   * invocation carries.
   *
   * `left` is the shared deadline, not a per-call allowance: this makes several
   * git invocations, and handing each of them the same fixed number would turn
   * one 10 s budget into thirty-five of them.
   *
   * ⚠️ **A CONFIG WE COULD NOT READ MEANS WE DO NOT RUN THE READ.** "No
   * repo-authored driver" and "we could not find out" must never be the same
   * answer, and there is no partial guard to fall back to — see `EMPTY_TREE`
   * for why the attribute-level switch that used to sit here was not the
   * blanket it looked like. Reaching this means `git config --list` failed
   * twice on a repository `rev-parse` had already called a work tree, which is
   * a broken repository or a timeout; both are better refused than guessed at.
   *
   * It says WHICH refusal since #785. The two are different problems with
   * different answers — "this repository is damaged" versus "this git predates
   * the mechanism, upgrade it" — and lumping them was fine only while the one
   * consumer was a thrown string nobody had to act on.
   */
  private async guardEnv(folder: string, left?: () => number): Promise<GuardEnv> {
    const entries = await this.scopedConfig(folder, left);
    if (!entries) return { env: null, reason: GUARD_CONFIG_UNREADABLE };
    const overrides = filterGuardOverrides(entries);
    // Nothing repo-authored: the common case, and it skips the check below.
    if (overrides.length === 0) return { env: overrideEnv(process.env, []) };
    const honoured = await this.honoursEnvOverrides(folder, left);
    // `null` is "the probe did not finish", not "this git is too old" — see
    // `honoursEnvOverrides`. Both refuse the read; only one blames the user's
    // git version, and saying that about a git that is fine is the confident
    // wrong answer #785 exists to stop.
    if (honoured === null) return { env: null, reason: GUARD_PROBE_UNFINISHED };
    if (!honoured) return { env: null, reason: GUARD_TOO_OLD };
    return { env: overrideEnv(process.env, overrides) };
  }

  /**
   * Does this git honour `GIT_CONFIG_KEY_<n>`? Asked once, of git itself.
   *
   * ⚠️ **THE WHOLE GUARD IS A NO-OP ON git < 2.31, WHICH IS NOT HYPOTHETICAL.**
   * `ownConfig` has a fallback branch precisely because Ubuntu 20.04 ships
   * 2.25.1 and Debian 11 ships 2.30.2 — and those gits do not know these
   * variables exist. They read the config, ignore our environment, and run the
   * driver, with nothing to show that anything was skipped. Round 1's
   * command-line overrides at least degraded to something.
   *
   * Asked BEHAVIOURALLY rather than by parsing `git --version`: what matters is
   * whether the override takes, not what number the binary reports. Memoised —
   * and only reached when there is actually something to guard, so a repository
   * with no driver of its own never pays for it.
   *
   * A `false` here refuses the read. The alternative — falling back to
   * `-c key=value` — is what round 1 did, and it cannot express a key
   * containing `=`, which is exactly the shape an attacker picks.
   *
   * ⚠️ **ONLY A DEFINITE ANSWER IS REMEMBERED (#785 review).** This used to
   * memoise `r.ok && …`, and `r.ok` is false for a probe that TIMED OUT or a
   * git that never started — neither of which is a fact about this git's
   * version. On the `status` path the guard's earlier reads share a 15 s budget
   * with this one, so a slow or network checkout with a repo-authored driver
   * (`git lfs install --local` writes one, which is the exact case the manual
   * documents) could spend the budget and leave `left()` clamped to 1 ms. The
   * cached `false` then sat on the app-wide service for the process lifetime
   * and told the user, for EVERY project including fast healthy ones, that
   * their git was too old and they should upgrade it — on git 2.51. #785 is
   * what made that sentence specific enough to be a lie worth stopping.
   *
   * So an indefinite outcome answers `null`, forgets itself, and the next read
   * asks again. `null` still refuses THIS read — a guard that cannot be checked
   * is not a guard — it just refuses with a different sentence.
   */
  private envOverridesHonoured: Promise<boolean | null> | null = null;
  private honoursEnvOverrides(folder: string, left?: () => number): Promise<boolean | null> {
    if (this.envOverridesHonoured) return this.envOverridesHonoured;
    // Annotated, and assigned BEFORE the `then` can run, so concurrent callers
    // still share one probe the way the old `??=` did.
    const probe: Promise<boolean | null> = this.run(
      folder,
      ['config', '--get', 'switchboard.guardprobe'],
      left?.(),
      overrideEnv(process.env, [['switchboard.guardprobe', 'yes']])
    ).then((r) => {
      if (r.failure === 'timeout' || r.failure === 'no-exec') {
        // Guarded against clobbering a later probe's answer, not just set to
        // null: another read may already have replaced this one.
        if (this.envOverridesHonoured === probe) this.envOverridesHonoured = null;
        return null;
      }
      return r.ok && r.out.trim() === 'yes';
    });
    this.envOverridesHonoured = probe;
    return probe;
  }

  /**
   * Every config entry that can name a filter driver for this read, with the
   * scope that set it — or `null` if we could not find out.
   *
   * **A SUBMODULE'S OWN CONFIG COUNTS (measured, #776).** Reading the
   * superproject recurses into each initialised submodule, and a driver defined
   * in `.git/modules/<name>/config` — a plain file an edit-only agent can write
   * in any repository that already has submodules — RAN during both `status`
   * and `diff-index`. The overrides themselves reach it (measured: the
   * `GIT_CONFIG_*` environment propagates to the child git, as does the
   * fsmonitor guard); what does not reach it is the *name*, which only that
   * config knows. So the names are collected from there too.
   *
   * `--ignore-submodules=all` would also have closed it and was rejected: it
   * drops a dirty submodule out of the answer entirely (measured, one changed
   * entry became zero), which is a confident wrong answer about somebody's
   * working tree rather than a slower one.
   */
  private async scopedConfig(folder: string, left?: () => number): Promise<ScopedConfigEntry[] | null> {
    const own = await this.ownConfig(folder, left);
    if (!own) return null;
    const submodules = await this.submoduleConfig(folder, left);
    if (!submodules) return null;
    return [...own, ...submodules];
  }

  /**
   * This repository's own config, in the scopes git reports for it.
   *
   * ⚠️ **`--show-scope` IS git ≥ 2.26, AND UBUNTU 20.04 SHIPS 2.25.1.** That LTS
   * is supported to 2030, so "just require a modern git" would blank the git
   * pane there. The second attempt asks the two repo-writable scopes directly,
   * with options that have existed for ever. It cannot see the trusted value
   * behind a shadowed driver, so a driver named there is neutralised to empty
   * rather than restored; a globally-installed one is still never listed, and
   * so still never touched.
   */
  private async ownConfig(folder: string, left?: () => number): Promise<ScopedConfigEntry[] | null> {
    const scoped = await this.run(folder, CONFIG_LIST_SCOPED, left?.());
    if (scoped.ok) return parseScopedConfig(scoped.out);

    const local = await this.run(folder, configListForScope('local'), left?.());
    if (!local.ok) return null;
    // `--worktree` returns the local config verbatim when the extension is off
    // rather than failing, so this usually duplicates the entries above. Both
    // scopes are untrusted and `filterGuardOverrides` de-duplicates by key, so
    // the duplication is harmless; it is listed separately for the repository
    // that HAS `extensions.worktreeConfig` on, where the two really differ.
    const worktree = await this.run(folder, configListForScope('worktree'), left?.());
    return [
      ...parseUnscopedConfig(local.out, 'local'),
      ...(worktree.ok ? parseUnscopedConfig(worktree.out, 'worktree') : []),
    ];
  }

  /**
   * The config of every populated submodule, recursively.
   *
   * ⚠️ **ASK GIT WHERE THE SUBMODULE IS; DO NOT WORK IT OUT.** Two earlier
   * versions of this tried, and a repository walked around both:
   *
   * - Gating on `<folder>/.gitmodules` switched the whole thing off whenever the
   *   session folder was a subdirectory — measured, `git status` from a
   *   subdirectory still recurses and still runs the drivers.
   * - Opening `<gitdir>/modules/<name>` by name missed **a redirected git
   *   directory**: `sub/.git` is a plain text file an edit-only agent can
   *   repoint at any ordinary folder, and measured, the driver then RAN during
   *   both `status` and `diff-index` while `modules/` sat empty. (It also had to
   *   know that a linked worktree has two roots, `$GIT_DIR` and
   *   `$GIT_COMMON_DIR`, with submodules possible under either.)
   *
   * The index is the honest source — a gitlink is what git recurses into — and
   * `git -C <path> config` then resolves whatever `.git` file, `core.worktree`
   * or nesting git itself would use. That deletes all the guessing, and gives
   * real SCOPES for the submodule's own config, so a globally-installed driver
   * inside a submodule stays trusted rather than being neutralised.
   *
   * `--ignore-submodules=all` would also have closed this and was rejected: it
   * drops a dirty submodule out of the answer entirely (measured, one changed
   * entry became zero) — a confident wrong answer about somebody's working tree
   * rather than a slower one.
   */
  private async submoduleConfig(
    folder: string,
    left?: () => number,
    depth = 0,
    budget = { left: MAX_SUBMODULES }
  ): Promise<ScopedConfigEntry[] | null> {
    const staged = await this.run(folder, ['ls-files', '--stage', '-z'], left?.());
    if (!staged.ok) return null;
    const paths = gitlinkPaths(staged.out);
    if (paths.length === 0) return [];
    // Over the cap, or nested deeper than anyone nests, the answer stops being
    // "these are the drivers" and becomes "these are some of them" — which is
    // the one thing a guard may not be. The caller refuses.
    if (depth >= MAX_SUBMODULE_DEPTH) return null;

    const entries: ScopedConfigEntry[] = [];
    for (const p of paths) {
      const dir = path.resolve(folder, p);
      // A submodule that was never checked out has no config, and git does not
      // recurse into it. `.git` is a file for a normal submodule and a
      // directory for an old-style embedded one; either answers "populated".
      if (!fs.existsSync(path.join(dir, '.git'))) continue;
      if (budget.left-- <= 0) return null;
      const own = await this.ownConfig(dir, left);
      if (!own) return null;
      entries.push(...own);
      const nested = await this.submoduleConfig(dir, left, depth + 1, budget);
      if (!nested) return null;
      entries.push(...nested);
    }
    return entries;
  }

  /** repo toplevel for a folder, or null when not a repo / no git */
  async root(folder: string): Promise<string | null> {
    const r = await this.run(folder, ['rev-parse', '--show-toplevel']);
    const top = r.out.trim();
    return r.ok && top ? top : null;
  }

  /**
   * ⚠️ **THE BUDGET BOUNDS THE GUARD, NOT THE STATUS (#776 review).** The guard
   * is what this item added to the pane's hot path — a config read, a directory
   * listing and one read per submodule, all reachable from files a session can
   * write — so it is what needs bounding. `status` itself is deliberately left
   * unbounded, as it always was: a genuinely enormous repository, or a cold
   * network drive, can legitimately take a long time, and killing it would
   * report a repository that is merely slow as one switchboard could not read.
   * Trading a hang for a lie is the wrong way round on this surface — the bus's
   * `diff`, whose answer a model reads, makes the opposite trade and says so.
   *
   * (That read **"Not a git repository"** until #785, which is what a killed
   * `status` reported then. The trade has not changed; the lie it was weighed
   * against got smaller, and the note would otherwise describe an answer this
   * method can no longer give.)
   */
  async status(folder: string, guardBudgetMs = GUARD_BUDGET_MS): Promise<GitStatus> {
    const probe = await this.run(folder, ['rev-parse', '--is-inside-work-tree']);
    if (!probe.ok) {
      // git never started: no stderr to read, and the error cannot say whether
      // it was git or the folder that was missing.
      if (probe.failure === 'no-exec') {
        return { isRepo: false, unreadable: await spawnReason(folder), files: [] };
      }
      const said = gitSaid(probe.err);
      // THE ONE BRANCH THAT MUST STAY QUIET. A folder that is not a repository
      // is the common case and is not an error — see `saysNotARepo` for why the
      // match is anchored and not a search of the whole of stderr.
      if (saysNotARepo(said)) return { isRepo: false, files: [] };
      return {
        isRepo: false,
        unreadable: said ?? 'git could not tell whether this folder is a repository',
        files: [],
      };
    }
    // `false` from a git that answered cleanly: a bare repository, or the
    // inside of a `.git` directory. Not a working tree, and not a failure.
    if (!probe.out.trim().startsWith('true')) return { isRepo: false, files: [] };

    const deadline = Date.now() + guardBudgetMs;
    // `isRepo: true` from here down, on every branch: `rev-parse` has ALREADY
    // said this is a work tree, so answering `false` would be a second wrong
    // answer bolted onto the first. What we no longer have is a reading of it.
    const guard = await this.guardEnv(folder, () => Math.max(1, deadline - Date.now()));
    if (!guard.env) return { isRepo: true, unreadable: guard.reason, files: [] };

    // quotePath=off: non-ASCII paths arrive literal, so fileVersions can find them
    const r = await this.run(
      folder,
      ['-c', 'core.quotePath=off', 'status', '--porcelain=v2', '--branch', '--untracked-files=all'],
      0,
      guard.env
    );
    if (!r.ok) {
      // `no-exec` is reachable here too: git, or the folder, can disappear
      // between the probe and this call. Falling through to "said nothing about
      // why" would throw away the one diagnosis we can still make (review nit).
      const why =
        r.failure === 'too-large'
          ? `git status produced more than the ${MAX_GIT_OUTPUT / 1024 / 1024} MB switchboard reads in one go`
          : r.failure === 'no-exec'
            ? await spawnReason(folder)
            : (gitSaid(r.err) ?? 'git status did not succeed, and said nothing about why');
      return { isRepo: true, unreadable: why, files: [] };
    }

    const status: GitStatus = { isRepo: true, files: [] };
    for (const line of r.out.split('\n')) {
      if (line.startsWith('# branch.head ')) {
        status.branch = line.slice('# branch.head '.length).trim();
      } else if (line.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(line);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        // ordinary/rename entries: "1 XY sub mH mI mW hH hI path"
        const parts = line.split(' ');
        const xy = parts[1];
        const p = line.startsWith('2 ')
          ? line.split('\t')[0].split(' ').slice(9).join(' ')
          : parts.slice(8).join(' ');
        status.files.push({
          path: p,
          xy,
          staged: xy[0] !== '.',
          unstaged: xy[1] !== '.',
          untracked: false,
        });
      } else if (line.startsWith('? ')) {
        status.files.push({ path: line.slice(2), xy: '??', staged: false, unstaged: true, untracked: true });
      }
    }
    return status;
  }

  /**
   * The working tree's uncommitted changes as ONE unified diff (P2-E11-01).
   *
   * WHY THIS EXISTS ALONGSIDE `fileVersions`. That one answers Monaco, which
   * wants two whole file contents and renders the difference itself. This one
   * answers a language model, which reads text — and would otherwise be handed
   * two full copies of every changed file and asked to diff them in its head,
   * at several times the tokens.
   *
   * Diffed against `HEAD` with no pathspec, so BOTH staged and unstaged changes
   * are included: a sibling agent asking "what have you changed" means
   * everything not committed, and plain `git diff` would silently omit whatever
   * the other session had already staged. Untracked files are NOT included —
   * `git diff` does not see them.
   *
   * ⚠️ **A REPO WITH NO COMMITS HAS NO `HEAD`**, and `git diff HEAD` there does
   * not return nothing — it fails with `fatal: ambiguous argument 'HEAD'`,
   * which this used to swallow into `{ isRepo: true, text: '' }`. A session
   * that had just scaffolded an entire project and staged it answered "I have
   * changed nothing": a confident wrong answer, which is the one failure mode
   * this whole query path is built to avoid. So an unborn HEAD falls back to
   * git's empty-tree object, against which every file reads as an addition.
   *
   * ⚠️ **`--no-ext-diff` IS THE SECURITY-RELEVANT FLAG, NOT `--no-textconv`.**
   * An earlier version of this comment claimed `--no-textconv` stopped a repo's
   * config running commands on our behalf. It does not — it disables textconv
   * filters only, and `diff.external` (or a `.gitattributes`-selected
   * `diff.<name>.command`) still executes. Measured: with
   * `diff.external = sh -c "echo PWNED"`, `--no-textconv` alone runs it and
   * `--no-ext-diff` does not. This matters more here than anywhere else in the
   * service, because #764 will point this at a folder another agent controls.
   *
   * Fail-open like the rest of this service for the question "is this a repo":
   * a folder that is not one yields `{ isRepo: false, text: '' }`. **No git on
   * PATH used to yield that too, and does not since #785** — see the probe.
   *
   * ⚠️ **A FAILED `git diff` THROWS, and that is the OPPOSITE of the rest of
   * this service on purpose (#764 review).** This used to be
   * `text: r.ok ? r.out : ''`, which is the SAME SWALLOW the unborn-HEAD note
   * above records fixing one line higher, and it is worse here than anywhere
   * else in the file: the one consumer is `SessionQueries.sessionDiff`, whose
   * answer is read by a language model, and an empty string there renders as
   * *"has no uncommitted changes"*. The most likely way to reach it is `git`
   * exceeding `maxBuffer` — 32 MB — which happens precisely when the sibling
   * has done the most work, so the tool got less truthful the more there was to
   * say. `sessionDiff` already refuses on a throw, with a reason, for exactly
   * this reason; it just never had one to catch.
   *
   * ⚠️ **PLUMBING, NOT PORCELAIN (#772) — `git diff` WRITES THE SIBLING'S
   * INDEX.** Porcelain `diff` quietly refreshes the index when it finds files
   * whose timestamps changed and contents did not (what an editor or formatter
   * leaves behind), and to do that it takes `.git/index.lock`. Measured: the
   * index file's bytes change across one call, and `GIT_OPTIONAL_LOCKS=0` does
   * NOT stop it — that switch covers `status`, not `diff`. So while a sibling
   * read this session's changes, this session's own `git add` could fail with
   * "index.lock: File exists" — and killing that git mid-write would have left
   * the lock behind for good. `diff-index` never refreshes; its output matched
   * porcelain byte for byte in the same measurement, and `-M` restores the
   * rename detection porcelain does by default (a staged `git mv` otherwise
   * reads as a delete plus an add). `--no-color` is belt and braces, NOT a
   * fix: plumbing ignores `color.ui=always` already (measured), but the repo's
   * config is another agent's to write and ANSI escapes in a model's context
   * would be a quiet way to get this wrong later. No test pins it, because
   * none could fail.
   *
   * **BOUNDED AND KILLED (#772).** All three invocations share
   * `budgetMs`; past it git is killed and this throws saying so. A timed-out
   * probe is a timeout — NOT "not a repository" and NOT "no HEAD", both of
   * which would be confident wrong answers about somebody else's work.
   */
  async diff(folder: string, budgetMs = DIFF_BUDGET_MS): Promise<{ isRepo: boolean; text: string }> {
    // ONE budget, spent across the calls — three budgets would be three times
    // the bound this exists to set.
    const deadline = Date.now() + budgetMs;
    const left = (): number => Math.max(1, deadline - Date.now());
    const timedOut = (): Error =>
      new Error(
        `git did not finish reading the changes within ${Math.round(budgetMs / 1000)}s ` +
          '(the repository may be very large, or its disk slow to respond)'
      );

    // One probe, and the same one `status()` uses — `--show-toplevel` was a
    // second answer to a question this file already asks.
    const inside = await this.run(folder, ['rev-parse', '--is-inside-work-tree'], left());
    if (inside.failure === 'timeout') throw timedOut();
    // ⚠️ **THE SAME LIE #785 FIXED ON `status`, ON THE PATH A MODEL READS.**
    // This was `!inside.ok || … → { isRepo: false }`, which `renderDiff` turns
    // into *"it is not working inside a git repository"* — told, with no
    // qualification, for a machine with no git, a folder that has been deleted
    // and a damaged repository alike. That is the confident wrong answer this
    // whole query path exists to avoid, and it is worse here than on the pane
    // because the reader is an agent that will act on it. A folder that really
    // is not a repository still answers plainly; see `saysNotARepo`.
    if (inside.failure === 'no-exec') throw new Error(await spawnReason(folder));
    const insideSaid = gitSaid(inside.err);
    if (!inside.ok && !saysNotARepo(insideSaid)) {
      throw new Error(insideSaid ?? 'git could not tell whether that folder is a repository');
    }
    if (!inside.ok || inside.out.trim() !== 'true') return { isRepo: false, text: '' };
    // git's canonical empty tree: the base every file is an addition against.
    // Shared with the guard, which points `--attr-source` at the same object.
    const head = await this.run(folder, ['rev-parse', '--verify', '-q', 'HEAD'], left());
    if (head.failure === 'timeout') throw timedOut();
    const base = head.ok ? 'HEAD' : EMPTY_TREE;
    // `left` ITSELF, not `left()` — the guard makes several invocations, and a
    // fixed number handed to each of them would turn one 10 s budget into one
    // per call, which is the bound #772 exists to set, undone.
    const guard = await this.guardEnv(folder, left);
    if (!guard.env) {
      if (Date.now() >= deadline) throw timedOut();
      throw new Error(guard.reason);
    }
    const r = await this.run(
      folder,
      ['diff-index', '-p', '-M', '--no-color', '--no-textconv', '--no-ext-diff', base],
      left(),
      guard.env
    );
    if (r.failure === 'timeout') throw timedOut();
    if (r.failure === 'too-large') {
      throw new Error(
        `git could not produce the diff: it is larger than the ${MAX_GIT_OUTPUT / 1024 / 1024} MB ` +
          'switchboard reads in one go'
      );
    }
    // git's own account, when it gave one (#785 review). The `git lfs install
    // --local` repository the manual documents fails HERE, and the pane has
    // been quoting `filter 'lfs' failed…` since #785 while the model on the
    // other end of the bus still got a bare shrug with the actionable half
    // deleted.
    if (!r.ok) throw new Error(gitSaid(r.err) ?? 'git could not produce the diff');
    return { isRepo: true, text: r.out };
  }

  /** HEAD vs working-tree contents for a Monaco diff (E5-02). */
  async fileVersions(folder: string, file: string): Promise<FileVersions> {
    const head = await this.run(folder, ['show', `HEAD:${toGitPath(file)}`]);
    let modified = '';
    try {
      modified = fs.readFileSync(path.join(folder, file), 'utf8');
    } catch {
      modified = ''; // deleted in working tree
    }
    return { original: head.ok ? head.out : '', modified };
  }
}

function toGitPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * How many submodules we will read the config of, and how deep we will nest,
 * before giving up on enumerating them (#776). Past either, the answer stops
 * being "these are the drivers" and becomes "these are some of them", which is
 * the one thing a guard may not be — so the read is refused rather than
 * half-guarded. Both are set well past anything real: "big repository" and
 * "hostile repository" must not be the same branch.
 */
const MAX_SUBMODULES = 512;
const MAX_SUBMODULE_DEPTH = 10;

/**
 * The environment #776's guard built, or why it refused to build one.
 *
 * A discriminated pair rather than `NodeJS.ProcessEnv | null` so the refusal
 * arrives WITH its reason (#785): `status()` puts it on the pane and `diff()`
 * throws it, and neither can invent it after the fact.
 */
type GuardEnv = { env: NodeJS.ProcessEnv; reason?: undefined } | { env: null; reason: string };

/**
 * ⚠️ **THE SUBMODULE CAP LANDS HERE TOO, AND THE WORDING ADMITS IT.**
 * `scopedConfig` returns a bare `null` for a config it could not read, a
 * submodule whose config it could not read, and a repository past
 * `MAX_SUBMODULES` / `MAX_SUBMODULE_DEPTH` alike. Threading a third reason back
 * through that recursion buys a distinction for a bound nothing real reaches —
 * so the sentence says "could not enumerate" and names the three shapes rather
 * than claiming one of them.
 */
const GUARD_CONFIG_UNREADABLE =
  "git could not enumerate this repository's own configuration, so switchboard did not run git " +
  'here (the repository may be damaged, its submodules unusual, or the read may have timed out)';

/**
 * The git-is-too-old refusal, kept APART from the one above since #785.
 *
 * It is not a damaged repository — it is a supported platform (Ubuntu 20.04
 * ships 2.25.1, Debian 11 ships 2.30.2, both below the 2.31 that introduced
 * `GIT_CONFIG_KEY_<n>`) — and the thing to do about it is upgrade git, which
 * "the repository may be damaged" would send nobody off to do.
 */
const GUARD_TOO_OLD =
  "this git is too old to apply switchboard's safety overrides (git 2.31 or newer is needed), " +
  'so switchboard did not run git here';

/**
 * The guard could not be CHECKED — distinct from both of the above (#785
 * review).
 *
 * A timed-out or unstartable capability probe says nothing about this git's
 * version, and `GUARD_TOO_OLD` would name a version number and send the user
 * off to upgrade a git that is fine. Hedged on purpose: this is the one of the
 * three that is most likely to be transient, and the next read may well answer.
 */
const GUARD_PROBE_UNFINISHED =
  'switchboard could not check whether this git applies its safety overrides (the check did not ' +
  'finish), so it did not run git here — this may clear by itself';
