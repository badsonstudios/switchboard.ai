// @vitest-environment jsdom
// Every change in one scroll, as the user meets it (E24 Git v2 item 9).
//
// `lib/multi-file-diff.test.ts` owns the BUDGET as a rule — which files start
// open, why, and what a toggle does to the plan. This file owns what only a
// mounted panel answers:
//
//   1. ⚠️ **THE BUDGET REALLY LIMITS WHAT MOUNTS.** The whole point of the policy
//      is that N Monaco editors are not built in one frame, and a plan nobody
//      honours would be a pure function passing its tests while the panel froze.
//   2. ⚠️ **A FOLDED FILE SAYS WHY, IN WORDS**, and the three reasons are three
//      different sentences — "this one is enormous" and "the panel ran out above
//      you" are not the same fact about the user's project.
//   3. The sticky header is a real `<button>` with `aria-expanded`, and ⧉ beside
//      it reaches the single-file panel rather than being a second route.
//   4. The four empty states, from the same one decision the sidebar uses.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { AllChangesView, editorHeightPx } from './AllChangesView';
import { putGitStatus, resetGitStatusStore } from '../lib/git-status-store';
import { resetDiffPanels } from '../lib/diff-panels';
import { setDiffOpener } from '../lib/diff-open';
import type { GitFileDto, GitStatusDto } from '../lib/git-status';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/**
 * ⚠️ **MONACO IS STUBBED, AND THAT IS THE POINT RATHER THAN A SHORTCUT.** This
 * file's claim is *how many editors the panel asks for*, so the editor has to be
 * countable; a real one also needs a layout engine jsdom does not have. The real
 * `MonacoDiff` is exercised end to end in `e2e/diff.spec.ts`.
 */
const mounted: string[] = [];
vi.mock('./MonacoDiff', () => ({
  MonacoDiff: (props: { source: { path: string | null } }) => {
    mounted.push(props.source.path ?? '');
    return null;
  },
}));

let root: Root | null = null;
const FOLDER = '/proj';

const file = (over: Partial<GitFileDto> & { path: string }): GitFileDto => ({
  staged: false,
  unstaged: true,
  untracked: false,
  xy: '.M',
  ...over,
});

/** A status with per-file numbers, which is what the budget is computed from. */
function status(files: Array<[string, number]>): GitStatusDto {
  return {
    isRepo: true,
    files: files.map(([path]) => file({ path })),
    stats: Object.fromEntries(
      files.map(([path, lines]) => [path, { unstaged: { insertions: lines, deletions: 0 } }])
    ),
  };
}

async function mount(s: GitStatusDto | null): Promise<void> {
  // Through the SHARED store, which is how the panel really gets its status —
  // item 11's "one fetch, every reader" and the reason this panel is not a fourth
  // independent reader of `git:status`.
  if (s) putGitStatus(FOLDER, s);
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <AllChangesView
        folder={FOLDER}
        colorScheme="dark"
        poppedOut={false}
        onPopoutToggle={() => undefined}
        panelId="allchanges-card-1"
        layoutPref="side-by-side"
        cardId="card-1"
      />
    );
  });
}

const one = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel);
const all = (sel: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(sel)];
const text = (): string => document.body.textContent ?? '';

async function click(el: Element | null | undefined): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('the all-changes panel', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    mounted.length = 0;
    resetGitStatusStore();
    resetDiffPanels();
    setDiffOpener(null);
    await initI18nForTests();
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      root = null;
      await act(async () => r.unmount());
    }
    document.body.innerHTML = '';
    resetGitStatusStore();
    setDiffOpener(null);
  });

  it('stacks every changed file, with its letter and its numbers (the done-when)', async () => {
    await mount(status([['src/a.ts', 10], ['docs/b.md', 4]]));
    expect(all('.all-changes-file')).toHaveLength(2);
    expect(one('.all-changes-file[data-path="src/a.ts"] .all-changes-name')?.textContent).toBe('a.ts');
    expect(one('.all-changes-file[data-path="src/a.ts"] .scm-letter')?.textContent).toBe('M');
    expect(one('.all-changes-file[data-path="src/a.ts"] .all-changes-stat')?.textContent).toContain('+10');
    // both fit the budget, so both mounted an editor
    expect(mounted.sort()).toEqual(['docs/b.md', 'src/a.ts']);
  });

  it('⚠️ THE BUDGET REALLY LIMITS WHAT MOUNTS — the plan is honoured, not merely computed', async () => {
    // ⚠️ **THE FAILURE THIS GUARDS AGAINST IS NOT A WRONG PICTURE, IT IS A FROZEN
    // APP.** Every expanded file is a real Monaco diff editor; a plan nobody
    // honoured would leave `multi-file-diff.test.ts` green while the panel built
    // seventeen of them in one frame.
    await mount(status([['a.ts', 300], ['b.ts', 300], ['c.ts', 300]]));
    expect(all('.all-changes-file')).toHaveLength(3);
    // 300 fits; 600 does not, so only the first mounted.
    expect(mounted).toEqual(['a.ts']);
    expect(all('.all-changes-folded')).toHaveLength(2);
  });

  it('⚠️ A FOLDED FILE SAYS WHY, and "enormous" is not the same sentence as "ran out"', async () => {
    // 9000 is bigger than the whole budget (`huge`); 395 is not, but 10 + 395
    // overruns it, so `b.ts` is the one that reads as a budget casualty. The two
    // numbers have to straddle the budget for the test to mean anything.
    await mount(status([['huge.ts', 9000], ['a.ts', 10], ['b.ts', 395]]));
    const reason = (path: string): string =>
      one(`.all-changes-file[data-path="${path}"] .all-changes-folded`)?.textContent ?? '';
    expect(reason('huge.ts')).toContain('too large');
    expect(reason('huge.ts')).toContain('9,000');
    // `a.ts` is open — a huge file must not spend the budget it never used
    expect(mounted).toEqual(['a.ts']);
    expect(reason('b.ts')).toContain('quick to open');
  });

  it('a header is a real `<button>` with `aria-expanded`, and clicking it opens the file', async () => {
    // §5.32 rule 1, and the same lesson the sidebar row records: a clickable
    // `div` means Enter, Space, focus and the announcement are all reimplemented
    // and none of them are.
    await mount(status([['huge.ts', 9000]]));
    const head = one('.all-changes-toggle');
    expect(head?.tagName).toBe('BUTTON');
    expect(head?.getAttribute('aria-expanded')).toBe('false');
    expect(mounted).toEqual([]);
    await click(head);
    expect(one('.all-changes-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(mounted).toEqual(['huge.ts']);
  });

  it('⚠️ AND THE FOLD SURVIVES A STATUS REFRESH, so nothing springs back open', async () => {
    // The plan is recomputed on every refresh; without the toggle set a file the
    // user had just folded away would silently reopen — the one thing a collapse
    // budget exists to avoid.
    await mount(status([['a.ts', 10]]));
    expect(mounted).toEqual(['a.ts']);
    await click(one('.all-changes-toggle'));
    expect(one('.all-changes-toggle')?.getAttribute('aria-expanded')).toBe('false');
    mounted.length = 0;
    // a fresh answer for the same tree
    await act(async () => putGitStatus(FOLDER, status([['a.ts', 12]])));
    expect(one('.all-changes-toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(mounted).toEqual([]);
  });

  it('⚠️ A PANEL THAT OPENS ENTIRELY FOLDED SAYS SO, rather than looking broken', async () => {
    await mount(status([['huge.ts', 9000]]));
    expect(one('.all-changes-all-folded')).not.toBeNull();
    // …and the fold control offers the way out rather than repeating itself
    expect(one('[data-testid="all-changes-fold"]')?.getAttribute('aria-label')).toContain('Expand');
  });

  it('“collapse all” ends with everything shut, whatever each file was', async () => {
    await mount(status([['a.ts', 10], ['b.ts', 10]]));
    expect(mounted).toHaveLength(2);
    await click(one('[data-testid="all-changes-fold"]'));
    expect(all('.all-changes-folded')).toHaveLength(2);
    // and back
    await click(one('[data-testid="all-changes-fold"]'));
    expect(all('.all-changes-folded')).toHaveLength(0);
  });

  it('⧉ beside a file reaches the SINGLE-FILE panel, rather than being a second route', async () => {
    const asked: Array<string | null | undefined> = [];
    setDiffOpener((target) => asked.push(target.path));
    await mount(status([['src/a.ts', 10]]));
    await click(one('[data-testid="all-changes-file-popout"]'));
    expect(asked).toEqual(['src/a.ts']);
  });

  it('the totals describe the stack, and HEDGE when something has no count', async () => {
    const s = status([['a.ts', 10]]);
    s.files.push(file({ path: 'logo.png' }));
    await mount(s);
    const bar = one('.all-changes-totals')?.textContent ?? '';
    expect(bar).toContain('+10');
    // ⚠️ ABSENT IS NOT ZERO: the binary has no numbers, so the bar says the count
    // is partial rather than reporting a total it cannot stand behind.
    expect(one('.all-changes-file[data-path="logo.png"] .all-changes-stat')?.textContent).toBe('');
    expect(bar).not.toContain('+0');
  });

  it('says WHAT is being compared, not just "All changes"', async () => {
    const s = status([['a.ts', 1]]);
    s.branch = 'feature/x';
    await mount(s);
    expect(one('.all-changes-scope')?.textContent).toContain('feature/x');
    expect(one('.all-changes-scope')?.textContent).toContain('working tree vs HEAD');
  });

  it('⚠️ THE FOUR EMPTY STATES, and an unreadable repo never reads as a clean one', async () => {
    await mount({ isRepo: true, files: [] });
    expect(text()).toContain('Working tree clean');
    const remount = async (s: GitStatusDto): Promise<void> => {
      if (root) {
        const r = root;
        root = null;
        await act(async () => r.unmount());
      }
      document.body.innerHTML = '';
      resetGitStatusStore();
      await mount(s);
    };
    await remount({ isRepo: false, files: [] });
    expect(text()).toContain('Not a git repository');
    await remount({ isRepo: true, files: [], unreadable: 'git exploded' });
    expect(text()).toContain('git exploded');
    expect(text()).not.toContain('Working tree clean');
  });

  it('nothing is drawn, and nothing throws, before a status has arrived', async () => {
    await mount(null);
    expect(all('.all-changes-file')).toHaveLength(0);
    expect(mounted).toEqual([]);
  });
});

describe('how tall a file editor is', () => {
  it('scales with the change and is clamped at both ends', () => {
    // Small changes must not leave a screen of blank; a large one gets its own
    // inner scroll rather than a page of column.
    expect(editorHeightPx(1)).toBe(140);
    expect(editorHeightPx(9000)).toBe(460);
    // The band between the clamps is narrow by design — above ~18 changed lines
    // a file is already getting the maximum box and its own inner scroll.
    expect(editorHeightPx(12)).toBeGreaterThan(140);
    expect(editorHeightPx(12)).toBeLessThan(460);
  });

  it('⚠️ AN UNKNOWN SIZE GETS THE MINIMUM, not the maximum', () => {
    // There is nothing to scale by, and guessing large would spend the most space
    // on the least information.
    expect(editorHeightPx(null)).toBe(140);
  });
});
