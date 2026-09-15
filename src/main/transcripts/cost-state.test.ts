import { describe, it, expect } from 'vitest';
import { parseCostState } from './cost-state';

/**
 * A real `cost-state` line, CLI 2.1.261, trimmed only of the keys the parser
 * does not read. Every test below mutates a copy of THIS rather than building a
 * shape by hand — a hand-built fixture is a fixture that asserts against our
 * own idea of the format instead of the CLI's.
 */
const REAL = {
  type: 'cost-state',
  sessionId: '30dbc63a-59b0-4456-974f-235c303aec0e',
  totalCostUSD: 54.9788885,
  totalAPIDuration: 8_244_912,
  totalAPIDurationWithoutRetries: 8_244_912,
  totalToolDuration: 1_508_731,
  totalLinesAdded: 2_477,
  totalLinesRemoved: 1_133,
  totalDuration: 14_006_882,
  startTime: 1_789_180_000_000,
  hasUnknownModelCost: false,
  modelUsage: {
    'claude-opus-5': {
      inputTokens: 590,
      outputTokens: 380369,
      thinkingTokens: 177370,
      cacheReadInputTokens: 72358771,
      cacheCreationInputTokens: 1162506,
      webSearchRequests: 0,
      costUSD: 54.88876549999999,
    },
    'claude-haiku-4-5-20251001': {
      inputTokens: 42198,
      outputTokens: 1585,
      thinkingTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 4,
      costUSD: 0.090123,
    },
  },
} as Record<string, unknown>;

const copy = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(REAL)) as Record<string, unknown>;

describe('parseCostState', () => {
  it('reads a real line whole', () => {
    const c = parseCostState(copy());
    expect(c).not.toBeNull();
    expect(c!.totalCostUSD).toBe(54.9788885);
    expect(c!.hasUnknownModelCost).toBe(false);
    expect(Object.keys(c!.modelUsage)).toEqual([
      'claude-opus-5',
      'claude-haiku-4-5-20251001',
    ]);
    expect(c!.modelUsage['claude-haiku-4-5-20251001'].webSearchRequests).toBe(4);
    expect(c!.totalLinesAdded).toBe(2477);
    expect(c!.startTime).toBe(1_789_180_000_000);
  });

  it('carries thinkingTokens through (parsed; the card deliberately reads its own, #789)', () => {
    const c = parseCostState(copy());
    expect(c!.modelUsage['claude-opus-5'].thinkingTokens).toBe(177370);
  });

  it('holds to the CLI’s own invariant: per-model costUSD sums to the total', () => {
    // Measured 22/22. Not enforced by the parser — a line that broke it is the
    // CLI's business, not ours to reject — but asserted here so the fixture is
    // provably a real one rather than numbers that merely look plausible.
    const c = parseCostState(copy())!;
    const sum = Object.values(c.modelUsage).reduce((a, m) => a + m.costUSD, 0);
    expect(sum).toBeCloseTo(c.totalCostUSD, 6);
  });

  it('is not a cost-state line', () => {
    expect(parseCostState({ type: 'assistant', totalCostUSD: 5 })).toBeNull();
    expect(parseCostState({ totalCostUSD: 5 })).toBeNull();
  });

  describe('refuses anything that would render as a bad dollar figure', () => {
    // The point of every case here: the fallback is the estimate we already
    // had, which is a worse number but a number. `NaN`, `-$3` and `$Infinity`
    // on a card are all worse than that.
    it.each([
      ['NaN total', 'totalCostUSD', NaN],
      ['infinite total', 'totalCostUSD', Infinity],
      ['negative total', 'totalCostUSD', -1],
      ['string total', 'totalCostUSD', '54.97'],
      ['missing total', 'totalCostUSD', undefined],
      ['negative duration', 'totalDuration', -1],
      ['missing startTime', 'startTime', undefined],
      ['NaN linesAdded', 'totalLinesAdded', NaN],
    ])('%s', (_label, key, value) => {
      const e = copy();
      if (value === undefined) delete e[key];
      else e[key] = value;
      expect(parseCostState(e)).toBeNull();
    });

    it('a non-object modelUsage', () => {
      for (const bad of [null, 'x', 42, ['claude-opus-5']]) {
        const e = copy();
        e.modelUsage = bad;
        expect(parseCostState(e), String(bad)).toBeNull();
      }
    });

    it('ONE bad model row rejects the WHOLE line', () => {
      // Not a partial parse. Half a cost line is not a cheaper cost line, it is
      // a wrong one — and it would be wrong in the direction of under-reporting
      // while still claiming to be the CLI's exact figure.
      const e = copy();
      (e.modelUsage as Record<string, Record<string, unknown>>)['claude-opus-5'].costUSD = -5;
      expect(parseCostState(e)).toBeNull();
    });

    it('a thinkingTokens that is present but invalid', () => {
      const e = copy();
      (e.modelUsage as Record<string, Record<string, unknown>>)['claude-opus-5'].thinkingTokens =
        NaN;
      expect(parseCostState(e)).toBeNull();
    });

    it('a non-boolean hasUnknownModelCost', () => {
      const e = copy();
      e.hasUnknownModelCost = 'true';
      expect(parseCostState(e)).toBeNull();
    });
  });

  describe('hasUnknownModelCost has three states', () => {
    it('absent stays absent — it is not defaulted to false', () => {
      // The CLI's own zod schema declares it `.optional()`. "This CLI did not
      // say" is a different claim from "I priced every model I used", and
      // flattening the two is the #776/#785 mistake in a new place. Anything
      // downstream that wants to distinguish them must still be able to.
      const e = copy();
      delete e.hasUnknownModelCost;
      const c = parseCostState(e);
      expect(c).not.toBeNull();
      expect('hasUnknownModelCost' in c!).toBe(false);
      expect(c!.hasUnknownModelCost).toBeUndefined();
    });

    it('true and false both round-trip', () => {
      for (const v of [true, false]) {
        const e = copy();
        e.hasUnknownModelCost = v;
        expect(parseCostState(e)!.hasUnknownModelCost).toBe(v);
      }
    });
  });

  it('keeps a __proto__ model id as a KEY instead of silently losing the row', () => {
    // `JSON.parse` makes `__proto__` an OWN property and `Object.entries`
    // yields it, but assigning it on an object literal runs `Object.prototype`'s
    // setter rather than adding a key: the row would vanish, `modelUsage` would
    // come out `{}`, and the line's own invariant (`sum(costUSD) ===
    // totalCostUSD`) would break while `totalCostUSD` still claimed the full
    // amount. No throw, so it fails SILENTLY — which is the only reason it is
    // worth a test for an input the CLI's model-id regex makes theoretical.
    // Built from JSON *TEXT*, and that is the whole fixture. Writing
    // `{ __proto__: {...} }` as an object literal sets the PROTOTYPE and
    // creates no own key, so the fixture would not contain the thing under
    // test — which is exactly what the first draft of this test did, and it
    // failed for that reason rather than finding anything.
    const e = JSON.parse(
      JSON.stringify({ ...REAL, totalCostUSD: 0.090123, modelUsage: {} }).replace(
        '"modelUsage":{}',
        '"modelUsage":{"__proto__":{"inputTokens":42198,"outputTokens":1585,' +
          '"cacheReadInputTokens":0,"cacheCreationInputTokens":0,' +
          '"webSearchRequests":4,"costUSD":0.090123}}'
      )
    ) as Record<string, unknown>;
    // WITNESS: the hostile key really is an OWN property of what we parsed.
    // Without this the assertions below pass trivially on an empty object.
    expect(
      Object.prototype.hasOwnProperty.call(e.modelUsage as object, '__proto__'),
      'fixture does not actually carry an own __proto__ key'
    ).toBe(true);
    const c = parseCostState(e);
    expect(c).not.toBeNull();
    expect(Object.keys(c!.modelUsage)).toEqual(['__proto__']);
    const sum = Object.values(c!.modelUsage).reduce((a, m) => a + m.costUSD, 0);
    expect(sum).toBeCloseTo(c!.totalCostUSD, 6);
  });

  it('accepts an empty modelUsage with a zero total', () => {
    // Both #790 probe transcripts look exactly like this — a session that
    // never reached the API. `{}` and `0` are real answers, not missing ones.
    const e = copy();
    e.modelUsage = {};
    e.totalCostUSD = 0;
    const c = parseCostState(e);
    expect(c).not.toBeNull();
    expect(c!.totalCostUSD).toBe(0);
    expect(c!.modelUsage).toEqual({});
  });
});
