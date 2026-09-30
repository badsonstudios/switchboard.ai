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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { FileTree, type ListDir } from './FileTree';
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

  it('an answer that lands after unmount is dropped, not set on a dead root', async () => {
    let settle: (r: DirListResult) => void = () => {};
    const list: ListDir = () => new Promise<DirListResult>((res) => (settle = res));
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount(list);
    const r = root;
    root = null;
    await act(async () => r!.unmount());
    await act(async () => {
      settle(ok([entry('late', 'file')]));
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the tree as a tree (§5.32)', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    opened.length = 0;
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
});
