// #1083 — a narrow card's tab strip does not draw its tabs over its readouts.
//
// Seen in the manual's own picture (a 1360px window with a document open
// beside one session, so the card was ~760px): the History tab ran into the
// plan counter, and the branch / changed / usage readouts wrapped onto a second
// line. The strip was allowed to be narrower than its tabs, and the tabs were
// not.
//
// The claim here is geometry and nothing else, so it is stated as geometry: at a
// width where the strip cannot hold everything, no tab overlaps a readout, the
// readouts stay on one line, and nothing is drawn outside the strip. The window
// is sized by the test rather than inherited, for `feed-tail-pin.spec.ts`'s
// reason — a 2560px desktop never reaches this state on its own.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp, registerTempDir } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

/** long enough that the branch readout alone would not fit beside the tabs */
const BRANCH = 'feature/a-branch-name-long-enough-to-crowd-any-card-header-there-is';

/** a repo on a long branch with uncommitted work, so every git readout is showing */
function crowdedRepo(): string {
  const dir = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-narrow-')));
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  };
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'e2e@switchboard.test']);
  git(['config', 'user.name', 'switchboard e2e']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);
  git(['checkout', '-b', BRANCH]);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');
  return dir;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

test.describe('a narrow card header (#1083)', () => {
  let a: LaunchedApp | undefined;

  test.afterEach(async () => {
    await a?.cleanup();
    a = undefined;
  });

  for (const width of [900, 700, 560]) {
    test(`at a ${width}px window the tabs and the readouts keep out of each other's way`, async () => {
      const folder = crowdedRepo();
      a = await launchApp({ seedFolder: folder, env: DIRECT });
      const w = a.window;
      await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
      await a.app.evaluate(
        ({ BrowserWindow }, box) => BrowserWindow.getAllWindows()[0]?.setBounds(box),
        { x: 0, y: 0, width, height: 720 }
      );

      const tabs = w.locator('[data-testid="view-tabs"]');
      const readouts = w.locator('[data-testid="view-readouts"]');
      // the premise: the git readout is really there, or there is nothing to crowd
      await expect(readouts.getByText(/a-branch-name-long-enough/)).toBeAttached({
        timeout: 25_000,
      });
      // …and it is the branch ALONE (#1145): the changes count lives on the
      // Changes tab's badge and the usage strip is off the header.
      await expect(readouts.getByText(/changed/)).toHaveCount(0);

      const measure = (): Promise<{ strip: Box; tabs: Box[]; readouts: Box; parts: Box[] }> =>
        w.evaluate(() => {
          const box = (el: Element): Box => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          };
          const list = document.querySelector('[data-testid="view-tabs"]');
          const side = document.querySelector('[data-testid="view-readouts"]');
          if (!list || !side || !list.parentElement) throw new Error('no tab strip to measure');
          return {
            strip: box(list.parentElement),
            tabs: [...list.querySelectorAll('[role="tab"]')].map(box),
            readouts: box(side),
            parts: [...side.children].map(box),
          };
        });

      // settled: the window resize has reached the card
      await expect
        .poll(async () => Math.round((await measure()).strip.right - (await measure()).strip.left))
        .toBeLessThan(width);
      const m = await measure();
      expect(m.tabs.length).toBeGreaterThan(2);

      // 1. every tab ends before the readouts begin (half a pixel for rounding)
      const lastTab = Math.max(...m.tabs.map((t) => t.right));
      expect(lastTab, 'a tab is drawn over the readouts').toBeLessThanOrEqual(m.readouts.left + 0.5);
      // 2. the readouts are one line: every part of them shares a row with the tabs
      const stripHeight = m.strip.bottom - m.strip.top;
      const tabHeight = Math.max(...m.tabs.map((t) => t.bottom - t.top));
      expect(stripHeight, 'the strip grew a second line').toBeLessThan(tabHeight + 12);
      // 3. and they stop at the strip's own edge rather than spilling past it
      expect(m.readouts.right).toBeLessThanOrEqual(m.strip.right + 0.5);
      await expect(tabs).toBeVisible();
    });
  }
});
