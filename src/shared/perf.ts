/**
 * E21's measurement vocabulary (#923) — shared by the renderer that records,
 * main that writes the file, and the dialog that reports.
 *
 * ## Local-only: this is instrumentation, not telemetry
 *
 * Nothing here leaves the machine, and the SHAPE is what makes that checkable
 * rather than promised. Every type below is closed: numbers, booleans, and
 * strings drawn from a fixed vocabulary declared in this file. There is no
 * free-text field anywhere in a sample, so a prompt, a file name or a line of a
 * conversation has nowhere to land even by accident. `stringLeaves()` exists so
 * a test can walk a real capture line and assert exactly that.
 *
 * The one length we do record is `draftLength` — a COUNT of characters, never
 * the characters. It is here because the whole premise of #716 is that cost
 * scales with how much is in the box and how much is scrolled above it, so a
 * keystroke sample without it cannot be ranked against another.
 *
 * ## Percentiles, never a mean
 *
 * The complaint E21 exists to answer is *bursts* — typing that runs fine and
 * then stalls. A mean is precisely the statistic that hides them: forty good
 * keystrokes and two 400ms ones average out to "fine". So `summarise()` reports
 * p50, p95 and the worst single sample, and offers no mean at all. That is a
 * deliberate omission, not a gap to fill later.
 */

/**
 * The named interactions we measure, and the whole list.
 *
 * A CLOSED tuple on purpose (owner decision 3, E21): the failure mode this item
 * was warned about is a week spent building an open-ended measurement framework
 * that still cannot say why typing lags. Adding a name here is a deliberate
 * edit with a call site, not a string someone passes in.
 *
 * `keystroke` is the odd one out and is NOT measured through the interaction
 * path — it arrives from the platform's Event Timing entries in tier 1, and
 * from the detailed recorder in tier 2. It is named here so a summary can sort
 * it beside the rest.
 */
export const PERF_INTERACTIONS = [
  'cold-start',
  'keystroke',
  'session-switch',
  'palette-open',
  'settings-open',
] as const;

/**
 * NOT HERE, AND THE OMISSION IS DELIBERATE: `prompt-first-token`.
 *
 * #904's menu of named interactions includes "sending a prompt to first
 * streamed token", and it is a genuinely useful number. It is not measured,
 * because the only place to start and stop it is inside the composer and the
 * feed — and E21's rule 2 makes those two files the one place instrumentation
 * may not go, since a perf import there is how a keystroke call site arrives
 * six months later. Every other interaction below is timed from OUTSIDE the
 * React tree, which is what makes "off means absent" checkable.
 *
 * It is also not in this item's done-when, which lists #741's four. If E21-03's
 * findings point at prompt latency, the honest way to get it is a main-side
 * timestamp on the send and on the first stream frame — neither of which is in
 * the renderer at all. Filed as a note rather than a TODO, because "add a
 * measurement" is a decision for the item that needs it.
 */

export type PerfInteraction = (typeof PERF_INTERACTIONS)[number];

const INTERACTION_SET = new Set<string>(PERF_INTERACTIONS);

/**
 * Is this one of the names we measure?
 *
 * Guards the IPC boundary — `sanitizeBatch` in `main/diagnostics/perf-capture.ts`
 * calls it on every sample arriving from the renderer, which is what turns the
 * closed vocabulary above from a compile-time promise into a runtime one.
 */
export function isPerfInteraction(value: unknown): value is PerfInteraction {
  return typeof value === 'string' && INTERACTION_SET.has(value);
}

/**
 * One named interaction, start to the paint that followed it.
 *
 * `at` is milliseconds since the renderer booted, not a wall clock. It exists
 * to correlate a sample with the long tasks around it; a clock time would be a
 * fact about the user's day rather than about the app.
 */
export interface PerfSample {
  name: PerfInteraction;
  /** trigger to next paint, milliseconds */
  ms: number;
  /** milliseconds since renderer boot */
  at: number;
}

/** A main-thread block the platform reported as a long task (>50ms). */
export interface PerfLongTask {
  /** milliseconds since renderer boot */
  at: number;
  ms: number;
}

/**
 * Tier 2's per-keystroke sample — #741's four measurements, in one record.
 *
 * `layoutReads` is the one with a contract attached: PR #739's guarantee is
 * that typing reads no layout and writes no height, so a non-zero value here is
 * a regression of that fix rather than merely a slow number. The unit test
 * `FeedView.composer.test.tsx` asserts the same thing at build time; this is
 * the runtime form, on the machine that actually struggles.
 */
export interface PerfKeystroke {
  /** milliseconds since renderer boot */
  at: number;
  /** keydown to the paint that followed it */
  ms: number;
  /** long-task time overlapping this keystroke's window */
  blockedMs: number;
  /** layout-forcing reads during the window — #739's contract says 0 */
  layoutReads: number;
  /** blocks the transcript holds at sample time (the capped window, see lib/feed) */
  blocks: number;
  /** blocks actually in the DOM at sample time */
  rendered: number;
  /** characters in the draft — a LENGTH, never the text */
  draftLength: number;
}

/** Main-process event-loop delay, in milliseconds. */
export interface PerfLoopDelay {
  p50: number;
  p99: number;
  maxMs: number;
}

/**
 * What the renderer hands main to write, and what main writes as one line.
 *
 * Batched rather than per-sample: a capture that costs an IPC round trip per
 * keystroke would be measuring its own overhead, which is the failure this
 * whole item is built to avoid.
 */
export interface PerfBatch {
  /** milliseconds since renderer boot at flush time */
  at: number;
  interactions: PerfSample[];
  longTasks: PerfLongTask[];
  keystrokes: PerfKeystroke[];
}

/** An empty batch — the shape every flush starts from. */
export function emptyBatch(at: number): PerfBatch {
  return { at, interactions: [], longTasks: [], keystrokes: [] };
}

/** True when a batch holds nothing worth a line in the file. */
export function batchIsEmpty(b: PerfBatch): boolean {
  return b.interactions.length === 0 && b.longTasks.length === 0 && b.keystrokes.length === 0;
}

/** Per-interaction latency, as percentiles. There is no mean here on purpose. */
export interface PerfStat {
  name: PerfInteraction;
  count: number;
  p50: number;
  p95: number;
  /** the single worst sample — the burst the user actually noticed */
  worst: number;
}

/** What the palette command puts on screen. */
export interface PerfSummary {
  /** one row per interaction that has at least one sample, worst p95 first */
  interactions: PerfStat[];
  longTasks: { count: number; totalMs: number; worstMs: number };
  /**
   * Tier 2's extras, or `null` when the switch is off. `null` and "zero
   * samples" are different sentences and the dialog says different things
   * about them: one is "not measured", the other is "measured, nothing found".
   */
  detail: PerfDetailSummary | null;
  /** main's event-loop delay, or `null` when main has not answered yet */
  loop: PerfLoopDelay | null;
}

export interface PerfDetailSummary {
  keystrokes: number;
  /** layout-forcing reads seen during a keystroke — #739's contract says 0 */
  layoutReads: number;
  /** p95 of blocked time per keystroke */
  blockedP95: number;
  /** the largest transcript any sample was taken against */
  maxBlocks: number;
  /** the most blocks in the DOM at any sample */
  maxRendered: number;
}

/**
 * The p-th percentile of `values`, by nearest-rank on a copy.
 *
 * Nearest-rank rather than interpolation because every consumer here is a
 * latency figure the owner will compare against a budget, and an interpolated
 * p95 reports a duration that no keystroke actually took. Returns 0 for an
 * empty list — a percentile of nothing has no honest answer, and 0 is the value
 * the summary renders as "no samples" beside a count of 0.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // `ceil` is the standard nearest-rank rule: p100 lands on the last element,
  // and no percentile can index past the end. Note what this means for small
  // samples — p95 of 20 is the 19th value, so ONE stall in twenty does not move
  // p95 at all. That is not a bug, it is what p95 means, and it is why the
  // summary also reports `worst`: on a short capture the worst single sample is
  // the only place a rare burst shows up.
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

function round(n: number): number {
  // One decimal. A keystroke budget is 16ms; reporting 14.7 is useful and
  // reporting 14.7231 is noise that makes two numbers hard to compare by eye.
  return Math.round(n * 10) / 10;
}

/** Build the on-screen summary from raw samples. */
export function summarise(input: {
  interactions: readonly PerfSample[];
  longTasks: readonly PerfLongTask[];
  keystrokes: readonly PerfKeystroke[] | null;
  loop: PerfLoopDelay | null;
}): PerfSummary {
  const byName = new Map<PerfInteraction, number[]>();
  for (const s of input.interactions) {
    const list = byName.get(s.name);
    if (list) list.push(s.ms);
    else byName.set(s.name, [s.ms]);
  }

  const interactions: PerfStat[] = [];
  for (const [name, values] of byName) {
    interactions.push({
      name,
      count: values.length,
      p50: round(percentile(values, 50)),
      p95: round(percentile(values, 95)),
      worst: round(Math.max(...values)),
    });
  }
  // Worst p95 first: the point of the screen is "what should I fix", and the
  // answer is at the top rather than wherever the vocabulary happens to put it.
  // Ties break on the name so the order is stable between two openings.
  interactions.sort((a, b) => b.p95 - a.p95 || a.name.localeCompare(b.name));

  let totalMs = 0;
  let worstMs = 0;
  for (const t of input.longTasks) {
    totalMs += t.ms;
    if (t.ms > worstMs) worstMs = t.ms;
  }

  const ks = input.keystrokes;
  const detail: PerfDetailSummary | null =
    ks === null
      ? null
      : {
          keystrokes: ks.length,
          layoutReads: ks.reduce((n, k) => n + k.layoutReads, 0),
          blockedP95: round(percentile(ks.map((k) => k.blockedMs), 95)),
          // `-1` is `perf-detail`'s "the feed published no count", not a size.
          // Folding it in with `Math.max(n, ...)` from 0 is harmless, but a
          // capture taken entirely against feeds that said nothing must report
          // 0 rather than -1 — "held -1 blocks" is not a sentence.
          maxBlocks: ks.reduce((n, k) => Math.max(n, k.blocks), 0),
          maxRendered: ks.reduce((n, k) => Math.max(n, k.rendered), 0),
        };

  return {
    interactions,
    longTasks: {
      count: input.longTasks.length,
      totalMs: round(totalMs),
      worstMs: round(worstMs),
    },
    detail,
    loop: input.loop,
  };
}

/**
 * Every string anywhere inside `value`, however deeply nested.
 *
 * This exists for ONE purpose: a test walks a real capture line through it and
 * asserts that every string it finds is drawn from a fixed allowlist. That is
 * how "the file contains no prompt text, file names or session content" becomes
 * an assertion rather than a claim in a comment — the interesting case is not
 * the field someone added carelessly, it is the field someone adds in six
 * months, and a walk over the whole object catches that one too.
 */
export function stringLeaves(value: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      found.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v !== null && typeof v === 'object') {
      // KEYS as well as values. A key is authored by us and so is far less
      // likely to carry content, but `{"/home/dan/secret.ts": 3}` is exactly
      // the shape a well-meaning "per-file cost" metric would take, and this
      // walk is the thing that would have to notice it.
      for (const [k, item] of Object.entries(v)) {
        found.push(k);
        walk(item);
      }
    }
  };
  walk(value);
  return found;
}
