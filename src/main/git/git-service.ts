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
import { ChildProcess, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
// Shared with the one-shot CLI runner (#758) rather than copied into it — see
// that module's header for the second measured launcher case.
import { killTree } from '../transport/kill-tree';
import { trackChild } from '../diagnostics/live-children';
import {
  type GitCommit,
  type GitLogQuery,
  appliedPath,
  diffBaseFor,
  logArgs,
  parseLog,
} from './git-log';
import {
  type GitWriteResult,
  batchPaths,
  discardTrackedArgs,
  discardUntrackedArgs,
  planDiscard,
  refused,
  stageArgs,
  unstageArgs,
  writePaths,
} from './git-write';
import {
  type CommitOptions,
  COMMIT_BUDGET_MS,
  commitArgs,
  commitRefusal,
  emptyMessageRefusal,
  isCommittableMessage,
} from './git-commit';
import { type FileStats, mergeNumstats, numstatArgs, parseNumstat } from './git-numstat';
import {
  type CommitFile,
  mergeCommitFiles,
  nameStatusArgs,
  parseNameStatus,
} from './git-commit-files';
import {
  CONFIG_LIST_SCOPED,
  EMPTY_TREE,
  type ScopedConfigEntry,
  configListForScope,
  filterGuardOverrides,
  gitlinkPaths,
  type GuardOpts,
  guardArgs,
  overrideEnv,
  parseScopedConfig,
  parseUnscopedConfig,
} from './repo-config-guard';

export interface GitFileStatus {
  path: string;
  /** porcelain XY, e.g. "M.", ".M", "??" (untracked), "UU" (conflicted) */
  xy: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  /**
   * This file is in a merge conflict (E24 Git v2 item 6).
   *
   * ⚠️ **NEW, BECAUSE CONFLICTED FILES WERE NOT REPORTED AT ALL.** porcelain v2
   * puts an unmerged entry on its own `u ` line, and the parser matched only
   * `1 `, `2 ` and `? ` — so a file in a conflict was invisible in the Changes
   * tab and uncounted in the card header's badge, at the one moment a user most
   * needs to know which files are in trouble.
   *
   * Optional rather than required so no existing consumer has to change: both
   * `staged` and `unstaged` are `true` for a conflict, which is the honest answer
   * to each of those questions on its own.
   */
  conflicted?: boolean;
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
  /**
   * Per-file `+/−`, keyed by the same path `files` uses (E24 Git v2 item 7).
   *
   * ⚠️ **PRESENT ONLY WHEN ASKED FOR, AND ABSENT IS NOT EMPTY.** `undefined` means
   * the caller did not pay for it; `{}` means it was asked and nothing has
   * changed. The sidebar needs the difference to tell "we have no numbers" from
   * "the numbers are zero" — which is the distinction this whole epic keeps being
   * corrected for.
   *
   * ⚠️ **AND IT RIDES ON `status()` RATHER THAN ON A CHANNEL OF ITS OWN, WHICH IS
   * THE WHOLE REASON IT IS HERE.** Two round trips would be two snapshots: the
   * file list from one moment and the numbers from another, drawn in the SAME ROW.
   * A row reading `+12 −3` beside a file that is no longer changed is exactly the
   * confident wrong answer this surface exists to stop giving. One call, one #776
   * guard, one moment.
   */
  stats?: Record<string, FileStats>;
}

export interface FileVersions {
  /** content at HEAD (empty for new files) */
  original: string;
  /** working-tree content (empty for deletions) */
  modified: string;
}

/**
 * `git log`'s answer (E24 Git v2 item 1, §5.7).
 *
 * Shaped like `GitStatus` and NOT like `diff()`: it answers a PANE, so it
 * reports a failure in a field rather than throwing. `diff()` throws because its
 * one consumer is a language model reading prose, where an empty string renders
 * as "has no uncommitted changes" — a confident wrong answer. The History tab
 * can draw "we could not read the history, because <git's reason>" and keep the
 * card alive, which is what fail-open asks for here.
 */
export interface GitLog {
  isRepo: boolean;
  /** why this is not a reading of the history — same discipline as `GitStatus` */
  unreadable?: string;
  /**
   * This repository has no commits yet.
   *
   * ⚠️ **A FACT, NOT A FAILURE, AND IT HAS TO BE SAID SEPARATELY.** `git log`
   * exits 128 on an unborn HEAD, and with an explicit `HEAD` argument — which
   * `logArgs` always passes — the message is `fatal: bad revision 'HEAD'`
   * (measured). That is byte-indistinguishable from a typo'd ref, so matching on
   * it would report a brand-new `git init` as a broken repository. The answer is
   * established POSITIVELY instead, by asking `rev-parse --verify -q HEAD` after
   * the failure.
   */
  unborn?: boolean;
  /**
   * The pathspec this reading was ACTUALLY filtered by, if any.
   *
   * ⚠️ **THE ANSWER CARRIES ITS OWN FILTER, AND IT HAS TO (found in review).** The
   * History tab drew its "showing only this file" chip off the REQUEST, so when
   * `safePath` refused a path the pane showed **the whole repository's history
   * under a chip naming one file** — the one shape worse than an empty list, and
   * the exact confident-wrong-answer this epic is a correction for. `safePath`'s
   * own comment justified its silent widening with *"nothing user-reachable
   * produces these shapes"*, and item 10 broke that premise: the path now comes
   * out of a repository's own `status` output and is clicked by a user. A filename
   * beginning with `:` is legal on macOS and Linux and is refused as pathspec
   * magic.
   *
   * Same discipline as `unreadable` above — what we could not do goes in a field,
   * so no reader can mistake a wider answer for the narrow one it asked for.
   */
  filteredBy?: string;
  /** a path WAS asked for and we would not pass it, so this is the whole history */
  pathRefused?: boolean;
  commits: GitCommit[];
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
 * How long `log()` gets before it is KILLED (E24 Git v2 item 1).
 *
 * **BOUNDED, WHERE `status()` DELIBERATELY IS NOT, AND THE DIFFERENCE IS WHAT
 * THE TIMEOUT WOULD BE A LIE ABOUT.** Killing `status` would report a repository
 * that is merely slow as one switchboard could not read — a claim about the
 * user's project. Killing `log` says "we could not read the history within 15
 * seconds", which is true, specific, and leaves the rest of the card working.
 *
 * ⚠️ **GENEROUS BECAUSE `--shortstat` TURNED OUT TO COST FAR MORE THAN EXPECTED.**
 * Measured on this repository (941 commits, essay-length bodies, Windows 11 with
 * Defender): **100 commits with the stats took 1,331 ms and without them 64 ms**,
 * and the whole history with stats took 2,858 ms. That is ~13 ms per commit, and
 * it is why `DEFAULT_LOG_LIMIT` is 50 and why the stats are a query option at
 * all — see `STATS_FLAGS` in `git-log.ts` for the table. Fifteen seconds is five
 * times the slowest full-history read measured, and is reached by a disk that has
 * stopped answering rather than by a big repository.
 */
export const LOG_BUDGET_MS = 15_000;

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

/**
 * How long the two `--numstat` reads get, counted from when THEY start.
 *
 * Not a slice of the guard's budget: that one is set before the status read, which
 * is deliberately unbounded, so by the time the stats run there may be nothing
 * left of it. Generous because this is the "something is badly wrong" bound and
 * not a latency target — two diffs of a working tree are the same work `diff()`
 * budgets at 10 s.
 */
const STATS_BUDGET_MS = 10_000;

/**
 * How long a WRITE gets — all its invocations together.
 *
 * Longer than a read's because the work is different in kind: `add` hashes file
 * contents into the object store and `clean` deletes from disk, both of which can
 * be slow on a big batch or a slow volume, where a `status` is mostly reading an
 * index. Still bounded, for the reason every budget in this file is bounded: a git
 * that never finishes must not become a surface that never answers.
 */
export const WRITE_BUDGET_MS = 30_000;

/**
 * The answer when a `--numstat` read did not succeed.
 *
 * Frozen and shared: a failure here costs the NUMBERS and never the file list
 * (see `status`'s own note), so this is reached on the fail-open path and must not
 * be something a caller could write into.
 */
const EMPTY_NUMSTATS: ReadonlyMap<string, never> = new Map<string, never>();

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

/**
 * What one invocation needs beyond its arguments.
 *
 * An options object rather than two more positionals: `git(cmd, folder, args,
 * ms, env)` was already at the limit of what a reader can keep straight, and
 * `input` and `guard` are both things exactly one caller uses.
 */
interface GitOpts {
  /**
   * Written to git's stdin, then closed.
   *
   * ⚠️ **THIS IS HOW A COMMIT MESSAGE TRAVELS, AND THE DESIGN RECORD SAYS
   * SO FOR A MEASURED REASON** (§2.1): *"Commit messages go in on stdin
   * (`commit --file=-`), never `-m`. A multi-line body with quotes in it is a
   * Windows quoting bug waiting to happen."* Measured through this path: a body
   * containing double quotes, a `$`, a `%` and several lines arrives byte-exact.
   */
  input?: string;
  /** see `GuardOpts` — `{ hooks: 'allow' }` is for `commit` and nothing else */
  guard?: GuardOpts;
}

function git(
  command: GitCommand,
  folder: string,
  args: string[],
  timeoutMs = 0,
  env?: NodeJS.ProcessEnv,
  opts: GitOpts = {}
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
        [...command.prefixArgs, ...guardArgs(opts.guard), ...args],
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
      trackChild('git', child); // the #719 heartbeat's own-children count
      /**
       * ⚠️ **THE MESSAGE GOES IN ON STDIN, AND THE PIPE IS CLOSED EVEN IF THE
       * WRITE FAILS.** `commit --file=-` reads until EOF, so a stdin left open is
       * a git that waits for ever — which our own budget would then kill and
       * report as a timeout, i.e. a bug that looks like a slow disk.
       *
       * `error` is swallowed deliberately: an EPIPE here means git has already
       * gone (it refused before reading, which is what an empty message does),
       * and that failure is reported through the exit code and stderr like every
       * other. An unhandled `error` on a stdin stream, by contrast, takes the
       * whole main process down.
       */
      if (opts.input !== undefined && child.stdin) {
        child.stdin.on('error', () => undefined);
        child.stdin.end(opts.input);
      }
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
    env?: NodeJS.ProcessEnv,
    opts?: GitOpts
  ): Promise<GitRun> {
    return git(this.command, folder, args, timeoutMs, env, opts);
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
  async status(
    folder: string,
    guardBudgetMs = GUARD_BUDGET_MS,
    /**
     * Also read the per-file `+/−` (E24 Git v2 item 7).
     *
     * ⚠️ **OPT-IN, AND THE REASON IS THE POLL.** `status()` is called for every
     * card, repeatedly, to draw the header's changed-count badge — and that
     * surface shows no numbers at all. Two extra `git diff` invocations per poll
     * per card, for a figure nobody is looking at, is the cost shape #719 is a
     * standing warning about. The Changes tab asks; the badge does not. Same
     * discipline as `GitLogQuery.stats`, and for the same measured reason.
     */
    withStats = false
  ): Promise<GitStatus> {
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
      [
        '-c',
        'core.quotePath=off',
        // ⚠️ **PINNED, BECAUSE THE OTHER SIDE OF THE MATCH DEPENDS ON IT (E24 Git
        // v2 item 7, found in review).** `status.relativePaths` defaults to true
        // and is repo-writable; `--numstat --relative` is pinned to agree with
        // that default. If a repository flipped this, every per-file `+/−` would
        // silently stop matching its row — see `numstatArgs` for the measurement.
        '-c',
        'status.relativePaths=true',
        'status',
        '--porcelain=v2',
        '--branch',
        '--untracked-files=all',
      ],
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
    if (withStats) {
      // ⚠️ **THE SAME `guard.env` THE STATUS READ USED.** `--numstat` diffs the
      // WORKING TREE, so unlike `log --shortstat` it really does run a
      // repo-configured filter driver — measured in #776 for `diff-index`, and
      // this is the same machinery. Reusing the env the guard already built is
      // also what keeps this to two extra invocations rather than two plus
      // another config enumeration.
      //
      // ⚠️ **AND A FAILURE HERE COSTS THE NUMBERS, NEVER THE LIST.** `status` is
      // the answer; these are a decoration on it. Reporting `unreadable` for a
      // diff that did not run would blank a file list we had already read
      // successfully — the fail-open rule pointing the opposite way from where it
      // points on the status read itself.
      // ⚠️ **THEIR OWN BUDGET, BECAUSE THE GUARD'S WAS ALREADY SPENT (found in
      // review).** `deadline` is set before the status read, and that read is
      // deliberately UNBOUNDED — see `status`'s own note about not reporting a
      // merely-slow repository as unreadable. So on exactly the repository that
      // note exists for, `deadline - Date.now()` is negative by the time we get
      // here and `Math.max(1, …)` turned "no budget left" into a 1 ms timeout: a
      // guaranteed failure dressed up as an attempt.
      const statsDeadline = Date.now() + STATS_BUDGET_MS;
      const left = (): number => Math.max(1, statsDeadline - Date.now());
      const [unstaged, staged] = await Promise.all([
        this.run(folder, numstatArgs('unstaged'), left(), guard.env),
        this.run(folder, numstatArgs('staged'), left(), guard.env),
      ]);
      // `EMPTY_NUMSTATS` rather than `new Map()` inline: a bare `new Map()` is
      // `Map<any, any>` to the linter, and silencing that with a cast would be a
      // cast on the exact value whose emptiness means "the read failed".
      status.stats = mergeNumstats(
        unstaged.ok ? parseNumstat(unstaged.out) : EMPTY_NUMSTATS,
        staged.ok ? parseNumstat(staged.out) : EMPTY_NUMSTATS
      );
    }
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
      } else if (line.startsWith('u ')) {
        // ⚠️ **AN UNMERGED ENTRY, AND UNTIL NOW IT WAS DROPPED ON THE FLOOR (E24
        // Git v2 item 6).** porcelain v2 reports a conflict on its own `u ` line,
        // not as a `1 ` or `2 `, and this parser only ever matched those two and
        // `? ` — so **a file in a merge conflict was invisible in the Changes
        // tab**: not listed, not counted in the header badge, nothing. The one
        // moment a user most needs to see which files are in trouble.
        //
        // The shape, measured: `u UU N... <m1> <m2> <m3> <mW> <h1> <h2> <h3>
        // <path>` — ten fields before the path, where an ordinary entry has eight.
        // The path is joined back rather than taken as one field because a path
        // may contain spaces and `core.quotePath=off` means it arrives literal.
        const parts = line.split(' ');
        const xy = parts[1];
        const p = parts.slice(10).join(' ');
        if (p) {
          status.files.push({
            path: p,
            xy,
            // ⚠️ **BOTH SIDES TRUE, AND NEITHER IS A GUESS.** A conflicted file
            // has content in the index AND differs from it in the worktree —
            // that is what a conflict IS — so every existing consumer that asks
            // "is this staged" or "is this changed" gets `true`, which is the
            // honest answer. `conflicted` is what tells the sidebar to put it in
            // the Merge group rather than in both of the others.
            staged: true,
            unstaged: true,
            untracked: false,
            conflicted: true,
          });
        }
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

  /**
   * The commit history (E24 Git v2 item 1, §5.7) — **the thing two documents
   * said had shipped and no code contained.**
   *
   * The command shape and the parser are in `git-log.ts`, where they are pure
   * and tested against fixture bytes. This method is the part that cannot be:
   * running git, and deciding what every way it can fail means.
   *
   * ⚠️ **NO CONFIG GUARD, AND THAT IS MEASURED RATHER THAN ASSUMED.** `status()`
   * and `diff()` both pay `guardEnv()` — a config read, a submodule enumeration,
   * several extra git invocations — because both were measured to run a
   * repo-configured filter driver (#776). `log --shortstat` was measured NOT to:
   * with `diff.external`, with a `.gitattributes`-selected `textconv` driver and
   * with `filter.<n>.clean` all configured, **none of the three ran**, because
   * `--shortstat` uses git's internal diffstat machinery and never materialises a
   * blob through a driver. So `log` joins `root()` and `fileVersions()` as a read
   * that carries only `guardArgs()` — `core.fsmonitor=false` and an empty
   * `core.hooksPath`, which every invocation in this file gets.
   *
   * That is not a free pass for the next person: the moment somebody adds `-p` or
   * `--numstat` to this command the measurement no longer applies and the guard
   * is needed. `LOG_FLAGS` says so where the flags are.
   *
   * ⚠️ **AN UNBORN HEAD IS A FACT AND IS REPORTED AS ONE.** See `GitLog.unborn`:
   * with the explicit `HEAD` that `logArgs` always passes, git says `bad
   * revision 'HEAD'`, which is also what a typo'd ref says. The distinction is
   * made by asking `rev-parse`, not by reading the message.
   */
  /**
   * ⚠️ **ONE WRAPPER, SO NO RETURN PATH CAN FORGET TO SAY WHAT IT FILTERED BY.**
   * `log` answers from eight places (not a repo, unreadable, timeout, too large,
   * unborn, read-but-unparseable, and two successes), and the field that matters
   * here — "is this really only one file's history?" — is a property of the QUERY
   * rather than of the outcome. Spreading it over the finished answer is why a
   * refused path cannot come back looking like an applied one; adding it to each
   * `return` individually is the version of this that goes stale on the ninth.
   */
  async log(folder: string, query: GitLogQuery = {}, budgetMs = LOG_BUDGET_MS): Promise<GitLog> {
    const applied = appliedPath(query);
    const filter: Pick<GitLog, 'filteredBy' | 'pathRefused'> =
      applied === null
        ? {}
        : 'refused' in applied
          ? { pathRefused: true }
          : { filteredBy: applied.path };
    return { ...(await this.readLog(folder, query, budgetMs)), ...filter };
  }

  private async readLog(
    folder: string,
    query: GitLogQuery = {},
    budgetMs = LOG_BUDGET_MS
  ): Promise<GitLog> {
    const deadline = Date.now() + budgetMs;
    const left = (): number => Math.max(1, deadline - Date.now());

    // The same probe `status()` and `diff()` open with, and the same three-way
    // reading of it: a folder that is honestly not a repository says so plainly,
    // and everything else carries git's own reason.
    const probe = await this.run(folder, ['rev-parse', '--is-inside-work-tree'], left());
    if (probe.failure === 'timeout') return { isRepo: false, unreadable: logTimedOut(budgetMs), commits: [] };
    if (probe.failure === 'no-exec') {
      return { isRepo: false, unreadable: await spawnReason(folder), commits: [] };
    }
    if (!probe.ok) {
      const said = gitSaid(probe.err);
      if (saysNotARepo(said)) return { isRepo: false, commits: [] };
      return {
        isRepo: false,
        unreadable: said ?? 'git could not tell whether this folder is a repository',
        commits: [],
      };
    }
    // A bare repository or the inside of a `.git` directory: a clean answer, and
    // not a failure. It has a history, but no working tree to show it beside.
    if (!probe.out.trim().startsWith('true')) return { isRepo: false, commits: [] };

    const r = await this.run(folder, logArgs(query), left());
    if (r.ok) {
      const commits = parseLog(r.out);
      // ⚠️ **OUTPUT WE COULD NOT READ IS NOT AN EMPTY HISTORY (found in review,
      // measured).** `--encoding=UTF-8` closes the one way a repository was shown
      // to re-frame this stream — `i18n.logOutputEncoding = UTF-16LE`, which puts
      // a NUL after every byte and makes the parser find no record anywhere — and
      // this is the belt for the next shape of the same trick. git exits 0, so
      // without it the History tab draws **"this project has no commits yet"** for
      // a repository with a thousand of them: a confident wrong answer about the
      // user's project, which is precisely what this service keeps being corrected
      // for. Empty output IS an empty answer (`--skip` past the end), so the test
      // is output-without-commits, not commits-without-output.
      if (commits.length === 0 && r.out.trim() !== '') {
        return {
          isRepo: true,
          unreadable:
            'git produced a history switchboard could not read — the repository may be ' +
            'configured to write its log in an unusual encoding',
          commits: [],
        };
      }
      return { isRepo: true, commits };
    }

    if (r.failure === 'timeout') return { isRepo: true, unreadable: logTimedOut(budgetMs), commits: [] };
    if (r.failure === 'no-exec') return { isRepo: true, unreadable: await spawnReason(folder), commits: [] };
    if (r.failure === 'too-large') {
      return {
        isRepo: true,
        unreadable:
          `the history is larger than the ${MAX_GIT_OUTPUT / 1024 / 1024} MB switchboard reads in ` +
          'one go — ask for fewer commits',
        commits: [],
      };
    }
    // ONLY NOW, and only on a failure, is the unborn question asked. Putting it
    // before the log would cost every successful read an extra git process for a
    // case that happens once in a repository's life.
    //
    // ⚠️ **TWO PROBES, BECAUSE ONE OF THEM ANSWERS THE WRONG QUESTION (found in
    // review, measured).** `rev-parse --verify -q HEAD` failing was the whole test
    // here, and it fails for more than an unborn HEAD. Measured on a repository
    // with one commit and a **zero-byte `.git/refs/heads/main`** — the classic
    // post-crash corruption, and a file an edit-only agent can write:
    //
    // | probe | fresh `git init` | corrupt ref |
    // |---|---|---|
    // | `rev-parse --verify -q HEAD` | exit 1 | exit 1 |
    // | `symbolic-ref -q HEAD` | **exit 0**, `refs/heads/main` | **exit 128**, `No such ref: HEAD` |
    //
    // So the first probe alone reported a damaged repository as a brand-new one,
    // which is the same shape of confident wrong answer as the `isRepo` lie #785
    // was filed for. Unborn is the CONJUNCTION: HEAD does not resolve **and** HEAD
    // is still a symbolic ref pointing somewhere. The `failure === 'failed'` guard
    // stays as well — a timeout or an unstartable git says nothing about whether
    // there are commits.
    const head = await this.run(folder, ['rev-parse', '--verify', '-q', 'HEAD'], left());
    if (!head.ok && head.failure === 'failed') {
      const symbolic = await this.run(folder, ['symbolic-ref', '-q', 'HEAD'], left());
      if (symbolic.ok) return { isRepo: true, unborn: true, commits: [] };
    }
    return {
      isRepo: true,
      unreadable: gitSaid(r.err) ?? 'git could not read this repository’s history',
      commits: [],
    };
  }

  /**
   * What one commit changed (E24 Git v2 item 4, §5.7) — screen 7's file list.
   *
   * ⚠️ **TWO READS, BECAUSE THE DESIGN RECORD'S ONE COMMAND CANNOT WORK.** It asks
   * for `diff --numstat --name-status`; measured, `--name-status` wins in either
   * order and the numbers are gone. See `git-commit-files.ts` for the bytes.
   *
   * ⚠️ **AND THE ROOT COMMIT IS THE CASE THAT FAILS SILENTLY** — it has no parent,
   * so `diffBaseFor` substitutes git's empty tree. Without that the repository's
   * first commit shows an EMPTY file list with no error anywhere, which is the
   * single most likely wrong answer this method can give.
   *
   * No #776 config guard of its own: `diff <rev> <rev>` is commit-to-commit, the
   * same ground `log --shortstat` was measured on, and it never materialises a
   * blob through a filter. `guardArgs()` rides on every invocation as always.
   */
  async commitFiles(
    folder: string,
    commit: { id: string; parentIds: string[] },
    budgetMs = DIFF_BUDGET_MS
  ): Promise<{ files: CommitFile[]; unreadable?: string }> {
    const deadline = Date.now() + budgetMs;
    const left = (): number => Math.max(1, deadline - Date.now());
    const base = diffBaseFor(commit);
    const [letters, numbers] = await Promise.all([
      this.run(folder, nameStatusArgs(base, commit.id), left()),
      this.run(folder, numstatArgs({ left: base, right: commit.id }), left()),
    ]);
    // ⚠️ THE LETTERS ARE THE ANSWER AND THE NUMBERS ARE A DECORATION. A failed
    // name-status means we do not know what the commit touched, which is the
    // question — so that one is reported. A failed numstat costs the `+/−` and
    // leaves the list, the same asymmetry `status`'s stats read has.
    if (!letters.ok) {
      const why =
        letters.failure === 'timeout'
          ? `git did not finish reading that commit within ${Math.round(budgetMs / 1000)}s`
          : letters.failure === 'no-exec'
            ? await spawnReason(folder)
            : (gitSaid(letters.err) ?? 'git could not read that commit');
      return { files: [], unreadable: why };
    }
    return {
      files: mergeCommitFiles(
        parseNameStatus(letters.out),
        numbers.ok ? parseNumstat(numbers.out) : EMPTY_NUMSTATS
      ),
    };
  }

  /**
   * Two sides of one file at two revisions (E24 Git v2 item 4, §5.7).
   *
   * The `fileVersions` twin for a COMMIT rather than for the working tree, and the
   * one thing item 5's diff panel needed before it could honestly show a commit —
   * until now it said "coming", because `fileVersions` answers HEAD-vs-disk and
   * nothing else.
   *
   * ⚠️ **A MISSING SIDE IS AN EMPTY STRING AND THAT IS CORRECT.** A file added in
   * this commit does not exist at `left`, and a file deleted in it does not exist
   * at `right` — `git show` fails for each, and empty is exactly what Monaco needs
   * to render an addition or a deletion. Which is also why a failure here cannot
   * be distinguished from an absence, and why neither is reported as an error: the
   * `name-status` letter beside it already says which it is.
   */
  async fileVersionsAt(
    folder: string,
    file: string,
    left: string,
    right: string
  ): Promise<FileVersions> {
    const [before, after] = await Promise.all([
      this.run(folder, ['show', `${left}:${toGitPath(file)}`]),
      this.run(folder, ['show', `${right}:${toGitPath(file)}`]),
    ]);
    return { original: before.ok ? before.out : '', modified: after.ok ? after.out : '' };
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

  // ── THE WRITE HALF (E24 Git v2 item 12) ───────────────────────────────────
  //
  // ⚠️ **THESE ARE THE FIRST COMMANDS IN THIS SERVICE THAT CHANGE THE USER'S
  // REPOSITORY**, and three things are true of all of them:
  //
  //  * **They still carry every #776 guard.** A write runs through the same
  //    `run()` as a read, so `--literal-pathspecs`, the fsmonitor pin and the
  //    empty hooks path all apply. The threat model does not soften because we
  //    asked for a change rather than for an answer — if anything a repository
  //    that can make `status` run a program can make `add` run one too.
  //  * **They report git's own words on failure.** A repository can refuse for
  //    reasons nobody has enumerated — an index lock another agent is holding, an
  //    unmerged path, a permission, a hook. Inventing a sentence for those would
  //    make switchboard the authority on something git decided.
  //  * **They are batched**, because a command line has a length limit and
  //    Windows' is the small one. See `MAX_PATHS_PER_CALL`.

  /** Stage these paths. */
  async stage(folder: string, paths: readonly string[], budgetMs = WRITE_BUDGET_MS): Promise<GitWriteResult> {
    return this.writeBatched(folder, paths, stageArgs, budgetMs);
  }

  /** Unstage these paths — the exact undo of `stage`. */
  async unstage(folder: string, paths: readonly string[], budgetMs = WRITE_BUDGET_MS): Promise<GitWriteResult> {
    return this.writeBatched(folder, paths, unstageArgs, budgetMs);
  }

  /**
   * Throw away the working-tree changes to these paths.
   *
   * ⚠️ **THE ONE DESTRUCTIVE OPERATION, AND IT IS TWO COMMANDS BECAUSE GIT MADE
   * IT TWO.** Measured: `git restore` refuses an untracked path outright, so a
   * mixed batch fails entirely — the classification is not an optimisation, it is
   * the only way the operation works at all.
   *
   * ⚠️ **AND THE CLASSIFICATION COMES FROM A FRESH `status` HERE, NOT FROM THE
   * RENDERER.** Otherwise main would be deleting files on the renderer's word
   * about which ones are untracked — and that word is a moment old, so a file
   * committed since the list was drawn would be `clean`ed while it is in git.
   */
  async discard(
    folder: string,
    paths: readonly string[],
    budgetMs = WRITE_BUDGET_MS
  ): Promise<GitWriteResult> {
    const safe = writePaths(paths);
    if (!Array.isArray(safe)) return safe;
    const deadline = Date.now() + budgetMs;
    const left = (): number => Math.max(1, deadline - Date.now());
    const now = await this.status(folder, left());
    if (now.unreadable) return refused(now.unreadable);
    if (!now.isRepo) return refused('that folder is not a git repository');
    const plan = planDiscard(safe, now.files);
    // ⚠️ **A CONFLICT REFUSES THE WHOLE REQUEST RATHER THAN BEING SKIPPED.**
    // "Discard this conflict" has three meanings and git has a command for each;
    // silently doing the other files and saying nothing about this one would be a
    // partial destructive operation the user was not told about.
    if (plan.conflicted.length > 0) {
      return refused(
        `switchboard will not discard a file that is in a merge conflict ` +
          `(${plan.conflicted.join(', ')}) — resolve it, or use git to choose a side`
      );
    }
    let applied = 0;
    if (plan.tracked.length > 0) {
      const r = await this.writeBatched(folder, plan.tracked, discardTrackedArgs, left());
      if (!r.ok) return r;
      applied += r.applied;
    }
    if (plan.untracked.length > 0) {
      const r = await this.writeBatched(folder, plan.untracked, discardUntrackedArgs, left());
      // ⚠️ THE TRACKED HALF ALREADY HAPPENED, so the count is reported even on a
      // failure of the second half. A result that said `applied: 0` after
      // restoring six files would send the user looking for changes that are gone.
      if (!r.ok) return { ok: false, reason: r.reason, applied };
      applied += r.applied;
    }
    // Paths that are in the request and not in the status are DROPPED silently
    // only in the sense that they needed nothing done: a file that is already
    // clean is the state a discard was asking for. Counting them would overstate
    // what happened.
    return { ok: true, applied };
  }

  /**
   * Make a commit (E24 Git v2 item 13).
   *
   * ⚠️ **THE MESSAGE GOES IN ON STDIN**, never on argv — see `git-commit.ts` and
   * the design record §2.1 for the Windows quoting trap that decided it.
   *
   * ⚠️⚠️ **AND `guard: { hooks: 'allow' }` IS THE DELIBERATE PART.** This is the
   * only call in the service that lifts any #776 guard, and the argument is in
   * `GuardOpts`: a guard that exists because we read a repository UNBIDDEN does
   * not apply to a button the user pressed, and a commit that silently skipped
   * their own `pre-commit` would be switchboard reimplementing `git commit`.
   * Everything else stays on — including the filter-driver neutralisation, which
   * is safe to keep because it only disarms REPO-AUTHORED driver keys and leaves
   * a user's global git-lfs working.
   */
  async commit(
    folder: string,
    message: unknown,
    opts: CommitOptions = {},
    budgetMs = COMMIT_BUDGET_MS
  ): Promise<GitWriteResult> {
    if (!isCommittableMessage(message)) return emptyMessageRefusal();
    const deadline = Date.now() + budgetMs;
    const guard = await this.guardEnv(folder, () => Math.max(1, deadline - Date.now()));
    if (!guard.env) return refused(guard.reason ?? 'switchboard could not make git safe to run here');
    const r = await this.run(
      folder,
      commitArgs(opts),
      Math.max(1, deadline - Date.now()),
      guard.env,
      { input: message, guard: { hooks: 'allow' } }
    );
    if (r.ok) return { ok: true, applied: 1 };
    if (r.failure === 'timeout') {
      return refused(
        `git did not finish committing within ${Math.round(budgetMs / 1000)}s — a ` +
          'pre-commit hook may still be running'
      );
    }
    if (r.failure === 'no-exec') return refused('switchboard could not run git here');
    return refused(commitRefusal(r.err, r.out));
  }

  /**
   * Run one write over however many invocations the path count needs.
   *
   * The batching is here rather than in each verb so that "how many paths fit on
   * a command line" is answered once — and so a new verb cannot forget it.
   */
  private async writeBatched(
    folder: string,
    paths: readonly string[],
    toArgs: (batch: readonly string[]) => string[],
    budgetMs: number
  ): Promise<GitWriteResult> {
    const safe = writePaths(paths);
    if (!Array.isArray(safe)) return safe;
    const deadline = Date.now() + budgetMs;
    /**
     * ⚠️ **`guardEnv` IS LOAD-BEARING HERE AND THE FIRST VERSION OF THIS METHOD
     * DID NOT HAVE IT — a #776 hole, found by the test written to prove the
     * opposite.**
     *
     * `guardArgs()` rides on every invocation through `run()`, so the fsmonitor
     * pin and the empty hooks path were already covered. The FILTER DRIVERS are
     * not: they are neutralised by `guardEnv`, which a caller has to ask for, and
     * `status` and `diff` were the only two that did. Measured on a real
     * repository: with `filter.evil.clean` in its own config and one line in
     * `.gitattributes`, `git add` ran the program — and `add` is the command that
     * most certainly reads file CONTENTS through a filter, because hashing them
     * into the object store is its whole job.
     *
     * So the threat model does not soften for a write; if anything this is the
     * commandment #776 was really about. A guard that cannot be established
     * refuses the write, which is the same posture `status` takes.
     */
    const guard = await this.guardEnv(folder, () => Math.max(1, deadline - Date.now()));
    if (!guard.env) return refused(guard.reason ?? 'switchboard could not make git safe to run here');
    let applied = 0;
    for (const batch of batchPaths(safe)) {
      const r = await this.run(folder, toArgs(batch), Math.max(1, deadline - Date.now()), guard.env);
      if (!r.ok) {
        // git's own words, trimmed. `applied` carries what the EARLIER batches
        // did, because they really did happen — a half-done write that reported
        // zero would be worse than one that reports what it managed.
        const said = r.err.trim().split('\n')[0] ?? '';
        return {
          ok: false,
          reason: said !== '' ? said : writeFailed(r.failure, budgetMs),
          applied,
        };
      }
      applied += batch.length;
    }
    return { ok: true, applied };
  }
}

/** What to say when git failed and said nothing we can quote. */
function writeFailed(failure: GitFailure | null, budgetMs: number): string {
  if (failure === 'timeout') {
    return `git did not finish within ${Math.round(budgetMs / 1000)}s`;
  }
  if (failure === 'no-exec') return 'switchboard could not run git here';
  return 'git refused, and said nothing switchboard could pass on';
}

function toGitPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * The one sentence `log()` says about a timeout — in one place, because it is
 * reachable from three branches and three copies would drift.
 *
 * It names the likely cause rather than only the fact. "git did not finish" sends
 * nobody anywhere; "the repository may be very large, or its disk slow to
 * respond" is the same hedge `diff()` settled on, and the paging that fixes the
 * first half is right there in the tab.
 */
function logTimedOut(budgetMs: number): string {
  return (
    `git did not finish reading the history within ${Math.round(budgetMs / 1000)}s ` +
    '(the repository may be very large, or its disk slow to respond)'
  );
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
