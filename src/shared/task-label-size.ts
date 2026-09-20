// How much task label you see (#877) — one vocabulary, shared by every surface.
//
// WHY A NAMED SIZE AND NOT A LINE COUNT ON THE WIRE. "Full" is a product
// decision the owner makes once; "three lines" is how the rail happens to
// render it today. If the stored value were a number, the card header and the
// rail would each be free to interpret it — and the moment one of them wanted
// two lines where the other drew three, the setting would mean two things. The
// name is the setting; `LABEL_LINES` below is the only place it becomes a count.
//
// Owner's instruction (2026-09-20): "Default to the full width and fill the
// space, but have options to make it smaller." So `full` is the default and the
// smaller sizes exist for someone running eight sessions who wants the rail
// dense rather than readable.

/** The sizes offered. `full` is the default — see the file header. */
export const TASK_LABEL_SIZES = ['full', 'medium', 'compact'] as const;
export type TaskLabelSize = (typeof TASK_LABEL_SIZES)[number];

export const DEFAULT_TASK_LABEL_SIZE: TaskLabelSize = 'full';

/**
 * Lines each size is allowed on screen.
 *
 * THE ONE PLACE A SIZE BECOMES A NUMBER. Both the rail row and the card header
 * clamp with this, so "full" cannot mean three lines in one and two in the
 * other — the drift that made this a named enum in the first place.
 *
 * `compact` is 1 and is therefore today's behaviour exactly: a single line,
 * ellipsised. Anyone who preferred the old rail keeps it by choosing this.
 */
export const LABEL_LINES: Record<TaskLabelSize, number> = {
  full: 3,
  medium: 2,
  compact: 1,
};

/**
 * Is this a size we offer?
 *
 * §5.29's rule: a value arriving from the renderer or out of a hand-edited
 * workspace file is untrusted, so the vocabulary is checked at runtime rather
 * than asserted by a cast. Shared so main and the renderer cannot disagree about
 * what is legal — the `isAutonomyMode` lesson, where an inline copy of the list
 * was the one thing that could go stale and silently refuse a real mode.
 */
export function isTaskLabelSize(v: unknown): v is TaskLabelSize {
  return typeof v === 'string' && (TASK_LABEL_SIZES as readonly string[]).includes(v);
}

/**
 * The size to use for a stored value, falling back to the default.
 *
 * Fail-open in the direction that shows MORE rather than less: a value we cannot
 * read is a value nobody chose, and the default is what someone who never opened
 * the dialog gets. Silently collapsing to `compact` would make a corrupt file
 * look like a deliberate preference for terse labels.
 */
export function taskLabelSizeOf(v: unknown): TaskLabelSize {
  return isTaskLabelSize(v) ? v : DEFAULT_TASK_LABEL_SIZE;
}

/** Lines for a stored value, tolerant of junk — what a renderer clamps with. */
export function labelLinesOf(v: unknown): number {
  return LABEL_LINES[taskLabelSizeOf(v)];
}
