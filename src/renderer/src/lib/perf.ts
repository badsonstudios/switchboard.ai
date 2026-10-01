/**
 * E21 tier 1 — the always-on recorder (#923).
 *
 * ## What "always on" costs, and why that is defensible
 *
 * Nothing here measures anything itself. `PerformanceObserver` is the browser
 * reporting work it had already done and already timed: long tasks come off the
 * scheduler, and input-to-next-paint comes off the Event Timing pipeline. Our
 * cost is an array push per entry, a few times a second at worst, and no IPC at
 * all while the capture switch is off — the buffers exist only so the palette
 * command has something to show.
 *
 * That last point is what keeps tier 1 honest: with the switch off this module
 * talks to nobody, writes nothing, and holds two bounded arrays.
 *
 * ## Tier 2 is not in this file, and that is the design
 *
 * `setDetailEnabled(true)` is the ONLY path to the detailed instrumentation,
 * and it reaches it through a dynamic `import()`. With the switch off,
 * `perf-detail.ts` is never evaluated: no listener is registered, no prototype
 * is patched, and — the part that actually matters — the composer's keystroke
 * path contains no perf code to branch on, because the instrumentation attaches
 * from OUTSIDE the React tree rather than being called from inside it.
 *
 * This is the owner's rule 2 ("off means genuinely absent, not a flag checked
 * per keystroke") expressed as a module boundary instead of as a comment, and
 * `perf.absent.test.ts` is what holds it to that.
 */
import {
  emptyBatch,
  summarise,
  type PerfBatch,
  type PerfContext,
  type PerfInteraction,
  type PerfKeystroke,
  type PerfLongTask,
  type PerfLoopDelay,
  type PerfSample,
  type PerfSummary,
} from '../../../shared/perf';

/**
 * How much we keep for the on-screen summary. A working day at tier 2 produces
 * far more than this; the FILE is the record, and these buffers only have to
 * answer "is it better than it was ten minutes ago?" without growing without
 * bound in a process that is already the memory-hungry one.
 */
const MAX_RECENT = 5_000;
/**
 * ⚠️ EACH OF THESE NOW CARRIES A CONTEXT OBJECT (#1031) — about 0.3 MB per window
 * at the cap, held in the process whose memory growth is itself under
 * investigation (#1013). Accepted rather than overlooked: the capture FILE wants
 * every one of them, and only the worst reaches the summary screen. If a memory
 * hunt ever lands here, this is the trade it is looking at.
 */
const MAX_RECENT_LONG_TASKS = 2_000;

/** How often a capture batch goes to main. Only ticks while the switch is on. */
export const FLUSH_MS = 5_000;

/**
 * Event Timing's floor. The spec rounds `duration` to the nearest 8ms and will
 * not report below 16ms at all, so this is the smallest threshold that means
 * anything — and 16ms is also the budget E21-03 will judge typing against.
 */
const EVENT_THRESHOLD_MS = 16;

/** Key events we count as a keystroke. */
const KEY_EVENTS = new Set(['keydown', 'keypress', 'input']);

interface Stream<T> {
  /** capped, for the summary screen */
  recent: T[];
  /** drained on every flush, for the file */
  pending: T[];
}

function stream<T>(): Stream<T> {
  return { recent: [], pending: [] };
}

function push<T>(s: Stream<T>, item: T, cap: number): void {
  s.recent.push(item);
  if (s.recent.length > cap) s.recent.shift();
  s.pending.push(item);
  // The pending list is bounded too. If main stops answering we drop the
  // OLDEST, because a capture of the last ten minutes beats a capture of the
  // ten minutes after launch.
  if (s.pending.length > cap) s.pending.shift();
}

/** What tier 2 hands back when it is loaded. */
export interface DetailSource {
  /** keystroke samples kept for the summary screen */
  recent: () => readonly PerfKeystroke[];
  /** keystroke samples not yet written to the file */
  drain: () => PerfKeystroke[];
  uninstall: () => void;
}

/** The bridge calls tier 1 needs. Injected so a test can drive it. */
export interface PerfHost {
  record: (batch: PerfBatch) => void;
  mainStats: () => Promise<PerfLoopDelay | null>;
  /**
   * How many sessions are mid-reply right now (#1031). Optional: a test need not
   * supply it, and an absent count must read as "not known" rather than as zero.
   *
   * Asked for as a CALLBACK and called only from the long-task observer, which
   * is what keeps the store out of the keystroke path. #1013's central claim is
   * that renderer cost follows reply activity rather than open-session count;
   * this is the number that confirms or refutes it.
   */
  replyingCount?: () => number;
}

/** A non-negative count off a raw attribute value; 0 for a missing one. */
function count(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * What the renderer was holding, read at long-task observation time (#1031).
 *
 * ⚠️ EVERY READ IN HERE IS FREE OR NEARLY SO, AND THAT IS A REQUIREMENT, not a
 * happy accident. `querySelectorAll` and `getAttribute` walk and read; neither
 * forces style or layout, so this cannot turn an observation into the thing it
 * is observing. No `getBoundingClientRect`, no `offsetHeight`, nothing that
 * would make the recorder the reason the app is slow.
 *
 * It runs only when the platform has ALREADY finished timing a block of 50ms or
 * more, so its cost is bounded by how often the app is too busy to redraw —
 * i.e. it is cheap exactly when it matters that it is cheap, and if long tasks
 * are so frequent that this matters, the app has a far bigger problem that this
 * line is there to describe.
 */
function sampleContext(): PerfContext | undefined {
  const ctx: PerfContext = {};
  try {
    // The feed publishes these unconditionally (`FeedView`'s `data-perf-*`), so
    // there is nothing to turn on and no cooperation to arrange. Several cards
    // means several roots; they are summed because the main thread is shared and
    // the question is what the WINDOW was holding.
    const roots = document.querySelectorAll('[data-perf-blocks]');
    ctx.feeds = roots.length;
    if (roots.length > 0) {
      let blocks = 0;
      let rendered = 0;
      for (const root of roots) {
        // ⚠️ THE HAZARD IS `Number(null) === 0`, not a sentinel (review). An
        // earlier comment here blamed a `-1` that `FeedView` never publishes —
        // `-1` is `perf-detail`'s own marker for a missing attribute, not the
        // feed's. The real trap: a root matching `[data-perf-blocks]` with no
        // `data-perf-rendered` yields `null`, and `Number(null)` is a finite 0
        // that would be summed as a measurement nobody took. So the RAW
        // attribute is tested, and a missing one contributes nothing.
        blocks += count(root.getAttribute('data-perf-blocks'));
        rendered += count(root.getAttribute('data-perf-rendered'));
      }
      ctx.blocks = blocks;
      ctx.rendered = rendered;
    }
  } catch {
    // A diagnostic that throws into a PerformanceObserver callback is worse than
    // a diagnostic that reports less.
  }
  try {
    const replying = host?.replyingCount?.();
    if (typeof replying === 'number' && Number.isFinite(replying)) ctx.replying = replying;
  } catch {
    // ditto: the host's own counter must not cost us the rest of the sample
  }
  try {
    // Chromium-only and gated behind a flag in some builds, hence the guard
    // rather than a type assertion. MB rather than bytes: #1013's number is
    // "1.2 GB" and nobody reads 1288490188.
    const mem = (performance as { memory?: { usedJSHeapSize?: number } }).memory;
    const used = mem?.usedJSHeapSize;
    if (typeof used === 'number' && Number.isFinite(used)) {
      ctx.heapMb = Math.round(used / (1024 * 1024));
    }
  } catch {
    // ditto
  }
  return Object.keys(ctx).length === 0 ? undefined : ctx;
}

const interactions = stream<PerfSample>();
const longTasks = stream<PerfLongTask>();

let host: PerfHost | null = null;
let observers: PerformanceObserver[] = [];
let detail: DetailSource | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let loop: PerfLoopDelay | null = null;
let installed = false;
/** when tier 1 was installed, so a replayed long task is not given today's context */
let installedAt = 0;
/** one context per observer callback: `undefined` = not yet taken, `null` = none */
let batchCtx: PerfContext | null | undefined;

const now = (): number => performance.now();

/** Record one finished interaction. */
export function recordInteraction(name: PerfInteraction, ms: number, at: number): void {
  push(interactions, { name, ms, at }, MAX_RECENT);
}

/**
 * Time from now until the next paint, and file it under `name`.
 *
 * The rAF-then-task trick is the standard approximation for "after the pixels
 * changed": a `requestAnimationFrame` callback runs BEFORE the frame is
 * painted, so a task queued from inside it is the first thing to run after.
 * It is an approximation and it is good to about a frame, which is the right
 * precision for a 100ms budget.
 */
export function measureToPaint(name: PerfInteraction): void {
  const t0 = now();
  requestAnimationFrame(() => {
    setTimeout(() => {
      // A window that is not being painted does not report on this app's
      // responsiveness. Chromium throttles `requestAnimationFrame` to nothing
      // when a window is minimised or occluded, so a sample that resolves while
      // hidden measures how long the window was away — and `session-switch` can
      // reach that state deliberately, because focusing a popped-out session
      // RAISES ANOTHER OS WINDOW and backgrounds this one. Left in, a
      // multi-second fabrication would land in the summary's `worst` column
      // under the one row the owner is told to read first.
      if (document.visibilityState === 'hidden') return;
      recordInteraction(name, now() - t0, t0);
    }, 0);
  });
}

/**
 * Cold start, measured from the renderer's own time origin.
 *
 * `performance.now()` at the moment the first window is usable IS the duration,
 * with no start mark needed — the origin is when the document began loading.
 */
export function recordColdStart(): void {
  // Once. A pop-out window mounting its own App later is not a cold start, and
  // recording it as one would put a 40ms sample beside a 3-second one under the
  // same name.
  if (interactions.recent.some((s) => s.name === 'cold-start')) return;
  recordInteraction('cold-start', now(), 0);
}

/** Long tasks overlapping a window, in milliseconds. Tier 2's correlation. */
export function blockedMsBetween(from: number, to: number): number {
  let total = 0;
  // Walk from the end: the caller is always asking about the last few hundred
  // milliseconds, and the buffer holds the last few thousand entries.
  for (let i = longTasks.recent.length - 1; i >= 0; i -= 1) {
    const t = longTasks.recent[i];
    if (t.at + t.ms < from) break;
    const overlap = Math.min(to, t.at + t.ms) - Math.max(from, t.at);
    if (overlap > 0) total += overlap;
  }
  return total;
}

/**
 * `durationThreshold` is Event Timing's, and TypeScript's DOM lib does not
 * carry it. Declared here rather than cast at the call site so the one place
 * that lies to the type system is the one place that has to.
 */
interface ObserveInit extends PerformanceObserverInit {
  durationThreshold?: number;
}

function observe(type: string, init: ObserveInit, onEntry: (e: never) => void): void {
  try {
    const ob = new PerformanceObserver((list) => {
      // One context sample per CALLBACK, shared by every entry in it (#1031).
      // Cleared here rather than inside the long-task handler so the handler
      // stays a pure "record this entry" and the batch boundary lives at the
      // boundary.
      batchCtx = undefined;
      try {
        for (const entry of list.getEntries()) onEntry(entry as never);
      } finally {
        batchCtx = undefined;
      }
    });
    ob.observe({ type, ...init });
    observers.push(ob);
  } catch {
    // An entry type this build of Chromium does not support is not a reason to
    // lose the ones it does. Fail-open is a hard constraint and it applies to
    // our own diagnostics first.
  }
}

/**
 * Install tier 1. Called once, from the renderer's boot.
 *
 * Safe to call again — a second call is ignored rather than doubling every
 * sample, which is the failure a pop-out window would otherwise cause.
 */
export function installPerf(h: PerfHost): void {
  if (installed) return;
  installed = true;
  installedAt = now();
  host = h;

  observe('longtask', { buffered: true }, (entry: PerformanceEntry) => {
    // `buffered: true` replays tasks from before this observer existed, and
    // sampling the context for those would date-stamp the present onto the past
    // — a block that happened during start-up would be reported as having
    // happened with whatever is mounted now. `startTime` is in the same clock as
    // `now()`, so "did this task end before we installed" is answerable (#1031).
    const stale = entry.startTime + entry.duration < installedAt;
    // ONCE PER CALLBACK, not once per entry (review). A batch of N long tasks
    // would otherwise walk the document N times for N identical answers — and a
    // batch is likeliest under exactly the load this is here to diagnose.
    // `batchCtx` is cleared by the wrapper in `observe`.
    if (!stale && batchCtx === undefined) batchCtx = sampleContext() ?? null;
    const ctx = stale ? null : batchCtx;
    push(
      longTasks,
      { at: entry.startTime, ms: entry.duration, ...(ctx ? { ctx } : {}) },
      MAX_RECENT_LONG_TASKS
    );
  });

  // Event Timing. `duration` is the platform's own input-to-next-paint, which
  // is the number this item was asked for and is measured far more accurately
  // than anything we could time from script.
  observe(
    'event',
    { buffered: true, durationThreshold: EVENT_THRESHOLD_MS },
    (entry: PerformanceEntry) => {
      if (!KEY_EVENTS.has(entry.name)) return;
      push(interactions, { name: 'keystroke', ms: entry.duration, at: entry.startTime }, MAX_RECENT);
    }
  );
}

/** Tear tier 1 down. For tests and for a window closing. */
export function uninstallPerf(): void {
  for (const ob of observers) ob.disconnect();
  observers = [];
  installedAt = 0;
  batchCtx = undefined;
  stopFlushing();
  installed = false;
  host = null;
}

function stopFlushing(): void {
  if (flushTimer === null) return;
  clearInterval(flushTimer);
  flushTimer = null;
}

/** Send everything buffered to main, and empty the pending lists. */
export function flushPerf(): void {
  if (!host) return;
  const batch: PerfBatch = emptyBatch(now());
  batch.interactions = interactions.pending.splice(0);
  batch.longTasks = longTasks.pending.splice(0);
  batch.keystrokes = detail?.drain() ?? [];
  host.record(batch);
}

/**
 * Follow the Settings switch.
 *
 * The dynamic `import()` is the whole point: with the switch off,
 * `perf-detail.ts` has never been evaluated in this renderer. Turning it off
 * again uninstalls the listeners and restores the patched descriptors, so the
 * app returns to the shape it had before — not to a shape with dormant hooks in
 * it, which would leave the measurement permanently altered by having once been
 * taken.
 *
 * ## The generation counter is not defensive programming, it is the requirement
 *
 * Turning ON awaits a dynamic import — a real chunk fetch — while turning OFF is
 * synchronous. Without `generation`, ticking the box and immediately unticking
 * it left the off-path looking at a still-`null` `detail`, so it uninstalled
 * nothing; the import then resolved and installed the listener and the prototype
 * patches for the life of the renderer, while the checkbox, `workspace.json` and
 * `getPerfCapture()` all said OFF. That is requirement 1 failing by the letter,
 * from a mis-click.
 *
 * The on/off/on ordering was worse: the second `true` also passed the `!detail`
 * check, so tier 2 installed TWICE. The first source was orphaned with its
 * listener still attached, and the second captured the already-patched
 * descriptors as its "originals" — so switching off restored the accessors to
 * the orphan's wrapper rather than to the browser's, leaving a permanent
 * per-layout-read tax that nothing could remove.
 */
let generation = 0;

export async function setDetailEnabled(on: boolean): Promise<void> {
  const mine = (generation += 1);
  if (on) {
    if (detail) return;
    const mod = await import('./perf-detail');
    // A later call overtook this one while the chunk was loading. Install
    // nothing: whatever that call decided is the current answer, and it has
    // already acted on it.
    if (mine !== generation || detail) return;
    detail = mod.installPerfDetail({ blockedMsBetween });
    if (flushTimer === null) flushTimer = setInterval(flushPerf, FLUSH_MS);
    return;
  }
  // One last flush so the tail of the capture is not lost to the click that
  // ended it.
  if (detail) flushPerf();
  detail?.uninstall();
  detail = null;
  stopFlushing();
}

/** True when tier 2 is loaded. Read by the test that pins "absent when off". */
export function detailLoaded(): boolean {
  return detail !== null;
}

/** Note main's latest event-loop numbers, for the summary screen. */
export function noteLoopDelay(value: PerfLoopDelay | null): void {
  loop = value;
}

/** Fetch main's numbers, then build what the palette command shows. */
export async function perfSummary(): Promise<PerfSummary> {
  if (host) {
    try {
      noteLoopDelay(await host.mainStats());
    } catch {
      // A refused or missing channel costs the loop row, not the screen.
    }
  }
  return summarise({
    interactions: interactions.recent,
    longTasks: longTasks.recent,
    keystrokes: detail ? [...detail.recent()] : null,
    loop,
  });
}

/** Test seam: forget everything recorded so far. */
export function resetPerfForTests(): void {
  interactions.recent = [];
  interactions.pending = [];
  longTasks.recent = [];
  longTasks.pending = [];
  loop = null;
}
