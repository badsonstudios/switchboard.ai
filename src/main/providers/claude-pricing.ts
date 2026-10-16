// Claude's price list, behind the Claude provider (E40 item 05, #1288;
// AR-P2-12). This is the `usage` capability's Claude implementation.
//
// It lived in the RENDERER (`renderer/src/lib/usage.ts`) until #1288, which was
// the wrong layer twice over: pricing is a fact about one AI, not about the
// screen, and the renderer's table answered for every model it did not know
// with Sonnet's rates — a confident number nobody reported (DESIGN §5.13: "an
// unknown version must show tokens with NO cost"). Here, a model this table
// does not recognise has no price, and the screen says so.
//
// The subscription-first framing still holds: the token counts are the real
// signal, and the dollar figure is there to give them a scale. The user is not
// billed per token on a subscription.
import type { UsageTokens } from '../../shared/usage-report';
import { isZeroUsage } from '../../shared/usage-report';

/**
 * USD per million tokens.
 *
 * ⚠️ MEASURED AGAINST THE CLI'S OWN LEDGER (#787), because the previous table
 * was wrong by more than a factor of two in BOTH directions and nothing caught
 * it for months: Opus was priced at $15/$75 (it is $5/$25), so every Opus
 * session over-reported by 2.0–2.8×, and Fable had no row at all, so it fell
 * through to sonnet-class $3/$15 and under-reported by 2.6–3.0×.
 *
 * The control that says the method is sound rather than the arithmetic: a real
 * haiku session with no web searches reconciles against the CLI's own
 * `costUSD` at ratio **1.0000** — see the reconciliation test, which pins the
 * measured token counts so a future rate edit that breaks it fails CI.
 */
export interface Rate {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

// Order matters: `fable`/`mythos` must be tested before the generic families,
// and `opus` before anything that could also match it.
const RATES: ReadonlyArray<{ match: RegExp; rate: Rate }> = [
  { match: /fable|mythos/i, rate: { input: 10, output: 50, cacheRead: 0.25, cacheCreate: 12.5 } },
  { match: /opus/i, rate: { input: 5, output: 25, cacheRead: 0.5, cacheCreate: 6.25 } },
  { match: /haiku/i, rate: { input: 1, output: 5, cacheRead: 0.1, cacheCreate: 1.25 } },
  { match: /sonnet/i, rate: { input: 2, output: 10, cacheRead: 0.2, cacheCreate: 2.5 } },
];

/**
 * The rate for a model id, by family, or `undefined` for a model this table
 * does not know.
 *
 * THERE IS NO DEFAULT ROW, and that is the #1288 fix. The renderer's copy fell
 * back to Sonnet, so a model released next month — or `<synthetic>`, or a
 * Bedrock id spelled some way we have not seen — was priced as Sonnet and shown
 * with the same `~` as a real estimate.
 *
 * Known gap, recorded in DESIGN §5.13 for E26: this matches FAMILIES, so a new
 * numeric version of a known family is priced at the family's current rate.
 * §5.13 asks for that to be refused too; doing it needs a version table, and a
 * missing row there would take the price off sessions that have one today.
 */
export function claudeRateForModel(model?: string): Rate | undefined {
  if (!model) return undefined;
  for (const r of RATES) if (r.match.test(model)) return r.rate;
  return undefined;
}

/**
 * Estimated USD for the accumulated usage, or `undefined` when there is no
 * honest price for it.
 *
 * ALWAYS A FLOOR, never a total, and that is a property of the INPUTS rather
 * than of the table (#787). Two things are missing from them, both measured:
 *
 *  - **Cache-write TTL.** Cache writes are billed at two rates depending on
 *    TTL (`ephemeral_5m` / `ephemeral_1h` — DESIGN §5.13) and the transcript
 *    does not break the two apart, so every one is priced at the cheaper 5m
 *    rate. Measured residual against the CLI's own number: Opus 0.91–0.97,
 *    Fable 0.79–0.86, always under.
 *  - **Web searches.** They bill at exactly $0.01 each (measured: four haiku
 *    sessions reconcile to the cent once the requests are added), but the
 *    token totals do not count them, so there is deliberately no rate row for
 *    them here — a rate nothing can bill is a comment pretending to be code.
 *    The reconciliation test prices them explicitly, which is the one place
 *    the number is load-bearing.
 *
 * Zero tokens are exactly $0 whatever the model, so a session that has not
 * spoken yet is not "unpriced" merely because no model line has arrived.
 *
 * `thinking` is never priced: it is a part of `output`, already counted.
 */
export function claudeEstimateCostUsd(u: UsageTokens, model?: string): number | undefined {
  if (isZeroUsage(u)) return 0;
  const r = claudeRateForModel(model);
  if (!r) return undefined;
  return (
    (u.input * r.input +
      u.output * r.output +
      u.cacheRead * r.cacheRead +
      u.cacheCreate * r.cacheCreate) /
    1_000_000
  );
}
