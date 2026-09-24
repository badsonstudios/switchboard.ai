// Two docked groups side by side — the layout the frame bugs lived in.
//
// Dan, 2026-07-31: "you can see a black space, but there is no line on each
// one." TWO separate causes, both invisible to a single-group test:
//
//  1. dockview sizes a group flush to a clipping ancestor, and on a scaled
//     display a 1px border snaps to ONE DEVICE pixel that the clip boundary
//     rounds away — so the left group's RIGHT border never painted.
//  2. the sash (the 4px drag handle for resizing a split, `z-index: 99`) was
//     painted with the page background by #84, back when a group had no frame
//     at all. Once groups had borders it covered BOTH of them.
//
// The single-group suite in tabs.spec.ts cannot see either: there is no clip
// pressure on the outer edge it checks and no sash at all. Hence this file.
import { test, expect } from '@playwright/test';
import {
  launchApp,
  LaunchedApp,
  tempProjectFolder,
  gridLeafViews,
  persistedLayout,
  readWorkspaceFile,
  writeWorkspaceFile,
  setTheme,
} from './fixtures/app';
import { decodePng, rowLuminance } from './fixtures/png';

/**
 * Boot once, then rewrite the saved dockview layout into two side-by-side
 * leaves and boot again. Splitting through the UI needs dockview's own
 * drag-and-drop state, which a synthetic `dragstart` does not produce; the
 * persisted layout is a supported entry point and is what a real user's
 * workspace restores from anyway.
 */
async function twoGroups(): Promise<LaunchedApp> {
  const first = await launchApp({
    seedFolder: tempProjectFolder(),
    env: { SWITCHBOARD_SEED_PANELS: '2' },
  });
  await first.window.locator('.dv-groupview').first().waitFor({ timeout: 25_000 });
  await first.window.waitForTimeout(1200); // let the layout reach disk
  await first.close();

  const ws = readWorkspaceFile(first.home);
  const layout = persistedLayout(ws);
  const views = gridLeafViews(layout.grid.root.data[0]);
  expect(views.length, 'need at least two panels to split').toBeGreaterThan(1);
  const half = Math.floor(layout.grid.width / 2);
  layout.grid.root.data = [
    { type: 'leaf', data: { views: views.slice(0, 1), activeView: views[0], id: '1' }, size: half },
    { type: 'leaf', data: { views: views.slice(1), activeView: views[1], id: '2' }, size: half },
  ];
  writeWorkspaceFile(first.home, ws);

  const a = await launchApp({ home: first.home });
  await a.window.locator('.dv-groupview').first().waitFor({ timeout: 25_000 });
  await expect(a.window.locator('.dv-groupview')).toHaveCount(2, { timeout: 20_000 });
  await a.window.waitForTimeout(600);
  return a;
}

test.describe('two docked groups (#102 rider)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('every group keeps a pixel of room for its right border', async () => {
    a = await twoGroups();
    const room = await a.window.evaluate(() =>
      [...document.querySelectorAll('.dv-groupview')].map((g) => {
        let clipper = g.parentElement;
        while (clipper && getComputedStyle(clipper).overflowX === 'visible') {
          clipper = clipper.parentElement;
        }
        return clipper
          ? clipper.getBoundingClientRect().right - g.getBoundingClientRect().right
          : 0;
      })
    );
    expect(room.length).toBe(2);
    for (const [i, r] of room.entries()) {
      expect(r, `group ${i} is flush against its clip — its right border will not paint`)
        .toBeGreaterThanOrEqual(1);
    }
  });

  test('the sash cannot paint over the frames it sits between', async () => {
    a = await twoGroups();
    const sash = await a.window.evaluate(() => {
      const s = document.querySelector('.dv-sash');
      return s ? getComputedStyle(s).backgroundColor : null;
    });
    expect(sash, 'no sash between two groups').not.toBeNull();
    // it is 4px wide, absolutely positioned and z-index 99, centred on the
    // seam — any fill at rest lands on both borders
    expect(sash, 'an opaque sash hides the frame on both sides of the seam').toMatch(
      /transparent|, *0\)/
    );
  });

  test('the seam shows a border on BOTH sides', async () => {
    test.skip(
      process.platform === 'linux',
      'reads painted pixels; CI runs xvfb at 8-bit colour where the anti-aliased edge quantises. Covered on Windows + macOS.'
    );
    a = await twoGroups();
    const w = a.window;
    // soft contrast: a light frame on a near-black surface, the case Dan hit
    await setTheme(w, 'soft contrast');
    await w.waitForTimeout(300);

    const b = (await w.locator('.dv-groupview').first().boundingBox())!;
    const file = 'test-results/seam-both-sides.png';
    // a strip across the seam, below the tab strip so only frames are in it
    await w.screenshot({
      path: file,
      clip: { x: b.x + b.width - 12, y: b.y + 120, width: 26, height: 40 },
    });

    const png = decodePng(file);
    const lum = rowLuminance(png, Math.floor(png.height / 2));
    // the darkest column is the gutter; a frame must be brighter than the card
    // interior on EACH side of it
    const gutter = lum.indexOf(Math.min(...lum));
    const interior = lum[0]; // card interior, well left of the seam
    const left = Math.max(...lum.slice(0, gutter));
    const right = Math.max(...lum.slice(gutter + 1));
    expect(left, `no left-hand frame at the seam (interior ${interior.toFixed(0)})`).toBeGreaterThan(
      interior + 40
    );
    expect(
      right,
      `no right-hand frame at the seam (interior ${interior.toFixed(0)})`
    ).toBeGreaterThan(interior + 40);
  });

  /**
   * #903's width guard, here rather than beside the other #903 specs because
   * this is the narrowest card the suite can build — and the numbers below are
   * measured, not assumed, which is the whole point of #885's lesson.
   *
   * WHAT WAS MEASURED, on this machine, at the app's own 800px window minimum:
   *
   * | card            | room for the row | content wants |
   * |-----------------|------------------|---------------|
   * | one, full width | 443px            | 297px (confirmation open) |
   * | one of two, split | 219px          | 157px         |
   *
   * So the row is NOT near overflow today, on any card a user can make — which
   * is a useful answer rather than a disappointing one, and it is recorded here
   * because the first two attempts at this test did not know it. The first
   * asserted "it wrapped or it fits" at full width and **passed with
   * `flexWrap` deleted** — the vacuous guard #885 is about. There is no window
   * size that reaches a wrap: 800px is a hard floor (`minWidth`, `main/index.ts`)
   * and `setContentSize` is clamped to it.
   *
   * WHAT THIS ASSERTS, therefore, is the thing that can actually fail: **nothing
   * in the row hangs off the end of it**, measured from the child rects rather
   * than `scrollWidth`, at the tightest card there is. That bites the day a
   * third control, a longer model name or a wider translation eats the 62px of
   * slack — which is exactly when someone needs to be told. That the row is
   * *able* to wrap is pinned cheaply and deterministically in
   * `FeedView.session-controls.test.tsx` instead.
   */
  test('nothing in the composer options row hangs off a narrow card (#903)', async () => {
    a = await twoGroups();
    const w = a.window;
    // the app's own floor, so any runner lands at the same pressure or worse
    await a.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.unmaximize();
      win.setContentSize(800, win.getContentSize()[1]);
    });
    await w.waitForTimeout(600);

    const row = w.getByTestId('composer-options').first();
    await expect(row).toBeVisible({ timeout: 25_000 });

    /**
     * MEASURED BY SUMMING THE CHILDREN, not from `scrollWidth` — #885's lesson,
     * repeated by this issue: a flex row's `scrollWidth` hides how much its
     * contents actually wanted, and Linux CI renders this text about 5% wider
     * than Windows does, so a Windows-green margin is not a margin at all.
     */
    const m = await row.evaluate((node) => {
      const el = node as HTMLElement;
      // the CONTENT box, taken so both sides of the comparison are in the same
      // units as the child rects
      const inner = el.getBoundingClientRect().width - (el.offsetWidth - el.clientWidth);
      // THE SPACER IS EXCLUDED, and leaving it in was the first cut's bug:
      // `flex: 1` GROWS to eat whatever is left on its line, so summing it back
      // in always lands on "they fit" and the assertion could never fail.
      const kids = Array.from(el.children).filter(
        (c) => Number.parseFloat(getComputedStyle(c).flexGrow || '0') === 0
      );
      const rects = kids.map((c) => c.getBoundingClientRect());
      const gap = Number.parseFloat(getComputedStyle(el).columnGap || '0') || 0;
      return {
        right: el.getBoundingClientRect().right,
        furthestChild: Math.max(...rects.map((k) => k.right)),
        wanted: rects.reduce((n, k) => n + k.width, 0) + gap * Math.max(0, rects.length - 1),
        room: inner,
        lines: new Set(rects.map((k) => Math.round(k.top))).size,
      };
    });

    // THE ASSERTION: nothing hangs off the end of the row. True whether the
    // content fits on one line or wrapped onto two — both are correct outcomes;
    // overflowing is not.
    expect(
      m.furthestChild,
      `a control hangs off the row (wants ${Math.round(m.wanted)}px, has ${Math.round(m.room)}px, ` +
        `on ${m.lines} line(s))`
    ).toBeLessThanOrEqual(m.right + 1);
    // …and the same fact stated from the other side, so a failure names the
    // margin that ran out rather than a pair of pixel coordinates.
    expect(
      m.wanted,
      `the row wants more than one line's room and did not wrap (${m.lines} line(s))`
    ).toBeLessThanOrEqual(m.lines > 1 ? Number.POSITIVE_INFINITY : m.room + 1);

    // and both controls are still ON the card down here, which is the point of
    // the exercise — a row that solved its width problem by dropping a button
    // would satisfy every measurement above.
    await expect(w.getByTestId('composer-clear').first()).toBeVisible();
    await expect(w.getByTestId('composer-compact').first()).toBeVisible();
  });
});
