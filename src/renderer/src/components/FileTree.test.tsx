// @vitest-environment jsdom
// The Files tree as the user meets it (#521 layer 2).
//
// `lib/file-tree-model.test.ts` owns the RULES — which rows appear, in what
// order, at what indent. This file owns the four things only a mounted
// component can answer:
//
//   1. THE TREE DOES NOT KNOW WHERE IT LIVES. It is mounted here with four
//      props and no card, no panel, no session and no dockview — which is the
//      item's placement-agnostic requirement stated as a test rather than as a
//      comment. If this file ever needs one of those, shape B stopped being a
//      new host and became a rewrite.
//   2. Clicking a file calls out with the path, and clicking a link or a
//      device does not.
//   3. Every request declares the root, so main can refuse.
//   4. Coming back into view re-lists what is open — the whole of the refresh
//      story, since there is no directory watch in this app.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { FileTree, type ListDir } from './FileTree';
import { putGitStatus, resetGitStatusStore } from '../lib/git-status-store';
import type { DirEntry, DirListResult } from '../../../shared/ipc/fs';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const ROOT = '/proj';
let root: Root | null = null;

const entry = (name: string, kind: DirEntry['kind'], parent = ROOT): DirEntry => ({
  name,
  path: `${parent}/${name}`,
  kind,
});
const ok = (entries: DirEntry[], truncated = false, cap = 500): DirListResult => ({
  ok: true,
  path: ROOT,
  entries,
  truncated,
  cap,
});

/** A lister that records every ask, so "it declares the root" is assertable. */
function recorder(answers: Record<string, DirListResult>, fallback?: DirListResult) {
  const asked: Array<{ root: string; dir?: string }> = [];
  const list: ListDir = async (r, dir) => {
    asked.push({ root: r, dir });
    return answers[dir ?? r] ?? fallback ?? { ok: false, reason: 'not-found' };
  };
  return { list, asked };
}

const opened: string[] = [];

async function mount(list: ListDir, active = true): Promise<{ setActive: (a: boolean) => Promise<void> }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const render = async (a: boolean): Promise<void> => {
    await act(async () => {
      root!.render(
        <FileTree root={ROOT} listDir={list} active={a} onOpenFile={(p) => opened.push(p)} />
      );
    });
  };
  await render(active);
  return { setActive: render };
}

const rows = (): HTMLElement[] => [
  ...document.body.querySelectorAll<HTMLElement>('[role="treeitem"][data-path]'),
];
const rowFor = (name: string): HTMLElement | undefined =>
  rows().find((r) => r.textContent?.includes(name));
const notice = (kind: string): HTMLElement | null =>
  document.body.querySelector(`[data-testid="file-tree-notice-${kind}"]`);

async function click(el: Element | null | undefined): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}
async function key(el: Element | null | undefined, k: string): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
}

describe('the Files tree', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    opened.length = 0;
    // The shared store is module state (item 11): a status left behind by one
    // test would decorate the next one's tree.
    resetGitStatusStore();
    await initI18nForTests();
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      root = null;
      await act(async () => r.unmount());
    }
  });

  it('lists the folder it was given, and names it', async () => {
    const { list, asked } = recorder({ [ROOT]: ok([entry('src', 'dir'), entry('a.txt', 'file')]) });
    await mount(list);
    expect(rows().map((r) => r.dataset.path)).toEqual(['/proj/src', '/proj/a.txt']);
    expect(document.body.querySelector('[data-testid="file-tree-root"]')?.textContent).toBe(ROOT);
    // EVERY ask declares the root — that is what main narrows against, and a
    // request without it would be refused outright.
    expect(asked).toEqual([{ root: ROOT, dir: undefined }]);
  });

  it('expands a folder lazily — one level per click, never a walk', async () => {
    const { list, asked } = recorder({
      [ROOT]: ok([entry('src', 'dir')]),
      '/proj/src': ok([entry('index.ts', 'file', '/proj/src')]),
    });
    await mount(list);
    expect(asked).toHaveLength(1);
    await click(rowFor('src'));
    expect(asked).toEqual([
      { root: ROOT, dir: undefined },
      { root: ROOT, dir: '/proj/src' },
    ]);
    expect(rowFor('index.ts')).toBeTruthy();
    // and collapsing asks for nothing at all
    await click(rowFor('src'));
    expect(asked).toHaveLength(2);
    expect(rowFor('index.ts')).toBeFalsy();
  });

  it('clicking a FILE opens it, by absolute path', async () => {
    const { list } = recorder({ [ROOT]: ok([entry('PROGRESS.md', 'file')]) });
    await mount(list);
    await click(rowFor('PROGRESS.md'));
    expect(opened).toEqual(['/proj/PROGRESS.md']);
  });

  it('clicking a LINK or a device opens nothing — main does not follow links', async () => {
    const { list } = recorder({ [ROOT]: ok([entry('shortcut', 'link'), entry('pipe', 'other')]) });
    await mount(list);
    await click(rowFor('shortcut'));
    await click(rowFor('pipe'));
    expect(opened).toEqual([]);
    // shown, though — §5.8: you can always see what exists
    expect(rowFor('shortcut')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('says the cap out loud rather than truncating silently', async () => {
    const { list } = recorder({ [ROOT]: ok([entry('a', 'file')], true, 500) });
    await mount(list);
    expect(notice('truncated')?.textContent).toContain('500');
  });

  it('a refusal is a row with a reason, and the tree still stands', async () => {
    const { list } = recorder({}, { ok: false, reason: 'out-of-scope' });
    await mount(list);
    expect(notice('error')?.textContent).toBeTruthy();
    expect(document.body.querySelector('[data-testid="file-tree"]')).toBeTruthy();
  });

  it('a bridge that REJECTS does not take the surface with it', async () => {
    const list: ListDir = () => Promise.reject(new Error('bridge gone'));
    await mount(list);
    expect(notice('error')).toBeTruthy();
  });

  it('Refresh re-asks the root and every OPEN folder, and nothing else', async () => {
    const { list, asked } = recorder({
      [ROOT]: ok([entry('open', 'dir'), entry('shut', 'dir')]),
      '/proj/open': ok([entry('x', 'file', '/proj/open')]),
      '/proj/shut': ok([entry('y', 'file', '/proj/shut')]),
    });
    await mount(list);
    await click(rowFor('open'));
    await click(rowFor('shut'));
    await click(rowFor('shut')); // …and closed again
    asked.length = 0;
    await click(document.body.querySelector('[data-testid="file-tree-refresh"]'));
    expect(asked.map((a) => a.dir).sort()).toEqual([undefined, '/proj/open'].sort());
  });

  it('coming back into view re-lists; sitting there does not', async () => {
    // The whole refresh story: `FileWatchService` watches FILES by signature and
    // cannot tell you an entry appeared, so there is no directory watch and
    // none is claimed. This is what replaces it.
    const { list, asked } = recorder({ [ROOT]: ok([entry('a', 'file')]) });
    const { setActive } = await mount(list, true);
    expect(asked).toHaveLength(1);
    await setActive(true);
    expect(asked).toHaveLength(1); // no churn on an ordinary re-render
    await setActive(false);
    expect(asked).toHaveLength(1); // going away costs nothing
    await setActive(true);
    expect(asked).toHaveLength(2);
  });

  it('a new root is a new tree, not a refresh of the old one', async () => {
    const { list, asked } = recorder({}, ok([entry('a', 'file')]));
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<FileTree root="/one" listDir={list} onOpenFile={() => {}} />);
    });
    await act(async () => {
      root!.render(<FileTree root="/two" listDir={list} onOpenFile={() => {}} />);
    });
    expect(asked.map((a) => a.root)).toEqual(['/one', '/two']);
    expect(document.body.querySelector('[data-testid="file-tree-root"]')?.textContent).toBe('/two');
  });

  it('an answer that lands after unmount is dropped', async () => {
    // ⚠️ THIS USED TO ASSERT `console.error` WAS NOT CALLED, which proves
    // nothing: React 18 removed the unmounted-setState warning, so the test
    // passed identically with the guard deleted. What it asserts now is that the
    // late answer reached no DOM — the only observable difference.
    let settle: (r: DirListResult) => void = () => {};
    const list: ListDir = () => new Promise<DirListResult>((res) => (settle = res));
    await mount(list);
    const r = root;
    root = null;
    await act(async () => r!.unmount());
    expect(document.body.querySelector('[data-testid="file-tree"]')).toBeNull();
    await act(async () => {
      settle(ok([entry('late', 'file')]));
    });
    expect(document.body.textContent).not.toContain('late');
    expect(rows()).toHaveLength(0);
  });

  it('a SUPERSEDED refresh cannot overwrite a fresher one', async () => {
    // Two presses of Refresh, answered out of order. Without a round token,
    // round 1's listing lands after round 2's and shows older data with nothing
    // to say so.
    const pending: Array<(r: DirListResult) => void> = [];
    const list: ListDir = () => new Promise<DirListResult>((res) => pending.push(res));
    await mount(list);
    pending.shift()!(ok([entry('first', 'file')]));
    await act(async () => {});
    expect(rowFor('first')).toBeTruthy();

    const refreshBtn = document.body.querySelector('[data-testid="file-tree-refresh"]');
    await click(refreshBtn); // round 2
    await click(refreshBtn); // round 3
    const [round2, round3] = [pending.shift()!, pending.shift()!];
    // round 3 answers first…
    await act(async () => round3(ok([entry('newest', 'file')])));
    expect(rowFor('newest')).toBeTruthy();
    // …and round 2's late answer is dropped rather than rewinding the tree
    await act(async () => round2(ok([entry('stale', 'file')])));
    expect(rowFor('stale')).toBeFalsy();
    expect(rowFor('newest')).toBeTruthy();
  });

  it('a refresh re-reads UNDERNEATH what you are looking at', async () => {
    // The tree must not blank to a single "Reading…" row while a refresh is in
    // flight — the whole reason the model keeps the old entries.
    const pending: Array<(r: DirListResult) => void> = [];
    const list: ListDir = () => new Promise<DirListResult>((res) => pending.push(res));
    await mount(list);
    pending.shift()!(ok([entry('there', 'file')]));
    await act(async () => {});
    await click(document.body.querySelector('[data-testid="file-tree-refresh"]'));
    // …still on screen, with no answer yet
    expect(rowFor('there')).toBeTruthy();
    expect(notice('loading')).toBeNull();
    await act(async () => pending.shift()!(ok([entry('there', 'file'), entry('and-now', 'file')])));
    expect(rowFor('and-now')).toBeTruthy();
  });
});

describe('the tree as a tree (§5.32)', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    opened.length = 0;
    // The shared store is module state (item 11): a status left behind by one
    // test would decorate the next one's tree.
    resetGitStatusStore();
    await initI18nForTests();
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      root = null;
      await act(async () => r.unmount());
    }
  });

  it('is ONE tab stop, with the level and the open state on every row', async () => {
    const { list } = recorder({
      [ROOT]: ok([entry('src', 'dir'), entry('a.txt', 'file')]),
      '/proj/src': ok([entry('index.ts', 'file', '/proj/src')]),
    });
    await mount(list);
    expect(document.body.querySelector('[role="tree"]')?.getAttribute('aria-label')).toBeTruthy();
    // a roving tabindex: one 0, the rest -1
    expect(rows().filter((r) => r.tabIndex === 0)).toHaveLength(1);
    expect(rowFor('src')?.getAttribute('aria-expanded')).toBe('false');
    // …and a file never claims an expanded state it cannot have
    expect(rowFor('a.txt')?.hasAttribute('aria-expanded')).toBe(false);
    await click(rowFor('src'));
    expect(rowFor('src')?.getAttribute('aria-expanded')).toBe('true');
    expect(rowFor('index.ts')?.getAttribute('aria-level')).toBe('2');
  });

  it('arrow keys walk it and Enter opens', async () => {
    const { list } = recorder({
      [ROOT]: ok([entry('src', 'dir'), entry('a.txt', 'file')]),
      '/proj/src': ok([entry('index.ts', 'file', '/proj/src')]),
    });
    await mount(list);
    await key(rowFor('src'), 'ArrowRight'); // open it
    expect(rowFor('index.ts')).toBeTruthy();
    await key(rowFor('src'), 'ArrowDown');
    expect(document.activeElement).toBe(rowFor('index.ts'));
    await key(document.activeElement, 'Enter');
    expect(opened).toEqual(['/proj/src/index.ts']);
    await key(rowFor('src'), 'ArrowLeft'); // close it again
    expect(rowFor('index.ts')).toBeFalsy();
  });

  describe('VCS decorations (E24 Git v2 item 11)', () => {
    /** The decorations are INJECTED, which is how the tree stays placement-agnostic. */
    const decos = new Map([
      ['/proj/a.txt', { letter: 'M', key: 'modified' }],
      ['/proj/src', { letter: 'D', key: 'deleted', rolledUp: true }],
    ]);

    async function mountWithDecorations(list: ListDir): Promise<void> {
      const host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(
          <FileTree
            root={ROOT}
            listDir={list}
            active
            onOpenFile={(p) => opened.push(p)}
            decorations={decos}
          />
        );
      });
    }

    it('paints a letter on a changed file (the done-when)', async () => {
      const { list } = recorder({ [ROOT]: ok([entry('src', 'dir'), entry('a.txt', 'file')]) });
      await mountWithDecorations(list);
      const file = rowFor('a.txt');
      expect(file?.querySelector('.file-vcs')?.textContent).toBe('M');
      expect(file?.querySelector('.file-vcs')?.getAttribute('data-rolled-up')).toBeNull();
    });

    it('⚠️ a FOLDER says something is UNDER it, and says it differently', async () => {
      // A tree that only marked changed FILES would be useless on a collapsed
      // tree — which is how this tree starts, one level at a time — because every
      // change would hide behind an undecorated folder. And "this changed" versus
      // "something under here changed" are different facts: drawn alike, every
      // folder up to the root would read as edited.
      const { list } = recorder({ [ROOT]: ok([entry('src', 'dir'), entry('a.txt', 'file')]) });
      await mountWithDecorations(list);
      const dir = rowFor('src');
      const badge = dir?.querySelector('.file-vcs');
      expect(badge?.textContent).toBe('D');
      expect(badge?.getAttribute('data-rolled-up')).toBe('true');
      expect(badge?.getAttribute('title')).toContain('under here');
    });

    it('⚠️ NO DECORATIONS IS A TREE THAT WORKS EXACTLY AS IT DID', async () => {
      // The fail-open shape: a folder that is not a repository, a status that has
      // not arrived, a missing bridge. The tree lists files, which is its job.
      const { list } = recorder({ [ROOT]: ok([entry('a.txt', 'file')]) });
      await mount(list);
      expect(rowFor('a.txt')).toBeDefined();
      expect(document.body.querySelector('.file-vcs')).toBeNull();
    });
    it('⚠️⚠️ PAINTS BADGES WHEN MAIN RESOLVED THE ROOT TO SOMEWHERE ELSE — the bug CI found', async () => {
      // ⚠️ **THE BUG THIS PINS, AND WHY NO TEST ABOVE COULD HAVE CAUGHT IT.**
      // Every test in this block INJECTS the decoration map, so none of them goes
      // through `decorationsFor` at all — and the bug was in the KEY that function
      // builds. This one mounts without the prop, so the real path runs.
      //
      // Main answers with the directory the entries ACTUALLY came from, links
      // collapsed, and builds every entry's path from it. The GitHub Windows
      // runner's temp directory is an **8.3 short name** (`C:\Users\RUNNER~1\…`)
      // which `realpath` expands — so `props.root` and the row paths shared no
      // prefix, every key missed, and the Files tab drew NO BADGES AT ALL with no
      // error anywhere. Deterministic there, invisible on every developer machine.
      // A junction or a symlink does exactly the same thing, and this project's
      // own worktree recipe uses junctions.
      const REAL = '/real/proj';
      const { list } = recorder({
        [ROOT]: {
          ok: true,
          // the resolved path, which is NOT what we asked for
          path: REAL,
          entries: [
            { name: 'a.txt', path: `${REAL}/a.txt`, kind: 'file' },
            { name: 'src', path: `${REAL}/src`, kind: 'dir' },
          ],
          truncated: false,
          cap: 500,
        },
      });
      // The status is keyed by the folder the SESSION declared, which is correct:
      // that is the key the shared store uses everywhere.
      putGitStatus(ROOT, {
        isRepo: true,
        files: [
          { path: 'a.txt', staged: false, unstaged: true, untracked: false, xy: '.M' },
          { path: 'src/deep.ts', staged: false, unstaged: true, untracked: false, xy: '.D' },
        ],
      });
      const host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(<FileTree root={ROOT} listDir={list} active onOpenFile={() => undefined} />);
      });

      // ⭐ THE ASSERTION THAT WAS FAILING ON CI, in a unit test now.
      expect(rowFor('a.txt')?.querySelector('.file-vcs')?.textContent).toBe('M');
      // …and the folder roll-up resolves against the same root.
      const dir = rowFor('src')?.querySelector('.file-vcs');
      expect(dir?.textContent).toBe('D');
      expect(dir?.getAttribute('data-rolled-up')).toBe('true');
    });

  });
});
