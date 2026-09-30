// The Files tree's model, as a table (#521 layer 2).
//
// Everything with a layout decision in it lives in the model precisely so it
// can be tested like this — no DOM, no React, no bridge. The rows asserted
// below ARE what the view draws, in that order, including the notices.
import { describe, it, expect } from 'vitest';
import type { DirEntry, DirListResult } from '../../../shared/ipc/fs';
import {
  applyListing,
  createTree,
  invalidate,
  isExpandable,
  isExpanded,
  isOpenable,
  markLoading,
  openDirs,
  toggleDir,
  visibleRows,
} from './file-tree-model';

const ROOT = '/r';
const entry = (name: string, kind: DirEntry['kind'], parent = ROOT): DirEntry => ({
  name,
  path: `${parent}/${name}`,
  kind,
});
const ok = (entries: DirEntry[], truncated = false): DirListResult => ({
  ok: true,
  path: ROOT,
  entries,
  truncated,
  cap: 500,
});

describe('createTree', () => {
  it('starts with the root loading, so the first paint is a spinner not a blank', () => {
    const s = createTree(ROOT);
    expect(visibleRows(s)).toEqual([
      { type: 'notice', key: '/r::loading', depth: 0, notice: 'loading', path: ROOT },
    ]);
  });
});

describe('visibleRows', () => {
  it('draws a flat listing at depth 0', () => {
    const s = applyListing(createTree(ROOT), ROOT, ok([entry('src', 'dir'), entry('a.txt', 'file')]));
    expect(visibleRows(s).map((r) => [r.type, 'name' in r ? r.name : r.notice, r.depth])).toEqual([
      ['entry', 'src', 0],
      ['entry', 'a.txt', 0],
    ]);
  });

  it('a collapsed folder has no children on screen', () => {
    const s = applyListing(createTree(ROOT), ROOT, ok([entry('src', 'dir')]));
    expect(visibleRows(s)).toHaveLength(1);
    expect(visibleRows(s)[0]).toMatchObject({ type: 'entry', expanded: false });
  });

  it('an expanded folder interleaves its children one level deeper', () => {
    let s = applyListing(createTree(ROOT), ROOT, ok([entry('src', 'dir'), entry('z.txt', 'file')]));
    const t = toggleDir(s, '/r/src');
    expect(t.fetch).toBe(true);
    s = applyListing(t.state, '/r/src', ok([entry('index.ts', 'file', '/r/src')]));
    expect(visibleRows(s).map((r) => ['name' in r ? r.name : r.notice, r.depth])).toEqual([
      ['src', 0],
      ['index.ts', 1],
      ['z.txt', 0],
    ]);
  });

  it('an expanded folder still loading shows its own spinner at the child indent', () => {
    let s = applyListing(createTree(ROOT), ROOT, ok([entry('src', 'dir')]));
    s = toggleDir(s, '/r/src').state;
    expect(visibleRows(s)[1]).toMatchObject({ type: 'notice', notice: 'loading', depth: 1 });
  });

  it('the cap notice comes LAST, under the entries it is about', () => {
    const s = applyListing(createTree(ROOT), ROOT, ok([entry('a', 'file'), entry('b', 'file')], true));
    const rows = visibleRows(s);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ type: 'notice', notice: 'truncated', cap: 500, depth: 0 });
  });

  it('an empty folder says so rather than drawing nothing', () => {
    const s = applyListing(createTree(ROOT), ROOT, ok([]));
    expect(visibleRows(s)[0]).toMatchObject({ notice: 'empty' });
  });

  it('a refusal is a ROW, carrying the reason — never a blank pane', () => {
    const s = applyListing(createTree(ROOT), ROOT, { ok: false, reason: 'out-of-scope' });
    expect(visibleRows(s)).toEqual([
      {
        type: 'notice',
        key: '/r::error',
        depth: 0,
        notice: 'error',
        path: ROOT,
        reason: 'out-of-scope',
      },
    ]);
  });

  it('keys are stable, because React re-mounts a row whose key moved', () => {
    const s = applyListing(createTree(ROOT), ROOT, ok([entry('a', 'file'), entry('b', 'dir')]));
    expect(visibleRows(s).map((r) => r.key)).toEqual(['/r/a', '/r/b']);
  });

  it('a cycle in the model cannot recurse forever', () => {
    // Links have no children, so this needs a bug to happen — and a stack
    // overflow inside a render is the worst possible way to discover one.
    let s = createTree(ROOT);
    s = applyListing(s, ROOT, ok([entry('loop', 'dir')]));
    s = toggleDir(s, '/r/loop').state;
    s = applyListing(s, '/r/loop', ok([{ name: 'r', path: ROOT, kind: 'dir' }]));
    s = toggleDir(s, ROOT).state;
    expect(() => visibleRows(s)).not.toThrow();
  });
});

describe('toggleDir', () => {
  it('asks for a listing the first time and not the second', () => {
    let s = applyListing(createTree(ROOT), ROOT, ok([entry('src', 'dir')]));
    const first = toggleDir(s, '/r/src');
    expect(first.fetch).toBe(true);
    s = applyListing(first.state, '/r/src', ok([]));
    const closed = toggleDir(s, '/r/src');
    expect(closed.fetch).toBe(false);
    expect(isExpanded(closed.state, '/r/src')).toBe(false);
    // re-opening a folder you just closed must not flash a spinner at you
    const reopened = toggleDir(closed.state, '/r/src');
    expect(reopened.fetch).toBe(false);
    expect(visibleRows(reopened.state)[1]).toMatchObject({ notice: 'empty' });
  });

  it('retries a folder whose last listing FAILED', () => {
    let s = applyListing(createTree(ROOT), ROOT, ok([entry('src', 'dir')]));
    s = toggleDir(s, '/r/src').state;
    s = applyListing(s, '/r/src', { ok: false, reason: 'unreadable' });
    s = toggleDir(s, '/r/src').state; // close
    expect(toggleDir(s, '/r/src').fetch).toBe(true);
  });

  it('collapsing does not discard what the folder held', () => {
    let s = applyListing(createTree(ROOT), ROOT, ok([entry('src', 'dir')]));
    s = toggleDir(s, '/r/src').state;
    s = applyListing(s, '/r/src', ok([entry('index.ts', 'file', '/r/src')]));
    const closed = toggleDir(s, '/r/src').state;
    expect(closed.dirs['/r/src'].entries).toHaveLength(1);
  });
});

describe('refresh', () => {
  it('re-asks the root plus what is OPEN, and nothing that is closed', () => {
    let s = applyListing(createTree(ROOT), ROOT, ok([entry('a', 'dir'), entry('b', 'dir')]));
    s = toggleDir(s, '/r/a').state;
    s = applyListing(s, '/r/a', ok([]));
    s = toggleDir(s, '/r/b').state;
    s = applyListing(s, '/r/b', ok([]));
    s = toggleDir(s, '/r/b').state; // b closed again — still listed, not shown
    expect(openDirs(s).sort()).toEqual(['/r', '/r/a']);
    const fresh = invalidate(s);
    expect(fresh.dirs['/r'].status).toBe('loading');
    expect(fresh.dirs['/r/a'].status).toBe('loading');
    expect(fresh.dirs['/r/b']).toBeUndefined();
    // and what was open stays open across the refresh
    expect(fresh.expanded).toEqual(['/r/a']);
  });

  it('the root appears once even when it is somehow also in expanded', () => {
    let s = createTree(ROOT);
    s = applyListing(s, ROOT, ok([]));
    s = toggleDir(s, ROOT).state;
    expect(openDirs(s)).toEqual([ROOT]);
  });

  it('markLoading keeps the old entries, so a refresh does not blank the tree', () => {
    const s = applyListing(createTree(ROOT), ROOT, ok([entry('a', 'file')]));
    const loading = markLoading(s, ROOT);
    expect(loading.dirs[ROOT]).toMatchObject({ status: 'loading', entries: [{ name: 'a' }] });
  });
});

describe('what a row lets you do', () => {
  it('only a file opens, and only a folder expands', () => {
    expect([isOpenable('file'), isOpenable('dir'), isOpenable('link'), isOpenable('other')]).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect([
      isExpandable('dir'),
      isExpandable('file'),
      isExpandable('link'),
      isExpandable('other'),
    ]).toEqual([true, false, false, false]);
  });

  it('a LINK is inert in both directions — main does not follow them', () => {
    const s = applyListing(createTree(ROOT), ROOT, ok([entry('escape', 'link')]));
    const row = visibleRows(s)[0];
    expect(row).toMatchObject({ type: 'entry', kind: 'link', expanded: false });
    // and asking to toggle it changes nothing anyone can see
    const t = toggleDir(s, '/r/escape');
    expect(visibleRows(t.state)[0]).toMatchObject({ expanded: false });
  });
});

describe('applyListing', () => {
  it('files the answer under the path we ASKED about, not the resolved one', () => {
    // Main answers with the real path, which differs whenever a segment above
    // is a link — `%TEMP%` on Windows is routinely an 8.3 short name. Keying on
    // `result.path` would file the listing under a name nothing is holding, and
    // the folder would spin forever.
    const s = applyListing(createTree(ROOT), ROOT, {
      ok: true,
      path: '/somewhere/else/real',
      entries: [entry('a', 'file')],
      truncated: false,
      cap: 500,
    });
    expect(s.dirs[ROOT].status).toBe('ready');
    expect(s.dirs['/somewhere/else/real']).toBeUndefined();
  });
});
