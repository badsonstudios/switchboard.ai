// A reader who is scrolled up does not move while pictures above them load
// (#1241), and a conversation following its tail still is.
//
// #1235's acceptance list asked for this to be measured rather than judged by
// eye. It was (`spike/findings/1241-scroll-position-while-pictures-load.md`):
// the reader's block moves a tenth of a pixel while 12 MB pictures above it
// collapse and grow back. Nothing in this app does that; the browser's scroll
// anchoring does, and the conversation leaves it on. THIS SPEC IS THE GUARD ON
// THAT, because it is easy to break from a distance: the obvious improvement
// tried for the same ticket (re-measuring a skipped part of the conversation
// when a picture in it loads) moved the reader by 300 to 420 px, in 55 of 57
// frames, and looked fine by eye in a short conversation.
//
// "Moved" is the distance between one block's top edge and the top of the
// conversation's pane, read EVERY animation frame: a jump that is corrected a
// frame later still counts.
//
// HOW A FIRST SIGHT IS PRODUCED. Each picture above the view is replaced by a
// fresh `<img>` with no `width` or `height`, which is the element a first
// render writes: zero pixels tall until its bytes arrive. Its address gains
// one parameter, because a page answers an address it has already shown from
// its own memory with no load at all (main reads only `path`).
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const WINDOW = { x: 0, y: 0, width: 1400, height: 900 };
const HEIGHTS = [80, 200, 420, 700, 300, 1000];
const composer = (w: Page) => w.getByPlaceholder(/^Message .+…$/);

const svg = (h: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="${h}" viewBox="0 0 500 ${h}">` +
  `<rect width="500" height="${h}" fill="#dde3ee"/><rect x="12" y="12" width="200" height="40" fill="#3b5bdb"/></svg>`;

interface Sample {
  t: number;
  top: number;
  height: number;
  offset: number;
  gap: number;
}

/** start sampling the feed every frame; `stop()` hands the samples back */
async function sample(w: Page, seq: string | null): Promise<void> {
  await w.evaluate((wanted) => {
    const scroller = document.querySelector('[data-feed-region]') as HTMLElement;
    const state = { on: true, samples: [] as Sample[] };
    (window as unknown as { __probe: typeof state }).__probe = state;
    const tick = (): void => {
      const mark = wanted ? (document.querySelector(`[data-feed-seq="${wanted}"]`)) : null;
      state.samples.push({
        t: performance.now(),
        top: scroller.scrollTop,
        height: scroller.scrollHeight,
        offset: mark ? mark.getBoundingClientRect().top - scroller.getBoundingClientRect().top : NaN,
        gap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
      });
      if (state.on) requestAnimationFrame(tick);
    };
    tick();
  }, seq);
}
const stop = (w: Page): Promise<Sample[]> =>
  w.evaluate(() => {
    const state = (window as unknown as { __probe: { on: boolean; samples: Sample[] } }).__probe;
    state.on = false;
    return state.samples;
  });

/** the block the reader's eye is on: the first one that starts inside the pane */
const landmark = (w: Page): Promise<{ seq: string; offset: number }> =>
  w.evaluate(() => {
    const scroller = document.querySelector('[data-feed-region]') as HTMLElement;
    const paneTop = scroller.getBoundingClientRect().top;
    for (const el of document.querySelectorAll<HTMLElement>('[data-feed-seq]')) {
      const top = el.getBoundingClientRect().top - paneTop;
      if (top >= 0) return { seq: el.getAttribute('data-feed-seq')!, offset: top };
    }
    throw new Error('no block starts inside the pane');
  });

/** replace pictures with fresh elements; answers how many, and how many were in skipped content */
const makeUnseen = (w: Page, which: 'above' | 'all', reserved: boolean): Promise<{ replaced: number; skipped: number }> =>
  w.evaluate(
    ([scope, keepSize]) => {
      const scroller = document.querySelector('[data-feed-region]') as HTMLElement;
      const paneTop = scroller.getBoundingClientRect().top;
      let replaced = 0;
      let skipped = 0;
      for (const img of [...document.querySelectorAll<HTMLImageElement>('[data-feed-region] img.doc-image')]) {
        const visibleToLayout = img.checkVisibility({ contentVisibilityAuto: true });
        if (scope === 'above' && visibleToLayout && img.getBoundingClientRect().bottom > paneTop) continue;
        if (!visibleToLayout) skipped += 1;
        const fresh = img.ownerDocument.createElement('img');
        for (const a of ['class', 'alt', 'data-doc-image-src']) {
          const v = img.getAttribute(a);
          if (v !== null) fresh.setAttribute(a, v);
        }
        if (keepSize) {
          for (const a of ['width', 'height']) {
            const v = img.getAttribute(a);
            if (v !== null) fresh.setAttribute(a, v);
          }
        }
        // A NEW ADDRESS for the same picture. A page keeps every picture it has
        // shown and answers the same address again at once, with no load at
        // all; main reads only `path`, so one more parameter is the same file.
        fresh.setAttribute('src', `${img.getAttribute('src')!}&unseen=${Date.now()}-${replaced}`);
        img.replaceWith(fresh);
        replaced += 1;
      }
      return { replaced, skipped };
    },
    [which, reserved] as const
  );

const allLoaded = (w: Page): Promise<boolean> =>
  w.evaluate(() =>
    [...document.querySelectorAll<HTMLImageElement>('[data-feed-region] img.doc-image')].every(
      (i) => i.complete && i.naturalWidth > 0
    )
  );

test.describe('scroll position while pictures load (#1241)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('following the tail holds, and a reader scrolled up does not move when pictures above load', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    HEIGHTS.forEach((h, i) => fs.writeFileSync(path.join(folder, `p${i + 1}.svg`), svg(h)));
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(composer(w)).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ BrowserWindow }, box) => {
      BrowserWindow.getAllWindows()[0]?.setBounds(box);
    }, WINDOW);
    await w.waitForTimeout(400);
    const filler = Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of a paragraph that is here to be read.`).join(' // ');

    // ── FOLLOWING THE TAIL while every picture arrives for the first time ───
    for (let i = 1; i <= HEIGHTS.length; i++) {
      await composer(w).click();
      await composer(w).fill(`REPLY${i} ![picture ${i}](p${i}.svg) ${filler}`);
      await composer(w).press('Enter');
      await expect(w.locator('[data-feed-block="assistant"]').filter({ hasText: `FAKE-REPLY: REPLY${i} ` })).toBeVisible({
        timeout: 60_000,
      });
    }
    await expect.poll(() => allLoaded(w), { timeout: 30_000 }).toBe(true);
    const tailGap = (): Promise<number> =>
      w.evaluate(() => {
        const s = document.querySelector('[data-feed-region]') as HTMLElement;
        return Math.round(s.scrollHeight - s.clientHeight - s.scrollTop);
      });
    // (40px is the slack the pin rule itself uses)
    await expect.poll(tailGap, { timeout: 15_000 }).toBeLessThanOrEqual(40);

    // enough conversation after the pictures that they are far above the tail
    await composer(w).click();
    await composer(w).fill('!bulk 60 FILL_');
    await composer(w).press('Enter');
    await expect(w.getByText('FILL_60', { exact: true })).toBeAttached({ timeout: 60_000 });
    await w.waitForTimeout(800);

    // ── A READER, A SCREEN OR SO UP FROM THE TAIL ───────────────────────────
    // a REAL wheel, over the conversation: the pin rule tells a person's
    // gesture from the layout's by what could have caused it
    const pane = (await w.locator('[data-feed-region]').first().boundingBox())!;
    await w.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
    for (let i = 0; i < 10; i++) {
      await w.mouse.wheel(0, -100);
      await w.waitForTimeout(40);
    }
    await w.waitForTimeout(600);
    expect(await tailGap()).toBeGreaterThan(200);
    const before = await landmark(w);

    // ── EVERY PICTURE ABOVE THEM LOADS AS IF NEVER SEEN ─────────────────────
    await sample(w, before.seq);
    const unseen = await makeUnseen(w, 'above', false);
    expect(unseen.replaced).toBe(HEIGHTS.length);
    await expect.poll(() => allLoaded(w), { timeout: 30_000 }).toBe(true);
    await w.waitForTimeout(800);
    const samples = await stop(w);
    expect(samples.length).toBeGreaterThan(5);
    const drift = samples.map((s) => Math.abs(s.offset - before.offset));
    // measured: 0.1 to 0.5 px. Two is the line between "held" and "moved".
    expect(Math.max(...drift)).toBeLessThan(2);
    // ...and they are still reading, not snapped to the tail
    expect(await tailGap()).toBeGreaterThan(200);
  });
});
