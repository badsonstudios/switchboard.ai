// Every change in one scroll (E24 Git v2 item 9, §5.7) — screen 5.
//
// ⚠️ **THE SURFACE EXISTS TO READ WHAT AN AGENT JUST DID, TOP TO BOTTOM**, instead
// of clicking seventeen files. Design §4 item 9 and screen 5: each changed file
// stacked in one scrollable panel with its own sticky header, *"large files
// collapsed until asked for"*.
//
// ⚠️ **AND THE COLLAPSE BUDGET IS NOT A NICETY, IT IS WHAT MAKES THE PANEL
// POSSIBLE AT ALL.** Each expanded file is a real Monaco diff editor — the same
// one the Changes tab mounts once. Seventeen of them in one scroll is seventeen
// editors, seventeen models, seventeen tokenizers; a change set like this
// repository's own produces exactly that, and the panel would take seconds to
// open and hold the main thread while it did. So the budget decides, BEFORE
// anything mounts, which files start open.
//
// Everything here is PURE — no React, no Monaco, no bridge — so the policy is
// testable as a rule rather than through a mounted panel. The row type is
// `scm-groups`' own `ScmRow`, deliberately: the stacked header draws the same
// letter, the same name-first split and the same `+/−` as a sidebar row, and a
// second shape for it would be a second place for those to drift.
import type { ScmRow } from './scm-groups';

/**
 * How many changed LINES the panel will mount editors for before it starts
 * collapsing.
 *
 * Design §4 item 9 says *"the ~400-line collapse budget"*, and the tilde is in the
 * design record because it is a judgement rather than a measurement: 400 changed
 * lines is roughly two screens of reading, which is about as much as anyone takes
 * in before scrolling anyway. Below it the panel opens instantly; above it the
 * cost is paid only for what the user asks to see.
 */
export const COLLAPSE_BUDGET_LINES = 400;

/**
 * And a cap on the NUMBER of editors, which the line budget alone cannot give.
 *
 * ⚠️ **BECAUSE "HOW MANY LINES" IS UNKNOWABLE FOR SOME FILES.** `git diff` does
 * not see an untracked file at all and reports `-` for a binary one, so `ScmRow.stat`
 * is `null` for both — and a hundred brand-new files would each cost 0 against a
 * line budget and still be a hundred editors. The two bounds answer two different
 * questions and neither is redundant.
 */
export const MAX_EXPANDED_FILES = 10;

/** Why a file in the stack starts closed. `null` means it does not. */
export type CollapseReason =
  /** the panel had spent its line budget before reaching this file */
  | 'budget'
  /** this ONE file is bigger than the whole budget — it would never fit */
  | 'huge'
  /** the panel had already opened as many editors as it will */
  | 'count'
  | null;

export interface StackedFile {
  /** the identity, and what a per-file diff asks for */
  readonly key: string;
  readonly row: ScmRow;
  /**
   * Changed lines, or `null` when there is nothing true to say.
   *
   * `null` for an untracked or binary file — `git diff` has no count for either —
   * and the header must draw nothing rather than a `0` that reads as "empty".
   */
  readonly lines: number | null;
  readonly collapsed: boolean;
  readonly reason: CollapseReason;
}

export interface StackPlan {
  readonly files: StackedFile[];
  /** how many start open, which is what the "Collapse all" control acts on */
  readonly expanded: number;
  /** how many start closed, so the panel can say so once at the top */
  readonly collapsed: number;
  /**
   * Nothing is open.
   *
   * ⚠️ **A STATE WORTH NAMING RATHER THAN LEAVING TO BE INFERRED**: a panel of
   * nothing but closed headers looks broken, so it says why in words instead.
   * Reachable with one file bigger than the budget, which is an ordinary
   * generated-file commit.
   */
  readonly allCollapsed: boolean;
}

/** Changed lines for one row, or `null` when git has no count. */
export function changedLines(row: ScmRow): number | null {
  const stat = row.stat;
  if (!stat || stat.binary) return null;
  return stat.insertions + stat.deletions;
}

/**
 * Decide what starts open.
 *
 * ⚠️ **IN THE ORDER GIVEN, AND NOT SORTED BY SIZE.** Opening the smallest files
 * first would fit more of them in the budget, and would also mean the panel's
 * reading order is not the list's — so scrolling the stack would jump about
 * relative to the sidebar beside it. The point of the surface is reading top to
 * bottom, so the budget is spent top to bottom.
 *
 * A file with no count (untracked, binary) spends none of the LINE budget — there
 * is no honest number to spend — but does take one of the editor slots, which is
 * the bound that catches it.
 */
export function planStack(
  rows: readonly ScmRow[],
  budget = COLLAPSE_BUDGET_LINES,
  maxFiles = MAX_EXPANDED_FILES
): StackPlan {
  let spent = 0;
  let open = 0;
  const files = rows.map((row): StackedFile => {
    const lines = changedLines(row);
    const key = `${row.group}:${row.path}`;
    // ⚠️ CHECKED FIRST, because a file bigger than the whole budget must read as
    // "this one is enormous" rather than as "the panel ran out above you" — and
    // those are different sentences for the user.
    if (lines !== null && lines > budget) {
      return { key, row, lines, collapsed: true, reason: 'huge' };
    }
    if (open >= maxFiles) {
      return { key, row, lines, collapsed: true, reason: 'count' };
    }
    if (spent + (lines ?? 0) > budget) {
      return { key, row, lines, collapsed: true, reason: 'budget' };
    }
    spent += lines ?? 0;
    open += 1;
    return { key, row, lines, collapsed: false, reason: null };
  });
  return {
    files,
    expanded: open,
    collapsed: files.length - open,
    allCollapsed: files.length > 0 && open === 0,
  };
}

/**
 * The totals the panel's toolbar draws.
 *
 * ⚠️ **ITS OWN FUNCTION RATHER THAN `scmTotals`, AND THE DIFFERENCE IS THE INPUT.**
 * `scmTotals` counts a `GitStatusDto` and takes care to count a file ONCE when it
 * appears in two groups. This counts the ROWS the panel is actually going to
 * stack, which is the right answer for a header above those rows — a file that is
 * staged and further modified really is two entries here, with two diffs.
 */
export function stackTotals(files: readonly StackedFile[]): {
  files: number;
  insertions: number;
  deletions: number;
  /** at least one file has no count, so the numbers are a floor, not a total */
  partial: boolean;
} {
  let insertions = 0;
  let deletions = 0;
  let partial = false;
  for (const f of files) {
    const stat = f.row.stat;
    if (!stat || stat.binary) {
      partial = true;
      continue;
    }
    insertions += stat.insertions;
    deletions += stat.deletions;
  }
  return { files: files.length, insertions, deletions, partial };
}

/**
 * Apply the user's own expand/collapse choices over the plan.
 *
 * ⚠️ **THE OVERRIDE IS A SET OF KEYS AND IT WINS IN BOTH DIRECTIONS**, so a header
 * the user has opened stays open when the plan is recomputed (a `git status`
 * refresh, a filter change) and one they closed stays closed. Recomputing without
 * it would silently reopen a 900-line file somebody had just folded away, which is
 * the one thing a budget exists to avoid.
 */
export function applyToggles(plan: StackPlan, toggled: ReadonlySet<string>): StackPlan {
  if (toggled.size === 0) return plan;
  let open = 0;
  const files = plan.files.map((f): StackedFile => {
    const collapsed = toggled.has(f.key) ? !f.collapsed : f.collapsed;
    if (!collapsed) open += 1;
    // The REASON is kept even while open: it is what the header says if it is
    // folded again, and dropping it would make a re-fold say nothing.
    return { ...f, collapsed };
  });
  return {
    files,
    expanded: open,
    collapsed: files.length - open,
    allCollapsed: files.length > 0 && open === 0,
  };
}
