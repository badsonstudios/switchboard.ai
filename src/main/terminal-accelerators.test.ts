// #90 — the browser-process half: when does a keystroke get taken away from
// the page, and (mostly) when must it not be.
import { describe, it, expect, vi } from 'vitest';
import {
  AcceleratorDeps,
  AcceleratorWiring,
  handleAcceleratorInput,
  makeAcceleratorDeps,
} from './terminal-accelerators';
import { AcceleratorInput } from '../shared/terminal-accelerators';

function input(over: Partial<AcceleratorInput> = {}): AcceleratorInput {
  return {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    control: false,
    meta: false,
    shift: false,
    alt: false,
    ...over,
  };
}

const CTRL_SHIFT_P = input({ key: 'P', code: 'KeyP', control: true, shift: true });

function deps(over: Partial<AcceleratorDeps> = {}): AcceleratorDeps & {
  deliver: ReturnType<typeof vi.fn>;
} {
  return {
    platform: 'other',
    deliver: vi.fn(() => true),
    ...over,
  } as AcceleratorDeps & { deliver: ReturnType<typeof vi.fn> };
}

describe('handleAcceleratorInput', () => {
  it('delivers an allowlisted chord and takes the key from the page', () => {
    const d = deps();
    const preventDefault = vi.fn();
    expect(handleAcceleratorInput({ preventDefault }, CTRL_SHIFT_P, d)).toBe('palette.open');
    expect(d.deliver).toHaveBeenCalledWith('palette.open');
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('leaves every other key to the page — never a preventDefault', () => {
    const d = deps();
    const preventDefault = vi.fn();
    // the CLI's own keys, and our own renderer-only accelerators
    for (const ev of [
      input({ key: 'r', code: 'KeyR', control: true }),
      input({ key: 'c', code: 'KeyC', control: true }),
      input({ key: 'Escape', code: 'Escape' }),
      input({ key: 'ArrowUp', code: 'ArrowUp' }),
      input({ key: '1', code: 'Digit1', control: true }),
      input({ key: 'x', code: 'KeyX' }),
    ]) {
      expect(handleAcceleratorInput({ preventDefault }, ev, d)).toBeNull();
    }
    expect(d.deliver).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('does NOT take the key when there is nobody to deliver it to (fail-open)', () => {
    // a closed or crashed renderer must cost the user a dead hotkey, never a
    // swallowed keystroke: the CLI still gets it
    const d = deps({ deliver: vi.fn(() => false) });
    const preventDefault = vi.fn();
    expect(handleAcceleratorInput({ preventDefault }, CTRL_SHIFT_P, d)).toBeNull();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('swallows a throwing delivery instead of throwing into Chromium input', () => {
    const onError = vi.fn();
    const d = deps({
      deliver: vi.fn(() => {
        throw new Error('boom');
      }),
      onError,
    });
    const preventDefault = vi.fn();
    expect(() => handleAcceleratorInput({ preventDefault }, CTRL_SHIFT_P, d)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(preventDefault).not.toHaveBeenCalled(); // the key still reaches the page
  });

  it('follows the platform it is given', () => {
    const cmdSpace = input({ key: ' ', code: 'Space', meta: true });
    expect(handleAcceleratorInput({ preventDefault: vi.fn() }, cmdSpace, deps())).toBeNull();
    expect(
      handleAcceleratorInput({ preventDefault: vi.fn() }, cmdSpace, deps({ platform: 'darwin' }))
    ).toBe('attention.next');
  });
});

describe('makeAcceleratorDeps — when a chord may be taken from the page at all', () => {
  const LIVE = 7; // a webContents id

  function wiring(over: Partial<AcceleratorWiring> = {}): AcceleratorWiring & {
    send: ReturnType<typeof vi.fn>;
  } {
    return {
      platform: 'other',
      renderer: () => ({ id: LIVE, alive: true }),
      ready: () => LIVE,
      send: vi.fn(() => true),
      ...over,
    } as AcceleratorWiring & { send: ReturnType<typeof vi.fn> };
  }

  it('delivers once the renderer is live AND listening', () => {
    const w = wiring();
    expect(makeAcceleratorDeps(w)(false).deliver('palette.open')).toBe(true);
    expect(w.send).toHaveBeenCalledWith('palette.open', false);
  });

  it('carries fromPopout through — the renderer decides what to raise', () => {
    const w = wiring();
    makeAcceleratorDeps(w)(true).deliver('attention.next');
    expect(w.send).toHaveBeenCalledWith('attention.next', true);
  });

  it('refuses while nothing has subscribed yet (the startup window)', () => {
    // a window exists before its renderer has mounted a listener: claiming the
    // chord here would swallow it and drop it on the floor
    const w = wiring({ ready: () => null });
    expect(makeAcceleratorDeps(w)(false).deliver('palette.open')).toBe(false);
    expect(w.send).not.toHaveBeenCalled();
  });

  it('refuses when the listener belongs to a DIFFERENT (older) renderer', () => {
    const w = wiring({ ready: () => 3 });
    expect(makeAcceleratorDeps(w)(false).deliver('palette.open')).toBe(false);
  });

  it('refuses when there is no window at all', () => {
    const w = wiring({ renderer: () => ({ id: null, alive: false }) });
    expect(makeAcceleratorDeps(w)(false).deliver('palette.open')).toBe(false);
    expect(w.send).not.toHaveBeenCalled();
  });

  it('refuses when the renderer has crashed — sessions run on, the hotkey does not', () => {
    const w = wiring({ renderer: () => ({ id: LIVE, alive: false }) });
    expect(makeAcceleratorDeps(w)(false).deliver('palette.open')).toBe(false);
  });

  it('reports a send that could not go out, rather than claiming the key', () => {
    const w = wiring({ send: vi.fn(() => false) });
    expect(makeAcceleratorDeps(w)(false).deliver('palette.open')).toBe(false);
  });

  it('feeds the whole thing back into the handler: no listener means no preventDefault', () => {
    const preventDefault = vi.fn();
    const deps = makeAcceleratorDeps(wiring({ ready: () => null }))(false);
    expect(handleAcceleratorInput({ preventDefault }, CTRL_SHIFT_P, deps)).toBeNull();
    expect(preventDefault).not.toHaveBeenCalled(); // the CLI still gets it
  });
});
