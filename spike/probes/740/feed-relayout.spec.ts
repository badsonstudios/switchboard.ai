// #740 probe: what does the un-skipped feed cost a keystroke, and can a
// MEASURED intrinsic size make skipping exact?
//
// Two questions, and the second is the one that decides the shape of the fix.
//
//   1. Reproduce the table in #740 on this machine, under a 4x CPU throttle, so
//      there is a "before" the new E21 telemetry can be ranked against (#904
//      phase 2 asks for before/after numbers, and #716's history is that a
//      plausible fix needs a measurement to be believed).
//   2. `content-visibility: auto` was tried, shipped to CI and REVERTED because
//      `contain-intrinsic-size: auto 80px` makes an unrendered block contribute
//      a GUESS — scrollHeight read +85% at 60 blocks and +127% at 400, and this
//      app has a pixel-exact scroll-restore contract (#442/#555). The record is
//      in `tokens.css` where `.feed-block` used to be. So: if every block
//      carries its OWN measured height instead of one global guess, does
//      scrollHeight come back exact?
//
// Local-only, not a CI job, for the same reason #923's probe is: this is a
// measurement, and a measurement whose result is a threshold assertion on a
// shared runner is a flaky test wearing a probe's coat. Findings go in
// `spike/findings/e21-740-feed-skipping.md`.
//
// Run: copy into e2e/, `npm run build`,
//      `npx playwright test e2e/feed-relayout.spec.ts --reporter=list --workers=1`
import { test } from '@playwright/test';
import path from 'path';
import { launchApp, streamPrompter, tempProjectFolder } from './fixtures/app';

/** keystrokes per phase — #740's own table counted long tasks over 43 keys */
const KEYS = 40;
/** the throttle #740's acceptance bar names */
const THROTTLE = 4;

interface Sample {
  mode: string;
  blocks: number;
  /**
   * JS time inside the dispatch. ⚠️ THE WRONG NUMBER ON ITS OWN, and the first
   * draft of this probe reported only this and concluded the bug was gone.
   * #739 removed the composer's FORCED synchronous layout, so since then the
   * relayout a keystroke causes happens at FRAME time, outside the dispatch —
   * this metric is blind to exactly the cost #740 is about.
   */
  medianDispatchMs: number;
  /** paced wall clock per key: one key per frame, so a slow frame shows up here */
  medianFrameMs: number;
  /**
   * The keystroke's layout bill, priced directly: flush the pending layout with
   * one read and time the flush. This is the thing #740 says scales with block
   * count.
   */
  medianLayoutMs: number;
  longTasks: number;
  longTaskMs: number;
  /** the scroller's reported height — the number the restore contract rides on */
  scrollHeight: number;
  /** how many composer height changes happened across the run */
  composerResizes: number;
}

test('#740 — the cost of the feed on a keystroke, and whether skipping can be exact', async () => {
  test.setTimeout(600_000);
  const folder = tempProjectFolder();
  const a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
  const title = path.basename(folder);

  try {
    const w = a.window;
    await w.getByText(title).first().waitFor({ timeout: 25_000 });
    const box = w.getByPlaceholder(/Prompt this session/).first();
    await box.waitFor({ timeout: 25_000 });
    await box.click();

    const cdp = await w.context().newCDPSession(w);
    const throttle = async (rate: number): Promise<void> => {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    };

    /**
     * One typing run, timed from inside the page.
     *
     * In-page rather than through Playwright's keyboard, exactly as #923's
     * probe does it: the CDP round trip per key is far larger than the thing
     * being measured and would drown it. The events are real `keydown` +
     * `input` on the real element.
     *
     * `mode` decides what the feed is doing while we type:
     *   'normal'      — as shipped
     *   'hidden'      — the content div display:none, i.e. #740's "feed skipped"
     *                   counterfactual, the floor any fix is measured against
     *   'cv-guess'    — content-visibility:auto + the reverted global 80px
     *   'cv-measured' — content-visibility:auto + each block's OWN measured
     *                   content-box height. The candidate fix.
     */
    const run = async (mode: string, draft: number): Promise<Sample> =>
      w.evaluate(
        async ({ mode, KEYS, draft }) => {
          const scroller = [...document.querySelectorAll<HTMLDivElement>('div')].find(
            (d) => d.getAttribute('data-feed-region') !== null
          )!;
          const content = scroller.firstElementChild as HTMLDivElement;
          const el = document.querySelector<HTMLTextAreaElement>('.composer-box')!;
          const blocks = [...scroller.querySelectorAll<HTMLElement>('[data-feed-block]')];

          // ⚠️ HOW MANY BLOCKS IS THE APP ITSELF STANDING ON A MEASURED HEIGHT?
          //
          // Read BEFORE anything below touches a style, because everything
          // below does. Once `useFeedSkipping` shipped, the `normal` row of
          // this table stopped meaning "as shipped": `clear()` strips exactly
          // the two properties the hook writes, so the row was measuring the
          // feature switched off and reported 26.4ms/key — unchanged — which
          // reads as "the fix does nothing" rather than "the probe undid it".
          // The `shipped` mode below is the honest after-number; this count is
          // how a reader can tell the two apart at a glance.
          const appStyled = blocks.filter(
            (b) => getComputedStyle(b).contentVisibility === 'auto'
          ).length;

          // ── put the feed into the mode under test ───────────────────────────
          const clear = (): void => {
            content.style.display = '';
            for (const b of blocks) {
              b.style.contentVisibility = '';
              b.style.containIntrinsicSize = '';
            }
          };
          // `shipped` is the one mode that touches NOTHING: it measures the app
          // exactly as a user has it.
          if (mode !== 'shipped') clear();
          // the truth, read with everything laid out — recorded BEFORE any mode
          // is applied so every row is compared against the same number
          const trueHeight = scroller.scrollHeight;

          if (mode === 'hidden') content.style.display = 'none';
          if (mode === 'cv-guess') {
            for (const b of blocks) {
              b.style.contentVisibility = 'auto';
              b.style.containIntrinsicSize = 'auto 80px';
            }
          }
          if (mode === 'cv-measured') {
            // MEASURE FIRST, WRITE SECOND. Interleaving a read and a write per
            // block would force one synchronous layout per block — 400 of them
            // — which is the very cost this is trying to remove, and it would
            // also make every height after the first one a measurement of a
            // half-applied state.
            //
            // The CONTENT box, not the border box: `contain-intrinsic-size`
            // gives the size of the content the element is standing in for, and
            // the used height then adds this element's own padding and border
            // back on top. Handing it `offsetHeight` would add the padding
            // twice — 8px per block, which at 400 blocks is 3,200px of invented
            // conversation and exactly the class of error that got the first
            // attempt reverted.
            const heights = blocks.map((b) => {
              const cs = getComputedStyle(b);
              const pad =
                parseFloat(cs.paddingBlockStart) +
                parseFloat(cs.paddingBlockEnd) +
                parseFloat(cs.borderBlockStartWidth) +
                parseFloat(cs.borderBlockEndWidth);
              return Math.max(0, b.getBoundingClientRect().height - pad);
            });
            blocks.forEach((b, i) => {
              b.style.contentVisibility = 'auto';
              b.style.containIntrinsicSize = `auto ${heights[i]!.toFixed(2)}px`;
            });
          }

          // ── type ────────────────────────────────────────────────────────────
          const tasks: number[] = [];
          const watcher = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) tasks.push(e.duration);
          });
          try {
            watcher.observe({ type: 'longtask', buffered: false });
          } catch {
            /* no longtask support: the count simply stays 0 */
          }

          const setValue = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value'
          )!.set!;
          const nextFrame = (): Promise<void> =>
            new Promise((r) => requestAnimationFrame(() => setTimeout(() => r(), 0)));

          // THE DRAFT MATTERS, and the first draft of this probe left it out.
          // #740's table says "long draft in the box"; typing into an EMPTY
          // composer never changes its height, so the feed's box never changes
          // and the relayout the item is about never happens. `composerResizes`
          // below is what caught it.
          setValue.call(el, draft ? `${'lorem ipsum dolor sit amet '.repeat(Math.ceil(draft / 27))}`.slice(0, draft) : '');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          await nextFrame();
          await nextFrame();

          const per: number[] = [];
          const frames: number[] = [];
          const layouts: number[] = [];
          let composerResizes = 0;
          let lastComposerH = el.offsetHeight;
          for (let i = 0; i < KEYS; i += 1) {
            const f0 = performance.now();
            const k0 = performance.now();
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
            setValue.call(el, `${el.value}a`);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            per.push(performance.now() - k0);
            // Price the relayout this keystroke just invalidated, by flushing it
            // with ONE read and timing the flush. Deliberately a layout-forcing
            // read: the pending work is the measurement.
            const l0 = performance.now();
            void scroller.scrollHeight;
            layouts.push(performance.now() - l0);
            await nextFrame();
            frames.push(performance.now() - f0);
            // Does typing change the composer's HEIGHT? If it does, the feed's
            // own box changes with it and a relayout is not the feed's fault at
            // all — a different bug with a different fix. Worth knowing before
            // building a virtualiser.
            if (el.offsetHeight !== lastComposerH) {
              composerResizes += 1;
              lastComposerH = el.offsetHeight;
            }
          }
          await nextFrame();
          watcher.disconnect();

          const scrollHeight = scroller.scrollHeight;
          // ⚠️ IS ANYTHING ACTUALLY BEING SKIPPED? Probe B asked the same
          // question in a different state and got "0 of 342" from two
          // independent witnesses, which cannot be squared with the `cv-guess`
          // row below inflating `scrollHeight` by +140.8%. One of the two
          // probes is wrong about something, and the way to find out which is
          // to put the witness inside the run that produced the claim.
          // Skipped contents have no boxes, so a child with a zero-height rect
          // is skipping observed rather than asked about.
          const skippedNow = blocks.filter(
            (b) =>
              b.lastElementChild instanceof HTMLElement &&
              b.lastElementChild.getBoundingClientRect().height === 0
          ).length;
          setValue.call(el, '');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          if (mode !== 'shipped') clear();
          await nextFrame();

          const med = (xs: number[]): number => {
            const v = [...xs].sort((x, y) => x - y);
            return Math.round(v[Math.floor(v.length / 2)]! * 100) / 100;
          };
          return {
            mode,
            blocks: blocks.length,
            medianDispatchMs: med(per),
            medianFrameMs: med(frames),
            medianLayoutMs: med(layouts),
            longTasks: tasks.length,
            longTaskMs: Math.round(tasks.reduce((n, d) => n + d, 0)),
            scrollHeight,
            skippedNow,
            appStyled,
            trueHeight,
            composerResizes,
          };
        },
        { mode, KEYS, draft }
      ) as Promise<Sample & { trueHeight: number }>;

    const rows: (Sample & { trueHeight: number })[] = [];
    const MODES = ['shipped', 'normal', 'hidden', 'cv-guess', 'cv-measured'];
    /** #740's conditions: "long draft in the box" */
    const DRAFT = 600;

    const sweep = async (label: string): Promise<void> => {
      await throttle(THROTTLE);
      // Warm-up: the first pass through any of this is slower than every later
      // one (JIT, cold layout), and #923's probe learned the hard way that a
      // straight ordering reports warm-up as a difference between modes.
      //
      // ⚠️ IN `shipped` MODE, WHICH IS THE ONLY ONE THAT DOES NOT CLEAR. This
      // used to warm up with `normal`, whose `clear()` strips the two
      // properties `useFeedSkipping` writes — and nothing puts them back until
      // the next block arrives, so the `shipped` row that followed measured the
      // app with its own feature wiped off and reported `appCV: 0` beside an
      // unchanged 26.4ms. The probe was disabling the thing it was there to
      // weigh.
      await run('shipped', DRAFT);
      for (const m of MODES) {
        const r = await run(m, DRAFT);
        rows.push({ ...r, mode: `${label} / ${m}` } as Sample & { trueHeight: number });
      }
      await throttle(1);
    };

    await sweep('0 blocks');

    await streamPrompter(a)(title, '!bulk 60 P740_A_');
    await w.getByText('P740_A_60', { exact: true }).waitFor({ timeout: 60_000 });
    await w.waitForTimeout(1_000);
    await sweep('60 blocks');

    for (let i = 0; i < 2; i += 1) {
      await streamPrompter(a)(title, `!bulk 170 P740_B${i}_`);
      await w.getByText(`P740_B${i}_170`, { exact: true }).waitFor({ timeout: 90_000 });
    }
    await w.waitForTimeout(1_500);
    await sweep('400 blocks');

    /* eslint-disable no-console -- a probe's entire output */
    console.log(`\n#740 — ${KEYS} keys per row, ${THROTTLE}x CPU throttle\n`);
    console.log(
      'row'.padEnd(26) +
        'blocks'.padStart(7) +
        'layout'.padStart(9) +
        'frame'.padStart(9) +
        'dispat'.padStart(8) +
        'longTk'.padStart(8) +
        'longMs'.padStart(8) +
        'scrollH'.padStart(9) +
        'true'.padStart(9) +
        'err%'.padStart(8) +
        'skipped'.padStart(9) +
        'appCV'.padStart(7) +
        'resizes'.padStart(9)
    );
    for (const r of rows) {
      const err = r.trueHeight ? ((r.scrollHeight - r.trueHeight) / r.trueHeight) * 100 : 0;
      console.log(
        r.mode.padEnd(26) +
          String(r.blocks).padStart(7) +
          r.medianLayoutMs.toFixed(2).padStart(9) +
          r.medianFrameMs.toFixed(2).padStart(9) +
          r.medianDispatchMs.toFixed(2).padStart(8) +
          String(r.longTasks).padStart(8) +
          String(r.longTaskMs).padStart(8) +
          String(r.scrollHeight).padStart(9) +
          String(r.trueHeight).padStart(9) +
          `${err >= 0 ? '+' : ''}${err.toFixed(1)}`.padStart(8) +
          String((r as unknown as { skippedNow: number }).skippedNow).padStart(9) +
          String((r as unknown as { appStyled: number }).appStyled).padStart(7) +
          String(r.composerResizes).padStart(9)
      );
    }
    console.log('');
    /* eslint-enable no-console */
  } finally {
    await a.app.close();
  }
});
