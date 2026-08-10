// The themeable tokens, ENUMERATED (§5.20, P2-E15-05).
//
// A theme is a token map, so something has to say which tokens a map may
// contain. This list is that answer, and it is the same list the future theme
// editor and the `theme` contribution point need — "override --panel" is not a
// feature anyone can use until the names are discoverable.
//
// tokens.css remains the ONLY place raw colors live in the app's CODE; this
// file names tokens and never values. `tokens.drift.test.ts` parses tokens.css
// and fails if the two drift apart, which is what keeps the list honest.
//
// WHAT IS DELIBERATELY NOT HERE:
//  - session accent colors (`--accent-*`) — §5.20: identities are separate from
//    themes and survive a theme switch. A theme that could repaint them would
//    change what a session IS, not how the app looks.
//  - `--accent-ink-on-fill`, the ink the §5.11 badge writes ON one of those
//    accents (#269). Note this is the OPPOSITE call from
//    `--status-needs-permission-ink-on-fill` below, which IS themeable, and the
//    difference is which side of the pair a theme controls: that ink sits on a
//    themeable fill, so a theme repainting the fill must be able to lift the ink
//    with it. An accent field is theme-independent, so a theme that could lift
//    this ink could only break a promise about a colour it may not touch.
//  - typography, radii and spacing — colors are what a theme is for today;
//    widening the map later is additive and does not break a stored theme.
//  - layer-3 component tokens (`--card-bg`, `--auto-surface`, …) — they are
//    derived from the layers above, so overriding one is how you get a card
//    that disagrees with its own panel.

/** A group of tokens, for a picker that has to show 42 of them to a human. */
export interface TokenGroup {
  id: string;
  /**
   * 1 = the theme map proper (tokens.css declares these per `[data-theme]`
   * preset); 2 = semantic tokens `:root` declares once. A theme MAY override
   * layer 2 — a high-contrast theme that cannot touch the status hues is
   * decoration — but it inherits them when it says nothing.
   */
  layer: 1 | 2;
  /**
   * What kind of value belongs here, and it is not documentation.
   *
   * A shadow token is CONCATENATED into a shorthand list at some call sites
   * (`box-shadow: 0 0 0 2px <accent>, var(--group-lift)` in SessionsRail) —
   * and `none` is a whole-property keyword, not a list item, so a theme
   * setting `--group-lift: none` makes that declaration INVALID and the
   * browser drops all of it, ring included. The theme that most needs the ring
   * would be the one to lose it. `tokens.drift.test.ts` enforces the rule; a
   * transparent shadow (`0 0 #0000`) is how a theme says "no lift".
   */
  kind: 'color' | 'shadow';
  tokens: readonly string[];
}

export const TOKEN_GROUPS: readonly TokenGroup[] = [
  {
    id: 'surface',
    layer: 1,
    kind: 'color',
    tokens: ['--bg', '--panel', '--panel2', '--border', '--group-frame', '--chip', '--bar', '--scrim'],
  },
  {
    id: 'elevation',
    layer: 1,
    kind: 'shadow',
    tokens: ['--group-lift', '--window-shadow', '--tab-lift'],
  },
  {
    id: 'text',
    layer: 1,
    kind: 'color',
    tokens: ['--text', '--muted', '--faint', '--term'],
  },
  {
    id: 'status-ink',
    layer: 1,
    kind: 'color',
    tokens: [
      '--status-working-ink',
      '--status-needs-input-ink',
      '--status-needs-permission-ink',
      '--status-idle-ink',
      '--status-done-ink',
      '--status-crashed-ink',
    ],
  },
  {
    id: 'rail',
    layer: 1,
    kind: 'color',
    tokens: [
      '--rail-canvas',
      '--rail-card',
      '--rail-row-hover',
      '--rail-divider',
      '--rail-close',
      '--rail-close-hover',
      '--auto-ink',
    ],
  },
  {
    id: 'status',
    layer: 2,
    kind: 'color',
    tokens: [
      '--status-working',
      '--status-needs-input',
      '--status-needs-permission',
      '--status-idle',
      '--status-done',
      '--status-crashed',
      // ink for words written ON the needs-permission fill (the preflight
      // banner) — themeable with the hue it sits on, because a theme that
      // repaints the fill has to be able to lift the ink with it (#206)
      '--status-needs-permission-ink-on-fill',
    ],
  },
  {
    id: 'diff',
    layer: 2,
    kind: 'color',
    tokens: ['--diff-added', '--diff-added-bg', '--diff-removed', '--diff-removed-bg'],
  },
  {
    id: 'controls',
    layer: 2,
    kind: 'color',
    tokens: ['--link', '--subagent', '--btn-primary-bg', '--btn-primary-text'],
  },
];

/** The tokens of one kind — the drift test validates each theme's values by it. */
export function tokensOfKind(kind: TokenGroup['kind']): string[] {
  return TOKEN_GROUPS.filter((g) => g.kind === kind).flatMap((g) => g.tokens);
}

/** Layer-1 tokens: what a `[data-theme]` preset in tokens.css declares. */
export const THEME_MAP_TOKENS: readonly string[] = TOKEN_GROUPS.filter((g) => g.layer === 1).flatMap(
  (g) => g.tokens
);

/** Layer-2 tokens a theme may override; inherited when it doesn't. */
export const SEMANTIC_TOKENS: readonly string[] = TOKEN_GROUPS.filter((g) => g.layer === 2).flatMap(
  (g) => g.tokens
);

/** Every token a theme map may set. */
export const THEME_TOKENS: readonly string[] = [...THEME_MAP_TOKENS, ...SEMANTIC_TOKENS];

/** Membership test — the applier runs it per token on every theme switch. */
const THEME_TOKEN_SET = new Set(THEME_TOKENS);
export function isThemeToken(name: string): boolean {
  return THEME_TOKEN_SET.has(name);
}
