// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  flashLanding,
  LANDED_ATTR,
  LANDING_FLASH_MS,
  LANDING_STATIC_MS,
  prefersLessMotion,
} from './landing-flash';

/** Make `win.matchMedia` answer "reduce" (or not) for the motion query. */
function motionPref(win: Window, reduce: boolean): void {
  Object.defineProperty(win, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: reduce && q.includes('prefers-reduced-motion'), media: q }),
  });
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('flashLanding (#1456)', () => {
  it('applies the flash once and clears it after the fade', () => {
    vi.useFakeTimers();
    motionPref(window, false);
    const el = document.createElement('div');
    const set = vi.spyOn(el, 'setAttribute');
    flashLanding(el);
    expect(el.getAttribute(LANDED_ATTR)).toBe('motion');
    expect(set.mock.calls.filter(([n]) => n === LANDED_ATTR)).toHaveLength(1);
    vi.advanceTimersByTime(LANDING_FLASH_MS - 1);
    expect(el.getAttribute(LANDED_ATTR)).toBe('motion');
    vi.advanceTimersByTime(1);
    expect(el.getAttribute(LANDED_ATTR)).toBeNull();
  });

  it('a repeat RESTARTS it — one attribute, one timer, never stacked', () => {
    vi.useFakeTimers();
    motionPref(window, false);
    const el = document.createElement('div');
    const remove = vi.spyOn(el, 'removeAttribute');
    flashLanding(el);
    vi.advanceTimersByTime(LANDING_FLASH_MS - 100);
    flashLanding(el);
    // re-armed: taken off and put back, so the CSS animation starts over
    expect(remove).toHaveBeenCalledWith(LANDED_ATTR);
    expect(el.getAttribute(LANDED_ATTR)).toBe('motion');
    // the FIRST timer no longer ends it early...
    vi.advanceTimersByTime(150);
    expect(el.getAttribute(LANDED_ATTR)).toBe('motion');
    // ...the second one does, a full fade after the repeat
    vi.advanceTimersByTime(LANDING_FLASH_MS - 150);
    expect(el.getAttribute(LANDED_ATTR)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('less motion gets the STATIC outline, which also clears', () => {
    vi.useFakeTimers();
    motionPref(window, true);
    const el = document.createElement('div');
    flashLanding(el);
    expect(el.getAttribute(LANDED_ATTR)).toBe('static');
    vi.advanceTimersByTime(LANDING_STATIC_MS);
    expect(el.getAttribute(LANDED_ATTR)).toBeNull();
  });

  it("asks the element's OWN window — a popped-out pane is another document", () => {
    // the main window wants motion; the iframe (standing in for a popout: a
    // real second document with its own globals) asks for less
    motionPref(window, false);
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const other = frame.contentWindow!;
    motionPref(other, true);
    const el = other.document.createElement('div');
    other.document.body.appendChild(el);
    expect(el instanceof Element).toBe(false); // the trap this is written around
    expect(prefersLessMotion(el)).toBe(true);
    flashLanding(el);
    expect(el.getAttribute(LANDED_ATTR)).toBe('static');
  });

  it("the stylesheet's fade lasts LANDING_FLASH_MS, the time the attribute is taken off", () => {
    const css = readFileSync(join(__dirname, '..', 'theme', 'dockview-tokens.css'), 'utf8');
    const rule = /\[data-landed='motion'\]::after\s*\{[^}]*animation:\s*sb-landed-fade\s+(\d+)ms/.exec(css);
    expect(rule?.[1]).toBe(String(LANDING_FLASH_MS));
  });

  it('does nothing without an element', () => {
    expect(() => flashLanding(null)).not.toThrow();
    expect(() => flashLanding(undefined)).not.toThrow();
  });
});
