// The missed-events digest's arithmetic (P2-E14-05c).
//
// Ordering, overflow and the summary counts, pinned away from the DOM — the
// panel's test proves it RENDERS, this one proves it is right.
import { describe, it, expect } from 'vitest';
import { buildDigest, DIGEST_ROWS, EMPTY_DIGEST } from './digest';
import { SuppressedEvent } from '../../../shared/suppressed';

const rec = (id: string, at: number, over: Partial<SuppressedEvent> = {}): SuppressedEvent => ({
  id,
  at,
  kind: 'needs-permission',
  cardId: 'card-a',
  title: 'TradingApp',
  body: 'needs permission',
  actions: ['os-toast'],
  ruleIds: ['built-in:toast'],
  reason: 'quiet-hours',
  ...over,
});

describe('buildDigest', () => {
  it('is the empty digest when nothing was held', () => {
    // the ordinary night, and the one the calm check is about: renders nothing
    expect(buildDigest([])).toEqual(EMPTY_DIGEST);
    expect(buildDigest([]).total).toBe(0);
  });

  it('orders NEWEST FIRST — the opposite of the store, on purpose', () => {
    // the store appends because it is a log; a person returning wants last
    // night's last event at the top
    const d = buildDigest([rec('early', 100), rec('late', 300), rec('mid', 200)]);
    expect(d.rows.map((r) => r.id)).toEqual(['late', 'mid', 'early']);
  });

  it('keeps the held order for events sharing a millisecond', () => {
    // ids are minted with a counter precisely because a batch can land on one
    // millisecond; a stable sort means the digest reads in the order they were held
    const d = buildDigest([rec('a', 500), rec('b', 500), rec('c', 500)]);
    expect(d.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it(`draws at most ${DIGEST_ROWS} rows and counts the rest as overflow`, () => {
    const many = Array.from({ length: DIGEST_ROWS + 4 }, (_, i) => rec(`e${i}`, 1000 + i));
    const d = buildDigest(many);
    expect(d.rows).toHaveLength(DIGEST_ROWS);
    expect(d.total).toBe(DIGEST_ROWS + 4);
    expect(d.overflow).toBe(4);
  });

  it('has NO overflow when everything fits', () => {
    const d = buildDigest([rec('a', 1), rec('b', 2)]);
    expect(d.overflow).toBe(0);
    expect(d.rows).toHaveLength(2);
  });

  it('accounts for EVERY id, not just the drawn ones', () => {
    // "Clear" on a digest that says "and 14 more" has to mean all 20 — or the
    // fifteenth surfaces alone tomorrow as though it had just happened
    const many = Array.from({ length: DIGEST_ROWS + 5 }, (_, i) => rec(`e${i}`, 1000 + i));
    const d = buildDigest(many);
    expect(d.ids).toHaveLength(DIGEST_ROWS + 5);
    expect(new Set(d.ids).size).toBe(DIGEST_ROWS + 5);
  });

  it('counts distinct sessions, with every unresolved card counting as ONE', () => {
    // the summary answers "how many of your sessions needed you"; an
    // unresolvable card is one unknown place, not N of them
    const d = buildDigest([
      rec('a', 1, { cardId: 'card-a' }),
      rec('b', 2, { cardId: 'card-b' }),
      rec('c', 3, { cardId: null }),
      rec('d', 4, { cardId: null }),
    ]);
    expect(d.sessions).toBe(3);
  });

  it('marks a row from an EARLIER DAY, so a bare clock time is never ambiguous', () => {
    // the cap is 200 and the manual advertises a long weekend, so a digest that
    // spans midnight must not render "03:14" with nothing saying which night
    const now = new Date(2026, 8, 23, 9, 0, 0);
    const lastNight = new Date(2026, 8, 23, 3, 14, 0).getTime();
    const theNightBefore = new Date(2026, 8, 22, 23, 50, 0).getTime();
    const d = buildDigest([rec('old', theNightBefore), rec('new', lastNight)], DIGEST_ROWS, now);
    expect(d.rows.map((r) => [r.id, r.earlierDay])).toEqual([
      ['new', false],
      ['old', true],
    ]);
  });

  it('judges the day by the LOCAL calendar, not by hours elapsed', () => {
    // 23:50 and 00:10 are 20 minutes apart and are different days; 09:00 and
    // 03:14 are six hours apart and are the same one
    const now = new Date(2026, 8, 23, 0, 10, 0);
    const d = buildDigest([rec('a', new Date(2026, 8, 22, 23, 50, 0).getTime())], DIGEST_ROWS, now);
    expect(d.rows[0].earlierDay).toBe(true);
  });

  it('does not mutate or alias the caller’s list', () => {
    // the array is the renderer's state; sorting it in place would reorder a
    // list React is holding
    const held = [rec('a', 300), rec('b', 100)];
    const d = buildDigest(held);
    expect(held.map((e) => e.id)).toEqual(['a', 'b']);
    d.rows[0].title = 'mutated';
    expect(held[0].title).toBe('TradingApp');
  });

  it('the shared EMPTY digest is frozen, so one caller cannot corrupt the rest', () => {
    expect(Object.isFrozen(EMPTY_DIGEST)).toBe(true);
    expect(() => (EMPTY_DIGEST.ids as string[]).push('x')).toThrow();
  });

  it('carries the CAPTURED title and body through untouched', () => {
    // #482 copies them at hold time so a renamed card cannot rewrite last
    // night; the digest must not undo that by looking anything up
    const d = buildDigest([rec('a', 1, { title: 'the name it had at 03:00', body: 'said this' })]);
    expect(d.rows[0]).toMatchObject({ title: 'the name it had at 03:00', body: 'said this' });
  });

  it('honours an explicit limit, including a degenerate one', () => {
    const many = Array.from({ length: 5 }, (_, i) => rec(`e${i}`, 1000 + i));
    expect(buildDigest(many, 2).rows).toHaveLength(2);
    expect(buildDigest(many, 2).overflow).toBe(3);
    // overflow off `rows.length`, never off `limit`: a limit LARGER than the
    // list is where the two diverge, and "and -5 more" is the bug that hides
    // there. Unpinned until review found it survived.
    expect(buildDigest(many, 50).overflow).toBe(0);
    expect(buildDigest(many, 50).rows).toHaveLength(5);
    // 0 and a negative both mean "name none of them", and the count still holds
    expect(buildDigest(many, 0).rows).toHaveLength(0);
    expect(buildDigest(many, 0).overflow).toBe(5);
    expect(buildDigest(many, -1).rows).toHaveLength(0);
    expect(buildDigest(many, -1).total).toBe(5);
  });
});
