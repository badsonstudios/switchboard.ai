// Usage/cost helpers for the session card (P2-E7-01). Subscription-first: the
// exact token counts are the real signal; the dollar figure is a labeled
// ESTIMATE (the user isn't billed per token on a subscription) computed from
// public per-model rates, defaulting to Sonnet-class when the model is unknown.

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/** USD per million tokens. Approximate public rates; refine per model as needed. */
interface Rate {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

const RATES: Array<{ match: RegExp; rate: Rate }> = [
  { match: /opus/i, rate: { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 } },
  { match: /haiku/i, rate: { input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 } },
  { match: /sonnet|fable|mythos/i, rate: { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 } },
];
const DEFAULT_RATE: Rate = RATES[2].rate; // sonnet-class

export function rateForModel(model?: string): Rate {
  if (model) for (const r of RATES) if (r.match.test(model)) return r.rate;
  return DEFAULT_RATE;
}

/** Estimated USD for the accumulated usage. */
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
