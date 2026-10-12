// PROBE (#1241). Does the reader move while pictures load in the conversation?
//
// #1235's acceptance list asked that follow-the-tail and scroll position hold
// while pictures load, "measured, not judged by eye". This measures it, in the
// real app, off the page's own geometry, once per animation frame.
//
// A conversation of six replies, each with a picture of a different height
// (two taller than the 420px cap) and a screenful of text, in a 1400 x 900
// window. Then four cases:
//
//   TAIL         following the newest message while every picture loads for
//                the first time;
//   FIRST-SIGHT  reading a screen up from the tail while every picture ABOVE
//                the view loads as if never seen: a fresh element with no
//                size on it. Counts how many of them sit in blocks the
//                conversation is skipping (off screen, standing on a
//                remembered height);
//   COLD-TAIL    quit, start again, resume: the conversation opens at its
//                tail with every picture in the replayed history a first
//                sight;
//   COLD-WALK-UP ...then one notch of the wheel at a time up to the top,
//                asking at each notch whether the text moved 100px or not.
//
// "Moved" is the distance between a landmark block's top edge and the top of
// the conversation's pane: the block the reader's eye is on. It is sampled
// every frame, so a jump that is corrected a frame later still shows.
//
// HOW FIRST SIGHT IS PRODUCED. A local picture loads in a few milliseconds, so
// there is no waiting for one to be late. Instead each picture above the view
// is replaced by a fresh `<img>` with the same address and NO `width` or
// `height`: exactly the element a first render writes, zero pixels tall until
// its bytes arrive. `PROBE_RESERVED=1` leaves the size on, which is what a
// second sight is.
//
// ⚠️ Parked under `spike/probes/1241/`; copy into `e2e/` to run it:
//   npx playwright test e2e/pictures-scroll.spec.ts
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const WINDOW = { x: 0, y: 0, width: 1400, height: 900 };
const RESERVED = process.env.PROBE_RESERVED === '1';
/**
 * `PROBE_BIG=1`: the pictures are 12 MB bitmaps instead of SVGs of a few
 * hundred bytes, so a load takes several frames (main reads the file, the
 * page decodes it) and the frames in between can be seen.
 */
const BIG = process.env.PROBE_BIG === '1';
const EXT = BIG ? 'bmp' : 'svg';
const HEIGHTS = [80, 200, 420, 700, 300, 1000];
const composer = (w: Page) => w.getByPlaceholder(/Prompt this session/);

const svg = (h: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="${h}" viewBox="0 0 500 ${h}">` +
  `<rect width="500" height="${h}" fill="#dde3ee"/><rect x="12" y="12" width="200" height="40" fill="#3b5bdb"/></svg>`;

/** an uncompressed 24-bit bitmap, 2000 wide and `h * 4` tall: about 6 KB a row */
function bmp(h: number): Buffer {
  const width = 2000;
  const height = h * 4;
  const row = width * 3;
  const size = 54 + row * height;
  const out = Buffer.alloc(size, 0xc8);
  out.write('BM', 0, 'latin1');
  out.writeUInt32LE(size, 2);
  out.writeUInt32LE(0, 6);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(0, 30);
  out.writeUInt32LE(row * height, 34);
  out.writeUInt32LE(2835, 38);
  out.writeUInt32LE(2835, 42);
  out.writeUInt32LE(0, 46);
  out.writeUInt32LE(0, 50);
  return out;
}

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
      const mark = wanted ? (document.querySelector(`[data-feed-seq="${wanted}"]`) as HTMLElement | null) : null;
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
        const visibleToLayout = img.checkVisibility({ contentVisibilityAuto: true } as CheckVisibilityOptions);
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

function report(name: string, samples: Sample[], base: number, extra: Record<string, unknown> = {}): void {
  const offsets = samples.map((s) => s.offset).filter((o) => !Number.isNaN(o));
  const drift = offsets.map((o) => o - base);
  const worst = drift.reduce((m, d) => (Math.abs(d) > Math.abs(m) ? d : m), 0);
  const moved = drift.filter((d) => Math.abs(d) >= 1).length;
  const heights = samples.map((s) => s.height);
  console.log(
    `PROBE ${name}: ${JSON.stringify({
      frames: samples.length,
      worstDriftPx: Math.round(worst * 10) / 10,
      finalDriftPx: Math.round((drift[drift.length - 1] ?? 0) * 10) / 10,
      framesMoved: moved,
      heightMinMax: [Math.min(...heights), Math.max(...heights)],
      ms: Math.round((samples[samples.length - 1]?.t ?? 0) - (samples[0]?.t ?? 0)),
      tailGapMax: Math.round(Math.max(...samples.map((s) => s.gap))),
      framesOffTail: samples.filter((s) => s.gap > 40).length,
      tailGapFinal: Math.round(samples[samples.length - 1]?.gap ?? -1),
      ...extra,
    })}`
  );
}

test.describe('PROBE #1241: scroll position while pictures load', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('measure', async () => {
    test.setTimeout(300_000);
    const folder = tempProjectFolder();
    HEIGHTS.forEach((h, i) => fs.writeFileSync(path.join(folder, `p${i + 1}.${EXT}`), BIG ? bmp(h) : svg(h)));
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(composer(w)).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ BrowserWindow }, box) => {
      BrowserWindow.getAllWindows()[0]?.setBounds(box);
    }, WINDOW);
    await w.waitForTimeout(400);
    const filler = Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of a paragraph that is here to be read.`).join('\n\n');

    // ── TAIL: every picture arrives for the first time while following ──────
    await sample(w, null);
    for (let i = 1; i <= HEIGHTS.length; i++) {
      await composer(w).click();
      await composer(w).fill(`REPLY${i} ![picture ${i}](p${i}.${EXT}) ${filler.replace(/\n\n/g, ' // ')}`);
      await composer(w).press('Enter');
      await expect(w.locator('[data-feed-block="assistant"]').filter({ hasText: `FAKE-REPLY: REPLY${i} ` })).toBeVisible({
        timeout: 60_000,
      });
    }
    await expect.poll(() => allLoaded(w), { timeout: 30_000 }).toBe(true);
    await w.waitForTimeout(500);
    report('TAIL', await stop(w), 0);

    // enough conversation after the pictures that they are far above the tail
    await composer(w).click();
    await composer(w).fill('!bulk 60 FILL_');
    await composer(w).press('Enter');
    await expect(w.getByText('FILL_60', { exact: true })).toBeAttached({ timeout: 60_000 });
    await w.waitForTimeout(800);

    // ── read a screen or so up from the tail ────────────────────────────────
    // a REAL wheel, over the conversation: the pin rule tells a person's
    // gesture from the layout's by what could have caused it
    const pane = (await w.locator('[data-feed-region]').first().boundingBox())!;
    await w.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
    for (let i = 0; i < 10; i++) {
      await w.mouse.wheel(0, -100);
      await w.waitForTimeout(40);
    }
    await w.waitForTimeout(600);
    const before = await landmark(w);

    // ── FIRST-SIGHT: the pictures above the reader load as if never seen ────
    await sample(w, before.seq);
    const unseen = await makeUnseen(w, 'above', RESERVED);
    await expect.poll(() => allLoaded(w), { timeout: 30_000 }).toBe(true);
    await w.waitForTimeout(800);
    report(RESERVED ? 'SECOND-SIGHT (size reserved)' : 'FIRST-SIGHT', await stop(w), before.offset, unseen);

    // ── COLD: quit, start again, resume ─────────────────────────────────────
    // Nothing remembers a size now: every picture in the replayed history is a
    // first sight, and the conversation opens at its tail, far below them.
    const home = a.home;
    await a.close();
    a = await launchApp({ home, env: DIRECT });
    const w2 = a.window;
    await a.app.evaluate(({ BrowserWindow }, box) => {
      BrowserWindow.getAllWindows()[0]?.setBounds(box);
    }, WINDOW);
    await expect(w2.locator('[data-feed-region]').first()).toBeVisible({ timeout: 60_000 });
    await sample(w2, null);
    await expect(w2.getByText('FILL_60', { exact: true })).toBeAttached({ timeout: 60_000 });
    await w2.waitForTimeout(1500);
    const pictures = await w2.evaluate(() => {
      const imgs = [...document.querySelectorAll<HTMLImageElement>('[data-feed-region] img.doc-image')];
      return {
        pictures: imgs.length,
        loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
        sized: imgs.filter((i) => i.hasAttribute('height')).length,
        skipped: imgs.filter((i) => !i.checkVisibility({ contentVisibilityAuto: true } as CheckVisibilityOptions)).length,
      };
    });
    report('COLD-TAIL', await stop(w2), 0, pictures);

    // ...and now walk up to them, one notch of the wheel at a time. A notch is
    // 100px: the text under the pointer should move 100px and no more.
    const pane2 = (await w2.locator('[data-feed-region]').first().boundingBox())!;
    await w2.mouse.move(pane2.x + pane2.width / 2, pane2.y + pane2.height / 2);
    const read = (): Promise<{ top: number; height: number; marks: Record<string, number> }> =>
      w2.evaluate(() => {
        const scroller = document.querySelector('[data-feed-region]') as HTMLElement;
        const paneTop = scroller.getBoundingClientRect().top;
        const marks: Record<string, number> = {};
        for (const el of document.querySelectorAll<HTMLElement>('[data-feed-seq]')) {
          const r = el.getBoundingClientRect();
          // only blocks wholly inside the pane: a block the layout is skipping has no honest edge
          if (r.top - paneTop >= 0 && r.bottom - paneTop <= scroller.clientHeight) {
            marks[el.getAttribute('data-feed-seq')!] = r.top - paneTop;
          }
        }
        return { top: scroller.scrollTop, height: scroller.scrollHeight, marks };
      });
    let prev = await read();
    const startHeight = prev.height;
    let notches = 0;
    let jumps = 0;
    let worstJump = 0;
    let heightChanges = 0;
    for (let i = 0; i < 400 && prev.top > 0; i++) {
      await w2.mouse.wheel(0, -100);
      await w2.waitForTimeout(60);
      const now = await read();
      notches += 1;
      // a block seen in both readings says how far the text really moved
      const shared = Object.keys(now.marks).find((k) => k in prev.marks);
      if (shared !== undefined && now.top > 0) {
        const moved = now.marks[shared] - prev.marks[shared];
        const off = Math.abs(moved - 100);
        if (off > 2) {
          jumps += 1;
          if (off > Math.abs(worstJump)) worstJump = moved - 100;
        }
      }
      if (now.height !== prev.height) heightChanges += 1;
      prev = now;
    }
    console.log(
      `PROBE COLD-WALK-UP: ${JSON.stringify({
        notches,
        notchesThatJumped: jumps,
        worstJumpPx: Math.round(worstJump * 10) / 10,
        heightAtTail: startHeight,
        heightAtTop: prev.height,
        heightCorrectionPx: prev.height - startHeight,
        notchesWhereHeightChanged: heightChanges,
      })}`
    );
  });
});
