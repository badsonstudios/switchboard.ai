// Usage/cost helpers for the session card (P2-E7-01, #787). Subscription-first:
// the exact token counts are the real signal, and the dollar figure is there to
// give them a scale — the user is not billed per token on a subscription.
//
// TWO SOURCES, AND THE UI SAYS WHICH (#787). While a session runs there is only
// our estimate. When it ENDS the CLI writes its own accounting into the
// transcript and that number supersedes ours. `costLine` is the single place
// that chooses, so no caller has to re-derive the honesty rules.

import type { CliCost, CliModelCost } from '../../../shared/transcripts';

export type { CliCost, CliModelCost };

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

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
interface Rate {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

// Order matters: `fable`/`mythos` must be tested before the generic families,
// and `opus` before anything that could also match it.
const RATES: Array<{ match: RegExp; rate: Rate }> = [
  { match: /fable|mythos/i, rate: { input: 10, output: 50, cacheRead: 0.25, cacheCreate: 12.5 } },
  { match: /opus/i, rate: { input: 5, output: 25, cacheRead: 0.5, cacheCreate: 6.25 } },
  { match: /haiku/i, rate: { input: 1, output: 5, cacheRead: 0.1, cacheCreate: 1.25 } },
  { match: /sonnet/i, rate: { input: 2, output: 10, cacheRead: 0.2, cacheCreate: 2.5 } },
];
/** Sonnet-class, for a model id we do not recognise. */
const DEFAULT_RATE: Rate = RATES[3].rate;

export function rateForModel(model?: string): Rate {
  if (model) for (const r of RATES) if (r.match.test(model)) return r.rate;
  return DEFAULT_RATE;
}

/**
 * Estimated USD for the accumulated usage.
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
 *    sessions reconcile to the cent once the requests are added), but
 *    `Usage` does not count them, so there is deliberately no rate row for
 *    them here — a rate nothing can bill is a comment pretending to be code.
 *    The reconciliation test prices them explicitly, which is the one place
 *    the number is load-bearing.
 *
 * `costLine` labels the result as a floor for these reasons; do not quietly
 * present it as a total.
 */
export function estimateCostUsd(u: Usage, model?: string): number {
  const r = rateForModel(model);
  return (
    (u.input * r.input +
      u.output * r.output +
      u.cacheRead * r.cacheRead +
      u.cacheCreate * r.cacheCreate) /
    1_000_000
  );
}

/** Compact token count: 942 → "942", 12_300 → "12.3k", 1_240_000 → "1.24M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatUsd(n: number): string {
  // Zero is EXACT and gets said exactly. `<$0.01` is an honest hedge about a
  // number we worked out and rounded; it is a lie about one we know to be nil,
  // and the CLI reports a true `totalCostUSD: 0` for any session that never
  // reached the API. Worse in combination: `costLine`'s floor marker made that
  // read `≥<$0.01` — "at least less than a cent". It also cleans up a fresh
  // card, which showed `~<$0.01` beside three zeroed token counts.
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreate: a.cacheCreate + b.cacheCreate,
  };
}

export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

/**
 * What the card should actually show for cost, and how honest it can be about
 * it (#787).
 *
 * - `source: 'cli'` — the CLI's own `totalCostUSD`, read from a `cost-state`
 *   line. Only ever available once the session has ended (or been `/clear`ed);
 *   see `main/transcripts/cost-state.ts` for why.
 * - `source: 'estimate'` — ours, from the rate table.
 *
 * `floor` means "at least this much, possibly more", and it is set for two
 * independent reasons, which is why it is a separate flag rather than folded
 * into `source`:
 *   - our estimate is structurally a floor (unbreakable cache-write TTL split);
 *   - the CLI's number is a floor when it says `hasUnknownModelCost: true` —
 *     it used a model it could not price, so its own total is short.
 *
 * ⚠️ `hasUnknownModelCost` HAS THREE STATES. The CLI's schema declares it
 * optional, so `undefined` means "this CLI did not say" — which is not the
 * same claim as `false`. An absent field is NOT treated as a clean bill of
 * health; it is treated as a definite number we cannot second-guess, the same
 * as `false`, but the distinction is preserved in `cliCost` for anything that
 * later needs it rather than being flattened here.
 */
export interface CostLine {
  /** Formatted for display, including any `~` / `≥` marker. */
  text: string;
  source: 'cli' | 'estimate';
  floor: boolean;
  /** The raw number, for callers that want to aggregate rather than render. */
  usd: number;
}

export function costLine(u: Usage, model?: string, cliCost?: CliCost): CostLine {
  // THE MONEY FIELD HAS TWO ENTRANCES AND THE PARSER ONLY GUARDS ONE (review).
  // `cost-state.ts` refuses a non-finite or negative total precisely so `$NaN`
  // cannot reach a card — but the OTHER way in is the persisted copy on the
  // card record, which comes back from `workspace.json` and is never re-parsed
  // (`isSaneSession` checks identity, not this). A truncated write or a
  // hand-edit would walk straight past. Re-asserting the parser's own contract
  // at the render boundary costs one condition and closes both doors; failing
  // it falls back to the estimate, which is the whole point of keeping one.
  if (cliCost && Number.isFinite(cliCost.totalCostUSD) && cliCost.totalCostUSD >= 0) {
    const floor = cliCost.hasUnknownModelCost === true;
    return {
      text: `${floor ? '≥' : ''}${formatUsd(cliCost.totalCostUSD)}`,
      source: 'cli',
      floor,
      usd: cliCost.totalCostUSD,
    };
  }
  const usd = estimateCostUsd(u, model);
  // `~` rather than `≥` even though the estimate IS a floor: `~` is what the
  // strip has always meant by "we worked this out", and `≥` is reserved for the
  // stronger, rarer claim that a DEFINITE number is known to be incomplete.
  // The tooltip carries the full story either way.
  return { text: `~${formatUsd(usd)}`, source: 'estimate', floor: true, usd };
}

/**
 * The workspace-wide total for the status bar.
 *
 * A function rather than three lines inlined in `App.tsx`, because inlined is
 * where it went wrong: the status bar summed `estimateCostUsd` directly and
 * dropped `cliCost` on the floor, so a session whose own card showed Claude
 * Code's exact figure still contributed our guess to the total — the one caller
 * re-deriving the choice this module claims to own. Here it is reachable by a
 * test, which is the difference between the claim being true and being hoped
 * for.
 *
 * The status-bar label stays "est", honestly: the total mixes exact figures with
 * estimates, and every estimate in it is a floor.
 */
export function sumCostUsd(
  entries: Iterable<{ usage: Usage; model?: string; cliCost?: CliCost }>
): number {
  let total = 0;
  for (const e of entries) total += costLine(e.usage, e.model, e.cliCost).usd;
  return total;
}
