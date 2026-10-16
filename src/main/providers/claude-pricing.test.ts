// Claude's price list (#787, moved out of the renderer by #1288). The
// calibration fixtures came with it: they are what says the table is right.
import { describe, it, expect } from 'vitest';
import { claudeEstimateCostUsd, claudeRateForModel } from './claude-pricing';
import type { CliModelCost } from '../../shared/transcripts';

/** The old `rateForModel`'s spelling, for the fixtures below: these models are all known. */
const rateForModel = (model: string) => {
  const r = claudeRateForModel(model);
  if (!r) throw new Error(`no rate for ${model}`);
  return r;
};

describe('claudeRateForModel', () => {
  it('picks by model family', () => {
    expect(rateForModel('claude-opus-5').output).toBe(25);
    expect(rateForModel('claude-haiku-4-5').output).toBe(5);
    expect(rateForModel('claude-sonnet-5').output).toBe(10);
  });

  it('has NO default: an unknown or absent model has no rate (#1288)', () => {
    // Before #1288 both of these answered sonnet-class $2/$10, which is how an
    // unrecognised model came to show a confident dollar figure nobody reported.
    expect(claudeRateForModel(undefined)).toBeUndefined();
    expect(claudeRateForModel('')).toBeUndefined();
    expect(claudeRateForModel('some-unknown-model')).toBeUndefined();
    expect(claudeRateForModel('<synthetic>')).toBeUndefined();
    expect(claudeRateForModel('gpt-6-luna')).toBeUndefined();
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

describe('claudeEstimateCostUsd', () => {
  const u = { input: 1e6, output: 1e6, cacheRead: 0, cacheCreate: 0 };

  it('computes per-million cost across token classes', () => {
    // 1M input + 1M output at sonnet rates = 2 + 10 = $12
    expect(claudeEstimateCostUsd(u, 'sonnet')).toBeCloseTo(12, 5);
    // ...and the cache classes are priced too: 1M read @ 0.5 + 1M write @ 6.25
    expect(
      claudeEstimateCostUsd({ input: 0, output: 0, cacheRead: 1e6, cacheCreate: 1e6 }, 'claude-opus-5')
    ).toBeCloseTo(6.75, 5);
  });

  it('opus is pricier than sonnet for the same usage', () => {
    expect(claudeEstimateCostUsd(u, 'claude-opus-5')!).toBeGreaterThan(
      claudeEstimateCostUsd(u, 'claude-sonnet-5')!
    );
  });

  it('an unknown model gets NO price, not a Sonnet one (#1288, Phase 3 exit 6)', () => {
    expect(claudeEstimateCostUsd(u, 'some-unknown-model')).toBeUndefined();
    expect(claudeEstimateCostUsd(u, undefined)).toBeUndefined();
  });

  it('zero tokens are exactly $0 whatever the model, including none', () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    expect(claudeEstimateCostUsd(zero, undefined)).toBe(0);
    expect(claudeEstimateCostUsd(zero, 'some-unknown-model')).toBe(0);
  });

  it('never prices thinking: it is already inside output', () => {
    const base = { input: 0, output: 4200, cacheRead: 0, cacheCreate: 0 };
    const without = claudeEstimateCostUsd(base, 'claude-opus-5');
    expect(claudeEstimateCostUsd({ ...base, thinking: 2900 }, 'claude-opus-5')).toBe(without);
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

