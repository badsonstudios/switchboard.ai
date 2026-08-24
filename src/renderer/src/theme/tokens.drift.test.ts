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
// normalized: a selector spanning two lines would never match against CRLF.
// `.gitattributes` pins checkouts to LF (#280); this stays as cheap insurance
// for a working copy that predates it.
const css = fs.readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n');

/** the text of one `<selector> { … }` block, by the selector's exact text */
function block(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `selector not found in tokens.css: ${selector}`).toBeGreaterThan(-1);
  // ...and found ONCE. This is a substring lookup, so a selector that also
  // appears inside a grouped selector list resolves to whichever comes first in
  // the file and every ratio below it measures a rule the browser applies to
  // something else — silently. `.urgency-lamp[data-lit='true'] {` was one edit
  // away from being exactly that (#267), which is why the group in tokens.css
  // leads with it.
  expect(
    css.split(selector).length - 1,
    `selector matches more than one rule in tokens.css — reword the lookup or the ` +
      `grouped selector it collides with: ${selector}`
  ).toBe(1);
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

/** the one neutral ink §5.11 badges write on an accent field (#269) */
const ACCENT_INK = '--accent-ink-on-fill';

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
  // `--group-frame` used to be here, against `--bg` only and for these two
  // themes only. It moved to "the container frame reads against every surface
  // it borders" below (#648), which is strictly stronger: all six surfaces the
  // edge actually touches, in all four themes. Leaving a weaker copy here
  // would be a second place to fix when the frame moves.
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
  // the events drawer's tab (P2-E14-01) tints its edge with the queue's hottest
  // kind and its notice dot with `--status-working-ink`. Both are non-text
  // objects that carry meaning, so 1.4.11's 3:1 — and against `--panel`, which
  // is the tab's own background. The RAW `--status-*` hues are one set of
  // values for every theme and measure 1.9–2.5:1 here, which is exactly why the
  // tab uses the per-theme inks; these lines are what keeps it that way.
  ['--status-working-ink', '--panel', 3],
  ['--status-needs-input-ink', '--panel', 3],
  ['--status-needs-permission-ink', '--panel', 3],
  ['--status-done-ink', '--panel', 3],
  ['--status-crashed-ink', '--panel', 3],
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
const FILLED_RULES: Array<[string, number]> = [
  ['.preflight-banner', 4.5],
  // P2-E14-07's corroboration strip. Same pair as the preflight banner, and on
  // the list for the same reason: a warning nobody can read is a warning that
  // did not arrive.
  ['.service-health-banner', 4.5],
  // The conversation's turn boundary (#640). Not a warning — the opposite, a
  // piece of permanent furniture — but it is on this list because it is the
  // first divider in the app that makes a PROMINENCE claim, and the way that
  // claim dies is silently: swap the ink back for `--border` and the rule is
  // 1.30:1 on nordic again, which is the defect #640 was filed over rather than
  // a subtler take on it. AA rather than 1.4.11's 3:1 because the caption is
  // real text (9px), and the rule itself is `currentColor`, so this one number
  // covers both halves of the divider.
  ['.turn-divider', 4.5],
  // The events drawer's row at rest (#268). Its de-emphasised twin is in
  // MIXED_RULES below — the pair is on the list together so the "reviewed"
  // step down the neutral ladder is always measured against the step it came
  // from, rather than one of them drifting on its own.
  ['.event-row', 4.5],
];

/**
 * FIND MARKS (#520) — the same measurement, a separate list for one reason:
 * nothing puts these on screen with a `className`.
 *
 * A mark is an ELEMENT the find code creates (`lib/text-marks.ts` writes
 * `<mark data-…-match>`), so the "is applied by a component" scan below — which
 * looks for the class inside a `className=` prop — would fail on a rule that is
 * perfectly live. The attribute IS the selector, and the thing that proves it
 * is applied is `feed-marks.test.ts` / `document-find.test.ts`, which assert on
 * the marked DOM.
 *
 * Held to AA rather than the banners' floor for the same reason they are: a
 * highlight nobody can read is not a subtler highlight, it is the bug #520 was
 * filed over with more colour in it. Both surfaces are on the list because they
 * deliberately share the two token pairs, and a list with one of them on it
 * would let the other drift.
 */
const MARK_RULES: Array<[string, number]> = [
  ['mark[data-feed-match]', 4.5],
  ['mark[data-feed-match-current]', 4.5],
  ['.doc-main mark[data-doc-match]', 4.5],
  ['.doc-main mark[data-doc-match-current]', 4.5],
];

/**
 * The rules whose background is a color-mix of a hue into a surface. Declared
 * up here with FILLED_RULES because the applied-by-a-component scan below
 * reads both — vitest collects describe() bodies lazily so a later const
 * happens to work, but a test file that only runs under one collector is a
 * trap rather than a test.
 *
 * `defaults` names the rule that declares the two placeholders, for the rules
 * that do not declare them themselves: the collapsed row's tint lives on a
 * `[data-needs-you]` variant while `--row-hue` / `--row-ink` are set once on
 * the base rule, which is where the ink-vs-hue roles have to be read from.
 */
interface TintedRule {
  /** the rule's own selector, exactly as tokens.css spells it */
  selector: string;
  /** the ratio it owes */
  min: number;
  /** where `--*-hue` / `--*-ink` are declared, if not in `selector` itself */
  defaults?: string;
}
const TINTED_RULES: TintedRule[] = [
  { selector: '.status-pill', min: 4.5 },
  // #246: the same shape as the pill and unaudited until now. Two rules, not
  // one — a row under the pointer is a different fill, and it was the one
  // below AA (26% put nordic at 4.03:1).
  { selector: ".collapsed-row[data-needs-you='true']", min: 4.5, defaults: '.collapsed-row' },
  {
    selector: ".collapsed-row[data-needs-you='true']:hover",
    min: 4.5,
    defaults: '.collapsed-row',
  },
];

/**
 * Rules whose background is a color-mix of two SURFACE tokens (#268).
 *
 * A third shape, and it is here because it is what an `opacity` becomes when
 * you stop using one. TINTED_RULES measures a STATUS HUE washed over a
 * surface, so its reader insists the two placeholders be one ramp position's
 * hue and ink — a de-emphasis has neither, it is one surface pulled part of
 * the way toward the surface behind it, and the ink on top is a neutral.
 *
 * The events drawer's reviewed row is the whole list so far, and it is the
 * case worth writing the reader for: it used to be `opacity: 0.82` on the row,
 * which is not a de-emphasis but a contrast cut applied to every colour at
 * once, and NOTHING in this file could see it. A `color-mix` can be read, so
 * the fill the user actually sees is now a number, and the ink written on it
 * is measured against that number rather than against `--panel2`, which is a
 * surface the reviewed row does not have.
 */
const MIXED_RULES: Array<[selector: string, min: number]> = [
  [".event-row[data-reviewed='true']", 4.5],
];

/** the class a tinted/filled selector is applied by — `.a[data-b]:hover` → `a` */
function classOf(selector: string): string {
  const m = /^\.([a-z0-9-]+)/.exec(selector);
  expect(m, `${selector} must start with a class to be found in a component`).not.toBeNull();
  return m![1];
}

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

  it.each([
    ...FILLED_RULES.map(([s]) => s),
    ...TINTED_RULES.map((r) => r.selector),
    ...MIXED_RULES.map(([s]) => s),
  ])('%s is applied by a component', (selector) => {
    // the class name inside a className prop, quoted either way, among other
    // classes, and whether or not it is behind a condition: #222 made the
    // preflight banner's class conditional (`className={spoken ?
    // 'preflight-banner' : undefined}`) so its live region could stay mounted
    // while the fill comes and goes, and a guard that only knew the literal
    // `className="…"` form would have called that "nobody renders it".
    // One line at a time — a className expression wrapped over several is not
    // matched, and would fail with the message below rather than silently.
    // the CLASS, not the whole selector: a tinted rule may be a variant
    // (`.collapsed-row[data-needs-you='true']:hover`) and what a component
    // writes in a className is only the stem (#246)
    const name = classOf(selector);
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

    it.each([...FILLED_RULES, ...MARK_RULES])('%s clears %s:1', (selector, min) => {
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
  { selector, defaults }: TintedRule,
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
  // the defaults may live on the base rule the variant refines — but they are
  // still READ, never named here, so a swapped pair fails exactly as it does
  // for a rule that declares its own (#246)
  const decl = declaredValues(defaults ? block(`${defaults} {`) : rule);
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

    for (const spec of TINTED_RULES) {
      const { selector, min } = spec;
      it.each(STATUS_TOKENS)(`${selector} clears ${min}:1 for %s`, (status) => {
        const t = tinted(spec, status);
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

// --- Words on a DE-EMPHASISED fill, in EVERY shipped theme (#268) -----------
//
// The events drawer's reviewed row receded with `opacity: 0.82` on the whole
// row. Group opacity is not a de-emphasis: it fades the text AND the fill
// toward whatever is behind BOTH, so it takes ratio off every colour on the
// row at once — the row's task label went from 4.55:1 to 3.61:1 on nordic —
// and no reader in this file could see it, because an opacity is not a token
// pair. Nor could it be rescued by a bigger number: `--muted` on `--panel2` is
// 4.55:1 at FULL strength on nordic, so the first legal opacity is 0.996.
//
// A `color-mix` of the two surfaces says the same thing and can be read. The
// fill below is byte-identical to what 0.82 composited (`#323846` on nordic),
// so the row does not move; what changed is that the ink on it is a token
// choice — one rung down the neutral ladder — instead of a faded `--text`.

/** what a de-emphasised rule paints: a mix of two SURFACES, and the ink on it */
function mixed(selector: string): { ink: string; top: string; pct: number; under: string } {
  const rule = block(`${selector} {`);
  const ink = refIn(rule, selector, 'color', String.raw`var\((--[a-z0-9-]+)\)`)[1];
  const bg = refIn(
    rule,
    selector,
    'background',
    String.raw`color-mix\(in srgb,\s*var\((--[a-z0-9-]+)\)\s*([\d.]+)%,\s*var\((--[a-z0-9-]+)\)\)`
  );
  return { ink, top: bg[1], pct: Number(bg[2]) / 100, under: bg[3] };
}

describe('a de-emphasised rule recedes from the rule it refines (issue 268)', () => {
  it.each(MIXED_RULES.map(([s]) => s))('%s mixes its OWN surface, not another', (selector) => {
    // The variant has to be the BASE rule's fill pulled toward something else.
    // Mixing a third surface in would make "reviewed" a different box rather
    // than a quieter one, and every ratio below would still pass — it would
    // just be measuring a row nobody recognises. The base rule is on
    // FILLED_RULES, so `pair()` reads its background out of the file too and
    // neither side is spelled here.
    const [baseInk, base] = pair(`.${classOf(selector)}`);
    const m = mixed(selector);
    expect(m.top, `${selector} must recede from ${base}`).toBe(base);
    expect(m.pct, `${selector}: a 100% mix is not a mix`).toBeLessThan(1);
    expect(m.pct, `${selector}: the base surface has to be most of the fill`).toBeGreaterThan(0.5);
    // ...and it has to be a DIFFERENT ink from the rule it refines. Without
    // this the whole file passes with `color: var(--text)` here — i.e. with
    // the de-emphasis gone entirely, which is not an AA failure (it is MORE
    // contrast) and is therefore the one regression no floor can object to.
    // The per-theme block below turns it into the stronger claim: less
    // contrast than the base rule, in every theme.
    expect(
      m.ink,
      `${selector} writes the same ink as the rule it is supposed to recede from`
    ).not.toBe(baseInk);
  });
});

describe.each(builtinThemes.map((t) => [t.id, t] as const))(
  '%s: words on a de-emphasised fill',
  (id, theme) => {
    const tokens = resolved(theme);

    it.each(MIXED_RULES)('%s clears %s:1', (selector, min) => {
      const m = mixed(selector);
      for (const token of [m.ink, m.top, m.under]) {
        expect(tokens[token], `${id} ${token} must be #rrggbb to be measured`).toMatch(
          /^#[0-9a-f]{6}$/i
        );
      }
      const fill = mix(tokens[m.top], tokens[m.under], m.pct);
      expect(
        ratio(tokens[m.ink], fill),
        `${id}: ${m.ink} on ${m.pct * 100}% ${m.top} over ${m.under} ` +
          `(${tokens[m.ink]} on ${fill})`
      ).toBeGreaterThanOrEqual(min);
      // BOTH DIRECTIONS. The floor above says the quiet row is readable; this
      // says it is still quiet. Measured against the rule it refines rather
      // than against a number, so retuning either ink keeps the relationship
      // honest and only an inversion fails. A "de-emphasis" that has drifted
      // into being the LOUDER of the two clears every floor in this file, and
      // it is the exact way a hand-tuned look dies.
      const [baseInk, base] = pair(`.${classOf(selector)}`);
      expect(
        ratio(tokens[m.ink], fill),
        `${id}: ${selector} is no quieter than ${base} — ${m.ink} on the mix vs ` +
          `${baseInk} on ${base}`
      ).toBeLessThan(ratio(tokens[baseInk], tokens[base]));
    });
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

// --- The container frame, against every surface it borders (#648) -----------
//
// `--group-frame` is the app's ONE structural edge: the grid's session windows
// and the rail's group cards share it, because both are "a container holding
// sessions". It is a meaningful non-text object, so WCAG 1.4.11 asks 3:1 of it
// — and until now the only assertion on it was one line in PAIRS, against
// `--bg`, for the two contrast themes. That left the frame unaudited on the
// two presets people actually use, and on five of the six surfaces it touches:
// it was 2.55-2.91:1 against everything INSIDE the card on nordic, and 2.76:1
// against the workspace it is drawn ON on daylight.
//
// A 1px line lives between two colours and has to be seen against both, so the
// list is every surface either side of it: the workspace behind a card
// (`--bg`, `--rail-canvas`), the body inside one (`--panel` = `--card-bg`,
// `--rail-card`, and the auto-group's own tinted fill), the dockview tab strip
// that runs along the top edge inside a session group (`--panel2`), and the
// header strip along the top of an auto-group card (`--auto-head`). Those last
// two are the same shape and both are easy to miss, because "the surface
// inside the frame" sounds like one thing and is two: a card is a strip and a
// body, and the frame touches both.
//
// TWO THINGS ARE NOT ON THE LIST, and the reasons differ:
//
//   - the ACTIVE group's frame, which `.dv-groupview.dv-active-group` repaints
//     in `--link`. A different token making a different promise; folding it in
//     would measure a border this one never draws.
//   - a HAND-MADE group's header strip, which is `color-mix(<the group's
//     colour> 7%, transparent)` over `--rail-card` (`SessionsRail.tsx`). The
//     colour is a user's pick out of a palette the main process persists, so it
//     is runtime data and there is nothing in these files to read. An exemption
//     by necessity rather than by choice, written down because an unstated
//     omission from a list like this is exactly how the frame stayed unaudited
//     on five surfaces in the first place.

const FRAME = '--group-frame';
const FRAME_SURFACES = ['--bg', '--panel', '--panel2', '--rail-canvas', '--rail-card'];

/** the derived surfaces the frame borders — layer-3 `color-mix` tokens */
const FRAME_DERIVED = ['--auto-surface', '--auto-head'];

/**
 * A layer-3 surface whose value is a color-mix of two theme tokens, resolved
 * for one theme — read out of the file rather than spelled here, so a retuned
 * auto-group fill is measured at its new value instead of at this test's
 * memory of the old one.
 *
 * `block()` is called INSIDE rather than at module scope, for `pair()`'s stated
 * reason: a reordered layer-3 block would otherwise throw during COLLECTION and
 * take every case in this file down with it, instead of failing the ones that
 * read it.
 */
function derivedSurface(token: string, id: string, tokens: Record<string, string>): string {
  const layer3 = declaredValues(block(':root {\n  --card-bg'));
  const m =
    /^color-mix\(in srgb,\s*var\((--[a-z0-9-]+)\)\s*([\d.]+)%,\s*var\((--[a-z0-9-]+)\)\)$/.exec(
      layer3[token] ?? ''
    );
  expect(m, `${token} must be a color-mix of two tokens to be measured`).not.toBeNull();
  // the same guard every sibling case has. Without it an undefined token throws
  // inside mix(), and a non-hex one yields a colour of NaNs and a failure that
  // says "expected NaN" rather than naming the value that is wrong.
  for (const t of [m![1], m![3]]) {
    expect(tokens[t], `${id} ${t} must be #rrggbb to be measured`).toMatch(/^#[0-9a-f]{6}$/i);
  }
  return mix(tokens[m![1]], tokens[m![3]], Number(m![2]) / 100);
}

describe.each(builtinThemes.map((t) => [t.id, t] as const))(
  '%s: the container frame reads against every surface it borders',
  (id, theme) => {
    const tokens = resolved(theme);
    const frame = (): string => {
      expect(tokens[FRAME], `${id} ${FRAME} must be #rrggbb to be measured`).toMatch(
        /^#[0-9a-f]{6}$/i
      );
      return tokens[FRAME];
    };

    it.each(FRAME_SURFACES)(`${FRAME} on %s clears 3:1`, (surface) => {
      expect(tokens[surface], `${id} ${surface} must be #rrggbb to be measured`).toMatch(
        /^#[0-9a-f]{6}$/i
      );
      expect(
        ratio(frame(), tokens[surface]),
        `${id}: ${FRAME} on ${surface} (${tokens[FRAME]} on ${tokens[surface]})`
      ).toBeGreaterThanOrEqual(3);
    });

    it.each(FRAME_DERIVED)(`${FRAME} on %s clears 3:1`, (surface) => {
      const fill = derivedSurface(surface, id, tokens);
      expect(
        ratio(frame(), fill),
        `${id}: ${FRAME} on ${surface} (${tokens[FRAME]} on ${fill})`
      ).toBeGreaterThanOrEqual(3);
    });
  }
);

// --- Words on an ACCENT FIELD, in EVERY shipped theme (#269) ----------------
//
// The §5.11 identity badge is the one place a session's accent has words on it,
// and until #269 the accent WAS the words: 9px of `--accent-pink` on the card
// header measured 3.39:1 on nordic, and every one of the eight was 1.80-3.11:1
// on daylight. The status ramp's answer (#221/#243 — a second, per-theme shade
// tuned to be read) is not available here, because an accent is an IDENTITY: a
// second shade of it would be a second identity, and §5.20 already forbids a
// theme from repainting one.
//
// So the accent became the FIELD and the ink became neutral, and this is the
// assertion that makes that a promise rather than a preference.
//
// BOTH HALVES ARE THEME-INDEPENDENT, so these are eight distinct facts measured
// four times, not thirty-two: the numbers below do NOT differ per theme, and
// that identity is the claim. It is still run per theme because `resolved()`
// spreads a theme's own tokens last — so a JSON theme that found a way to set
// either side would fail here, in the theme that set it, rather than ship.
//
// The accents are READ OUT OF THE FILE, so a ninth needs no edit to this test.

/** every `--accent-<name>` the palette declares, minus the ink that sits on them */
const ACCENT_TOKENS = declaredTokens(block(':root {\n  /* status machine')).filter(
  (t) => t.startsWith('--accent-') && t !== ACCENT_INK
);

it('has an accent palette to measure', () => {
  // the guard's guard: a renamed prefix would leave this list empty and every
  // case below would pass by not existing. Once, at module scope — inside the
  // per-theme describe it was the same assertion four times.
  expect(ACCENT_TOKENS.length).toBeGreaterThan(4);
});

describe.each(builtinThemes.map((t) => [t.id, t] as const))(
  '%s: words on an accent field',
  (id, theme) => {
    const tokens = resolved(theme);

    it.each(ACCENT_TOKENS)(`${ACCENT_INK} on %s clears 4.5:1`, (accent) => {
      for (const token of [ACCENT_INK, accent]) {
        expect(tokens[token], `${id} ${token} must be #rrggbb to be measured`).toMatch(
          /^#[0-9a-f]{6}$/i
        );
      }
      expect(
        ratio(tokens[ACCENT_INK], tokens[accent]),
        `${id}: ${ACCENT_INK} on ${accent} (${tokens[ACCENT_INK]} on ${tokens[accent]})`
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
);

// The badge falls back to a neutral chip for a card with no accent yet, and that
// pair is `--text` on `--chip` — 8.4:1 on nordic, where the `--muted` it
// replaced was 4.10:1. Held here because the chip is the only place in the app
// that writes it and PAIRS above only covers the two contrast themes.
describe.each(builtinThemes.map((t) => [t.id, t] as const))(
  '%s: the accent-less badge',
  (id, theme) => {
    const tokens = resolved(theme);
    it('clears 4.5:1 on the neutral chip it falls back to', () => {
      expect(
        ratio(tokens['--text'], tokens['--chip']),
        `${id}: --text on --chip (${tokens['--text']} on ${tokens['--chip']})`
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
);

// --- The urgency lamp's STATE MODEL, in EVERY shipped theme (#267) ----------
//
// The pill above is one rule with one fill. The lamp is a state MATRIX, and
// that is why it shipped below AA while every rule around it was being audited:
// four surfaces (the strip at rest, the hover wash, the "you are here" chip,
// and a wash of the lamp's own hue) crossed with the ink each of them owes —
// and the colour for the lit state was never written by the lit rule at all. It
// fell out of whichever rule won the cascade, which was the base rule's
// `--muted`, a token tuned against the flat strip. Over the old 22% wash that
// measured 2.97-3.67:1 on nordic, and 2.77:1 under the pointer at 26%.
//
// So the assertions below are deliberately about the MODEL and not only about
// the numbers. A state that paints a wash must name the lamp's HUE placeholder
// and write its INK placeholder — which is which comes from the base rule's own
// defaults, so swapping them fails before a ratio is computed — and every state
// on a flat surface must name an ink that clears that surface. The lamp's name
// is TEXT (the session title at 10px), so the floor is 4.5:1 in every state;
// the dot and the lit ring are the only graphical objects here and neither
// carries a word.
//
// `tinted()` above cannot read any of this: it wants one rule that declares its
// own placeholders, and the lamp declares them once on `.urgency-lamp` while
// the washes live on the state rules. #246 (PR #265) generalises `tinted()`
// with a `defaults` selector for the same reason — once both have landed, this
// reader and that one should become one.

/** the rules, spelled exactly as tokens.css groups them — `block()` looks up by
 *  substring, so a regrouped selector fails loudly instead of measuring a rule
 *  the browser no longer applies */
const LAMP_BASE = '.urgency-lamp';
const LAMP_ACTIVE = ".urgency-lamp[data-active='true']";
const LAMP_HOVER = '.urgency-lamp:hover';
const LAMP_LIT = ".urgency-lamp[data-lit='true']";
const LAMP_SIGNAL = ".urgency-lamp[data-lit='true'],\n.urgency-lamp[data-needs-you='true']";
const LAMP_SIGNAL_HOVER =
  ".urgency-lamp[data-needs-you='true']:hover,\n.urgency-lamp[data-lit='true']:hover";

/** the surface the strip paints behind every lamp. Named here because it lives
 *  in a component's inline style rather than in this file — UrgencyStrip.test's
 *  "the strip stays on --panel2" is the half that keeps it true. */
const LAMP_SURFACE = '--panel2';

/** a `<prop>: var(--x)` a rule declares, as the token name */
function lampRef(selector: string, prop: string): string {
  return refIn(block(`${selector} {`), selector, prop, String.raw`var\((--[a-z0-9-]+)\)`)[1];
}

/** which of the lamp's two placeholders is the hue and which is the ink — from
 *  the BASE rule's own defaults, never from a name spelled here. They have to
 *  be ONE ramp position's pair, so a state rule that writes the hue into
 *  `color` cannot satisfy both. */
function lampPlaceholders(): { hue: string; ink: string } {
  const decl = declaredValues(block(`${LAMP_BASE} {`));
  const named = (value: string): string | undefined =>
    Object.keys(decl).find((k) => decl[k] === value);
  for (const token of STATUS_TOKENS) {
    const v = statusVars(token);
    const [hue, ink] = [named(v.hue), named(v.ink)];
    if (hue && ink) return { hue, ink };
  }
  expect(
    undefined,
    `${LAMP_BASE} must default its two placeholders to ONE ramp position's hue and ink — ` +
      `got ${JSON.stringify(decl)}`
  ).toBeDefined();
  throw new Error('unreachable');
}

/** what one state rule washes over the strip */
function lampWash(selector: string): { hue: string; pct: number; surface: string } {
  const m = refIn(
    block(`${selector} {`),
    selector,
    'background',
    String.raw`color-mix\(in srgb,\s*var\((--[a-z0-9-]+)\)\s*([\d.]+)%,\s*var\((--[a-z0-9-]+)\)\)`
  );
  return { hue: m[1], pct: Number(m[2]) / 100, surface: m[3] };
}

/** [what the state is, the rule its ink comes from, the rule its surface comes
 *  from — or the surface itself]. Thunks, so a renamed selector fails the one
 *  case that reads it rather than taking the file's collection down. The pairs
 *  are the cascade the browser runs: `:hover` changes the background and leaves
 *  the colour wherever the state rules put it. */
const LAMP_FLAT: Array<[state: string, ink: () => string, surface: () => string]> = [
  ['at rest, on the strip', () => lampRef(LAMP_BASE, 'color'), () => LAMP_SURFACE],
  [
    'at rest, under the pointer',
    () => lampRef(LAMP_BASE, 'color'),
    () => lampRef(LAMP_HOVER, 'background'),
  ],
  ['"you are here"', () => lampRef(LAMP_ACTIVE, 'color'), () => lampRef(LAMP_ACTIVE, 'background')],
  [
    '"you are here", under the pointer',
    () => lampRef(LAMP_ACTIVE, 'color'),
    () => lampRef(LAMP_HOVER, 'background'),
  ],
];

/** [what the state is, the rule that paints the wash, the rule its ink comes
 *  from] — the deeper hover wash inherits the signal rule's colour, which is
 *  the cascade and therefore what is measured. */
const LAMP_WASHES: Array<[state: string, wash: string, inkFrom: string]> = [
  ['a lamp carrying a signal', LAMP_SIGNAL, LAMP_SIGNAL],
  ['a lamp carrying a signal, under the pointer', LAMP_SIGNAL_HOVER, LAMP_SIGNAL],
];

// `issue 267`, not `#267`: the no-raw-hex ESLint rule reads a `#` followed by
// three hex digits in a string literal as a colour, which is the convention the
// other renderer tests already follow.
describe('the urgency lamp writes an ink, never a repurposed one (issue 267)', () => {
  it('washes the placeholder the base rule calls the HUE', () => {
    const roles = lampPlaceholders();
    for (const [state, wash] of LAMP_WASHES) {
      expect(lampWash(wash).hue, `${state} must wash the lamp's hue`).toBe(roles.hue);
    }
  });

  it('writes the placeholder the base rule calls the INK on the wash', () => {
    // #267 verbatim: a wash whose colour is left to the cascade, which hands it
    // the base rule's `--muted`. Naming the ink is the fix, and this is the
    // assertion that fails if it is ever taken back out.
    expect(lampRef(LAMP_SIGNAL, 'color')).toBe(lampPlaceholders().ink);
  });

  it('lets no LATER rule write a colour over that ink', () => {
    // The rules below the wash are (0,2,0) and (0,3,0) and every one of them is
    // source-later, so a `color` in any of them wins for a washed lamp — which
    // is #267's shape exactly, and neither the ratios below nor the flat cases
    // would see it: they read the rule they are told to read. The deep hover
    // wash and the lit ring must therefore declare a background and a border
    // and nothing else about the text.
    for (const selector of [LAMP_SIGNAL_HOVER, LAMP_LIT, LAMP_HOVER]) {
      expect(
        /^\s*color:/m.test(block(`${selector} {`)),
        `${selector} comes after the wash rule, so a color: here silently replaces its ink`
      ).toBe(false);
    }
  });

  it('washes over the surface the strip actually paints', () => {
    // a wash mixed into `transparent`, or into some other panel, leaves every
    // ratio below measuring a colour nobody sees
    for (const [state, wash] of LAMP_WASHES) {
      expect(lampWash(wash).surface, `${state} must mix into ${LAMP_SURFACE}`).toBe(LAMP_SURFACE);
    }
  });

  it('puts those rules where the comment says they are', () => {
    // the test above is only true because of SOURCE ORDER — every rule here is
    // (0,2,0) but for the hover pair, so the file's order is the cascade. Move
    // the wash above `[data-active]` and the "you are here" ink would start
    // winning for a washed lamp; move it below the hover rule and a hovered
    // needing lamp would lose its wash. Neither shows up in a ratio.
    const at = (selector: string): number => css.indexOf(`${selector} {`);
    expect(at(LAMP_ACTIVE), 'the wash must override "you are here"').toBeLessThan(at(LAMP_SIGNAL));
    for (const selector of [LAMP_SIGNAL_HOVER, LAMP_LIT, LAMP_HOVER]) {
      expect(at(LAMP_SIGNAL), `${selector} must come after the wash`).toBeLessThan(at(selector));
    }
  });

  it('draws the lit ring in the ink, not the raw hue', () => {
    // the ring is now the WHOLE of "you were just sent here" — the wash no
    // longer differs — so it is a graphical object carrying meaning, and 1.4.11
    // asks 3:1 of it. In the raw hue it was 1.80:1 against the strip on
    // daylight; the ratios are asserted per theme below.
    const roles = lampPlaceholders();
    expect(lampRef(LAMP_LIT, 'border-color')).toBe(roles.ink);
  });

  it('keeps the hover wash deeper than the one it deepens', () => {
    // otherwise "hover" is a rule that paints the state the lamp already had —
    // the failure mode of pulling both numbers down to the same ceiling
    expect(lampWash(LAMP_SIGNAL_HOVER).pct).toBeGreaterThan(lampWash(LAMP_SIGNAL).pct);
  });
});

describe.each(builtinThemes.map((t) => [t.id, t] as const))(
  '%s: every urgency lamp state is legible',
  (id, theme) => {
    const tokens = resolved(theme);
    const hex = (token: string): string => {
      expect(tokens[token], `${id} ${token} must be #rrggbb to be measured`).toMatch(
        /^#[0-9a-f]{6}$/i
      );
      return tokens[token];
    };

    it.each(LAMP_FLAT)('%s clears 4.5:1', (_state, ink, surface) => {
      const [i, s] = [ink(), surface()];
      expect(
        ratio(hex(i), hex(s)),
        `${id}: ${i} on ${s} (${tokens[i]} on ${tokens[s]})`
      ).toBeGreaterThanOrEqual(4.5);
    });

    for (const [state, wash, inkFrom] of LAMP_WASHES) {
      it.each(STATUS_TOKENS)(`${state} clears 4.5:1 for %s`, (status) => {
        const w = lampWash(wash);
        // the wash is measured with the colour the CASCADE gives it, and that
        // colour has to be the lamp's ink placeholder — the roles check above
        // says which one that is, and this says this rule still uses it
        expect(lampRef(inkFrom, 'color'), 'the wash must be read with the ink it writes').toBe(
          lampPlaceholders().ink
        );
        // the PAIR the component substitutes, not the placeholders: the rule's
        // defaults are idle's, and idle is not the position that fails
        const name = (value: string): string => {
          const m = /^var\((--[a-z0-9-]+)\)$/.exec(value);
          expect(m, `statusVars must produce a bare var(), got ${value}`).not.toBeNull();
          return m![1];
        };
        const v = statusVars(status);
        const [ink, hue] = [name(v.ink), name(v.hue)];
        const fill = mix(hex(hue), hex(w.surface), w.pct);
        expect(
          ratio(hex(ink), fill),
          `${id}: ${ink} on ${w.pct * 100}% ${hue} over ${w.surface} (${tokens[ink]} on ${fill})`
        ).toBeGreaterThanOrEqual(4.5);
        // The lit RING is drawn in this same ink (asserted above) around this
        // same fill, and it is a graphical object rather than text: 1.4.11's
        // 3:1. Its inside edge is the ratio just measured, so what is left to
        // check is its OUTSIDE edge, against the strip.
        expect(
          ratio(hex(ink), hex(w.surface)),
          `${id}: the lit ring (${ink}) against ${w.surface}`
        ).toBeGreaterThanOrEqual(3);
      });
    }
  }
);

// --- No raw status hue is ever a TEXT colour, anywhere (#246) ---------------
//
// The floor above says the INK is readable. This says the ink is what gets
// used, and it is the assertion #221's hand-off asked for: it fixed one site
// and reported six more of exactly the same shape — a dirty-file count, an
// approval title, a stop glyph, a streaming caret, a tool name, a link in
// rendered prose — none of which any test could see, because they are inline
// styles and a lone CSS rule rather than a measurable pair. Two more of the
// same defect (the feed's todo markers and its autonomy chip) were found by
// writing this, which is the argument for it: six known sites are a list, and
// a list goes stale the next time somebody reaches for a status colour.
//
// The rule it encodes is the whole of §5.20's status vocabulary in one line:
// `--status-<x>` is for dots, rings, tints and edges; `--status-<x>-ink` is
// the only one of the pair tuned against what is BEHIND a word. Reaching for
// the hue in a `color` is the bug, in every theme at once, whatever the
// surface — so this needs no surface to check and cannot go stale.
describe('a status hue is never spent on words', () => {
  /** every file that can paint: the stylesheets and the renderer's own code */
  const sources = (function read(dir: string): Array<[string, string]> {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e): Array<[string, string]> => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return read(p);
      // tests are excluded: one of them names a status hue as a GROUP colour
      // (an identity, not a status) and would be a permanent false positive
      const src = /\.(css|tsx?)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name);
      return src ? [[path.relative(path.join(__dirname, '..'), p), fs.readFileSync(p, 'utf8')]] : [];
    });
  })(path.join(__dirname, '..'));

  /**
   * The value of every `color:` in a file — the CSS declaration and the React
   * inline-style property, which are the same three characters.
   *
   * `borderColor` / `background-color` / `caret-color` are NOT matched: the
   * capital C fails a case-sensitive match and the hyphen fails the boundary,
   * which is deliberate — an EDGE painted in a status hue is the design (the
   * pill's border, the collapsed row's, the stop button's), and folding those
   * in would make this test demand a redesign rather than guard a promise.
   *
   * The value ends at the first `,` or `;` AT PAREN DEPTH ZERO, so an object
   * property stops before the next one while a `color-mix(in srgb, …)` — whose
   * first comma is three characters in — is kept whole. A ternary contains
   * neither and is captured entire, which is how both arms of the feed's todo
   * marker are seen.
   *
   * KNOWN BLIND SPOT: a value wrapped onto the following line. `[^\n]*` stops
   * at the newline, and there is no formatter in this repo to produce one, so
   * it takes a human writing `color:\n  …` — but it would pass silently.
   */
  const colorValues = (src: string): string[] =>
    [...src.matchAll(/(?:^|[\s{(,;])color:\s*([^\n]*)/g)].map((m) => {
      let depth = 0;
      for (let i = 0; i < m[1].length; i++) {
        const c = m[1][i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if ((c === ',' || c === ';') && depth <= 0) return m[1].slice(0, i);
      }
      return m[1];
    });

  /**
   * The values of every `const NAME: … = { … }` map in a file, keyed by NAME.
   *
   * ONE HOP OF INDIRECTION, and it is here because a real site hid behind
   * exactly one: `EventsPanel.tsx` wrote `color: KIND_TOKEN[e.kind]` over a map
   * whose values were raw hues, so the scan above saw the literal text
   * `KIND_TOKEN[e.kind]` and passed — while the panel painted every event's
   * state in a colour measuring 1.80:1 on daylight. A table of colours is the
   * natural shape for this and the natural place for the bug to hide (it is
   * also how the grid's pill held its own drifted table until #221), so a
   * `color` that names an identifier is followed to that identifier's map.
   *
   * Deliberately one hop and same-file only: two would need a module graph,
   * and the point is to close the shape that has actually bitten twice, not to
   * write a type checker.
   */
  const mapValues = (src: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)[^=\n]*=\s*\{([^}]*)\}/g)) {
      out[m[1]] = m[2];
    }
    return out;
  };

  it.each(sources)('%s writes no word in a raw status hue', (_name, src) => {
    const maps = mapValues(src);
    const offenders = colorValues(src)
      .flatMap((v) => {
        const hop = /^([A-Za-z_$][\w$]*)\s*\[/.exec(v.trim());
        return hop && maps[hop[1]] !== undefined ? [v, `${v} -> ${maps[hop[1]]}`] : [v];
      })
      .filter((v) => STATUS_TOKENS.some((t) => v.includes(`var(--status-${t})`)))
      .map((v) => v.trim());
    expect(
      offenders,
      // no `#nnn` in the message: the no-raw-hex lint rule reads an issue
      // number as a three-digit colour, which is a funny way to fail a
      // contrast test and a real one
      'use var(--status-<x>-ink) for text — the hue is for dots, rings, tints and edges'
    ).toEqual([]);
  });

  /**
   * ...and the same rule for a §5.11 ACCENT (#269).
   *
   * Same shape, different vocabulary: `--status-<x>` has an ink to reach for
   * instead, an accent does not and never will, so the rule is simply that an
   * accent is a FIELD — a dot, a stripe, a ring, a badge's background — and
   * never a `color:`. That is what the card header's badge did (`color:
   * live.accent`), at 1.80-3.11:1 on daylight for all eight.
   *
   * Matched by NAME, not by value, and that is the whole reason this lives here
   * rather than in the painted e2e sweep: four of the eight accents are
   * byte-identical to a status hue, and a session's accent reaches the renderer
   * as a raw hex from the main process, so on screen there is nothing to tell
   * `--accent-blue` from `--status-working`. In the SOURCE there is — the
   * property is spelled `accent`.
   *
   * Both spellings count: `var(--accent-*)` for a stylesheet, and any value
   * naming an `accent` identifier for the inline styles the badge is written in.
   * The one exemption is the ink that sits ON a field, which has to be allowed
   * to be a `color:` because being one is its entire job.
   *
   * SAME BLIND SPOT as the hop above, and it is worth naming: `color: ink`,
   * where a local holds the token, reads as innocent here. `identityBadgeStyle`
   * is written that way on purpose (a ternary inside the declaration would read
   * as an offender), so its half of the promise is held by IdentityChip.test.tsx
   * and by the painted badge test in e2e/theme.spec.ts, which measures both
   * render sites in all four themes against what is really behind them.
   */
  const accented = (src: string): string[] =>
    colorValues(src)
      .map((v) => v.split(`var(${ACCENT_INK})`).join('').trim())
      .filter((v) => /\baccent\b/i.test(v));

  it.each(sources)('%s writes no word in an identity accent', (_name, src) => {
    expect(
      accented(src),
      'an accent is a field — a dot, a stripe, a badge background. Words on one ' +
        'take the neutral on-field ink instead'
    ).toEqual([]);
  });

  it('sees the defect it is named for', () => {
    // the guard's own guard: an empty scan (a regex that matches nothing, a
    // file walk that finds no files) passes every case above, silently
    expect(sources.length).toBeGreaterThan(20);
    expect(colorValues("  color: 'var(--status-crashed)',\n")).toEqual([
      "'var(--status-crashed)'",
    ]);
    // and does not flag the fix, an edge, or a nested property
    expect(colorValues('  color: var(--status-crashed-ink);\n')[0]).not.toContain(
      'var(--status-crashed)'
    );
    expect(colorValues('  border-color: var(--status-crashed);\n')).toEqual([]);
    expect(colorValues("  borderColor: 'var(--status-crashed)',\n")).toEqual([]);
    // a value whose own commas are inside parens survives the cut — before
    // this, `color: color-mix(in srgb, <hue> …)` was truncated at "in srgb"
    // and the hue behind it was never looked at
    expect(colorValues('  color: color-mix(in srgb, var(--status-done) 60%, transparent);\n')[0])
      .toContain('var(--status-done)');
    // and the hop the events panel hid behind is followed
    expect(
      mapValues("const T: Record<string, string> = {\n  a: 'var(--status-done)',\n};\n").T
    ).toContain('var(--status-done)');

    // The accent half (#269): the exact declaration the card header shipped,
    // the stylesheet spelling of the same mistake, and the two things that are
    // NOT the mistake — an accent as a FIELD, and the ink that sits on one.
    // Through the SHARED `accented`, not a copy of it: a private copy here would
    // report the scan healthy while the real filter had been loosened.
    expect(accented("  color: live.accent ?? 'var(--muted)',\n")).toHaveLength(1);
    expect(accented('  color: var(--accent-pink);\n')).toHaveLength(1);
    expect(accented('  background: var(--accent-pink);\n')).toEqual([]);
    expect(accented(`  color: 'var(${ACCENT_INK})',\n`)).toEqual([]);
  });
});

// --- "A notice keeps its height" moved out (#274) ----------------------------
//
// #241 pinned `.preflight-banner`'s `flex-shrink: 0` here, because a rule in
// tokens.css is the only witness a CSS-styled notice has. That assertion now
// lives in `src/renderer/src/always-visible-notices.test.ts`, alongside the
// five other always-visible bars — whose guards are INLINE styles, so this
// file could never have held them. One roster for the whole class, plus a scan
// of App.tsx that fails when a new child of the shell column is added without
// being classified. Nothing about the mechanism changed; only where the list
// of them lives.
