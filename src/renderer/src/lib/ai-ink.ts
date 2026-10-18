// Which colour an AI's icon is drawn in (#1326).
//
// Each catalog AI has a per-theme ink, `--ai-<catalog id>-ink` (tokens.css,
// the `ai-ink` group in theme/tokens.ts), measured against every surface the
// badge sits on by tokens.drift.test.ts. This is the ONE place a catalog id
// becomes that token's name, so the badge, the status bar, the AI switch and
// Settings > AIs cannot spell it four ways.
//
// FAIL-OPEN: the reference carries its own fallback, `--text`, so an id with
// no token (a catalog entry added by a registry refresh after this build, say)
// is drawn in the ordinary text colour rather than in nothing. An id that is
// not a plain slug is not turned into CSS at all.

/** the neutral ink: what an AI with no colour of its own is drawn in */
export const NEUTRAL_AI_INK = 'var(--text)';

/** the token name for a catalog id, or `undefined` when the id is not a slug */
export function aiInkToken(catalogId: string | undefined): string | undefined {
  if (!catalogId || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(catalogId)) return undefined;
  return `--ai-${catalogId}-ink`;
}

/** the CSS colour to paint a catalog AI's icon in, falling back to `--text` */
export function aiInk(catalogId: string | undefined): string {
  const token = aiInkToken(catalogId);
  return token ? `var(${token}, ${NEUTRAL_AI_INK})` : NEUTRAL_AI_INK;
}
