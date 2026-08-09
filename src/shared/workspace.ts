// What the renderer is told about the workspace file's health (#207).
//
// Shared rather than main-only because both ends type the same payload: the
// store produces it, the preload carries it, and the notice banner renders it.

/**
 * Whether the workspace store can still write its file.
 *
 * `failing` is NOT "the last save threw" — a single EPERM from a scanner
 * touching the file for a moment is normal on Windows and clears itself. It
 * means saving has failed repeatedly and is still failing, so what is on disk
 * is now older than what is on screen. It goes back to `false` the moment a
 * save succeeds; see `WorkspaceStore.save`.
 *
 * `file` rides along because the only useful thing a user can do about this is
 * go and look at that file — its drive, its permissions, whatever is holding
 * it — and the renderer has no other way to know where it is.
 */
export interface WorkspaceSaveState {
  failing: boolean;
  /** absolute path of `workspace.json` */
  file: string;
}
