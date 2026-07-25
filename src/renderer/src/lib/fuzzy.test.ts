import { describe, it, expect } from 'vitest';
import { fuzzyMatch, fuzzyRank } from './fuzzy';

describe('fuzzyMatch', () => {
  it('reads a query as an acronym when it can — the common palette case', () => {
    // "cs" means Close session, not Clo(s)e
    expect(fuzzyMatch('cs', 'Close session')!.indices).toEqual([0, 6]);
    // T(oggle) … (s)essions — the word starts, not "the"'s t
    expect(fuzzyMatch('ts', 'Toggle the sessions rail')!.indices).toEqual([0, 11]);
  });

  it('falls back to a leftmost match when the acronym reading dead-ends', () => {
    // 'ee' has no second word-start 'e' to jump to — the plain match still wins
    expect(fuzzyMatch('ee', 'tee elm')).not.toBeNull();
    expect(fuzzyMatch('ss', 'passes')!.indices).toEqual([2, 3]);
  });

  it('returns null when a character is missing or out of order', () => {
    expect(fuzzyMatch('zz', 'Close session')).toBeNull();
    expect(fuzzyMatch('sc', 'Close')).toBeNull(); // 'c' never follows 's'
  });

  it('is case-insensitive both ways', () => {
    expect(fuzzyMatch('CLOSE', 'close session')).not.toBeNull();
    expect(fuzzyMatch('close', 'CLOSE SESSION')).not.toBeNull();
  });

  it('an empty query matches everything, scoring nothing', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch('   ', 'anything')?.score).toBe(0);
  });

  it('ranks a prefix above a mid-word hit', () => {
    const prefix = fuzzyMatch('n', 'New session')!.score;
    const middle = fuzzyMatch('n', 'Close session')!.score;
    expect(prefix).toBeGreaterThan(middle);
  });

  it('ranks a word-boundary hit above a scattered one', () => {
    const boundary = fuzzyMatch('s', 'New session')!.score;
    const scattered = fuzzyMatch('s', 'Close')!.score;
    expect(boundary).toBeGreaterThan(scattered);
  });

  it('rewards consecutive characters, all else equal', () => {
    const together = fuzzyMatch('ses', 'session')!.score;
    const apart = fuzzyMatch('ses', 'setters')!.score; // s-e-…-s, same length
    expect(together).toBeGreaterThan(apart);
  });
});

describe('fuzzyRank', () => {
  const items = ['Close session', 'New session', 'Toggle Changes view', 'Previous session'];
  const id = (s: string): string => s;

  it('orders by score — the obvious answer comes first', () => {
    // 'ns' also matches "Toggle Cha(n)ge(s) view" as a subsequence; ranking,
    // not filtering, is what puts the command the user meant on top
    expect(fuzzyRank('ns', items, id)[0].item).toBe('New session');
    expect(fuzzyRank('clo', items, id)[0].item).toBe('Close session');
  });

  it('drops targets missing a character entirely', () => {
    expect(fuzzyRank('xq', items, id)).toEqual([]);
  });

  it('breaks ties toward the shorter target', () => {
    expect(fuzzyRank('cs', items, id)[0].item).toBe('Close session');
  });

  it('handles non-ASCII titles without throwing', () => {
    expect(fuzzyRank('ü', ['Grüße', 'plain'], id).map((r) => r.item)).toEqual(['Grüße']);
  });

  it('an empty query keeps the input (registry) order', () => {
    expect(fuzzyRank('', items, id).map((r) => r.item)).toEqual(items);
  });

  it('no matches means an empty list, never a throw', () => {
    expect(fuzzyRank('zzzz', items, id)).toEqual([]);
  });

  it('is stable for equal scores', () => {
    const same = ['session one', 'session two'];
    expect(fuzzyRank('session', same, id).map((r) => r.item)).toEqual(same);
  });
});
