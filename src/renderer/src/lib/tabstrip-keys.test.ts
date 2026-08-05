// The view tab strip's keyboard semantics (#197).
//
// SessionGrid applies these against the real DOM, so what is worth pinning here
// is the DECISIONS: that arrows wrap (the feed's, deliberately, do not), that
// activation is manual, and that a key we do not claim falls through instead of
// being swallowed.
import { describe, it, expect } from 'vitest';
import { tabStripAction } from './tabstrip-keys';

const four = (current: number): { count: number; current: number } => ({ count: 4, current });

describe('tabStripAction', () => {
  it('walks right and left one tab at a time', () => {
    expect(tabStripAction('ArrowRight', four(1))).toEqual({ kind: 'focus', index: 2 });
    expect(tabStripAction('ArrowLeft', four(2))).toEqual({ kind: 'focus', index: 1 });
  });

  it('wraps at both ends — a tab strip is a closed ring', () => {
    expect(tabStripAction('ArrowRight', four(3))).toEqual({ kind: 'focus', index: 0 });
    expect(tabStripAction('ArrowLeft', four(0))).toEqual({ kind: 'focus', index: 3 });
  });

  it('Home and End are absolute', () => {
    expect(tabStripAction('Home', four(2))).toEqual({ kind: 'focus', index: 0 });
    expect(tabStripAction('End', four(2))).toEqual({ kind: 'focus', index: 3 });
  });

  it('activates on Enter and Space, and never on an arrow', () => {
    // manual activation is the whole point: arrowing past Changes must not
    // build its Monaco diff on the way through
    expect(tabStripAction('Enter', four(1))).toEqual({ kind: 'activate' });
    expect(tabStripAction(' ', four(1))).toEqual({ kind: 'activate' });
    expect(tabStripAction('ArrowRight', four(1))).toEqual({ kind: 'focus', index: 2 });
  });

  it('leaves keys it does not own to the browser', () => {
    for (const key of ['Tab', 'a', 'ArrowUp', 'ArrowDown', 'Escape', 'PageDown']) {
      expect(tabStripAction(key, four(0))).toBeNull();
    }
  });

  it('does nothing on an empty strip', () => {
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End', 'Enter', ' ']) {
      expect(tabStripAction(key, { count: 0, current: -1 })).toBeNull();
    }
  });

  it('treats "focus is not on a tab" as "before the first one"', () => {
    // -1 arrives whenever the strip is keyed before anything inside it has been
    // focused; a raw modulo would land on a negative index
    expect(tabStripAction('ArrowRight', four(-1))).toEqual({ kind: 'focus', index: 1 });
    expect(tabStripAction('ArrowLeft', four(-1))).toEqual({ kind: 'focus', index: 3 });
    expect(tabStripAction('End', four(-1))).toEqual({ kind: 'focus', index: 3 });
  });

  it('survives a current index past the end of a shrunken strip', () => {
    // a contribution can disappear between renders (§5.23), so `current` may
    // name a tab that is no longer there
    expect(tabStripAction('ArrowRight', four(9))).toEqual({ kind: 'focus', index: 1 });
    expect(tabStripAction('Home', four(9))).toEqual({ kind: 'focus', index: 0 });
  });

  it('is a no-op on a one-tab strip rather than a key that appears stuck', () => {
    // wrapping onto yourself is the honest answer here: there is nowhere else
    expect(tabStripAction('ArrowRight', { count: 1, current: 0 })).toEqual({
      kind: 'focus',
      index: 0,
    });
  });
});
