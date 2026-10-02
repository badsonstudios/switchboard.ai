// Staging one hunk, from the renderer (E24 Git v2 item 14) — screen 8.
//
// ⚠️ **NO CONFIRM, AND THAT IS NOT AN OVERSIGHT — IT IS THE DIFFERENCE FROM ITEM
// 12.** Everything here applies to the **index only** (`git apply --cached`,
// measured: the file on disk is never written), so nothing reachable through this
// module can lose work. Item 12's discard needed a mandatory confirm because
// `clean` destroys an untracked file for good; staging a hunk is undoable by
// pressing the same button again.
//
// ⚠️ **AND LINE-LEVEL SELECTION IS NOT HERE.** It is filed as its own issue,
// because the obvious implementation was built and demonstrated to put the WRONG
// CONTENT in the index while `git apply` accepted the patch. `main/git/git-hunks.ts`
// carries the counter-example and names the mechanism it needs.
import { answered } from '../../../shared/ipc/refusal';
import type { WriteOutcome } from './git-write';

/** One hunk, as main parsed it. The shape mirrors `Hunk` in the service. */
export interface HunkDto {
  header: string;
  lines: string[];
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface HunksDto {
  unreadable?: string;
  /** the `diff --git` / `---` / `+++` lines — a patch is invalid without them */
  header?: string[];
  hunks: HunkDto[];
}

interface HunkBridge {
  hunks?: (folder: string, file: string) => Promise<unknown>;
  applyPatch?: (
    folder: string,
    patch: string,
    opts?: { reverse?: boolean; zeroContext?: boolean }
  ) => Promise<unknown>;
}

/** `globalThis`, not `window` — the note every module in this family carries. */
function bridge(): HunkBridge | undefined {
  return (globalThis as { switchboard?: { git?: HunkBridge } }).switchboard?.git;
}

/** Can this build stage part of a file? Both halves or neither. */
export function canStageHunks(): boolean {
  const g = bridge();
  return typeof g?.hunks === 'function' && typeof g?.applyPatch === 'function';
}

/**
 * Read one file's hunks.
 *
 * ⚠️ **`null` MEANS "WE LEARNED NOTHING", WHICH IS NOT THE SAME AS "NO HUNKS".**
 * A file with nothing unstaged really has an empty list, and a surface that drew
 * the same thing for both would tell a user their change had vanished.
 */
export async function readHunks(folder: string, file: string): Promise<HunksDto | null> {
  const fn = bridge()?.hunks;
  if (typeof fn !== 'function' || !folder || !file) return null;
  try {
    const out = answered(await fn(folder, file)) as HunksDto | undefined;
    if (!out || !Array.isArray(out.hunks)) return null;
    return out;
  } catch {
    return null;
  }
}

/**
 * The patch for one hunk of a file.
 *
 * ⚠️ **BUILT HERE RATHER THAN IN MAIN, AND THE TRAILING NEWLINE IS LOAD-BEARING.**
 * `git apply` reading a patch whose last line has no terminator reports *"corrupt
 * patch at line N"* — a failure that looks like a synthesis bug and is one missing
 * byte. Composed in the renderer because the renderer is what knows WHICH hunk the
 * user pointed at; main validates and applies.
 */
export function onePatch(dto: HunksDto, hunk: HunkDto): string {
  const lines = [...(dto.header ?? []), hunk.header, ...hunk.lines];
  return `${lines.join('\n')}\n`;
}

/** Stage (or, reversed, unstage) exactly one hunk. */
export async function applyOneHunk(
  folder: string,
  dto: HunksDto,
  hunk: HunkDto,
  opts: { reverse?: boolean } = {}
): Promise<WriteOutcome> {
  const fn = bridge()?.applyPatch;
  if (typeof fn !== 'function' || !folder) {
    return { ok: false, applied: 0, reason: 'this build of switchboard cannot stage part of a file' };
  }
  try {
    const out = answered(await fn(folder, onePatch(dto, hunk), opts)) as WriteOutcome | undefined;
    if (!out || typeof out.ok !== 'boolean') {
      return { ok: false, applied: 0, reason: 'switchboard was not allowed to do that' };
    }
    return out;
  } catch {
    return { ok: false, applied: 0, reason: 'switchboard could not reach git' };
  }
}

/**
 * A short human label for a hunk.
 *
 * ⚠️ **THE `@@ … @@` LINE IS NOT IT.** `@@ -160,12 +160,18 @@` is precise and
 * means nothing to most people; what a reader wants is *where* and *how much*.
 * Returned as a key plus values so the catalog owns the words.
 */
export function hunkLabel(hunk: HunkDto): { key: string; values: Record<string, number> } {
  const added = hunk.lines.filter((l) => l[0] === '+').length;
  const removed = hunk.lines.filter((l) => l[0] === '-').length;
  return { key: 'scm.hunkLabel', values: { line: hunk.newStart, added, removed } };
}
