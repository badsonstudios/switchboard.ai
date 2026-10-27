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
//
// The second test (#1035) asks the same question with N cards open, each at
// the 1,000-block cap. Run it alone with `-g 1035`; `P1035_REPS` and
// `P1035_RUNS` size it. Findings: `spike/findings/1035-feed-relayout-n-cards.md`.
import { test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, streamPrompter, tempProjectFolder } from './fixtures/app';

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
    const box = w.locator('.composer-box').first();
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

// ═════════════════════════════════════════════════════════════════════════════
// #1035: the same keystroke, with N full cards open.
//
// Feed skipping observes every block AND every 40-block group with a
// ResizeObserver, one observer per FeedView. `FEED_VIEW_CAP` is 1,000 blocks,
// so a full card is ~1,025 targets and eight full cards are ~8,200, all
// registered with the one document whose rendering loop gathers them. The test
// above measured ONE feed. This one measures 1, 2, 4 and 8.
//
// Two layouts per launch, because they are the two ways a person has many cards:
//   'tabbed' — the default: every card a tab in one place, ONE on screen. The
//              rest are mounted (React keeps them) but detached by dockview, so
//              this row isolates the cost of the OTHER cards' observers.
//   'grid'   — the `grid` layout preset: all N on screen at once, each smaller.
//              The worst realistic case, and the one where every card is laid
//              out for real.
//
// ⚠️ NOTHING HERE READS BLOCK GEOMETRY. A rect read inside skipped content
// un-skips it (see `e21-740-feed-skipping.md`, "What this cost to learn" 1),
// which would delete the thing being priced. The target count comes from a
// counting wrapper on `ResizeObserver.prototype.observe`, installed before the
// first block arrives — it touches the DOM not at all.
//
// ⚠️ INTERLEAVED, NOT BATCHED. Each (rep, N) is its own fresh launch and the N
// order rotates per rep: on this desktop a background .NET build can slow a
// whole batch, and a batched sweep would report that as a slope against N.

/** the values of N; 8 is the "eight busy cards" the issue names */
const NS = (process.env.P1035_NS ?? '1,2,4,8').split(',').map(Number);
/** launches per N */
const REPS = Number(process.env.P1035_REPS ?? 3);
/** timed typing runs per layout per launch, after one warm-up */
const RUNS = Number(process.env.P1035_RUNS ?? 3);
/** five `!bulk 200` turns: 1,000 blocks plus five prompts, i.e. at the cap */
const BULKS = 5;
/**
 * A frame slower than this missed at least one vsync. The paced frame below is
 * key -> rAF -> setTimeout(0), so an on-budget key reads ~16.7ms plus timer
 * slack; 25ms (1.5 frames) is the first value that cannot be one frame.
 */
const SLOW_FRAME_MS = 25;

interface NRun {
  rep: number;
  n: number;
  layout: string;
  traced: boolean;
  layoutMs: number;
  frameMs: number;
  frameP90: number;
  slowFrames: number;
  dispatchMs: number;
  longTasks: number;
  longTaskMs: number;
  composerResizes: number;
  /** blocks in the typed-into card that the app has styled `content-visibility: auto` */
  appCV: number;
  /** blocks in the typed-into card */
  cardBlocks: number;
}

interface Census {
  /** live feed targets (blocks + groups still attached to a parent) across every observer */
  feedTargets: number;
  /** of those, how many are in the document right now */
  feedConnected: number;
  /** every live target of every observer, feed or not */
  allTargets: number;
  /** blocks across every card in the document */
  docBlocks: number;
  feedRegions: number;
  innerW: number;
  innerH: number;
}

interface TraceShare {
  n: number;
  layout: string;
  /** ms per key on the renderer main thread, by event name */
  perKey: Record<string, number>;
  /** median `totalObjects` the keystroke layouts walked */
  layoutObjects: number;
  layoutCount: number;
}

/** count every ResizeObserver target from here on — no DOM reads, ever */
async function installTargetCounter(w: Page): Promise<void> {
  await w.evaluate(() => {
    const proto = ResizeObserver.prototype;
    const reg = new Map<ResizeObserver, Set<Element>>();
    (window as unknown as { __p1035: typeof reg }).__p1035 = reg;
    const observe = proto.observe;
    const unobserve = proto.unobserve;
    const disconnect = proto.disconnect;
    proto.observe = function (this: ResizeObserver, el: Element, opts?: ResizeObserverOptions) {
      let s = reg.get(this);
      if (!s) {
        s = new Set();
        reg.set(this, s);
      }
      s.add(el);
      return observe.call(this, el, opts);
    };
    proto.unobserve = function (this: ResizeObserver, el: Element) {
      reg.get(this)?.delete(el);
      return unobserve.call(this, el);
    };
    proto.disconnect = function (this: ResizeObserver) {
      reg.delete(this);
      return disconnect.call(this);
    };
  });
}

async function census(w: Page): Promise<Census> {
  return w.evaluate(() => {
    const reg = (window as unknown as { __p1035: Map<ResizeObserver, Set<Element>> }).__p1035;
    let feedTargets = 0;
    let feedConnected = 0;
    let allTargets = 0;
    for (const set of reg.values()) {
      for (const el of set) {
        // an evicted block is removed from its parent; a block in a card
        // dockview has detached keeps its parent, so it still counts
        if (el.parentElement === null && !el.isConnected) continue;
        allTargets += 1;
        if (el.matches('[data-feed-block], [data-feed-group]')) {
          feedTargets += 1;
          if (el.isConnected) feedConnected += 1;
        }
      }
    }
    return {
      feedTargets,
      feedConnected,
      allTargets,
      docBlocks: document.querySelectorAll('[data-feed-block]').length,
      feedRegions: document.querySelectorAll('[data-feed-region]').length,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
    };
  });
}

/** open one more session, in its own folder (so nothing auto-groups) */
async function addSession(a: LaunchedApp): Promise<string> {
  const dir = tempProjectFolder();
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
  await a.window.getByRole('button', { name: '+ session' }).click();
  const name = path.basename(dir);
  await a.window
    .locator('nav .rail-row')
    .filter({ has: a.window.locator('[data-rail-title]', { hasText: name }) })
    .first()
    .waitFor({ timeout: 25_000 });
  return name;
}

/** fill a card to the cap while it is the one on screen */
async function fill(a: LaunchedApp, title: string, k: number): Promise<void> {
  const prompt = streamPrompter(a);
  for (let i = 0; i < BULKS; i += 1) {
    await prompt(title, `!bulk 200 C${k}_${i}_`);
    await a.window.getByText(`C${k}_${i}_200`, { exact: true }).first().waitFor({ timeout: 90_000 });
  }
}

/**
 * One 40-key run into the FIRST card in the document — the only one on screen
 * when tabbed, the top-left one in a grid. The same instrument as the #740
 * test's `shipped` mode: touches no style, prices the layout with one flushing
 * read, paces one key per frame.
 */
async function typeRun(w: Page, draft: number): Promise<Omit<NRun, 'rep' | 'n' | 'layout' | 'traced'>> {
  return w.evaluate(
    async ({ KEYS, draft, SLOW }) => {
      const scroller = document.querySelector<HTMLElement>('[data-feed-region]')!;
      // the composer in the SAME card: walk up until an ancestor holds one
      let card: HTMLElement | null = scroller.parentElement;
      while (card && !card.querySelector('.composer-box')) card = card.parentElement;
      const el = card!.querySelector<HTMLTextAreaElement>('.composer-box')!;
      const blocks = [...scroller.querySelectorAll<HTMLElement>('[data-feed-block]')];
      // style only, never geometry
      const appCV = blocks.filter((b) => getComputedStyle(b).contentVisibility === 'auto').length;

      const tasks: number[] = [];
      const watcher = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) tasks.push(e.duration);
      });
      try {
        watcher.observe({ type: 'longtask', buffered: false });
      } catch {
        /* no longtask support */
      }
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      const nextFrame = (): Promise<void> =>
        new Promise((r) => requestAnimationFrame(() => setTimeout(() => r(), 0)));

      setValue.call(el, `${'lorem ipsum dolor sit amet '.repeat(Math.ceil(draft / 27))}`.slice(0, draft));
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
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        setValue.call(el, `${el.value}a`);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        per.push(performance.now() - f0);
        const l0 = performance.now();
        void scroller.scrollHeight;
        layouts.push(performance.now() - l0);
        await nextFrame();
        frames.push(performance.now() - f0);
        // the composer's own box, after the frame is timed — the same check as #740's
        if (el.offsetHeight !== lastComposerH) {
          composerResizes += 1;
          lastComposerH = el.offsetHeight;
        }
      }
      await nextFrame();
      watcher.disconnect();
      setValue.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await nextFrame();

      const q = (xs: number[], p: number): number => {
        const v = [...xs].sort((x, y) => x - y);
        return Math.round(v[Math.min(v.length - 1, Math.floor(v.length * p))]! * 100) / 100;
      };
      return {
        layoutMs: q(layouts, 0.5),
        frameMs: q(frames, 0.5),
        frameP90: q(frames, 0.9),
        slowFrames: frames.filter((f) => f > SLOW).length,
        dispatchMs: q(per, 0.5),
        longTasks: tasks.length,
        longTaskMs: Math.round(tasks.reduce((n, d) => n + d, 0)),
        composerResizes,
        appCV,
        cardBlocks: blocks.length,
      };
    },
    { KEYS, draft, SLOW: SLOW_FRAME_MS }
  );
}

interface TraceEvent {
  ph: string;
  name: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: { name?: string; beginData?: { totalObjects?: number } };
}

/** run `fn` under a CDP trace; per-key ms by event name on the busiest renderer main thread */
async function traced(cdp: CDPSession, fn: () => Promise<unknown>): Promise<Omit<TraceShare, 'n' | 'layout'> | null> {
  const events: TraceEvent[] = [];
  const onData = (p: { value: unknown[] }): void => {
    events.push(...(p.value as TraceEvent[]));
  };
  try {
    cdp.on('Tracing.dataCollected', onData);
    await cdp.send('Tracing.start', {
      categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink',
      transferMode: 'ReportEvents',
    });
  } catch (e) {
    cdp.off('Tracing.dataCollected', onData);
    // eslint-disable-next-line no-console -- a probe's output
    console.log(`[1035] tracing unavailable: ${String(e)}`);
    await fn();
    return null;
  }
  await fn();
  const done = new Promise<void>((r) => cdp.once('Tracing.tracingComplete', () => r()));
  await cdp.send('Tracing.end');
  await done;
  cdp.off('Tracing.dataCollected', onData);

  const mains = new Set(
    events
      .filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
      .map((e) => `${e.pid}:${e.tid}`)
  );
  const byThread = new Map<string, TraceEvent[]>();
  for (const e of events) {
    const k = `${e.pid}:${e.tid}`;
    if (!mains.has(k)) continue;
    let l = byThread.get(k);
    if (!l) byThread.set(k, (l = []));
    l.push(e);
  }
  const main = [...byThread.values()].sort((x, y) => y.length - x.length)[0] ?? [];
  const totals = new Map<string, number>();
  const objects: number[] = [];
  const add = (name: string, us: number): void => {
    totals.set(name, (totals.get(name) ?? 0) + us);
  };
  const open = new Map<string, TraceEvent[]>();
  for (const e of [...main].sort((x, y) => x.ts - y.ts)) {
    if (e.ph === 'X') {
      add(e.name, e.dur ?? 0);
      if (e.name === 'Layout' && e.args?.beginData?.totalObjects !== undefined) objects.push(e.args.beginData.totalObjects);
    } else if (e.ph === 'B') {
      let s = open.get(e.name);
      if (!s) open.set(e.name, (s = []));
      s.push(e);
      if (e.name === 'Layout' && e.args?.beginData?.totalObjects !== undefined) objects.push(e.args.beginData.totalObjects);
    } else if (e.ph === 'E') {
      const b = open.get(e.name)?.pop();
      if (b) add(e.name, e.ts - b.ts);
    }
  }
  const perKey: Record<string, number> = {};
  const top = [...totals.entries()].sort((x, y) => y[1] - x[1]).slice(0, 14);
  const wanted = [...totals.keys()].filter((k) =>
    /ResizeObserver|^Layout$|^UpdateLayoutTree$|^RecalcStyle$|^Paint$|^PrePaint$|^Layerize$/.test(k)
  );
  for (const [k] of [...top, ...wanted.map((k) => [k, 0] as const)]) {
    perKey[k] = Math.round(((totals.get(k) ?? 0) / 1000 / KEYS) * 100) / 100;
  }
  objects.sort((x, y) => x - y);
  return {
    perKey,
    layoutObjects: objects.length ? objects[Math.floor(objects.length / 2)]! : -1,
    layoutCount: objects.length,
  };
}

test('#1035 — the keystroke with N full cards open', async () => {
  test.setTimeout(4 * 60 * 60_000);
  const DRAFT = 600;
  const runs: NRun[] = [];
  const censuses: (Census & { rep: number; n: number; layout: string })[] = [];
  const traces: TraceShare[] = [];

  const oneLaunch = async (rep: number, n: number): Promise<void> => {
    const folder = tempProjectFolder();
    const a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    try {
      const w = a.window;
      const first = path.basename(folder);
      await w.getByText(first).first().waitFor({ timeout: 25_000 });
      await w.locator('.composer-box').first().waitFor({ timeout: 25_000 });
      await installTargetCounter(w);
      await fill(a, first, 0);
      for (let k = 1; k < n; k += 1) await fill(a, await addSession(a), k);
      await w.waitForTimeout(1_500);
      const cdp = await w.context().newCDPSession(w);

      const measure = async (layout: string): Promise<void> => {
        censuses.push({ ...(await census(w)), rep, n, layout });
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
        await typeRun(w, DRAFT); // warm-up
        for (let r = 0; r < RUNS; r += 1) {
          runs.push({ ...(await typeRun(w, DRAFT)), rep, n, layout, traced: false });
        }
        // one traced run on the first rep only, and never counted in the timings:
        // tracing has its own cost
        if (rep === 0 || process.env.P1035_TRACE_ALL) {
          const t = await traced(cdp, () => typeRun(w, DRAFT));
          if (t) traces.push({ ...t, n, layout });
        }
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      };

      const regionsAre = async (want: number): Promise<void> => {
        const deadline = Date.now() + 15_000;
        while (
          Date.now() < deadline &&
          (await w.evaluate(() => document.querySelectorAll('[data-feed-region]').length)) !== want
        ) {
          await w.waitForTimeout(250);
        }
        await w.waitForTimeout(1_500);
      };

      await measure('tabbed');
      if (n > 1) {
        await w.locator('[data-layout-preset="grid"]').click();
        await regionsAre(Math.min(n, 4)); // the grid preset has at most four places
        await measure('grid');
        // the order check: is the grid row's tail the first pass after a remount?
        if (process.env.P1035_GRID_TWICE) await measure('grid-again');
      }
      // ── THE CONTROL: the same DOM, the same skip styles, NO feed observers ──
      //
      // The registry holds every observer the app made, so the feed-skipping
      // ones — those watching a block or a group — can be disconnected from
      // here. The inline `content-visibility` / `contain-intrinsic-size` they
      // wrote stay exactly where they are, so skipping keeps working; the ONLY
      // thing that goes is the per-frame gathering of ~1,025 targets per card.
      // On minus off is therefore the observers' bill, and nothing else's.
      // Irreversible within a launch, hence last.
      const cutFeedObservers = async (): Promise<number> => w.evaluate(() => {
        const reg = (window as unknown as { __p1035: Map<ResizeObserver, Set<Element>> }).__p1035;
        let observers = 0;
        for (const [ro, set] of [...reg.entries()]) {
          if ([...set].some((el) => el.matches('[data-feed-block], [data-feed-group]'))) {
            ro.disconnect();
            observers += 1;
          }
        }
        return observers;
      });
      const cut = await cutFeedObservers();
      // eslint-disable-next-line no-console -- progress
      console.log(`[1035] N=${n}: disconnected ${cut} feed observers`);
      if (n > 1) await measure('grid-noRO');
      if (n > 1) {
        await w.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+P`);
        await w.getByPlaceholder('Type a command or a session name…').fill('Arrange: one place');
        await w.keyboard.press('Enter');
        await regionsAre(1);
        // Re-arranging REMOUNTS the cards, and each remounted FeedView makes a
        // fresh observer for its blocks (seen on the first run: the census
        // read 1,026 live targets here). Cut those too, or this row is not a
        // control at all.
        await cutFeedObservers();
      }
      await measure('tabbed-noRO');
    } finally {
      await a.app.close();
    }
  };

  for (let rep = 0; rep < REPS; rep += 1) {
    // rotate the order each rep so no N always runs first, or last
    const order = NS.map((_, i) => NS[(i + rep) % NS.length]!);
    for (const n of order) {
      await oneLaunch(rep, n);
      // eslint-disable-next-line no-console -- progress
      console.log(`[1035] rep ${rep} N=${n} done`);
    }
  }

  /* eslint-disable no-console -- a probe's entire output */
  const med = (xs: number[]): number => {
    const v = [...xs].sort((x, y) => x - y);
    return v.length ? v[Math.floor(v.length / 2)]! : NaN;
  };
  const span = (xs: number[]): string => `${Math.min(...xs).toFixed(2)}-${Math.max(...xs).toFixed(2)}`;
  console.log(`\n#1035 — ${KEYS} keys per run, ${THROTTLE}x CPU throttle, ${REPS} launches x ${RUNS} runs per N per layout\n`);
  console.log('RAW');
  for (const r of runs) console.log(`P1035RUN ${JSON.stringify(r)}`);
  for (const c of censuses) console.log(`P1035CENSUS ${JSON.stringify(c)}`);
  for (const t of traces) console.log(`P1035TRACE ${JSON.stringify(t)}`);
  console.log('');
  console.log(
    'layout'.padEnd(12) +
      'N'.padStart(3) +
      'targets'.padStart(9) +
      'inDoc'.padStart(7) +
      'layout med'.padStart(12) +
      'layout span'.padStart(14) +
      'frame med'.padStart(11) +
      'frame span'.padStart(14) +
      'p90 med'.padStart(9) +
      'slow%'.padStart(7) +
      'longTk'.padStart(8) +
      'appCV'.padStart(7) +
      'blocks'.padStart(8)
  );
  for (const layout of ['tabbed', 'tabbed-noRO', 'grid', 'grid-again', 'grid-noRO']) {
    for (const n of NS) {
      const rs = runs.filter((r) => r.layout === layout && r.n === n);
      if (!rs.length) continue;
      const cs = censuses.filter((c) => c.layout === layout && c.n === n);
      const slow = rs.reduce((s, r) => s + r.slowFrames, 0) / (rs.length * KEYS);
      console.log(
        layout.padEnd(12) +
          String(n).padStart(3) +
          String(med(cs.map((c) => c.feedTargets))).padStart(9) +
          String(med(cs.map((c) => c.feedConnected))).padStart(7) +
          med(rs.map((r) => r.layoutMs)).toFixed(2).padStart(12) +
          span(rs.map((r) => r.layoutMs)).padStart(14) +
          med(rs.map((r) => r.frameMs)).toFixed(2).padStart(11) +
          span(rs.map((r) => r.frameMs)).padStart(14) +
          med(rs.map((r) => r.frameP90)).toFixed(2).padStart(9) +
          `${(slow * 100).toFixed(1)}`.padStart(7) +
          String(rs.reduce((s, r) => s + r.longTasks, 0)).padStart(8) +
          String(med(rs.map((r) => r.appCV))).padStart(7) +
          String(med(rs.map((r) => r.cardBlocks))).padStart(8)
      );
    }
  }
  console.log('');
  /* eslint-enable no-console */
});
