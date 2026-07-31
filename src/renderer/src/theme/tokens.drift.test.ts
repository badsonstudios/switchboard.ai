// The tests that keep "a theme is a token map" true after this commit
// (P2-E15-05, §5.20).
//
// Three things are asserted, and each one guards a different way this decays:
//  1. DRIFT — tokens.css and theme/tokens.ts name the same tokens. An
//     enumerable list that silently misses a token is worse than no list: the
//     future theme editor would show 41 of 42 swatches and nobody would notice
//     which one it can't reach.
//  2. COVERAGE — a theme that makes a contrast CLAIM defines every themeable
//     token. One that inherits half its palette is a contrast theme by luck.
//  3. CONTRAST — the ratios that make those themes accessibility rather than
//     decoration, computed from the files themselves. §5.20 calls high-contrast
//     an accessibility feature; this is what makes the claim checkable, and it
//     is what stops the softer variant drifting into a merely dimmer one.
//
// Every rule below is applied to the themes as DATA, never to one hard-coded
// import: theme #4 arrived after these tests were written and met all of them
// without a line being added here.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  SEMANTIC_TOKENS,
  THEME_MAP_TOKENS,
  THEME_TOKENS,
  TOKEN_GROUPS,
  tokensOfKind,
} from './tokens';
import { builtinThemes } from './builtin-themes';

const cssPath = path.join(__dirname, 'tokens.css');
// normalized: git hands Windows checkouts CRLF, and a selector spanning two
// lines would never match
const css = fs.readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n');

/** the text of one `<selector> { … }` block, by the selector's exact text */
function block(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `selector not found in tokens.css: ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n}', open);
  return css.slice(open, close);
}

/** custom-property names DECLARED in a block (not the ones it references) */
function declaredTokens(text: string): string[] {
  return [...text.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]);
}

const nordic = declaredTokens(block(":root,\n:root[data-theme='nordic']"));
const daylight = declaredTokens(block(":root[data-theme='daylight']"));
describe('themeable token list', () => {
  it('matches the nordic preset in tokens.css exactly', () => {
    expect([...THEME_MAP_TOKENS].sort()).toEqual([...nordic].sort());
  });

  it('is declared identically by both built-in presets', () => {
    // a token one preset forgets renders as the OTHER theme's value, which is
    // how a light theme ends up with one dark surface
    expect([...daylight].sort()).toEqual([...nordic].sort());
  });

  it('lists only semantic tokens tokens.css actually declares', () => {
    const semantic = declaredTokens(block(':root {\n  /* status machine'));
    for (const token of SEMANTIC_TOKENS) expect(semantic).toContain(token);
  });

  it('leaves session accents, type and metrics out of a theme (§5.20)', () => {
    // identity survives a theme switch — a theme that could repaint accents
    // would change what a session IS, not how the app looks. Read from the
    // FILE rather than matched by a pattern spelled here: a hand-rolled regex
    // is this test writing its own copy of the rule.
    const semantic = declaredTokens(block(':root {\n  /* status machine'));
    const identity = semantic.filter((t) => !SEMANTIC_TOKENS.includes(t));
    expect(identity.length, 'nothing left for a theme to leave alone').toBeGreaterThan(0);
    for (const token of identity) {
      expect(THEME_TOKENS, `${token} must not be themeable`).not.toContain(token);
    }
  });

  it('leaves the derived layer-3 tokens out of a theme', () => {
    // overriding one is how you get a card that disagrees with its own panel
    for (const token of declaredTokens(block(':root {\n  --card-bg'))) {
      expect(THEME_TOKENS, `${token} is derived — not themeable`).not.toContain(token);
    }
  });

  it('has no duplicate token across groups', () => {
    expect(new Set(THEME_TOKENS).size).toBe(THEME_TOKENS.length);
  });

  it('gives every group a value kind', () => {
    for (const g of TOKEN_GROUPS) expect(['color', 'shadow']).toContain(g.kind);
  });
});

/**
 * The themes that make a CONTRAST CLAIM, and are therefore held to it.
 *
 * They must be complete: a contrast theme that inherits half its palette from
 * the nordic preset is a contrast theme by luck. That rule is deliberately NOT
 * applied to every theme — §5.20 promises the ten-token tweaker too, and a
 * small overlay is a legitimate theme. It is the claim that brings the duty.
 */
const CONTRAST_THEMES = ['high-contrast', 'soft-contrast'];

describe.each(CONTRAST_THEMES)('%s is data, and complete', (id) => {
  const tokens = builtinThemes.find((t) => t.id === id)!.tokens;

  it('defines every themeable token', () => {
    expect(Object.keys(tokens).sort()).toEqual([...THEME_TOKENS].sort());
  });

  it('sets no token the applier would drop', () => {
    for (const name of Object.keys(tokens)) expect(THEME_TOKENS).toContain(name);
  });
});

// Applied to EVERY built-in map, not just today's one JSON: the whole point of
// this item is that theme #4 is a file somebody drops in, and a rule enforced
// against a hard-coded import is a rule the next theme never meets.
const mapped = builtinThemes.filter((t) => Object.keys(t.tokens).length > 0);

describe.each(mapped.map((t) => [t.id, t.tokens] as const))('%s: token values', (id, tokens) => {
  it('never says "none" for a shadow', () => {
    // `none` is a whole-property keyword, not a list item: at the call sites
    // that concatenate (`0 0 0 2px <accent>, var(--group-lift)` in the rail)
    // it makes the declaration invalid and the browser drops the LOT — so the
    // theme that most needs the drop-target ring is the one that loses it. A
    // transparent shadow is how a theme says "no lift".
    for (const token of tokensOfKind('shadow')) {
      if (tokens[token] === undefined) continue; // an overlay may inherit it
      expect(tokens[token], `${id} ${token} must be a shadow, not "none"`).not.toBe('none');
    }
  });

  it('gives every color token something a browser reads as a color', () => {
    // Deliberately conservative — it rejects valid CSS (`white`,
    // `transparent`, `currentColor`) and would accept a malformed `#12345`.
    // It is a smell test over OUR files, not a CSS parser; a theme arriving
    // from outside the bundle needs real validation in applyTheme, which is
    // what the token kinds are the hook for.
    for (const token of tokensOfKind('color')) {
      if (tokens[token] === undefined) continue;
      expect(tokens[token], `${id} ${token}`).toMatch(
        /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|color-mix\()/i
      );
    }
  });
});

// --- WCAG contrast, computed from the file ---------------------------------

function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

/** [ink, surface, minimum] — AAA (7:1) for body text, AA (4.5:1) for
 *  secondary ink, 1.4.11's 3:1 for the edges that carry structure. */
const PAIRS: Array<[string, string, number]> = [
  ['--text', '--bg', 7],
  ['--text', '--panel', 7],
  ['--text', '--panel2', 7],
  ['--text', '--chip', 7],
  ['--term', '--bg', 7],
  ['--muted', '--panel', 7],
  ['--faint', '--panel', 4.5],
  ['--border', '--panel', 3],
  ['--group-frame', '--bg', 3],
  ['--rail-divider', '--rail-card', 3],
  ['--rail-close', '--rail-card', 4.5],
  ['--rail-close-hover', '--rail-card', 4.5],
  ['--auto-ink', '--rail-card', 4.5],
  ['--status-working-ink', '--rail-card', 4.5],
  ['--status-needs-input-ink', '--rail-card', 4.5],
  ['--status-needs-permission-ink', '--rail-card', 4.5],
  ['--status-idle-ink', '--rail-card', 4.5],
  ['--status-done-ink', '--rail-card', 4.5],
  ['--status-crashed-ink', '--rail-card', 4.5],
  ['--link', '--panel', 4.5],
  ['--subagent', '--panel', 4.5],
  ['--diff-added', '--panel', 4.5],
  ['--diff-removed', '--panel', 4.5],
  ['--btn-primary-text', '--btn-primary-bg', 4.5],
];

// Both contrast themes, same bars. `soft-contrast` is the comfort variant —
// pure white and pure black pulled back a step because the hard one glares —
// and holding it to the identical thresholds is what stops "softer" drifting
// into "worse": body text measures 15:1 against high contrast's 21:1, and both
// are AAA.
describe.each(CONTRAST_THEMES)('%s is accessibility, not decoration', (id) => {
  const tokens = builtinThemes.find((t) => t.id === id)!.tokens;

  it.each(PAIRS)('%s on %s clears %s:1', (ink, surface, min) => {
    // luminance() reads 6-digit hex only; without this the failure would read
    // "expected NaN to be >= 7" and say nothing about which value is wrong
    for (const token of [ink, surface]) {
      expect(tokens[token], `${token} must be #rrggbb to be measured`).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(ratio(tokens[ink], tokens[surface])).toBeGreaterThanOrEqual(min);
  });
});
