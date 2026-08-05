// §5.8's pinning contract (P2-E9-09) — the state and the two rules that are
// purely about pinning. The EXEMPTIONS are tested where they live, because that
// is where a future change would break them: groups.test.ts (sorts first),
// ladder.test.ts (never aggregates), presentation-policy.test.ts (never
// auto-collapses on submit).
import { describe, it, expect } from 'vitest';
import {
  closableCards,
  isPinned,
  loadPins,
  NO_PINS,
  persistablePins,
  PIN_KEY,
  prunePins,
  sortPinnedFirst,
  togglePin,
  withPin,
} from './pinning';

const pins = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe('pin state', () => {
  it('reads a pin, and a missing card is never pinned', () => {
    expect(isPinned(pins('a'), 'a')).toBe(true);
    expect(isPinned(pins('a'), 'b')).toBe(false);
    expect(isPinned(pins('a'), undefined)).toBe(false);
    expect(isPinned(NO_PINS, 'a')).toBe(false);
  });

  it('pins and unpins one card without touching the others', () => {
    const one = withPin(pins('a'), 'b', true);
    expect([...one].sort()).toEqual(['a', 'b']);
    expect([...withPin(one, 'a', false)]).toEqual(['b']);
  });

  it('hands back THE SAME set when nothing changed — identity is the change signal', () => {
    const cur = pins('a');
    // a no-op write would re-derive rail order and re-render every row
    expect(withPin(cur, 'a', true)).toBe(cur);
    expect(withPin(cur, 'b', false)).toBe(cur);
    expect(withPin(cur, '', true)).toBe(cur);
  });

  it('toggles both ways from one gesture (§5.8)', () => {
    const on = togglePin(NO_PINS, 'a');
    expect(isPinned(on, 'a')).toBe(true);
    expect(isPinned(togglePin(on, 'a'), 'a')).toBe(false);
  });
});

describe('prunePins', () => {
  it('drops pins for cards that no longer exist', () => {
    const next = prunePins(pins('a', 'gone'), ['a', 'b']);
    expect(next && [...next]).toEqual(['a']);
  });

  it('returns null when nothing is stale, so the caller skips the write', () => {
    expect(prunePins(pins('a'), ['a', 'b'])).toBeNull();
    expect(prunePins(NO_PINS, [])).toBeNull();
  });
});

describe('sortPinnedFirst', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

  it('lifts the pinned ones to the front', () => {
    expect(sortPinnedFirst(list, pins('c')).map((s) => s.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('is STABLE on both sides — pinning promotes, it never shuffles', () => {
    expect(sortPinnedFirst(list, pins('d', 'b')).map((s) => s.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('hands back the very same array when no pin applies', () => {
    expect(sortPinnedFirst(list, NO_PINS)).toBe(list);
    // a pin for a card that is not in this list must not cost a copy either
    expect(sortPinnedFirst(list, pins('zz'))).toBe(list);
  });
});

describe('closableCards — the bulk-operation exemption', () => {
  it('spares the pinned ones and keeps the caller’s order', () => {
    expect(closableCards(['a', 'b', 'c', 'd'], pins('c', 'a'))).toEqual(['b', 'd']);
  });

  it('takes everything when nothing is pinned', () => {
    expect(closableCards(['a', 'b'], NO_PINS)).toEqual(['a', 'b']);
  });

  it('takes NOTHING when every card is pinned — the caller must handle that', () => {
    // the close-all command says so rather than opening a confirm for an empty
    // list, which would read as the command being broken
    expect(closableCards(['a', 'b'], pins('a', 'b'))).toEqual([]);
  });
});

describe('persistence', () => {
  it('round-trips through the ui blob', () => {
    const set = pins('b', 'a');
    const blob = persistablePins(set);
    expect(blob).toEqual(['a', 'b']); // sorted, so an unchanged set rewrites identically
    expect([...loadPins(blob)].sort()).toEqual(['a', 'b']);
  });

  it('writes NOTHING when nothing is pinned', () => {
    expect(persistablePins(NO_PINS)).toBeNull();
  });

  it('survives a blob written by another version', () => {
    // a blob outlives the code that wrote it; a stale value must never cost the
    // user their workspace
    expect(loadPins(undefined)).toBe(NO_PINS);
    expect(loadPins('nonsense')).toBe(NO_PINS);
    expect(loadPins({ a: true })).toBe(NO_PINS);
    expect([...loadPins(['a', 42, '', null, 'b'])].sort()).toEqual(['a', 'b']);
  });

  it('names its ui-blob key', () => {
    expect(PIN_KEY).toBe('pinned');
  });
});
