import { describe, it, expect } from 'vitest';
import {
  formatTokens,
  formatUsd,
  estimateCostUsd,
  rateForModel,
  addUsage,
  costLine,
  sumCostUsd,
  thinkingPart,
  ZERO_USAGE,
  type CliCost,
  type CliModelCost,
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

describe('rateForModel', () => {
  it('picks by model family, defaults to sonnet-class', () => {
    expect(rateForModel('claude-opus-5').output).toBe(25);
    expect(rateForModel('claude-haiku-4-5').output).toBe(5);
    expect(rateForModel('claude-sonnet-5').output).toBe(10);
    expect(rateForModel(undefined).output).toBe(10); // default
    expect(rateForModel('some-unknown-model').output).toBe(10);
  });

  it('matches fable before the generic families', () => {
    // `claude-fable-5-1` has no `sonnet`/`opus` in it, but the ordering is what
    // guarantees it can never fall through to the sonnet-class default — which
    // is exactly what happened before #787 and made every Fable session
    // under-report by 2.6-3.0x.
    expect(rateForModel('claude-fable-5-1').output).toBe(50);
    expect(rateForModel('claude-mythos-5-1').output).toBe(50);
  });
});

describe('estimateCostUsd', () => {
  it('computes per-million cost across token classes', () => {
    // 1M input + 1M output at sonnet rates = 2 + 10 = $12
    const cost = estimateCostUsd({ input: 1e6, output: 1e6, cacheRead: 0, cacheCreate: 0 }, 'sonnet');
    expect(cost).toBeCloseTo(12, 5);
  });
  it('opus is pricier than sonnet for the same usage', () => {
    const u = { input: 1e6, output: 1e6, cacheRead: 0, cacheCreate: 0 };
    expect(estimateCostUsd(u, 'claude-opus-5')).toBeGreaterThan(
      estimateCostUsd(u, 'claude-sonnet-5')
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CALIBRATION TEST (#787)
//
// The rate table was wrong by more than 2x in BOTH directions for months and
// nothing caught it, because nothing here was ever compared against a number
// with an independent source. These fixtures ARE that independent source: they
// are real `modelUsage` rows lifted verbatim from `cost-state` lines the CLI
// wrote, each carrying the CLI's own `costUSD` for those exact tokens.
//
// A future edit to RATES that breaks the arithmetic fails here, with the
// measurement that contradicts it sitting on the same screen.
// ─────────────────────────────────────────────────────────────────────────────

/** USD per web search request. MEASURED — see the four-row assertion below. */
const WEB_SEARCH_USD = 0.01;

/**
 * What our table says a CLI-reported `modelUsage` row should have cost.
 *
 * Test-only on purpose: production's `estimateCostUsd` reads `Usage`, which has
 * no web-search count, so it cannot bill that line item. Here the count IS
 * available, which is what makes exact reconciliation possible at all.
 */
function priceModelRow(row: CliModelCost, model: string): number {
  const r = rateForModel(model);
  return (
    (row.inputTokens * r.input +
      row.outputTokens * r.output +
      row.cacheReadInputTokens * r.cacheRead +
      row.cacheCreationInputTokens * r.cacheCreate) /
      1_000_000 +
    row.webSearchRequests * WEB_SEARCH_USD
  );
}

const HAIKU = 'claude-haiku-4-5-20251001';

/** Real rows from `cost-state` lines, CLI 2.1.261. Do not "tidy" these. */
const HAIKU_ROWS: CliModelCost[] = [
  {
    inputTokens: 442414,
    outputTokens: 6441,
    thinkingTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.474619,
  },
  {
    inputTokens: 42198,
    outputTokens: 1585,
    thinkingTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 4,
    costUSD: 0.090123,
  },
  {
    inputTokens: 281419,
    outputTokens: 5676,
    thinkingTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 2,
    costUSD: 0.329799,
  },
  {
    inputTokens: 35820,
    outputTokens: 1002,
    thinkingTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 3,
    costUSD: 0.07083,
  },
  {
    inputTokens: 352041,
    outputTokens: 6874,
    thinkingTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 3,
    costUSD: 0.416411,
  },
];

describe('the rate table against the CLI’s own accounting', () => {
  it('reconciles EXACTLY on haiku rows, web searches included', () => {
    // WITNESS: the fixtures are non-trivial and were actually read. Without
    // this a future edit that emptied the array would leave the loop below
    // green over nothing — the #785 lesson, twice over.
    expect(HAIKU_ROWS).toHaveLength(5);
    expect(HAIKU_ROWS.map((r) => r.webSearchRequests)).toEqual([0, 4, 2, 3, 3]);

    for (const row of HAIKU_ROWS) {
      // To the cent, against a number we did not compute. Not `toBeCloseTo(2)`
      // — the whole claim is that this is exact.
      expect(priceModelRow(row, HAIKU), `haiku row ${row.inputTokens}`).toBeCloseTo(row.costUSD, 6);
    }
  });

  it('bills web searches at $0.01, which is the only free parameter above', () => {
    // Isolates the constant the previous test folds in: strip the web searches
    // and the four rows that have them fall short by exactly their count of
    // cents. If this drifts, the reconciliation is coincidence.
    for (const row of HAIKU_ROWS.filter((r) => r.webSearchRequests > 0)) {
      const withoutSearches = priceModelRow(
        { ...row, webSearchRequests: 0 },
        HAIKU
      );
      expect(row.costUSD - withoutSearches).toBeCloseTo(row.webSearchRequests * 0.01, 6);
    }
  });

  it('is a FLOOR on cache-heavy rows, never an over-estimate', () => {
    // Opus and Fable cannot reconcile exactly: the CLI knows the 5m/1h
    // cache-write split and the transcript does not, so our number is short by
    // a measured 3-21%. What must NEVER happen is the other direction — an
    // estimate ABOVE the CLI's own figure is the 2.4x bug #787 fixed, and this
    // is the assertion that would catch its return.
    const rows: Array<{ model: string; row: CliModelCost }> = [
      {
        model: 'claude-fable-5-1',
        row: {
          inputTokens: 764,
          outputTokens: 42888,
          thinkingTokens: 2919,
          cacheReadInputTokens: 2476682,
          cacheCreationInputTokens: 79617,
          webSearchRequests: 0,
          costUSD: 4.3635505,
        },
      },
      {
        model: 'claude-opus-5',
        row: {
          inputTokens: 590,
          outputTokens: 380369,
          thinkingTokens: 177370,
          cacheReadInputTokens: 72358771,
          cacheCreationInputTokens: 1162506,
          webSearchRequests: 0,
          costUSD: 54.88876549999999,
        },
      },
    ];
    expect(rows).toHaveLength(2);
    for (const { model, row } of rows) {
      const ours = priceModelRow(row, model);
      expect(ours, `${model} must not exceed the CLI`).toBeLessThanOrEqual(row.costUSD);
      // ...and must not be so far short that it has stopped being informative.
      expect(ours / row.costUSD, `${model} within 25% of the CLI`).toBeGreaterThan(0.75);
    }
  });
});

describe('costLine', () => {
  const USAGE = { input: 1e6, output: 1e6, cacheRead: 0, cacheCreate: 0 };
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
    const line = costLine(USAGE, 'claude-opus-5');
    expect(line.source).toBe('estimate');
    expect(line.floor).toBe(true);
    expect(line.text).toBe('~$30.00'); // 1M in @ $5 + 1M out @ $25
    expect(line.usd).toBeCloseTo(30, 6);
  });

  it('prefers the CLI’s own figure and drops the approximation marker', () => {
    const line = costLine(USAGE, 'claude-opus-5', cli());
    expect(line.source).toBe('cli');
    expect(line.floor).toBe(false);
    expect(line.text).toBe('$42.50');
    expect(line.usd).toBe(42.5);
  });

  it('marks the CLI’s figure as a floor when it could not price a model', () => {
    const line = costLine(USAGE, 'claude-opus-5', cli({ hasUnknownModelCost: true }));
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
    const absent = costLine(USAGE, 'claude-opus-5', cli());
    const explicitlyFalse = costLine(USAGE, 'claude-opus-5', cli({ hasUnknownModelCost: false }));
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
    const line = costLine(USAGE, 'claude-opus-5', cli({ totalCostUSD: 0 }));
    expect(line.source).toBe('cli');
    expect(line.text).toBe('$0.00');
    expect(line.usd).toBe(0);
    expect(costLine(USAGE, 'x', cli({ totalCostUSD: 0, hasUnknownModelCost: true })).text).toBe(
      '≥$0.00'
    );
  });

  it('refuses a persisted figure that is not a number at all', () => {
    // The parser guards the transcript entrance; this guards the OTHER one.
    // `cliCost` also arrives from `workspace.json` via the card record, which
    // is never re-parsed — a truncated write would otherwise render `$NaN`.
    for (const bad of [NaN, Infinity, -1, undefined as unknown as number]) {
      const line = costLine(USAGE, 'claude-opus-5', cli({ totalCostUSD: bad }));
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
    expect(sumCostUsd([])).toBe(0);
  });

  it('MIXES the CLI’s exact figures with our estimates rather than ignoring either', () => {
    // The defect this function was extracted to make testable: the status bar
    // re-derived `estimateCostUsd` and dropped `cliCost`, so an ended session
    // contributed our guess (here $30) instead of Claude Code's real $7.
    const total = sumCostUsd([
      { usage: spender, model: 'claude-opus-5' }, // estimate: $30
      { usage: spender, model: 'claude-opus-5', cliCost: cli(7) }, // exact: $7
    ]);
    expect(total).toBeCloseTo(37, 6);
    // ...and it is NOT the all-estimate answer, which is what regressing here
    // would produce.
    expect(total).not.toBeCloseTo(60, 6);
  });

  it('a garbage persisted figure falls back to the estimate instead of poisoning the total', () => {
    const total = sumCostUsd([
      { usage: spender, model: 'claude-opus-5', cliCost: cli(NaN) },
    ]);
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBeCloseTo(30, 6);
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

  it('is never priced: the estimate is identical with or without it', () => {
    // The hard rule, pinned where the money is: thinking is already inside
    // `output`, so charging it again at the output rate would double-bill it.
    const without = estimateCostUsd(base, 'claude-opus-5');
    expect(estimateCostUsd({ ...base, thinking: 2900 }, 'claude-opus-5')).toBe(without);
  });
});
