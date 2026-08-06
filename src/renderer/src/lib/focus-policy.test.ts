// §5.8's focus-stealing policy (P2-E9-10).
//
// The thing this file is really guarding is that a preference nobody set can
// never move the cursor, and that a preference somebody DID set is never
// quietly overruled by another rule. Both are decisions the app makes while the
// user is looking somewhere else, which is exactly why they are pure functions
// and exactly why they are tested here rather than guessed at in e2e.
import { describe, it, expect } from 'vitest';
import {
  attentionEvents,
  attentionResponse,
  DEFAULT_FOCUS_BOOK,
  DEFAULT_FOCUS_POLICY,
  FocusBook,
  FOCUS_POLICY_KEY,
  FOCUS_POLICY_ORDER,
  FocusPolicy,
  focusOverride,
  loadFocusBook,
  marksUrgent,
  persistableFocusPolicies,
  pruneFocusPolicies,
  resolveFocusPolicy,
  revealsCard,
  takesFocus,
  withFocusCard,
  withFocusGlobal,
} from './focus-policy';

const book = (patch: Partial<FocusBook> = {}): FocusBook => ({ ...DEFAULT_FOCUS_BOOK, ...patch });

/** the two answers a response carries, as one readable tuple */
const effect = (policy: FocusPolicy, visible: boolean) => {
  const r = attentionResponse(policy, { visible });
  return { focus: takesFocus(r), reveal: revealsCard(r), urgent: marksUrgent(r) };
};

describe('focus-stealing policy — the rule (E9-10, §5.8)', () => {
  it('defaults to smart, and smart is what an untouched workspace resolves to', () => {
    expect(DEFAULT_FOCUS_POLICY).toBe('smart');
    expect(resolveFocusPolicy(DEFAULT_FOCUS_BOOK, 'card-A')).toBe('smart');
    // an untouched book writes NOTHING: a workspace nobody configured must not
    // accrete a settings record
    expect(persistableFocusPolicies(DEFAULT_FOCUS_BOOK)).toBeNull();
  });

  it('lists all four of §5.8s modes, loudest first', () => {
    expect(FOCUS_POLICY_ORDER).toEqual(['focus', 'smart', 'urgent', 'none']);
  });

  it('THE DONE-WHEN: under `urgent` nothing ever steals focus', () => {
    // "...(lamp only)". Not when the card is on screen, not when it is hidden,
    // not ever — and the workspace is not rearranged either, which is the other
    // half of never stealing.
    for (const visible of [true, false]) {
      expect(effect('urgent', visible)).toEqual({ focus: false, reveal: false, urgent: true });
    }
  });

  it('THE DONE-WHEN: under `smart` a visible card focuses, a hidden one does not', () => {
    expect(effect('smart', true)).toEqual({ focus: true, reveal: true, urgent: true });
    // the hidden one still comes BACK — reveal-on-attention is E9-05's own §5.8
    // bullet and `smart` is the default, so reading "only marks urgent" as
    // switching it off would turn a shipped feature off for everyone who never
    // opens this setting. What it does not do is take the cursor.
    expect(effect('smart', false)).toEqual({ focus: false, reveal: true, urgent: true });
  });

  it('`focus` always focuses, on screen or not', () => {
    expect(effect('focus', true)).toEqual({ focus: true, reveal: true, urgent: true });
    expect(effect('focus', false)).toEqual({ focus: true, reveal: true, urgent: true });
  });

  it('`none` is the only mode that stops the urgency mark too', () => {
    // i3's own `none`: "the window will neither be focused nor will the urgency
    // hint be set". It is also the only reading that leaves `none` a job — if
    // it still marked urgent it would be `urgent` under a second name.
    for (const visible of [true, false]) {
      expect(effect('none', visible)).toEqual({ focus: false, reveal: false, urgent: false });
    }
    // and every other mode DOES mark
    for (const p of ['focus', 'smart', 'urgent'] as const) {
      expect(marksUrgent(attentionResponse(p, { visible: false }))).toBe(true);
    }
  });

  it('is a ladder: every mode is quieter than the one above it', () => {
    // the property that makes the four modes navigable — a user who dislikes
    // what one does knows which way to move. Guarded rather than argued,
    // because a fifth mode slotted in the wrong place would read as an
    // arbitrary list to everyone after us.
    const loudness = (p: FocusPolicy, visible: boolean): number => {
      const e = effect(p, visible);
      return (e.focus ? 4 : 0) + (e.reveal ? 2 : 0) + (e.urgent ? 1 : 0);
    };
    for (const visible of [true, false]) {
      const scores = FOCUS_POLICY_ORDER.map((p) => loudness(p, visible));
      const sorted = [...scores].sort((a, b) => b - a);
      expect(scores).toEqual(sorted);
    }
  });

  it('cannot focus without revealing', () => {
    // "focus but leave it off screen" is not representable, and must not
    // become representable: you cannot focus a panel that is not there.
    for (const p of FOCUS_POLICY_ORDER) {
      for (const visible of [true, false]) {
        const e = effect(p, visible);
        if (e.focus) expect(e.reveal).toBe(true);
      }
    }
  });

  it('fails open on a value it does not recognise', () => {
    // §4: our own blind spot must never be the reason a session grabs the
    // screen — an unknown value from an older or newer blob reads as the
    // default, not as `focus`.
    const rogue = 'shout' as FocusPolicy;
    expect(attentionResponse(rogue, { visible: false })).toBe(
      attentionResponse(DEFAULT_FOCUS_POLICY, { visible: false })
    );
    expect(resolveFocusPolicy({ global: rogue, cards: {} }, 'card-A')).toBe('smart');
    expect(resolveFocusPolicy({ global: 'urgent', cards: { 'card-A': rogue } }, 'card-A')).toBe(
      'urgent'
    );
  });
});

describe('focus-stealing policy — precedence and edits', () => {
  it('a session override beats the global', () => {
    const b = book({ global: 'urgent', cards: { 'card-A': 'focus' } });
    expect(resolveFocusPolicy(b, 'card-A')).toBe('focus');
    expect(resolveFocusPolicy(b, 'card-B')).toBe('urgent');
    // and with no card at all it is the global
    expect(resolveFocusPolicy(b, undefined)).toBe('urgent');
  });

  it('the override the menu ticks is the card own, not the resolved one', () => {
    const b = book({ global: 'urgent', cards: { 'card-A': 'none' } });
    expect(focusOverride(b, 'card-A')).toBe('none');
    // "follow the default" is the ABSENCE of a record, which is what lets a
    // later change to the global reach the sessions that never overrode it
    expect(focusOverride(b, 'card-B')).toBeUndefined();
  });

  it('clearing an override removes the record rather than storing a value', () => {
    const b = withFocusCard(book(), 'card-A', 'focus');
    expect(focusOverride(b, 'card-A')).toBe('focus');
    const cleared = withFocusCard(b, 'card-A', undefined);
    expect('card-A' in cleared.cards).toBe(false);
    // the global still governs it, whatever the global becomes later
    expect(resolveFocusPolicy(withFocusGlobal(cleared, 'urgent'), 'card-A')).toBe('urgent');
  });

  it('a no-op edit returns the SAME book', () => {
    // the store publishes by identity: a write that changed nothing must not
    // re-render every surface reading the book
    const b = book({ global: 'urgent', cards: { 'card-A': 'none' } });
    expect(withFocusGlobal(b, 'urgent')).toBe(b);
    expect(withFocusCard(b, 'card-A', 'none')).toBe(b);
    expect(withFocusCard(b, 'card-B', undefined)).toBe(b);
    expect(withFocusCard(b, '', 'focus')).toBe(b);
    // ...and a real edit does not mutate the old one
    expect(withFocusGlobal(b, 'focus').global).toBe('focus');
    expect(b.global).toBe('urgent');
  });

  it('prunes overrides for cards that are gone, and nothing else', () => {
    const b = book({ global: 'urgent', cards: { alive: 'focus', dead: 'none' } });
    const pruned = pruneFocusPolicies(b, ['alive']);
    expect(pruned?.cards).toEqual({ alive: 'focus' });
    expect(pruned?.global).toBe('urgent'); // the global is not card-keyed
    // nothing to drop -> null, so the caller can skip a write and a re-render
    expect(pruneFocusPolicies(book({ cards: { alive: 'focus' } }), ['alive'])).toBeNull();
    expect(pruneFocusPolicies(DEFAULT_FOCUS_BOOK, [])).toBeNull();
  });
});

describe('focus-stealing policy — persistence', () => {
  it('round-trips through the ui blob', () => {
    const b = book({ global: 'urgent', cards: { 'card-A': 'none' } });
    const blob = persistableFocusPolicies(b);
    expect(blob).toEqual({ global: 'urgent', cards: { 'card-A': 'none' } });
    expect(loadFocusBook(blob)).toEqual(b);
    expect(FOCUS_POLICY_KEY).toBe('focusPolicy');
  });

  it('writes nothing when there is nothing to say', () => {
    expect(persistableFocusPolicies(book())).toBeNull();
    // a book whose only content is an emptied override table is still nothing
    expect(persistableFocusPolicies(withFocusCard(book(), 'gone', undefined))).toBeNull();
  });

  it('survives a blob written by another version', () => {
    // a blob outlives the code that wrote it; a stale value must never cost the
    // user their workspace
    expect(loadFocusBook(null)).toBe(DEFAULT_FOCUS_BOOK);
    expect(loadFocusBook('nonsense')).toBe(DEFAULT_FOCUS_BOOK);
    expect(loadFocusBook({ global: 'shout' })).toEqual(DEFAULT_FOCUS_BOOK);
    expect(loadFocusBook({ global: 'none', cards: 'not a table' })).toEqual(
      book({ global: 'none' })
    );
    expect(loadFocusBook({ cards: { good: 'focus', bad: 42, '': 'focus' } })).toEqual(
      book({ cards: { good: 'focus' } })
    );
  });
});

describe('attentionEvents — where `none` actually bites', () => {
  const ev = (id: number, sessionId: string) => ({ id, sessionId });

  it('drops the silenced sessions events and keeps everyone elses', () => {
    const events = [ev(1, 'loud'), ev(2, 'quiet'), ev(3, 'loud')];
    const kept = attentionEvents(events, (s) => (s === 'quiet' ? 'none' : 'smart'));
    expect(kept.map((e) => e.id)).toEqual([1, 3]);
  });

  it('returns the SAME array when nothing is silenced', () => {
    // the common case by a mile, and the store publishes derived values by
    // identity — a fresh array every push would re-render the events panel and
    // the palette on every status change in the workspace
    const events = [ev(1, 'a'), ev(2, 'b')];
    expect(attentionEvents(events, () => 'smart')).toBe(events);
    expect(attentionEvents(events, () => 'urgent')).toBe(events);
    const empty: { id: number; sessionId: string }[] = [];
    expect(attentionEvents(empty, () => 'none')).toBe(empty);
  });

  it('is keyed by the events LIVE session id, which the caller maps', () => {
    // events carry the live id; the book is keyed by card. The mapping is the
    // caller's, so this function cannot silently look up the wrong thing.
    const seen: string[] = [];
    attentionEvents([ev(1, 'live-9')], (s) => {
      seen.push(s);
      return 'smart';
    });
    expect(seen).toEqual(['live-9']);
  });
});
