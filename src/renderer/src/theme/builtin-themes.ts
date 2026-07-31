// The themes that ship (§5.20, P2-E15-05).
//
// nordic and daylight are the tokens.css presets, so their maps are EMPTY —
// they are the base, not an overlay on it. high-contrast is the one that has
// to prove the mechanism: it is a JSON file, authored with no code change, and
// if adding it had needed an edit anywhere but this list the map would be
// decoration.
import type { ThemeDefinition } from './theme';
import highContrast from './themes/high-contrast.json';
import softContrast from './themes/soft-contrast.json';

/**
 * Keep the token keys, drop the metadata.
 *
 * A theme file is allowed to carry `$comment` and friends — JSON has no
 * comments and a palette nobody can annotate is a palette nobody will edit —
 * so the loader takes `--*` and leaves the rest. Unknown `--tokens` still
 * reach the applier, which warns: a typo'd token is a mistake, a `$comment`
 * is not.
 */
export function tokensFromJson(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith('--')) continue;
    if (typeof v !== 'string') {
      // symmetry with the applier, which warns about an unknown NAME: a
      // `"--bg": 0` that vanishes without a word is the same author error
      console.warn(`theme token ${k}: expected a string, got ${typeof v} — ignored`);
      continue;
    }
    out[k] = v;
  }
  return out;
}

export const builtinThemes: readonly ThemeDefinition[] = [
  {
    id: 'nordic',
    nameKey: 'theme.nordic',
    base: 'nordic',
    colorScheme: 'dark',
    systemDefault: 'dark',
    tokens: {},
  },
  {
    id: 'daylight',
    nameKey: 'theme.daylight',
    base: 'daylight',
    colorScheme: 'light',
    systemDefault: 'light',
    tokens: {},
  },
  {
    id: 'high-contrast',
    nameKey: 'theme.high-contrast',
    // built on the dark preset: anything the file omits stays dark rather than
    // landing on a light value, so a gap degrades to "less contrast than
    // intended" instead of "white text on white"
    base: 'nordic',
    colorScheme: 'dark',
    // deliberately NOT a systemDefault: `prefers-contrast` is the OS signal for
    // this one, and honouring it is its own decision (§5.20 OS sync), not a
    // side effect of shipping the theme
    tokens: tokensFromJson(highContrast as Record<string, unknown>),
  },
  {
    // Added 2026-07-31, and it is the proof this design works: one entry here
    // and one string in en.json — no code path, no branch, no component
    // touched. The old two-value union could not have held it at all.
    id: 'soft-contrast',
    nameKey: 'theme.soft-contrast',
    base: 'nordic',
    colorScheme: 'dark',
    tokens: tokensFromJson(softContrast as Record<string, unknown>),
  },
];
