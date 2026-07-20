import { describe, it, expect } from 'vitest';
import { formatTokens, formatUsd, estimateCostUsd, rateForModel, addUsage, ZERO_USAGE } from './usage';

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
    expect(rateForModel('claude-opus-4-8').output).toBe(75);
    expect(rateForModel('claude-3-5-haiku').output).toBe(4);
    expect(rateForModel('claude-sonnet-5').output).toBe(15);
    expect(rateForModel(undefined).output).toBe(15); // default
    expect(rateForModel('some-unknown-model').output).toBe(15);
  });
});

describe('estimateCostUsd', () => {
  it('computes per-million cost across token classes', () => {
    // 1M input + 1M output at sonnet rates = 3 + 15 = $18
    const cost = estimateCostUsd({ input: 1e6, output: 1e6, cacheRead: 0, cacheCreate: 0 }, 'sonnet');
    expect(cost).toBeCloseTo(18, 5);
  });
  it('opus is pricier than sonnet for the same usage', () => {
    const u = { input: 1e6, output: 1e6, cacheRead: 0, cacheCreate: 0 };
    expect(estimateCostUsd(u, 'claude-opus-4-8')).toBeGreaterThan(estimateCostUsd(u, 'claude-sonnet-5'));
  });
});

describe('addUsage', () => {
  it('sums fieldwise from zero', () => {
    const total = addUsage(ZERO_USAGE, { input: 5, output: 10, cacheRead: 100, cacheCreate: 2 });
    expect(total).toEqual({ input: 5, output: 10, cacheRead: 100, cacheCreate: 2 });
  });
});
