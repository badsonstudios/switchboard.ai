import { describe, expect, it } from 'vitest';
import { MAX_LINEAGE, recordNativeId, resumeCandidates, sanitizeLineage } from './lineage';

describe('resumeCandidates', () => {
  it('offers the head first, then its ancestors', () => {
    expect(resumeCandidates({ nativeSessionId: 'c', nativeSessionLineage: ['b', 'a'] })).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('is empty for a card that has never held a conversation', () => {
    expect(resumeCandidates(undefined)).toEqual([]);
    expect(resumeCandidates({})).toEqual([]);
  });

  it('drops blanks and repeats — a hand-edited chain must not ask twice', () => {
    expect(
      resumeCandidates({
        nativeSessionId: 'b',
        nativeSessionLineage: ['', 'b', 'a', 'a', undefined as unknown as string],
      })
    ).toEqual(['b', 'a']);
  });

  it('works for a card with ancestors but no head', () => {
    // not a shape we write, but a half-migrated or hand-edited file can hold it,
    // and losing the ancestors over a missing head would be this issue again
    expect(resumeCandidates({ nativeSessionLineage: ['a'] })).toEqual(['a']);
  });
});

describe('recordNativeId', () => {
  it('pushes the old id down instead of overwriting it — THE fix (#484)', () => {
    // the CLI announces `b` before any turn has happened, and writes no
    // transcript for it until one does. If `a` is lost here, a quit before the
    // first prompt orphans the whole conversation.
    expect(recordNativeId({ nativeSessionId: 'a' }, 'b')).toEqual({
      nativeSessionId: 'b',
      nativeSessionLineage: ['a'],
    });
  });

  it('keeps the whole chain, newest first, across repeated new conversations', () => {
    let card = recordNativeId({ nativeSessionId: 'a' }, 'b');
    card = recordNativeId(card, 'c');
    expect(card).toEqual({ nativeSessionId: 'c', nativeSessionLineage: ['b', 'a'] });
  });

  it('is a no-op for the id the card already has', () => {
    expect(recordNativeId({ nativeSessionId: 'a', nativeSessionLineage: ['z'] }, 'a')).toEqual({
      nativeSessionId: 'a',
      nativeSessionLineage: ['z'],
    });
  });

  it('promoting an ancestor demotes the dead head and leaves the id in one place', () => {
    // the launch after a session that got no prompt: `b` has no file, `a` does,
    // so `a` becomes the head again — and `b` is kept, because that conversation
    // may yet get a turn and materialize
    expect(recordNativeId({ nativeSessionId: 'b', nativeSessionLineage: ['a'] }, 'a')).toEqual({
      nativeSessionId: 'a',
      nativeSessionLineage: ['b'],
    });
  });

  it('seeds the chain for a card that had nothing, with no empty array in the file', () => {
    // absence, not `[]` — the store's load maps an empty chain back to
    // undefined, so returning one here would make a card read differently
    // before and after a relaunch
    expect(recordNativeId(undefined, 'a')).toEqual({
      nativeSessionId: 'a',
      nativeSessionLineage: undefined,
    });
  });

  it('is bounded — a card resumed daily must not grow an unbounded array', () => {
    let card = { nativeSessionId: 'id-0' } as ReturnType<typeof recordNativeId>;
    for (let i = 1; i <= MAX_LINEAGE + 5; i++) card = recordNativeId(card, `id-${i}`);
    expect(card.nativeSessionLineage).toHaveLength(MAX_LINEAGE);
    // and it is the OLDEST that fall off — the newest ancestor holds the most
    expect(card.nativeSessionLineage?.[0]).toBe(`id-${MAX_LINEAGE + 4}`);
    expect(card.nativeSessionLineage).not.toContain('id-0');
  });

  it('does not mutate the card it was handed', () => {
    const card = { nativeSessionId: 'a', nativeSessionLineage: ['z'] };
    recordNativeId(card, 'b');
    expect(card).toEqual({ nativeSessionId: 'a', nativeSessionLineage: ['z'] });
  });
});

describe('sanitizeLineage', () => {
  it('passes a clean chain through', () => {
    expect(sanitizeLineage(['b', 'a'])).toEqual(['b', 'a']);
  });

  it('refuses anything that is not an array', () => {
    for (const junk of ['b', 7, {}, null, undefined]) expect(sanitizeLineage(junk)).toBeUndefined();
  });

  it('drops non-strings, blanks and repeats rather than the whole chain', () => {
    expect(sanitizeLineage(['b', 7, '', 'b', null, 'a'])).toEqual(['b', 'a']);
  });

  it('caps a chain someone pasted a thousand ids into', () => {
    expect(sanitizeLineage(Array.from({ length: 500 }, (_, i) => `id-${i}`))).toHaveLength(
      MAX_LINEAGE
    );
  });

  it('an array with nothing usable in it is absence, not an empty chain', () => {
    expect(sanitizeLineage([''])).toBeUndefined();
    expect(sanitizeLineage([])).toBeUndefined();
  });
});
