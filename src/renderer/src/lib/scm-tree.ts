// Tree mode for the source-control sidebar (E24 Git v2 item 8, §5.7) — screen 2.
//
// ⚠️ **THE DESIGN RECORD TOLD ME TO CHECK FOR REUSE FIRST, AND THE ANSWER IS NO.**
// §4 item 8: *"`FileTree`'s model may be reusable — check before writing a second
// one."* It is not, and the reason is structural rather than a matter of taste:
//
// `lib/file-tree-model.ts` is a **lazy browser of the filesystem**. Its state is
// `dirs: Record<absolutePath, DirState>` where a `DirState` is
// `loading | ready | error` with an entry list, a truncation cap and a refusal
// reason; `toggleDir` returns `{ state, fetch }` because opening a folder is a
// question for the main process; and `visibleRows` emits four kinds of NOTICE row
// (loading, empty, truncated, error) that exist because a listing can be in
// flight or can fail.
//
// This tree has **none of those problems and one it does not have**. The input is
// an already-complete list of changed paths that arrived in a single `git status`
// — nothing to fetch, nothing to be in flight, nothing that can fail, no cap, no
// notices. And it needs **single-child compression**, which the filesystem tree
// must never do: that one is a real directory browser, where showing
// `src/renderer/src` as one row would misreport where a file actually lives and
// break the "open this folder" gesture. Reusing it would mean synthesising
// `DirState`s for directories we are not listing and suppressing four notice
// types that cannot occur, to inherit a fetch protocol with nothing to fetch.
//
// So: a pure transform, `ScmRow[] → ScmTreeRow[]`, in the same shape as
// `scm-groups.ts` beside it — no React, no bridge, no clock.
import type { ScmRow } from './scm-groups';

/** A directory row. The label can span several segments — see the compression rule. */
export interface ScmTreeFolder {
  readonly type: 'folder';
  /**
   * The identity, and what the caller's closed-set holds.
   *
   * `scope` + the directory's full path, so two groups can fold the same
   * directory independently — folding `docs` under *Staged* must not fold it
   * under *Changes*, which are two different lists of files.
   */
  readonly key: string;
  /** the directory's full path from the repo root, with no trailing slash */
  readonly path: string;
  /**
   * What the row DRAWS, which is not always one segment.
   *
   * `src/renderer/src/components` compressed into one node shows all four, because
   * the three above it have nothing else in them and a row per level would be
   * three rows of chrome. Screen 2's own words: *"not four nested rows"*.
   */
  readonly label: string;
  /** 0 for a child of the repo root */
  readonly depth: number;
  /** how many FILE rows are under here, at any depth */
  readonly count: number;
  readonly open: boolean;
}

export interface ScmTreeFile {
  readonly type: 'file';
  /** `scope` + the file's path — the same shape as a folder's key, and unique */
  readonly key: string;
  readonly depth: number;
  readonly row: ScmRow;
}

export type ScmTreeRow = ScmTreeFolder | ScmTreeFile;

/** A directory while the tree is being built. */
interface Node {
  /** child directories, by their own single segment */
  readonly dirs: Map<string, Node>;
  /** the files directly in this directory */
  readonly files: ScmRow[];
}

const node = (): Node => ({ dirs: new Map(), files: [] });

/**
 * Folders before files, each A→Z, case-insensitively.
 *
 * ⚠️ **AND THE TIE IS BROKEN BY THE RAW STRING, DELIBERATELY.** A
 * case-insensitive compare alone makes `README.md` and `readme.md` *equal*, and a
 * comparator that returns 0 for two different names leaves their order up to the
 * sort's internals — so the list could reorder between two renders of the same
 * data. `localeCompare` on the original settles it.
 */
function byName(a: string, b: string): number {
  const folded = a.toLowerCase().localeCompare(b.toLowerCase());
  return folded !== 0 ? folded : a.localeCompare(b);
}

/** Count the files under a node, at any depth. */
function countUnder(n: Node): number {
  let total = n.files.length;
  for (const child of n.dirs.values()) total += countUnder(child);
  return total;
}

/**
 * Walk a directory down through every level that has nothing else in it.
 *
 * ⚠️ **THE RULE, AND ITS TWO LIMITS.** A directory is merged with its child when
 * it has **exactly one child directory and no files of its own** — which is VS
 * Code's rule, and the one the callout on screen 2 credits. The two limits are
 * what keep it honest:
 *
 *  - **one child directory AND a file of its own is not compressible** — the file
 *    has to be drawn somewhere, and it lives at this level;
 *  - **one child FILE is not compression at all** — a directory holding a single
 *    file still has that file as its one row beneath it, and folding the two
 *    together would put a letter and a `+/−` on something that is a place.
 *
 * Returns the joined label and the node the row actually stands for.
 */
function compress(name: string, n: Node): { label: string; path: string[]; node: Node } {
  const path = [name];
  let current = n;
  while (current.files.length === 0 && current.dirs.size === 1) {
    const [childName, child] = [...current.dirs.entries()][0];
    path.push(childName);
    current = child;
  }
  return { label: path.join('/'), path, node: current };
}

/**
 * Build the rows the sidebar draws, in order.
 *
 * `closed` holds the KEYS of folded directories (`scope` + path), so the caller
 * keeps one flat set across every group rather than a set per group. A folded
 * directory still draws its own row, with its count — the count is the whole
 * reason folding it is safe, because the row still says how much is hidden.
 *
 * ⚠️ **A FOLDED ANCESTOR HIDES ITS DESCENDANT FOLDERS TOO**, not just its files:
 * the recursion simply stops, so there is no way for a nested folder row to
 * survive its parent being shut.
 */
export function buildScmTree(
  rows: readonly ScmRow[],
  closed: ReadonlySet<string> = new Set(),
  scope = ''
): ScmTreeRow[] {
  const root = node();
  for (const row of rows) {
    // `dir` arrives with its trailing slash from `splitPath`, and an empty string
    // for a root-level file. Both shapes have to land in the root.
    const segments = row.dir.split('/').filter((s) => s !== '');
    let current = root;
    for (const segment of segments) {
      let next = current.dirs.get(segment);
      if (!next) {
        next = node();
        current.dirs.set(segment, next);
      }
      current = next;
    }
    current.files.push(row);
  }

  const out: ScmTreeRow[] = [];
  const walk = (n: Node, prefix: string, depth: number): void => {
    for (const name of [...n.dirs.keys()].sort(byName)) {
      const child = n.dirs.get(name);
      if (!child) continue;
      const folded = compress(name, child);
      const path = prefix === '' ? folded.label : `${prefix}/${folded.label}`;
      const key = `${scope}${path}`;
      const open = !closed.has(key);
      out.push({
        type: 'folder',
        key,
        path,
        label: folded.label,
        depth,
        count: countUnder(folded.node),
        open,
      });
      if (open) walk(folded.node, path, depth + 1);
    }
    // Files AFTER the directories at this level, which is every file browser's
    // order and screen 2's: `PROGRESS.md` sits below the folded folders.
    for (const row of [...n.files].sort((a, b) => byName(a.name, b.name))) {
      out.push({ type: 'file', key: `${scope}${row.path}`, depth, row });
    }
  };
  walk(root, '', 0);
  return out;
}

/**
 * Every folder key in a set of rows — what "collapse all" needs.
 *
 * ⚠️ **AND IT IS BUILT FROM A FULLY OPEN TREE, NOT FROM WHAT IS ON SCREEN.**
 * Collapsing from the visible rows would only reach the folders whose parents
 * happened to be open, so pressing it twice would collapse more the second time.
 */
export function allFolderKeys(rows: readonly ScmRow[], scope = ''): string[] {
  return buildScmTree(rows, new Set(), scope)
    .filter((r): r is ScmTreeFolder => r.type === 'folder')
    .map((r) => r.key);
}
