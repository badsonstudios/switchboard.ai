// How the document viewer's header folds into "…" in a narrow pane (#1408).
//
// The header is a single row — Back/Forward, the file name, its folder, the
// session chip, then Rendered|Source, Outline, Readable width, Open externally,
// Reveal in folder and pop-out — and only the folder could shrink. A 348px pane
// needed 448px of it and a 476px pane (the default window, one document beside
// one card) needed 511px, so the right-hand buttons sat past the pane's edge.
//
// THE RULE IS THE DIFF TOOLBAR'S (`lib/diff-toolbar-fit`, #1384), not a second
// one: the same arithmetic, the same slack, the same "0×0 is not a measurement".
// What is specific to this header is only WHICH groups fold and in what order:
//
//   1. the file actions — Open externally, Reveal in folder. The widest pair,
//      and the least used: they leave the viewer.
//   2. the view controls — Rendered|Source, Outline, Readable width.
//
// Never folded: Back/Forward, the name (the pane's identity — it truncates
// instead, as the very last resort), the session chip, the encoding note, and
// pop-out. The FOLDER shrinks first, exactly as before; it is the path's
// `pathMin` of 0, because unlike the diff toolbar's path it is not the identity.
//
// So this file holds only what the fold needs that the diff toolbar does not:
// the thresholds at which two of the folded chips would not be on the row at
// all, which the "…" menu has to honour too.

/**
 * The pane widths under which `tokens.css` hides the Outline and Readable width
 * chips (`@container doc-pane (max-width: …)`, #1010 and #1404). A folded chip
 * lives in a menu that is NOT inside that container, so the menu asks the same
 * question in numbers — the CSS and these are pinned together by a test that
 * reads `tokens.css`.
 */
export const OUTLINE_CHIP_MAX_HIDDEN_PX = 420;
export const MEASURE_CHIP_MAX_HIDDEN_PX = 600;

/** Is a chip hidden by `@container doc-pane (max-width: <max>px)` at this pane width? */
export function chipHiddenAt(paneWidth: number, max: number): boolean {
  return paneWidth <= max;
}
