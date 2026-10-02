// The collapse budget (E24 Git v2 item 9).
//
// ⚠️ **THE BUDGET IS THE ONLY REASON THE PANEL CAN EXIST, so it is tested as a
// rule rather than through a mounted panel.** Each expanded file is a real Monaco
// diff editor; seventeen of them in one scroll is seventeen editors, seventeen
// models and seventeen tokenizers, which is seconds of held main thread on a
// change set the size of this repository's own. So what matters here is not that
// some files collapse — it is WHICH, in what order, and whether the panel can ever
// open saying nothing.
import { describe, it, expect } from 'vitest';
import {
  COLLAPSE_BUDGET_LINES,
  MAX_EXPANDED_FILES,
  applyToggles,
  changedLines,
  planStack,
  stackTotals,
} from './multi-file-diff';
import { splitPath, type ScmRow } from './scm-groups';

/** A row with a line count, or with none (untracked / binary). */
function row(path: string, stat: ScmRow['stat']): ScmRow {
  const { name, dir } = splitPath(path);
  return {
    path,
    name,
    dir,
    letter: 'M',
    group: 'unstaged',
    file: { path, staged: false, unstaged: true, untracked: false },
    stat,
  };
}

const sized = (path: string, lines: number): ScmRow =>
  row(path, { insertions: lines, deletions: 0 });
const unknown = (path: string): ScmRow => row(path, null);
const binary = (path: string): ScmRow =>
  row(path, { insertions: 0, deletions: 0, binary: true });

/**
 * `name:open` / `name:<reason>` / `name:closed`.
 *
 * `closed` is a file the USER folded: it carries no reason, and that is correct —
 * the panel owes an explanation for a decision IT made, not for one the user made.
 */
const shape = (plan: ReturnType<typeof planStack>): string[] =>
  plan.files.map((f) => `${f.row.name}:${f.collapsed ? (f.reason ?? 'closed') : 'open'}`);

describe('the collapse budget', () => {
  it('opens everything that fits (the done-when)', () => {
    const plan = planStack([sized('a.ts', 10), sized('b.ts', 20), sized('c.ts', 30)]);
    expect(shape(plan)).toEqual(['a.ts:open', 'b.ts:open', 'c.ts:open']);
    expect(plan.expanded).toBe(3);
    expect(plan.collapsed).toBe(0);
    expect(plan.allCollapsed).toBe(false);
  });

  it('⚠️ SPENDS THE BUDGET TOP TO BOTTOM, and does NOT sort by size to fit more in', () => {
    // Opening the smallest first would fit more editors, and would also mean the
    // stack's reading order is not the list's — so scrolling it would jump about
    // relative to the sidebar beside it. The whole point of the surface is reading
    // top to bottom.
    // 350 + 45 = 395, so `tiny` would take it to 405 and does not fit. Sorted by
    // size, all three would have — which is exactly the trade being refused.
    const plan = planStack([sized('big.ts', 350), sized('small.ts', 45), sized('tiny.ts', 10)], 400);
    expect(shape(plan)).toEqual(['big.ts:open', 'small.ts:open', 'tiny.ts:budget']);
  });

  it('⚠️ A FILE BIGGER THAN THE WHOLE BUDGET SAYS SO, not "the panel ran out above you"', () => {
    // Two different sentences for the user, so two different reasons: `huge` is
    // about this file, `budget` is about the ones before it. An ordinary
    // generated-file commit reaches the first.
    const plan = planStack([sized('generated.ts', 9000), sized('real.ts', 12)], 400);
    expect(shape(plan)).toEqual(['generated.ts:huge', 'real.ts:open']);
    // …and it is checked FIRST, so a huge file never reads as a budget casualty
    // even when the budget was already spent.
    const after = planStack([sized('fills.ts', 400), sized('generated.ts', 9000)], 400);
    expect(shape(after)).toEqual(['fills.ts:open', 'generated.ts:huge']);
  });

  it('⚠️ AND IT DOES NOT BLOCK THE FILES BELOW IT — the budget is unspent by a closed file', () => {
    // The thing a naive running total gets wrong: charging the budget for a file
    // nobody is going to mount would collapse the whole rest of the panel.
    const plan = planStack([sized('generated.ts', 9000), sized('a.ts', 10), sized('b.ts', 10)], 400);
    expect(plan.expanded).toBe(2);
  });

  it('⚠️ A FILE WITH NO COUNT SPENDS NO LINES — there is no honest number to spend', () => {
    // `git diff` does not see an untracked file and reports `-` for a binary one.
    const plan = planStack([unknown('new.ts'), binary('logo.png'), sized('a.ts', 399)], 400);
    expect(shape(plan)).toEqual(['new.ts:open', 'logo.png:open', 'a.ts:open']);
  });

  it('⚠️ BUT IT STILL TAKES AN EDITOR SLOT, which is the bound the line budget cannot give', () => {
    // A hundred brand-new files would each cost 0 against a line budget and still
    // be a hundred Monaco editors. The two bounds answer two different questions.
    const many = Array.from({ length: 30 }, (_, i) => unknown(`new-${i}.ts`));
    const plan = planStack(many);
    expect(plan.expanded).toBe(MAX_EXPANDED_FILES);
    expect(plan.files[MAX_EXPANDED_FILES].reason).toBe('count');
  });

  it('the editor cap applies to counted files too, and says `count` rather than `budget`', () => {
    const many = Array.from({ length: 20 }, (_, i) => sized(`a-${i}.ts`, 1));
    const plan = planStack(many, 400, 3);
    expect(plan.expanded).toBe(3);
    expect(plan.files[3].reason).toBe('count');
  });

  it('⚠️ A PANEL THAT OPENS ENTIRELY CLOSED SAYS SO, rather than looking broken', () => {
    // Reachable with one enormous file, which is an ordinary commit. The flag
    // exists so the panel can put it in words once at the top.
    const plan = planStack([sized('generated.ts', 9000)], 400);
    expect(plan.allCollapsed).toBe(true);
    expect(plan.expanded).toBe(0);
  });

  it('…and an EMPTY stack is not "all collapsed", which is a different thing', () => {
    const plan = planStack([]);
    expect(plan.allCollapsed).toBe(false);
    expect(plan.files).toEqual([]);
  });

  it('the default budget is the one the design record asked for', () => {
    expect(COLLAPSE_BUDGET_LINES).toBe(400);
    // exactly at the budget still fits — the boundary is "more than", not "as much as"
    expect(planStack([sized('a.ts', 400)], 400).expanded).toBe(1);
    expect(planStack([sized('a.ts', 401)], 400).expanded).toBe(0);
  });

  it('counts both sides of a change, not just additions', () => {
    expect(changedLines(row('a.ts', { insertions: 10, deletions: 7 }))).toBe(17);
    expect(changedLines(unknown('a.ts'))).toBeNull();
    expect(changedLines(binary('a.png'))).toBeNull();
  });

  it('keys a file by GROUP and path, so one file staged AND modified is two entries', () => {
    const staged: ScmRow = { ...sized('a.ts', 1), group: 'staged' };
    const plan = planStack([staged, sized('a.ts', 2)]);
    expect(plan.files.map((f) => f.key)).toEqual(['staged:a.ts', 'unstaged:a.ts']);
  });
});

describe('the user’s own expand and collapse', () => {
  it('⚠️ WINS IN BOTH DIRECTIONS, so a refresh cannot reopen what was folded away', () => {
    // ⚠️ **THE BUG THIS PREVENTS.** The plan is recomputed on every `git status`
    // refresh and every filter change. Without the override, a 900-line file
    // somebody had just folded would silently spring open again — which is the one
    // thing a collapse budget exists to avoid.
    const plan = planStack([sized('a.ts', 10), sized('huge.ts', 9000)], 400);
    expect(shape(plan)).toEqual(['a.ts:open', 'huge.ts:huge']);
    const toggled = applyToggles(plan, new Set(['unstaged:a.ts', 'unstaged:huge.ts']));
    expect(shape(toggled)).toEqual(['a.ts:closed', 'huge.ts:open']);
    expect(toggled.expanded).toBe(1);
  });

  it('keeps the REASON while open, so folding it again still says why', () => {
    const plan = planStack([sized('huge.ts', 9000)], 400);
    const opened = applyToggles(plan, new Set(['unstaged:huge.ts']));
    expect(opened.files[0]).toMatchObject({ collapsed: false, reason: 'huge' });
  });

  it('no toggles is the plan itself, by identity — nothing to re-render for', () => {
    const plan = planStack([sized('a.ts', 10)]);
    expect(applyToggles(plan, new Set())).toBe(plan);
  });

  it('a toggle for a file that is no longer there is simply ignored', () => {
    // A path can leave the list between two refreshes (committed, discarded).
    const plan = planStack([sized('a.ts', 10)]);
    const after = applyToggles(plan, new Set(['unstaged:gone.ts']));
    expect(shape(after)).toEqual(['a.ts:open']);
  });

  it('recomputes `allCollapsed` after a toggle, rather than carrying the old answer', () => {
    const plan = planStack([sized('a.ts', 10)]);
    expect(plan.allCollapsed).toBe(false);
    expect(applyToggles(plan, new Set(['unstaged:a.ts'])).allCollapsed).toBe(true);
  });
});

describe('the toolbar’s totals', () => {
  it('sums the ROWS the panel stacks, which is not the same question `scmTotals` answers', () => {
    // `scmTotals` counts a file ONCE when it is in two groups, because it is
    // describing a working tree. This describes the rows below it, and a file that
    // is staged and further modified really is two entries here, with two diffs.
    const staged: ScmRow = { ...row('a.ts', { insertions: 5, deletions: 1 }), group: 'staged' };
    const plan = planStack([staged, row('a.ts', { insertions: 2, deletions: 3 })]);
    expect(stackTotals(plan.files)).toEqual({
      files: 2,
      insertions: 7,
      deletions: 4,
      partial: false,
    });
  });

  it('⚠️ SAYS THE NUMBERS ARE A FLOOR when something has no count', () => {
    // Absent is not zero — the standing rule of this epic. A binary or untracked
    // file in the stack makes the total a floor, and the bar has to hedge it.
    const plan = planStack([sized('a.ts', 10), binary('logo.png')]);
    expect(stackTotals(plan.files).partial).toBe(true);
    expect(stackTotals(plan.files).insertions).toBe(10);
  });

  it('an empty stack reports zeroes and nothing missing', () => {
    expect(stackTotals([])).toEqual({ files: 0, insertions: 0, deletions: 0, partial: false });
  });
});
