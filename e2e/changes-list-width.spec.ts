// #1142 — the Changes tab's file list shows whole file names, and can be widened.
//
// The owner's screenshot: two cards side by side, and every changed file cut to
// a few letters — "PROGR…", "CMakeLi…", "Wrappe…". Measured in the real app with
// those names, a 232px row gave the name 57px and kept ~125px empty for buttons
// that only appear on hover.
//
// Everything here is geometry, so it is stated as geometry and measured in the
// real app: jsdom lays nothing out, and the defect was two inline styles that
// read perfectly well in the source.
import { test, expect, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp, registerTempDir } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

/** the owner's own kind of names, at the depth he had them */
const TRACKED = [
  'docs/plans/PROGRESS.md',
  'src/core/CMakeLists.txt',
  'src/formats/pe/WrappedPayloadBuilder.cpp',
];
const UNTRACKED = ['src/crypto/SecureRandomGenerator.cpp', 'tests/code_packer_roundtrip_test.cpp'];

function repo(): string {
  const dir = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-1142-')));
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  };
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'e2e@switchboard.test']);
  git(['config', 'user.name', 'switchboard e2e']);
  for (const f of TRACKED) write(f, 'one\n');
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);
  for (const f of [...TRACKED, ...UNTRACKED]) write(f, 'two\nthree\n');
  return dir;
}

const list = (w: Page) => w.locator('.scm-sidebar').first();
const row = (w: Page, file: string) => w.locator(`.scm-row[data-path="${file}"]`).first();

async function openChanges(w: Page, folder: string): Promise<void> {
  await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
  await w.locator('[data-testid="view-tabs"] [data-vtab="diff"]').first().click();
  await expect(w.locator('.scm-row')).toHaveCount(TRACKED.length + UNTRACKED.length, {
    timeout: 25_000,
  });
}

/** how much of its text an element is showing: its box against what it needs */
const fit = (w: Page, file: string): Promise<{ shown: number; needs: number; left: number }> =>
  row(w, file)
    .locator('.scm-name')
    .evaluate((el) => ({
      shown: el.clientWidth,
      needs: el.scrollWidth,
      left: el.getBoundingClientRect().left,
    }));

test.describe('the Changes list shows whole file names (#1142)', () => {
  let a: LaunchedApp | undefined;

  test.afterEach(async () => {
    await a?.cleanup();
    a = undefined;
  });

  test('at its ordinary width, every one of these names is shown in full', async () => {
    const folder = repo();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await openChanges(w, folder);
    expect(Math.round((await list(w).boundingBox())!.width)).toBe(240); // unchanged default

    for (const file of [...TRACKED, ...UNTRACKED]) {
      const f = await fit(w, file);
      // not cut: the box is as wide as the text
      expect(f.needs, `${path.basename(file)} is cut off`).toBeLessThanOrEqual(f.shown);
    }
  });

  test('reaching for a row’s buttons moves nothing in it', async () => {
    const folder = repo();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await openChanges(w, folder);
    const file = TRACKED[2];
    const before = await fit(w, file);
    const statBefore = (await row(w, file).locator('.scm-row-stat').boundingBox())!;

    await row(w, file).hover();
    const acts = row(w, file).locator('.scm-row-acts');
    await expect(acts).toBeVisible();
    // the name is exactly where it was, and exactly as wide
    const after = await fit(w, file);
    expect(after).toEqual(before);
    // the buttons are inside the row, at its end, over where the numbers are
    const box = (await acts.boundingBox())!;
    const rowBox = (await row(w, file).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5);
    expect(box.x).toBeLessThanOrEqual(statBefore.x);
    // …and one of them really takes a click there
    await acts.locator('button').first().hover();
    await expect(acts.locator('button').first()).toBeVisible();
  });

  test('the list’s edge drags wider, stays wider on a relaunch, and resets', async () => {
    const folder = repo();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const first = a;
    const w = first.window;
    await openChanges(w, folder);

    const edge = w.getByTestId('scm-resize').first();
    const start = (await list(w).boundingBox())!;
    const box = (await edge.boundingBox())!;
    const y = box.y + box.height / 2;
    await w.mouse.move(box.x + box.width / 2, y);
    await w.mouse.down();
    await w.mouse.move(box.x + box.width / 2 + 120, y, { steps: 8 });
    await w.mouse.up();
    await expect
      .poll(async () => Math.round((await list(w).boundingBox())!.width))
      .toBe(Math.round(start.width) + 120);
    // the diff beside it still has room
    const pane = (await list(w).locator('xpath=..').boundingBox())!;
    expect(pane.width - (start.width + 120)).toBeGreaterThanOrEqual(200);

    await w.waitForTimeout(800); // let the debounced ui-blob save reach disk
    await first.close();
    a = await launchApp({ home: first.home, env: DIRECT });
    const w2 = a.window;
    await openChanges(w2, folder);
    await expect
      .poll(async () => Math.round((await list(w2).boundingBox())!.width))
      .toBe(Math.round(start.width) + 120);

    // double-click the edge: back to the width it shipped with
    await w2.getByTestId('scm-resize').first().dblclick();
    await expect.poll(async () => Math.round((await list(w2).boundingBox())!.width)).toBe(240);
  });
});
