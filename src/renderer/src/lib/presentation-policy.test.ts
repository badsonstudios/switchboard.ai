import { describe, it, expect } from 'vitest';
import {
  cardOverride,
  cycleGlobal,
  cycleOverride,
  DEFAULT_BOOK,
  DEFAULT_POLICY,
  groupOverride,
  loadPolicyBook,
  persistablePolicies,
  POLICY_ORDER,
  PolicyBook,
  prunePolicies,
  resolvePolicy,
  submitTarget,
  withCard,
  withGlobal,
  withGroup,
} from './presentation-policy';

const book = (patch: Partial<PolicyBook> = {}): PolicyBook => ({ ...DEFAULT_BOOK, ...patch });

describe('presentation policy (E9-06, §5.8)', () => {
  it('defaults to auto-collapse — §5.8 names it, and a new user must not watch a card vanish', () => {
    expect(DEFAULT_POLICY).toBe('auto-collapse');
    expect(resolvePolicy(DEFAULT_BOOK, 'card-A')).toBe('auto-collapse');
    // an untouched book writes NOTHING: a workspace nobody configured must not
    // accrete a settings record
    expect(persistablePolicies(DEFAULT_BOOK)).toBeNull();
  });

  describe('precedence — session beats group beats global (the done-when)', () => {
    it('the global applies when nothing overrides it', () => {
      expect(resolvePolicy(book({ global: 'auto-hide' }), 'card-A', 'g1')).toBe('auto-hide');
    });

    it('a group override beats the global', () => {
      const b = book({ global: 'auto-hide', groups: { g1: 'always-visible' } });
      expect(resolvePolicy(b, 'card-A', 'g1')).toBe('always-visible');
      // ...and only for that group's members
      expect(resolvePolicy(b, 'card-B', 'g2')).toBe('auto-hide');
      expect(resolvePolicy(b, 'card-C', null)).toBe('auto-hide');
    });

    it('a session override beats BOTH', () => {
      const b = book({
        global: 'always-visible',
        groups: { g1: 'always-visible' },
        cards: { 'card-A': 'auto-hide' },
      });
      expect(resolvePolicy(b, 'card-A', 'g1')).toBe('auto-hide');
      expect(resolvePolicy(b, 'card-B', 'g1')).toBe('always-visible');
    });

    it('a garbage value anywhere falls through to the next level, never throws', () => {
      // a ui blob outlives the code that wrote it
      const b = {
        global: 'nonsense',
        groups: { g1: 'also-nonsense' },
        cards: { 'card-A': 42 },
      } as unknown as PolicyBook;
      expect(resolvePolicy(b, 'card-A', 'g1')).toBe(DEFAULT_POLICY);
    });
  });

  describe('submitTarget — where a card goes when its prompt is sent', () => {
    const at = (
      policy: PolicyBook['global'],
      ladder: Parameters<typeof submitTarget>[0]['ladder'] = 'expanded',
      poppedOut = false,
      needsHuman = false
    ) => submitTarget({ policy, ladder, poppedOut, needsHuman });

    it('auto-collapse collapses and auto-hide hides', () => {
      expect(at('auto-collapse')).toBe('collapsed');
      expect(at('auto-hide')).toBe('hidden');
    });

    it('always-visible does nothing at all', () => {
      expect(at('always-visible')).toBeNull();
    });

    it('a card already off the top rung is left alone', () => {
      // "give the screen back" is already done — pushing a collapsed session on
      // to hidden would be a second demotion nobody asked for, and would remove
      // the one row that says where it went
      for (const rung of ['collapsed', 'tabbed', 'hidden'] as const) {
        expect(at('auto-hide', rung)).toBeNull();
        expect(at('auto-collapse', rung)).toBeNull();
      }
    });

    it('a POPPED-OUT card is left alone', () => {
      // its rung change would close an OS window the user placed, possibly on
      // another monitor. Manual collapse still works; this rule is about what
      // happens UNASKED.
      expect(at('auto-collapse', 'expanded', true)).toBeNull();
      expect(at('auto-hide', 'expanded', true)).toBeNull();
    });

    it('a session ALREADY waiting on a human is left alone', () => {
      // the composer stays live while a permission is held, so you can type
      // into a blocked session. Minimizing it there takes the approval bar off
      // screen and NOTHING brings it back: E9-05's reveal fires on a new event
      // id, the hold already spent its own, and a CLI parked on a hold mints no
      // more. The one card that needs a human is the one card this must keep.
      expect(at('auto-collapse', 'expanded', false, true)).toBeNull();
      expect(at('auto-hide', 'expanded', false, true)).toBeNull();
      // ...and it is the ONLY thing that changed: the same card, not blocked,
      // still folds away
      expect(at('auto-collapse', 'expanded', false, false)).toBe('collapsed');
    });
  });

  describe('cycling', () => {
    it('the global cycles through three states and wraps', () => {
      let p = POLICY_ORDER[0];
      const seen = [p];
      for (let i = 0; i < POLICY_ORDER.length; i++) {
        p = cycleGlobal(p);
        seen.push(p);
      }
      expect(seen).toEqual([...POLICY_ORDER, POLICY_ORDER[0]]);
    });

    it('an override cycles through FOUR states — "follow the default" is one of them', () => {
      // without it, the only way out of an override would be picking the value
      // the default happens to have today
      const walk: (string | undefined)[] = [undefined];
      let cur = cycleOverride(undefined);
      for (let i = 0; i < POLICY_ORDER.length; i++) {
        walk.push(cur);
        cur = cycleOverride(cur);
      }
      expect(walk).toEqual([undefined, ...POLICY_ORDER]);
      expect(cur).toBeUndefined(); // back where it started
    });
  });

  describe('edits', () => {
    it('setting an override records it; clearing it REMOVES the record', () => {
      const one = withCard(DEFAULT_BOOK, 'card-A', 'auto-hide');
      expect(cardOverride(one, 'card-A')).toBe('auto-hide');
      const cleared = withCard(one, 'card-A', undefined);
      expect(cardOverride(cleared, 'card-A')).toBeUndefined();
      // absence, not a fourth stored value — so a later change to the global
      // default reaches the sessions that never overrode it
      expect(Object.keys(cleared.cards)).toEqual([]);
    });

    it('group overrides work the same way and do not touch the cards table', () => {
      const b = withGroup(withCard(DEFAULT_BOOK, 'card-A', 'auto-hide'), 'g1', 'always-visible');
      expect(groupOverride(b, 'g1')).toBe('always-visible');
      expect(cardOverride(b, 'card-A')).toBe('auto-hide');
    });

    it('every edit returns a NEW book — identity is the store change signal', () => {
      const b = withGlobal(DEFAULT_BOOK, 'auto-hide');
      expect(b).not.toBe(DEFAULT_BOOK);
      expect(DEFAULT_BOOK.global).toBe('auto-collapse'); // the original is untouched
    });
  });

  describe('pruning', () => {
    it('drops overrides for cards and groups that are gone', () => {
      const b = book({
        cards: { 'card-A': 'auto-hide', 'card-B': 'always-visible' },
        groups: { g1: 'auto-hide', g2: 'always-visible' },
      });
      const next = prunePolicies(b, ['card-A'], ['g2'])!;
      expect(Object.keys(next.cards)).toEqual(['card-A']);
      expect(Object.keys(next.groups)).toEqual(['g2']);
      expect(next.global).toBe(b.global);
    });

    it('returns null when there is nothing to drop — no write, no re-render', () => {
      const b = book({ cards: { 'card-A': 'auto-hide' } });
      expect(prunePolicies(b, ['card-A'], [])).toBeNull();
    });
  });

  describe('persistence', () => {
    it('round-trips through the blob', () => {
      const b = book({
        global: 'auto-hide',
        groups: { g1: 'always-visible' },
        cards: { 'card-A': 'auto-collapse' },
      });
      const blob = persistablePolicies(b);
      expect(loadPolicyBook(blob)).toEqual(b);
    });

    it('only writes what differs from the default', () => {
      expect(persistablePolicies(withCard(DEFAULT_BOOK, 'card-A', 'auto-hide'))).toEqual({
        cards: { 'card-A': 'auto-hide' },
      });
    });

    it('a missing or unusable blob loads the default book rather than throwing', () => {
      expect(loadPolicyBook(null)).toEqual(DEFAULT_BOOK);
      expect(loadPolicyBook('nope')).toEqual(DEFAULT_BOOK);
      expect(loadPolicyBook({ cards: 'not-a-table', global: 7 })).toEqual(DEFAULT_BOOK);
      // and a half-valid table keeps the half that is valid
      expect(loadPolicyBook({ cards: { a: 'auto-hide', b: 'garbage' } }).cards).toEqual({
        a: 'auto-hide',
      });
    });
  });
});
