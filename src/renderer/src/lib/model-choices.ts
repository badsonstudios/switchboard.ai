// The model list's shared rules (#747), extracted from `ModelPickerDialog`.
//
// TWO surfaces now render the CLI's `list_models` answer: the picker dialog
// (#721/#746 — select, then OK) and the footer chip's quick menu (#747 — one
// click, no OK). They differ in their COMMIT semantics and in nothing else:
// the same rows, the same subtitles, the same one-row-is-ticked arithmetic.
//
// It lives here rather than being copied because `currentIndex` in particular
// is a rule that is easy to get wrong and invisible when you do — it took a
// captured payload and a bug to arrive at, and a second hand-written copy would
// diverge from it silently. #747 says so explicitly: "Don't re-derive that;
// extract and share."

import type { CliModel } from '../../../shared/stream-protocol';
import type { ControlVerdict } from '../../../shared/control';

/**
 * The verdict's failure, in words a person can act on.
 *
 * `refused` passes the CLI's OWN SENTENCE through untouched — it is written for
 * a human ("Model \"x\" is not a recognized model id. Run /model to see
 * available models."), and ours would be a guess at what it meant. Same call
 * `mcp/cli.ts` made, for the same reason.
 *
 * Pure, so the mapping is unit-tested rather than asserted through a rendered
 * tree — and so both surfaces say the same thing about the same failure.
 */
export function failureText(
  v: Extract<ControlVerdict, { ok: false }>,
  t: (k: string) => string
): string {
  if (v.reason === 'refused' && v.message) return v.message;
  if (v.reason === 'not-stream') return t('model.notStream');
  if (v.reason === 'session-gone') return t('model.sessionGone');
  if (v.reason === 'timed-out') return t('model.timedOut');
  return t('model.failed');
}

/** What a row says under the name. Never empty — the id is the honest fallback. */
export function rowSubtitle(m: CliModel): string {
  return m.description ?? m.resolvedModel ?? m.value;
}

/** What a row is CALLED. The alias is the fallback — every entry has one. */
export function modelLabel(m: CliModel): string {
  return m.displayName ?? m.value;
}

/**
 * WHICH ONE ROW is the session running — an index, or `-1`.
 *
 * MATCHED ON TWO FIELDS, because the two sides speak different dialects:
 * `system:init.model` reports a RESOLVED id (`claude-haiku-4-5-20251001`) while
 * the list's `value` is the alias you set (`haiku`). Matching only `value`
 * would leave a session with nothing ticked the moment the CLI resolved an
 * alias — which is always.
 *
 * ⚠️ AN INDEX RATHER THAN A PER-ROW PREDICATE, AND THAT IS NOT STYLE. **Two
 * rows in the real payload share a `resolvedModel`**: `default` and `opus[1m]`
 * both resolve to `claude-opus-5[1m]` (captured, 2.1.245). A per-row test
 * therefore ticked BOTH of them for anyone on the default model — which is the
 * default setup — and put two `aria-checked` radios in one radiogroup, which is
 * invalid as well as wrong. Resolving once, here, is what makes "the current
 * one" singular.
 *
 * EXACT `value` WINS over a resolved match, so a session that was switched to
 * `opus[1m]` ticks `opus[1m]` rather than the `default` row that happens to
 * resolve the same way. Only when nothing matches by alias do we fall back to
 * the first resolved match — which is `default`, the right answer for a session
 * that never chose.
 *
 * `null` current means "not known yet" and must tick NOTHING — the CLI reports
 * the running model only on `system:init`, once per TURN, so a session that has
 * not replied has genuinely never said. Ticking `default` there would be
 * inventing the one fact these surfaces exist to report.
 */
export function currentIndex(models: readonly CliModel[], current: string | null): number {
  if (!current) return -1;
  const exact = models.findIndex((m) => m.value === current);
  if (exact >= 0) return exact;
  return models.findIndex((m) => m.resolvedModel === current);
}
