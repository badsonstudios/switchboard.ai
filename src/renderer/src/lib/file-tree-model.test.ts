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

  it('truncated-and-empty says the USEFUL thing, not "nothing here"', () => {
    // Unreachable with a cap above zero, but the ordering was wrong in
    // principle: the empty check used to return before the truncation notice.
    const s = applyListing(createTree(ROOT), ROOT, ok([], true));
    expect(visibleRows(s)).toHaveLength(1);
    expect(visibleRows(s)[0]).toMatchObject({ notice: 'truncated' });
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

  it('retries a folder stuck on LOADING — a spinner nobody can clear', () => {
    // The failure this rules out: a listing that lost a race and was discarded
    // leaves the folder `loading` with nobody in flight. A rule that only
    // retried `error` meant closing and re-opening it changed nothing, and the
    // spinner stayed until the toolbar Refresh. Asking twice is cheap.
    let s = applyListing(createTree(ROOT), ROOT, ok([entry('src', 'dir')]));
    s = toggleDir(s, '/r/src').state; // now loading, never answered
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

  it('a refresh does not blank the tree — ASSERTED THROUGH visibleRows', () => {
    // ⚠️ THIS TEST USED TO ASSERT ON `DirState` and was named the same thing. It
    // passed while `visibleRows` checked `status === 'loading'` FIRST and
    // returned, so every Refresh really did collapse the whole tree to one
    // "Reading…" row and the entries `markLoading` so carefully kept were dead
    // data. Found by review, and the lesson is the assertion target: the rows
    // are the only surface that matters.
    let s = applyListing(createTree(ROOT), ROOT, ok([entry('a', 'dir'), entry('b.txt', 'file')]));
    s = toggleDir(s, '/r/a').state;
    s = applyListing(s, '/r/a', ok([entry('inner.txt', 'file', '/r/a')]));
    const before = visibleRows(s).map((r) => ('name' in r ? r.name : r.notice));
    expect(before).toEqual(['a', 'inner.txt', 'b.txt']);

    const loading = invalidate(s);
    expect(loading.dirs[ROOT]).toMatchObject({
      status: 'loading',
      entries: [{ name: 'a' }, { name: 'b.txt' }],
    });
    // …and the rows are UNCHANGED while the re-read is in flight
    expect(visibleRows(loading).map((r) => ('name' in r ? r.name : r.notice))).toEqual(before);
  });

  it('markLoading on a folder we know NOTHING about still shows a spinner', () => {
    const s = markLoading(createTree(ROOT), ROOT);
    expect(visibleRows(s)).toEqual([
      { type: 'notice', key: '/r::loading', depth: 0, notice: 'loading', path: ROOT },
    ]);
  });

  it('a folder that is GONE stops being open, so a refresh stops asking for it', () => {
    let s = applyListing(createTree(ROOT), ROOT, ok([entry('a', 'dir')]));
    s = toggleDir(s, '/r/a').state;
    s = applyListing(s, '/r/a', ok([]));
    expect(openDirs(s).sort()).toEqual(['/r', '/r/a']);
    // it vanished off disk between one refresh and the next
    s = applyListing(s, '/r/a', { ok: false, reason: 'not-found' });
    expect(openDirs(s)).toEqual([ROOT]);
    // …but a root that goes missing stays the root; there is nothing to fall
    // back to and dropping it would leave the tree with no subject at all
    const rootGone = applyListing(s, ROOT, { ok: false, reason: 'not-found' });
    expect(rootGone.root).toBe(ROOT);
    expect(visibleRows(rootGone)[0]).toMatchObject({ notice: 'error', reason: 'not-found' });
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

// The ROOT AS MAIN RESOLVED IT (E24 Git v2 item 11, found by CI).
//
// ⚠️ **THE BUG THIS PINS WAS DETERMINISTIC ON A WINDOWS CI RUNNER AND INVISIBLE
// ON EVERY DEVELOPER MACHINE.** Main answers with the directory the entries
// ACTUALLY came from — links collapsed — and builds every entry's path from it.
// Item 11's git badges are keyed by `<root>/<git path>`, so on a runner whose
// temp directory is an **8.3 short name** (`C:\Users\RUNNER~1\...`, which
// `realpath` expands) the keys shared no prefix with any row and the Files tab
// drew NO BADGES AT ALL, with no error anywhere. A junction or a symlink does the
// same thing — and this project's own worktree recipe uses junctions.
describe('the resolved root', () => {
  /** A listing that came from somewhere other than where we asked. */
  const resolved = (real: string, names: string[]): DirListResult => ({
    ok: true,
    path: real,
    entries: names.map((n) => ({ name: n, path: `${real}/${n}`, kind: 'file' as const })),
    truncated: false,
    cap: 500,
  });

  it('⚠️ IS RECORDED FROM THE ROOT LISTING, not assumed to be what we asked for', () => {
    const s = applyListing(createTree(ROOT), ROOT, resolved('/real/r', ['a.txt']));
    expect(s.resolvedRoot).toBe('/real/r');
    // …and `root` is UNCHANGED, because that is still the folder the session
    // declared and the key everything else is keyed by.
    expect(s.root).toBe(ROOT);
  });

  it('is the asked path when they agree, which is every ordinary case', () => {
    const s = applyListing(createTree(ROOT), ROOT, ok([entry('a.txt', 'file')]));
    expect(s.resolvedRoot).toBe(ROOT);
  });

  it('⚠️ IS NOT SET BY A CHILD LISTING — only the root answers for the root', () => {
    // A subdirectory can itself be a link, and its resolved path says nothing
    // about where the root is. Taking it would move the whole tree's key space.
    let s = applyListing(createTree(ROOT), ROOT, resolved('/real/r', ['src']));
    s = applyListing(s, '/real/r/src', resolved('/somewhere/else', ['index.ts']));
    expect(s.resolvedRoot).toBe('/real/r');
  });

  it('is undefined until the root listing lands, rather than a guess', () => {
    expect(createTree(ROOT).resolvedRoot).toBeUndefined();
  });

  it('survives a FAILED child listing', () => {
    let s = applyListing(createTree(ROOT), ROOT, resolved('/real/r', ['src']));
    s = applyListing(s, '/real/r/src', { ok: false, reason: 'not-found' });
    expect(s.resolvedRoot).toBe('/real/r');
  });
});
