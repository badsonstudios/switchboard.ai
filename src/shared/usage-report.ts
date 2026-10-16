// What an AI reports about its usage, in the shape every surface reads (E40
// item 05, #1288). DESIGN §5.13; the owner's rule for more than one AI is
// "show whatever the AI reports, in the same spot" (design record §1).
//
// THE PRICE IS NOT WORKED OUT HERE, OR IN THE RENDERER. Each provider prices
// its own tokens in main (`ProviderCapabilities.usage`), and a provider that
// cannot price a model says nothing rather than borrowing another model's
// rate. Before #1288 the renderer held one table for everybody and priced an
// unrecognised model as Sonnet, which is a number nobody reported.

/**
 * Token totals for one session. The fields Claude's transcript ledger has
 * always carried; an engine that reports fewer leaves the rest at zero.
 */
export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /**
   * The part of `output` the model spent thinking (#789). INSIDE `output`,
   * never added to it. Optional because the persisted copy predates it.
   */
  thinking?: number;
}

/**
 * One plan-limit window the AI reports: "5-hour limit, 3% used, resets at
 * 15:19". Shaped on Codex's measured `account/rateLimits/read`
 * (`spike/findings/e40-codex-acp.md` Q6): `usedPercent`, `windowDurationMins`,
 * `resetsAt`. Claude reports none through any channel we read.
 *
 * A window is ACCOUNT-wide, not per session, so it is never summed.
 */
export interface PlanLimitWindow {
  /** stable within one AI, e.g. `primary` / `secondary` */
  id: string;
  /** the AI's own name for it, when it gives one */
  label?: string;
  /** 0–100, as reported */
  usedPercent: number;
  windowMinutes?: number;
  /** ISO-8601 */
  resetsAt?: string;
}

/**
 * What `sessions:usage` tells the renderer about one session. The transcript
 * snapshot carries more than this (binding state, the plan), and the renderer
 * reads those where it needs them; this is the usage part.
 */
export interface UsageReport {
  sessionId: string;
  usage: UsageTokens;
  /** last-seen model id, as the AI named it */
  model?: string;
  /**
   * The provider's own estimate for `usage`, in USD. ABSENT MEANS "NO PRICE":
   * the provider has no price list, or does not know this model. Never filled
   * in with a guess, and never read as zero.
   */
  estimateUsd?: number;
  /** plan-limit windows, when the AI reports them (last report wins) */
  limits?: PlanLimitWindow[];
}

/** Zero tokens cost nothing on any price list, so they need no price list. */
export function isZeroUsage(u: UsageTokens): boolean {
  return u.input === 0 && u.output === 0 && u.cacheRead === 0 && u.cacheCreate === 0;
}
