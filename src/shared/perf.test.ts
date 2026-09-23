import { describe, it, expect } from 'vitest';
import {
  PERF_INTERACTIONS,
  batchIsEmpty,
  emptyBatch,
  isPerfInteraction,
  percentile,
  stringLeaves,
  sanitizeSummary,
  summarise,
  summaryAsText,
  type PerfKeystroke,
  type PerfLongTask,
  type PerfSample,
} from './perf';

const sample = (name: PerfSample['name'], ms: number, at = 0): PerfSample => ({ name, ms, at });

const keystroke = (over: Partial<PerfKeystroke> = {}): PerfKeystroke => ({
  at: 0,
  ms: 10,
  blockedMs: 0,
  layoutReads: 0,
  blocks: 0,
  rendered: 0,
  draftLength: 0,
  ...over,
});

describe('percentile (#923)', () => {
  it('has no honest answer for an empty list and says 0', () => {
    // Paired with a count of 0 on screen, which is what makes the 0 readable
    // as "nothing measured" rather than as "instant".
    expect(percentile([], 50)).toBe(0);
    expect(percentile([], 95)).toBe(0);
  });

  it('is nearest-rank, so every answer is a duration something actually took', () => {
    // The whole reason this is not interpolated. With these samples an
    // interpolating p95 would report ~86, a number no interaction produced.
    const values = [10, 20, 30, 40, 100];
    expect(values).toContain(percentile(values, 50));
    expect(values).toContain(percentile(values, 95));
    expect(percentile(values, 50)).toBe(30);
    expect(percentile(values, 95)).toBe(100);
  });

  it('does not care what order the samples arrived in', () => {
    expect(percentile([100, 10, 40, 20, 30], 50)).toBe(30);
  });

  it('one stall in twenty does not move p95 — which is why `worst` is reported too', () => {
    // Standard nearest-rank: p95 of 20 samples is the 19th, so a single burst
    // is invisible at p95 on a short capture. Pinned rather than worked around,
    // because it is what p95 means — and it is the reason `summarise` reports
    // the worst single sample beside the percentiles instead of only them.
    const one = [...Array.from({ length: 19 }, () => 8), 400];
    expect(percentile(one, 95)).toBe(8);
    expect(Math.max(...one)).toBe(400);

    // Two in twenty is 10%, and p95 finally sees it.
    const two = [...Array.from({ length: 18 }, () => 8), 400, 400];
    expect(percentile(two, 95)).toBe(400);
  });

  it('p100 and p0 land on the ends rather than off them', () => {
    expect(percentile([5, 50], 100)).toBe(50);
    expect(percentile([5, 50], 0)).toBe(5);
  });

  it('a single sample is its own every percentile', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it('does not reorder the caller’s array', () => {
    // It sorts a copy. The caller's ring buffer is in arrival order and other
    // readers depend on that.
    const values = [30, 10, 20];
    percentile(values, 50);
    expect(values).toEqual([30, 10, 20]);
  });
});

describe('summarise (#923)', () => {
  it('reports percentiles and the worst — and offers no mean at all', () => {
    // The deliberate omission. 18 fast keystrokes and two 400ms stalls is
    // EXACTLY the shape the owner is complaining about: the mean is 47ms, which
    // reads as "a bit slow", while p95 and worst both report the 400 he
    // actually felt.
    const interactions = [
      ...Array.from({ length: 18 }, () => sample('keystroke', 8)),
      sample('keystroke', 400),
      sample('keystroke', 400),
    ];
    const out = summarise({ interactions, longTasks: [], keystrokes: null, loop: null });

    const row = out.interactions[0];
    expect(row.name).toBe('keystroke');
    expect(row.count).toBe(20);
    expect(row.p50).toBe(8);
    expect(row.worst).toBe(400);
    expect(row.p95).toBe(400);
    // …and the statistic that would have hidden it is not on the row at all.
    const mean = interactions.reduce((n, s) => n + s.ms, 0) / interactions.length;
    expect(Math.round(mean)).toBe(47);
    expect(Object.keys(row)).not.toContain('mean');
    expect(Object.keys(row)).not.toContain('avg');
  });

  it('puts the worst p95 first, because the top row is the answer to "what do I fix"', () => {
    const out = summarise({
      interactions: [sample('palette-open', 5), sample('session-switch', 300), sample('keystroke', 40)],
      longTasks: [],
      keystrokes: null,
      loop: null,
    });
    expect(out.interactions.map((i) => i.name)).toEqual([
      'session-switch',
      'keystroke',
      'palette-open',
    ]);
  });

  it('breaks ties on the name, so two openings of the dialog agree', () => {
    const out = summarise({
      interactions: [sample('settings-open', 10), sample('palette-open', 10)],
      longTasks: [],
      keystrokes: null,
      loop: null,
    });
    expect(out.interactions.map((i) => i.name)).toEqual(['palette-open', 'settings-open']);
  });

  it('omits an interaction nobody performed rather than showing it as 0', () => {
    // A row of zeros reads as "this is fast". It is not measured, and the
    // screen must not let those two look alike.
    const out = summarise({
      interactions: [sample('keystroke', 10)],
      longTasks: [],
      keystrokes: null,
      loop: null,
    });
    expect(out.interactions).toHaveLength(1);
    expect(PERF_INTERACTIONS.length).toBeGreaterThan(1);
  });

  it('totals long tasks and keeps the worst single one', () => {
    const longTasks: PerfLongTask[] = [
      { at: 1, ms: 60 },
      { at: 2, ms: 180 },
      { at: 3, ms: 55 },
    ];
    const out = summarise({ interactions: [], longTasks, keystrokes: null, loop: null });
    expect(out.longTasks).toEqual({ count: 3, totalMs: 295, worstMs: 180 });
  });

  it('distinguishes "tier 2 was off" from "tier 2 found nothing"', () => {
    // null and an empty array are different sentences and the dialog says
    // different things about them. Collapsing them would tell the owner his
    // capture found no layout reads on a day he never switched it on.
    expect(summarise({ interactions: [], longTasks: [], keystrokes: null, loop: null }).detail).toBeNull();

    const measured = summarise({ interactions: [], longTasks: [], keystrokes: [], loop: null });
    expect(measured.detail).not.toBeNull();
    expect(measured.detail?.keystrokes).toBe(0);
  });

  it('sums layout reads across keystrokes — #739’s contract says the total is 0', () => {
    const out = summarise({
      interactions: [],
      longTasks: [],
      keystrokes: [keystroke({ layoutReads: 0 }), keystroke({ layoutReads: 3 })],
      loop: null,
    });
    expect(out.detail?.layoutReads).toBe(3);
  });

  it('keeps the LARGEST transcript a sample was taken against, not the last', () => {
    // The premise of the whole epic is that cost scales with these, so the
    // number that matters is the worst case the owner actually reached.
    const out = summarise({
      interactions: [],
      longTasks: [],
      keystrokes: [
        keystroke({ blocks: 400, rendered: 120 }),
        keystroke({ blocks: 12, rendered: 12 }),
      ],
      loop: null,
    });
    expect(out.detail?.maxBlocks).toBe(400);
    expect(out.detail?.maxRendered).toBe(120);
  });

  it('carries main’s event-loop delay through untouched', () => {
    const loop = { p50: 1.2, p99: 48, maxMs: 310 };
    expect(summarise({ interactions: [], longTasks: [], keystrokes: null, loop }).loop).toEqual(loop);
  });
});

describe('the batch shape (#923)', () => {
  it('an empty batch is empty, and one sample stops it being empty', () => {
    const b = emptyBatch(100);
    expect(b.at).toBe(100);
    expect(batchIsEmpty(b)).toBe(true);

    b.longTasks.push({ at: 1, ms: 60 });
    expect(batchIsEmpty(b)).toBe(false);
  });

  it('guards the interaction name at the boundary', () => {
    expect(isPerfInteraction('keystroke')).toBe(true);
    for (const junk of ['Keystroke', '', null, 3, {}, 'prompt text here'])
      expect(isPerfInteraction(junk), JSON.stringify(junk)).toBe(false);
  });
});

describe('stringLeaves — the local-only assertion (#923)', () => {
  it('finds a string however deeply it is buried', () => {
    expect(stringLeaves({ a: [{ b: ['deep'] }] })).toContain('deep');
  });

  it('finds KEYS too — a per-file metric would hide content there', () => {
    // `{"/home/dan/secret.ts": 3}` is exactly the shape a well-meaning
    // "cost per file" addition would take, and the value side is a number.
    expect(stringLeaves({ '/home/dan/secret.ts': 3 })).toContain('/home/dan/secret.ts');
  });

  it('a real batch carries no string but the interaction names we declared', () => {
    // THE test the local-only constraint reduces to. Every string in a flushed
    // batch has to come from `PERF_INTERACTIONS`; anything else is content that
    // found a way in.
    const batch = emptyBatch(1000);
    batch.interactions.push(sample('keystroke', 12, 900), sample('session-switch', 140, 950));
    batch.longTasks.push({ at: 940, ms: 90 });
    batch.keystrokes.push(keystroke({ blocks: 400, rendered: 120, draftLength: 2048 }));

    const allowed = new Set<string>([
      ...PERF_INTERACTIONS,
      // structural keys, all authored here
      'at',
      'ms',
      'name',
      'interactions',
      'longTasks',
      'keystrokes',
      'blockedMs',
      'layoutReads',
      'blocks',
      'rendered',
      'draftLength',
    ]);
    for (const s of stringLeaves(JSON.parse(JSON.stringify(batch)))) {
      expect(allowed.has(s), `unexpected string in a capture batch: ${JSON.stringify(s)}`).toBe(
        true
      );
    }
  });

  it('draftLength is a NUMBER — the one place text could have leaked', () => {
    const k = keystroke({ draftLength: 2048 });
    expect(typeof k.draftLength).toBe('number');
    expect(stringLeaves(k).filter((s) => s === 'draftLength')).toHaveLength(1);
  });
});

describe('summaryAsText — what a filed issue and the zip both read (#927)', () => {
  const full = (): Parameters<typeof summaryAsText>[0] =>
    summarise({
      interactions: [sample('keystroke', 41), sample('session-switch', 140)],
      longTasks: [{ at: 1, ms: 90 }],
      keystrokes: [keystroke({ blocks: 412, rendered: 120, layoutReads: 0 })],
      loop: { p50: 1.2, p99: 48, maxMs: 310 },
    });

  it('carries percentiles and the worst, and still offers no mean', () => {
    const text = summaryAsText(full());
    expect(text).toContain('p50');
    expect(text).toContain('p95');
    expect(text).toContain('worst');
    expect(text.toLowerCase()).not.toContain('mean');
    expect(text.toLowerCase()).not.toContain('average');
  });

  it('says "nothing measured" rather than printing an empty table', () => {
    const text = summaryAsText(
      summarise({ interactions: [], longTasks: [], keystrokes: null, loop: null })
    );
    expect(text).toMatch(/No interactions were measured/);
  });

  it('distinguishes the switch being OFF from it finding nothing', () => {
    // The sentence that decides whether the reader should ask for more. A
    // report filed with the switch off is not a report that found nothing.
    expect(summaryAsText(summarise({ interactions: [], longTasks: [], keystrokes: null, loop: null })))
      .toMatch(/Detailed capture was OFF/);
    expect(summaryAsText(summarise({ interactions: [], longTasks: [], keystrokes: [], loop: null })))
      .toMatch(/Detailed capture was ON/);
  });

  it('shouts when layout was read while typing, and is quiet when it was not', () => {
    // The one line with a contract behind it: PR #739 guarantees zero, so any
    // number is that fix having regressed — the most actionable thing a report
    // about slowness can carry.
    expect(summaryAsText(full())).toMatch(/Layout reads while typing: 0/);

    const bad = summarise({
      interactions: [],
      longTasks: [],
      keystrokes: [keystroke({ layoutReads: 7 })],
      loop: null,
    });
    expect(summaryAsText(bad)).toMatch(/EXPECTED 0/);
    expect(summaryAsText(bad)).toMatch(/#739/);
  });

  it('says main was not measured yet rather than printing zeros', () => {
    const text = summaryAsText(
      summarise({ interactions: [], longTasks: [], keystrokes: null, loop: null })
    );
    expect(text).toMatch(/not measured yet/);
  });

  it('THE LOCAL-ONLY ASSERTION: every word is ours, a number, or a unit', () => {
    // This text goes into a GITHUB ISSUE — the one place in the app where local
    // data leaves the machine on purpose. So the check is a walk over the
    // rendered output rather than a read-through: the dangerous field is the one
    // someone adds in six months, and this goes red when it appears.
    const text = summaryAsText(full());
    const allowed = new Set<string>([
      ...PERF_INTERACTIONS,
      'Responsiveness',
      'this',
      'window',
      'since',
      'it',
      'opened',
      'action',
      'count',
      'p50',
      'p95',
      'p99',
      'max',
      'worst',
      'ms',
      'No',
      'interactions',
      'were',
      'measured',
      'Long',
      'tasks',
      'none',
      'the',
      'app',
      'was',
      'never',
      'too',
      'busy',
      'to',
      'redraw',
      'total',
      'Main-process',
      'event-loop',
      'delay',
      'not',
      'yet',
      'read',
      'once',
      'a',
      'minute',
      'Detailed',
      'capture',
      'OFF',
      'ON',
      'so',
      'keystrokes',
      'and',
      'layout',
      'Layout',
      'work',
      'sampled',
      'largest',
      'conversation',
      'blocks',
      'rendered',
      'blocked',
      'reads',
      'while',
      'typing',
      'as',
      'expected',
      'EXPECTED',
      'This',
      'is',
      'PR',
      '#739',
      'having',
      'regressed',
    ]);
    const words = text
      .replace(/[(),.:]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .filter((w) => !/^-?\d+(\.\d+)?$/.test(w));
    for (const w of words)
      expect(allowed.has(w), `unexpected word in a report body: ${JSON.stringify(w)}`).toBe(true);
  });
});

describe('sanitizeSummary — the boundary the issue body sits behind (#927)', () => {
  it('refuses anything that is not a summary', () => {
    for (const junk of [null, undefined, 'text', 7, []])
      expect(sanitizeSummary(junk), JSON.stringify(junk)).toBeNull();
  });

  it('REBUILDS — an extra property cannot ride along into a public issue', () => {
    const out = sanitizeSummary({
      prompt: 'the secret project plan',
      interactions: [
        { name: 'keystroke', count: 1, p50: 1, p95: 1, worst: 1, file: '/home/dan/x.ts' },
      ],
      longTasks: { count: 0, totalMs: 0, worstMs: 0 },
      detail: null,
      loop: null,
    });
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(JSON.stringify(out)).not.toContain('/home/dan');
    expect(Object.keys(out!.interactions[0]).sort()).toEqual([
      'count',
      'name',
      'p50',
      'p95',
      'worst',
    ]);
  });

  it('drops a row whose interaction name we never declared', () => {
    const out = sanitizeSummary({
      interactions: [
        { name: 'keystroke', count: 1, p50: 1, p95: 1, worst: 1 },
        { name: 'my project name', count: 1, p50: 1, p95: 1, worst: 1 },
      ],
    });
    expect(out?.interactions).toHaveLength(1);
  });

  it('keeps null detail as null — off and empty are different reports', () => {
    expect(sanitizeSummary({ detail: null })?.detail).toBeNull();
    expect(sanitizeSummary({ detail: { keystrokes: 3 } })?.detail?.keystrokes).toBe(3);
  });

  it('rejects NaN and Infinity, which JSON writes as null', () => {
    const out = sanitizeSummary({
      loop: { p50: Number.NaN, p99: 1, maxMs: 1 },
      longTasks: { count: Number.POSITIVE_INFINITY, totalMs: 1, worstMs: 1 },
    });
    expect(out?.loop).toBeNull();
    expect(out?.longTasks.count).toBe(0);
  });
});
