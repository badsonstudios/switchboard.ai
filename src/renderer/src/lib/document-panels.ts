// The peek slot and the pin contract for §5.30 document viewers (P2-E16-03).
//
// §5.30: "glancing at a file REPLACES the current viewer's content; pinning
// promotes it to a permanent tab and sends the next glance to a fresh peek
// slot. Without this rule the app accumulates thirty stale document tabs and
// fails the calm check by accretion."
//
// WHY THIS IS A MODULE AND NOT STATE IN `SessionGrid`. The thing that opens a
// viewer (`openDocumentPanel`) is already module-level — commands, the Changes
// tab and the boot seam all call it without a mounted component in the way —
// so the bookkeeping it needs has to live at the same altitude. Keeping it
// HERE rather than as three more `let`s in a 3,000-line component file is what
// makes the rules below testable as rules, without a dockview.
//
// ONE PIECE OF STATE, and that is the whole design: `peekId`. Pinned is not
// stored per panel, it is DERIVED — `pinned(id) === (id !== peekId)` — because
// two sources for one fact is how "pin a document, open another, unpin the
// first" ends up with two peek slots and a viewer that can never be replaced
// again. With the derivation, every gesture falls out of moving one pointer:
//
//   * pin the peek        → `peekId = null`; the next open has no slot to
//                           reuse, so it creates one. That IS "promotes it to
//                           a permanent tab and sends the next glance to a
//                           fresh peek slot".
//   * unpin a kept viewer → `peekId = <that panel>`; it becomes the slot the
//                           next glance replaces, and whatever WAS the slot
//                           reads as pinned from the same instant. Nothing is
//                           closed and nothing is silently replaceable: the
//                           protection moves, it does not evaporate.
//
// The alternative — a `pinned` boolean per entry — allows two unpinned viewers,
// and the second one is a panel the peek rule will never touch: a stale tab
// that looks transient and behaves permanent. VS Code has exactly one preview
// tab for the same reason; this is that invariant made structural.

/** One open viewer, as the peek/pin rules see it. */
export interface DocumentPanelEntry {
  /** the dockview panel id (`doc-<n>`) */
  id: string;
  /**
   * The file this panel was opened on.
   *
   * It moves when the peek slot is RE-POINTED, and only then. Following a
   * relative link inside the viewer moves what is on screen without telling
   * this module, so a viewer navigated from `DESIGN.md` to `00-process.md` is
   * still recorded against `DESIGN.md`. The one consequence: asking for
   * `00-process.md` from outside re-points the panel (`replace`) instead of
   * merely focusing it, which costs the back stack. In-viewer navigation is a
   * lens on one open document, not a new open, and teaching the registry about
   * it would mean routing every link click back out through the panel.
   */
  path: string;
  /** the card this viewer was opened from, for §5.24 attribution (or none) */
  sessionId?: string;
}

/** What the caller should do with dockview to honour an open request. */
export type DocumentOpenPlan =
  /** it is already open: raise it */
  | { action: 'focus'; id: string; path: string; sessionId?: string }
  /** the peek slot exists: re-point it at the new file */
  | { action: 'replace'; id: string; path: string; sessionId?: string }
  /** no peek slot: make one */
  | { action: 'create'; id: string; path: string; sessionId?: string };

const entries = new Map<string, DocumentPanelEntry>();
let peekId: string | null = null;
let seq = 0;

/**
 * Two spellings of one file are one document.
 *
 * The Changes tab joins with `/`, the native picker answers with `\`, and
 * `C:/p/a.md` and `C:\p\a.md` are the same bytes on disk. Case is left alone —
 * it decides nothing on POSIX and guessing on Windows is worse than the
 * occasional duplicate.
 */
export function documentKey(path: string): string {
  return path.replace(/\\/g, '/');
}

/** The panel that the next glance replaces, or null when there is none. */
export function documentPeekId(): string | null {
  return peekId;
}

/** Is this viewer protected from the next glance? */
export function isDocumentPinned(id: string): boolean {
  return id !== peekId;
}

/** Every open viewer, in the order they were opened. Read-only; for tests and
 *  for the caller's "sync the pinned flag onto every panel" pass. */
export function documentPanels(): readonly DocumentPanelEntry[] {
  return [...entries.values()];
}

/**
 * Decide where `path` should open, and record the decision.
 *
 * The caller then does the dockview half — `focus`, `updateParameters`, or
 * `addPanel` with the returned id. Recording here rather than after the panel
 * exists keeps the two halves from disagreeing when `addPanel` throws: a plan
 * for a panel that failed to open is corrected by `forgetDocumentPanel`, which
 * the removal handler calls anyway.
 */
export function planDocumentOpen(path: string, sessionId?: string): DocumentOpenPlan {
  const key = documentKey(path);
  for (const entry of entries.values()) {
    if (documentKey(entry.path) === key) {
      // Already open — raise it rather than opening a second copy or, worse,
      // burning the peek slot on a document the user can already see.
      return { action: 'focus', id: entry.id, path: entry.path, sessionId: entry.sessionId };
    }
  }
  const peek = peekId ? entries.get(peekId) : undefined;
  if (peek) {
    // THE PEEK SLOT, doing its one job. Attribution follows the content: a
    // viewer re-pointed from a different session's Changes tab now belongs to
    // that session, and a re-point from the palette carries no session at all.
    peek.path = path;
    peek.sessionId = sessionId;
    return { action: 'replace', id: peek.id, path, sessionId };
  }
  seq += 1;
  const id = `doc-${seq}`;
  entries.set(id, { id, path, sessionId });
  peekId = id;
  return { action: 'create', id, path, sessionId };
}

/**
 * Set a viewer's pin state.
 *
 * Pinning the peek empties the slot; unpinning anything claims it. Pinning a
 * viewer that is already pinned, or unpinning the peek, are both no-ops — the
 * control cannot show either state, but a stale param could ask for it.
 */
export function setDocumentPinned(id: string, pinned: boolean): void {
  if (!entries.has(id)) return;
  if (pinned) {
    if (peekId === id) peekId = null;
    return;
  }
  peekId = id;
}

/** The panel is gone. Drop it, and free the slot if it held it. */
export function forgetDocumentPanel(id: string): void {
  if (!entries.delete(id)) return;
  if (peekId === id) peekId = null;
}

/** The path a viewer is currently showing, or undefined if it is not open. */
export function documentPanelPath(id: string): string | undefined {
  return entries.get(id)?.path;
}

/** Test seam — a fresh renderer has no viewers, and neither should a test. */
export function resetDocumentPanels(): void {
  entries.clear();
  peekId = null;
  seq = 0;
}
