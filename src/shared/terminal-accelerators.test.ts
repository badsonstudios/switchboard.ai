// #90 — the allowlist matcher. The tests that matter here are the NEGATIVE
// ones: this function is the only thing standing between the hosted CLI and a
// keystroke it never gets back, so "does it claim Ctrl+R" is a more important
// question than "does it claim the palette".
import { describe, it, expect } from 'vitest';
import {
  AcceleratorInput,
  matchTerminalAccelerator,
  TERMINAL_ACCELERATORS,
} from './terminal-accelerators';

/** an Electron `Input`, shaped as the browser process really hands it over —
 *  values taken from a live before-input-event probe on Windows */
function input(over: Partial<AcceleratorInput> = {}): AcceleratorInput {
  return {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    control: false,
    meta: false,
    shift: false,
    alt: false,
    isAutoRepeat: false,
    isComposing: false,
    ...over,
  };
}

const CTRL_SHIFT_P = input({ key: 'P', code: 'KeyP', control: true, shift: true });
// the spacebar reports key ' '; only the physical code identifies it
const CTRL_SPACE = input({ key: ' ', code: 'Space', control: true });

describe('the allowlist itself', () => {
  it('is exactly two entries — the size is the design, not a starting point', () => {
    expect(TERMINAL_ACCELERATORS.map((a) => a.commandId)).toEqual([
      'palette.open',
      'attention.next',
    ]);
  });
});

describe('matchTerminalAccelerator — what it claims', () => {
  it('claims Ctrl+Shift+P for the palette', () => {
    expect(matchTerminalAccelerator(CTRL_SHIFT_P, 'other')).toBe('palette.open');
  });

  it('claims Ctrl+Space for the attention jump', () => {
    expect(matchTerminalAccelerator(CTRL_SPACE, 'other')).toBe('attention.next');
  });

  it('uses Cmd on macOS and Ctrl elsewhere — one accelerator, three OSes', () => {
    const cmdShiftP = input({ key: 'P', code: 'KeyP', meta: true, shift: true });
    expect(matchTerminalAccelerator(cmdShiftP, 'darwin')).toBe('palette.open');
    expect(matchTerminalAccelerator(cmdShiftP, 'other')).toBeNull();
    expect(matchTerminalAccelerator(CTRL_SHIFT_P, 'darwin')).toBeNull();
  });
});

describe('matchTerminalAccelerator — what it leaves to the CLI', () => {
  // Every one of these is a key Claude Code itself binds (read off the shipped
  // binary's default keybinding table). If any of them ever starts matching,
  // switchboard has begun eating the CLI's own interactions — P7's exact
  // failure — and this test is the alarm.
  const cliKeys: Array<[string, AcceleratorInput]> = [
    ['Ctrl+C (interrupt)', input({ key: 'c', code: 'KeyC', control: true })],
    ['Ctrl+D (exit)', input({ key: 'd', code: 'KeyD', control: true })],
    ['Ctrl+R (history search)', input({ key: 'r', code: 'KeyR', control: true })],
    ['Ctrl+O (transcript)', input({ key: 'o', code: 'KeyO', control: true })],
    ['Ctrl+T (todos)', input({ key: 't', code: 'KeyT', control: true })],
    ['Ctrl+L (clear)', input({ key: 'l', code: 'KeyL', control: true })],
    ['Ctrl+P (no shift — a DIFFERENT chord)', input({ key: 'p', code: 'KeyP', control: true })],
    ['Ctrl+Shift+B (brief)', input({ key: 'B', code: 'KeyB', control: true, shift: true })],
    ['Ctrl+Shift+C (copy)', input({ key: 'C', code: 'KeyC', control: true, shift: true })],
    ['Escape', input({ key: 'Escape', code: 'Escape' })],
    ['Enter', input({ key: 'Enter', code: 'Enter' })],
    ['Tab', input({ key: 'Tab', code: 'Tab' })],
    ['Shift+Tab (cycle mode)', input({ key: 'Tab', code: 'Tab', shift: true })],
    ['ArrowUp', input({ key: 'ArrowUp', code: 'ArrowUp' })],
    ['Ctrl+ArrowDown', input({ key: 'ArrowDown', code: 'ArrowDown', control: true })],
    ['a bare space (push-to-talk)', input({ key: ' ', code: 'Space' })],
    ['a plain letter', input({ key: 'x', code: 'KeyX' })],
  ];
  for (const [name, ev] of cliKeys) {
    it(`leaves ${name} alone`, () => {
      expect(matchTerminalAccelerator(ev, 'other')).toBeNull();
      expect(matchTerminalAccelerator(ev, 'darwin')).toBeNull();
    });
  }

  it("leaves the app's OWN other accelerators alone — they are not on the list", () => {
    // Ctrl+1..9, Ctrl+B, Ctrl+N, Ctrl+W and friends stay renderer-only, so
    // inside a terminal they still do nothing at all
    expect(matchTerminalAccelerator(input({ key: '1', code: 'Digit1', control: true }), 'other')).toBeNull();
    expect(matchTerminalAccelerator(input({ key: 'b', code: 'KeyB', control: true }), 'other')).toBeNull();
    expect(matchTerminalAccelerator(input({ key: 'w', code: 'KeyW', control: true }), 'other')).toBeNull();
    expect(
      matchTerminalAccelerator(input({ key: 'O', code: 'KeyO', control: true, shift: true }), 'other')
    ).toBeNull();
  });

  it('claims the keyDown only — never the keyUp or a char event', () => {
    expect(matchTerminalAccelerator({ ...CTRL_SHIFT_P, type: 'keyUp' }, 'other')).toBeNull();
    expect(matchTerminalAccelerator({ ...CTRL_SPACE, type: 'char' }, 'other')).toBeNull();
  });

  it('ignores auto-repeat — holding it must not queue N jumps', () => {
    expect(matchTerminalAccelerator({ ...CTRL_SPACE, isAutoRepeat: true }, 'other')).toBeNull();
  });

  it('ignores a keystroke mid-IME composition', () => {
    expect(matchTerminalAccelerator({ ...CTRL_SPACE, isComposing: true }, 'other')).toBeNull();
  });

  it('refuses a near-miss: an extra modifier is a different chord', () => {
    expect(matchTerminalAccelerator({ ...CTRL_SPACE, alt: true }, 'other')).toBeNull();
    expect(matchTerminalAccelerator({ ...CTRL_SPACE, meta: true }, 'other')).toBeNull();
    expect(matchTerminalAccelerator({ ...CTRL_SPACE, shift: true }, 'other')).toBeNull();
    expect(matchTerminalAccelerator({ ...CTRL_SHIFT_P, alt: true }, 'other')).toBeNull();
  });
});
