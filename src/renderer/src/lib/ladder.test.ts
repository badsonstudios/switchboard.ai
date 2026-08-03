// §5.8's presentation ladder — the rules (P2-E9-05).
//
// Everything here is a decision the app makes without a user watching: which
// rung a step lands on, whether a rung keeps a dockview panel, and — the one
// with teeth — which events bring a session back on their own. They are pure
// functions precisely so these can be tests rather than e2e guesses.
import { describe, it, expect } from 'vitest';
import type { AttentionEvent } from './queue';
import {
  collapsedRows,
  hasPanel,
  LADDER_ORDER,
  revealTargets,
  REVEAL_KINDS,
  showsRow,
  slotIsLive,
  stepDown,
  stepUp,
} from './ladder';
import type { Ladder } from './presentation';
import en from '../i18n/locales/en.json';

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

/** the default wiring: live id == card id, and every card is hidden */
function opts(rungs: Record<string, Ladder> = {}, act = true) {
  return {
    cardIdFor: (s: string) => s,
    rungOf: (c: string) => rungs[c] ?? ('hidden' as Ladder),
    act,
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

  it('leaves an already-expanded card alone', () => {
    // re-placing a panel that is on screen would move it for no reason
    const events = [ev(1, 'a', 'needs-permission'), ev(2, 'b', 'needs-permission')];
    const plan = revealTargets(events, new Set(), opts({ a: 'expanded' }));
    expect(plan.cardIds).toEqual(['b']);
  });

  it('reveals a collapsed and a tabbed card, not only a hidden one', () => {
    // every rung below the top is "not where you can work in it"
    const events = [ev(1, 'a', 'done'), ev(2, 'b', 'done'), ev(3, 'c', 'done')];
    const plan = revealTargets(events, new Set(), opts({ a: 'collapsed', b: 'tabbed', c: 'hidden' }));
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
      cardIdFor: (s) => (s === 'live-9' ? 'card-A' : s),
      rungOf: () => 'hidden',
      act: true,
    });
    expect(plan.cardIds).toEqual(['card-A']);
  });

  it('names a card once even when it has two queued events', () => {
    const events = [ev(1, 'a', 'needs-permission'), ev(2, 'a', 'needs-input')];
    expect(revealTargets(events, new Set(), opts()).cardIds).toEqual(['a']);
  });
});

// ── the collapsed strip's rows ──────────────────────────────────────────────

describe('collapsedRows', () => {
  // An opaque sentinel, not a real color: the rule under test is "the accent is
  // carried through untouched", and a literal color here would only be asserting
  // that strings are strings (and would trip the no-raw-color lint besides — a
  // session's accent is DATA the main process minted, never a themeable token).
  const ACCENT = 'accent-sentinel';
  const sessions = [
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
