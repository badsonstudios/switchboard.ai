// Usage for an AI that reports it per turn (#1288). Shaped on Codex's measured
// `session/prompt` result (`spike/findings/e40-codex-acp.md` Q6), which is the
// first engine that will send it.
import { describe, it, expect, vi } from 'vitest';
import { EventUsageLedger, readLimits } from './event-usage';
import { priceUsage } from './price';

describe('EventUsageLedger', () => {
  it('adds per-turn deltas up, per session', () => {
    const l = new EventUsageLedger();
    l.absorb('a', { type: 'usage', inputTokens: 11962, cacheReadTokens: 7296, outputTokens: 11 });
    const a = l.absorb('a', { type: 'usage', inputTokens: 100, outputTokens: 5, cacheWriteTokens: 3 });
    expect(a.usage).toEqual({ input: 12062, output: 16, cacheRead: 7296, cacheCreate: 3, thinking: 0 });
    expect(l.absorb('b', { type: 'usage', inputTokens: 1 }).usage.input).toBe(1);
  });

  it('a turn that reported nothing (Codex’s cancelled turn: `usage: null`) adds nothing', () => {
    const l = new EventUsageLedger();
    l.absorb('a', { type: 'usage', inputTokens: 10 });
    expect(l.absorb('a', { type: 'usage' }).usage.input).toBe(10);
  });

  it('refuses counts that are not counts', () => {
    const l = new EventUsageLedger();
    const u = l.absorb('a', {
      type: 'usage',
      inputTokens: -5,
      outputTokens: NaN,
      cacheReadTokens: Infinity,
      cacheWriteTokens: '7' as unknown as number,
    }).usage;
    expect(u).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0 });
  });

  it('thinking is a PART of output and never more than the output it came with (#789)', () => {
    const l = new EventUsageLedger();
    expect(l.absorb('a', { type: 'usage', outputTokens: 10, thinkingTokens: 40 }).usage).toMatchObject({
      output: 10,
      thinking: 10,
    });
  });

  it('keeps the last model NAMED, and the latest limits', () => {
    const l = new EventUsageLedger();
    l.absorb('a', { type: 'usage', model: 'gpt-6-luna', limits: [{ id: 'primary', usedPercent: 3 }] });
    const a = l.absorb('a', { type: 'usage', limits: [{ id: 'primary', usedPercent: 4 }] });
    expect(a.model).toBe('gpt-6-luna');
    expect(a.limits).toEqual([{ id: 'primary', usedPercent: 4 }]);
  });

  it('forget starts the count again', () => {
    const l = new EventUsageLedger();
    l.absorb('a', { type: 'usage', inputTokens: 10 });
    l.forget('a');
    expect(l.absorb('a', { type: 'usage', inputTokens: 1 }).usage.input).toBe(1);
  });
});

describe('readLimits', () => {
  it('reads the measured Codex windows', () => {
    expect(
      readLimits([
        { id: 'primary', label: '5h limit', usedPercent: 3, windowMinutes: 300, resetsAt: '2026-10-16T15:19:22.000Z' },
        { id: 'secondary', label: 'Weekly limit', usedPercent: 0, windowMinutes: 10080 },
      ])
    ).toEqual([
      { id: 'primary', label: '5h limit', usedPercent: 3, windowMinutes: 300, resetsAt: '2026-10-16T15:19:22.000Z' },
      { id: 'secondary', label: 'Weekly limit', usedPercent: 0, windowMinutes: 10080 },
    ]);
  });

  it('drops a window it cannot draw honestly, rather than drawing it as 0%', () => {
    expect(readLimits([{ id: 'x' }, { usedPercent: 5 }, null, 'nope', { id: 'y', usedPercent: NaN }])).toBeUndefined();
    expect(readLimits('not a list')).toBeUndefined();
  });

  it('clamps a percentage to 0–100', () => {
    expect(readLimits([{ id: 'p', usedPercent: 140 }])?.[0].usedPercent).toBe(100);
    expect(readLimits([{ id: 'p', usedPercent: -3 }])?.[0].usedPercent).toBe(0);
  });

  it('bounds how many windows it keeps', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `w${i}`, usedPercent: 1 }));
    expect(readLimits(many)).toHaveLength(8);
  });
});

describe('priceUsage', () => {
  const U = { input: 1e6, output: 0, cacheRead: 0, cacheCreate: 0 };

  it('asks the provider, and passes the model through', () => {
    const estimateCostUsd = vi.fn(() => 5);
    expect(priceUsage({ usage: { estimateCostUsd } }, U, 'm')).toBe(5);
    expect(estimateCostUsd).toHaveBeenCalledWith(U, 'm');
  });

  it('no capability, no provider: no price', () => {
    expect(priceUsage({}, U, 'm')).toBeUndefined();
    expect(priceUsage(undefined, U, 'm')).toBeUndefined();
  });

  it('a throw or a nonsense answer is no price, never zero', () => {
    const warn = vi.fn();
    const boom = {
      usage: {
        estimateCostUsd: () => {
          throw new Error('x');
        },
      },
    };
    expect(priceUsage(boom, U, 'm', warn)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    for (const bad of [NaN, -1, Infinity, '3' as unknown as number]) {
      expect(priceUsage({ usage: { estimateCostUsd: () => bad } }, U, 'm'), String(bad)).toBeUndefined();
    }
  });
});
