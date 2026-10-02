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

const one = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel);
const all = (sel: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(sel)];
const text = (): string => document.body.textContent ?? '';

async function click(el: Element | null | undefined): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
    const box = one('.scm-filter') as HTMLInputElement;
    // Through the prototype's setter, wrapped: React tracks the last value it
    // wrote on the node, so a plain `box.value = x` makes the two agree and the
    // synthetic change never fires. Wrapped because an unbound method reference
    // is a lint error — `HistoryPane.test.tsx` records the same two facts.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const typeInto = async (value: string): Promise<void> => {
      await act(async () => {
        descriptor?.set?.call(box, value);
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await typeInto('lib/');
    expect(all('.scm-row')).toHaveLength(1);
    await typeInto('aardvark');
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
