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
  collapsedRows,
  foldableRow,
  hasPanel,
  IDLE_FOLD_MIN,
  LADDER_ORDER,
  revealTargets,
  REVEAL_KINDS,
  showsRow,
  slotIsLive,
  stepDown,
  stepUp,
  stripItems,
} from './ladder';
import type { CollapsedRow, StripItem } from './ladder';
import en from '../../../shared/i18n/locales/en.json';
import type { CardStatus } from '../../../shared/sessions';
import type { RailSession } from '../model/types';

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

  it('shows a collapsed row for exactly one rung', () => {
    // the whole difference between the two panel-less rungs: §5.8 says hidden
    // leaves the session in "the sidebar, urgency lamps, and event feed" and
    // nowhere else, so a hidden session must NOT get a strip row
    expect(LADDER_ORDER.filter(showsRow)).toEqual(['collapsed']);
    expect(showsRow('hidden')).toBe(false);
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

// ── the collapsed strip's rows ──────────────────────────────────────────────

describe('collapsedRows', () => {
  // An opaque sentinel, not a real color: the rule under test is "the accent is
  // carried through untouched", and a literal color here would only be asserting
  // that strings are strings (and would trip the no-raw-color lint besides — a
  // session's accent is DATA the main process minted, never a themeable token).
  const ACCENT = 'accent-sentinel';
  const sessions: RailSession[] = [
    { id: 'a', title: 'alpha', status: 'idle', accent: ACCENT },
    { id: 'b', title: 'bravo', status: 'needs-permission' },
    { id: 'c', title: 'charlie', status: 'working' },
  ];

  it('lists only the collapsed sessions, in the order it was given', () => {
    const rows = collapsedRows(sessions, (id) =>
      id === 'a' || id === 'c' ? 'collapsed' : 'expanded'
    );
    // rail order in, rail order out: the strip must not become a second
    // ordering authority alongside the rail and Ctrl+1..9
    expect(rows.map((r) => r.cardId)).toEqual(['a', 'c']);
  });

  it('leaves a HIDDEN session out — that is the difference between the rungs', () => {
    expect(collapsedRows(sessions, () => 'hidden')).toEqual([]);
  });

  it('describes a session in the rail vocabulary, not one of its own', () => {
    const rows = collapsedRows(sessions, () => 'collapsed');
    const bravo = rows.find((r) => r.cardId === 'b')!;
    expect(bravo.token).toBe('needs-permission');
    expect(bravo.needsYou).toBe(true);
    expect(rows.find((r) => r.cardId === 'c')!.needsYou).toBe(false);
    // and the label key it hands the view actually resolves
    for (const r of rows) {
      const [ns, key] = r.labelKey.split('.');
      expect((en as Record<string, Record<string, unknown>>)[ns]?.[key]).toBeTruthy();
    }
  });

  it('carries the identity accent through when the session has one', () => {
    const rows = collapsedRows(sessions, () => 'collapsed');
    expect(rows.find((r) => r.cardId === 'a')!.accent).toBe(ACCENT);
    // and omits it rather than inventing one — the CSS has the fallback
    expect(rows.find((r) => r.cardId === 'b')!.accent).toBeUndefined();
  });
});

// ── idle aggregation (P2-E9-08) ─────────────────────────────────────────────
//
// §5.8: "more than ~3 idle aggregate into a single 'N idle sessions' row.
// Working / errored / currently-focused sessions always keep their own row."
// Every clause of that sentence is one test below, plus the two things the
// done-when asks for that the sentence does not spell out: four folds, and a
// status change takes the right session — and only that one — back out.

describe('stripItems (idle aggregation)', () => {
  /** a collapsed row for a session in `status`, described the way the strip is */
  // `status` stays a plain `string` here, and the cast is the point: one test
  // below hands this `'no-such-status'` deliberately, to pin that an unknown
  // value — a card written by an older build — is PAINTED rather than dropped.
  // `RailSession.status` is a `CardStatus` since #618 precisely so nothing in
  // the app can produce one of these; the tolerant reader still has to.
  const rowOf = (cardId: string, status: string): CollapsedRow => {
    const [only] = collapsedRows(
      [{ id: cardId, title: cardId, status: status as CardStatus }],
      () => 'collapsed'
    );
    return only;
  };
  const idles = (n: number, from = 0): CollapsedRow[] =>
    Array.from({ length: n }, (_, i) => rowOf(`idle${i + from}`, 'idle'));
  /** what the strip would actually draw, as a flat description */
  const shape = (items: StripItem[]): string[] =>
    items.map((i) => (i.kind === 'row' ? i.row.cardId : `fold:${i.rows.length}`));

  it('leaves three idle sessions alone — the fold has to earn its click', () => {
    expect(IDLE_FOLD_MIN).toBe(4);
    expect(shape(stripItems(idles(3)))).toEqual(['idle0', 'idle1', 'idle2']);
  });

  it('folds FOUR idle sessions into one row (the item, verbatim)', () => {
    const items = stripItems(idles(4));
    expect(shape(items)).toEqual(['fold:4']);
    // the fold carries the rows themselves, in rail order — the strip lists
    // them on disclosure rather than deriving the same list a second time
    const fold = items[0];
    expect(fold.kind).toBe('fold');
    if (fold.kind !== 'fold') return;
    expect(fold.rows.map((r) => r.cardId)).toEqual(['idle0', 'idle1', 'idle2', 'idle3']);
  });

  it('never swallows a session that is working, errored, or waiting on you', () => {
    // one of each, so a status the fold should keep out cannot pass by being
    // grouped with a status that is already handled
    const rows = [
      rowOf('working', 'working'),
      rowOf('starting', 'starting'),
      rowOf('crashed', 'crashed'),
      rowOf('asking', 'needs-input'),
      rowOf('held', 'needs-permission'),
      rowOf('finished', 'done'),
      ...idles(4),
    ];
    expect(shape(stripItems(rows))).toEqual([
      'working',
      'starting',
      'crashed',
      'asking',
      'held',
      'finished',
      'fold:4',
    ]);
  });

  it('never swallows the session you are IN', () => {
    const rows = idles(4);
    // four idle sessions, but one of them is the focused card: three are
    // foldable, which is not enough, so nothing folds at all
    expect(shape(stripItems(rows, { activeCardId: 'idle1' }))).toEqual([
      'idle0',
      'idle1',
      'idle2',
      'idle3',
    ]);
    // ...and with a fifth it folds around the focused one rather than over it
    expect(shape(stripItems(idles(5), { activeCardId: 'idle1' }))).toEqual(['fold:4', 'idle1']);
  });

  it('pops the right one back out when its status changes, and keeps the rest folded', () => {
    const before = idles(5);
    expect(shape(stripItems(before))).toEqual(['fold:5']);
    // idle2 starts working — that one row comes back, the other four stay folded
    const after = before.map((r) => (r.cardId === 'idle2' ? rowOf('idle2', 'working') : r));
    expect(shape(stripItems(after))).toEqual(['fold:4', 'idle2']);
    // and when enough of them wake up, the fold dissolves rather than lingering
    // as a summary of two things
    const awake = after.map((r) =>
      r.cardId === 'idle3' || r.cardId === 'idle4' ? rowOf(r.cardId, 'working') : r
    );
    expect(shape(stripItems(awake))).toEqual(['idle0', 'idle1', 'idle2', 'idle3', 'idle4']);
  });

  it('puts the fold where the first row it swallows was, keeping rail order', () => {
    // the strip is ordered by the rail (the Ctrl+1..9 authority); a fold that
    // shunted itself to one end would reorder everything around it
    const rows = [
      rowOf('held', 'needs-permission'),
      ...idles(2),
      rowOf('working', 'working'),
      ...idles(2, 2),
    ];
    expect(shape(stripItems(rows))).toEqual(['held', 'fold:4', 'working']);
  });

  it('describes foldability from the row alone', () => {
    // the predicate the view never re-derives — one rule, asserted directly
    expect(foldableRow(rowOf('a', 'idle'), null)).toBe(true);
    expect(foldableRow(rowOf('a', 'suspended'), null)).toBe(true); // idle by any reading
    expect(foldableRow(rowOf('a', 'idle'), 'a')).toBe(false);
    expect(foldableRow(rowOf('a', 'done'), null)).toBe(false);
    // an UNKNOWN status reads as idle (rail-view fails open) — and a fold is a
    // safe place for a session nothing is claiming about
    expect(foldableRow(rowOf('a', 'no-such-status'), null)).toBe(true);
  });

  it('is a no-op on an empty strip', () => {
    expect(stripItems([])).toEqual([]);
  });

  // ── §5.8's pinning contract (E9-09) ───────────────────────────────────────
  //
  // "exempt from EVERY bulk operation — ... idle aggregation ...". The fold is
  // the operation that takes a session's PLACE IN THE LIST away, which is
  // exactly what pinning protects — and note the pinned row is still a strip
  // row, i.e. still collapsed: "protects existence and position, not size".

  /** the same row, but pinned — built through collapsedRows so the flag travels
   *  the real path rather than being pasted onto the object */
  const pinnedRowOf = (cardId: string, status: CardStatus): CollapsedRow => {
    const [only] = collapsedRows(
      [{ id: cardId, title: cardId, status }],
      () => 'collapsed',
      () => true
    );
    return only;
  };

  it('a pinned IDLE row never folds', () => {
    expect(pinnedRowOf('a', 'idle').pinned).toBe(true);
    expect(foldableRow(pinnedRowOf('a', 'idle'), null)).toBe(false);
    // ...and the flag is absent, not false, on an unpinned row: a card at the
    // default must not accrete a property
    expect(rowOf('a', 'idle').pinned).toBeUndefined();
  });

  it('keeps its own row while the rest of the idle sessions fold around it', () => {
    const rows = [pinnedRowOf('pinned', 'idle'), ...idles(4)];
    expect(shape(stripItems(rows))).toEqual(['pinned', 'fold:4']);
  });

  it('a pin can drop the fold below the threshold, which is the point', () => {
    // four idle rows fold; pin one and only three are foldable, so the strip
    // lists all four again rather than hiding three behind a summary
    const rows = [pinnedRowOf('pinned', 'idle'), ...idles(3)];
    expect(shape(stripItems(rows))).toEqual(['pinned', 'idle0', 'idle1', 'idle2']);
  });

  it('collapsedRows defaults to nothing pinned, so every existing caller is unmoved', () => {
    const rows = collapsedRows([{ id: 'a', title: 'a', status: 'idle' }], () => 'collapsed');
    expect(rows[0].pinned).toBeUndefined();
    expect(foldableRow(rows[0], null)).toBe(true);
  });
});
