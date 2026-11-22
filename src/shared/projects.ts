// Projects (E42, #1636; step 1 is #1637).
//
// A PROJECT is one git repo, keyed by git's COMMON directory, so the primary
// checkout and every linked worktree belong to the same project. It holds that
// repo's WORKTREES (a branch in a folder; the primary checkout is one of them),
// and each worktree holds the sessions working in it. Plain sessions and groups
// are untouched.
//
// Membership is DERIVED, never stored on a session: a session belongs to a
// project when its folder's common dir is the project's, and to a worktree when
// its folder's toplevel is that worktree's path. That keeps it fail-open (no
// git answer, no membership, and the session renders exactly as it does today)
// and means a session the AI moves into a worktree (#1616) lands under it with
// nothing extra here.

/** One entry of `git worktree list --porcelain` (main/git/worktree-list.ts). */
export interface WorktreeInfo {
  /**
   * The worktree's folder. The parser keeps git's spelling (forward slashes,
   * also on Windows); `GitService.worktreeList` hands it on in native form.
   */
  path: string;
  /** the first entry git lists: the primary checkout (or the bare repo) */
  primary: boolean;
  /** short branch name, or null when detached or unborn */
  branch: string | null;
  head: string | null;
  detached: boolean;
  bare?: boolean;
  locked?: boolean;
  /** git thinks the folder is gone; `git worktree prune` would drop it */
  prunable?: boolean;
}

/** The persisted project record. Persisted shape and wire shape are the same. */
export interface ProjectRecord {
  id: string;
  name: string;
  color: string;
  /** absolute git common dir, native separators (the project's identity) */
  commonDir: string;
  /** the primary checkout's folder when the project was opened */
  primaryPath: string;
  /** worktree paths (pathKey form) the user chose to hide from the card */
  hiddenWorktrees: string[];
  /** step 2 (#1506): where new worktrees start from; unset until then */
  baseRef?: string;
  /** step 2 (#1506): where new worktrees are created; unset until then */
  worktreeRoot?: string;
}

/** What `projects:inspect` tells the Open project dialog about a folder. */
export interface ProjectInspection {
  commonDir: string;
  primaryPath: string;
  /** the name the dialog offers: the primary checkout's folder name */
  suggestedName: string;
  worktrees: WorktreeInfo[];
  /** already open as this project */
  existingProjectId?: string;
}

/** A project's worktrees as the card draws them (`projects:worktrees`). */
export interface ProjectWorktrees {
  projectId: string;
  /** null when git could not be read: the card says so and still shows sessions */
  worktrees: WorktreeInfo[] | null;
}

/**
 * The one way to compare two paths here: separators unified, trailing
 * separators dropped, lower-cased. Lower-casing is right on Windows and macOS
 * (case-insensitive by default) and costs only a theoretical collision on
 * Linux, which matches what the automatic folder groups already do.
 */
export function pathKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Is `folder` the worktree at `worktreePath`, or inside it? */
export function isInside(folder: string, worktreePath: string): boolean {
  const f = pathKey(folder);
  const w = pathKey(worktreePath);
  return f === w || f.startsWith(`${w}/`);
}

/**
 * Which worktree a session folder belongs to: the DEEPEST worktree that
 * contains it. Deepest, because a linked worktree may sit inside the primary
 * checkout (`.claude/worktrees/x` is a common shape), and that session belongs
 * to the inner one.
 */
export function worktreeFor(
  folder: string,
  worktrees: ReadonlyArray<{ path: string }>
): string | null {
  let best: string | null = null;
  for (const w of worktrees) {
    if (!isInside(folder, w.path)) continue;
    if (best === null || pathKey(w.path).length > pathKey(best).length) best = w.path;
  }
  return best;
}
