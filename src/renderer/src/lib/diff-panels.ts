// The open-diff registry (E24 Git v2 item 5, §5.7) — mockup screens 3 and 4.
//
// ⚠️ **THE STRUCTURAL DECISION, from design record §3: A DIFF BECOMES A DOCK
// PANEL, NOT A TAB BODY.** The reason is cause 3 of "everything's smashed
// together": card tabs are mutually exclusive, so reading a diff costs you sight
// of the conversation that produced it — and the pane then self-reports
// `tooNarrow` and silently drops to inline, which is #532's whole story.
//
// It costs almost nothing because the pattern is already proved. This module is
// `lib/document-panels.ts` with one difference, and the difference is the KEY: a
// document is identified by its path, while a diff is identified by **what is
// being compared** — the same file at `HEAD..working` and at `sha^..sha` are two
// different diffs and must be two panels. Everything else — the prefix as a
// contract, minting ids, focus-don't-duplicate, forgetting on removal, sparing
// popped-out ones from a bulk close — is the same rule, written once more because
// the two registries hold different things and a shared generic over them would
// be harder to read than either.

/**
 * What every diff panel's dockview panel id starts with.
 *
 * A CONTRACT, not a formatting detail — exactly as `doc-` is: the command context
 * asks "is the active panel a diff?" by this prefix, the way it asks "is it a
 * document?" by `doc-` and "is it a card?" by `session-`. Two spellings of it
 * would be two answers.
 *
 * ⚠️ **`gitdiff-`, AND THE DESIGN RECORD SAYS `diff-<n>`. THE DESIGN WAS WRONG
 * BECAUSE `diff-` IS ALREADY TAKEN.** `SessionGrid`'s existing `openDiff`
 * controller verb opens the WHOLE Changes tab into the document area as
 * `diff-<cardId>` — that is #504's subject, and it predates this item. Three
 * things read that prefix today and all three would have been confused:
 *
 *  - `documentHomeGroup` excludes any group containing `/^(session|diff)-/` from
 *    being the document area, because such a group is a session's own. A new
 *    panel matching `diff-` would therefore have been barred from the document
 *    area it is supposed to open into, and every comparison would have minted a
 *    group of its own.
 *  - the colour-scheme heal loop matches `diff-` and must reach these panels.
 *  - `isDiffPanelId` would have claimed an open Changes tab, so a bulk close or a
 *    "is the active panel a diff?" command would have acted on the wrong surface.
 *
 * Two prefixes for two different things is the honest shape: `diff-<cardId>` is a
 * SESSION'S Changes tab relocated, and `gitdiff-<n>` is one COMPARISON, which may
 * have no session behind it at all.
 */
export const DIFF_PANEL_PREFIX = 'gitdiff-';

/**
 * What a diff panel is OF.
 *
 * ⚠️ **THREE SHAPES, ONE FAMILY** (design §3), and the type admits all three from
 * the start so that items 4 and 9 add a caller rather than a second registry:
 *
 *  1. **one file, working tree vs index/HEAD** — screens 3 and 4. `path` set,
 *     `left`/`right` the working-tree sentinels.
 *  2. **all changes, stacked** — screen 5, item 9. `path` ABSENT, `left..right` a
 *     range.
 *  3. **one file at a commit** — screen 7, items 4 and 10. `path` set,
 *     `left = sha^`, `right = sha`.
 */
export interface DiffTarget {
  /** the repository root or session folder the two sides are read from */
  folder: string;
  /**
   * git's forward-slash relative path, or `undefined` for a whole-range diff.
   *
   * `undefined` is shape 2 and is NOT the same as the empty string, which is a
   * caller bug; `diffKey` keeps them apart so a mistake cannot quietly collide
   * with the all-changes panel.
   */
  path?: string;
  /** the "before" side: a sha, a ref, or `WORKING_TREE_LEFT` */
  left: string;
  /** the "after" side: a sha, a ref, or `WORKING_TREE_RIGHT` */
  right: string;
  /** the card this diff was opened from, for §5.24 attribution (or none) */
  sessionId?: string;
}

/**
 * The two sides of "what this session has changed".
 *
 * Named rather than spelled `'HEAD'` and `''` at each call site, because the pair
 * is a FACT about what `git:fileVersions` answers — `HEAD` vs the bytes on disk,
 * staged and unstaged together — and a caller that invented its own spelling
 * would mint a second panel for the same diff.
 */
export const WORKING_TREE_LEFT = 'HEAD';
export const WORKING_TREE_RIGHT = 'WORKTREE';

/** One open diff panel. */
export interface DiffPanelEntry {
  /** the dockview panel id (`gitdiff-<n>`) */
  id: string;
  readonly target: DiffTarget;
}

/** What the caller should do with dockview to honour an open request. */
export type DiffOpenPlan =
  /** it is already open: raise it */
  | { action: 'focus'; id: string; target: DiffTarget }
  /** everything else: a new tab, beside the ones already there */
  | { action: 'create'; id: string; target: DiffTarget };

const entries = new Map<string, DiffPanelEntry>();
let seq = 0;

/**
 * Two spellings of one comparison are one panel.
 *
 * ⚠️ **THE KEY IS `folder + path + left..right`, AND EVERY PART OF IT EARNS ITS
 * PLACE.** Drop `folder` and two sessions on two checkouts of one repository
 * share a panel. Drop `path` and the all-changes panel collides with every file
 * in it. Drop `left..right` and asking for a file at a commit focuses the
 * working-tree diff of the same file, showing the reader something they did not
 * ask for — which is the vanished-document failure `document-panels` records,
 * arriving by a different door.
 *
 * `sessionId` is NOT in the key: attribution says where a diff was opened from,
 * and two cards asking about the same comparison are asking one question.
 *
 * Path separators and case are folded exactly as `documentKey` folds them, and
 * for the same reasons — the Changes tab joins with `/`, git answers with `/`, a
 * picker answers with `\`, and `C:/p/a.ts` and `C:\p\a.ts` are the same bytes.
 */
export function diffKey(target: DiffTarget): string {
  const fold = (s: string): string => {
    const slashed = s.replace(/\\/g, '/');
    return caseInsensitiveHost() ? slashed.toLowerCase() : slashed;
  };
  // `\0` as the field separator: it is the one byte a path cannot contain, so no
  // folder/path pair can be spelled two ways that collide. `undefined` path and
  // empty-string path are therefore distinguishable, which is the point.
  const path = target.path === undefined ? '\u0000-' : `\u0000+${fold(target.path)}`;
  return `${fold(target.folder)}${path}\u0000${target.left}..${target.right}`;
}

/**
 * `globalThis`, not `window`, and it is not a style choice: this module is pure
 * enough that its own tests run in vitest's NODE environment, where a bare
 * `window` is a `ReferenceError` rather than an undefined — so naming `window`
 * here would make the case rule a crash in every test that opens a diff. In the
 * renderer the two are the same object, and `contextBridge` puts `switchboard`
 * on it.
 */
function caseInsensitiveHost(): boolean {
  const platform = (globalThis as { switchboard?: { platform?: string } }).switchboard?.platform;
  return platform === 'win32' || platform === 'darwin';
}

/** Every open diff panel, in the order they were opened. Read-only; for tests. */
export function diffPanels(): readonly DiffPanelEntry[] {
  return [...entries.values()];
}

/**
 * Decide where this comparison should open, and record the decision.
 *
 * The caller then does the dockview half — `focus`, or `addPanel` with the
 * returned id. Recording here rather than after the panel exists keeps the two
 * halves from disagreeing when `addPanel` throws: a plan for a panel that failed
 * to open is corrected by `forgetDiffPanel`, which the removal handler calls
 * anyway.
 */
export function planDiffOpen(target: DiffTarget): DiffOpenPlan {
  const key = diffKey(target);
  for (const entry of entries.values()) {
    if (diffKey(entry.target) === key) {
      // Already open — raise it rather than opening a second copy of one
      // comparison. The recorded `sessionId` is NOT overwritten, for the reason
      // `planDocumentOpen` gives: attribution is where it came FROM, and that
      // does not change because someone asked again from somewhere else.
      return { action: 'focus', id: entry.id, target: entry.target };
    }
  }
  seq += 1;
  const id = `${DIFF_PANEL_PREFIX}${seq}`;
  entries.set(id, { id, target });
  return { action: 'create', id, target };
}

/**
 * Is this a diff panel's id?
 *
 * The PREFIX, not a lookup in `entries`, and `document-panels` records why: this
 * answers for a panel dockview actually HAS, and the registry can lag it in one
 * direction (a removal that never reported). A command that asked the registry
 * would then quietly do nothing for a panel the user is looking at.
 *
 * ⚠️ **"a layout restored from disk" was in that list and is NOT a case here** —
 * `isDerivedPanelId` names `gitdiff-` so these panels are dropped on restore, and
 * review found that they were not. See that function for what it cost.
 */
export function isDiffPanelId(id: string): boolean {
  return id.startsWith(DIFF_PANEL_PREFIX);
}

/** The panel is gone. Drop it. */
export function forgetDiffPanel(id: string): void {
  entries.delete(id);
}

/** What a panel is a diff OF, or undefined if it is not open. */
export function diffPanelTarget(id: string): DiffTarget | undefined {
  return entries.get(id)?.target;
}

/** Test seam — a fresh renderer has no diff panels, and neither should a test. */
export function resetDiffPanels(): void {
  entries.clear();
  seq = 0;
}

/** One open diff panel, as a BULK operation sees it — dockview's answer. */
export interface DiffPanelShape {
  id: string;
  /** is it in ANOTHER OS window right now? */
  poppedOut: boolean;
}

/**
 * Which diffs a bulk close may take.
 *
 * **POPPED-OUT ONES ARE SPARED**, and the argument is `closableDocuments`' word
 * for word, because it is the same argument: popping out IS the surviving "keep
 * this one"; the gesture is about a TAB STRIP and a panel in its own window is not
 * a tab; and the costs are asymmetric — sparing costs one extra click on a
 * window's own ✕, while closing loses a window the user placed deliberately, from
 * a command typed in a different window.
 *
 * It matters MORE here than for a document. A popped-out diff is the thing this
 * whole item exists to make possible — the owner's request was to read a diff
 * while watching the conversation that produced it — so taking it away with a
 * bulk close would undo the feature from inside.
 *
 * ⚠️ **NOTHING CALLS THIS YET, AND `DIFF_PANEL_PREFIX`'s NOTE ABOUT "a bulk close"
 * IS THEREFORE ABOUT A COMMAND THAT DOES NOT EXIST** (said by review, not
 * discovered later). Design §4 item 5 does not ask for one: "Close all diffs" is
 * the answer to accretion, and accretion needs more than one diff panel to have
 * been opened in anger first. The rule is written now, with its test, because the
 * EXEMPTION is the part that is easy to forget when the command is eventually
 * added in a hurry — which is exactly how #543 came to need `closableDocuments`.
 */
export function closableDiffs(panels: readonly DiffPanelShape[]): string[] {
  return panels.filter((p) => isDiffPanelId(p.id) && !p.poppedOut).map((p) => p.id);
}
