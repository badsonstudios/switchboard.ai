// P2-E14-07: what the record looks like, as a table.
//
// Pure functions, so the four states and the whole tooltip are checked without
// mounting anything — the components below only have to be checked for the
// things a DOM can be wrong about.
import { describe, it, expect } from 'vitest';
import { ServiceHealthStatus } from '../../../shared/service-health';
import { healthTone, healthTooltip } from './service-health';

const base: ServiceHealthStatus = {
  state: 'operational',
  reason: 'ok',
  incidents: [],
  corroboration: null,
};

describe('the dot', () => {
  it.each([
    ['operational', '●', 'var(--status-done-ink)', null],
    ['degraded', '●', 'var(--status-needs-input-ink)', 'health.short.degraded'],
    ['outage', '●', 'var(--status-crashed-ink)', 'health.short.outage'],
    ['unknown', '○', 'var(--status-idle-ink)', null],
  ] as const)('%s', (state, glyph, colorVar, shortKey) => {
    const tone = healthTone({ ...base, state });
    expect(tone.glyph).toBe(glyph);
    expect(tone.colorVar).toBe(colorVar);
    expect(tone.shortKey).toBe(shortKey);
  });

  it('never carries a literal colour — the renderer paints in tokens', () => {
    for (const state of ['operational', 'degraded', 'outage', 'unknown'] as const) {
      expect(healthTone({ ...base, state }).colorVar).toMatch(/^var\(--/);
    }
  });

  it('tells the two known-bad states apart by more than colour', () => {
    // §5.32: a red dot and an amber dot are the same dot to a lot of people
    expect(healthTone({ ...base, state: 'degraded' }).shortKey).not.toBe(
      healthTone({ ...base, state: 'outage' }).shortKey
    );
  });
});

describe('the tooltip', () => {
  const keys = (s: ServiceHealthStatus): string[] => healthTooltip(s).map((l) => l.key);

  it("leads with our verdict, then the page's own words", () => {
    expect(keys({ ...base, description: 'All Systems Operational' })).toEqual([
      'health.state.operational',
      'health.page',
    ]);
  });

  it('says why when it could not find out', () => {
    for (const reason of ['offline', 'polling-off', 'network', 'bad-response'] as const) {
      expect(keys({ ...base, state: 'unknown', reason })).toContain(`health.reason.${reason}`);
    }
  });

  it('says nothing about a reason when there is nothing to explain', () => {
    expect(keys(base)).toEqual(['health.state.operational']);
    expect(keys({ ...base, state: 'unknown', reason: 'never-checked' })).toEqual([
      'health.state.unknown',
    ]);
  });

  it('names every open incident', () => {
    const lines = healthTooltip({
      ...base,
      state: 'outage',
      incidents: [
        { id: 'a', name: 'API errors', status: 'investigating', impact: 'major' },
        { id: 'b', name: 'Console slow', status: 'monitoring', impact: 'minor' },
      ],
    });
    expect(lines.filter((l) => l.key === 'health.incident')).toHaveLength(2);
    expect(lines[1].params).toEqual({ name: 'API errors', status: 'investigating' });
  });

  it('carries the local corroboration too', () => {
    const lines = healthTooltip({
      ...base,
      corroboration: { sessions: 3 },
    });
    expect(lines.find((l) => l.key === 'health.corroborated')?.params).toEqual({ count: 3 });
  });

  it('formats the check time for a person, not for a log', () => {
    const lines = healthTooltip({ ...base, checkedAt: '2026-08-11T12:34:56.000Z' });
    const at = lines.find((l) => l.key === 'health.checkedAt');
    expect(at).toBeDefined();
    expect(String(at!.params!.time)).not.toContain('T');
  });

  it('drops a checkedAt that is not a time', () => {
    expect(keys({ ...base, checkedAt: 'whenever' })).not.toContain('health.checkedAt');
  });
});
