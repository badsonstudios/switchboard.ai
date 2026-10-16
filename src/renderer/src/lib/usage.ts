// Usage/cost helpers for the session card (P2-E7-01, #787). Subscription-first:
// the token counts are the real signal, and the dollar figure is there to
// give them a scale — the user is not billed per token on a subscription.
//
// TWO SOURCES, AND THE UI SAYS WHICH (#787). While a session runs there is only
// an estimate. When it ENDS the CLI writes its own accounting into the
// transcript and that number supersedes it. `costLine` is the single place
// that chooses, so no caller has to re-derive the honesty rules.
//
// NO PRICE LIST LIVES HERE ANY MORE (#1288, AR-P2-12). The estimate is the
// PROVIDER's, worked out in main (`ProviderCapabilities.usage`; Claude's table
// is `main/providers/claude-pricing.ts`) and handed over as `estimateUsd`. This
// file used to hold one table for every AI and price an unknown model as
// Sonnet. Now an absent `estimateUsd` means "no price", and every function
// below keeps that meaning: never zero, never somebody else's rate.

import type { CliCost, CliModelCost } from '../../../shared/transcripts';
import { isZeroUsage } from '../../../shared/usage-report';

export type { CliCost, CliModelCost };

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /**
   * The part of `output` the model spent thinking (#789) — INSIDE `output`,
   * never on top of it, and never priced separately.
   *
   * OPTIONAL because the persisted copy is a second entrance: every
   * `workspace.json` written before #789 lacks it. Read it through
   * `thinkingPart`, which treats absent, zero and invalid alike.
   */
  thinking?: number;
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

// `thinking` is deliberately NOT summed: nothing shows a workspace-wide thinking
// total (#789). Add it here before anything does, or that total reads nothing.
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
 * How much of a session's output was thinking, or `null` when there is nothing
 * honest to show (#789).
 *
 * THIS is the check the display rests on — not the watcher. The watcher keeps
 * each line's thinking inside that line's output, but it adds `output_tokens`
 * without validating it, so the totals are not safe by construction. And the
 * card record comes back from `workspace.json` and is never re-parsed, the same
 * second entrance `costLine` guards. A figure that claims more thinking than
 * output is the one inversion this breakdown must never show, so it shows
 * nothing instead.
 *
 * Absent, `0` and invalid all come out `null` — none of them is something to
 * put on the card, and the difference between them is not the user's problem.
 */
export function thinkingPart(u: Usage): { tokens: number; pct: number } | null {
  const t = u.thinking;
  // `!(t <= output)`, not `t > output`: against a NaN output both comparisons
  // are false, and only the negated form refuses it. The same negation refuses a
  // NaN or Infinite `t` against a finite output, so there is deliberately no
  // `Number.isFinite` here: it would differ only when BOTH are Infinity, which
  // `workspace.json` cannot hold (`JSON.stringify` writes Infinity as `null`).
  if (typeof t !== 'number' || t <= 0 || !(t <= u.output)) return null;
  // 1–99 unless EXACT. Plain rounding said "100% of the output was thinking" at
  // 99.6%, beside an output figure visibly larger than the thinking one, and
  // "0%" beside a figure that is plainly not nothing.
  const pct = t === u.output ? 100 : Math.min(99, Math.max(1, Math.round((t / u.output) * 100)));
  return { tokens: t, pct };
}


/**
 * The provider's estimate, if it is one we can show.
 *
 * `estimateUsd` crosses IPC from main, and the card's copy also comes back from
 * `workspace.json`, which is never re-parsed — the same second entrance the CLI
 * figure has (see `costLine`). A value that is not a finite, non-negative
 * number is no price, not a broken one.
 */
function shownEstimate(estimateUsd: unknown): number | undefined {
  return typeof estimateUsd === 'number' && Number.isFinite(estimateUsd) && estimateUsd >= 0
    ? estimateUsd
    : undefined;
}

/**
 * What the card should actually show for cost, and how honest it can be about
 * it (#787, #1288).
 *
 * - `source: 'cli'` — the CLI's own `totalCostUSD`, read from a `cost-state`
 *   line. Only ever available once the session has ended (or been `/clear`ed);
 *   see `main/transcripts/cost-state.ts` for why.
 * - `source: 'estimate'` — the provider's, from its own price list in main.
 * - `source: 'none'` — NO PRICE (#1288). The provider has no price list, or
 *   does not know this model. `usd` is `undefined` and the text is a dash;
 *   nothing downstream may turn that into a number.
 *
 * `floor` means "at least this much, possibly more", and it is set for two
 * independent reasons, which is why it is a separate flag rather than folded
 * into `source`:
 *   - an estimate is structurally a floor (unbreakable cache-write TTL split);
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
  /** Formatted for display, including any `~` / `≥` marker, or `—` for no price. */
  text: string;
  source: 'cli' | 'estimate' | 'none';
  floor: boolean;
  /** The raw number, for callers that want to aggregate; `undefined` = no price. */
  usd: number | undefined;
}

export function costLine(u: Usage, estimateUsd?: number, cliCost?: CliCost): CostLine {
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
  const usd = shownEstimate(estimateUsd);
  // Zero tokens cost exactly zero on ANY price list, so a session that has not
  // spoken yet and has no estimate shows `$0.00` rather than "no price". No
  // `~`: nothing was worked out, the zero is exact (`formatUsd`'s rule). A
  // provider that DID price it (Claude prices zero tokens at 0) still reads
  // `~$0.00`, as before #1288.
  if (usd === undefined && isZeroUsage(u)) {
    return { text: formatUsd(0), source: 'estimate', floor: false, usd: 0 };
  }
  if (usd === undefined) return { text: '—', source: 'none', floor: false, usd: undefined };
  // `~` rather than `≥` even though the estimate IS a floor: `~` is what the
  // strip has always meant by "we worked this out", and `≥` is reserved for the
  // stronger, rarer claim that a DEFINITE number is known to be incomplete.
  // The tooltip carries the full story either way.
  return { text: `~${formatUsd(usd)}`, source: 'estimate', floor: true, usd };
}

/** The status bar's total, and how much of the workspace it could not price. */
export interface CostTotal {
  /** the sum over every session that HAS a price */
  usd: number;
  /** sessions with tokens and no price: they are not in `usd`, at any rate */
  unpriced: number;
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
 * A SESSION WITH NO PRICE IS COUNTED, NOT PRICED (#1288). It adds nothing to
 * `usd` and one to `unpriced`, so the bar can say the total is short rather
 * than present a partial sum as the whole. Before #1288 it added a Sonnet-rate
 * guess.
 *
 * The status-bar label stays "est", honestly: the total mixes exact figures with
 * estimates, and every estimate in it is a floor.
 */
export function sumCostUsd(
  entries: Iterable<{ usage: Usage; estimateUsd?: number; cliCost?: CliCost }>
): CostTotal {
  let usd = 0;
  let unpriced = 0;
  for (const e of entries) {
    const line = costLine(e.usage, e.estimateUsd, e.cliCost);
    if (line.usd === undefined) unpriced += 1;
    else usd += line.usd;
  }
  return { usd, unpriced };
}
