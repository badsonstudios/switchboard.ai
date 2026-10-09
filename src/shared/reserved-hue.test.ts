// What counts as "yellowish", and what happens to a saved colour that is (#1165).
import { describe, it, expect } from 'vitest';
import { hueOf, isReservedColor, outOfReserved } from './reserved-hue';
import { ACCENTS, RETIRED_ACCENTS } from './accents';
import { GROUP_PALETTE, RETIRED_GROUP_COLORS } from './group-palette';

describe('which colours are reserved for "a session needs you"', () => {
  it('yellow, gold, amber and orange are', () => {
    for (const hex of ['#ffff00', '#ffd700', '#e3b341', '#f0883e', '#d98f3d', '#a3a83e']) {
      expect(isReservedColor(hex), hex).toBe(true);
    }
  });

  it('red, coral, green, teal, blue, violet and pink are not', () => {
    for (const hex of ['#f85149', '#f0776b', '#3fb950', '#39c5bb', '#58a6ff', '#a78bfa', '#db61a2']) {
      expect(isReservedColor(hex), hex).toBe(false);
    }
  });

  it('a grey is not, whatever its hue works out to: it does not read as a colour', () => {
    for (const hex of ['#8a8a80', '#b0b5bf', '#20252e', '#ffffff', '#000000']) {
      expect(isReservedColor(hex), hex).toBe(false);
    }
  });

  it('something that is not a colour is not reserved, and has no hue', () => {
    expect(hueOf('var(--accent-teal)')).toBeNull();
    expect(isReservedColor('var(--status-needs-input)')).toBe(false);
    expect(isReservedColor('')).toBe(false);
  });

  it('reads a hue the ordinary way', () => {
    expect(Math.round(hueOf('#ff0000')!.hue)).toBe(0);
    expect(Math.round(hueOf('#00ff00')!.hue)).toBe(120);
    expect(Math.round(hueOf('#0000ff')!.hue)).toBe(240);
    expect(Math.round(hueOf('#e3b341')!.hue)).toBe(42);
  });
});

describe('a saved colour that is reserved', () => {
  const allowed = ACCENTS.map((a) => a.value);

  it('⭐ the two retired session colours each become their own successor', () => {
    const amber = outOfReserved('#e3b341', allowed, RETIRED_ACCENTS);
    const orange = outOfReserved('#f0883e', allowed, RETIRED_ACCENTS);
    expect(amber).toBe('#7c8cf8');
    expect(orange).toBe('#cf7bea');
    // two sessions that were told apart by colour still are
    expect(amber).not.toBe(orange);
  });

  it('is matched whatever case the file wrote it in', () => {
    expect(outOfReserved('#E3B341', allowed, RETIRED_ACCENTS)).toBe('#7c8cf8');
  });

  it('the two retired group colours each become their own successor', () => {
    expect(outOfReserved('#d98f3d', GROUP_PALETTE, RETIRED_GROUP_COLORS)).toBe('#5b6ee1');
    expect(outOfReserved('#a3a83e', GROUP_PALETTE, RETIRED_GROUP_COLORS)).toBe('#a35fd0');
  });

  it('a yellow nobody listed goes to the allowed colour nearest in hue', () => {
    // a hand-edited file: pure yellow (60 degrees). Coral (5) is nearer than green (128).
    const got = outOfReserved('#ffff00', allowed, RETIRED_ACCENTS);
    expect(allowed).toContain(got);
    expect(isReservedColor(got)).toBe(false);
    expect(got).toBe('#f0776b');
  });

  it('a colour that is NOT reserved comes back as the same string', () => {
    for (const hex of allowed) expect(outOfReserved(hex, allowed, RETIRED_ACCENTS)).toBe(hex);
    expect(outOfReserved('#123456', allowed)).toBe('#123456');
    expect(outOfReserved('not-a-colour', allowed)).toBe('not-a-colour');
  });

  it('running it twice changes nothing the second time', () => {
    const once = outOfReserved('#e3b341', allowed, RETIRED_ACCENTS);
    expect(outOfReserved(once, allowed, RETIRED_ACCENTS)).toBe(once);
  });

  it('no successor is itself reserved, and every one is in its palette', () => {
    for (const to of Object.values(RETIRED_ACCENTS)) {
      expect(isReservedColor(to)).toBe(false);
      expect(allowed).toContain(to);
    }
    for (const to of Object.values(RETIRED_GROUP_COLORS)) {
      expect(isReservedColor(to)).toBe(false);
      expect(GROUP_PALETTE).toContain(to);
    }
  });
});
