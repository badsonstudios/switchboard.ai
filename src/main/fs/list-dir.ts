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

/**
 * Is this an entry the tree never shows?
 *
 * CASE-FOLDED UNCONDITIONALLY, and the asymmetry is deliberate: on Windows a
 * repository whose directory is spelled `.GIT` genuinely IS the git directory,
 * and a case-sensitive check listed all forty thousand of its objects. On Linux
 * `.GIT` is an ordinary folder that this now hides for no reason — which is the
 * better of the two ways to be wrong, since one hidden folder on one OS costs
 * less than a screenful of content-addressed blobs on the other. Folding only
 * where `HOST_STYLE` says to would be exactly right and is more machinery than a
 * cosmetic filter earns.
 */
const neverListed = (name: string): boolean => NEVER_LISTED.has(name.toLowerCase());

/**
 * Bounds on the SHAPE of a path, applied before anything resolves it.
 *
 * ⚠️ THIS IS A DENIAL-OF-SERVICE GUARD, NOT A CONTAINMENT ONE — containment is
 * the three checks below and does not depend on it. It is here because
 * `ReadScope.resolve` is SYNCHRONOUS: an unresolvable path sends it walking up
 * one segment at a time doing a blocking `realpathSync` per segment, and this
 * channel asks it twice per call. Measured on the owner's desktop, a
 * 2000-segment path costs ~106 ms of frozen main process, and a renderer can
 * fire a thousand un-awaited calls. That is our breakage costing the user every
 * session in the window, which fail-open forbids.
 *
 * Both numbers are far past anything real: the longest path on a Windows box
 * with long paths enabled is 32,767 characters, and 64 levels of nesting is
 * deeper than any source tree. Refusing beyond them costs a legitimate caller
 * nothing.
 */
const MAX_PATH_CHARS = 4096;
const MAX_PATH_SEGMENTS = 64;

function tooBigToResolve(p: unknown): boolean {
  if (typeof p !== 'string') return false; // not our refusal to make
  if (p.length > MAX_PATH_CHARS) return true;
  let segments = 1;
  for (let i = 0; i < p.length; i += 1) {
    const c = p.charCodeAt(i);
    // 47 is `/`, 92 is `\` — written as codes because an escaped backslash in a
    // character class is the kind of literal this repo has been bitten by.
    if (c === 47 || c === 92) segments += 1;
  }
  return segments > MAX_PATH_SEGMENTS;
}

export interface ListDirDeps {
  scope: ReadScope;
  log: Logger;
  /** the entry cap, overridable for tests; production uses `MAX_DIR_ENTRIES` */
  cap?: number;
  /** `fs.promises.opendir`, injectable so a test can force a read failure */
  opendir?: (p: string) => Promise<fs.Dir>;
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

  const { root, path: target } = (req ?? {}) as Partial<DirListRequest>;
  if (typeof root !== 'string' || root.length === 0) return { ok: false, reason: 'invalid-path' };
  // The DoS bound, before either resolve. See `tooBigToResolve`: this is not
  // part of containment, it is what stops a caller spending the main process's
  // event loop on a path nobody could have meant.
  if (tooBigToResolve(root) || tooBigToResolve(target)) {
    return { ok: false, reason: 'invalid-path' };
  }

  // CHECK 1 — is the declared root itself in the read scope? Asked first so a
  // caller that invents a root is refused before anything is read.
  //
  // ⚠️ `ReadScope`'s existence-oracle argument is INHERITED BUT NOT PERFECT, and
  // it is worth being exact rather than repeating the claim. Its `catch` answers
  // `not-found` only when the nearest resolvable ancestor is itself in scope,
  // which closes the oracle for any path *spelled* outside the scope. It does
  // not close it for a path spelled INSIDE the scope that resolves outside it:
  // given a symlink `<root>/probe` aimed anywhere on the machine, `out-of-scope`
  // means the target exists and `not-found` means it does not. That predates
  // this channel and applies equally to `fs:read`, `fs:watch` and `fs:reveal`;
  // it requires write access inside a session folder, which the agent already
  // has. It is written down here rather than quietly re-asserted, and it wants
  // its own item against E16 rather than a fix on this path only.
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

  const entries: DirEntry[] = [];
  let truncated = false;
  let dir: fs.Dir;
  // `opendir` ANSWERS BOTH QUESTIONS, which is why there is no `stat` in front
  // of it any more. It returns ENOTDIR for a file and ENOENT for a missing path,
  // so a `stat` first bought nothing and cost a syscall — and it widened the
  // window between the check and the open. That window is not closed: `real` is
  // realpath'd, but resolution is not sticky, so a final component replaced with
  // a junction between `realpath` and here would be followed by the OS. The
  // exposure is exactly ONE level of names — the next call re-checks and refuses
  // — and winning the race needs write access inside a session folder, which the
  // agent already has. Naming it rather than implying it is closed; `openat`-
  // style handle-relative listing is the real fix and Node does not offer one.
  try {
    dir = await opendir(real);
  } catch (err) {
    const code = errorCode(err);
    return {
      ok: false,
      reason:
        code === 'ENOTDIR' ? 'not-a-directory' : code === 'ENOENT' ? 'not-found' : 'unreadable',
    };
  }
  try {
    // ONE DIRENT AT A TIME, and the loop stops itself. `readdir` would
    // materialise every name in a `node_modules` before we could cap anything;
    // `opendir` hands them back in batches and lets us walk away. The `+ 1` is
    // how "there is more" is learned without reading the rest.
    for (;;) {
      const d = await dir.read();
      if (!d) break;
      if (neverListed(d.name)) continue;
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
    // `Dir` holds an OS HANDLE. The read loop above can leave through three
    // doors — exhausted, capped, thrown — and every one of them has to come
    // through here or the app leaks a descriptor per browsed folder.
    //
    // Swallowed in BOTH shapes: `close()` on an already-closed handle answers
    // `ERR_DIR_CLOSED`, which Node rejects with — but a `try` around the call as
    // well covers it throwing synchronously, and either one escaping a `finally`
    // would replace a good answer with a rejected `invoke`.
    try {
      await dir.close();
    } catch {
      /* already closed, or closing failed — there is nothing useful to do */
    }
  }

  entries.sort(compareEntries);
  if (truncated) {
    deps.log.info('fs:listDir capped a directory', { path: real, cap });
  }
  return { ok: true, path: real, entries, truncated, cap };
}
