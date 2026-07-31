// Themes as contributions (§5.20 + §5.23, P2-E15-05).
//
// Thin on purpose: the themes themselves are data in theme/builtin-themes.ts,
// and this file only says how they enter the registry. The picker and the
// status bar list from here, so "which themes exist" has one answer and adding
// a fourth is a file plus a line — never an edit to a component.
import { manifestFor, ThemeContribution } from './contributions';
import { RendererRegistry } from './registry-instance';
import { builtinThemes } from '../theme/builtin-themes';
import type { ThemeDefinition } from '../theme/theme';

/**
 * 'system' is the absence of a choice, not a theme — the picker renders it
 * itself and `resolveTheme` short-circuits on it, so a theme claiming that id
 * would be selectable and unpaintable at the same time.
 */
export const RESERVED_THEME_IDS: readonly string[] = ['system'];

/** Every registered theme, in picker order — the ONE definition of that rule. */
export function listThemes(registry: RendererRegistry): ThemeDefinition[] {
  return [...registry.list('theme')]
    .sort((a, b) => a.order - b.order)
    .map((c) => c.theme)
    .filter((t) => {
      if (!RESERVED_THEME_IDS.includes(t.id)) return true;
      // loudly: a theme that simply vanished from the picker is a bug report
      // its author cannot write
      console.warn(`theme "${t.id}": that id is reserved — not offered`);
      return false;
    });
}

// A duplicate id THROWS at registration (the registry dedupes by manifest id),
// which is right for built-ins — fail fast, at the entry point, on our own bug.
// The day a third-party theme can register, that throw is in the boot path with
// no error boundary above it and needs catching there, not here.
export const themeContributions: ThemeContribution[] = builtinThemes.map((theme, i) => ({
  manifest: manifestFor(`theme-${theme.id}`, theme.id, 'theme.contribute'),
  // 10, 20, 30 — room to slot a theme between two built-ins without renumbering
  order: (i + 1) * 10,
  theme,
}));
