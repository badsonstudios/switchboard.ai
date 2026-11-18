// #1601: the inks chosen for a picked note colour, and the defaults the
// pickers start at, pinned to the theme tokens they copy.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTE_COLOURS, contrast, inksFor, mixHex } from './note-colour-math';

describe('the ink chosen for a picked colour clears 4.5:1 (#1601)', () => {
  // a light, a dark and a saturated pick, as the ticket asks, plus the two
  // hardest middles: mid grey and a mid saturated blue
  it.each([
    ['light', '#fff7cc'],
    ['dark', '#1e2a3a'],
    ['saturated red', '#e01b24'],
    ['saturated blue', '#1a5fff'],
    ['mid grey', '#777777'],
    ['black', '#000000'],
    ['white', '#ffffff'],
  ])('%s %s: words and byline', (_name, fill) => {
    const { ink, muted, edge } = inksFor(fill);
    expect(contrast(ink, fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(muted, fill)).toBeGreaterThanOrEqual(4.5);
    expect(edge).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('holds for every colour on a 16-step grid of the whole sRGB cube', () => {
    const steps = Array.from({ length: 16 }, (_, i) => Math.round((i * 255) / 15));
    let worst = Infinity;
    for (const r of steps)
      for (const g of steps)
        for (const b of steps) {
          const fill = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
          const { ink, muted } = inksFor(fill);
          worst = Math.min(worst, contrast(ink, fill), contrast(muted, fill));
        }
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });

  it('writes dark on a light note and light on a dark one', () => {
    expect(contrast(inksFor('#fff7cc').ink, '#000000')).toBeLessThan(2);
    expect(contrast(inksFor('#1e2a3a').ink, '#ffffff')).toBeLessThan(2);
  });

  it('the maths agrees with the known endpoints', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});

describe("the defaults are today's colours, read from the theme (#1601)", () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'theme', 'tokens.css'), 'utf8');
  const token = (name: string): string => {
    const m = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css);
    expect(m, name).not.toBeNull();
    return m![1].toLowerCase();
  };
  it('the session note starts at --note-paper', () => {
    expect(DEFAULT_NOTE_COLOURS.session).toBe(token('--note-paper'));
  });
  it('the waiting note starts at --status-needs-input 42% on white, as drawn', () => {
    expect(DEFAULT_NOTE_COLOURS.waiting).toBe(mixHex(token('--status-needs-input'), '#ffffff', 0.58));
  });
});
