// @vitest-environment jsdom
// The source-control sidebar as the user meets it (E24 Git v2 items 6 and 7).
//
// `lib/scm-groups.test.ts` owns the RULES — which group, which letter, what the
// filter matches, how the totals count. This file owns what only a mounted
// component can answer:
//
//   1. ⚠️ **EVERY COLOUR TOKEN IT NAMES EXISTS.** Item 2's review found two
//      invented custom properties that had SHIPPED, and both failed in total
//      silence because a `var()` with a fallback cannot tell you the name was
//      wrong. The token drift test reads the token files and cannot see an inline
//      style, so this is the only place the two sides are compared.
//   2. ⚠️ **THE ROW IS A `<button>`.** The old row was a clickable `<div>`, which
//      meant the file list was unreachable by keyboard — §5.32 rule 1, and the
//      kind of thing that is invisible until somebody tries to Tab to it.
//   3. The hover slot really swaps the numbers for the verbs, and does so on
//      FOCUS as well — a verb that only exists under a pointer is a verb a
//      keyboard user cannot reach.
//   4. The groups fold, and a group that appears later is open.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { LETTER_INKS, ScmSidebar } from './ScmSidebar';
import { resetAllChangesOpener, setAllChangesOpener } from '../lib/allchanges-open';
import { loadUiState } from '../lib/ui-state';
import type { GitFileDto, GitStatusDto } from '../lib/git-status';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
const FOLDER = '/proj';

const file = (over: Partial<GitFileDto> & { path: string }): GitFileDto => ({
  staged: false,
  unstaged: true,
  untracked: false,
  ...over,
});

const selected: string[] = [];

async function mount(status: GitStatusDto | null): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ScmSidebar
        folder={FOLDER}
        status={status}
        selected={null}
        onSelect={(p) => selected.push(p)}
        onRefresh={() => undefined}
      />
    );
  });
}

/**
 * The workspace `ui` blob behind the preload bridge, for tree mode's preference.
 *
 * ⚠️ **NOT `localStorage`** (P2-E15-06): the packaged renderer's origin changes
 * port every launch, so a pref stored there survives nothing — which is why
 * `lib/scm-view-mode` reads the blob and why a test of it has to stub one. Shared
 * with `diff-layout.test.ts`'s harness in shape, deliberately.
 */
function stubUi(initial: Record<string, unknown> = {}): { store: Record<string, unknown> } {
  const state = { store: { ...initial } };
  (window as unknown as { switchboard: unknown }).switchboard = {
    workspace: {
      getUi: async () => state.store,
      setUi: (v: Record<string, unknown>) => {
        state.store = { ...v };
      },
    },
  };
  return state;
}

/**
 * The same sidebar, but belonging to a CARD.
 *
 * ⚠️ **THE HARNESS ABOVE DELIBERATELY PASSES NO `cardId`, AND THAT IS WHY TWO
 * BUTTONS ARE INVISIBLE IN MOST OF THIS FILE.** ⏱ (item 10) and ⧉ (item 9) are
 * both absent without a card to act on — the owner's rule about a control that
 * does nothing — so a test of either has to say which card it is.
 */
async function mountWithCard(status: GitStatusDto | null): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ScmSidebar
        folder={FOLDER}
        status={status}
        selected={null}
        onSelect={(p) => selected.push(p)}
        onRefresh={() => undefined}
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

/**
 * Type into the filter box.
 *
 * ⚠️ **THROUGH THE PROTOTYPE'S SETTER, AND THAT IS NOT A STYLE CHOICE.** React
 * tracks the last value it wrote on the node, so a plain `box.value = x` makes the
 * two agree and the synthetic `change` NEVER FIRES — the test then asserts against
 * an unfiltered list and passes for the wrong reason. (It did: the tree-mode filter
 * test below was written the plain way and failed, which is the one shape of this
 * mistake that announces itself.) Wrapped because an unbound method reference is a
 * lint error. `HistoryPane.test.tsx` records the same two facts.
 */
async function typeIntoFilter(value: string): Promise<void> {
  const box = one('.scm-filter') as HTMLInputElement | null;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  await act(async () => {
    if (!box) return;
    descriptor?.set?.call(box, value);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the sidebar’s inks', () => {
  it('⚠️ every token LETTER_INKS names is declared in tokens.css', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'src/renderer/src/theme/tokens.css'),
      'utf8'
    );
    for (const token of Object.values(LETTER_INKS)) {
      expect(css, `${token} is not declared in tokens.css`).toContain(`${token}:`);
    }
  });

  it('gives the four common letters four different colours', () => {
    // A letter whose colour matched its neighbour's would be a letter doing no
    // work beyond the glyph.
    const four = [LETTER_INKS.A, LETTER_INKS.D, LETTER_INKS.M, LETTER_INKS['!']];
    expect(new Set(four).size).toBe(4);
  });
});

describe('the source-control sidebar', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    selected.length = 0;
    await initI18nForTests();
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      root = null;
      await act(async () => r.unmount());
    }
  });

  it('draws a named group per kind, with its own count (the done-when)', async () => {
    await mount({
      isRepo: true,
      files: [
        file({ path: 'src/a.ts', staged: true, unstaged: false, xy: 'M.' }),
        file({ path: 'src/b.ts', xy: '.M' }),
        file({ path: 'c.ts', xy: '.M' }),
        file({ path: 'new.ts', untracked: true, xy: '??' }),
      ],
    });
    expect(all('.scm-group').map((g) => g.className)).toEqual([
      'scm-group scm-group-staged',
      'scm-group scm-group-unstaged',
      'scm-group scm-group-untracked',
    ]);
    expect(text()).toContain('Staged changes');
    expect(text()).toContain('Untracked');
    const counts = all('.scm-group-count').map((c) => c.textContent);
    expect(counts).toEqual(['1', '2', '1']);
  });

  it('⚠️ a MERGE CONFLICT is drawn FIRST, because it is the one that blocks you', async () => {
    await mount({
      isRepo: true,
      files: [
        file({ path: 'z.ts', xy: '.M' }),
        file({ path: 'c.ts', conflicted: true, staged: true, unstaged: true, xy: 'UU' }),
      ],
    });
    expect(all('.scm-group')[0].className).toContain('scm-group-merge');
    // `!`, not `U`: a conflict blocks, an untracked file does not, and sharing a
    // letter between them would be the wrong signal (review).
    expect(one('.scm-letter-conflicted')).not.toBeNull();
  });

  it('⚠️ the row is a BUTTON, so the list is reachable by keyboard', async () => {
    // The old row was a clickable `<div>`: Enter, Space, focus and the
    // announcement all had to be reimplemented and none of them were.
    await mount({ isRepo: true, files: [file({ path: 'src/a.ts', xy: '.M' })] });
    const open = one('.scm-row-open');
    expect(open?.tagName).toBe('BUTTON');
    // …and it says what it is, because a lone "M" tells a screen reader nothing.
    expect(open?.getAttribute('aria-label')).toContain('modified');
    expect(open?.getAttribute('aria-label')).toContain('a.ts');
    await click(open);
    expect(selected).toEqual(['src/a.ts']);
  });

  it('⚠️ leads with the NAME and keeps the directory separate', async () => {
    // Design §1.2 cause 2: the rail used to cut off the basename, which is the
    // only part that identifies the file.
    await mount({
      isRepo: true,
      files: [file({ path: 'src/renderer/src/components/FeedView.tsx', xy: '.M' })],
    });
    expect(one('.scm-name')?.textContent).toBe('FeedView.tsx');
    expect(one('.scm-dir')?.textContent).toContain('src/renderer/src/components/');
  });

  it('⚠️ a file at the ROOT renders NO directory span at all', async () => {
    // The path goes through a bidi isolate, so an empty directory produced a span
    // holding two invisible code points — an empty box in the layout, and
    // something a text selector matches. An e2e asserting on a sibling span is
    // what found it.
    await mount({ isRepo: true, files: [file({ path: 'README.md', xy: '.M' })] });
    expect(one('.scm-name')?.textContent).toBe('README.md');
    expect(one('.scm-dir')).toBeNull();
    // …and the LABEL does not say "README.md in , modified" either, which is what
    // the one-key version interpolated (review).
    const label = one('.scm-row-open')?.getAttribute('aria-label') ?? '';
    expect(label).toBe('README.md, modified');
  });

  it('draws the per-file numbers, and NOTHING for a file with none', async () => {
    await mount({
      isRepo: true,
      files: [file({ path: 'a.ts', xy: '.M' }), file({ path: 'new.ts', untracked: true, xy: '??' })],
      stats: { 'a.ts': { unstaged: { insertions: 12, deletions: 3 } } },
    });
    const stats = all('.scm-row-stat').map((s) => s.textContent?.trim());
    expect(stats[0]).toContain('+12');
    expect(stats[0]).toContain('−3');
    // `git diff` does not see an untracked file; `+0 −0` would read as "empty".
    expect(stats[1]).toBe('');
  });

  it('⚠️ a BINARY file says binary, not a number', async () => {
    await mount({
      isRepo: true,
      files: [file({ path: 'logo.png', xy: '.M' })],
      stats: { 'logo.png': { unstaged: { insertions: 0, deletions: 0, binary: true } } },
    });
    expect(one('.scm-row-stat')?.textContent).toContain('binary');
  });

  it('⚠️ the two rows of ONE file show DIFFERENT numbers', async () => {
    // Staging captured one thing and something has happened since. One total
    // would be right for neither row.
    await mount({
      isRepo: true,
      files: [file({ path: 'a.ts', staged: true, unstaged: true, xy: 'MM' })],
      stats: { 'a.ts': { staged: { insertions: 9, deletions: 0 }, unstaged: { insertions: 1, deletions: 2 } } },
    });
    const stats = all('.scm-row-stat').map((s) => s.textContent?.trim() ?? '');
    expect(stats[0]).toContain('+9');
    expect(stats[1]).toContain('+1');
  });

  it('⚠️ the header reads branch, ahead AND behind — three fields nothing had ever read', async () => {
    await mount({
      isRepo: true,
      branch: 'feature/x',
      ahead: 3,
      behind: 1,
      files: [file({ path: 'a.ts', xy: '.M' })],
    });
    expect(one('.scm-branch')?.textContent).toContain('feature/x');
    expect(one('.scm-ahead')?.textContent).toContain('3');
    expect(one('.scm-behind')?.textContent).toContain('1');
  });

  it('a branch level with its upstream shows neither arrow', async () => {
    await mount({ isRepo: true, branch: 'main', ahead: 0, behind: 0, files: [file({ path: 'a.ts' })] });
    expect(one('.scm-ahead')).toBeNull();
    expect(one('.scm-behind')).toBeNull();
  });

  it('⚠️ the totals bar counts a file ONCE even when it is two rows, and says when it cannot know', async () => {
    await mount({
      isRepo: true,
      files: [file({ path: 'a.ts', staged: true, unstaged: true, xy: 'MM' }), file({ path: 'n.ts', untracked: true })],
      stats: { 'a.ts': { staged: { insertions: 1, deletions: 1 }, unstaged: { insertions: 1, deletions: 1 } } },
    });
    expect(all('.scm-row')).toHaveLength(3);
    // two FILES, three rows — and "some uncounted", because the untracked file
    // has no line count and a bare total would imply one.
    expect(one('.scm-filecount')?.textContent).toContain('2 files');
    expect(one('.scm-filecount')?.textContent).toContain('uncounted');
  });

  it('folds a group shut and back', async () => {
    await mount({ isRepo: true, files: [file({ path: 'a.ts', xy: '.M' })] });
    const head = one('.scm-group-head');
    expect(head?.getAttribute('aria-expanded')).toBe('true');
    expect(all('.scm-row')).toHaveLength(1);
    await click(head);
    expect(one('.scm-group-head')?.getAttribute('aria-expanded')).toBe('false');
    expect(all('.scm-row')).toHaveLength(0);
    await click(one('.scm-group-head'));
    expect(all('.scm-row')).toHaveLength(1);
  });

  it('⚠️ the verbs are HIDDEN AT REST — and this is asserted against the COMPUTED style', async () => {
    // ⚠️ **THE FIRST VERSION OF THIS TEST READ `tokens.css` AS TEXT AND PASSED
    // WHILE THE FEATURE WAS BROKEN** (found in review). The component set
    // `display: flex` INLINE on the same element, and an inline declaration
    // outranks any author rule without `!important` — so the verbs were painted on
    // every row at rest and hovering removed the numbers and added nothing. The
    // test proved the rule had been TYPED, not that it won: the same shape as
    // "the hostile-driver test was proving the fixture, not the subject".
    //
    // So the stylesheet is loaded into jsdom and the answer is read off the
    // element. `getComputedStyle` in jsdom does apply author stylesheets and does
    // respect inline-vs-rule precedence, which is the whole of the claim.
    const css = fs.readFileSync(
      path.join(process.cwd(), 'src/renderer/src/theme/tokens.css'),
      'utf8'
    );
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    try {
      await mount({ isRepo: true, files: [file({ path: 'a.ts', xy: '.M' })] });
      const acts = one('.scm-row-acts');
      expect(acts).not.toBeNull();
      expect(getComputedStyle(acts!).visibility).toBe('hidden');
      // ⚠️ AND NOT `display: none`, which would take the buttons out of the
      // ACCESSIBILITY TREE as well — a screen-reader user browsing the list would
      // never be told the row has an action at all.
      expect(getComputedStyle(acts!).display).not.toBe('none');
      // The rule that reveals them names FOCUS as well as hover: a verb that only
      // exists under a pointer is a verb a keyboard user cannot reach.
      expect(css).toContain('.scm-row:focus-within .scm-row-acts');
      expect(css).toContain('.scm-row:hover .scm-row-acts');
    } finally {
      style.remove();
    }
  });

  it('⚠️ NO stage or discard button yet — the owner’s own rule', async () => {
    // Screen 1 draws `＋` and `↶` on every row; both need `git.write`, which is
    // item 12. *"A row with a `＋` that does nothing is worse than a row with no
    // `＋`"* — so the slot is built and those two are absent rather than dead.
    await mount({ isRepo: true, files: [file({ path: 'a.ts', xy: '.M' })] });
    const acts = one('.scm-row-acts');
    expect(acts).not.toBeNull();
    for (const button of all('.scm-row-acts button')) {
      const label = button.getAttribute('aria-label') ?? '';
      expect(label).not.toMatch(/stage|discard|revert/i);
    }
  });

  it('filters, and says so when nothing matches', async () => {
    await mount({
      isRepo: true,
      files: [file({ path: 'src/lib/a.ts', xy: '.M' }), file({ path: 'docs/b.md', xy: '.M' })],
    });
    // `typeIntoFilter` at module scope, rather than a second copy here: the
    // prototype-setter trap it documents is the kind of knowledge that must live
    // in exactly one place, and item 8's own filter test proved it by being
    // written the plain way first.
    await typeIntoFilter('lib/');
    expect(all('.scm-row')).toHaveLength(1);
    await typeIntoFilter('aardvark');
    expect(all('.scm-row')).toHaveLength(0);
    expect(one('.scm-no-match')).not.toBeNull();
  });

  it('⚠️ an UNREADABLE repository shows the reason and NO file list', async () => {
    // `gitPaneState`'s ordering, through the component: an unreadable answer
    // carries `files: []` and `isRepo: true`, which is also the shape of a clean
    // tree — so the wrong order greets a damaged repository with "Working tree
    // clean".
    await mount({ isRepo: true, unreadable: 'the repository is damaged', files: [] });
    expect(text()).toContain('the repository is damaged');
    expect(text()).not.toContain('Working tree clean');
    expect(one('.scm-filter')).toBeNull();
    expect(one('.scm-totals')).toBeNull();
  });

  it('a clean tree says so, and a bare folder says it is not a repository', async () => {
    await mount({ isRepo: true, files: [] });
    expect(text()).toContain('Working tree clean');
    if (root) {
      const r = root;
      root = null;
      await act(async () => r.unmount());
    }
    document.body.innerHTML = '';
    await mount({ isRepo: false, files: [] });
    expect(text()).toContain('Not a git repository');
  });
});

// Tree mode (E24 Git v2 item 8) — screen 2.
//
// `lib/scm-tree.test.ts` owns the SHAPE: what compresses, what does not, what a
// count means, how a fold hides. This file owns what only a mounted component
// answers — that the toggle really switches the list, that a folder row is a real
// `<button>` carrying its own state, that the two modes SHARE the file row, and
// that the directory stops being repeated after every name once the folder is the
// row above it.
describe('tree mode (E24 Git v2 item 8)', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    selected.length = 0;
    await initI18nForTests();
    stubUi();
    await loadUiState();
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      root = null;
      await act(async () => r.unmount());
    }
    document.body.innerHTML = '';
    delete (window as unknown as { switchboard?: unknown }).switchboard;
  });

  const nested: GitStatusDto = {
    isRepo: true,
    files: [
      file({ path: 'src/renderer/src/components/FeedView.tsx', xy: '.M' }),
      file({ path: 'src/renderer/src/components/FeedView.test.tsx', xy: '.M' }),
      file({ path: 'src/preload/index.ts', xy: '.M' }),
      file({ path: 'PROGRESS.md', xy: '.M' }),
    ],
  };

  it('starts on the FLAT list, and the tree button switches it (the done-when)', async () => {
    await mount(nested);
    expect(one('[data-testid="scm-mode-flat"]')?.getAttribute('aria-checked')).toBe('true');
    expect(all('.scm-tree-folder')).toHaveLength(0);
    await click(one('[data-testid="scm-mode-tree"]'));
    expect(one('[data-testid="scm-mode-tree"]')?.getAttribute('aria-checked')).toBe('true');
    expect(all('.scm-tree-folder').length).toBeGreaterThan(0);
  });

  it('⚠️ COMPRESSES A SINGLE-CHILD CHAIN INTO ONE ROW, which is the item', async () => {
    await mount(nested);
    await click(one('[data-testid="scm-mode-tree"]'));
    const paths = all('.scm-tree-folder').map((el) => el.getAttribute('data-path'));
    // `src` branches (renderer, preload) so it is a row; below it each side folds.
    expect(paths).toContain('src');
    expect(paths).toContain('src/renderer/src/components');
    expect(paths).toContain('src/preload');
    // …and the four levels did NOT each become a row.
    expect(paths).not.toContain('src/renderer');
    expect(paths).not.toContain('src/renderer/src');
  });

  it('⚠️ A FOLDER ROW IS A REAL button WITH `aria-expanded`', async () => {
    // §5.32 rule 1, and the lesson the file row already records: a clickable
    // `div` means Enter, Space, focus and the announcement all have to be
    // reimplemented, and none of them ever are.
    await mount(nested);
    await click(one('[data-testid="scm-mode-tree"]'));
    const folder = one('.scm-tree-folder');
    expect(folder?.tagName).toBe('BUTTON');
    expect(folder?.getAttribute('aria-expanded')).toBe('true');
    expect(folder?.getAttribute('aria-label')).toContain('changed file');
  });

  it('a folder folds and unfolds, and SAYS how much is hidden while folded', async () => {
    await mount(nested);
    await click(one('[data-testid="scm-mode-tree"]'));
    const before = all('.scm-row').length;
    const src = one('.scm-tree-folder[data-path="src"]');
    expect(src?.querySelector('.scm-tree-count')?.textContent).toBe('3');
    await click(src);
    expect(one('.scm-tree-folder[data-path="src"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(all('.scm-row').length).toBeLessThan(before);
    // the count survives the fold — a collapsed folder never understates
    expect(one('.scm-tree-folder[data-path="src"] .scm-tree-count')?.textContent).toBe('3');
    await click(one('.scm-tree-folder[data-path="src"]'));
    expect(all('.scm-row').length).toBe(before);
  });

  it('⚠️ THE TWO MODES SHARE THE FILE ROW — same letter, same name, same verbs', async () => {
    // A second row component would be a second place for the letter, the
    // name-first split, the hover verbs and the selection to drift.
    await mount(nested);
    await click(one('[data-testid="scm-mode-tree"]'));
    const row = one('.scm-row[data-path="src/preload/index.ts"]');
    expect(row).not.toBeNull();
    expect(row?.querySelector('.scm-letter')?.textContent).toBe('M');
    expect(row?.querySelector('.scm-name')?.textContent).toBe('index.ts');
    expect(row?.querySelector('.scm-row-acts')).not.toBeNull();
    await click(row?.querySelector('.scm-row-open'));
    expect(selected).toEqual(['src/preload/index.ts']);
  });

  it('⚠️ AND IT STOPS REPEATING THE DIRECTORY, because the folder is the row above', async () => {
    await mount(nested);
    // flat: the directory is the whole reason the row has a second half
    expect(one('.scm-row[data-path="src/preload/index.ts"] .scm-dir')).not.toBeNull();
    await click(one('[data-testid="scm-mode-tree"]'));
    expect(one('.scm-row[data-path="src/preload/index.ts"] .scm-dir')).toBeNull();
  });

  it('indents by depth, and STOPS indenting before the filename pays for it', async () => {
    await mount({
      isRepo: true,
      files: [file({ path: 'a/b/c/d/e/f/g/h/i/deep.ts', xy: '.M' })],
    });
    await click(one('[data-testid="scm-mode-tree"]'));
    // one compressed folder row at depth 0, so the file sits at depth 1
    const row = one('.scm-row[data-path="a/b/c/d/e/f/g/h/i/deep.ts"]');
    expect(row?.getAttribute('data-depth')).toBe('1');
    // and the cap holds: nothing is pushed past six levels of indent
    const px = Number((row?.style.paddingInlineStart ?? '0px').replace('px', ''));
    expect(px).toBeLessThanOrEqual(6 * 9);
  });

  it('a root-only change set grows no folders in either mode', async () => {
    await mount({ isRepo: true, files: [file({ path: 'PROGRESS.md', xy: '.M' })] });
    await click(one('[data-testid="scm-mode-tree"]'));
    expect(all('.scm-tree-folder')).toHaveLength(0);
    expect(all('.scm-row')).toHaveLength(1);
  });

  it('⚠️ THE FILTER STILL WORKS, and the tree is built from what SURVIVES it', async () => {
    // The tree is of the filtered rows, not of the repository: a folder row for a
    // directory whose only file the filter hid would be a count of nothing.
    await mount(nested);
    await click(one('[data-testid="scm-mode-tree"]'));
    await typeIntoFilter('preload');
    const paths = all('.scm-tree-folder').map((el) => el.getAttribute('data-path'));
    expect(paths).toContain('src/preload');
    expect(paths).not.toContain('src/renderer/src/components');
    expect(all('.scm-row')).toHaveLength(1);
  });

  it('the mode is a WORKSPACE preference, so a remount comes back in it', async () => {
    await mount(nested);
    await click(one('[data-testid="scm-mode-tree"]'));
    const r = root;
    root = null;
    await act(async () => r?.unmount());
    document.body.innerHTML = '';
    await mount(nested);
    expect(one('[data-testid="scm-mode-tree"]')?.getAttribute('aria-checked')).toBe('true');
    expect(all('.scm-tree-folder').length).toBeGreaterThan(0);
  });
});

// Item 9's entry point lives in the same toolbar, so it is tested here rather
// than in a third file about one button.
describe('the all-changes entry point (E24 Git v2 item 9)', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    selected.length = 0;
    await initI18nForTests();
    stubUi();
    await loadUiState();
    resetAllChangesOpener();
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      root = null;
      await act(async () => r.unmount());
    }
    document.body.innerHTML = '';
    resetAllChangesOpener();
    delete (window as unknown as { switchboard?: unknown }).switchboard;
  });

  it('⚠️ ⧉ OPENS THE ALL-CHANGES PANEL, and is ABSENT with nowhere to open it', async () => {
    // Item 9's entry point, in screen 2's own place for it. Absent rather than
    // dead is the owner's rule, applied to a toolbar button this time.
    await mount({ isRepo: true, files: [file({ path: 'a.ts', xy: '.M' })] });
    expect(one('[data-testid="scm-all-changes"]')).toBeNull();
    const asked: Array<[string, string]> = [];
    setAllChangesOpener((cardId, folder) => asked.push([cardId, folder]));
    const r = root;
    root = null;
    await act(async () => r?.unmount());
    document.body.innerHTML = '';
    await mountWithCard({ isRepo: true, files: [file({ path: 'a.ts', xy: '.M' })] });
    await click(one('[data-testid="scm-all-changes"]'));
    expect(asked).toEqual([['card-1', FOLDER]]);
    resetAllChangesOpener();
  });
});

// The write verbs in the sidebar (E24 Git v2 item 12).
//
// `lib/git-write.test.ts` owns the seam — the refusals, the bad payloads, what a
// confirm has to say. This file owns what only a mounted sidebar answers, and the
// most important of those is a NEGATIVE: **a discard cannot happen without a
// confirm.** It is the only operation in the app that destroys work no other copy
// of exists, and the only thing between a stray click and a deleted file is the
// dialog — so the test that matters is the one where the user says no.
describe('the write verbs (E24 Git v2 item 12)', () => {
  let asked: Array<{ verb: string; paths: readonly string[] }>;
  let answer: { ok: boolean; reason?: string; applied: number };
  let confirms: string[];
  let says: boolean;
  let refreshes: number;

  /** A bridge that records, and answers whatever `answer` currently is. */
  function writeBridge(): void {
    const verb =
      (name: string) =>
      (_folder: string, paths: readonly string[]): Promise<unknown> => {
        asked.push({ verb: name, paths });
        return Promise.resolve(answer);
      };
    (window as unknown as { switchboard: unknown }).switchboard = {
      workspace: { getUi: async () => ({}), setUi: () => undefined },
      git: { stage: verb('stage'), unstage: verb('unstage'), discard: verb('discard') },
    };
  }

  async function mountWritable(status: GitStatusDto | null): Promise<void> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <ScmSidebar
          folder={FOLDER}
          status={status}
          selected={null}
          onSelect={(p) => selected.push(p)}
          onRefresh={() => void refreshes++}
          cardId="card-1"
          onConfirm={(m) => {
            confirms.push(m);
            return says;
          }}
        />
      );
    });
  }

  const dirty: GitStatusDto = {
    isRepo: true,
    files: [
      file({ path: 'staged.ts', staged: true, unstaged: false, xy: 'M.' }),
      file({ path: 'mod.ts', xy: '.M' }),
      file({ path: 'new.ts', untracked: true, xy: '??' }),
    ],
  };

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    selected.length = 0;
    asked = [];
    confirms = [];
    says = true;
    refreshes = 0;
    answer = { ok: true, applied: 1 };
    await initI18nForTests();
    writeBridge();
    await loadUiState();
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      root = null;
      await act(async () => r.unmount());
    }
    document.body.innerHTML = '';
    delete (window as unknown as { switchboard?: unknown }).switchboard;
  });

  it('stages one file from its row (the done-when)', async () => {
    await mountWritable(dirty);
    await click(one('.scm-row[data-path="mod.ts"] [data-testid="scm-row-stage"]'));
    expect(asked).toEqual([{ verb: 'stage', paths: ['mod.ts'] }]);
    // ⚠️ AND IT REFRESHES: nothing watches a repository, so without this the row
    // stays in the same group with the same letter and a second click repeats it.
    expect(refreshes).toBe(1);
  });

  it('⚠️ WHICH VERBS A ROW GETS DEPENDS ON ITS GROUP', async () => {
    // A staged row can only be UNSTAGED: a ＋ would be a button for something
    // already done, and a ↶ would discard a change the user deliberately kept.
    await mountWritable(dirty);
    const staged = '.scm-row[data-path="staged.ts"] ';
    expect(one(`${staged}[data-testid="scm-row-unstage"]`)).not.toBeNull();
    expect(one(`${staged}[data-testid="scm-row-stage"]`)).toBeNull();
    expect(one(`${staged}[data-testid="scm-row-discard"]`)).toBeNull();
    const mod = '.scm-row[data-path="mod.ts"] ';
    expect(one(`${mod}[data-testid="scm-row-stage"]`)).not.toBeNull();
    expect(one(`${mod}[data-testid="scm-row-discard"]`)).not.toBeNull();
    expect(one(`${mod}[data-testid="scm-row-unstage"]`)).toBeNull();
  });

  it('⚠️⚠️ A DISCARD ASKS FIRST, AND "NO" MEANS NOTHING HAPPENS', async () => {
    // ⚠️ **THE MOST IMPORTANT TEST IN THIS ITEM.** `clean` on an untracked file
    // destroys work that is in no index, no commit and no reflog. The dialog is
    // the only thing between a stray click and that, so the case that must hold
    // is the one where the user declines.
    says = false;
    await mountWritable(dirty);
    await click(one('.scm-row[data-path="new.ts"] [data-testid="scm-row-discard"]'));
    expect(confirms).toHaveLength(1);
    expect(asked).toEqual([]);
    expect(refreshes).toBe(0);
  });

  it('…and "yes" discards exactly what was named', async () => {
    await mountWritable(dirty);
    await click(one('.scm-row[data-path="new.ts"] [data-testid="scm-row-discard"]'));
    expect(asked).toEqual([{ verb: 'discard', paths: ['new.ts'] }]);
  });

  it('⚠️ THE CONFIRM NAMES THE FILE for one, and the COUNT for a group', async () => {
    // Design §4 item 12 verbatim: "Discard is destructive: confirm, naming the
    // file count." A group heading can mean forty files and does not say which.
    await mountWritable({
      isRepo: true,
      files: [file({ path: 'mod.ts', xy: '.M' }), file({ path: 'other.ts', xy: '.M' })],
    });
    await click(one('.scm-row[data-path="mod.ts"] [data-testid="scm-row-discard"]'));
    expect(confirms[0]).toContain('mod.ts');
    confirms.length = 0;
    // ⚠️ TWO files, because the wording SWITCHES on the count: one file is named,
    // because that is the most useful thing to be told, and many get a count,
    // because a list of forty names in a dialog is a wall nobody reads. A
    // one-file group would exercise the first branch again and prove nothing.
    await click(one('.scm-group-unstaged [data-testid="scm-group-discard"]'));
    expect(confirms[0]).toContain('2 files');
    expect(confirms[0]).not.toContain('mod.ts');
  });

  it('a group verb acts on every row in THAT group and no other', async () => {
    await mountWritable({
      isRepo: true,
      files: [
        file({ path: 'a.ts', xy: '.M' }),
        file({ path: 'b.ts', xy: '.M' }),
        file({ path: 'staged.ts', staged: true, unstaged: false, xy: 'M.' }),
      ],
    });
    await click(one('.scm-group-unstaged [data-testid="scm-group-stage"]'));
    expect(asked).toEqual([{ verb: 'stage', paths: ['a.ts', 'b.ts'] }]);
  });

  it('⚠️ A MERGE CONFLICT GETS NO WRITE VERBS AT ALL, on the row or the group', async () => {
    // Every verb is ambiguous on a conflict — take ours, take theirs, abandon the
    // merge — and main refuses them by name. Drawing one would be exactly the
    // dead control this whole item exists to stop drawing.
    await mountWritable({
      isRepo: true,
      files: [file({ path: 'clash.ts', conflicted: true, staged: true, unstaged: true, xy: 'UU' })],
    });
    expect(one('.scm-group-merge')).not.toBeNull();
    expect(one('.scm-group-merge [data-testid="scm-group-stage"]')).toBeNull();
    expect(one('.scm-group-merge [data-testid="scm-group-discard"]')).toBeNull();
    expect(one('.scm-row[data-path="clash.ts"] [data-testid="scm-row-stage"]')).toBeNull();
    expect(one('.scm-row[data-path="clash.ts"] [data-testid="scm-row-discard"]')).toBeNull();
  });

  it('⚠️ A FAILED WRITE SAYS SO, IN GIT’S OWN WORDS, and still refreshes', async () => {
    // The whole difference from a read: a refused read leaves a pane drawing
    // nothing, while a refused write leaves this list drawing a change it thinks
    // it removed, beside a button that looked like it worked.
    answer = { ok: false, reason: 'fatal: Unable to create index.lock: File exists', applied: 0 };
    await mountWritable(dirty);
    await click(one('.scm-row[data-path="mod.ts"] [data-testid="scm-row-stage"]'));
    const said = one('.scm-write-error');
    expect(said?.textContent).toContain('index.lock');
    expect(said?.getAttribute('role')).toBe('status');
    // refreshed anyway: a discard is two commands, so a partial failure still
    // changed the tree and the list has to catch up with what is really there
    expect(refreshes).toBe(1);
  });

  it('…and the next write that works clears it', async () => {
    answer = { ok: false, reason: 'git refused', applied: 0 };
    await mountWritable(dirty);
    await click(one('.scm-row[data-path="mod.ts"] [data-testid="scm-row-stage"]'));
    expect(one('.scm-write-error')).not.toBeNull();
    answer = { ok: true, applied: 1 };
    await click(one('.scm-row[data-path="mod.ts"] [data-testid="scm-row-stage"]'));
    expect(one('.scm-write-error')).toBeNull();
  });

  it('⚠️ WITH NO WRITE BRIDGE THE BUTTONS ARE ABSENT, not disabled', async () => {
    // The owner's own rule, and the reason the scope was layers 1 AND 2 together:
    // "a row with a `＋` that does nothing is worse than a row with no `＋`".
    (window as unknown as { switchboard: unknown }).switchboard = {
      workspace: { getUi: async () => ({}), setUi: () => undefined },
    };
    await mountWritable(dirty);
    expect(one('[data-testid="scm-row-stage"]')).toBeNull();
    expect(one('[data-testid="scm-row-discard"]')).toBeNull();
    expect(one('[data-testid="scm-group-stage"]')).toBeNull();
    // …and the three READ verbs are still there, so the slot did not vanish.
    expect(one('.scm-row[data-path="mod.ts"] .scm-row-acts')).not.toBeNull();
  });

  it('the group heading is still a real button, and is not nested in another one', async () => {
    // A `<button>` inside a `<button>` is invalid HTML — browsers reparent it, so
    // the inner one ends up outside and the layout silently breaks. The verbs are
    // siblings of the heading for that reason.
    await mountWritable(dirty);
    const head = one('.scm-group-unstaged .scm-group-head');
    expect(head?.tagName).toBe('BUTTON');
    expect(head?.querySelector('button')).toBeNull();
    expect(one('.scm-group-unstaged .scm-group-acts')).not.toBeNull();
  });
});
