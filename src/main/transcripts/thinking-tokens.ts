// `message.usage.output_tokens_details.thinking_tokens`: how much of a turn's
// OUTPUT was the model thinking before it answered (#789).
//
// ⚠️ A BREAKDOWN OF `output_tokens`, NEVER A QUANTITY TO ADD ON TOP. Measured,
// not reasoned (#779, `spike/probes/779/usage-details.mjs`): over 42,071 lines
// carrying it, 25,908 of them with `thinking_tokens > 0`, it exceeded
// `output_tokens` zero times, with a maximum ratio of 0.9928. Re-measured for
// #789 on 2026-09-15 through CLI 2.1.270: 48,588 lines, 0 violations, maximum
// 0.9964. The CLI's own aggregator agrees by construction — it adds
// `output_tokens` to a running total and tracks `thinking_tokens` in a separate
// field. Adding it to our output total would inflate every number the card
// shows and turn nothing red.
//
// PER LINE, AGAINST THE SAME LINE'S `output_tokens`. The watcher adds this to
// its thinking total on exactly the lines, and at exactly the place, it adds
// `output_tokens` to its output total. That keeps each LINE's thinking inside
// that line's output. It does NOT by itself make the session totals safe: the
// watcher adds `output_tokens` without validating it, so a hostile negative
// output would lower the output total and leave thinking where it was. The
// check the DISPLAY rests on is `thinkingPart` in the renderer, which re-tests
// `thinking <= output` on the totals.
//
// A line that breaks the subset contributes 0 rather than being clamped to its
// output: a clamp would render a confident "100% thinking" out of a line whose
// meaning has changed under us, while 0 keeps the figure a floor, which is the
// posture the cost estimate already takes.
//
// "Measured 0 violations" is a measurement, not a guarantee. What would falsify
// it is a line with `thinking_tokens > output_tokens`; this function is where
// such a line is refused, and `thinking-tokens.test.ts` is where that is pinned.
// A RENAME of `thinking_tokens` would make the figure vanish silently here, which
// is why `schema.ts` declares it as a consumed key and the drift detector warns.

/** A type guard, so one check both narrows and refuses NaN, Infinity and non-numbers. */
function finite(v: unknown): v is number {
  return Number.isFinite(v);
}

/** This line's thinking tokens, or 0 when it has none we can trust. */
export function thinkingTokensOf(usage: Record<string, unknown>): number {
  const out = usage.output_tokens;
  const details = usage.output_tokens_details;
  if (typeof out !== 'number' || typeof details !== 'object' || details === null) return 0;
  const t = (details as Record<string, unknown>).thinking_tokens;
  if (!finite(t) || t < 0 || t > out) return 0;
  return t;
}
