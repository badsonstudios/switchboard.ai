// §5.8's presentation ladder — the rules (P2-E9-05).
//
// Everything here is a decision the app makes without a user watching: which
// rung a step lands on, whether a rung keeps a dockview panel, and — the one
// with teeth — which events bring a session back on their own. They are pure
// functions precisely so these can be tests rather than e2e guesses.
import { describe, it, expect } from 'vitest';
import type { AttentionEvent } from './queue';
import type { AttentionResponse } from './focus-policy';
import {
  hasPanel,
  LADDER_ORDER,
  revealTargets,
  REVEAL_KINDS,
  slotIsLive,
  stepDown,
  stepUp,
} from './ladder';

describe('the ladder itself', () => {
  it('runs from most screen to none', () => {
    expect(LADDER_ORDER).toEqual(['expanded', 'collapsed', 'tabbed', 'hidden']);
  });

  it('steps down one rung at a time and STOPS at the bottom', () => {
    expect(stepDown('expanded')).toBe('collapsed');
    expect(stepDown('collapsed')).toBe('tabbed');
    expect(stepDown('tabbed')).toBe('hidden');
    // never wraps: "collapse again" turning a hidden session back into a full
    // card would be a gesture that silently undoes itself
    expect(stepDown('hidden')).toBe('hidden');
  });

  it('steps up one rung at a time and stops at the top', () => {
    expect(stepUp('hidden')).toBe('tabbed');
    expect(stepUp('tabbed')).toBe('collapsed');
    expect(stepUp('collapsed')).toBe('expanded');
    expect(stepUp('expanded')).toBe('expanded');
  });

  it('round-trips every rung: down then up is where you started', () => {
    for (const rung of LADDER_ORDER) {
      if (rung === 'hidden') continue; // the bottom has nowhere further down
      expect(stepUp(stepDown(rung))).toBe(rung);
    }
  });

  it('knows which rungs have a dockview panel', () => {
    // the single source of truth for the hide-vs-show half of a transition:
    // SessionGrid adds a panel when this turns true and removes one when it
    // turns false
    expect(LADDER_ORDER.filter(hasPanel)).toEqual(['expanded', 'tabbed']);
  });

  it('treats only an expanded card as being AT its slot', () => {
    // a tabbed card's panel sits in the shared stack, which is not where it
    // came from — letting the slot recorder write that would overwrite home
    // with the stack and strand it there for good
    expect(LADDER_ORDER.filter(slotIsLive)).toEqual(['expanded']);
  });
});

// ── reveal on needs-attention ───────────────────────────────────────────────

const ev = (id: number, sessionId: string, kind: AttentionEvent['kind']) => ({
  id,
  sessionId,
  kind,
});

/**
 * The default wiring: live id == card id, and every card is hidden.
 *
 * `respond` defaults to the REVEAL-ONLY answer — put a card back if it isn't on
 * screen, and never take focus — because the tests below are about the ladder's
 * walk over the feed (the kind filter, the seen set, the live→card mapping,
 * de-duplication), not about which of E9-10's four settings the user is on.
 * The policy's own interaction is the last block in this describe, where the
 * response is passed explicitly, and the four-way rule itself is
 * lib/focus-policy's test.
 */
function opts(onScreen: Record<string, boolean> = {}, act = true) {
  return {
    cardIdFor: (s: string) => s,
    onScreen: (c: string) => onScreen[c] ?? false,
    act,
    respond: (_c: string, on: boolean): AttentionResponse => (on ? 'mark' : 'reveal'),
  };
}

describe('revealTargets (§5.8 reveal triggers)', () => {
  it('reveals on permission, input and done — and on nothing else', () => {
    expect(REVEAL_KINDS).toEqual(['needs-permission', 'needs-input', 'done']);
    const events = [
      ev(1, 'a', 'needs-permission'),
      ev(2, 'b', 'needs-input'),
      ev(3, 'c', 'done'),
      ev(4, 'd', 'ready'),
      // crashed is deliberately NOT a trigger: §5.8 enumerates three, and a
      // crashed session is not waiting on an answer. It still reaches you
      // through the queue, its lamp and the events list.
      ev(5, 'e', 'crashed'),
    ];
    expect(revealTargets(events, new Set(), opts()).cardIds).toEqual(['a', 'b', 'c']);
  });

  it('leaves a card that is already on screen alone', () => {
    // re-placing a panel you can already see would move it for no reason — and
    // would drag a tabbed card out of the stack it was put in
    const events = [ev(1, 'a', 'needs-permission'), ev(2, 'b', 'needs-permission')];
    const plan = revealTargets(events, new Set(), opts({ a: true }));
    expect(plan.cardIds).toEqual(['b']);
  });

  it('places every card you cannot see, whatever is keeping it off screen', () => {
    // collapsed, stacked behind another tab, hidden — "not where you can work
    // in it" is one answer, and dockview gives it
    const events = [ev(1, 'a', 'done'), ev(2, 'b', 'done'), ev(3, 'c', 'done')];
    const plan = revealTargets(events, new Set(), opts({ a: false, b: false, c: false }));
    expect(plan.cardIds).toEqual(['a', 'b', 'c']);
  });

  it('acts ONCE per event, not on every feed push', () => {
    const events = [ev(1, 'a', 'needs-permission')];
    const first = revealTargets(events, new Set(), opts());
    expect(first.cardIds).toEqual(['a']);
    // the same list arriving again (a push that changed some other session)
    // must not fight a user who has collapsed it back in the meantime
    const second = revealTargets(events, first.seen, opts());
    expect(second.cardIds).toEqual([]);
  });

  it('reveals again when the session blocks a SECOND time', () => {
    // EventFeed mints a new id on every ingest, which is what makes this work:
    // keying by session id would suppress the second call for the life of the
    // process (the same reasoning as lib/queue's visited set)
    const first = revealTargets([ev(1, 'a', 'done')], new Set(), opts());
    expect(first.cardIds).toEqual(['a']);
    // it left the feed, then came back with a fresh id
    const quiet = revealTargets([], first.seen, opts());
    expect(quiet.seen.size).toBe(0); // the old id was pruned, not remembered
    const again = revealTargets([ev(7, 'a', 'needs-permission')], quiet.seen, opts());
    expect(again.cardIds).toEqual(['a']);
  });

  it('seeds the first list without acting on it', () => {
    // §5.25: the workspace comes back as the user left it. A launch that
    // instantly un-collapses every session that was blocked when you quit
    // yesterday is not that.
    const events = [ev(1, 'a', 'needs-permission'), ev(2, 'b', 'done')];
    const boot = revealTargets(events, new Set(), opts({}, false));
    expect(boot.cardIds).toEqual([]);
    expect([...boot.seen].sort()).toEqual([1, 2]);
    // ...and a genuinely new event after boot still reveals
    const later = revealTargets([...events, ev(3, 'c', 'done')], boot.seen, opts());
    expect(later.cardIds).toEqual(['c']);
  });

  it('maps the live session id to the durable card id', () => {
    // events carry the LIVE id, which churns on every resume; the ladder is
    // keyed by card. Getting this backwards would reveal nothing, silently.
    const plan = revealTargets([ev(1, 'live-9', 'done')], new Set(), {
      ...opts(),
      cardIdFor: (s) => (s === 'live-9' ? 'card-A' : s),
      onScreen: () => false,
      act: true,
    });
    expect(plan.cardIds).toEqual(['card-A']);
  });

  it('names a card once even when it has two queued events', () => {
    const events = [ev(1, 'a', 'needs-permission'), ev(2, 'a', 'needs-input')];
    expect(revealTargets(events, new Set(), opts()).cardIds).toEqual(['a']);
  });

  // ── the focus-stealing policy's half (P2-E9-10) ──────────────────────────
  //
  // What the four settings MEAN is lib/focus-policy's test; this is the wiring
  // — that the walk asks per card, and that each of the four answers reaches
  // the workspace as the right pair of (place it, focus it).

  it('an off-screen card that focuses is placed AND focused, in one call', () => {
    const events = [ev(1, 'a', 'done')];
    const plan = revealTargets(events, new Set(), {
      ...opts({ a: false }),
      respond: () => 'focus',
    });
    expect(plan.cardIds).toEqual(['a']);
    expect(plan.focusIds).toEqual(['a']);
  });

  it('an ON-SCREEN card is focused WITHOUT being placed', () => {
    // the whole of what `smart` does for a card you can see. Placing it too
    // would move a panel for nothing, and for a tabbed card it would pull it
    // out of its stack — a rearrangement, not a focus.
    const events = [ev(1, 'a', 'done')];
    const visible = { a: true };
    const focusing = revealTargets(events, new Set(), {
      ...opts(visible),
      respond: () => 'focus',
    });
    expect(focusing.cardIds).toEqual([]);
    expect(focusing.focusIds).toEqual(['a']);
    // and `reveal` on a card you can see is a no-op on both counts
    const revealing = revealTargets(events, new Set(), {
      ...opts(visible),
      respond: () => 'reveal',
    });
    expect(revealing.cardIds).toEqual([]);
    expect(revealing.focusIds).toEqual([]);
  });

  it('leaves the workspace untouched under `mark` and `ignore`', () => {
    const events = [ev(1, 'a', 'needs-permission'), ev(2, 'b', 'done')];
    for (const response of ['mark', 'ignore'] as const) {
      const plan = revealTargets(events, new Set(), { ...opts(), respond: () => response });
      expect(plan.cardIds).toEqual([]);
      expect(plan.focusIds).toEqual([]);
      // ...and the events are still ACCOUNTED FOR. A silenced session whose
      // ids were left unseen would fight the setting the moment its policy
      // changed, revealing a backlog the user never asked to see.
      expect([...plan.seen].sort()).toEqual([1, 2]);
    }
  });

  it('asks per card, so two sessions can be on different settings', () => {
    const events = [ev(1, 'loud', 'done'), ev(2, 'quiet', 'done')];
    const plan = revealTargets(events, new Set(), {
      ...opts(),
      respond: (cardId) => (cardId === 'loud' ? 'focus' : 'mark'),
    });
    expect(plan.cardIds).toEqual(['loud']);
    expect(plan.focusIds).toEqual(['loud']);
  });

  it('names a focusing card once even with two queued events', () => {
    const events = [ev(1, 'a', 'needs-permission'), ev(2, 'a', 'needs-input')];
    const plan = revealTargets(events, new Set(), { ...opts(), respond: () => 'focus' });
    expect(plan.focusIds).toEqual(['a']);
  });
});

