// The live-surface registry for §5.31's find providers (P2-E17-02).
//
// A `find-provider` contribution is a VALUE registered once at boot. The thing
// it has to drive is a MOUNTED COMPONENT INSTANCE — this card's FeedView, that
// card's Monaco diff editor — and there are N of those on screen at a time,
// coming and going as tabs are switched and cards are popped out. The
// contribution cannot hold a reference to any of them.
//
// So the mounted panel PUBLISHES a small imperative surface here, keyed by
// (cardId, panelId), and the provider is handed the one belonging to the card
// Ctrl+F was pressed on. That key is the reason a search can never reach into
// another card: there is no way to ask for a surface without naming a card.
//
// Module-level rather than React context, following `lib/popout-windows.ts`:
// the reader is a keydown handler and a bar rendered by a sibling subtree, not
// a descendant of the panel that publishes.
//
// The concrete surface TYPES live here too, rather than beside the providers
// that read them: `FeedView` and `DiffPane` publish, and a panel component
// importing anything from the module that also exports `sessionFindProvider`
// would put a consumer one auto-import away from reaching a contributor
// directly — the one rule `docs/extensibility.md` opens with.
import type { FindQuery, FindSurface } from '../extensibility/contributions';
import type { DocumentSearchResult } from './document-find';
import type { TerminalMatch, TerminalSearchOutcome, TerminalSearchQuery } from './terminal-find';

/**
 * The registry key.
 *
 * `::` as the separator: a cardId is a uuid and a panelId is a kebab-case id,
 * so neither component can contain a colon and no two distinct pairs can
 * collapse onto one key. Exported because publishers, readers and tests all
 * have to build the same one.
 */
export function findSurfaceKey(cardId: string, panelId: string): string {
  return `${cardId}::${panelId}`;
}

/** What `FeedView` publishes — the Session view's half of jump-to-hit. */
export interface FeedFindSurface extends FindSurface {
  kind: 'feed';
  /**
   * Reveal a live Feed `seq`: force it past the verbosity filter, expand
   * whatever was folded over it, mark it, and scroll it into view.
   *
   * Returns whether the block is IN the view buffer at all. False is the
   * §5.31 v1 boundary, and the caller must not pretend it jumped.
   */
  jumpTo(seq: number): boolean;
  /** drop the reveal set and the highlight — the view as find found it */
  clear(): void;
}

/** What `DiffPane` publishes — a way into Monaco's own find, nothing more. */
export interface MonacoFindSurface extends FindSurface {
  kind: 'monaco';
  /**
   * Is there an editor with a MODEL on it? An editor is created when the pane
   * mounts, but no file is selected until the user picks one, and a find over
   * a model-less editor opens a widget that can never match anything.
   */
  ready(): boolean;
  /** focus the editor and open ITS find widget, seeded with `term`.
   *  False when there is nothing to search. */
  openFind(term: string): boolean;
}

/**
 * What `TerminalPane` publishes — xterm's scrollback, behind the search addon
 * (P2-E17-03).
 *
 * `search` is SYNCHRONOUS, unlike the session's: the buffer is already in this
 * process, and the addon walks it in memory. The provider still returns a
 * promise, because the seam's `search` is async for the one registrant that
 * genuinely crosses to main.
 */
export interface TerminalFindSurface extends FindSurface {
  kind: 'terminal';
  /**
   * Is there a live xterm with a buffer? A stream session renders a notice
   * instead of a terminal and never publishes at all, so this is about the
   * window between mount and `term.open()` — not about transport.
   */
  ready(): boolean;
  search(query: TerminalSearchQuery): TerminalSearchOutcome;
  /** scroll to and select a collected match */
  reveal(match: TerminalMatch): boolean;
  /** drop the highlights and the selection */
  clear(): void;
}

/**
 * What `DocumentViewer` publishes — the §5.30 viewer's two bodies (#533).
 *
 * THE ONE SURFACE WITH TWO HALVES, because the viewer has two bodies and they
 * want opposite treatment:
 *
 *  • RENDERED markdown is our own DOM, and `lib/document-find` marks matches in
 *    it — so the bar drives it (`search` / `reveal` / `clear`).
 *  • SOURCE is a Monaco editor, and §5.31 says not to reimplement Monaco's
 *    find — so that half DELEGATES, exactly as the Changes tab does
 *    (`openFind`).
 *
 * `view()` is how the provider tells them apart, and it is also why
 * `FindProviderContribution.modeFor` exists: one panel, one provider, and which
 * half is on screen is a runtime question the toggle in its own header answers.
 *
 * The KEY this publishes under is `findSurfaceKey(<the doc- panel id>, 'document')`
 * — the panel id plays the cardId role. A viewer is not a session card and has
 * no card to name, and the guarantee the key exists for ("a search can never
 * reach another card") holds by the same argument: there is no way to ask for a
 * surface without naming the panel it belongs to.
 */
export interface DocumentFindSurface extends FindSurface {
  kind: 'document';
  /** which body is on screen: ours, Monaco's, or nothing searchable yet */
  view(): 'rendered' | 'source' | 'none';
  /** rendered only: mark every match and describe them, in document order */
  search(query: FindQuery): DocumentSearchResult;
  /** rendered only: make the `index`-th mark current and scroll to it */
  reveal(index: number): boolean;
  /** rendered only: drop every mark, leaving the text as it was */
  clear(): void;
  /** source only: focus the editor and open Monaco's own find, seeded */
  openFind(term: string): boolean;
}

const surfaces = new Map<string, FindSurface>();
const listeners = new Set<() => void>();
/**
 * Bumped on every publish/withdraw.
 *
 * `useSyncExternalStore` compares snapshots by reference, so a reader that
 * needs SEVERAL surfaces (the grouped bar asks every registered panel for its
 * own) cannot snapshot them as an array — it would allocate a new one every
 * render and loop. A monotonic number is the snapshot; the reader derives the
 * surfaces from it in a memo.
 */
let version = 0;

function announce(): void {
  version += 1;
  // copy first: a listener that unsubscribes itself during the walk would
  // otherwise mutate the set we are iterating
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* fail-open: a bad subscriber costs its own update, not everyone's */
    }
  }
}

/**
 * Publish a mounted panel's surface. Returns the unpublish, for use as an
 * effect cleanup.
 *
 * Last publisher wins, deliberately: React can mount the next instance before
 * unmounting the previous one (StrictMode, and dockview re-parenting a popout),
 * and the newer instance is the one on screen. The cleanup only deletes the
 * entry if it is still the one it published, so a late cleanup from the OLD
 * instance cannot unpublish the NEW one.
 */
export function publishFindSurface(key: string, surface: FindSurface): () => void {
  surfaces.set(key, surface);
  announce();
  return () => {
    if (surfaces.get(key) !== surface) return;
    surfaces.delete(key);
    announce();
  };
}

/** The surface for a card's panel, or null when it has not mounted/published. */
export function findSurfaceFor(key: string): FindSurface | null {
  return surfaces.get(key) ?? null;
}

/** A snapshot token for readers that need more than one surface — see `version`. */
export function findSurfacesVersion(): number {
  return version;
}

/** Fires whenever any surface is published or withdrawn (for useSyncExternalStore). */
export function subscribeFindSurfaces(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Test hook: forget everything. Never called in production.
 *
 * It drops SUBSCRIBERS as well as surfaces, so call it before mounting
 * anything in a case — calling it while a component is mounted would leave a
 * live `useSyncExternalStore` deaf to every later change, which reads as a
 * component that has stopped updating for no reason.
 */
export function resetFindSurfaces(): void {
  surfaces.clear();
  listeners.clear();
  version += 1;
}
