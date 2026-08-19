// Where the "Open File…" browser starts (#569).
//
// `fs:pickFile` passed no `defaultPath` at all, so the dialog opened wherever
// the OS last left it — globally, across every app on the machine. The owner's
// ask: "it defaults to the working folder or remembers whatever the last folder
// was."
//
// THE RULE, and both halves matter:
//
//   1. the folder you last opened a file from, if there is one;
//   2. otherwise the FOCUSED SESSION's project folder, because that is the
//      "working folder" of the thing you are looking at.
//
// Nothing is persisted. The owner chose "survives until you quit" over a
// disk-backed memory, so this is module state and a restart starts fresh — one
// less absolute path written into the workspace file, and one less thing to go
// stale when a project moves.
//
// A module rather than a hook, for `lib/diff-places`' reason: it is a rule with
// edge cases and it is worth a unit test, and the caller is a command callback
// with no component around it.

let lastFolder: string | null = null;

/**
 * The folder a picked file came out of.
 *
 * Called by the BROWSE path only — File > Open File… and the palette. A document
 * opened by following a relative link inside another document, or from a path in
 * a session's conversation, does not move this: the user did not browse there,
 * and the next browse should start where they last chose to look.
 *
 * Takes the FILE and does the splitting here, so no caller has to know which
 * separator this platform used — main answers with the OS's own spelling, and
 * on Windows that is backslashes with a drive letter, while every path the
 * renderer builds itself uses forward slashes.
 */
export function rememberOpenedFile(absolutePath: string | null | undefined): void {
  if (typeof absolutePath !== 'string') return;
  const cut = Math.max(absolutePath.lastIndexOf('/'), absolutePath.lastIndexOf('\\'));
  // No separator at all is not a path we can take a folder from; a separator at
  // position 0 is the root, and "" is not a folder either.
  if (cut <= 0) return;
  lastFolder = absolutePath.slice(0, cut);
}

/**
 * Where the dialog should open, or undefined to let the OS decide.
 *
 * `sessionFolder` is the focused session's project folder, and is only consulted
 * when nothing has been opened yet — once the user has browsed somewhere, that
 * is the better guess about where they are working, even if the session says
 * otherwise.
 */
export function openFileStartFolder(sessionFolder?: string | null): string | undefined {
  if (lastFolder) return lastFolder;
  return typeof sessionFolder === 'string' && sessionFolder ? sessionFolder : undefined;
}

/** Tests only. */
export function forgetOpenFileStart(): void {
  lastFolder = null;
}
