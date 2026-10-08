// Where a drag on the sessions strip would land (#1143).
import { describe, it, expect } from 'vitest';
import { edgeAtX, insertIndex } from './strip-drag';

describe('which side of an entry the pointer is on', () => {
  const box = { left: 100, right: 300 };

  it('is "before" on the left half and "after" on the right, reading left to right', () => {
    expect(edgeAtX(box, 150, false)).toBe('before');
    expect(edgeAtX(box, 250, false)).toBe('after');
  });

  it('swaps when the page reads right to left: the right half comes first', () => {
    expect(edgeAtX(box, 250, true)).toBe('before');
    expect(edgeAtX(box, 150, true)).toBe('after');
  });

  it('gives the exact middle to the right-hand half, whichever way the page reads', () => {
    expect(edgeAtX(box, 200, false)).toBe('after');
    expect(edgeAtX(box, 200, true)).toBe('before');
  });
});

describe('where the dragged item goes among the others', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('lands before or after the one it was dropped on', () => {
    expect(insertIndex(ids, 'a', 'c', 'before')).toBe(1); // b | a | c d
    expect(insertIndex(ids, 'a', 'c', 'after')).toBe(2); // b c | a | d
    expect(insertIndex(ids, 'd', 'a', 'before')).toBe(0);
  });

  it('dropped beside its own neighbour, it is where it already was', () => {
    // a is first; "before b" among the others [b, c, d] is index 0: unchanged
    expect(insertIndex(ids, 'a', 'b', 'before')).toBe(0);
    // c is third; "after b" among [a, b, d] is index 2: unchanged
    expect(insertIndex(ids, 'c', 'b', 'after')).toBe(2);
  });

  it('goes to the end when the target is not in the list', () => {
    expect(insertIndex(ids, 'a', 'nope', 'before')).toBe(3);
  });
});
