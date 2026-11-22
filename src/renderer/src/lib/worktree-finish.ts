// The window's half of finishing a worktree (E42 step 3, #1638): which
// sessions live in a worktree, and the words handed to one of them when
// "Update from main" stops on conflicts. Pure, so it is tested without a DOM.
import { pathKey, worktreeFor, type WorktreeInfo } from '../../../shared/projects';
import type { RailSession } from '../model/types';

/**
 * The sessions working in the worktree at `folder`: by the DEEPEST worktree
 * holding each session's folder (`worktreeFor`), so a worktree nested inside
 * the primary checkout does not count as the primary's, and the other way
 * round. Without a worktree list (git unreadable), a plain "inside" test.
 */
export function sessionsInWorktree(
  sessions: readonly RailSession[],
  worktrees: readonly WorktreeInfo[] | null,
  folder: string
): RailSession[] {
  const want = pathKey(folder);
  return sessions.filter((s) => {
    // GIT'S answer first, as the card places them (`lib/groups`): `autoKey` is
    // the folder's toplevel in git's spelling, which still matches when the
    // folder string is an 8.3 short name (`RUNNER~1`, Windows CI)
    const top = s.autoKey ? pathKey(s.autoKey) : null;
    if (top && worktrees?.some((w) => pathKey(w.path) === top)) return top === want;
    if (!s.folder) return false;
    if (worktrees) {
      const home = worktreeFor(s.folder, worktrees);
      return home !== null && pathKey(home) === want;
    }
    const f = pathKey(s.folder);
    return f === want || f.startsWith(`${want}/`);
  });
}

/** The session to hand conflicts to: a live one, the one asking first if it is here. */
export function handOffSession(here: readonly RailSession[], activeId: string | null): RailSession | null {
  const live = here.filter((s) => !!s.liveId);
  return live.find((s) => s.id === activeId) ?? live[0] ?? null;
}

/** The file list in the hand-off prompt: one per line, capped. */
export function conflictFileLines(files: readonly string[], more: (n: number) => string, max = 30): string {
  const shown = files.slice(0, max).map((f) => `- ${f}`);
  if (files.length > max) shown.push(`- ${more(files.length - max)}`);
  return shown.join('\n');
}
