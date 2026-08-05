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
// the status ramp and the var() pair a component paints it with (#221): the
// pill's ratio is measured for the pair the app really substitutes, not for one
// spelled out again here
import { statusVars, STATUS_TOKENS, type StatusToken } from '../lib/rail-view';

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

/** the same declarations, with their VALUES — what a theme inherits */
function declaredValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim)) out[m[1]] = m[2].trim();
  return out;
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
  // the urgency strip (E9-04) is the first surface to put secondary ink on
  // --panel2, and it is a functional readout rather than chrome
  ['--muted', '--panel2', 7],
  ['--faint', '--panel2', 4.5],
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

// --- Text on a FILLED surface, in EVERY shipped theme (#206) ----------------
//
// The bars above are a promise the two contrast themes make about themselves.
// This one is different in kind: a legibility FLOOR that holds for nordic and
// daylight too, because a banner nobody can read is not a "less accessible"
// banner, it is a warning that did not arrive. It is what the drift test could
// not catch before — the list of pairs was global, so a token that resolves to
// white on one preset and near-black on another (which is exactly what `--bar`
// does) sailed through: the preflight banner shipped at ~2.5:1 on daylight.
//
// Deliberately NOT the whole PAIRS list applied to all four themes: nordic and
// daylight make no contrast CLAIM (daylight's --faint on --panel is 2.8:1 by
// design, a hairline hint rather than text), and inventing that claim here
// would be this test rewriting the design instead of guarding it.

/** what a theme actually paints: its base preset, plus its own overrides */
const preset: Record<string, Record<string, string>> = {
  nordic: declaredValues(block(":root,\n:root[data-theme='nordic']")),
  daylight: declaredValues(block(":root[data-theme='daylight']")),
};
const semanticDefaults = declaredValues(block(':root {\n  /* status machine'));
function resolved(theme: (typeof builtinThemes)[number]): Record<string, string> {
  return { ...semanticDefaults, ...preset[theme.base], ...theme.tokens };
}

/** the rules that fill OPAQUELY with a color and write on it, and the floor
 *  each owes. Tinted fills are the same promise measured differently — see
 *  "Text on a TINTED fill" below. */
const FILLED_RULES: Array<[string, number]> = [['.preflight-banner', 4.5]];

/** the rules whose background is a color-mix of a hue into a surface. Declared
 *  up here with FILLED_RULES because the applied-by-a-component scan below
 *  reads both — vitest collects describe() bodies lazily so a later const
 *  happens to work, but a test file that only runs under one collector is a
 *  trap rather than a test. */
const TINTED_RULES: Array<[string, number]> = [['.status-pill', 4.5]];

/**
 * The pair, read OUT OF THE STYLESHEET rather than named here.
 *
 * The rule in tokens.css is the thing that ships, so it is the thing measured:
 * swap either var() back for a token that fails — `--bar`, the original bug —
 * and this fails naming it, rather than passing because the tokens it was told
 * to check are still fine and no longer used. Resolved INSIDE the test, not at
 * module scope, so a renamed selector fails one case instead of taking the
 * whole file's collection down with it.
 *
 * `background` and `color` must each be one `var()` — a shorthand or a
 * `background-color:` is a legibility claim this cannot check, so it fails
 * loudly rather than silently measuring nothing.
 */
function pair(selector: string): [ink: string, fill: string] {
  // `${selector} {`, not `selector` — block() looks up by SUBSTRING, so a rule
  // renamed to `.preflight-bannerZ` would still answer to `.preflight-banner`
  // and this would happily measure a rule the component no longer matches
  const rule = block(`${selector} {`);
  const ref = (prop: string): string => {
    const m = new RegExp(`^\\s*${prop}:\\s*var\\((--[a-z0-9-]+)\\)`, 'm').exec(rule);
    expect(m, `${selector} must set ${prop} to one var() to be measured`).not.toBeNull();
    return m![1];
  };
  return [ref('color'), ref('background')];
}

describe('a filled rule is a rule something applies', () => {
  // The stylesheet half is measurable; the half that puts it on screen is a
  // className in a component, and a class nobody applies is a banner rendering
  // with no fill and `--text` ink — every assertion below still green. Scanned
  // across the renderer rather than pinned to App.tsx: which file owns the
  // banner is free to change, "somebody renders it" is not.
  // Components only: a `.test.tsx` asserting on the class is the test agreeing
  // with itself, and the matcher below is loose enough to be fooled by one.
  const tsx = (function read(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return read(p);
      return e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx')
        ? [fs.readFileSync(p, 'utf8')]
        : [];
    });
  })(path.join(__dirname, '..'));

  it.each([...FILLED_RULES, ...TINTED_RULES])('%s is applied by a component', (selector) => {
    // the class name inside a className prop, quoted either way, among other
    // classes, and whether or not it is behind a condition: #222 made the
    // preflight banner's class conditional (`className={spoken ?
    // 'preflight-banner' : undefined}`) so its live region could stay mounted
    // while the fill comes and goes, and a guard that only knew the literal
    // `className="…"` form would have called that "nobody renders it".
    // One line at a time — a className expression wrapped over several is not
    // matched, and would fail with the message below rather than silently.
    const name = selector.slice(1);
    const applied = new RegExp(`className=\\{?[^}\\n]*['"\`][^'"\`\\n]*\\b${name}\\b`);
    expect(
      tsx.some((s) => applied.test(s)),
      `nothing in the renderer puts ${name} in a className`
    ).toBe(true);
  });
});

describe.each(builtinThemes.map((t) => [t.id, t] as const))(
  '%s: words on a filled surface',
  (id, theme) => {
    const tokens = resolved(theme);

    it.each(FILLED_RULES)('%s clears %s:1', (selector, min) => {
      const [ink, fill] = pair(selector);
      for (const token of [ink, fill]) {
        expect(tokens[token], `${id} ${token} must be #rrggbb to be measured`).toMatch(
          /^#[0-9a-f]{6}$/i
        );
      }
      expect(
        ratio(tokens[ink], tokens[fill]),
        `${id}: ${ink} on ${fill} (${tokens[ink]} on ${tokens[fill]})`
      ).toBeGreaterThanOrEqual(min);
    });
  }
);

// --- Text on a TINTED fill, in EVERY shipped theme (#221) -------------------
//
// The banner above fills opaquely, so its fill is a token and the pair is two
// lookups. The grid's status pill is the harder half of the same promise: it
// fills with 14% of a status hue over the card header, so the colour behind the
// word EXISTS NOWHERE as a token — it has to be computed the way the browser
// computes it, which is why #206 could report this defect but not measure it.
//
// It is the worst case in the app by size and by exposure: 9.5px, on every card
// header, permanently. Before this it measured 1.7-2.6:1 on daylight (raw hue
// on a tint of itself) and 3.0-4.5:1 on nordic.

/** srgb mix, rounded to 8 bits — what the compositor actually paints */
function mix(a: string, b: string, pct: number): string {
  const ch = (hex: string): number[] => [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16));
  return (
    '#' +
    ch(a)
      .map((v, i) => Math.round(v * pct + ch(b)[i] * (1 - pct)))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  );
}

/** a `<prop>: var(--x)` reference in a rule — the custom property, not a value */
function refIn(rule: string, selector: string, prop: string, pattern: string): RegExpExecArray {
  const m = new RegExp(`^\\s*${prop}:\\s*${pattern}`, 'm').exec(rule);
  expect(m, `${selector} must set ${prop} to ${pattern} to be measured`).not.toBeNull();
  return m!;
}

/**
 * What one status's pill actually paints, read OUT OF THE STYLESHEET — same
 * rule as `pair()` and for the same reason: the rule is what ships.
 *
 * The rule names two PLACEHOLDERS a component fills in, so which of them is the
 * ink and which is the hue cannot be assumed — assuming it is what let the
 * first cut of this test pass with `color: var(--pill-hue)`, i.e. with the
 * exact bug #221 is about. The roles come from the rule's own DEFAULTS instead:
 * they have to be ONE ramp position's ink and hue. Put the hue back in the
 * `color` and one declaration would have to be both `--status-idle` and
 * `--status-idle-ink`, so this fails before any ratio is computed. WHICH
 * position the default is stays the rule's business — the pill's is idle
 * because §4 says an unrecognised state reads as quiet rather than as an alarm,
 * and presentStatus asserts that where it is decided (rail-view.test.ts).
 *
 * The component's half — which pair those placeholders actually receive — is
 * the one thing this file cannot see, and is held by StatusPill.test.tsx.
 */
function tinted(
  selector: string,
  status: StatusToken
): { ink: string; hue: string; pct: number; surface: string } {
  const rule = block(`${selector} {`);
  const inkVar = refIn(rule, selector, 'color', String.raw`var\((--[a-z0-9-]+)\)`)[1];
  const bg = refIn(
    rule,
    selector,
    'background',
    String.raw`color-mix\(in srgb,\s*var\((--[a-z0-9-]+)\)\s*([\d.]+)%,\s*var\((--[a-z0-9-]+)\)\)`
  );
  const decl = declaredValues(rule);
  const stem = STATUS_TOKENS.find(
    (t) => decl[inkVar] === statusVars(t).ink && decl[bg[1]] === statusVars(t).hue
  );
  expect(
    stem,
    `${selector}: the color and the background must default to ONE ramp position's ink and ` +
      `hue — got ${decl[inkVar]} and ${decl[bg[1]]}, which is not a pair`
  ).toBeDefined();

  const v = statusVars(status);
  const name = (value: string): string => {
    const m = /^var\((--[a-z0-9-]+)\)$/.exec(value);
    expect(m, `statusVars must produce a bare var(), got ${value}`).not.toBeNull();
    return m![1];
  };
  return { ink: name(v.ink), hue: name(v.hue), pct: Number(bg[2]) / 100, surface: bg[3] };
}

describe.each(builtinThemes.map((t) => [t.id, t] as const))(
  '%s: words on a tinted fill',
  (id, theme) => {
    const tokens = resolved(theme);

    for (const [selector, min] of TINTED_RULES) {
      it.each(STATUS_TOKENS)(`${selector} clears ${min}:1 for %s`, (status) => {
        const t = tinted(selector, status);
        for (const token of [t.hue, t.ink, t.surface]) {
          expect(tokens[token], `${id} ${token} must be #rrggbb to be measured`).toMatch(
            /^#[0-9a-f]{6}$/i
          );
        }
        const fill = mix(tokens[t.hue], tokens[t.surface], t.pct);
        expect(
          ratio(tokens[t.ink], fill),
          `${id}: ${t.ink} on ${t.pct * 100}% ${t.hue} over ${t.surface} ` +
            `(${tokens[t.ink]} on ${fill})`
        ).toBeGreaterThanOrEqual(min);
      });
    }
  }
);

// --- Status ink as PLAIN text, in EVERY shipped theme (#221) ----------------
//
// The same defect without the tint: the grid wrote the raw hue as 9.5-11px text
// on the card header (--panel2, 1.8:1 for needs-input on daylight) and on the
// workspace behind the cards (--bg). Those sites are inline styles rather than
// a rule — the value they must NOT use again is the hue, and the floor below is
// what makes the -ink they use instead a promise rather than a preference.
// Not "every surface": every surface a status WORD lands on. --panel2 is the
// card header and the vtab bar, --bg the workspace behind the cards, --panel
// and --rail-row-hover the rail row at rest and under the pointer, --chip the
// collapsed row. It is also what keeps the tinted assertion above honest — that
// one has to be told which surface the pill sits on, and a floor that holds on
// all five means a pill that moved has not silently lost its promise.
const STATUS_TEXT_SURFACES = ['--panel2', '--bg', '--panel', '--rail-row-hover', '--chip'];

describe.each(builtinThemes.map((t) => [t.id, t] as const))(
  '%s: status ink as plain text',
  (id, theme) => {
    const tokens = resolved(theme);

    it.each(
      STATUS_TOKENS.flatMap((s) => STATUS_TEXT_SURFACES.map((f) => [`--status-${s}-ink`, f]))
    )('%s on %s clears 4.5:1', (ink, surface) => {
      for (const token of [ink, surface]) {
        expect(tokens[token], `${id} ${token} must be #rrggbb to be measured`).toMatch(
          /^#[0-9a-f]{6}$/i
        );
      }
      expect(
        ratio(tokens[ink], tokens[surface]),
        `${id}: ${ink} on ${surface} (${tokens[ink]} on ${tokens[surface]})`
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
);
