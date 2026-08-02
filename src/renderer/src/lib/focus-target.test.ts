// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { FocusableWindow, focusedElementIn } from './focus-target';

const el = (tag: string): Element => document.createElement(tag);

function win(hasFocus: boolean, activeElement: Element | null): FocusableWindow {
  return { document: { hasFocus: () => hasFocus, activeElement } };
}

/** a popout that has been torn down — touching its document throws */
const dead: FocusableWindow = {
  get document(): never {
    throw new Error('window is closed');
  },
};

describe('focusedElementIn (#90)', () => {
  it('returns the active element of the popout that actually holds focus', () => {
    const target = el('textarea');
    const main = { activeElement: el('button') };
    expect(focusedElementIn([win(false, el('input')), win(true, target)], main)).toBe(target);
  });

  it('falls back to this document when no popout holds focus', () => {
    const here = el('button');
    expect(focusedElementIn([win(false, el('input'))], { activeElement: here })).toBe(here);
  });

  it('falls back when there are no popouts at all', () => {
    const here = el('div');
    expect(focusedElementIn([], { activeElement: here })).toBe(here);
  });

  it('steps over a popout that is mid-close instead of throwing', () => {
    const target = el('textarea');
    expect(focusedElementIn([dead, win(true, target)], { activeElement: null })).toBe(target);
  });

  it('survives every window being dead', () => {
    const here = el('div');
    expect(focusedElementIn([dead, dead], { activeElement: here })).toBe(here);
  });

  it('returns null rather than throwing when nothing is focused anywhere', () => {
    expect(focusedElementIn([win(true, null)], { activeElement: null })).toBeNull();
  });
});
