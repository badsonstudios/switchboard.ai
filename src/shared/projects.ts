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
  /** where new worktrees start from (#1506); unset = the detected default */
  baseRef?: string;
  /** the folder new worktrees go in (#1506); unset = the app-wide default */
  worktreeRoot?: string;
  /**
   * Worktrees this app made (#1506), in `pathKey` form. They are drawn without
   * the FOUND tag; every other linked worktree was made outside the app.
   */
  made?: string[];
  /** project settings (#1506): files copied from the primary checkout */
  copyFiles?: string[];
  /**
   * Git-ignored folders shared by LINK (a junction on Windows) instead of
   * copied. Opt-in, empty by default: a branch that changes dependencies would
   * disturb every worktree sharing them. Main refuses an entry git does not
   * ignore.
   */
  sharedDirs?: string[];
  /** run in a new worktree after copy and share, before the session starts */
  setupCommand?: string;
}

/** The longest list a project setting keeps, and the longest entry in it. */
export const PROJECT_LIST_MAX = 32;
export const PROJECT_ENTRY_MAX = 260;
export const SETUP_COMMAND_MAX = 1000;

/**
 * Is `rel` a path INSIDE a checkout, written relative to its root? Copy and
 * share entries are joined onto two folders (the primary checkout and the new
 * worktree), so an absolute path, a drive letter or a `..` segment would reach
 * outside both.
 */
export function isInsideRelative(rel: unknown): rel is string {
  if (typeof rel !== 'string') return false;
  const r = rel.trim();
  if (r === '' || r.length > PROJECT_ENTRY_MAX) return false;
  if (/^[\\/]/.test(r) || /^[A-Za-z]:/.test(r)) return false;
  const parts = r.split(/[\\/]+/).filter((s) => s !== '');
  if (parts.length === 0) return false;
  return parts.every((s) => s !== '..' && s !== '.' && s !== '.git');
}

/** The one spelling of a relative entry: forward slashes, no trailing slash. */
export function cleanRelative(rel: string): string {
  return rel.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

/**
 * A branch name as a folder name: every run of other characters becomes one
 * dash. `feat/1629-mcp-keys` → `feat-1629-mcp-keys`.
 */
export function branchSlug(branch: string): string {
  const s = branch
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return s || 'worktree';
}

/**
 * A branch name offered for what the work is for: lower-case words joined by
 * dashes, short enough to read in the card. The user can change it.
 */
export function suggestBranch(purpose: string): string {
  return purpose
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** What the new-worktree dialog sends (`projects:createWorktree`). */
export interface NewWorktreeRequest {
  projectId: string;
  /** the branch the worktree checks out */
  branch: string;
  /** true: make `branch` from `base`; false: check out an existing branch */
  newBranch: boolean;
  /** the ref a new branch starts from; ignored for an existing branch */
  base?: string;
  /** the session's name once the worktree is ready */
  title?: string;
  /** run the project's setup command (copy and share always run) */
  runSetup: boolean;
}

/**
 * A worktree being built in the background (#1506). Main owns these and pushes
 * every change on `projects:jobChanged`; the card draws them under the project.
 *
 * - `creating` → `copying` → `linking` → `setup` → `ready`: the session starts
 *   (the window claims the job and starts it).
 * - `failed`: git could not make the worktree; nothing was left behind.
 * - `setup-failed`: the worktree exists but the setup command failed; the card
 *   offers to start the session anyway, keep the worktree, or discard it.
 */
export type WorktreeJobPhase =
  | 'creating'
  | 'copying'
  | 'linking'
  | 'setup'
  | 'ready'
  | 'failed'
  | 'setup-failed'
  | 'done';

export interface WorktreeJob {
  id: string;
  projectId: string;
  branch: string;
  /** the worktree's folder (native separators) */
  path: string;
  /** the session's name when it starts */
  title: string;
  phase: WorktreeJobPhase;
  /** git's words on failure, or the setup command's last line (not translated: quoted) */
  detail?: string;
  /** copy / share steps that were skipped (fail-open); the window words them */
  warnings: WorktreeWarning[];
}

export type WorktreeWarningCode =
  | 'copy-missing'
  | 'copy-failed'
  | 'share-missing'
  | 'share-not-ignored'
  | 'share-exists'
  | 'share-failed';

export interface WorktreeWarning {
  code: WorktreeWarningCode;
  /** the copy or share entry it is about */
  entry: string;
  /** the system's own words, when there are any */
  detail?: string;
}

/** Why `projects:configure` left an entry out; the window words it. */
export type ProjectSettingProblemCode =
  | 'base-invalid'
  | 'folder-not-local'
  | 'folder-inside-repo'
  | 'entry-outside'
  | 'share-not-ignored'
  | 'share-unknown'
  | 'setup-too-long'
  | 'not-a-list';

export interface ProjectSettingProblem {
  code: ProjectSettingProblemCode;
  field: 'base' | 'folder' | 'copy' | 'share' | 'setup';
  entry?: string;
}

/** The branches the dialog offers (`projects:branches`). */
export interface ProjectBranches {
  local: string[];
  remote: string[];
  /** what a new worktree starts from when nobody says: origin's default, else main/master, else HEAD's branch */
  defaultBase: string | null;
}

/** What `projects:checkout` says about a folder (the busy-folder prompt). */
export interface CheckoutInfo {
  /** the checkout's own folder (git's toplevel) */
  toplevel: string;
  commonDir: string;
  branch: string | null;
  /** files changed and not committed; null when status could not be read */
  dirty: number | null;
}

/** The app-wide project settings (Settings ▸ General ▸ Projects). */
export interface ProjectDefaults {
  /** unset = `defaultRoot` */
  worktreeRoot?: string;
  /** what main uses when nothing is set (read-only, for the settings page) */
  defaultRoot?: string;
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
