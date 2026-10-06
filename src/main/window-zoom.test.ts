// #1114 — Ctrl+= zooms.
//
// The owner: *"Pressing Ctrl+ does not work."* The stock `zoomIn` role answers
// `CommandOrControl+Plus`, and Plus is a shifted key: the first describe below is
// that report as one keystroke.
import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { AcceleratorInput } from '../shared/terminal-accelerators';
import {
  applyZoom,
  installWindowZoom,
  matchZoomInput,
  nextZoomLevel,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from './window-zoom';

const key = (k: string, over: Partial<AcceleratorInput> = {}): AcceleratorInput => ({
  type: 'keyDown',
  key: k,
  control: true,
  meta: false,
  shift: false,
  alt: false,
  ...over,
});

describe('#1114 — which keystrokes zoom', () => {
  it('answers Ctrl+= with no Shift — the owner`s report', () => {
    expect(matchZoomInput(key('='), 'other')).toBe('in');
  });

  it('still answers the shifted form, and the keypad`s plus', () => {
    expect(matchZoomInput(key('+', { shift: true }), 'other')).toBe('in');
    expect(matchZoomInput(key('+'), 'other')).toBe('in');
  });

  it('zooms out on minus in both forms, and resets on zero', () => {
    expect(matchZoomInput(key('-'), 'other')).toBe('out');
    expect(matchZoomInput(key('_', { shift: true }), 'other')).toBe('out');
    expect(matchZoomInput(key('0'), 'other')).toBe('reset');
  });

  it('leaves the bare keys alone — they are text', () => {
    for (const k of ['=', '+', '-', '0']) {
      expect(matchZoomInput(key(k, { control: false }), 'other')).toBeNull();
    }
  });

  it('leaves AltGr alone: on many layouts it IS Ctrl+Alt, and it types a character', () => {
    for (const k of ['=', '-', '0']) expect(matchZoomInput(key(k, { alt: true }), 'other')).toBeNull();
  });

  it('does not answer the key coming back up, or a composition in progress', () => {
    expect(matchZoomInput(key('=', { type: 'keyUp' }), 'other')).toBeNull();
    expect(matchZoomInput(key('=', { isComposing: true }), 'other')).toBeNull();
  });

  it('uses Cmd on macOS and Ctrl everywhere else, never both', () => {
    const cmd = { control: false, meta: true };
    expect(matchZoomInput(key('=', cmd), 'darwin')).toBe('in');
    expect(matchZoomInput(key('='), 'darwin')).toBeNull();
    expect(matchZoomInput(key('=', cmd), 'other')).toBeNull();
  });

  it('ignores every other Ctrl chord', () => {
    for (const k of ['a', 'c', '1', '9', 'Enter', ')']) expect(matchZoomInput(key(k), 'other')).toBeNull();
    expect(matchZoomInput(key('0', { shift: true }), 'other')).toBeNull();
  });
});

describe('#1114 — how far a press moves', () => {
  it('steps by the same amount the menu items always did', () => {
    expect(nextZoomLevel(0, 'in')).toBe(ZOOM_STEP);
    expect(nextZoomLevel(0, 'out')).toBe(-ZOOM_STEP);
    expect(nextZoomLevel(1.5, 'reset')).toBe(0);
  });

  it('stops at the bounds instead of zooming the app out of reach', () => {
    expect(nextZoomLevel(ZOOM_MAX, 'in')).toBe(ZOOM_MAX);
    expect(nextZoomLevel(ZOOM_MIN, 'out')).toBe(ZOOM_MIN);
    // …and a level from outside them (an older build, a hand-edited profile)
    // comes back inside on the first press rather than moving further out
    expect(nextZoomLevel(9, 'in')).toBe(ZOOM_MAX);
    expect(nextZoomLevel(-9, 'out')).toBe(ZOOM_MIN);
  });

  it('treats a level that is not a number as the default', () => {
    expect(nextZoomLevel(Number.NaN, 'in')).toBe(ZOOM_STEP);
  });
});

/** just enough of a `WebContents` to press keys on */
function fakeContents(level = 0): {
  contents: WebContents;
  press: (input: AcceleratorInput) => { prevented: boolean };
  level: () => number;
} {
  let current = level;
  let listener: ((e: { preventDefault: () => void }, i: AcceleratorInput) => void) | undefined;
  const contents = {
    on: (name: string, fn: typeof listener) => {
      if (name === 'before-input-event') listener = fn;
    },
    getZoomLevel: () => current,
    setZoomLevel: (l: number) => {
      current = l;
    },
  } as unknown as WebContents;
  return {
    contents,
    level: () => current,
    press: (input) => {
      const event = { prevented: false, preventDefault: vi.fn() };
      listener?.(event, input);
      return { prevented: event.preventDefault.mock.calls.length > 0 };
    },
  };
}

describe('#1114 — the claim on a window', () => {
  it('zooms the window and keeps the chord away from the page', () => {
    const w = fakeContents();
    installWindowZoom(w.contents, { platform: 'other' });
    expect(w.press(key('=')).prevented).toBe(true);
    expect(w.level()).toBe(ZOOM_STEP);
    w.press(key('='));
    w.press(key('-'));
    expect(w.level()).toBe(ZOOM_STEP);
    w.press(key('0'));
    expect(w.level()).toBe(0);
  });

  it('keeps growing while the chord is held', () => {
    const w = fakeContents();
    installWindowZoom(w.contents, { platform: 'other' });
    w.press(key('='));
    w.press(key('=', { isAutoRepeat: true }));
    expect(w.level()).toBe(2 * ZOOM_STEP);
  });

  it('lets everything else through untouched', () => {
    const w = fakeContents();
    installWindowZoom(w.contents, { platform: 'other' });
    expect(w.press(key('=', { control: false })).prevented).toBe(false);
    expect(w.press(key('c')).prevented).toBe(false);
    expect(w.level()).toBe(0);
  });

  it('costs nothing but the chord when the window throws', () => {
    const w = fakeContents();
    const onError = vi.fn();
    (w.contents as unknown as { setZoomLevel: () => void }).setZoomLevel = () => {
      throw new Error('destroyed');
    };
    installWindowZoom(w.contents, { platform: 'other', onError });
    expect(w.press(key('=')).prevented).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('applyZoom answers the level it set, for the menu to share', () => {
    const w = fakeContents(1);
    expect(applyZoom(w.contents, 'in')).toBe(1.5);
    expect(applyZoom(w.contents, 'reset')).toBe(0);
  });
});
