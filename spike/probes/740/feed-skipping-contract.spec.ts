// #740 probe B: can skipping keep the promises this feed already makes?
//
// Probe A (`feed-relayout.spec.ts`) answered the COST question and the headline
// exactness question: per-block measured `contain-intrinsic-size` renders
// `scrollHeight` exact (0.0% at 60 and 400 blocks) where the reverted global
// `80px` guess read +140.8%, and the keystroke's layout bill drops 26.3ms →
// 7.4ms against a 1.4ms floor.
//
// None of that is worth anything if skipping breaks something else, and this
// feed makes more promises than most:
//
//   Q1  Does this Chromium have the parts a REAL implementation needs —
//       `contentvisibilityautostatechange` (the only honest "this block is
//       being laid out for real now, measure it" signal) and
//       `checkVisibility({ contentVisibilityAuto })` (the guard that stops a
//       ResizeObserver reading back the intrinsic size we just wrote and
//       feeding it to itself)? Read, never assumed — the standing rule.
//   Q2  WIDTH. A measured height is only true at the width it was measured at.
//       After a pane resize every stored height is stale, and `scrollHeight` is
//       the number #442/#555 ride on. How wrong does it get, and does the
//       obvious remedy (drop the heights, let one real layout re-measure) put
//       it back?
//   Q3  Scroll restore across the skip: park at a scrollTop, read which block
//       is under the fold, switch modes, read again. This is Dan's own
//       2026-07-26 bug and the test the first attempt failed on Linux CI.
//   Q4  Is a skipped block still FINDABLE and FOCUSABLE? The #174 keyboard walk
//       reads `FEED_STOP_SELECTOR` off the DOM and find/jumpTo scrolls to a
//       `data-feed-seq`. Both reach blocks that are nowhere near the viewport.
//
// Local-only. Findings: `spike/findings/e21-740-feed-skipping.md`.
// Run: copy into e2e/, `npm run build`,
//      `npx playwright test e2e/feed-skipping-contract.spec.ts --reporter=list --workers=1`
import { test } from '@playwright/test';
import path from 'path';
import { launchApp, streamPrompter, tempProjectFolder } from './fixtures/app';

test('#740 — what skipping does to the feed’s other promises', async () => {
  test.setTimeout(600_000);
  const folder = tempProjectFolder();
  const a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
  const title = path.basename(folder);

  try {
    const w = a.window;
    await w.getByText(title).first().waitFor({ timeout: 25_000 });
    await w.getByPlaceholder(/Prompt this session/).first().waitFor({ timeout: 25_000 });

    // ⚠️ PROSE, NOT `P740C_1`. The first run of this probe seeded one-line
    // blocks and Q2 came back "a 954px → 525px narrowing changes the content
    // height by 0.0%" — which is true, and says nothing, because a nine-character
    // block does not rewrap at any width this window can reach. A measured height
    // is only stale if the text it measured can REFLOW, so the fixture has to be
    // text that reflows.
    const PROSE =
      'the quick brown fox jumps over the lazy dog while the sun sets behind a ' +
      'row of quiet houses and somebody somewhere is still typing into a box ';
    for (let i = 0; i < 2; i += 1) {
      await streamPrompter(a)(title, `!bulk 170 ${PROSE}${i} #`);
      await w.getByText(`${PROSE}${i} #170`, { exact: true }).waitFor({ timeout: 90_000 });
    }
    await w.waitForTimeout(1_500);

    // ── Q1: what does this engine actually have? ───────────────────────────
    const support = await w.evaluate(() => ({
      chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? 'unknown',
      stateChangeEvent: 'oncontentvisibilityautostatechange' in document.createElement('div'),
      checkVisibility: typeof document.createElement('div').checkVisibility === 'function',
      contentVisibility: CSS.supports('content-visibility', 'auto'),
      containIntrinsicSize: CSS.supports('contain-intrinsic-size', '100px'),
      containIntrinsicSizeAuto: CSS.supports('contain-intrinsic-size', 'auto 100px'),
    }));

    const results = await w.evaluate(async () => {
      const out: Record<string, unknown> = {};
      const scroller = [...document.querySelectorAll<HTMLDivElement>('div')].find(
        (d) => d.getAttribute('data-feed-region') !== null
      )!;
      const blocks = (): HTMLElement[] => [
        ...scroller.querySelectorAll<HTMLElement>('[data-feed-block]'),
      ];
      const nextFrame = (): Promise<void> =>
        new Promise((r) => requestAnimationFrame(() => setTimeout(() => r(), 0)));

      /** content-box height, the unit `contain-intrinsic-size` speaks */
      const contentH = (b: HTMLElement): number => {
        const cs = getComputedStyle(b);
        const pad =
          parseFloat(cs.paddingBlockStart) +
          parseFloat(cs.paddingBlockEnd) +
          parseFloat(cs.borderBlockStartWidth) +
          parseFloat(cs.borderBlockEndWidth);
        return Math.max(0, b.getBoundingClientRect().height - pad);
      };
      const unskip = (): void => {
        for (const b of blocks()) {
          b.style.contentVisibility = '';
          b.style.containIntrinsicSize = '';
        }
      };
      /**
       * Measure every block in ONE read pass, then write in ONE write pass.
       *
       * `auto <length>`, not a bare length, and the difference is the one
       * variable that separated this probe from probe A when they disagreed
       * about whether anything was being skipped at all.
       */
      const applyMeasured = (): void => {
        unskip();
        const bs = blocks();
        const hs = bs.map(contentH);
        bs.forEach((b, i) => {
          b.style.contentVisibility = 'auto';
          b.style.containIntrinsicSize = `auto ${hs[i]!.toFixed(2)}px`;
        });
      };

      /**
       * Park the view, against a feed that does not want to be parked.
       *
       * ⚠️ `scrollTop = x` ALONE DOES NOT WORK HERE and the first run of this
       * probe did not notice: it asked for 40% of the way down, reported
       * `parkedAt: 10638` of an 11021px conversation, and nobody read the number
       * — the feed is TAIL-PINNED, so writing scrollTop fires `onScroll`, the pin
       * rule reads a scroll it did not cause, and `pin()` puts the view straight
       * back at the bottom. Every "mid-feed" answer was really the bottom.
       *
       * A wheel event first is what unpins it: `onWheel` marks a gesture, and the
       * scroll that follows is then read as the user's own (`FeedView`'s
       * `nextPin`). Synthetic, but it reaches React's delegated handler, which is
       * all the rule looks at.
       */
      const parkAt = async (top: number): Promise<number> => {
        scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -240 }));
        scroller.scrollTop = top;
        await nextFrame();
        await nextFrame();
        return scroller.scrollTop;
      };

      // ── Q3 setup: park somewhere in the middle and remember what is there ──
      unskip();
      await nextFrame();
      const trueHeight = scroller.scrollHeight;
      const wanted = Math.round(trueHeight * 0.4);
      const parkedAt = await parkAt(wanted);
      /** the seq of the block sitting at the top of the viewport */
      const atFold = (): string | null => {
        const top = scroller.getBoundingClientRect().top;
        for (const b of blocks()) {
          const r = b.getBoundingClientRect();
          if (r.bottom > top + 1) return b.getAttribute('data-feed-seq');
        }
        return null;
      };
      const foldBefore = atFold();

      applyMeasured();
      await nextFrame();
      out.q3 = {
        // THE PREMISE. If `parkedAt` is not near `wanted`, the pin won and every
        // answer below is about the bottom of the feed, not the middle of it.
        wanted,
        parkedAt: Math.round(parkedAt),
        scrollTopAfter: Math.round(scroller.scrollTop),
        foldBefore,
        foldAfter: atFold(),
        heightBefore: trueHeight,
        heightAfterSkipping: scroller.scrollHeight,
      };

      // ── Q2: WIDTH. Narrow the pane and see what the stored heights are worth ─
      const panel = scroller.closest<HTMLElement>('[data-perf-blocks]')!.parentElement!;
      const originalWidth = panel.style.inlineSize;
      const w0 = panel.getBoundingClientRect().width;
      // a real narrowing — wide enough to rewrap prose, which is what makes a
      // stored height stale
      panel.style.inlineSize = `${Math.round(w0 * 0.55)}px`;
      await nextFrame();
      await nextFrame();
      const staleHeight = scroller.scrollHeight;
      // the remedy under test: drop every stored height and let ONE real layout
      // put them back — the same full layout a resize already pays today
      unskip();
      await nextFrame();
      const truthAtNarrow = scroller.scrollHeight;
      applyMeasured();
      await nextFrame();
      out.q2 = {
        widthBefore: Math.round(w0),
        widthAfter: Math.round(panel.getBoundingClientRect().width),
        staleHeight,
        truthAtNarrow,
        stalePct: Math.round(((staleHeight - truthAtNarrow) / truthAtNarrow) * 1000) / 10,
        afterRemeasure: scroller.scrollHeight,
        remeasuredPct:
          Math.round(((scroller.scrollHeight - truthAtNarrow) / truthAtNarrow) * 1000) / 10,
      };
      panel.style.inlineSize = originalWidth;
      await nextFrame();
      unskip();
      await nextFrame();
      applyMeasured();
      await nextFrame();

      // ── Q4: is a skipped block still findable and focusable? ────────────────
      //
      // ⚠️ PICK A BLOCK AWAY FROM THE FOLD, DON'T SCROLL TO ONE. The first run
      // did `scrollTop = 0` and then asked about the LAST block — and got back
      // "not skipped", because this feed is TAIL-PINNED: writing scrollTop fires
      // `onScroll`, the pin rule repins, and the view is back at the bottom with
      // the last block on screen before the question is asked. The view stays
      // where it is and the block is chosen a fifth of the way down instead.
      const bs = blocks();
      const isSkipped = (b: HTMLElement): boolean | null =>
        typeof b.checkVisibility === 'function'
          ? !b.checkVisibility({ contentVisibilityAuto: true } as unknown as CheckVisibilityOptions)
          : null;
      const far = bs[Math.floor(bs.length * 0.2)]!;
      /**
       * HOW LONG does skipping take to engage? Not a curiosity — the first run
       * of this probe read two frames after applying the styles, got "0 of 342
       * skipped", and would have concluded the feature does not work in this
       * engine. Q2 proved otherwise in the same run: `staleHeight` 12,461
       * against a true 17,177 can only be intrinsic sizes being honoured.
       *
       * So the relevance pass LAGS, and a real implementation has to tolerate
       * that: a block is not skipped the instant you ask for it to be, which
       * means anything that measures blocks must not treat "has a box right
       * now" as "will keep having one".
       */
      //
      // ⚠️ AND IT ONLY ENGAGES WHEN SOMETHING DIRTIES LAYOUT. Polling a
      // completely static page for sixty frames never skipped a single block
      // (`framesToSkip: -1`) while Q2, three frames earlier in the same run,
      // was unarguably standing on intrinsic sizes. So the poll below nudges
      // layout on a throwaway node each frame — the way a keystroke, a streamed
      // token or a resize does in real use — and `framesIdle` records what the
      // undisturbed page did, because a reader who sees only the engaged number
      // will build something that assumes skipping is instant.
      const nudge = document.createElement('div');
      nudge.style.cssText = 'position:absolute;inset-block-start:-9999px';
      document.body.append(nudge);
      let framesIdle = -1;
      for (let i = 0; i < 20; i += 1) {
        if (isSkipped(far) === true) {
          framesIdle = i;
          break;
        }
        await nextFrame();
      }
      let framesToSkip = -1;
      for (let i = 0; i < 60; i += 1) {
        if (isSkipped(far) === true) {
          framesToSkip = i;
          break;
        }
        nudge.style.inlineSize = `${i % 17}px`;
        await nextFrame();
      }
      nudge.remove();
      // ⚠️ AND IF THAT STILL DOES NOT ENGAGE IT, THE TWO PROBES ARE IN DIRECT
      // CONFLICT AND ONE OF THEM IS WRONG. Probe A's `cv-guess` row at 400
      // blocks read `scrollHeight` 31,377 against a true 13,031, which is only
      // possible if most blocks were standing on an 80px intrinsic size — i.e.
      // skipped. The one condition A had that nothing above reproduces is that
      // A was TYPING: 40 real keystrokes into the composer, the feed pinned to
      // its tail rather than parked mid-conversation. So do that here, and let
      // the answer fall where it falls rather than picking whichever probe
      // agrees with the plan.
      let framesTypingToSkip = -1;
      const box = document.querySelector<HTMLTextAreaElement>('.composer-box');
      if (box) {
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value'
        )!.set!;
        for (let i = 0; i < 40; i += 1) {
          if (isSkipped(far) === true) {
            framesTypingToSkip = i;
            break;
          }
          box.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
          setValue.call(box, `${box.value}a`);
          box.dispatchEvent(new Event('input', { bubbles: true }));
          await nextFrame();
        }
        setValue.call(box, '');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const skipped = isSkipped(far);
      const stops = scroller.querySelectorAll('[data-feed-expander], button');
      const textReachable = (far.textContent ?? '').trim().length > 0;
      const rect = far.getBoundingClientRect();
      // HOW MANY of the 340 are skipped at all? One block answering "no" could
      // be a quirk of that block; the whole list answering "no" means the
      // feature is not engaging and probe A's numbers need re-reading.
      const skippedCount = bs.filter((b) => isSkipped(b) === true).length;
      // ⚠️ A SECOND, INDEPENDENT WITNESS, because the first run had the two
      // probes disagreeing: A's `cv-guess` row inflated `scrollHeight` by
      // +140.8%, which can only happen if off-screen blocks are standing on
      // their intrinsic size, while B's `checkVisibility` said 0 of 342 were
      // skipped. Both cannot be right. Skipped contents have NO BOXES, so a
      // child with a zero-height rect is skipping observed directly rather than
      // asked about.
      const childless = bs.filter(
        (b) =>
          b.lastElementChild instanceof HTMLElement &&
          b.lastElementChild.getBoundingClientRect().height === 0
      ).length;
      // the jump path find/#174 uses
      far.scrollIntoView({ block: 'center' });
      await nextFrame();
      await nextFrame();
      const landedWithin = Math.abs(
        far.getBoundingClientRect().top -
          (scroller.getBoundingClientRect().top + scroller.clientHeight / 2)
      );
      const view = scroller.getBoundingClientRect();
      out.q4 = {
        // the premise again: was this block anywhere near the viewport?
        // MAX, not min — one of the two gaps is always negative, and the first
        // version took the min and printed that, which is the distance to the
        // NEAR edge and tells you nothing about whether it is outside.
        offscreenByPx: Math.round(Math.max(view.top - rect.bottom, rect.top - view.bottom)),
        scrollTop: Math.round(scroller.scrollTop),
        viewportPx: Math.round(scroller.clientHeight),
        computedContentVisibility: getComputedStyle(far).contentVisibility,
        computedIntrinsicSize: getComputedStyle(far).containIntrinsicSize,
        skippedOfTotal: `${skippedCount} / ${bs.length}`,
        childBoxGoneOfTotal: `${childless} / ${bs.length}`,
        framesIdle,
        framesToSkip,
        framesTypingToSkip,
        skippedWhileOffscreen: skipped,
        textContentReachable: textReachable,
        boundingBoxHeight: Math.round(rect.height),
        stopsFoundInDom: stops.length,
        scrollIntoViewLandedWithinPx: Math.round(landedWithin),
      };

      unskip();
      return out;
    });

    /* eslint-disable no-console -- a probe's entire output */
    console.log('\n#740 probe B — engine support\n', support);
    console.log('\nQ3 scroll restore across the skip\n', results.q3);
    console.log('\nQ2 width change\n', results.q2);
    console.log('\nQ4 findable / focusable while skipped\n', results.q4);
    console.log('');
    /* eslint-enable no-console */
  } finally {
    await a.app.close();
  }
});
