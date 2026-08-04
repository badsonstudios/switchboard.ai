import { describe, it, expect } from 'vitest';
import { feedKeyAction } from './feed-keys';

describe('feedKeyAction', () => {
  it('does nothing at all in a conversation with no expanders', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape']) {
      expect(feedKeyAction(key, { count: 0, current: -1 })).toBeNull();
    }
  });

  it('enters at the TOP with Down and at the BOTTOM with Up', () => {
    // the region itself has focus (current -1) — the menu convention, and the
    // only one that lets a user reach either end of a long transcript in one key
    expect(feedKeyAction('ArrowDown', { count: 5, current: -1 })).toEqual({ kind: 'move', index: 0 });
    expect(feedKeyAction('ArrowUp', { count: 5, current: -1 })).toEqual({ kind: 'move', index: 4 });
  });

  it('steps one expander at a time', () => {
    expect(feedKeyAction('ArrowDown', { count: 5, current: 1 })).toEqual({ kind: 'move', index: 2 });
    expect(feedKeyAction('ArrowUp', { count: 5, current: 3 })).toEqual({ kind: 'move', index: 2 });
  });

  it('falls through at the ends rather than eating the scroll', () => {
    // the whole reason `move()` returns null for a no-op: a swallowed
    // ArrowDown on the last block would leave the view stuck and silent
    expect(feedKeyAction('ArrowDown', { count: 3, current: 2 })).toBeNull();
    expect(feedKeyAction('ArrowUp', { count: 3, current: 0 })).toBeNull();
  });

  it('jumps to the first and last expander with Home and End', () => {
    expect(feedKeyAction('Home', { count: 9, current: 4 })).toEqual({ kind: 'move', index: 0 });
    expect(feedKeyAction('End', { count: 9, current: 4 })).toEqual({ kind: 'move', index: 8 });
    // already there: hand the key back
    expect(feedKeyAction('Home', { count: 9, current: 0 })).toBeNull();
    expect(feedKeyAction('End', { count: 9, current: 8 })).toBeNull();
  });

  it('ignores Home/End while focus is still on the region', () => {
    // nothing is focused yet; Home/End there mean "scroll", which is the
    // browser's job and a perfectly good answer
    expect(feedKeyAction('Home', { count: 9, current: -1 })).toBeNull();
    expect(feedKeyAction('End', { count: 9, current: -1 })).toBeNull();
  });

  it('Escape leaves the expanders, but only from inside them', () => {
    expect(feedKeyAction('Escape', { count: 4, current: 2 })).toEqual({ kind: 'exit' });
    expect(feedKeyAction('Escape', { count: 4, current: -1 })).toBeNull();
  });

  it('never claims a key the button or the scroller needs', () => {
    // Enter/Space activate the real <button> natively — intercepting either
    // would re-implement what the platform already does correctly. Page keys
    // scroll, which is the only way to move a long transcript quickly.
    for (const key of ['Enter', ' ', 'Spacebar', 'PageDown', 'PageUp', 'Tab', 'a']) {
      expect(feedKeyAction(key, { count: 6, current: 2 })).toBeNull();
    }
  });
});
