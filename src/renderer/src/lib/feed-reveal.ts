// "Jumping to a hit EXPANDS that block" (§5.31) — the mechanism (P2-E17-02).
//
// §5.31 decides that find searches everything the view is hiding: thinking is
// folded to one line, tool boxes are collapsed, and a verbosity preset can
// drop a whole block out of the list. A find that respected those would be the
// same silent lie as searching the DOM, only subtler — `quiet` hides exactly
// the tool output error strings live in.
//
// The problem this module solves: every collapsible block renderer owns its
// open/closed `useState` privately (`extensibility/feed-blocks.tsx`), which is
// right — a block's fold is its own business — but it leaves nothing for the
// find bar to push on. Rather than lifting six pieces of state into FeedView,
// the feed publishes the SET OF SEQS FIND HAS REVEALED and each renderer ORs it
// into its own `open`. A renderer that never collapses anything ignores the
// context and nothing breaks; a contributed renderer that does not know about
// this still renders, it just does not auto-expand.
//
// It is deliberately one-way: find can open a block, and the user's own toggle
// still works afterwards, because `open || revealed` leaves `setOpen` alone.
// (Which means a revealed block cannot be re-collapsed while the bar is still
// on it. That is the honest trade: the alternative is find seeding state that
// then drifts from what the user does with it.)
import React from 'react';

export interface FeedReveal {
  /** every block the bar has jumped to since it opened */
  readonly revealed: ReadonlySet<number>;
  /** the one it is on RIGHT NOW — the highlight ring, not the expansion */
  readonly current: number | null;
}

const EMPTY: FeedReveal = Object.freeze({ revealed: Object.freeze(new Set<number>()), current: null });

const FeedRevealContext = React.createContext<FeedReveal>(EMPTY);

export const FeedRevealProvider = FeedRevealContext.Provider;

/** The neutral value: no find in progress. Exported so a test can assert it. */
export const NO_REVEAL = EMPTY;

/**
 * Has the find bar revealed this block? Collapsible renderers OR this into
 * their own open state.
 */
export function useRevealed(seq: number): boolean {
  return React.useContext(FeedRevealContext).revealed.has(seq);
}

/** Is this the block the bar is sitting on? Drives the highlight, nothing else. */
export function useCurrentHit(seq: number): boolean {
  return React.useContext(FeedRevealContext).current === seq;
}

/** The attribute a block wrapper carries so a jump can find its element. */
export const FEED_SEQ_ATTR = 'data-feed-seq';
