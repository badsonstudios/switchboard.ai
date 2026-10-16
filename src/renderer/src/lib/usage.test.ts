import { describe, it, expect } from 'vitest';
import {
  formatTokens,
  formatUsd,
  addUsage,
  costLine,
  sumCostUsd,
  thinkingPart,
  ZERO_USAGE,
  type CliCost,
} from './usage';

describe('formatTokens', () => {
  it('scales to k / M', () => {
    expect(formatTokens(942)).toBe('942');
    expect(formatTokens(12_300)).toBe('12k');
    expect(formatTokens(9_400)).toBe('9.4k');
    expect(formatTokens(1_240_000)).toBe('1.24M');
  });
});

describe('formatUsd', () => {
  it('floors tiny amounts', () => {
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(1.239)).toBe('$1.24');
  });
});

describe('costLine', () => {
  const USAGE = { input: 1e6, output: 1e6, cacheRead: 0, cacheCreate: 0 };
  /** what Claude's price list says USAGE costs on Opus: 1M in @ $5 + 1M out @ $25 */
  const OPUS_EST = 30;
  const cli = (over: Partial<CliCost> = {}): CliCost => ({
    totalCostUSD: 42.5,
    modelUsage: {},
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,
    totalDuration: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    startTime: 0,
    ...over,
  });

  it('falls back to our estimate, marked as approximate and a floor', () => {
    const line = costLine(USAGE, OPUS_EST);
    expect(line.source).toBe('estimate');
    expect(line.floor).toBe(true);
    expect(line.text).toBe('~$30.00'); // 1M in @ $5 + 1M out @ $25
    expect(line.usd).toBeCloseTo(30, 6);
  });

  it('prefers the CLI’s own figure and drops the approximation marker', () => {
    const line = costLine(USAGE, OPUS_EST, cli());
    expect(line.source).toBe('cli');
    expect(line.floor).toBe(false);
    expect(line.text).toBe('$42.50');
    expect(line.usd).toBe(42.5);
  });

  it('marks the CLI’s figure as a floor when it could not price a model', () => {
    const line = costLine(USAGE, OPUS_EST, cli({ hasUnknownModelCost: true }));
    expect(line.source).toBe('cli');
    expect(line.floor).toBe(true);
    expect(line.text).toBe('≥$42.50');
  });

  it('treats an ABSENT hasUnknownModelCost as a definite figure, not a floor', () => {
    // Three states, not two: the CLI's schema declares the field optional, so
    // `undefined` means "this CLI did not say". It is not evidence of an
    // unpriced model, so it must not put a `>=` on the card — but it is also
    // not the same value as `false`, and `costLine` must not flatten it into
    // one by testing truthiness of something it never set.
    const absent = costLine(USAGE, OPUS_EST, cli());
    const explicitlyFalse = costLine(USAGE, OPUS_EST, cli({ hasUnknownModelCost: false }));
    expect(absent.floor).toBe(false);
    expect(explicitlyFalse.floor).toBe(false);
    expect(absent.text).toBe(explicitlyFalse.text);
  });

  it('shows the CLI’s zero rather than reverting to a non-zero estimate', () => {
    // `0` is a real answer the CLI gives (both #790 probe transcripts report
    // `totalCostUSD: 0`). A truthiness check on the number instead of on the
    // object would silently show our estimate beside it.
    //
    // And it says `$0.00`, not `<$0.01`: the hedge is honest about a number we
    // rounded and a lie about one we know to be nil. With the floor marker the
    // old form read `≥<$0.01` — "at least less than a cent".
    const line = costLine(USAGE, OPUS_EST, cli({ totalCostUSD: 0 }));
    expect(line.source).toBe('cli');
    expect(line.text).toBe('$0.00');
    expect(line.usd).toBe(0);
    expect(costLine(USAGE, undefined, cli({ totalCostUSD: 0, hasUnknownModelCost: true })).text).toBe(
      '≥$0.00'
    );
  });

  it('shows NO PRICE when the provider gave none — a dash, never a guess (#1288)', () => {
    const line = costLine(USAGE, undefined);
    expect(line.source).toBe('none');
    expect(line.usd).toBeUndefined();
    expect(line.text).toBe('—');
    expect(line.floor).toBe(false);
  });

  it('treats a broken estimate as no price, not as a number', () => {
    for (const bad of [NaN, Infinity, -1, '30' as unknown as number]) {
      expect(costLine(USAGE, bad).source, String(bad)).toBe('none');
    }
  });

  it('says $0.00 for a session that has not spoken, price list or not', () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    expect(costLine(zero, undefined).text).toBe('$0.00');
    expect(costLine(zero, undefined).usd).toBe(0);
  });

  it('still prefers the CLI’s own figure when there is no estimate', () => {
    expect(costLine(USAGE, undefined, cli()).text).toBe('$42.50');
  });

  it('refuses a persisted figure that is not a number at all', () => {
    // The parser guards the transcript entrance; this guards the OTHER one.
    // `cliCost` also arrives from `workspace.json` via the card record, which
    // is never re-parsed — a truncated write would otherwise render `$NaN`.
    for (const bad of [NaN, Infinity, -1, undefined as unknown as number]) {
      const line = costLine(USAGE, OPUS_EST, cli({ totalCostUSD: bad }));
      expect(line.source, String(bad)).toBe('estimate');
      expect(line.text).toBe('~$30.00');
    }
  });
});

describe('formatUsd', () => {
  it('says an exact zero exactly', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('<$0.01');
  });
});

describe('sumCostUsd (the status-bar total)', () => {
  const cli = (usd: number): CliCost => ({
    totalCostUSD: usd,
    modelUsage: {},
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,
    totalDuration: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    startTime: 0,
  });
  const spender = { input: 1e6, output: 1e6, cacheRead: 0, cacheCreate: 0 };

  it('is zero for an empty workspace', () => {
    expect(sumCostUsd([])).toEqual({ usd: 0, unpriced: 0 });
  });

  it('MIXES the CLI’s exact figures with our estimates rather than ignoring either', () => {
    // The defect this function was extracted to make testable: the status bar
    // re-derived `estimateCostUsd` and dropped `cliCost`, so an ended session
    // contributed our guess (here $30) instead of Claude Code's real $7.
    const total = sumCostUsd([
      { usage: spender, estimateUsd: 30 }, // estimate: $30
      { usage: spender, estimateUsd: 30, cliCost: cli(7) }, // exact: $7
    ]);
    expect(total.usd).toBeCloseTo(37, 6);
    expect(total.unpriced).toBe(0);
    // ...and it is NOT the all-estimate answer, which is what regressing here
    // would produce.
    expect(total.usd).not.toBeCloseTo(60, 6);
  });

  it('COUNTS a session with no price instead of pricing it (#1288)', () => {
    // The Phase 3 exit criterion: an unknown model must not silently price as
    // Sonnet. Before #1288 the second row added sonnet-class $12 to the total.
    const total = sumCostUsd([
      { usage: spender, estimateUsd: 30 },
      { usage: spender }, // tokens, and no price from its provider
    ]);
    expect(total.usd).toBeCloseTo(30, 6);
    expect(total.unpriced).toBe(1);
  });

  it('a session with no tokens costs nothing on any price list, so it is not "unpriced"', () => {
    const total = sumCostUsd([{ usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 } }]);
    expect(total).toEqual({ usd: 0, unpriced: 0 });
  });

  it('a garbage persisted figure falls back to the estimate instead of poisoning the total', () => {
    const total = sumCostUsd([
      { usage: spender, estimateUsd: 30, cliCost: cli(NaN) },
    ]);
    expect(Number.isFinite(total.usd)).toBe(true);
    expect(total.usd).toBeCloseTo(30, 6);
  });
});

describe('addUsage', () => {
  it('sums fieldwise from zero', () => {
    const total = addUsage(ZERO_USAGE, { input: 5, output: 10, cacheRead: 100, cacheCreate: 2 });
    expect(total).toEqual({ input: 5, output: 10, cacheRead: 100, cacheCreate: 2 });
  });
});

describe('thinkingPart (#789) — a part of output, never more than it', () => {
  const base = { input: 0, output: 4200, cacheRead: 0, cacheCreate: 0 };

  it('gives the tokens and their share of output', () => {
    expect(thinkingPart({ ...base, thinking: 2900 })).toEqual({ tokens: 2900, pct: 69 });
  });

  it('accepts thinking equal to output (100%)', () => {
    expect(thinkingPart({ ...base, thinking: 4200 })).toEqual({ tokens: 4200, pct: 100 });
  });

  it('never says 100% unless it is exactly all, nor 0% unless it is exactly none', () => {
    expect((4183 / 4200) * 100).toBeGreaterThan(99.5); // witness: would round to 100
    expect(thinkingPart({ ...base, thinking: 4183 })!.pct).toBe(99);
    expect((17 / 4200) * 100).toBeLessThan(0.5); // witness: would round to 0
    expect(thinkingPart({ ...base, thinking: 17 })!.pct).toBe(1);
  });

  it('rounds to nearest, not down', () => {
    expect((2980 / 4200) * 100).toBeCloseTo(70.95, 2); // witness: floor 70, round 71
    expect(thinkingPart({ ...base, thinking: 2980 })!.pct).toBe(71);
  });

  it('shows NOTHING when thinking exceeds output — the persisted copy is never re-parsed', () => {
    expect(thinkingPart({ ...base, thinking: 4201 })).toBeNull();
  });

  it('shows nothing for a record written before #789 (no key at all)', () => {
    const old = { ...base };
    expect(Object.prototype.hasOwnProperty.call(old, 'thinking')).toBe(false); // witness
    expect(thinkingPart(old)).toBeNull();
  });

  it('shows nothing for zero, rather than "(0 thinking)"', () => {
    expect(thinkingPart({ ...base, thinking: 0 })).toBeNull();
  });

  it('shows nothing for a hand-edited non-number, NaN or negative', () => {
    expect(thinkingPart({ ...base, thinking: '2900' as unknown as number })).toBeNull();
    expect(thinkingPart({ ...base, thinking: NaN })).toBeNull();
    expect(thinkingPart({ ...base, thinking: -1 })).toBeNull();
  });

  it('shows nothing when OUTPUT itself is not a number', () => {
    // `!(t <= output)` rather than `t > output`: against NaN both comparisons
    // are false, so only the negated form refuses it.
    expect(thinkingPart({ ...base, output: NaN, thinking: 5 })).toBeNull();
  });
});
