import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONTRAST_FIXES, DIFF_THEME, EDITOR_BACKGROUND } from './monaco-theme';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
/** monaco's own `vs` / `vs-dark` definitions — the source of truth we correct. */
const THEMES_JS = path.join(
  REPO_ROOT,
  'node_modules/monaco-editor/esm/vs/editor/standalone/common/themes.js'
);

/** WCAG 2.x relative luminance of an `rrggbb` colour (no leading `#`). */
function luminance(h: string): number {
  const channels = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG 2.x contrast ratio, 1..21. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** AA for normal-size text. */
const AA = 4.5;

/**
 * Monaco's built-in palettes, read out of the installed package.
 *
 * Parsed rather than imported: importing monaco pulls the whole editor and its
 * CSS into the unit run. The file is a flat list of
 * `{ token: '...', foreground: 'rrggbb' }` for `vs`, then `vs-dark`, then the
 * two high-contrast themes we do not use.
 */
function basePalette(): Record<
  'light' | 'dark',
  { background: string; rules: { token: string; foreground: string }[] }
> {
  const src = fs.readFileSync(THEMES_JS, 'utf8');
  // Sliced on `base: '<id>'`, the line that OPENS each theme object, rather
  // than on the id anywhere in the file — the banner comments above each theme
  // mention it first, and relying on those would be luck rather than design.
  const darkAt = src.indexOf("base: 'vs-dark'");
  const hcAt = src.indexOf("base: 'hc-black'");
  expect(darkAt, 'monaco no longer declares vs-dark where expected').toBeGreaterThan(0);
  expect(hcAt, 'monaco no longer declares hc-black where expected').toBeGreaterThan(darkAt);

  const slice = (s: string) => {
    const rules = [...s.matchAll(/token: '([^']*)', foreground: '([0-9a-fA-F]{6})'/g)].map((m) => ({
      token: m[1],
      foreground: m[2].toLowerCase(),
    }));
    // the theme's default rule carries its editor background:
    // `{ token: '', foreground: '000000', background: 'fffffe' }`
    const background = /token: '', foreground: '[0-9a-fA-F]{6}', background: '([0-9a-fA-F]{6})'/
      .exec(s)?.[1]
      ?.toLowerCase();
    expect(background, 'monaco theme has no default background rule').toBeDefined();
    return { background: background ?? '', rules };
  };
  return { light: slice(src.slice(0, darkAt)), dark: slice(src.slice(darkAt, hcAt)) };
}

describe('contrast math', () => {
  it('agrees with the WCAG reference points', () => {
    expect(contrast('000000', 'ffffff')).toBeCloseTo(21, 5);
    expect(contrast('ffffff', 'ffffff')).toBeCloseTo(1, 5);
    // the canonical AA boundary grey on white: #767676 passes, #777777 does not
    expect(contrast('767676', 'ffffff')).toBeGreaterThanOrEqual(AA);
    expect(contrast('777777', 'ffffff')).toBeLessThan(AA);
  });
});

describe('the diff editor themes clear WCAG AA', () => {
  const palette = basePalette();

  for (const scheme of ['light', 'dark'] as const) {
    const bg = EDITOR_BACKGROUND[scheme];

    it(`${scheme}: the background every ratio is measured against is monaco's own`, () => {
      // the one number in monaco-theme.ts the ratios all depend on and nothing
      // else checks — if a monaco upgrade repaints the editor surface, every
      // colour in that file is measured against the wrong thing
      expect(bg).toBe(palette[scheme].background);
    });

    it(`${scheme}: every override clears ${AA}:1 on ${bg}`, () => {
      const missingColor = CONTRAST_FIXES[scheme].filter((r) => r.foreground === undefined);
      // without this, `contrast(undefined-as-'')` is NaN and `NaN < AA` is
      // false — a rule that sets only `fontStyle` would pass silently
      expect(missingColor, 'override with no foreground').toEqual([]);
      const failing = CONTRAST_FIXES[scheme]
        .map((r) => ({ token: r.token, ratio: contrast(r.foreground ?? '', bg) }))
        .filter((r) => !(r.ratio >= AA));
      expect(failing, 'an override that does not actually fix anything').toEqual([]);
    });

    it(`${scheme}: every base scope that misses AA is overridden`, () => {
      // The claim the header makes: a scope is either AA already, or corrected
      // here. This is what a monaco upgrade would break silently — a repainted
      // token would go back under 4.5:1 with nothing to say so.
      const covered = new Set(CONTRAST_FIXES[scheme].map((r) => r.token));
      const uncovered = palette[scheme].rules
        .filter((r) => contrast(r.foreground, bg) < AA && !covered.has(r.token))
        .map((r) => `${r.token || '(default)'} #${r.foreground}`);
      expect(uncovered, 'monaco scope below AA with no override').toEqual([]);
    });

    it(`${scheme}: no override is dead weight`, () => {
      // the flip side: an override for a scope monaco already renders at AA is
      // an unexplained repaint of someone else's palette
      const base = new Map(palette[scheme].rules.map((r) => [r.token, r.foreground]));
      const pointless = CONTRAST_FIXES[scheme]
        .filter((r) => {
          const original = base.get(r.token);
          return original === undefined || contrast(original, bg) >= AA;
        })
        .map((r) => r.token);
      expect(pointless, 'overrides a scope that was already AA (or does not exist)').toEqual([]);
    });

    it(`${scheme}: the override keeps monaco's hue rather than replacing it`, () => {
      // a "minimum nudge" is a lightness move; if the hue swung, someone
      // recoloured the palette and should say so out loud
      const base = new Map(palette[scheme].rules.map((r) => [r.token, r.foreground]));
      for (const rule of CONTRAST_FIXES[scheme]) {
        const before = base.get(rule.token);
        const after = rule.foreground;
        if (before === undefined || after === undefined) continue;
        const channels = (h: string) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
        const [r1, g1, b1] = channels(before);
        const [r2, g2, b2] = channels(after);
        // same ordering of the three channels = same hue family
        const order = (r: number, g: number, b: number) =>
          [r >= g, g >= b, r >= b].map(Number).join('');
        expect(order(r2, g2, b2), `${scheme}/${rule.token} changed hue`).toBe(order(r1, g1, b1));
      }
    });
  }

  it('registers one theme id per colour scheme', () => {
    expect(new Set(Object.values(DIFF_THEME)).size).toBe(2);
  });
});
