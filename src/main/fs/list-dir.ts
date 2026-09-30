// Listing ONE directory, in main, behind the read scope (#521 layer 2, §5.35).
//
// THIS IS THE APP'S FIRST DIRECTORY-LISTING CHANNEL, and it is built as a
// STRICT NARROWING of `fs:read` rather than a new power beside it. Three checks,
// in this order, and the third is the one that is new:
//
//   1. `ReadScope.resolve(root)`   — the root must already be readable.
//   2. `ReadScope.resolve(path)`   — the target must already be readable.
//   3. `isWithinRoot(root, path)`  — and the target must be inside THAT root.
//
// The first two are the existing guard, untouched; `read-scope.ts` has the whole
// argument for why they resolve before they compare, and every word of it
// applies here. The third exists because a tree browses one folder: without it,
// session A's tab could be steered at session B's folder — no worse than what
// `fs:read` already permits, but not what the surface says it does, and #832 is
// days old and was exactly the class of bug where a path from somewhere
// untrusted reached further than its surface implied.
//
// So the guarantee, stated exactly: **nothing this channel can reach was
// unreachable by `fs:read` before it existed, and within one call it can only
// enumerate inside the root that call declared.**
//
// LINKS ARE NOT FOLLOWED. A symlink or a Windows junction inside a session
// folder can point at `C:\Users\dan\.ssh`, and "resolve it and check it" is a
// correct answer that is harder to prove than "do not". So a link is reported as
// its own kind and the tree neither expands nor opens it. If someone asks about
// one directly, `ReadScope` resolves it and refuses — the two defences are
// independent on purpose.
//
// BOUNDED. One level per call, never a walk, and the READ stops at the cap —
// see `MAX_DIR_ENTRIES`. `.git` is not listed, so there is no route into it from
// the tree.
import fs from 'fs';
import path from 'path';
import type { Logger } from '../log/logger';
import {
  DirEntry,
  DirEntryKind,
  DirListRequest,
  DirListResult,
  MAX_DIR_ENTRIES,
} from '../../shared/ipc/fs';
import { isWithinRoot, ReadScope } from './read-scope';

/**
 * Directories the tree never shows.
 *
 * `.git` only, and deliberately not a general "hidden files" rule: an agent's
 * folder is full of dotted things a user wants to see (`.claude`,
 * `.env.example`, `.github`), and hiding them would be hiding the most
 * switchboard-relevant files in the project. `.git` is different in kind — it is
 * thousands of content-addressed objects, it is not source, and §5.7's git story
 * is told by the Changes and History tabs rather than by browsing loose files.
 *
 * It is a listing filter, NOT a security control. A `.git` file is inside the
 * session folder and `fs:read` could always read it; this only means the tree
 * does not offer a road there.
 */
const NEVER_LISTED = new Set(['.git']);

export interface ListDirDeps {
  scope: ReadScope;
  log: Logger;
  /** the entry cap, overridable for tests; production uses `MAX_DIR_ENTRIES` */
  cap?: number;
  /** `fs.promises.opendir`, injectable so a test can force a read failure */
  opendir?: (p: string) => Promise<fs.Dir>;
  /** `fs.promises.stat`, injectable for the same reason */
  stat?: (p: string) => Promise<fs.Stats>;
}

/**
 * What kind of thing a dirent is.
 *
 * THE LINK TEST COMES FIRST and that ordering is load-bearing. `readdir` with
 * `withFileTypes` reports a dirent from `lstat`-shaped information, so a
 * junction answers `isSymbolicLink()` — but on some platforms and filesystems a
 * reparse point can *also* answer `isDirectory()`. Asking about the link first
 * means a junction can never be classified as an expandable folder, which is
 * exactly the classification that would let the tree walk out of the root.
 */
export function kindOf(d: {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}): DirEntryKind {
  if (d.isSymbolicLink()) return 'link';
  if (d.isDirectory()) return 'dir';
  if (d.isFile()) return 'file';
  return 'other';
}

/**
 * Folders before files, then by name.
 *
 * Case-folded, with the raw name as the tie-break so the order is TOTAL: two
 * entries differing only in case (possible on Linux, impossible on Windows)
 * must not swap between calls, or the tree would reshuffle on every refresh.
 * `localeCompare` is deliberately not used — it is locale-dependent, and this
 * order is compared against in tests that run on three platforms.
 */
export function compareEntries(a: DirEntry, b: DirEntry): number {
  const rank = (e: DirEntry): number => (e.kind === 'dir' ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const al = a.name.toLowerCase();
  const bl = b.name.toLowerCase();
  if (al !== bl) return al < bl ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Thrown-shaped errors from `fs` carry a string `code`. */
function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined;
}

/**
 * List one directory, or say why not.
 *
 * Never throws and never rejects: every failure is one of the refusal words,
 * because this is called from an IPC handler and a rejecting handler is the one
 * thing the fail-open constraint forbids of a channel the UI depends on.
 */
export async function listDirectory(req: unknown, deps: ListDirDeps): Promise<DirListResult> {
  const cap = deps.cap ?? MAX_DIR_ENTRIES;
  const opendir = deps.opendir ?? ((p: string) => fs.promises.opendir(p));
  const stat = deps.stat ?? ((p: string) => fs.promises.stat(p));

  const { root, path: target } = (req ?? {}) as Partial<DirListRequest>;
  if (typeof root !== 'string' || root.length === 0) return { ok: false, reason: 'invalid-path' };

  // CHECK 1 — is the declared root itself in the read scope? Asked first so a
  // caller that invents a root is refused before anything is read, and refused
  // with the same word whether or not the root exists (that is `ReadScope`'s
  // existence-oracle argument, and it holds here unchanged).
  const rootDecision = deps.scope.resolve(root);
  if (!rootDecision.ok) return { ok: false, reason: rootDecision.reason };

  // CHECK 2 — and the target. An absent `path` means "the root", which is what
  // the tab asks for when it opens; it is not a special case in the guard,
  // because the root has already been resolved by exactly the same call.
  const asked = target === undefined || target === null ? rootDecision.path : target;
  const targetDecision = deps.scope.resolve(asked);
  if (!targetDecision.ok) return { ok: false, reason: targetDecision.reason };

  // CHECK 3 — the narrowing. Both operands are REAL paths by now: `..` is
  // collapsed, junctions and symlinks are resolved, an 8.3 short name is
  // expanded and the case is canonical. Comparing the strings the caller sent
  // would pass `root/junction-to-c-windows` — the requested string does start
  // with the root, and the bytes come from somewhere else entirely.
  if (!isWithinRoot(rootDecision.path, targetDecision.path)) {
    return { ok: false, reason: 'out-of-scope' };
  }
  const real = targetDecision.path;

  // A file is not a folder, and this is the mirror of `read-file.ts`'s
  // `not-a-file`. `stat` rather than `lstat`: `real` is already realpath'd, so
  // there is no link left to be fooled by, and the two agree by construction.
  try {
    const st = await stat(real);
    if (!st.isDirectory()) return { ok: false, reason: 'not-a-directory' };
  } catch (err) {
    const code = errorCode(err);
    return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'unreadable' };
  }

  const entries: DirEntry[] = [];
  let truncated = false;
  let dir: fs.Dir;
  try {
    dir = await opendir(real);
  } catch (err) {
    const code = errorCode(err);
    return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'unreadable' };
  }
  try {
    // ONE DIRENT AT A TIME, and the loop stops itself. `readdir` would
    // materialise every name in a `node_modules` before we could cap anything;
    // `opendir` hands them back in batches and lets us walk away. The `+ 1` is
    // how "there is more" is learned without reading the rest.
    for (;;) {
      const d = await dir.read();
      if (!d) break;
      if (NEVER_LISTED.has(d.name)) continue;
      if (entries.length >= cap) {
        truncated = true;
        break;
      }
      entries.push({ name: d.name, path: path.join(real, d.name), kind: kindOf(d) });
    }
  } catch (err) {
    // A directory that started listing and then failed (a drive unplugged
    // mid-walk, a permission that changed) is `unreadable`, not a throw.
    deps.log.warn('fs:listDir failed part-way through a directory', {
      path: real,
      error: String(err),
    });
    return { ok: false, reason: 'unreadable' };
  } finally {
    // `Dir` holds an OS handle. The read loop above can leave through four
    // doors — done, capped, thrown — and every one of them has to come through
    // here or the app leaks a descriptor per browsed folder. The catch is
    // because closing an already-closed handle throws `ERR_DIR_CLOSED`, which
    // would replace a good answer with a crash.
    await dir.close().catch(() => {});
  }

  entries.sort(compareEntries);
  if (truncated) {
    deps.log.info('fs:listDir capped a directory', { path: real, cap });
  }
  return { ok: true, path: real, entries, truncated, cap };
}
