// The write half (E24 Git v2 item 12, §5.7) — stage, unstage, discard.
//
// ⚠️ **EVERY COMMAND HERE WAS MEASURED AGAINST REAL GIT BEFORE IT WAS WRITTEN,
// and two of the four findings changed the design.** The standing rule in this
// repository is never to guess a CLI contract, and it matters more here than
// anywhere else in the epic: these are the first commands switchboard runs that
// CHANGE a user's repository, and one of them destroys work.
//
// WHAT WAS MEASURED (git 2.51 on Windows, a repo with a modified file, a deleted
// file and an untracked file):
//
//  1. **`git add -- <path>` is enough for all three shapes.** It stages a
//     DELETION (`.D` → `D.`) and an untracked ADD (`?` → `A.`) as well as a
//     modification. No `-A` needed, and not using `-A` is the safer form: `-A`
//     with no pathspec would stage the whole tree, so a bug that dropped the
//     paths would stage everything instead of nothing.
//  2. **`git restore --staged -- <paths>` reverses all three**, returning the
//     untracked file to `?` and the deletion to `.D`. Symmetric with (1), which
//     is what makes "unstage" the exact undo of "stage".
//  3. **`git restore -- <path>` discards a modification AND brings back a
//     deleted file.** It restores the worktree from the INDEX, so a staged
//     change SURVIVES a discard of the working-tree change — which is the
//     correct meaning of discarding one row rather than the file.
//  4. ⚠️ **`git restore` REFUSES AN UNTRACKED PATH OUTRIGHT** — *"error: pathspec
//     'x' did not match any file(s) known to git"*, exit 1. So one `restore` for
//     a mixed batch fails ENTIRELY, and discard cannot be one command. It
//     classifies first and runs `clean -f` for the untracked ones.
//
// ⚠️ **AND `clean` IS DELIBERATELY WITHOUT `-d`.** Without it, `clean` cannot
// remove a DIRECTORY, only files it was named. Every path here comes from
// `status`, which lists files, so `-d` would buy nothing and would turn a bug in
// the path list into a recursive delete.
import type { GitFileStatus } from './git-service';
import { safeGitPaths } from './git-paths';

/** What a write did, or why it did not. */
export interface GitWriteResult {
  ok: boolean;
  /**
   * Why not — git's own words where we have them.
   *
   * ⚠️ **GIT'S WORDS, NOT OURS, AND THAT IS A RULE RATHER THAN LAZINESS.** A
   * repository can refuse for reasons we have not enumerated (a lock held by
   * another agent, a permission, an unmerged path, a hook). Inventing a sentence
   * for those would make switchboard the authority on something git decided, and
   * the user needs the real message to act on it.
   */
  reason?: string;
  /** how many paths it applied to, so the surface can say what happened */
  applied: number;
}

/** A refusal we can state without running anything. */
export function refused(reason: string): GitWriteResult {
  return { ok: false, reason, applied: 0 };
}

/**
 * Whatever came over the wire, as a list of strings.
 *
 * ⚠️ **AN UNKNOWN, BECAUSE IPC IS AN UNKNOWN (#650's discipline).** The renderer
 * is not a trusted source of shapes: a bad payload must become a refusal, not a
 * `TypeError` in the handler or — much worse — a `join` on something that is not
 * an array reaching argv. Non-strings and empties are dropped here so the only
 * thing `safeGitPaths` has to reason about is strings; an entirely bogus payload
 * comes out as `[]`, which `writePaths` refuses by name.
 */
export function asPathList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === 'string' && p !== '');
}

/**
 * Stage these paths.
 *
 * ⚠️ **`--` ALWAYS, AND NO `-A`.** See finding (1): plain `add` already covers
 * deletions and untracked files, and leaving `-A` out means a bug that lost the
 * path list stages NOTHING rather than the entire tree.
 */
export function stageArgs(paths: readonly string[]): string[] {
  return ['add', '--', ...paths];
}

/** Unstage these paths — the exact undo of `stageArgs`, per finding (2). */
export function unstageArgs(paths: readonly string[]): string[] {
  return ['restore', '--staged', '--', ...paths];
}

/**
 * Discard the working-tree change to these TRACKED paths.
 *
 * Restores from the index, so a staged change survives — finding (3), and the
 * correct meaning of discarding one row.
 */
export function discardTrackedArgs(paths: readonly string[]): string[] {
  return ['restore', '--', ...paths];
}

/**
 * Delete these UNTRACKED paths.
 *
 * ⚠️ **THE ONLY OPERATION IN SWITCHBOARD THAT DESTROYS WORK NO OTHER COPY OF
 * EXISTS.** A modified tracked file can always be brought back from the index or
 * from HEAD; an untracked file that is cleaned is gone. That asymmetry is why the
 * surface has to confirm and has to say the count, and why `-d` is absent.
 */
export function discardUntrackedArgs(paths: readonly string[]): string[] {
  return ['clean', '-f', '--', ...paths];
}

/** Which bucket a path falls in, for a discard. */
export interface DiscardPlan {
  tracked: string[];
  untracked: string[];
  /**
   * Paths we will not discard, and why.
   *
   * ⚠️ **A CONFLICTED PATH IS REFUSED RATHER THAN GUESSED AT.** "Discard this
   * conflict" has at least three meanings — take ours, take theirs, abandon the
   * merge — and git has a different command for each. Picking one silently would
   * be switchboard deciding something only the user can, on the one file where
   * being wrong costs the most. It is refused BY NAME so the message can say so.
   */
  conflicted: string[];
  /** a path that is in the request but not in the status at all */
  unknown: string[];
}

/**
 * Sort the requested paths into what each one needs.
 *
 * ⚠️ **CLASSIFIED FROM A FRESH `status` IN MAIN, NOT FROM WHAT THE RENDERER
 * SAID.** The renderer has a status and could hand over "these are untracked" —
 * and then main would be deleting files on the renderer's word. The status is
 * also a moment old by the time a click lands: a file that was untracked when the
 * list was drawn may have been committed since, and `clean` would then delete a
 * file that is in git. Re-reading costs one `status` on an operation the user had
 * to confirm anyway.
 */
export function planDiscard(
  paths: readonly string[],
  files: readonly GitFileStatus[]
): DiscardPlan {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const plan: DiscardPlan = { tracked: [], untracked: [], conflicted: [], unknown: [] };
  for (const path of paths) {
    const file = byPath.get(path);
    if (!file) plan.unknown.push(path);
    else if (file.conflicted) plan.conflicted.push(path);
    else if (file.untracked) plan.untracked.push(path);
    else plan.tracked.push(path);
  }
  return plan;
}

/**
 * The paths a write will be given, or a refusal.
 *
 * ⚠️ **ALL OR NOTHING** — `safeGitPaths`' own comment has the argument, and it is
 * sharpest for discard: a destructive operation that silently applied to five of
 * six named files is the worst outcome available here.
 */
export function writePaths(raw: readonly string[] | undefined): string[] | GitWriteResult {
  if (!raw || raw.length === 0) return refused('no files were named');
  const safe = safeGitPaths(raw);
  if (!safe) {
    return refused(
      'switchboard will not act on one of those paths — a path that leaves the ' +
        'session folder, or that git would read as a pattern rather than a name'
    );
  }
  return safe;
}

/**
 * How many paths one invocation may carry.
 *
 * ⚠️ **BECAUSE A COMMAND LINE HAS A LENGTH LIMIT AND WINDOWS' IS THE SMALL ONE**
 * (~32,767 characters for `CreateProcess`). A "stage all" on a generated-file
 * commit really can name thousands of paths, and the failure without this is git
 * never starting at all — reported as a spawn error, which reads like "git is not
 * installed". Batched, each invocation is well inside the limit.
 *
 * 200 at a path length of 150 characters is ~30 KB of argv, so the cap is on the
 * COUNT and deliberately conservative rather than a byte budget that would have
 * to be right about quoting.
 */
export const MAX_PATHS_PER_CALL = 200;

export function batchPaths(paths: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < paths.length; i += MAX_PATHS_PER_CALL) {
    out.push(paths.slice(i, i + MAX_PATHS_PER_CALL));
  }
  return out;
}
