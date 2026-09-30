// The Files tab's directory model — PURE, and that is the point (#521 layer 2).
//
// PLACEMENT-AGNOSTIC BY CONSTRUCTION. The owner chose shape A (a tab on the
// session card) knowing its limitation — session tabs are exclusive, so you
// cannot browse the tree while watching the Feed — and chose it on the
// condition that shape B (Files as a document-area panel) stays a later move
// rather than a rewrite. This module is how that condition is met: it knows
// about a root, directories, and which of them are open. It does not know what
// a card is, what a tab is, what a panel is, or that React exists.
//
// Everything with a layout decision in it lives HERE rather than in the view,
// including the notice rows — "this folder is empty", "only the first 500
// entries", "you may not read that". A view that decided when to interleave
// those would be a view with an untestable table in it; as data they are a
// fixture and an `expect`.
//
// IMMUTABLE. Every function answers a new state, because the consumer is React
// and a mutated map is a render that does not happen.
import type { DirEntry, DirEntryKind, DirListRefusal, DirListResult } from '../../../shared/ipc/fs';

/** What we know about one directory. */
export interface DirState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly entries: readonly DirEntry[];
  /** the listing stopped at the cap — there are more entries than these */
  readonly truncated: boolean;
  /** the cap that was applied, so the notice can name the number main used */
  readonly cap?: number;
  /** why the listing failed, when `status` is `error` */
  readonly reason?: DirListRefusal;
}

export interface TreeState {
  /** the folder being browsed — the boundary every request declares */
  readonly root: string;
  /** what we know, keyed by absolute path. The root is always a key. */
  readonly dirs: Readonly<Record<string, DirState>>;
  /**
   * Which directories are OPEN, in no particular order.
   *
   * Separate from `dirs` because the two outlive each other in both directions:
   * a folder can be open while its listing is still in flight, and a refresh
   * discards a listing without closing the folder the user opened.
   */
  readonly expanded: readonly string[];
}

/** One row the view draws. A union, because a notice is not an entry. */
export type TreeRow =
  | {
      readonly type: 'entry';
      readonly key: string;
      readonly path: string;
      readonly name: string;
      readonly kind: DirEntryKind;
      /** 0 for a child of the root */
      readonly depth: number;
      /** only ever true for a `dir` */
      readonly expanded: boolean;
    }
  | {
      readonly type: 'notice';
      readonly key: string;
      readonly depth: number;
      readonly notice: 'loading' | 'empty' | 'truncated' | 'error';
      /** which folder this notice is about — it is not always the row above */
      readonly path: string;
      readonly cap?: number;
      readonly reason?: DirListRefusal;
    };

const LOADING: DirState = { status: 'loading', entries: [], truncated: false };

/** A fresh tree, with the root already marked as loading. */
export function createTree(root: string): TreeState {
  return { root, dirs: { [root]: LOADING }, expanded: [] };
}

export function isExpanded(state: TreeState, dir: string): boolean {
  return state.expanded.includes(dir);
}

/** Mark `dir` as in flight, keeping whatever we already had for it. */
export function markLoading(state: TreeState, dir: string): TreeState {
  return { ...state, dirs: { ...state.dirs, [dir]: { ...(state.dirs[dir] ?? LOADING), status: 'loading' } } };
}

/**
 * Fold a listing in.
 *
 * `path` is the path we ASKED about, not `result.path` — main answers with the
 * resolved real path, and using that as the key would file the answer under a
 * name nothing in the tree is holding. (They differ whenever any segment above
 * the folder is a link, which on a Windows dev box is more often than you would
 * think: `%TEMP%` is routinely an 8.3 short name.)
 */
export function applyListing(state: TreeState, path: string, result: DirListResult): TreeState {
  const next: DirState = result.ok
    ? { status: 'ready', entries: result.entries, truncated: result.truncated, cap: result.cap }
    : { status: 'error', entries: [], truncated: false, reason: result.reason };
  // A FOLDER THAT IS GONE STOPS BEING OPEN. Otherwise it sits in `expanded` for
  // the life of the tree and every Refresh and every return-to-view re-asks for
  // it — one IPC round trip and two main-process `realpath` walks each time,
  // forever, for a directory that will never come back. `expanded` would also
  // grow without bound across a long session.
  const expanded =
    !result.ok && result.reason === 'not-found' && path !== state.root
      ? state.expanded.filter((p) => p !== path)
      : state.expanded;
  return { ...state, dirs: { ...state.dirs, [path]: next }, expanded };
}

/**
 * Open or close `dir`.
 *
 * Answers the new state AND whether a listing is now needed, so the caller does
 * not have to re-derive "was that an open, and did I already have it?" — which
 * is the kind of question a component asks wrongly once and then fetches on
 * every render forever.
 */
export function toggleDir(state: TreeState, dir: string): { state: TreeState; fetch: boolean } {
  if (isExpanded(state, dir)) {
    // Collapsing KEEPS the listing. Re-opening a folder you just closed should
    // not flash a spinner at you, and the data is a handful of names.
    return { state: { ...state, expanded: state.expanded.filter((p) => p !== dir) }, fetch: false };
  }
  const known = state.dirs[dir];
  // `loading` COUNTS AS NEEDING A FETCH, and leaving it out was a way to strand
  // a folder on a spinner forever: a listing that lost a race and was discarded
  // leaves the folder `loading` with nobody in flight, and a rule that only
  // retried `error` meant closing and re-opening it changed nothing. Asking
  // twice is cheap; a permanent spinner the user cannot clear is not.
  const fetch = !known || known.status === 'error' || known.status === 'loading';
  const opened: TreeState = { ...state, expanded: [...state.expanded, dir] };
  return { state: fetch ? markLoading(opened, dir) : opened, fetch };
}

/**
 * Every folder whose contents are on screen — the root plus what is open.
 *
 * This is what a Refresh re-asks for, and it is deliberately not "every folder
 * we have ever listed": a closed folder's stale listing costs nothing and
 * re-reading it would make the cost of Refresh grow with how much browsing you
 * have done rather than with what you can see.
 */
export function openDirs(state: TreeState): string[] {
  return [state.root, ...state.expanded.filter((p) => p !== state.root)];
}

/** Forget every listing, keeping what is open — a Refresh, before the fetches. */
export function invalidate(state: TreeState): TreeState {
  const dirs: Record<string, DirState> = {};
  for (const dir of openDirs(state)) dirs[dir] = { ...(state.dirs[dir] ?? LOADING), status: 'loading' };
  return { ...state, dirs, expanded: state.expanded };
}

/** Is this entry something the tree lets you open in the viewer? */
export function isOpenable(kind: DirEntryKind): boolean {
  // Files only. A `link` is refused on purpose — main does not follow links, so
  // offering a click here would be offering one that main then declines, and
  // §5.8's rule is that a surface says what it can do. `other` is a device or a
  // socket; there are no bytes to render.
  return kind === 'file';
}

/** Can this entry be opened out into children? */
export function isExpandable(kind: DirEntryKind): boolean {
  return kind === 'dir';
}

/**
 * The rows, top to bottom, exactly as the view draws them.
 *
 * Depth-first over what is open, with each folder's own notices rendered at its
 * children's indent. The root's own notices sit at depth 0, which is why a
 * failed root read shows as a row in the tree rather than as an empty box.
 */
export function visibleRows(state: TreeState): TreeRow[] {
  const out: TreeRow[] = [];
  // A SET, not `isExpanded`'s `includes`, and the difference is measurable: this
  // is called once per render and the `includes` was once per ENTRY — 500 rows
  // against 100 open folders is 50,000 string comparisons per paint.
  const open = new Set(state.expanded);
  const walk = (dir: string, depth: number, seen: readonly string[]): void => {
    // A cycle cannot happen through a link — links have no children here — but
    // it can happen through a bug, and a stack overflow inside a render is the
    // worst possible way to find one out.
    if (seen.includes(dir)) return;
    const st = state.dirs[dir];
    if (!st) {
      out.push({ type: 'notice', key: `${dir}::loading`, depth, notice: 'loading', path: dir });
      return;
    }
    if (st.status === 'error') {
      out.push({
        type: 'notice',
        key: `${dir}::error`,
        depth,
        notice: 'error',
        path: dir,
        reason: st.reason,
      });
      return;
    }
    // ⚠️ LOADING WITH ENTRIES STILL DRAWS THE ENTRIES, and getting this wrong is
    // the whole point of `markLoading` keeping them. An earlier draft returned
    // here on `status === 'loading'`, which meant every Refresh collapsed the
    // WHOLE TREE to one "Reading…" row and rebuilt it — the retained entries
    // were dead data. The unit test even claimed otherwise, because it asserted
    // on the `DirState` rather than on these rows: the only surface that
    // matters. A refresh now re-reads underneath what you are looking at.
    if (st.status === 'loading' && st.entries.length === 0) {
      out.push({ type: 'notice', key: `${dir}::loading`, depth, notice: 'loading', path: dir });
      return;
    }
    for (const e of st.entries) {
      const expanded = isExpandable(e.kind) && open.has(e.path);
      out.push({
        type: 'entry',
        key: e.path,
        path: e.path,
        name: e.name,
        kind: e.kind,
        depth,
        expanded,
      });
      if (expanded) walk(e.path, depth + 1, [...seen, dir]);
    }
    if (st.truncated) {
      // LAST, under the entries it is talking about, and never instead of them:
      // "here are 500 of them" is more useful than "there are too many". Emitted
      // BEFORE the empty check below, so a listing that somehow came back
      // truncated-and-empty says the useful thing rather than "nothing here".
      out.push({
        type: 'notice',
        key: `${dir}::truncated`,
        depth,
        notice: 'truncated',
        path: dir,
        cap: st.cap,
      });
    } else if (st.entries.length === 0) {
      out.push({ type: 'notice', key: `${dir}::empty`, depth, notice: 'empty', path: dir });
    }
  };
  walk(state.root, 0, []);
  return out;
}
