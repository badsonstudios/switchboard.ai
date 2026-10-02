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

// The commit box (E24 Git v2 item 13).
//
// ⚠️ **"ONE COMMIT PATH, NOT TWO" IS A CLAIM ABOUT WHAT IS ON SCREEN, so it is
// asserted here rather than left to the comment.** Amend, sign-off and no-verify
// are modifiers behind the ⋯; there is exactly one button that commits. Two
// primary buttons that both commit is how somebody amends by accident, and an
// amend rewrites history.
//
// The other thing only a mounted box can answer: **the draft survives.** The list
// below it re-reads after every stage and every discard, so a half-typed message
// is at the mercy of every refresh unless it lives somewhere that does not.
describe('the commit box (E24 Git v2 item 13)', () => {
  let committed: Array<{ message: string; opts: unknown }>;
  let answer: { ok: boolean; reason?: string; applied: number };
  let refreshes: number;

  function commitBridge(): void {
    (window as unknown as { switchboard: unknown }).switchboard = {
      workspace: { getUi: async () => ({}), setUi: () => undefined },
      git: {
        stage: async () => answer,
        unstage: async () => answer,
        discard: async () => answer,
        commit: async (_f: string, message: string, opts: unknown) => {
          committed.push({ message, opts });
          return answer;
        },
      },
    };
  }

  async function mountCommit(status: GitStatusDto | null): Promise<void> {
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
          onConfirm={() => true}
        />
      );
    });
  }

  /** Type into the message box, through the prototype setter React tracks. */
  async function type(value: string): Promise<void> {
    const box = one('.scm-commit-message') as HTMLTextAreaElement | null;
    const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    await act(async () => {
      if (!box) return;
      d?.set?.call(box, value);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  /**
   * Tick one of the ⋯ checkboxes.
   *
   * ⚠️ **A PLAIN CLICK, AND NOTHING ELSE.** Setting `.checked` first and then
   * dispatching defeats React's change tracking — it sees the DOM already
   * agreeing with what it would have written, so `onChange` never fires and the
   * flag is silently never set. jsdom runs the checkbox's own activation
   * behaviour on a click, which toggles `.checked` and fires the event React is
   * listening for. Three tests here were written the other way and all three
   * failed, which is the one shape of this mistake that announces itself.
   */
  async function tick(id: string): Promise<void> {
    await click(one(`[data-testid="${id}"]`));
  }

  const withStaged: GitStatusDto = {
    isRepo: true,
    files: [
      file({ path: 'a.ts', staged: true, unstaged: false, xy: 'M.' }),
      file({ path: 'b.ts', staged: true, unstaged: false, xy: 'A.' }),
    ],
  };
  const nothingStaged: GitStatusDto = {
    isRepo: true,
    files: [file({ path: 'c.ts', xy: '.M' })],
  };

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    selected.length = 0;
    committed = [];
    refreshes = 0;
    answer = { ok: true, applied: 1 };
    await initI18nForTests();
    commitBridge();
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

  it('commits the message that was typed (the done-when)', async () => {
    await mountCommit(withStaged);
    await type('a real subject');
    await click(one('[data-testid="scm-commit"]'));
    expect(committed).toHaveLength(1);
    expect(committed[0].message).toBe('a real subject');
    expect(refreshes).toBe(1);
  });

  it('⚠️ ONE BUTTON COMMITS, and the modifiers are behind the ⋯', async () => {
    // "E24's own rule": amend is never a second primary button, because two
    // buttons that both commit is how somebody rewrites history by accident.
    await mountCommit(withStaged);
    expect(all('[data-testid="scm-commit"]')).toHaveLength(1);
    // the options are not even rendered until the ⋯ is pressed
    expect(one('[data-testid="scm-commit-amend"]')).toBeNull();
    await click(one('[data-testid="scm-commit-options"]'));
    expect(one('[data-testid="scm-commit-amend"]')).not.toBeNull();
    expect(one('[data-testid="scm-commit-signoff"]')).not.toBeNull();
    expect(one('[data-testid="scm-commit-noVerify"]')).not.toBeNull();
    // …and still exactly one thing that commits
    expect(all('[data-testid="scm-commit"]')).toHaveLength(1);
  });

  it('the ⋯ options reach git as flags, not as a second command', async () => {
    await mountCommit(withStaged);
    await click(one('[data-testid="scm-commit-options"]'));
    await tick('scm-commit-signoff');
    await type('signed please');
    await click(one('[data-testid="scm-commit"]'));
    expect(committed[0].opts).toMatchObject({ signoff: true });
  });

  it('⚠️ THE BUTTON IS OFF WITH NO MESSAGE, AND SAYS WHY', async () => {
    // A disabled button that does not say why is a dead end — and the two
    // reasons have different fixes.
    await mountCommit(withStaged);
    const btn = one('[data-testid="scm-commit"]') as HTMLButtonElement | null;
    expect(btn?.disabled).toBe(true);
    expect(btn?.getAttribute('aria-label')).toContain('message');
    await type('now there is one');
    expect((one('[data-testid="scm-commit"]') as HTMLButtonElement | null)?.disabled).toBe(false);
  });

  it('⚠️ AND OFF WITH NOTHING STAGED, with the OTHER reason', async () => {
    await mountCommit(nothingStaged);
    await type('a message with nothing to commit');
    const btn = one('[data-testid="scm-commit"]') as HTMLButtonElement | null;
    expect(btn?.disabled).toBe(true);
    expect(btn?.getAttribute('aria-label')).toContain('Stage something');
  });

  it('⚠️ EXCEPT WHEN AMENDING, which is the commonest use of amend', async () => {
    // Measured against real git: `commit --amend` with an empty index succeeds —
    // it replaces the message. A button disabled on "nothing staged" would make
    // fixing a message you just wrote impossible.
    await mountCommit(nothingStaged);
    await type('fixing the last message');
    expect((one('[data-testid="scm-commit"]') as HTMLButtonElement | null)?.disabled).toBe(true);
    await click(one('[data-testid="scm-commit-options"]'));
    await tick('scm-commit-amend');
    expect((one('[data-testid="scm-commit"]') as HTMLButtonElement | null)?.disabled).toBe(false);
  });

  it('⚠️ AMEND IS ANNOUNCED AFTER THE MENU CLOSES — the mode outlives the menu', async () => {
    // Somebody who ticked amend, shut the ⋯ and then pressed a button reading
    // "Commit" would rewrite a commit without being reminded.
    await mountCommit(withStaged);
    await click(one('[data-testid="scm-commit-options"]'));
    await tick('scm-commit-amend');
    await click(one('[data-testid="scm-commit-options"]'));
    expect(one('.scm-amend-on')).not.toBeNull();
    // …and the button itself says so too, rather than reading "Commit 2 files"
    expect(one('[data-testid="scm-commit"]')?.textContent).toContain('Amend');
  });

  it('the button names what a commit will CAPTURE', async () => {
    await mountCommit(withStaged);
    expect(one('[data-testid="scm-commit"]')?.textContent).toContain('2 staged files');
  });

  it('⚠️ THE COUNT IGNORES THE FILTER, because `git commit` does', async () => {
    // The totals bar follows the filter — that was an item 6 review finding. A
    // commit does not: it captures the whole index whatever the box is showing,
    // so a count that followed the filter would promise three files and commit
    // thirty.
    await mountCommit(withStaged);
    await typeIntoFilter('a.ts');
    expect(all('.scm-row')).toHaveLength(1);
    expect(one('[data-testid="scm-commit"]')?.textContent).toContain('2 staged files');
  });

  it('⚠️⚠️ A FAILED COMMIT KEEPS THE MESSAGE — losing it would be unforgivable', async () => {
    // A hook said no, or nothing was staged. The user's words are the one thing
    // in this box that cannot be reconstructed.
    answer = { ok: false, reason: 'LINT FAILED: two problems', applied: 0 };
    await mountCommit(withStaged);
    await type('a message worth keeping');
    await click(one('[data-testid="scm-commit"]'));
    expect((one('.scm-commit-message') as HTMLTextAreaElement | null)?.value).toBe(
      'a message worth keeping'
    );
    // …and the reason is on screen, in git's own words
    expect(one('.scm-write-error')?.textContent).toContain('LINT FAILED');
  });

  it('…and a SUCCESSFUL one clears the box and says what landed', async () => {
    await mountCommit(withStaged);
    await type('this one works');
    await click(one('[data-testid="scm-commit"]'));
    expect((one('.scm-commit-message') as HTMLTextAreaElement | null)?.value).toBe('');
    expect(one('.scm-commit-said')?.textContent).toContain('Committed');
  });

  it('⚠️ Ctrl+Enter COMMITS and plain Enter DOES NOT', async () => {
    // A commit message has a body as often as not, so Enter has to be a newline.
    await mountCommit(withStaged);
    await type('by keyboard');
    const box = one('.scm-commit-message');
    await act(async () => {
      box?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(committed).toHaveLength(0);
    await act(async () => {
      box?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
      );
    });
    expect(committed).toHaveLength(1);
  });

  it('⚠️ NO COMMIT CHANNEL MEANS NO BOX AT ALL, not a dead button', async () => {
    // Asked separately from the row verbs: a build with the three path verbs and
    // no `commit` would otherwise draw a Commit button that cannot work.
    (window as unknown as { switchboard: unknown }).switchboard = {
      workspace: { getUi: async () => ({}), setUi: () => undefined },
      git: { stage: async () => answer, unstage: async () => answer, discard: async () => answer },
    };
    await mountCommit(withStaged);
    expect(one('.scm-commit')).toBeNull();
    // …and the row verbs are still there, so the two are really independent
    expect(one('[data-testid="scm-row-unstage"]')).not.toBeNull();
  });
});

// The hunk list (E24 Git v2 item 14).
//
// ⚠️ **THE CLAIM ONLY A MOUNTED LIST CAN ANSWER IS THAT IT RELOADS.** Staging one
// hunk MOVES the others: their line numbers shift, so a list left as it was would
// offer to stage something that is no longer where it says — and that patch is
// refused, or lands somewhere else. Everything else here is about the ⊞ being
// absent where it would be meaningless.
describe('staging part of a file (E24 Git v2 item 14)', () => {
  let reads: number;
  let applied: string[];
  let answer: { ok: boolean; reason?: string; applied: number };
  let hunkAnswer: unknown;
  let refreshes: number;

  const dto = {
    header: ['diff --git a/mod.ts b/mod.ts', '--- a/mod.ts', '+++ b/mod.ts'],
    hunks: [
      {
        header: '@@ -1,2 +1,2 @@',
        lines: ['-one', '+ONE', ' two'],
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 2,
      },
      {
        header: '@@ -9,2 +9,2 @@',
        lines: [' nine', '-ten', '+TEN'],
        oldStart: 9,
        oldCount: 2,
        newStart: 9,
        newCount: 2,
      },
    ],
  };

  function hunkBridge(): void {
    (window as unknown as { switchboard: unknown }).switchboard = {
      workspace: { getUi: async () => ({}), setUi: () => undefined },
      git: {
        stage: async () => answer,
        unstage: async () => answer,
        discard: async () => answer,
        hunks: async () => {
          reads++;
          return hunkAnswer;
        },
        applyPatch: async (_f: string, patch: string) => {
          applied.push(patch);
          return answer;
        },
      },
    };
  }

  async function mountHunks(status: GitStatusDto | null): Promise<void> {
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
          onConfirm={() => true}
        />
      );
    });
  }

  const dirty: GitStatusDto = {
    isRepo: true,
    files: [
      file({ path: 'mod.ts', xy: '.M' }),
      file({ path: 'new.ts', untracked: true, xy: '??' }),
      file({ path: 'staged.ts', staged: true, unstaged: false, xy: 'M.' }),
    ],
  };

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    selected.length = 0;
    reads = 0;
    applied = [];
    refreshes = 0;
    answer = { ok: true, applied: 1 };
    hunkAnswer = dto;
    await initI18nForTests();
    hunkBridge();
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

  it('⊞ on an unstaged row lists that file’s hunks (the done-when)', async () => {
    await mountHunks(dirty);
    expect(one('.scm-hunks')).toBeNull();
    await click(one('.scm-row[data-path="mod.ts"] [data-testid="scm-row-hunks"]'));
    expect(one('.scm-hunks')).not.toBeNull();
    expect(all('.scm-hunk')).toHaveLength(2);
    // …named by WHERE and HOW MUCH, not by the `@@` line
    expect(one('.scm-hunk-label')?.textContent).toContain('line 1');
    expect(text()).not.toContain('@@ -1,2');
  });

  it('⚠️ ONLY ON AN UNSTAGED TRACKED ROW — git has no hunks for the others', async () => {
    // An untracked file has no parts to split: git has never seen it, so its
    // "diff" is nothing. A staged row's remaining change is on the OTHER side.
    await mountHunks(dirty);
    expect(one('.scm-row[data-path="mod.ts"] [data-testid="scm-row-hunks"]')).not.toBeNull();
    expect(one('.scm-row[data-path="new.ts"] [data-testid="scm-row-hunks"]')).toBeNull();
    expect(one('.scm-row[data-path="staged.ts"] [data-testid="scm-row-hunks"]')).toBeNull();
  });

  it('stages exactly the hunk whose ＋ was pressed', async () => {
    await mountHunks(dirty);
    await click(one('.scm-row[data-path="mod.ts"] [data-testid="scm-row-hunks"]'));
    await click(all('.scm-hunk')[1].querySelector('[data-testid="scm-hunk-stage"]'));
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain('+TEN');
    expect(applied[0]).not.toContain('+ONE');
  });

  it('⚠️⚠️ AND RELOADS AFTERWARDS, because staging one hunk MOVES the others', async () => {
    // ⚠️ **THE CLAIM ONLY A MOUNTED LIST CAN MAKE.** Their line numbers shift, so
    // a list left as it was offers to stage something no longer where it says —
    // and that patch is refused, or lands somewhere else.
    await mountHunks(dirty);
    await click(one('.scm-row[data-path="mod.ts"] [data-testid="scm-row-hunks"]'));
    expect(reads).toBe(1);
    await click(one('[data-testid="scm-hunk-stage"]'));
    expect(reads).toBe(2);
    // …and the file list is refreshed too, so the groups catch up
    expect(refreshes).toBe(1);
  });

  it('…and reloads even when the apply FAILED, because the tree may have moved anyway', async () => {
    answer = { ok: false, reason: 'error: patch does not apply', applied: 0 };
    await mountHunks(dirty);
    await click(one('.scm-row[data-path="mod.ts"] [data-testid="scm-row-hunks"]'));
    await click(one('[data-testid="scm-hunk-stage"]'));
    expect(reads).toBe(2);
    expect(text()).toContain('does not apply');
  });

  it('⚠️ NOTHING LEFT TO STAGE IS A SENTENCE, not an empty box', async () => {
    hunkAnswer = { header: [], hunks: [] };
    await mountHunks(dirty);
    await click(one('.scm-row[data-path="mod.ts"] [data-testid="scm-row-hunks"]'));
    expect(one('.scm-hunks-none')).not.toBeNull();
    expect(all('.scm-hunk')).toHaveLength(0);
  });

  it('⚠️ AND A REFUSAL IS NOT THE SAME AS "no hunks"', async () => {
    // A surface that drew the same thing for both would tell a user their change
    // had vanished.
    hunkAnswer = null;
    await mountHunks(dirty);
    await click(one('.scm-row[data-path="mod.ts"] [data-testid="scm-row-hunks"]'));
    expect(one('.scm-hunks-none')).toBeNull();
    expect(one('.scm-hunks')?.textContent).toContain("Couldn't read");
  });

  it('pressing ⊞ again closes it, and the ✕ closes it too', async () => {
    await mountHunks(dirty);
    const open = (): Promise<void> =>
      click(one('.scm-row[data-path="mod.ts"] [data-testid="scm-row-hunks"]'));
    await open();
    expect(one('.scm-hunks')).not.toBeNull();
    await open();
    expect(one('.scm-hunks')).toBeNull();
    await open();
    await click(one('[data-testid="scm-hunks-close"]'));
    expect(one('.scm-hunks')).toBeNull();
  });

  it('⚠️ SWITCHING FILES REMOUNTS THE LIST, so it is never another file’s hunks', async () => {
    await mountHunks({
      isRepo: true,
      files: [file({ path: 'mod.ts', xy: '.M' }), file({ path: 'other.ts', xy: '.M' })],
    });
    await click(one('.scm-row[data-path="mod.ts"] [data-testid="scm-row-hunks"]'));
    expect(reads).toBe(1);
    await click(one('.scm-row[data-path="other.ts"] [data-testid="scm-row-hunks"]'));
    // a fresh read for the new file rather than the old list left on screen
    expect(reads).toBe(2);
    expect(one('.scm-hunks')?.textContent).toContain('other.ts');
  });

  it('⚠️ WITH NO HUNK CHANNELS THE ⊞ IS ABSENT, not dead', async () => {
    (window as unknown as { switchboard: unknown }).switchboard = {
      workspace: { getUi: async () => ({}), setUi: () => undefined },
      git: { stage: async () => answer, unstage: async () => answer, discard: async () => answer },
    };
    await mountHunks(dirty);
    expect(one('[data-testid="scm-row-hunks"]')).toBeNull();
    // …and the other row verbs are still there, so the two are independent
    expect(one('.scm-row[data-path="mod.ts"] [data-testid="scm-row-stage"]')).not.toBeNull();
  });
});

// The sync verbs in the header (E24 Git v2 item 15).
//
// ⚠️ **ITEMS 2 AND 6 BOTH DREW THOSE COUNTS WITH NO BUTTONS AND SAID SO** —
// *"Pull and Push come with the branch/sync item"* — which is the owner's rule
// about a control that does nothing, applied to a number. These tests are that
// promise being kept, and the thing they most need to pin is that each verb is
// ABSENT when it would do nothing rather than greyed.
describe('the sync verbs (E24 Git v2 item 15)', () => {
  let calls: string[];
  let answer: { ok: boolean; reason?: string; applied: number };
  let refreshes: number;

  function syncBridge(): void {
    const verb =
      (name: string) =>
      (): Promise<unknown> => {
        calls.push(name);
        return Promise.resolve(answer);
      };
    (window as unknown as { switchboard: unknown }).switchboard = {
      workspace: { getUi: async () => ({}), setUi: () => undefined },
      git: {
        stage: verb('stage'),
        unstage: verb('unstage'),
        discard: verb('discard'),
        fetch: verb('fetch'),
        pull: verb('pull'),
        push: verb('push'),
        checkout: verb('checkout'),
        createBranch: verb('createBranch'),
      },
    };
  }

  async function mountSync(status: GitStatusDto | null): Promise<void> {
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
          onConfirm={() => true}
        />
      );
    });
  }

  const withCounts = (ahead: number, behind: number): GitStatusDto => ({
    isRepo: true,
    branch: 'main',
    ahead,
    behind,
    files: [file({ path: 'a.ts', xy: '.M' })],
  });

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    selected.length = 0;
    calls = [];
    refreshes = 0;
    answer = { ok: true, applied: 1 };
    await initI18nForTests();
    syncBridge();
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

  it('⟳ fetches, and the list refreshes afterwards (the done-when)', async () => {
    // A fetch changes `ahead`/`behind` without touching a file, and those two
    // numbers are the only thing on screen that would show it happened.
    await mountSync(withCounts(0, 0));
    await click(one('[data-testid="scm-fetch"]'));
    expect(calls).toEqual(['fetch']);
    expect(refreshes).toBe(1);
  });

  it('⚠️ ↓ AND ↑ ARE ABSENT WHEN THEY WOULD DO NOTHING, not greyed', async () => {
    await mountSync(withCounts(0, 0));
    expect(one('[data-testid="scm-fetch"]')).not.toBeNull();
    expect(one('[data-testid="scm-pull"]')).toBeNull();
    expect(one('[data-testid="scm-push"]')).toBeNull();
  });

  it('…and each appears with the count it acts on', async () => {
    await mountSync(withCounts(3, 1));
    expect(one('[data-testid="scm-pull"]')?.getAttribute('aria-label')).toContain('1 commit');
    expect(one('[data-testid="scm-push"]')?.getAttribute('aria-label')).toContain('3 commits');
    await click(one('[data-testid="scm-pull"]'));
    await click(one('[data-testid="scm-push"]'));
    expect(calls).toEqual(['pull', 'push']);
  });

  it('⚠️ A REFUSAL IS SHOWN IN GIT’S OWN WORDS', async () => {
    // For these five, git's refusal is usually the most useful thing on screen:
    // "Not possible to fast-forward" tells the user exactly what to do next.
    answer = { ok: false, reason: 'fatal: Not possible to fast-forward, aborting.', applied: 0 };
    await mountSync(withCounts(1, 1));
    await click(one('[data-testid="scm-pull"]'));
    expect(one('.scm-write-error')?.textContent).toContain('fast-forward');
  });

  it('⚠️⚠️ "PUBLISH THIS BRANCH" APPEARS ONLY ONCE GIT HAS SAID THAT IS THE GAP', async () => {
    // ⚠️ **AND IT IS A SECOND, EXPLICIT PRESS — never an automatic retry.** A push
    // that failed for want of an upstream is a different thing from one that
    // failed because somebody else pushed first, and quietly adding
    // `--set-upstream` would PUBLISH a branch the user had not decided to publish.
    answer = {
      ok: false,
      reason: 'fatal: The current branch side has no upstream branch.',
      applied: 0,
    };
    await mountSync(withCounts(2, 0));
    expect(one('[data-testid="scm-publish"]')).toBeNull();
    await click(one('[data-testid="scm-push"]'));
    expect(one('[data-testid="scm-publish"]')).not.toBeNull();
    // the push was NOT retried with the flag behind the user's back
    expect(calls).toEqual(['push']);
    // …and pressing publish is the second press
    answer = { ok: true, applied: 1 };
    await click(one('[data-testid="scm-publish"]'));
    expect(calls).toEqual(['push', 'push']);
    // …and the offer is withdrawn the moment it is no longer true
    expect(one('[data-testid="scm-publish"]')).toBeNull();
  });

  it('⚠️ THE BUTTONS DISABLE WHILE A SYNC IS IN FLIGHT', async () => {
    // These are the only commands in the app that reach somebody else's server,
    // so they can take seconds — and a button that does not show it is busy gets
    // pressed again. A second push while the first is in flight is two pushes.
    let release: (v: unknown) => void = () => undefined;
    (window as unknown as { switchboard: { git: Record<string, unknown> } }).switchboard.git.fetch =
      () =>
        new Promise((r) => {
          release = r;
        });
    await mountSync(withCounts(1, 1));
    await click(one('[data-testid="scm-fetch"]'));
    expect((one('[data-testid="scm-fetch"]') as HTMLButtonElement | null)?.disabled).toBe(true);
    expect((one('[data-testid="scm-pull"]') as HTMLButtonElement | null)?.disabled).toBe(true);
    await act(async () => release({ ok: true, applied: 1 }));
    expect((one('[data-testid="scm-fetch"]') as HTMLButtonElement | null)?.disabled).toBe(false);
  });

  it('⚠️ WITH NO SYNC CHANNELS THERE ARE NO SYNC BUTTONS, not dead ones', async () => {
    (window as unknown as { switchboard: unknown }).switchboard = {
      workspace: { getUi: async () => ({}), setUi: () => undefined },
      git: { stage: async () => answer, unstage: async () => answer, discard: async () => answer },
    };
    await mountSync(withCounts(2, 2));
    expect(one('[data-testid="scm-fetch"]')).toBeNull();
    expect(one('[data-testid="scm-pull"]')).toBeNull();
    expect(one('[data-testid="scm-push"]')).toBeNull();
    // …and the COUNTS are still drawn, which is what items 2 and 6 shipped
    expect(one('.scm-ahead')).not.toBeNull();
    expect(one('.scm-behind')).not.toBeNull();
  });
});
