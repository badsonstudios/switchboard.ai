// #923 probe: what does E21's own instrumentation cost?
//
// The item's done-when says the always-on tier must record "with no measurable
// cost — shown with a before/after number, not asserted". This is that number,
// taken in a REAL Chromium renderer inside the real app, because the whole
// premise of E21 is that we stopped trusting numbers from anywhere else.
//
// Local-only, not a CI job: it is a measurement, and a measurement whose result
// is a threshold assertion on a shared runner is a flaky test wearing a
// probe's coat. The findings go in `spike/findings/e21-923-instrument-cost.md`.
//
// Run: copy into e2e/, `npm run build`,
//      `npx playwright test e2e/perf-cost.spec.ts --reporter=list`
import { test } from '@playwright/test';
import path from 'path';
import { launchApp, tempProjectFolder } from './fixtures/app';

/** keystrokes per phase. Enough that a per-key cost of microseconds shows up. */
const KEYS = 400;

interface Phase {
  name: string;
  /** wall clock for the whole paced run — frame-bound, so mostly vsync */
  totalMs: number;
  /**
   * The number that actually answers the question: JS time spent INSIDE the
   * dispatch, summed over every key, with the frame waits excluded. The paced
   * wall clock is ~16.7ms/key at 60Hz no matter what we do, which would hide a
   * cost of anything under a frame — i.e. exactly the range in question.
   */
  workMs: number;
  perKeyWorkMs: number;
  /** cost of ONE layout-forcing read, in nanoseconds — tier 2's residual tax */
  layoutReadNs: number;
  longTasks: number;
  longTaskMs: number;
}

test('#923 — the cost of the instrument', async () => {
  test.setTimeout(240_000);
  const folder = tempProjectFolder();
  const a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });

  try {
    const w = a.window;
    await w.getByText(path.basename(folder)).first().waitFor({ timeout: 25_000 });
    const box = w.getByPlaceholder(/Prompt this session/).first();
    await box.waitFor({ timeout: 25_000 });
    await box.click();

    /**
     * Type into the composer from inside the page and time it.
     *
     * In-page rather than through Playwright's keyboard: the CDP round trip per
     * key is far larger than the thing being measured and would drown it. The
     * events are real `keydown` + `input` on the real element, dispatched the
     * way the recorder sees them, which is what matters here.
     */
    const phase = async (name: string, extraObservers: boolean): Promise<Phase> =>
      w.evaluate(
        async ({ name, extraObservers, KEYS }) => {
          const el = document.querySelector<HTMLTextAreaElement>('.composer-box')!;
          const observers: PerformanceObserver[] = [];
          const seen: { at: number; ms: number }[] = [];

          if (extraObservers) {
            // A SECOND, identical pair beside the app's own. Tier 1's observers
            // are already running in every phase and cannot be turned off from
            // here, so this measures the marginal cost of one more of exactly
            // the same thing — a deliberate OVER-estimate of tier 1.
            for (const type of ['longtask', 'event']) {
              try {
                const ob = new PerformanceObserver((list) => {
                  for (const e of list.getEntries()) seen.push({ at: e.startTime, ms: e.duration });
                });
                ob.observe(
                  type === 'event'
                    ? ({ type, buffered: true, durationThreshold: 16 } as PerformanceObserverInit)
                    : { type, buffered: true }
                );
                observers.push(ob);
              } catch {
                /* an entry type this build does not know is not a failure here */
              }
            }
          }

          const tasks: number[] = [];
          const watcher = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) tasks.push(e.duration);
          });
          try {
            watcher.observe({ type: 'longtask', buffered: false });
          } catch {
            /* no longtask support: the count simply stays 0 */
          }

          // The native value setter, so React's value tracker does not swallow
          // the change — the same trick `FeedView.composer.test.tsx` uses.
          const setValue = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value'
          )!.set!;

          const nextFrame = (): Promise<void> =>
            new Promise((r) => requestAnimationFrame(() => setTimeout(() => r(), 0)));

          await nextFrame();
          const t0 = performance.now();
          let workMs = 0;
          for (let i = 0; i < KEYS; i += 1) {
            const k0 = performance.now();
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
            setValue.call(el, `${el.value}a`);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            workMs += performance.now() - k0;
            // One frame per key: typing is paced by paints, and a tight loop
            // with no frame between would measure JS throughput instead.
            await nextFrame();
          }
          const totalMs = performance.now() - t0;
          await nextFrame();

          // Tier 2's residual tax, measured on its own: while the detailed tier
          // is on, every layout-forcing read app-wide goes through a wrapper
          // that tests one boolean. This prices that wrapper.
          //
          // The read is INVALIDATED each time (a style write on a throwaway
          // node), or the engine answers the second and every later read from a
          // cached layout and we would be pricing a property lookup instead of
          // a forced layout — which is the thing #739 is about.
          const scratch = document.createElement('div');
          scratch.style.cssText = 'position:absolute;inset-block-start:-9999px';
          document.body.append(scratch);
          const READS = 4_000;
          const r0 = performance.now();
          let sink = 0;
          for (let i = 0; i < READS; i += 1) {
            scratch.style.inlineSize = `${i % 17}px`;
            sink += el.scrollHeight;
          }
          const layoutReadNs = ((performance.now() - r0) / READS) * 1e6;
          scratch.remove();
          if (sink < 0) throw new Error('unreachable');

          watcher.disconnect();
          for (const ob of observers) ob.disconnect();
          setValue.call(el, '');
          el.dispatchEvent(new Event('input', { bubbles: true }));

          return {
            name,
            totalMs: Math.round(totalMs),
            workMs: Math.round(workMs * 100) / 100,
            perKeyWorkMs: Math.round((workMs / KEYS) * 10000) / 10000,
            layoutReadNs: Math.round(layoutReadNs),
            longTasks: tasks.length,
            longTaskMs: Math.round(tasks.reduce((n, d) => n + d, 0)),
          };
        },
        { name, extraObservers, KEYS }
      );

    const setCapture = async (on: boolean): Promise<void> => {
      await w.evaluate(
        async (on) =>
          (
            window as unknown as {
              switchboard?: { settings?: { setPerfCapture?: (v: boolean) => Promise<boolean> } };
            }
          ).switchboard?.settings?.setPerfCapture?.(on),
        on
      );
      // The renderer loads/unloads tier 2 on main's answer; give it a beat.
      await w.waitForTimeout(500);
    };

    // INTERLEAVED, and reported as a median of mins rather than as one run.
    // The first pass through this code path is slower than every later one (JIT,
    // cold layout), so a straight "off then on" ordering reports warm-up as the
    // instrument's cost — the first draft of this probe did exactly that and
    // made tier 2 look FASTER than no tier 2 at all.
    const ROUNDS = 5;
    const off: Phase[] = [];
    const on: Phase[] = [];

    await phase('warmup', false);
    await phase('warmup', false);

    for (let r = 0; r < ROUNDS; r += 1) {
      await setCapture(false);
      off.push(await phase('tier 1 only', false));
      await setCapture(true);
      on.push(await phase('tier 1 + tier 2', false));
    }
    await setCapture(false);

    const extra = await phase('tier 1 + a second identical observer pair', true);

    const median = (xs: number[]): number => {
      const v = [...xs].sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)]!;
    };
    const report = (label: string, rows: Phase[]): void => {
      // eslint-disable-next-line no-console -- a probe's entire output
      console.log(
        `${label.padEnd(30)} per-key work: min ${Math.min(...rows.map((r) => r.perKeyWorkMs)).toFixed(4)} ms  ` +
          `median ${median(rows.map((r) => r.perKeyWorkMs)).toFixed(4)} ms   |   ` +
          `one forced layout read: min ${Math.min(...rows.map((r) => r.layoutReadNs))} ns  ` +
          `median ${median(rows.map((r) => r.layoutReadNs))} ns`
      );
    };

    // eslint-disable-next-line no-console -- a probe's entire output
    console.log(`
#923 instrument cost — ${KEYS} keys × ${ROUNDS} interleaved rounds
`);
    report('capture OFF (shipped)', off);
    report('capture ON (tier 2)', on);
    report('one extra observer pair', [extra]);

  } finally {
    await a.app.close();
  }
});
