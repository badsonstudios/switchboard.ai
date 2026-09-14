// `cost-state` lines: the CLI's OWN cost accounting for a session (#787).
//
// §5.13 estimates cost from token counts against a public rate table. These
// lines carry the CLI's own number for the same quantity, and it is the number
// the CLI itself would print. Reading it removes the estimate's two standing
// failure modes at once: a stale rate table, and anything the CLI charged for
// that we never modelled.
//
// ⚠️ IT IS AN EPITAPH, NOT A LIVE READOUT — MEASURED BOTH WAYS (#787).
//
// The CLI registers the builder on its EXIT path: `exitReStampProviders.add()`,
// drained by `appendOwedEntryAtExit`. The only other two call sites are the
// `conversation_reset` path (`/clear`) and the fork/resume path. There is no
// periodic writer. The corpus agrees: of 3,210 transcripts, 22 carry a
// `cost-state` line and in **22 of 22 it is the last line of the file**.
//
// So this supersedes the estimate when a session ENDS; it never replaces it
// while one is running. Anything built on top has to keep saying which of the
// two numbers it is showing — see `costLine` in the renderer.
//
// ⚠️ "LAST LINE OF THE FILE" IS A MEASUREMENT, NOT AN INVARIANT — and the first
// draft of this comment leaned on it as one. A **resumed** conversation appends
// to the same transcript, so the line stops being last the moment the session
// is reopened, and we replay that file from byte 0. `watcher.ts` therefore
// clears the figure again on the next usage-bearing line; read that code, not
// this sentence, for what is actually enforced.
//
// LAST-WINS, NEVER SUMMED. The CLI's own routing table says
// `"cost-state": "last-wins"`, and two lines in one transcript is real (both
// probe transcripts carry two, 108 ms apart, written as the session tore down).
// Summing them would double a session's reported cost.

// The TYPES live in `shared/transcripts.ts`, not here: the renderer is what
// has to choose between this number and our estimate. Re-exported so the
// parser and the shape it produces still read as one module.
import type { CliCost, CliModelCost } from '../../shared/transcripts';

export type { CliCost, CliModelCost };

/**
 * The CLI declares every numeric on this line as `nonnegative().finite()`. We
 * hold to the same contract rather than a looser one, because this number is
 * rendered as money: a `NaN` or a negative reaching the card is worse than
 * showing the estimate we already had.
 */
function num(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v;
}

function parseModelCost(v: unknown): CliModelCost | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const inputTokens = num(o.inputTokens);
  const outputTokens = num(o.outputTokens);
  const cacheReadInputTokens = num(o.cacheReadInputTokens);
  const cacheCreationInputTokens = num(o.cacheCreationInputTokens);
  const webSearchRequests = num(o.webSearchRequests);
  const costUSD = num(o.costUSD);
  if (
    inputTokens === null ||
    outputTokens === null ||
    cacheReadInputTokens === null ||
    cacheCreationInputTokens === null ||
    webSearchRequests === null ||
    costUSD === null
  ) {
    return null;
  }
  const out: CliModelCost = {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    webSearchRequests,
    costUSD,
  };
  // Optional in the CLI's schema. Absent stays absent; present must be valid.
  if (o.thinkingTokens !== undefined) {
    const t = num(o.thinkingTokens);
    if (t === null) return null;
    out.thinkingTokens = t;
  }
  return out;
}

/**
 * Parse one transcript entry as a `cost-state` line.
 *
 * Returns `null` for anything that is not one, or that is one but does not
 * hold to the CLI's contract — the caller counts that as malformed and keeps
 * whatever it had. There is deliberately no partial result: half a cost line
 * is not a cheaper cost line, it is a wrong one.
 */
export function parseCostState(entry: Record<string, unknown>): CliCost | null {
  if (entry.type !== 'cost-state') return null;
  const totalCostUSD = num(entry.totalCostUSD);
  const totalAPIDuration = num(entry.totalAPIDuration);
  const totalAPIDurationWithoutRetries = num(entry.totalAPIDurationWithoutRetries);
  const totalToolDuration = num(entry.totalToolDuration);
  const totalDuration = num(entry.totalDuration);
  const totalLinesAdded = num(entry.totalLinesAdded);
  const totalLinesRemoved = num(entry.totalLinesRemoved);
  const startTime = num(entry.startTime);
  if (
    totalCostUSD === null ||
    totalAPIDuration === null ||
    totalAPIDurationWithoutRetries === null ||
    totalToolDuration === null ||
    totalDuration === null ||
    totalLinesAdded === null ||
    totalLinesRemoved === null ||
    startTime === null
  ) {
    return null;
  }
  const mu = entry.modelUsage;
  if (typeof mu !== 'object' || mu === null || Array.isArray(mu)) return null;
  // `Object.create(null)`, not `{}`: `JSON.parse` makes `__proto__` an OWN
  // property, `Object.entries` yields it, and assigning it on an object literal
  // runs `Object.prototype`'s setter instead of adding a key — the row would
  // vanish, `modelUsage` would come out `{}`, and the file's own stated
  // invariant (`sum(costUSD) === totalCostUSD`) would break while
  // `totalCostUSD` still claimed the full amount. Theoretical given the CLI's
  // model-id regex, and a silent wrong answer is exactly what this file exists
  // to refuse.
  const modelUsage = Object.create(null) as Record<string, CliModelCost>;
  for (const [model, raw] of Object.entries(mu as Record<string, unknown>)) {
    const parsed = parseModelCost(raw);
    if (parsed === null) return null;
    modelUsage[model] = parsed;
  }
  const out: CliCost = {
    totalCostUSD,
    modelUsage,
    totalAPIDuration,
    totalAPIDurationWithoutRetries,
    totalToolDuration,
    totalDuration,
    totalLinesAdded,
    totalLinesRemoved,
    startTime,
  };
  if (entry.hasUnknownModelCost !== undefined) {
    if (typeof entry.hasUnknownModelCost !== 'boolean') return null;
    out.hasUnknownModelCost = entry.hasUnknownModelCost;
  }
  return out;
}
