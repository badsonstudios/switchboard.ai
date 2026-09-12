// GitService (P1-E5-01): status + diff via the system git binary, parsed
// models, graceful everywhere — a session folder that isn't a repo (or a
// machine without git) yields { isRepo: false }, never an error dialog.
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

/** Why a git invocation did not succeed, when the difference matters. */
type GitFailure = 'timeout' | 'too-large' | 'failed';

interface GitRun {
  ok: boolean;
  out: string;
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
    const child = execFile(
      command.file,
      [...command.prefixArgs, ...guardArgs(), ...args],
      {
        cwd: folder,
        encoding: 'utf8',
        maxBuffer: MAX_GIT_OUTPUT,
        windowsHide: true,
        // GIT_OPTIONAL_LOCKS=0 suppresses the index refresh `status` would
        // otherwise write — which is what fires `post-index-change`, and which
        // also took `.git/index.lock` in a folder another agent may be
        // `git add`-ing (#772 fixed that for `diff` and never for `status`).
        // Measured: status output is byte-identical with and without.
        env: { ...(env ?? process.env), GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout) => {
        if (timer) clearTimeout(timer);
        if (grace) clearTimeout(grace);
        // Abandoned means we closed the pipes ourselves, so whatever came
        // back may be cut short: a timeout, whatever the exit code said.
        const failure = abandoned ? 'timeout' : err ? failureOf(err) : null;
        resolve({ ok: !err && !abandoned, out: stdout ?? '', failure });
      }
    );
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
  if ((err as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'too-large';
  return 'failed';
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
   */
  private async guardEnv(folder: string, left?: () => number): Promise<NodeJS.ProcessEnv | null> {
    const entries = await this.scopedConfig(folder, left);
    if (!entries) return null;
    const overrides = filterGuardOverrides(entries);
    // Nothing repo-authored: the common case, and it skips the check below.
    if (overrides.length === 0) return overrideEnv(process.env, []);
    if (!(await this.honoursEnvOverrides(folder, left))) return null;
    return overrideEnv(process.env, overrides);
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
   */
  private envOverridesHonoured: Promise<boolean> | null = null;
  private honoursEnvOverrides(folder: string, left?: () => number): Promise<boolean> {
    this.envOverridesHonoured ??= this.run(
      folder,
      ['config', '--get', 'switchboard.guardprobe'],
      left?.(),
      overrideEnv(process.env, [['switchboard.guardprobe', 'yes']])
    ).then((r) => r.ok && r.out.trim() === 'yes');
    return this.envOverridesHonoured;
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
   * report **"Not a git repository"** for a repository that is merely slow.
   * Trading a hang for a lie is the wrong way round on this surface — the bus's
   * `diff`, whose answer a model reads, makes the opposite trade and says so.
   */
  async status(folder: string, guardBudgetMs = GUARD_BUDGET_MS): Promise<GitStatus> {
    const probe = await this.run(folder, ['rev-parse', '--is-inside-work-tree']);
    if (!probe.ok || !probe.out.trim().startsWith('true')) return { isRepo: false, files: [] };

    const deadline = Date.now() + guardBudgetMs;
    const env = await this.guardEnv(folder, () => Math.max(1, deadline - Date.now()));
    if (!env) return { isRepo: false, files: [] };

    // quotePath=off: non-ASCII paths arrive literal, so fileVersions can find them
    const r = await this.run(
      folder,
      ['-c', 'core.quotePath=off', 'status', '--porcelain=v2', '--branch', '--untracked-files=all'],
      0,
      env
    );
    if (!r.ok) return { isRepo: false, files: [] };

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
   * not a repo, and no git on PATH, both yield `{ isRepo: false, text: '' }`.
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
    if (!inside.ok || inside.out.trim() !== 'true') return { isRepo: false, text: '' };
    // git's canonical empty tree: the base every file is an addition against.
    // Shared with the guard, which points `--attr-source` at the same object.
    const head = await this.run(folder, ['rev-parse', '--verify', '-q', 'HEAD'], left());
    if (head.failure === 'timeout') throw timedOut();
    const base = head.ok ? 'HEAD' : EMPTY_TREE;
    // `left` ITSELF, not `left()` — the guard makes several invocations, and a
    // fixed number handed to each of them would turn one 10 s budget into one
    // per call, which is the bound #772 exists to set, undone.
    const env = await this.guardEnv(folder, left);
    if (!env) {
      if (Date.now() >= deadline) throw timedOut();
      throw new Error(
        "git could not read the repository's own configuration, so switchboard did not run " +
          'git in that folder (the repository may be damaged)'
      );
    }
    const r = await this.run(
      folder,
      ['diff-index', '-p', '-M', '--no-color', '--no-textconv', '--no-ext-diff', base],
      left(),
      env
    );
    if (r.failure === 'timeout') throw timedOut();
    if (r.failure === 'too-large') {
      throw new Error(
        `git could not produce the diff: it is larger than the ${MAX_GIT_OUTPUT / 1024 / 1024} MB ` +
          'switchboard reads in one go'
      );
    }
    if (!r.ok) throw new Error('git could not produce the diff');
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
