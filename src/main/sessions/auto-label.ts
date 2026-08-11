// Auto task labels (P2-E7-06, §5.11): who owns a card's task label, and what
// the CLI's own conversation title is allowed to do to it.
//
// A pure module on purpose. Every rule below is one of Dan's four decisions of
// 2026-07-30, and a rule you can call in a test is the only kind you can prove:
// "typing pins it forever" and "clearing hands it back" are claims about a
// DECISION, not about an IPC handler.
//
// Nothing here knows what a transcript looks like, which CLI wrote it, or that
// `ai-title` exists — the provider's `titles` capability owns that spelling
// (see `providers/claude.ts`). This module is handed a title, or not.

/** Who last set a card's task label. Persisted on the card. */
export type LabelSource = 'auto' | 'user';

/** The slice of a persisted card this module reasons about. */
export interface LabelledCard {
  taskLabel?: string;
  labelSource?: LabelSource;
}

/**
 * Who owns this card's label right now.
 *
 * The stored `labelSource` decides — except for cards that predate this feature
 * (E7-03 shipped the typed label with no source at all) and for a hand-edited
 * workspace file carrying junk. Both fall back to the SAME rule the live
 * behaviour uses: a label with text in it is somebody's typing, a blank one is
 * nobody's.
 *
 * That fallback direction is the load-bearing one. Guessing 'auto' for a
 * pre-feature card would let the first `ai-title` line overwrite a label the
 * user typed weeks ago — a silent data loss on upgrade, in the one place the
 * user is most likely to notice and least able to explain.
 */
export function labelSourceOf(card: LabelledCard): LabelSource {
  if (card.labelSource === 'user' || card.labelSource === 'auto') return card.labelSource;
  return card.taskLabel && card.taskLabel.trim() ? 'user' : 'auto';
}

/**
 * What a freshly-seen conversation `title` should do to this card's label, or
 * `null` for "nothing" — which is the answer on the overwhelming majority of
 * calls, and the reason this returns a decision rather than performing one.
 *
 * `null` covers four genuinely different situations that all cost the same
 * (nothing): auto labels are switched off, the card is the user's, the CLI has
 * not produced a title, and the title has not moved since last time.
 *
 * The last of those is THE de-dupe, and it is the one that matters: a transcript
 * snapshot fires on every drain and carries the same settled title every time,
 * so without this each turn on each open session would rewrite the workspace
 * file and push a render. Measured on a real transcript: 13 `ai-title` lines,
 * one distinct title (`fixtures/ai-title.ts`).
 */
export function nextAutoLabel(
  card: LabelledCard,
  title: string | undefined,
  enabled: boolean
): string | null {
  if (!enabled) return null;
  if (labelSourceOf(card) === 'user') return null;
  // Capped like a typed one. The observed titles are six words, but this string
  // comes off an undocumented key in a file we do not write — the size of it is
  // not ours to assume, and a card header is one row either way.
  const clean = title?.trim().slice(0, MAX_LABEL_LENGTH);
  if (!clean) return null;
  return clean === card.taskLabel ? null : clean;
}

/**
 * The label this card should SHOW — undefined when it has none to show.
 *
 * Turning auto labels off has to take the phrase off the screen it is already
 * on, not merely stop the next one arriving: the reason for the switch is a
 * screen-share, and a stale label sitting on a card is exactly what the user is
 * trying not to broadcast (§5.11, litmus #4). So the stored value is KEPT and
 * hidden rather than deleted — flipping the switch back is instant and lossless,
 * and nothing the user typed is ever at risk, because a typed label is never
 * auto and is therefore never hidden.
 */
export function visibleTaskLabel(card: LabelledCard, enabled: boolean): string | undefined {
  if (!enabled && labelSourceOf(card) === 'auto') return undefined;
  return card.taskLabel;
}

/**
 * What `sessions:setTaskLabel` should store for what the user typed.
 *
 * The blank case is the whole reason this is a function: an empty field is not
 * an empty label, it is a HAND-BACK. Clearing the field drops the stored text
 * and returns the card to auto, so the next title refills it — which is the
 * only way "is it empty?" can stop being the ownership test while a deliberately
 * blank label remains possible to keep.
 *
 * `taskLabel` is ALWAYS present in the result, explicitly `undefined` for the
 * blank case. Callers spread this over the card they are updating, and a key
 * left out of a spread keeps the old value — so omitting it would clear the
 * ownership and leave the text, which is the one combination that means
 * "auto-fill will now overwrite something the user can still see".
 */
export function typedLabel(raw: string): { taskLabel: string | undefined; labelSource: LabelSource } {
  const clean = raw.trim().slice(0, MAX_LABEL_LENGTH);
  return clean
    ? { taskLabel: clean, labelSource: 'user' }
    : { taskLabel: undefined, labelSource: 'auto' };
}

/** Same cap as a card title (`sessions:renameCard`) — one row of a card header
 *  is one row of a card header whichever field is in it. */
export const MAX_LABEL_LENGTH = 120;
