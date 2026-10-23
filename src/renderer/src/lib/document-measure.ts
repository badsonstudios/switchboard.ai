// How wide the document viewer lets its rendered prose run (#1404, §5.30).
//
// The viewer used to cap `.doc-md` at 78 characters, a deliberate "readable
// measure". The owner found that in a wide window it reads as broken: the text
// sits in a narrow column on the left with empty pane beside it, and widening
// the window does nothing. VS Code's Markdown preview has no cap. So the default
// is now FULL — the prose fills the pane and reflows as it is resized — and this
// is the reader's way back to the old measure for anyone who preferred it.
//
// GLOBAL and not per panel, and module state rather than React state, for
// exactly `lib/document-outline`'s reasons (read its header): a `doc-` panel
// never survives a relaunch and its id is re-minted every launch, and N viewers
// — docked and popped out, all in this one renderer realm — read one value.
import { uiGet, uiSet } from './ui-state';

/** ui-blob key. NOT localStorage — the packaged renderer's origin changes port
 *  every launch, so a pref stored there survives nothing (P2-E15-06). */
export const DOCUMENT_MEASURE_KEY = 'documentMeasure';

/** `full`: the prose fills the pane. `readable`: capped at 78 characters. */
export type DocumentMeasure = 'full' | 'readable';

/** Full, because that is what the owner asked the default to be (#1404). */
export const DEFAULT_DOCUMENT_MEASURE: DocumentMeasure = 'full';

/**
 * One stored value -> a measure. Only the literal `'readable'` caps: anything
 * else — absent, a typo, a shape a future build wrote — is the default, because
 * a ui blob outlives the code that wrote it.
 */
export function parseDocumentMeasure(raw: unknown): DocumentMeasure {
  return raw === 'readable' ? 'readable' : DEFAULT_DOCUMENT_MEASURE;
}

const listeners = new Set<() => void>();

/** The preference, read through `lib/ui-state`'s cache every time (a string, so
 *  `useSyncExternalStore`'s reference compare is a value compare). */
export function getDocumentMeasure(): DocumentMeasure {
  return parseDocumentMeasure(uiGet<unknown>(DOCUMENT_MEASURE_KEY, DEFAULT_DOCUMENT_MEASURE));
}

/** Set and persist. A no-op write announces nothing. */
export function setDocumentMeasure(next: DocumentMeasure): DocumentMeasure {
  if (getDocumentMeasure() === next) return next;
  uiSet(DOCUMENT_MEASURE_KEY, next);
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* fail-open: a bad subscriber costs its own update, not everyone's */
    }
  }
  return next;
}

/** Flip it — what the toolbar chip runs. */
export function toggleDocumentMeasure(): DocumentMeasure {
  return setDocumentMeasure(getDocumentMeasure() === 'readable' ? 'full' : 'readable');
}

/** Fires whenever the preference changes (for `useSyncExternalStore`). */
export function subscribeDocumentMeasure(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ── WHO HAS PROSE TO MEASURE (#1408) ─────────────────────────────────────────
//
// `lib/document-outline`'s registry, for the same reason: the toolbar chip is
// greyed outside the rendered view (there is no prose for a reading width to
// cap), and the command palette's entry for the same switch is not inside any
// viewer. Each viewer says here whether it is showing rendered prose, and the
// command is enabled while any does.

const offering = new Set<string>();

/** A viewer says whether it is showing rendered prose. `key` is the viewer's own. */
export function setMeasureOffered(key: string, offered: boolean): void {
  if (offered) offering.add(key);
  else offering.delete(key);
}

/** Does any open document have prose the switch would visibly change? */
export function isMeasureOffered(): boolean {
  return offering.size > 0;
}

/** The tests' reset, and nothing else's. */
export function resetMeasureOfferedForTest(): void {
  offering.clear();
}
