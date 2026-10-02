// The renderer's view of `GitService.log` (E24 Git v2 item 2, §5.7).
//
// Modelled on `lib/git-status.ts`, deliberately and to the letter: one DTO, one
// pure state decision, both exported so the three branches can be tested without
// instantiating a pane. That file's header records what happens otherwise — three
// near-copies of a DTO that drifted until only one of them carried `ahead`.
//
// Everything here is PURE. No React, no bridge, no `window`.

/**
 * How many commits one page is.
 *
 * Matches main's own `DEFAULT_LOG_LIMIT`, and the number is measured rather than
 * chosen: `--shortstat` costs ~13 ms per commit, so fifty is about 650 ms and a
 * hundred would be 1.3 s of a spinner on a tab you just clicked.
 *
 * ⚠️ **IT LIVES IN THIS `.ts` MODULE RATHER THAN BESIDE THE COMPONENT, AND THE
 * REASON IS A TSCONFIG.** `tsconfig.node.json` sets no `--jsx`, so main's test
 * suite cannot import a `.tsx` at all — and the test that pins these two against
 * main's own constants is in `main/git/git-log.test.ts`, because that is the only
 * side that can see both. Two files remembering the same number is exactly the
 * shape that drifts, and the comment claiming a test for it came before the test
 * did (found in review).
 */
export const HISTORY_PAGE = 50;

/**
 * The most history the History tab will hold — mirrors main's `MAX_LOG_LIMIT`.
 *
 * Pinned against it by the same test, and the tab SAYS when it gets here: without
 * that, the last click returned the same two thousand rows and the button vanished
 * with no explanation, which reads as a bug in the button.
 */
export const MAX_HISTORY = 2_000;

/**
 * `git:log`'s answer, as it crosses the wire.
 *
 * ⚠️ This is a BRAND, not a validation — the same caveat `GitStatusDto` carries.
 * `git:log` is declared `Promise<unknown>` because a channel can answer with a
 * refusal instead of its payload, so every consumer runs `answered()` first and
 * treats a missing field as "learn nothing" rather than as a value.
 */
export interface GitLogDto {
  isRepo: boolean;
  /** see `GitStatus.unreadable` in main — present ONLY when we could not find out */
  unreadable?: string;
  /** this repository has no commits yet: a fact, not a failure */
  unborn?: boolean;
  /**
   * The path this reading was ACTUALLY filtered by (see `GitLog.filteredBy`).
   *
   * ⚠️ **THE CHIP IS DRAWN FROM THIS, NOT FROM THE REQUEST (found in review).**
   * Drawing it from what was asked for meant a path main would not pass produced
   * the WHOLE history under a chip naming one file — worse than an empty list,
   * because it is a confident wrong answer about the user's project rather than a
   * missing one.
   */
  filteredBy?: string;
  /** a path was asked for and main would not pass it, so this is everything */
  pathRefused?: boolean;
  commits: GitCommitDto[];
}

export interface GitCommitDto {
  id: string;
  parentIds: string[];
  displayId: string;
  subject: string;
  message: string;
  author: string;
  authorEmail: string;
  /** author date, seconds since epoch — `null` when git printed none (see main) */
  timestamp: number | null;
  committedTimestamp: number | null;
  /** `null` when git printed no diffstat — an empty commit, or stats not asked for */
  stats: { files: number; insertions: number; deletions: number } | null;
  references: GitRefDto[];
}

/**
 * One file in a commit (E24 Git v2 item 4) — screen 7's expanded row.
 *
 * ⚠️ `insertions` and `deletions` are ZERO rather than absent when git had no
 * number — a pure mode change, or a numstat read that failed beside a
 * name-status that succeeded. The LETTER is the authority on what happened; the
 * numbers are a decoration, and `binary` is the one case where drawing them would
 * be a lie.
 */
export interface CommitFileDto {
  path: string;
  /** M A D R C T */
  letter: string;
  /** where it came from, for a rename or a copy */
  from?: string;
  insertions: number;
  deletions: number;
  binary?: boolean;
}

/** `git:commitFiles`' answer, as it crosses the wire. */
export interface CommitFilesDto {
  files: CommitFileDto[];
  /** why this is not a reading of the commit — the same discipline as `GitLog` */
  unreadable?: string;
}

export interface GitRefDto {
  kind: 'head' | 'branch' | 'remote' | 'tag' | 'other';
  name: string;
  full: string;
  isHead?: boolean;
}

/**
 * What the History tab should SAY, as one decision rather than five conditions
 * in JSX.
 *
 * ⚠️ **THE ORDER IS LOAD-BEARING AND IT IS THE SAME TRAP `gitPaneState` HAS.** An
 * unreadable answer carries `commits: []` and, on most branches, `isRepo: true` —
 * which is exactly the shape of a repository whose history we simply have not
 * fetched. Checked in the wrong order the tab greets a damaged repository with
 * **"No commits yet"**, which is a worse lie than saying nothing: it is a claim
 * about the user's project, and it is the specific claim this whole epic exists
 * to stop making. `unreadable` wins, then `unborn`, then `not-repo`.
 *
 * `loading` is distinct from `empty` for the same reason. A pane that has not
 * asked yet and a pane that asked and got nothing must not look the same, or the
 * first render of every History tab announces that the project has no history.
 */
export type HistoryPaneState =
  | { kind: 'loading' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'unborn' }
  | { kind: 'not-repo' }
  | { kind: 'commits' };

export function historyPaneState(log: GitLogDto | null | undefined): HistoryPaneState {
  if (!log) return { kind: 'loading' };
  if (log.unreadable) return { kind: 'unreadable', reason: log.unreadable };
  if (log.unborn) return { kind: 'unborn' };
  if (!log.isRepo) return { kind: 'not-repo' };
  return { kind: 'commits' };
}

/**
 * Does this commit match what the user typed?
 *
 * Matches the subject, the author name and the sha — the three things screen 6's
 * search box says it searches. **The whole message is NOT searched**, and that is
 * a decision rather than an omission: this repository's commit bodies are essays,
 * so a body search makes nearly every query match nearly every row, and a filter
 * that matches everything is indistinguishable from a filter that is broken.
 *
 * Case-insensitive, and the sha matches on a PREFIX because that is how a human
 * has a sha: copied from somewhere, usually abbreviated, sometimes longer than
 * the eight characters the row shows.
 */
export function commitMatches(commit: GitCommitDto, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  if (commit.subject.toLowerCase().includes(q)) return true;
  if (commit.author.toLowerCase().includes(q)) return true;
  if (commit.id.startsWith(q)) return true;
  // A ref name is the other thing a human has in hand — "which commit is v0.8.3".
  return commit.references.some((r) => r.name.toLowerCase().includes(q));
}

/**
 * How long ago, in the shortest honest form.
 *
 * ⚠️ **TAKES `now` RATHER THAN CALLING `Date.now()`, which is what makes it
 * testable at all.** A function that reads the clock itself can only be tested
 * against the clock, and a test that computes its own expected value from
 * `Date.now()` is asserting the implementation against itself.
 *
 * Units stop at days and then switch to a date. "427d" is not a unit anybody
 * reads as time; past a few weeks the actual date is the useful answer, and the
 * row has the space for it because `d` was always going to run out.
 */
export function relativeTime(timestampSeconds: number | null, now: number): string {
  // ⚠️ **A `NaN` GUARD IS NOT THE GUARD THIS NEEDS (found in review).** The first
  // version checked `Number.isFinite` and was proud of not rendering "NaNd" — but
  // the field that actually goes wrong is an EMPTY one, and `Number('')` is `0`,
  // which is a perfectly finite 1 January 1970. Main now sends `null` for that
  // case and this refuses anything non-positive as well, so neither layer is the
  // only thing standing between a missing date and a confident wrong one.
  if (timestampSeconds === null || !Number.isFinite(timestampSeconds) || timestampSeconds <= 0) {
    return '';
  }
  const seconds = Math.floor(now / 1000) - Math.floor(timestampSeconds);
  // A commit dated in the future is real — a wrong clock on another machine, or a
  // rebase — and "in 3 hours" is noise on a history row. Clamped to "now", which
  // is the nearest true thing.
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  // ⚠️ **LOCAL, NOT `toISOString()` (found in review).** UTC here and
  // `toLocaleString()` in the row's tooltip disagreed by a day for any commit
  // made near local midnight — the same row saying two different dates about one
  // commit, which is a small thing that destroys trust in the bigger numbers.
  return localDate(new Date(timestampSeconds * 1000));
}

/**
 * `YYYY-MM-DD` in the reader's own timezone.
 *
 * Built by hand rather than with `toLocaleDateString`, because the row needs a
 * fixed-width, sortable-looking string in a monospace column and a locale-ordered
 * date (`3/4/25`) is ambiguous between two readers of the same screen.
 */
function localDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The branch this history is of, read off the commits rather than asked for
 * separately.
 *
 * `%D` already tells us which ref `HEAD` points at, so a second `git` call for
 * the branch name would be a second source that could disagree with the rows
 * drawn beside it. Returns `undefined` for a detached HEAD, where there is no
 * branch — and the toolbar then shows the sha instead, because "no branch" and
 * "we do not know" must not look the same.
 */
export function currentBranch(commits: readonly GitCommitDto[]): string | undefined {
  for (const c of commits) {
    const head = c.references.find((r) => r.isHead && r.kind === 'branch');
    if (head) return head.name;
  }
  return undefined;
}

/**
 * Is `HEAD` detached, i.e. sitting on a commit rather than on a branch?
 *
 * The bare `HEAD` decoration is how git says so (`parseRefs` gives it
 * `kind: 'head'`). Worth surfacing because a detached HEAD is a state people get
 * into by accident and then cannot explain, and because every commit they make
 * there is one they can lose.
 */
export function isDetached(commits: readonly GitCommitDto[]): boolean {
  return commits.some((c) => c.references.some((r) => r.kind === 'head' && r.name === 'HEAD'));
}

/**
 * Ahead/behind, as the two rows screen 6 draws.
 *
 * Comes from `GitStatus` — `ahead` and `behind` are two fields it has always
 * carried and that, per the design record §1.2, **no consumer has ever read.**
 * This is the first.
 *
 * ⚠️ **`undefined` AND `0` ARE DIFFERENT AND BOTH ARE DRAWN AS NOTHING.** git
 * omits `# branch.ab` entirely when there is no upstream, so `undefined` means
 * "this branch tracks nothing" while `0` means "tracks something, and is level
 * with it". Neither draws a row — but a future surface that offers to set an
 * upstream needs the difference, so it is kept rather than collapsed here.
 */
export interface SyncCounts {
  ahead?: number;
  behind?: number;
  /** false when git reported no upstream at all */
  hasUpstream: boolean;
}

export function syncCounts(status: { ahead?: number; behind?: number } | null | undefined): SyncCounts {
  if (!status || (status.ahead === undefined && status.behind === undefined)) {
    return { hasUpstream: false };
  }
  return { ahead: status.ahead ?? 0, behind: status.behind ?? 0, hasUpstream: true };
}
