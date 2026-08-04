import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  launchApp,
  LaunchedApp,
  registerTempDir,
  sweepTempDirs,
  tempProjectFolder,
  workspaceJsonPath,
} from './fixtures/app';

// the banner's lead line, verbatim from en.json
const NOTICE = 'Nothing in this workspace will be saved.';

/**
 * A home whose workspace file was written by a version this build has never
 * heard of — the one condition that makes the store refuse to save (#110).
 *
 * Seeded BEFORE the first launch: launchApp only creates the AppData folders,
 * never workspace.json, so the app's very first load reads ours.
 */
function futureWorkspaceHome(): { home: string; contents: string } {
  // Ours, not the fixture's — so hand it to the fixture's registry and let the
  // sweep take it, with retries and a requeue if Electron is slow to let go.
  // A bare `rmSync` in a `finally` could THROW and fail a test that had
  // already passed (#213).
  const home = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-')));
  const wsPath = workspaceJsonPath(home);
  fs.mkdirSync(path.dirname(wsPath), { recursive: true });
  const contents = JSON.stringify({ version: 99, sessions: [], groups: [] }, null, 2);
  fs.writeFileSync(wsPath, contents);
  return { home, contents };
}

/**
 * The banner appears only after an IPC round-trip, so an instant "it is not
 * there" would pass while the answer was still in flight — and would keep
 * passing for the regression that matters (a banner that renders once
 * `isReadOnly()` resolves). Make the same call from the page and wait for it:
 * once THAT has answered, the component's own call has too.
 */
async function readOnlyAnswered(window: Page): Promise<void> {
  await window.evaluate(() =>
    (
      window as unknown as {
        switchboard: { workspace: { isReadOnly: () => Promise<boolean> } };
      }
    ).switchboard.workspace.isReadOnly()
  );
}

test.describe('a workspace file written by a newer version', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    await a?.cleanup();
    a = undefined;
  });

  test('says so on screen, and leaves the file byte-identical', async () => {
    const { home, contents: future } = futureWorkspaceHome();
    const wsPath = workspaceJsonPath(home);

    try {
      a = await launchApp({ home });
    } catch (err) {
      // the fixture only self-cleans a home it created — this one is ours
      await sweepTempDirs();
      throw err;
    }
    // fail-open first: a future file must still BOOT (#110), not blank the app
    await expect(a.window.getByRole('button', { name: '+ session' })).toBeVisible();
    await expect(a.window.getByRole('status').filter({ hasText: NOTICE })).toBeVisible();

    // and the promise the banner makes is kept — quitting writes nothing, so
    // whatever the newer version put in that file survives the downgrade.
    // This test owns the teardown from here: `cleanup()` would close a second
    // time, and `app.process()` throws once the app is gone.
    const app = a;
    a = undefined;
    await app.close();
    try {
      expect(fs.readFileSync(wsPath, 'utf8')).toBe(future);
    } finally {
      await sweepTempDirs();
    }
  });

  // #208 — a popped-out session is its own OS window with none of the app's
  // chrome in it. Work the whole run in one (which is what popping out is FOR)
  // and #168's notice never reaches you: the same silent data loss it exists to
  // prevent, one window over.
  test('says so in a popped-out window too, without covering the session', async () => {
    test.skip(
      process.platform === 'linux',
      'popout opens a 2nd OS window — unreliable under headless xvfb; covered on Windows + macOS'
    );
    const { home } = futureWorkspaceHome();
    try {
      a = await launchApp({ home, seedFolder: tempProjectFolder() });
    } catch (err) {
      await sweepTempDirs(); // the fixture only self-cleans its own; ours is registered
      throw err;
    }
    const app = a;
    const w = app.window;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });
    await expect(w.getByRole('status').filter({ hasText: NOTICE })).toBeVisible();

    await w.getByTitle('Pop out into its own window').click();
    const isPopout = (p: Page): boolean => p.url().includes('popout.html');
    await expect
      .poll(() => app.app.windows().filter(isPopout).length, { timeout: 20_000 })
      .toBe(1);
    const popout = app.app.windows().find(isPopout)!;

    await expect(popout.getByRole('status').filter({ hasText: NOTICE })).toBeVisible();

    // …and it made ROOM for itself. dockview positions its container with inline
    // styles, so the notice would otherwise be underneath it — invisible, or (if
    // we overlaid it) sitting on top of the tab strip the user needs. The
    // stylesheet in popout.html is the only thing holding this; if it rots, this
    // is the assertion that says so.
    const geometry = await popout.evaluate(() => {
      const rect = (el: Element | null): DOMRect | null =>
        el ? (el.getBoundingClientRect().toJSON() as DOMRect) : null;
      const host = document.querySelector<HTMLElement>('[data-sb-banner-host]');
      return {
        notice: rect(host),
        // what the notice WANTS to be tall, so "squeezed to a sliver" fails too
        noticeWanted: host?.scrollHeight ?? 0,
        dockview: rect(document.getElementById('dv-popout-window')),
        innerHeight: window.innerHeight,
      };
    });
    expect(geometry.notice, 'no notice host in the popout document').not.toBeNull();
    expect(geometry.dockview, 'dockview has no container in the popout').not.toBeNull();
    expect(geometry.notice!.height, 'the notice is clipped').toBeGreaterThanOrEqual(
      geometry.noticeWanted - 1
    );
    expect(geometry.notice!.height, 'the notice took no vertical space').toBeGreaterThan(10);
    // the session starts where the notice ends — neither overlapping…
    expect(Math.abs(geometry.dockview!.top - geometry.notice!.bottom)).toBeLessThanOrEqual(1);
    // …nor pushed off the bottom of the window
    expect(geometry.dockview!.bottom).toBeLessThanOrEqual(geometry.innerHeight + 1);
  });

  test('is absent for a normal workspace', async () => {
    a = await launchApp();
    await expect(a.window.getByRole('button', { name: '+ session' })).toBeVisible();
    await readOnlyAnswered(a.window);
    await expect(a.window.getByText(NOTICE)).toHaveCount(0);
  });
});
