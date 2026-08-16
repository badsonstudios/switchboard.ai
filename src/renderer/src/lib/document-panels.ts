// The open-document registry for §5.30 document viewers (P2-E16-03, #530).
//
// **THE CONTRACT, decided by the owner on 2026-08-15 (#530): every file opens
// its own tab.** Opening a file ALWAYS creates a new viewer panel, docked
// beside the ones already open. Nothing is ever replaced, and tabs close by
// their ✕ and nothing else.
//
// THIS SUPERSEDES the peek slot and the pin (#410/#460, and §5.30's original
// "one peek slot, pin to keep" bullet, which DESIGN.md has been rewritten to
// match). That design had exactly one replaceable viewer: a second glance
// re-pointed the panel you were reading, and a 📌 was how you kept it. It was
// promoted from IntelliJ's preview tab to stop the app accumulating thirty
// stale document tabs — a real risk, and the owner's answer to it is the ✕:
// "when a file opens it should just open a new tab automatically… it doesn't
// close the previous file window." A surface that silently replaces what you
// were reading costs more than the tab strip it saves, because the thing it
// takes away is the one you did not ask it to take away. Accretion is a mess
// you can see and undo; a vanished document is not.
//
// WHAT SURVIVED THE CHANGE, and it is the reason this module still exists:
// **opening a file that is already open focuses its tab.** That is not the
// peek rule in disguise — it is the same rule every tabbed reader has, and
// without it "always a new tab" would mean two tabs on one file and no way to
// tell them apart. It needs a registry of what is open, keyed by path, which
// is all that is left here.
//
// WHY A MODULE AND NOT STATE IN `SessionGrid`. The thing that opens a viewer
// (`openDocumentPanel`) is already module-level — commands, the Changes tab
// and the boot seam all call it without a mounted component in the way — so
// the bookkeeping it needs has to live at the same altitude. Keeping it HERE
// rather than as two more `let`s in a 3,000-line component file is what makes
// the rule below testable as a rule, without a dockview.

/**
 * What every viewer's dockview panel id starts with.
 *
 * A CONTRACT since #533, not a formatting detail: the command context asks
 * "is the active panel a document?" by this prefix, exactly as it asks "is it a
 * card?" by `session-`. Two spellings of it would be two answers.
 */
export const DOCUMENT_PANEL_PREFIX = 'doc-';

/** One open viewer, as the open/focus rule sees it. */
export interface DocumentPanelEntry {
  /** the dockview panel id (`doc-<n>`) */
  id: string;
  /**
   * The file this panel was opened on.
   *
   * FIXED FOR THE LIFE OF THE PANEL. Under the peek slot this moved when the
   * slot was re-pointed; nothing re-points a panel any more, so the only way
   * it can drift from what is on screen is the viewer's own back/forward:
   * following a relative link from `DESIGN.md` to `00-process.md` changes the
   * document without telling this module. The one consequence is that asking
   * for `00-process.md` from outside then opens a SECOND tab on it rather than
   * focusing the one that happens to be showing it — which under "every file
   * opens its own tab" is at least the consistent answer, where under the peek
   * slot the same gap silently ate a back stack. Teaching the registry about
   * in-viewer navigation would mean routing every link click back out through
   * the panel; it is a lens on one open document, not a new open.
   */
  readonly path: string;
  /** the card this viewer was opened from, for §5.24 attribution (or none) */
  readonly sessionId?: string;
}

/** What the caller should do with dockview to honour an open request. */
export type DocumentOpenPlan =
  /** it is already open: raise it */
  | { action: 'focus'; id: string; path: string; sessionId?: string }
  /** everything else: a new tab, beside the ones already there */
  | { action: 'create'; id: string; path: string; sessionId?: string };

const entries = new Map<string, DocumentPanelEntry>();
let seq = 0;

/**
 * Two spellings of one file are one document.
 *
 * The Changes tab joins with `/`, the native picker answers with `\`, and
 * `C:/p/a.md` and `C:\p\a.md` are the same bytes on disk.
 *
 * CASE IS FOLDED WHERE THE FILE SYSTEM FOLDS IT, and #530 is why it now is.
 * The old comment here said case "decides nothing on POSIX and guessing on
 * Windows is worse than the occasional duplicate" — true when a duplicate meant
 * the peek slot re-pointing itself, invisible. Now a duplicate is a SECOND TAB
 * on one file, which is precisely the thing the focus rule exists to prevent
 * and which the manual promises does not happen. It is also not a guess: main
 * decided this question once, in `fs/read-scope.ts`'s `HOST_STYLE`, and
 * `fs/file-watch.ts` already folds by it so two spellings cannot become two
 * watches. This is that rule, on the renderer's side of the bridge.
 *
 * The platform comes from the preload bridge; with no bridge (a unit test that
 * has not stubbed one) nothing is folded, which is the POSIX answer and the
 * conservative one — it can only ever split a document, never merge two.
 */
export function documentKey(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  return caseInsensitiveHost() ? slashed.toLowerCase() : slashed;
}

/**
 * `globalThis`, not `window`, and it is not a style choice: this module is pure
 * enough that its own tests run in vitest's NODE environment, where a bare
 * `window` is a `ReferenceError` rather than an undefined — so naming `window`
 * here would make the case rule a crash in every test that opens a document.
 * In the renderer the two are the same object, and `contextBridge` puts
 * `switchboard` on it.
 */
function caseInsensitiveHost(): boolean {
  const platform = (globalThis as { switchboard?: { platform?: string } }).switchboard?.platform;
  return platform === 'win32' || platform === 'darwin';
}

/** Every open viewer, in the order they were opened. Read-only; for tests. */
export function documentPanels(): readonly DocumentPanelEntry[] {
  return [...entries.values()];
}

/**
 * Decide where `path` should open, and record the decision.
 *
 * The caller then does the dockview half — `focus`, or `addPanel` with the
 * returned id. Recording here rather than after the panel exists keeps the two
 * halves from disagreeing when `addPanel` throws: a plan for a panel that
 * failed to open is corrected by `forgetDocumentPanel`, which the removal
 * handler calls anyway.
 */
export function planDocumentOpen(path: string, sessionId?: string): DocumentOpenPlan {
  const key = documentKey(path);
  for (const entry of entries.values()) {
    if (documentKey(entry.path) === key) {
      // Already open — raise it rather than opening a second copy of one file.
      // The recorded `sessionId` is NOT overwritten: attribution says where a
      // document came from, and the answer to that does not change because
      // someone asked for it again from somewhere else.
      return { action: 'focus', id: entry.id, path: entry.path, sessionId: entry.sessionId };
    }
  }
  seq += 1;
  const id = `${DOCUMENT_PANEL_PREFIX}${seq}`;
  entries.set(id, { id, path, sessionId });
  return { action: 'create', id, path, sessionId };
}

/**
 * Is this a document viewer's panel id?
 *
 * The PREFIX, not a lookup in `entries`: this answers for a panel dockview
 * actually has, and the registry can lag it in one direction (a removal that
 * never reported, a layout restored from disk). A command that asked the
 * registry would then quietly do nothing for a viewer the user is looking at —
 * which is the failure mode #533 exists to remove — so the id is the authority
 * and `planDocumentOpen` is the only thing that mints one.
 */
export function isDocumentPanelId(id: string): boolean {
  return id.startsWith(DOCUMENT_PANEL_PREFIX);
}

/** The panel is gone. Drop it. */
export function forgetDocumentPanel(id: string): void {
  entries.delete(id);
}

/**
 * The path a viewer was OPENED ON, or undefined if it is not open.
 *
 * Not necessarily what it is showing — see `DocumentPanelEntry.path`; the
 * viewer's own back/forward moves the document without telling this module.
 */
export function documentPanelPath(id: string): string | undefined {
  return entries.get(id)?.path;
}

/** Test seam — a fresh renderer has no viewers, and neither should a test. */
export function resetDocumentPanels(): void {
  entries.clear();
  seq = 0;
}
