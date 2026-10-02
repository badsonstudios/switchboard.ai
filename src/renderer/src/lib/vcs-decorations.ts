// VCS decorations for the Files tab (E24 Git v2 item 11, §5.7 / E25).
//
// This is the half of §5.7's file-tree bullet that was still Phase 3 work after
// #521 shipped the tree itself: *"The tree paints no modified/added/untracked
// badges, and wiring `GitFileStatus` into its rows is the remaining work, not a
// rewrite of the tree."*
//
// Everything here is PURE and takes the status it is given — which is how item
// 11's acceptance bar is met. `lib/git-status-store.ts` is the one source both
// tabs read; this file only decides what a row says about it.
import type { GitStatusDto } from './git-status';
import { letterFor, type ScmGroupKind } from './scm-groups';

/** What a row is decorated with, or `null` for a row git has nothing to say about. */
export interface Decoration {
  /** M A D R C T U ! — the same vocabulary the sidebar's letters use */
  letter: string;
  /** a key into `scm.letter.*`, for the row's accessible name */
  key: string;
  /** this row is a FOLDER summarising what is under it, not a changed file itself */
  rolledUp?: boolean;
}

/**
 * The decorations for one folder's worth of rows, by ABSOLUTE path.
 *
 * ⚠️ **ABSOLUTE, BECAUSE THE TREE AND GIT SPEAK DIFFERENT PATHS.** `FileTree`
 * rows carry an absolute path with the OS separator (it came from a directory
 * listing); git reports a forward-slash path relative to the session folder. One
 * of them has to convert, and doing it HERE means the tree never learns what a
 * repository root is.
 *
 * ⚠️ **AND A FOLDER IS DECORATED BY WHAT IS UNDER IT.** A tree that only marked
 * changed FILES would be useless on a collapsed tree — which is how the tree
 * starts, one level at a time — because every change would be hidden behind an
 * undecorated folder. So a folder carries the strongest letter beneath it, marked
 * `rolledUp` so the row can draw it differently from a file's own status.
 *
 * The strength order is the one that matters to a reader: a CONFLICT outranks
 * everything (it blocks), then a deletion (the surprising one), then a
 * modification, then an addition, then untracked.
 */
export function decorationsFor(
  folder: string | undefined,
  status: GitStatusDto | null | undefined
): Map<string, Decoration> {
  const out = new Map<string, Decoration>();
  if (!folder || !status?.isRepo) return out;
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  const root = folder.replace(/[\\/]+$/, '');
  for (const file of status.files ?? []) {
    const group: ScmGroupKind = file.conflicted
      ? 'merge'
      : file.untracked
        ? 'untracked'
        : file.unstaged
          ? 'unstaged'
          : 'staged';
    const letter = letterFor(file, group);
    const absolute = `${root}${sep}${file.path.split('/').join(sep)}`;
    out.set(absolute, { letter, key: decorationKey(letter) });
    // Every ancestor up to (and excluding) the session folder gets the roll-up.
    const parts = file.path.split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      const dir = `${root}${sep}${parts.slice(0, i).join(sep)}`;
      const held = out.get(dir);
      if (held && !held.rolledUp) continue; // a folder that is itself changed wins
      if (held && strength(held.letter) >= strength(letter)) continue;
      out.set(dir, { letter, key: decorationKey(letter), rolledUp: true });
    }
  }
  return out;
}

/**
 * How much a letter should win a folder's roll-up.
 *
 * Not alphabetical and not git's own order: this is "what would a reader most
 * want to be told is under here". A conflict blocks everything, a deletion is the
 * one nobody expects, and untracked is the most harmless thing a folder can hold.
 */
function strength(letter: string): number {
  switch (letter) {
    case '!':
      return 5;
    case 'D':
      return 4;
    case 'M':
    case 'T':
      return 3;
    case 'A':
    case 'R':
    case 'C':
      return 2;
    default:
      return 1;
  }
}

/** The `scm.letter.*` key for a letter — the sidebar's vocabulary, reused. */
function decorationKey(letter: string): string {
  switch (letter) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
      return 'untracked';
    case '!':
      return 'conflicted';
    case 'T':
      return 'typechange';
    default:
      return 'modified';
  }
}
