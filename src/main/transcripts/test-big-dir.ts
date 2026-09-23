// Directories that REPORT thousands of entries, without any being written (#916).
//
// WHY THIS EXISTS. Four tests across `paths.test.ts` and `history.test.ts`
// assert a size cap, and each used to set it up by creating hundreds of real
// files or directories in a loop. On the windows-latest CI runner — cold disk,
// antivirus on every create, four jobs sharing the box — two of them blew
// vitest's 5,000 ms default and reddened a PR that had touched only renderer
// code. Measured on the owner's machine those two take 207 ms and 119 ms; the
// runner took 6,326 ms and 6,912 ms. A 30-50x slowdown on a setup loop is not
// something a timeout bump fixes for good, it just moves the cliff.
//
// WHAT IT SUBSTITUTES, AND WHY THAT IS HONEST. Every one of these caps is a
// COUNT, taken off a `readdir` before the per-entry work it exists to avoid.
// The files and directories existed only to make a number large; nothing ever
// read their contents, names or mtimes. So these spy the `readdir` and hand
// back the number directly.
//
// WHAT THE SUBSTITUTION DOES NOT BUY YOU, measured rather than assumed. Faking
// the listing does NOT on its own pin the "checked BEFORE the per-entry work"
// half of a cap. Both mutations below were run in a throwaway worktree and both
// stayed GREEN on a fake listing AND on the real-file version that preceded it:
//
//   - `listConversations`' cap moved below its stat loop — absent files
//     ENOENT-drop through the "vanished mid-listing" branch, and the later
//     check still answers `unknown`.
//   - `everyProject`'s cap keeping `truncated = true` but losing its
//     `continue` — the directory is scanned anyway, and the reported-but-not-
//     skipped result is indistinguishable from the skipped one.
//
// Both are now caught, because the callers assert on `statSync` rather than on
// the status alone. That is what makes a cheap refusal a tested property
// instead of a comment, and it is the part worth copying if a fifth cap
// appears.
import fs from 'fs';
import path from 'path';
import { vi } from 'vitest';
import type { MockInstance } from 'vitest';

/** A `Dirent` with the two members the code under test actually calls. */
function dirent(name: string, isDir: boolean): fs.Dirent {
  return { name, isFile: () => !isDir, isDirectory: () => isDir } as fs.Dirent;
}

/**
 * Install a `readdirSync` spy that answers for some paths and passes the rest
 * through to the real filesystem.
 *
 * ONE PER TEST: each call replaces the previous spy rather than layering on it.
 *
 * `encoding` options are not modelled — `'buffer'` and `{ encoding: 'buffer' }`
 * would be answered with strings — because no caller in this codebase passes
 * one. `{ recursive: true }` is likewise treated as flat. If that changes, this
 * is the place that has to learn about it.
 */
function fakeReaddir(
  answer: (p: string, wantsDirents: boolean) => string[] | fs.Dirent[] | undefined
): MockInstance {
  const real = fs.readdirSync;
  return vi.spyOn(fs, 'readdirSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
    const wantsDirents = !!(rest[0] as { withFileTypes?: boolean } | undefined)?.withFileTypes;
    const mine = answer(String(p), wantsDirents);
    if (mine !== undefined) return mine;
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readdirSync);
}

/**
 * Make `dir` report `count` conversation transcripts.
 *
 * BOTH CALL SHAPES are answered for `dir`, deliberately. Keying the fake on the
 * directory alone — rather than on "strings are mine, dirents are the root's" —
 * is what keeps it robust to a behaviour-preserving refactor: rewriting
 * `fs.readdirSync(dir)` as `fs.readdirSync(dir, { withFileTypes: true }).map(d
 * => d.name)`, which is the obvious way to stop counting `subagents/` toward
 * the cap, used to fall through to a genuinely empty directory and fail the
 * test with "the cap is broken" when the cap was fine.
 *
 * `dir` must exist for real: the code under test reaches it by matching a
 * directory the projects root genuinely lists. Asserted rather than trusted,
 * because the failure mode of a near-miss (wrong case, trailing separator) is a
 * silent no-op that surfaces as a confusing `status: 'ok'`.
 *
 * Returns the spy, so a caller can assert the fake actually fired.
 */
export function reportsConversationCount(dir: string, count: number): MockInstance {
  if (!fs.existsSync(dir)) throw new Error(`reportsConversationCount: ${dir} must exist on disk`);
  const names = Array.from({ length: count }, (_, i) => `c-${i}.jsonl`);
  return fakeReaddir((p, wantsDirents) => {
    if (p !== dir) return undefined;
    // a fresh array each time: nothing sorts it today, but a `names.sort()` in
    // production would otherwise poison every call after the first.
    return wantsDirents ? names.map((n) => dirent(n, false)) : names.slice();
  });
}

/**
 * Make `root` report `count` project directories, each of which lists EMPTY.
 *
 * The empty listing is the whole point, and is why this is honest where the
 * naive version was not. `everyProject` sets `truncated` when a project
 * directory fails to `readdir` — so project directories that are not there
 * would satisfy a `truncated === true` assertion even with the directory cap
 * deleted outright, which is a test that passes with the feature removed.
 * Answering `[]` for each one keeps that branch from ever firing, so `truncated`
 * can only come from the cap. Mutation-verified: deleting the cap turns the
 * caller red, which the 405-real-directory version it replaced did not manage.
 *
 * Real entries already in `root` are listed as well, so a test can still seed a
 * genuine project alongside the reported ones.
 */
export function reportsProjectDirs(root: string, count: number): MockInstance {
  if (!fs.existsSync(root)) throw new Error(`reportsProjectDirs: ${root} must exist on disk`);
  const names = Array.from({ length: count }, (_, i) => `proj-${i}`);
  const fake = new Set(names.map((n) => path.join(root, n)));
  const real = fs.readdirSync;
  return fakeReaddir((p, wantsDirents) => {
    // a reported project directory: EMPTY, never a failed readdir (see above)
    if (fake.has(p)) return [];
    if (p !== root) return undefined;
    // real entries keep their real kind, so a seeded project is still a project
    const existing = (real as (...a: unknown[]) => fs.Dirent[])(root, { withFileTypes: true });
    const reported = names.map((n) => dirent(n, true));
    return wantsDirents
      ? [...existing, ...reported]
      : [...existing.map((d) => d.name), ...names];
  });
}
