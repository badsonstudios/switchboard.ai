// Where the find bar is open, and what it is looking for (P2-E17-02, §5.31).
//
// TWO things live here and they have different lifetimes, which is the whole
// reason this is a module rather than component state:
//
//   • `openOn` — the card whose bar is showing. Ctrl+F is dispatched by App's
//     keydown handler, which knows the ACTIVE CARD ID and nothing about that
//     card's React tree; the bar is rendered by `SessionCardPanel`, which is a
//     different subtree in a different dockview panel (possibly in another OS
//     window). One of them has to publish and the other subscribe.
//
//   • `term` and the two options — STICKY, and sticky is a browser-find
//     promise: you press Ctrl+F, type, Esc, switch tab, press Ctrl+F again and
//     your term is still there. Component state dies with the panel, and every
//     tab switch unmounts one (`keepMounted` is the exception, not the rule).
//
// NOT PERSISTED, deliberately: §5.31's non-goals say no search history, and a
// term restored from three days ago at the next launch is the smallest,
// creepiest version of one.
import type { FindQuery } from '../extensibility/contributions';

interface FindBarState {
  /** cardId whose bar is open, or null */
  readonly openOn: string | null;
  /**
   * Bumped by every Ctrl+F, including one pressed while the bar is already
   * open. A browser's second Ctrl+F re-focuses the box and selects what is in
   * it, and `openOn` alone cannot express that — it did not change, so nothing
   * downstream would re-run.
   */
  readonly openNonce: number;
  readonly term: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  /** the results list is expanded (§5.31's hybrid presentation) */
  readonly listOpen: boolean;
}

const INITIAL: FindBarState = Object.freeze({
  openOn: null,
  openNonce: 0,
  term: '',
  caseSensitive: false,
  wholeWord: false,
  listOpen: false,
});

let state: FindBarState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<FindBarState>): void {
  const next = { ...state, ...patch };
  // identity is the subscription contract (useSyncExternalStore compares
  // snapshots by reference) — so a no-op set must not produce a new object
  if (
    next.openOn === state.openOn &&
    next.openNonce === state.openNonce &&
    next.term === state.term &&
    next.caseSensitive === state.caseSensitive &&
    next.wholeWord === state.wholeWord &&
    next.listOpen === state.listOpen
  ) {
    return;
  }
  state = Object.freeze(next);
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* fail-open */
    }
  }
}

export function findBarState(): FindBarState {
  return state;
}

export function subscribeFindBar(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Open the bar on a card.
 *
 * Re-opening on the card it is already showing on is NOT a no-op: it bumps
 * `openNonce`, and the bar re-focuses and selects its input off that — which
 * is what a second Ctrl+F means in every browser.
 */
export function openFindBar(cardId: string | null): void {
  if (!cardId) return;
  set({ openOn: cardId, openNonce: state.openNonce + 1 });
}

export function closeFindBar(): void {
  set({ openOn: null, listOpen: false });
}

/** The bar's own edits. The term survives the close — see the header. */
export function setFindTerm(term: string): void {
  set({ term });
}

export function setFindOptions(opts: { caseSensitive?: boolean; wholeWord?: boolean }): void {
  set(opts);
}

export function setFindListOpen(listOpen: boolean): void {
  set({ listOpen });
}

/** The sticky query, in the shape a provider takes. */
export function findQuery(): FindQuery {
  return { term: state.term, caseSensitive: state.caseSensitive, wholeWord: state.wholeWord };
}

/**
 * Test hook: back to a fresh module. Never called in production.
 *
 * It drops SUBSCRIBERS as well as state, so call it before mounting anything
 * in a case — calling it while a component is mounted leaves a live
 * `useSyncExternalStore` deaf to every later change.
 */
export function resetFindBarState(): void {
  state = INITIAL;
  listeners.clear();
}
