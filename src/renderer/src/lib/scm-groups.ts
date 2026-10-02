// The source-control sidebar's shape (E24 Git v2 items 6 and 7, §5.7) — screen 1.
//
// ⚠️ **THIS IS THE OWNER'S "everything's kind of just smashed together", ANSWERED.**
// Design record §1.2 lists four causes in weight order, and the first two are
// decided entirely in this file:
//
//  1. **No resource groups.** Staged, unstaged, untracked and conflicted files
//     were ONE undifferentiated list, told apart only by a three-letter word chip
//     in 9px mono. `groupOf` is the fix, and the vocabulary is VS Code's
//     `scmResourceGroup` — `merge` / `index` / `workingTree` / `untracked` —
//     because that is the shape every git GUI uses and a new user can guess.
//  2. **The path truncated the wrong end.** Rows rendered the full relative path
//     with `text-overflow: ellipsis`, so in a 200px rail
//     `.../components/FeedView.tsx` and `.../FeedView.test.tsx` were the same
//     string. **The identifying part of a path is its tail**, and the rail cut
//     the tail off. `splitPath` is the fix: basename first, directory dimmed
//     after it, which is what reverses which end can be lost.
//
// Everything here is PURE — no React, no bridge, no clock — so the grouping and
// the letters are testable as rules rather than through a mounted component.
import type { GitFileDto, GitStatusDto } from './git-status';

/**
 * The four groups, in the order they are drawn.
 *
 * ⚠️ **MERGE FIRST, ALWAYS, AND IT IS NOT ALPHABETICAL.** A conflict is the only
 * thing in this list that BLOCKS you: nothing else can be committed until it is
 * resolved. Ordering it with the others would bury the one group that has to be
 * dealt with first — and conflicted files were not even listed until this item
 * (porcelain v2 puts them on a `u ` line, which the parser had never matched).
 */
export const SCM_GROUP_ORDER = ['merge', 'staged', 'unstaged', 'untracked'] as const;
export type ScmGroupKind = (typeof SCM_GROUP_ORDER)[number];

/** One row of the sidebar. */
export interface ScmRow {
  /** git's forward-slash relative path — the identity, and what a diff asks for */
  path: string;
  /** the basename: what the row leads with, so it can never be truncated away */
  name: string;
  /** the directory, with its trailing slash, drawn dimmed AFTER the name */
  dir: string;
  /** one letter: M A D R C U ? */
  letter: string;
  /** which group this row belongs to */
  group: ScmGroupKind;
  /** the file, for a caller that needs the raw flags */
  file: GitFileDto;
  /** `+/−` for this row, or `null` when there is nothing true to say */
  stat: { insertions: number; deletions: number; binary?: boolean } | null;
}

export interface ScmGroup {
  kind: ScmGroupKind;
  rows: ScmRow[];
}

/**
 * Split a path into the part that identifies it and the part that locates it.
 *
 * ⚠️ **THE BASENAME IS NEVER ALLOWED TO BE THE PART THAT GETS CUT**, which is
 * design §1.2 cause 2. Returns the directory WITH its trailing slash, because the
 * slash is what makes `src/main/git/` read as a place rather than as a name.
 */
export function splitPath(path: string): { name: string; dir: string } {
  const cut = path.lastIndexOf('/');
  if (cut === -1) return { name: path, dir: '' };
  return { name: path.slice(cut + 1), dir: path.slice(0, cut + 1) };
}

/**
 * Which group a file belongs to — and a file can be in TWO.
 *
 * Returns a list, because that is the truth: a file with staged changes AND
 * further unstaged ones appears under both headings, with different numbers in
 * each, exactly as VS Code does it. Collapsing it to one group would mean one of
 * the two counts is a lie about what staging would do.
 *
 * ⚠️ **A CONFLICT IS IN `merge` AND NOWHERE ELSE**, even though `staged` and
 * `unstaged` are both `true` on it (see `GitFileStatus.conflicted` — both ARE
 * true, which is what a conflict is). Listing it three times would bury the one
 * row that blocks everything else.
 */
export function groupsOf(file: GitFileDto): ScmGroupKind[] {
  if (file.conflicted) return ['merge'];
  if (file.untracked) return ['untracked'];
  const groups: ScmGroupKind[] = [];
  if (file.staged) groups.push('staged');
  if (file.unstaged) groups.push('unstaged');
  // Neither flag set is not a shape porcelain produces for a listed file, but a
  // row that reached here with no group would simply vanish — so it is shown
  // under the working tree, which is the wider of the two answers.
  return groups.length > 0 ? groups : ['unstaged'];
}

/**
 * The one letter a row leads with.
 *
 * ⚠️ **ONE LETTER, WHERE THERE USED TO BE A WORD CHIP IN 9px MONO** (`mod` /
 * `staged` / `both` / `new`). Design §1.2 cause 1: that chip was the ONLY thing
 * distinguishing four kinds of change, and it said which GROUP a file was in
 * rather than what had happened to it. Now the group says where, and the letter
 * says what — git's own vocabulary, which every git user already reads.
 *
 * Taken from the porcelain `XY` for the SIDE this group is about: the index
 * column for a staged row, the worktree column for an unstaged one. A file that
 * is `MD` — modified in the index, deleted in the worktree — therefore reads `M`
 * under Staged and `D` under Changes, which is exactly what it is.
 */
export function letterFor(file: GitFileDto, group: ScmGroupKind): string {
  // ⚠️ `U` FOR UNTRACKED, NOT `A` (found in review). git's `A` means a STAGED
  // add, and real staged-add rows carry it two groups up — so an untracked row
  // reading `A added` both collided with those and read as a contradiction
  // against its own heading. `U` for untracked is VS Code's choice, and the word
  // beside it is "untracked".
  if (group === 'untracked') return 'U';
  // A conflict is `!`: it is the one row that BLOCKS, and sharing `U` with
  // untracked — the most harmless row there is — would be the opposite signal.
  if (group === 'merge') return '!';
  const xy = file.xy ?? '';
  const side = group === 'staged' ? xy[0] : xy[1];
  // `.` is porcelain's "unchanged on this side", which cannot happen for a row
  // that is IN this group — but a missing `xy` can (the card-header path does not
  // read it), and `M` is the honest fallback for "something changed here".
  return side && side !== '.' ? side : 'M';
}

/**
 * What a letter MEANS, as a word, for the row's accessible name.
 *
 * The letter is git's and is terse on purpose; a screen reader saying "M" tells
 * nobody anything. Returned as a key rather than a sentence so the catalog owns
 * the words.
 */
export function letterKey(letter: string): string {
  switch (letter) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
      return 'untracked';
    case '!':
      return 'conflicted';
    // ⚠️ `T` IS A REAL PORCELAIN LETTER AND FELL THROUGH TO "modified" (found in
    // review): a file whose TYPE changed — replaced by a symlink, or by a
    // directory — which is a thing worth being told rather than a modification.
    case 'T':
      return 'typechange';
    default:
      return 'modified';
  }
}

/**
 * Build the groups, in order, from a status answer.
 *
 * `filter` matches the whole path, not just the basename: somebody typing `lib/`
 * means "the files in lib", and a basename-only match would answer nothing.
 */
export function buildGroups(status: GitStatusDto | null | undefined, filter = ''): ScmGroup[] {
  const needle = filter.trim().toLowerCase();
  const rows = new Map<ScmGroupKind, ScmRow[]>();
  for (const kind of SCM_GROUP_ORDER) rows.set(kind, []);
  for (const file of status?.files ?? []) {
    if (needle !== '' && !file.path.toLowerCase().includes(needle)) continue;
    const { name, dir } = splitPath(file.path);
    for (const group of groupsOf(file)) {
      rows.get(group)?.push({
        path: file.path,
        name,
        dir,
        letter: letterFor(file, group),
        group,
        file,
        stat: statFor(status, file.path, group),
      });
    }
  }
  return SCM_GROUP_ORDER.map((kind) => ({ kind, rows: rows.get(kind) ?? [] })).filter(
    (g) => g.rows.length > 0
  );
}

/**
 * The numbers for one row.
 *
 * ⚠️ **PER GROUP, NOT PER FILE, AND THAT IS THE POINT OF KEEPING THE TWO SIDES
 * APART IN MAIN.** A staged row shows what staging captured; the unstaged row
 * below it shows what has happened since. One total would be right for neither.
 *
 * `null` for untracked and for anything with no record: `git diff` does not see an
 * untracked file at all, and drawing `+0 −0` beside a brand-new file would read as
 * "this file is empty".
 */
function statFor(
  status: GitStatusDto | null | undefined,
  path: string,
  group: ScmGroupKind
): ScmRow['stat'] {
  // ⚠️ **A CONFLICT HAS NO MEANINGFUL ONE-SIDED COUNT, AND git GIVES A REAL `0 0`
  // RATHER THAN NOTHING (found in review, measured).** `diff --numstat` on an
  // unmerged path emits `0	0	<path>` — not `-`, not absence — so the Merge
  // group, the one the whole design says matters most, rendered **`+0 −0` on a
  // file full of conflict markers**. And `scmTotals` counted it, so a tree whose
  // only changes were conflicts read `+0 −0 · 3 files` with no "(some
  // uncounted)". Exactly the confident wrong number this epic keeps being
  // corrected for.
  if (group === 'merge') return null;
  const stats = status?.stats?.[path];
  if (!stats) return null;
  if (group === 'staged') return stats.staged ?? null;
  if (group === 'unstaged') return stats.unstaged ?? null;
  return null;
}

/**
 * The totals bar: how many files, and how many lines either way.
 *
 * ⚠️ **FILES ARE COUNTED ONCE EVEN WHEN THEY APPEAR TWICE.** A file that is
 * staged AND has further unstaged changes is two ROWS and one FILE, and a header
 * reading "18 files" over seventeen distinct names is the kind of small untruth
 * that teaches a user not to trust the bigger numbers.
 *
 * The LINES are summed across both sides, because that is the honest answer to
 * "how much has changed here" — the question the bar is asking.
 */
export function scmTotals(status: GitStatusDto | null | undefined): {
  files: number;
  insertions: number;
  deletions: number;
  /**
   * At least one changed file has no line count — a binary, an untracked file, a
   * conflict, or stats that were never asked for.
   *
   * ⚠️ **AND IT IS WHAT TELLS THE BAR TO DRAW NO NUMBERS AT ALL when it has none**
   * (found in review): with every file uncounted, `insertions` and `deletions` are
   * both 0 and a bar reading `+0 −0` is the same "absent is not zero" lie the ROWS
   * four lines below it get right.
   */
  partial: boolean;
  /** nothing could be counted at all — draw no numbers, only the file count */
  counted: boolean;
} {
  const files = status?.files ?? [];
  let insertions = 0;
  let deletions = 0;
  let partial = false;
  for (const file of files) {
    const stats = status?.stats?.[file.path];
    const sides = [stats?.unstaged, stats?.staged].filter((s) => !!s);
    // A CONFLICT IS UNCOUNTED, for the reason `statFor` gives: git's `0 0` for an
    // unmerged path is not a measurement, and counting it makes a tree of
    // conflicts read as a tree of no changes.
    if (file.conflicted || sides.length === 0 || sides.some((s) => s?.binary)) {
      partial = true;
      continue;
    }
    for (const side of sides) {
      insertions += side?.insertions ?? 0;
      deletions += side?.deletions ?? 0;
    }
  }
  return {
    files: new Set(files.map((f) => f.path)).size,
    insertions,
    deletions,
    partial,
    // "we counted SOMETHING", which is a different question from "we counted
    // everything". The bar needs the first to decide whether to draw a number at
    // all, and the second to decide whether to hedge it.
    counted: insertions > 0 || deletions > 0 || (!partial && files.length > 0),
  };
}
