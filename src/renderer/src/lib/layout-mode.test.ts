import { describe, it, expect } from 'vitest';
import {
  cycleMode,
  DEFAULT_LAYOUT,
  forgetLayoutCard,
  isEnforced,
  LayoutCard,
  LayoutState,
  loadLayout,
  persistableLayout,
  plan,
  pruneLayout,
  snapshotRungs,
  withMaximized,
  withMode,
  withoutMaximized,
} from './layout-mode';
import type { Ladder } from './presentation';
import { showsRow } from './ladder';

/** a card at the default rung, needing nothing, in the main window */
function card(cardId: string, over: Partial<LayoutCard> = {}): LayoutCard {
  return { cardId, ladder: 'expanded', needsAttention: false, poppedOut: false, ...over };
}

const state = (over: Partial<LayoutState> = {}): LayoutState => ({
  ...DEFAULT_LAYOUT,
  ...over,
});

/** the plan as a plain map, for readable assertions */
function moves(
  s: LayoutState,
  cards: LayoutCard[],
  activeCardId: string | null = null,
  trigger: 'switch' | 'react' = 'switch',
  restore?: Record<string, Ladder>
): Record<string, Ladder> {
  const out: Record<string, Ladder> = {};
  for (const m of plan({ state: s, cards, activeCardId, trigger, ...(restore ? { restore } : {}) })) {
    out[m.cardId] = m.rung;
  }
  return out;
}

describe('layout modes (E9-07, §5.8)', () => {
  describe('grid', () => {
    it('gives every session a card again — including hidden ones', () => {
      const cards = [
        card('a', { ladder: 'collapsed' }),
        card('b', { ladder: 'hidden' }),
        card('c', { ladder: 'tabbed' }),
        card('d'),
      ];
      expect(moves(state({ mode: 'grid' }), cards, 'd')).toEqual({
        a: 'expanded',
        b: 'expanded',
        c: 'expanded',
        // 'd' is already expanded: a card that is where the mode wants it must
        // produce no dockview work at all
      });
    });

    it('is NOT enforced between switches — the default mode must never undo the ladder', () => {
      // The rule this file exists to protect: grid says "every session gets a
      // card", so a standing grid sweep would re-expand every card the user
      // collapsed by hand on the next status change.
      const cards = [card('a', { ladder: 'collapsed' }), card('b')];
      expect(isEnforced(state({ mode: 'grid' }))).toBe(false);
      expect(moves(state({ mode: 'grid' }), cards, 'b', 'react')).toEqual({});
      // ...and it still rearranges when you actually switch into it
      expect(moves(state({ mode: 'grid' }), cards, 'b', 'switch')).toEqual({ a: 'expanded' });
    });
  });

  describe('focus', () => {
    it('keeps the card you are IN and folds the rest into the strip', () => {
      const cards = [card('a'), card('b'), card('c')];
      expect(moves(state({ mode: 'focus' }), cards, 'b')).toEqual({
        a: 'collapsed',
        c: 'collapsed',
      });
    });

    it('follows focus: the big card moves with you', () => {
      const cards = [card('a', { ladder: 'collapsed' }), card('b'), card('c', { ladder: 'collapsed' })];
      // clicking 'c' expands it (the reveal contract) and this then folds 'b'
      expect(moves(state({ mode: 'focus' }), cards, 'c', 'react')).toEqual({
        c: 'expanded',
        b: 'collapsed',
      });
    });

    it('expands before it collapses — a card comes home to a slot that still exists', () => {
      const cards = [card('a'), card('b', { ladder: 'hidden' })];
      const list = plan({
        state: state({ mode: 'focus' }),
        cards,
        activeCardId: 'b',
        trigger: 'switch',
      });
      expect(list.map((m) => m.cardId)).toEqual(['b', 'a']);
    });

    it('falls back to the first card in rail order when nothing is focused', () => {
      // a relaunch lands here: the mode is restored before anything is focused,
      // and folding the ENTIRE workspace away would not be "one large + strips"
      const cards = [card('a'), card('b'), card('c')];
      expect(moves(state({ mode: 'focus' }), cards, null)).toEqual({
        b: 'collapsed',
        c: 'collapsed',
      });
    });

    it('keeps the card that is ALREADY big when focus moves off the cards', () => {
      // `activeCard` goes null whenever the active panel is not a session card —
      // opening a Changes tab does it. The big card must not jump to rail
      // position 1 because you looked at a diff.
      const cards = [card('a', { ladder: 'collapsed' }), card('b'), card('c', { ladder: 'collapsed' })];
      expect(moves(state({ mode: 'focus' }), cards, null, 'react')).toEqual({});
    });

    it('does not pick a big card for you when TWO are expanded', () => {
      // The case "first expanded card" gets wrong, and it is the normal one:
      // E9-05 reveals a session that needs a human WITHOUT focusing it, so a
      // second expanded card is routine. Open the Changes tab on the card you
      // are reading (activeCard -> null) and guessing would hand the screen to
      // the blocked session and fold the one you were reading.
      const cards = [
        card('a', { needsAttention: true }), // revealed by E9-05, not focused
        card('b'), // the one the user is actually reading
        card('c', { ladder: 'collapsed' }),
      ];
      expect(moves(state({ mode: 'focus' }), cards, null, 'react')).toEqual({});
    });

    it('does not go and fetch a card nobody put on screen', () => {
      // E9-06's auto-collapse can leave nothing expanded and nothing focused. A
      // reactive pass must not answer that by re-expanding rail position 1 —
      // that would be one §5.8 feature quietly undoing another.
      const cards = [card('a', { ladder: 'collapsed' }), card('b', { ladder: 'collapsed' })];
      expect(moves(state({ mode: 'focus' }), cards, null, 'react')).toEqual({});
      // ...but asking for focus mode outright still gives you a card
      expect(moves(state({ mode: 'focus' }), cards, null, 'switch')).toEqual({ a: 'expanded' });
    });

    it('a POPPED-OUT card is never the big card — it is in another window', () => {
      // folding this window around a card that is not in it empties the screen
      const cards = [card('a', { poppedOut: true }), card('b'), card('c')];
      expect(moves(state({ mode: 'focus' }), cards, 'a')).toEqual({ c: 'collapsed' });
    });

    it('an unknown active card is not the big card — the rail order is', () => {
      const cards = [card('a'), card('b')];
      expect(moves(state({ mode: 'focus' }), cards, 'ghost')).toEqual({ b: 'collapsed' });
    });
  });

  describe('queue', () => {
    it('expands only the sessions that need a human', () => {
      const cards = [
        card('a', { ladder: 'collapsed', needsAttention: true }),
        card('b'),
        card('c', { needsAttention: true }),
      ];
      expect(moves(state({ mode: 'queue' }), cards, null)).toEqual({
        a: 'expanded',
        // c already is
        b: 'collapsed',
      });
    });

    it('expands a session THE INSTANT it needs attention (the done-when)', () => {
      const before = [card('a'), card('b', { ladder: 'collapsed' })];
      expect(moves(state({ mode: 'queue' }), before, 'a', 'react')).toEqual({});
      const after = [card('a'), card('b', { ladder: 'collapsed', needsAttention: true })];
      expect(moves(state({ mode: 'queue' }), after, 'a', 'react')).toEqual({ b: 'expanded' });
    });

    it('does not empty the workspace out from under you: the focused card stays', () => {
      const cards = [card('a'), card('b'), card('c')];
      expect(moves(state({ mode: 'queue' }), cards, 'a')).toEqual({
        b: 'collapsed',
        c: 'collapsed',
      });
    });
  });

  describe('the exemptions', () => {
    it('never folds a session that needs a human — in ANY mode', () => {
      // E9-05 would reveal it again on the next event and the next sweep would
      // fold it again: a mode and the attention system taking turns on one card
      const cards = [card('a'), card('b', { needsAttention: true })];
      expect(moves(state({ mode: 'focus' }), cards, 'a')).toEqual({});
      expect(moves(state({ maximized: 'a' }), cards, 'a')).toEqual({});
    });

    it('never touches a popped-out card — that would close an OS window', () => {
      const cards = [card('a'), card('b', { poppedOut: true })];
      expect(moves(state({ mode: 'focus' }), cards, 'a')).toEqual({});
      expect(moves(state({ mode: 'queue' }), cards, 'a')).toEqual({});
    });

    it('leaves a card that is already out of the way where the user put it', () => {
      const cards = [card('a'), card('b', { ladder: 'hidden' }), card('c', { ladder: 'tabbed' })];
      // 'hidden' and 'tabbed' both satisfy "out of the way"; promoting them to
      // `collapsed` would be a demotion the user has to undo
      expect(moves(state({ mode: 'focus' }), cards, 'a')).toEqual({});
    });
  });

  describe('maximize', () => {
    it('blows one card up and puts the rest away, whatever the mode says', () => {
      const cards = [card('a'), card('b'), card('c', { ladder: 'collapsed' })];
      expect(moves(state({ maximized: 'b', mode: 'grid' }), cards, 'b')).toEqual({
        a: 'collapsed',
        // 'c' is already out of the way, 'b' is already expanded
      });
    });

    it('puts away the card you were in — unlike every other sweep', () => {
      const cards = [card('a'), card('b')];
      // focus mode spares the active card; a maximize on ANOTHER card is an
      // explicit "put the rest away", and the active card is part of the rest
      expect(moves(state({ mode: 'focus' }), cards, 'a')).toEqual({ b: 'collapsed' });
      expect(moves(state({ maximized: 'b' }), cards, 'a')).toEqual({ a: 'collapsed' });
    });

    it('restores the PRIOR layout, not the current mode', () => {
      // §5.8, verbatim: "restores the prior layout on repeat". A card the user
      // had hidden before maximizing is hidden again afterwards.
      const before = [card('a'), card('b', { ladder: 'hidden' }), card('c', { ladder: 'tabbed' })];
      const snapshot = snapshotRungs(before);
      expect(snapshot).toEqual({ a: 'expanded', b: 'hidden', c: 'tabbed' });

      const held = withMaximized(state({ mode: 'grid' }), 'a', snapshot);
      expect(held.maximized).toBe('a');

      // ...the workspace is now all-collapsed around 'a'
      const after = [card('a'), card('b', { ladder: 'collapsed' }), card('c', { ladder: 'collapsed' })];
      const restore = held.restore;
      expect(withoutMaximized(held)).toEqual(DEFAULT_LAYOUT);
      expect(moves(state(), after, 'a', 'switch', restore)).toEqual({
        b: 'hidden',
        c: 'tabbed',
      });
    });

    it('a restore beats the exemptions — the user is being put back, not overridden', () => {
      const cards = [card('a', { ladder: 'collapsed', needsAttention: true, poppedOut: false })];
      expect(moves(state(), cards, 'a', 'switch', { a: 'expanded' })).toEqual({ a: 'expanded' });
    });

    it('a second maximize keeps the FIRST snapshot', () => {
      // the arrangement worth restoring is the one before the first blow-up,
      // not the all-collapsed workspace the first one produced
      const original = { a: 'expanded', b: 'hidden' } as Record<string, Ladder>;
      const held = withMaximized(DEFAULT_LAYOUT, 'a', original);
      const again = withMaximized(held, 'b', { a: 'collapsed', b: 'expanded' });
      expect(again.maximized).toBe('b');
      expect(again.restore).toEqual(original);
    });

    it('a maximize whose card is gone stops holding the workspace open', () => {
      const held = withMaximized(DEFAULT_LAYOUT, 'a', { a: 'expanded', b: 'collapsed' });
      expect(pruneLayout(held, ['b'])).toEqual(DEFAULT_LAYOUT);
      // a live maximize with a dead snapshot entry keeps the maximize
      expect(pruneLayout(held, ['a'])).toEqual(
        expect.objectContaining({ maximized: 'a', restore: { a: 'expanded' } })
      );
      // nothing stale: no write, no re-render
      expect(pruneLayout(held, ['a', 'b'])).toBeNull();
      expect(pruneLayout(DEFAULT_LAYOUT, [])).toBeNull();
    });

    it('is dropped the moment its card is closed, not at the next boot', () => {
      const held = withMaximized(DEFAULT_LAYOUT, 'a', { a: 'expanded', b: 'collapsed' });
      expect(forgetLayoutCard(held, 'a')).toEqual(DEFAULT_LAYOUT);
      expect(forgetLayoutCard(held, 'b')).toEqual(
        expect.objectContaining({ maximized: 'a', restore: { a: 'expanded' } })
      );
      expect(forgetLayoutCard(held, 'nobody')).toBeNull();
    });

    it('is dropped by a mode switch — you asked for a whole arrangement', () => {
      const held = withMaximized(DEFAULT_LAYOUT, 'a', { a: 'expanded' });
      expect(withMode('queue')).toEqual({ mode: 'queue', maximized: null, restore: {} });
      expect(withMode('queue').maximized).toBeNull();
      expect(held.maximized).toBe('a'); // ...and the edit is immutable
    });

    it('a maximize whose card is not on screen is ignored, not obeyed', () => {
      // fail-open, and specifically: a maximize left over from a card that has
      // been CLOSED must not make `grid` start enforcing. If it did, grid's own
      // plan ("every session gets a card") would re-expand every card the user
      // had collapsed by hand, on the next status push and every one after.
      const cards = [card('a', { ladder: 'collapsed' }), card('b')];
      expect(moves(state({ maximized: 'ghost', mode: 'grid' }), cards, 'b', 'react')).toEqual({});
      expect(isEnforced(state({ maximized: 'ghost' }), null)).toBe(false);
    });

    it('lets you go and look at another session while it is held', () => {
      // Clicking a session reveals it (§5.8). If the next reactive sweep folded
      // it straight back, a maximize would be a trap with one way out that
      // nothing on screen mentions.
      const cards = [card('a'), card('b')];
      expect(moves(state({ maximized: 'a' }), cards, 'b', 'react')).toEqual({});
      // ...but taking the maximize in the first place still puts 'b' away
      expect(moves(state({ maximized: 'a' }), cards, 'b', 'switch')).toEqual({ b: 'collapsed' });
    });

    it('never closes an OS window to restore a card popped out since', () => {
      const cards = [card('a', { poppedOut: true })];
      expect(moves(state(), cards, null, 'switch', { a: 'collapsed' })).toEqual({});
      // it may still come HOME, which opens nothing and closes nothing
      expect(
        moves(state(), [card('a', { ladder: 'collapsed' })], null, 'switch', { a: 'expanded' })
      ).toEqual({ a: 'expanded' });
    });
  });

  describe('the setting itself', () => {
    it('cycles grid → focus → queue → grid', () => {
      expect(cycleMode('grid')).toBe('focus');
      expect(cycleMode('focus')).toBe('queue');
      expect(cycleMode('queue')).toBe('grid');
    });

    it('is enforced by every mode but the default, and by a maximize', () => {
      expect(isEnforced(DEFAULT_LAYOUT)).toBe(false);
      expect(isEnforced(state({ mode: 'focus' }))).toBe(true);
      expect(isEnforced(state({ mode: 'queue' }))).toBe(true);
      expect(isEnforced(state({ maximized: 'a' }))).toBe(true);
    });

    it('an untouched workspace writes NOTHING to the ui blob', () => {
      expect(persistableLayout(DEFAULT_LAYOUT)).toBeNull();
      expect(persistableLayout(withMode('grid'))).toBeNull();
    });

    it('round-trips through the blob — the mode survives a relaunch (§5.25)', () => {
      const held = withMaximized(withMode('queue'), 'a', { a: 'expanded', b: 'hidden' });
      const blob = persistableLayout(held);
      expect(blob).toEqual({ mode: 'queue', maximized: 'a', restore: { a: 'expanded', b: 'hidden' } });
      expect(loadLayout(blob)).toEqual(held);
    });

    it('a snapshot with no maximize is dropped on the way out AND on the way in', () => {
      // the snapshot belongs to the maximize; on its own it is a stale record
      // that a later restore would apply out of nowhere
      expect(persistableLayout(state({ mode: 'focus', restore: { a: 'hidden' } }))).toEqual({
        mode: 'focus',
      });
      expect(loadLayout({ mode: 'focus', restore: { a: 'hidden' } }).restore).toEqual({});
    });

    it('survives a blob written by a newer (or older) build', () => {
      expect(loadLayout(null)).toEqual(DEFAULT_LAYOUT);
      expect(loadLayout('grid')).toEqual(DEFAULT_LAYOUT);
      expect(loadLayout({ mode: 'mosaic' })).toEqual(DEFAULT_LAYOUT);
      expect(loadLayout({ mode: 'focus', maximized: 42 })).toEqual(
        expect.objectContaining({ mode: 'focus', maximized: null })
      );
      expect(
        loadLayout({ mode: 'grid', maximized: 'a', restore: { a: 'nowhere', b: 'tabbed' } }).restore
      ).toEqual({ b: 'tabbed' });
    });
  });
});

// ── the invariant §5.8's pinning contract leans on (P2-E9-09) ───────────────
//
// E9-09 deliberately does NOT exempt a pinned card from a layout mode: a mode
// changes a card's RUNG, and §5.8 says pinning protects "existence and
// position, not size". That decision is only safe because a mode can never put
// a card somewhere it stops being LISTED — every demotion lands on `collapsed`,
// which shows a row in the strip, where lib/ladder's fold exemption keeps a
// pinned session a row of its own.
//
// Nothing enforced that. Add a fourth mode that wants `tabbed` or `hidden` and
// a pinned session would silently vanish from the strip with every existing
// test still green. This is that enforcement, asserted over the rungs `plan`
// can actually emit rather than over a list someone has to remember to update.
describe('a layout mode never hides a card outright (the E9-09 load-bearing invariant)', () => {
  it('every rung plan() can emit is one that still shows the session somewhere', () => {
    const cards = [
      card('a'),
      card('b', { needsAttention: true }),
      card('c', { ladder: 'collapsed' }),
      card('d', { poppedOut: true }),
      card('e', { ladder: 'hidden' }),
    ];
    const emitted = new Set<Ladder>();
    for (const mode of ['grid', 'focus', 'queue'] as const) {
      for (const trigger of ['switch', 'react'] as const) {
        for (const active of [null, 'a', 'c', 'e']) {
          for (const maximized of [null, 'a', 'b']) {
            const s = state({ mode, maximized, restore: {} });
            for (const m of plan({ state: s, cards, activeCardId: active, trigger })) {
              emitted.add(m.rung);
            }
          }
        }
      }
    }
    // it has to have DONE something, or the loop above proves nothing
    expect(emitted.size).toBeGreaterThan(0);
    for (const rung of emitted) {
      // `expanded` keeps its card; `collapsed` keeps a strip row (showsRow).
      // Anything else — `tabbed`, `hidden` — takes the session out of the one
      // list pinning promises to keep it in.
      expect(rung === 'expanded' || showsRow(rung)).toBe(true);
    }
  });

  it('...and a RESTORE may still put a card back on any rung, because the user put it there', () => {
    // the exemption is about what a MODE does unasked; an un-maximize replaying
    // the user's own prior arrangement is not that, and must stay exact
    const back = plan({
      state: state({ maximized: 'a', restore: { b: 'hidden' } }),
      cards: [card('a'), card('b')],
      activeCardId: 'a',
      trigger: 'switch',
      restore: { b: 'hidden' },
    });
    expect(back).toContainEqual({ cardId: 'b', rung: 'hidden' });
  });
});
