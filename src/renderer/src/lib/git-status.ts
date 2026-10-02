// The renderer's view of `GitService.status` (#785).
//
// One DTO, where there used to be three near-copies — `DiffPane` declared its
// own, `GitContext` exported another, and `SessionGrid` imported the second to
// hold the result of the same IPC call. They drifted (only one carried `xy`,
// only one carried `ahead`), and a third state added to main would have had to
// be remembered in each of them.

/**
 * `git:status`' answer, as it crosses the wire.
 *
 * ⚠️ This is a BRAND, not a validation. `git:status` is declared
 * `Promise<unknown>` and the cast at each call site is the only thing between
 * the pipe and a typed record — which is why every consumer runs `answered()`
 * first and treats a missing field as "learn nothing" rather than as a value.
 */
export interface GitStatusDto {
  isRepo: boolean;
  /** see `GitStatus.unreadable` in main: present ONLY when switchboard could
   *  not find out, so `isRepo: false` alone still means "not a repository" */
  unreadable?: string;
  branch?: string;
  ahead?: number;
  behind?: number;
  files: GitFileDto[];
  /**
   * Per-file `+/−`, keyed by the same path `files` uses (E24 Git v2 item 7).
   *
   * ⚠️ ABSENT is not EMPTY: `undefined` means the caller did not ask (the card
   * header's poll does not, because it draws no numbers), `{}` means it asked and
   * nothing has changed. See `GitStatus.stats` in main for why the numbers ride on
   * the status answer rather than on a channel of their own.
   */
  stats?: Record<string, GitFileStatsDto>;
}

export interface GitFileStatsDto {
  /** working tree vs index */
  unstaged?: { insertions: number; deletions: number; binary?: boolean };
  /** index vs HEAD */
  staged?: { insertions: number; deletions: number; binary?: boolean };
}

export interface GitFileDto {
  path: string;
  /** porcelain XY, e.g. "M.", ".M", "??", "UU" — absent on the card-header path,
   *  which never reads it */
  xy?: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  /**
   * In a merge conflict (E24 Git v2 item 6).
   *
   * ⚠️ Both `staged` and `unstaged` are ALSO true on a conflict — that is what a
   * conflict is — so this is what tells the sidebar to draw the row in the Merge
   * group rather than in both of the others. Conflicted files were not reported at
   * all until that item; see `GitFileStatus.conflicted` in main.
   */
  conflicted?: boolean;
}

/**
 * What the Changes tab's file list should SAY, as one decision rather than
 * three conditions in JSX.
 *
 * ⚠️ **`unreadable` HAS TO WIN, AND THE REASON IS `clean` (#785).** An
 * unreadable answer carries `files: []` and, on the guard and status branches,
 * `isRepo: true` — which is exactly the shape of a repository with nothing
 * uncommitted. Rendered in the old order the pane would have greeted a damaged
 * repository with **"Working tree clean"**: a worse lie than the "Not a git
 * repository" this change is here to remove, and one the change itself would
 * have introduced.
 *
 * Pure, and exported, because the alternative is testing these three branches
 * through a component that instantiates Monaco.
 */
export type GitPaneState =
  | { kind: 'unreadable'; reason: string }
  | { kind: 'not-repo' }
  | { kind: 'clean' }
  | { kind: 'files' };

export function gitPaneState(status: GitStatusDto | null | undefined): GitPaneState | null {
  // Nothing has been learned yet (first mount, or a refusal the caller chose
  // not to apply): an empty pane, which says nothing about the working tree.
  if (!status) return null;
  if (status.unreadable) return { kind: 'unreadable', reason: status.unreadable };
  if (!status.isRepo) return { kind: 'not-repo' };
  return status.files.length === 0 ? { kind: 'clean' } : { kind: 'files' };
}
