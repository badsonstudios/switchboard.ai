// The unsent prompt, kept (#485, P2-E10-12).
//
// Typed-but-unsent composer text was bare React state, which meant it lived
// exactly as long as the component did — and the component dies more often than
// anyone expects: switching a card to the Terminal or Changes tab unmounts the
// Session panel (only `panel-terminal` is `keepMounted`), the stranded-popout
// rescue rebuilds the card from its record, and quitting obviously ends it. Two
// sentences of a half-written prompt is a real thing to lose, and the user has
// no way to get it back.
//
// WHERE IT GOES: the workspace `ui` blob, over `workspace.getUi`/`setUi`. NOT
// localStorage — the packaged renderer is served from a random loopback port, so
// its origin changes every launch and anything stored against it is gone by the
// next one (P2-E15-06's measured rule; `ui-state.ts` says it again at the top).
//
// SAVE ON CHANGE, NOT ON QUIT, and that is the whole design. A save-on-quit
// draft survives exactly one of the three ways it gets lost. `uiSetSoon` writes
// the in-memory blob synchronously and only debounces the IPC, so a remount that
// happens a tick later reads back what the user typed with nothing to wait for.
//
// KEYED BY CARD, NOT BY SESSION. The live session id churns — a resume mints a
// new one — so a draft filed under it would be orphaned by the very restart it
// is supposed to survive. `cardId` is the durable key (the same reason
// `feedVerbosity.<cardId>` uses it), which is also what makes "a suspended card
// gets its draft back when it resumes" true for free.
import { uiDelete, uiGet, uiSetSoon } from './ui-state';

/** One key per card. Namespaced, like every other per-card ui key. */
export function draftKey(cardId: string): string {
  return `composerDraft.${cardId}`;
}

/**
 * What this card had typed, or ''.
 *
 * Tolerant of anything that is not a string — a hand-edited workspace file, or
 * a key an older build wrote — because a composer that throws on mount is a
 * card you cannot use, and the value it is protecting is a draft.
 */
export function loadDraft(cardId: string | undefined): string {
  if (!cardId) return '';
  const v = uiGet<unknown>(draftKey(cardId), '');
  return typeof v === 'string' ? v : '';
}

/**
 * Remember this card's draft. Called on every keystroke; the debounce and the
 * synchronous cache write both live in `uiSetSoon`.
 *
 * An EMPTY draft deletes the key rather than storing '', so a workspace with
 * forty cards nobody has typed into carries forty fewer entries — the "an empty
 * draft doesn't bloat the store" clause, enforced here rather than by a sweep.
 *
 * A card with no id (a view rendered without one) simply does not persist:
 * there is no durable name to file it under, and inventing one would put a
 * draft on the wrong card after a restart.
 */
export function saveDraft(cardId: string | undefined, text: string): void {
  if (!cardId) return;
  uiSetSoon(draftKey(cardId), text.length > 0 ? text : undefined);
}

/**
 * The prompt went. Forget it — IMMEDIATELY, not on the debounce.
 *
 * The one asymmetry in this module, and it is deliberate: a draft that is late
 * to be saved costs a few hundred milliseconds of typing in a crash, while a
 * draft that is late to be CLEARED can be restored on top of an empty composer
 * after a send, which reads as the app un-sending your prompt.
 */
export function clearDraft(cardId: string | undefined): void {
  if (!cardId) return;
  uiDelete([draftKey(cardId)]);
}
