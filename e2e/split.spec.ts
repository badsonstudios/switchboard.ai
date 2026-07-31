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
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';
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

  const file = path.join(first.home, 'AppData', 'Roaming', 'switchboard', 'workspace.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const layout = json.layout ?? json.state.layout;
  const views: string[] = layout.grid.root.data[0].data.views;
  expect(views.length, 'need at least two panels to split').toBeGreaterThan(1);
  const half = Math.floor(layout.grid.width / 2);
  layout.grid.root.data = [
    { type: 'leaf', data: { views: views.slice(0, 1), activeView: views[0], id: '1' }, size: half },
    { type: 'leaf', data: { views: views.slice(1), activeView: views[1], id: '2' }, size: half },
  ];
  fs.writeFileSync(file, JSON.stringify(json));

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
    await w.getByRole('button', { name: 'soft contrast', exact: true }).click();
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
});
