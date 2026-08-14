// Issue #86 — a popped-out window must come back where you left it.
//
// The failure this guards: dockview only notices a popout moved via a debounced
// requestAnimationFrame poll of screenX, and rAF throttles in a backgrounded
// window — exactly the state the main window is in while you drag a popout onto
// another monitor. Quit before the poll catches up and the STALE (open-time)
// position is what gets restored, which is how Dan's popout came back
// straddling two monitors. The main process now drives the save from Electron's
// own move/resize events, so quitting immediately after a move is safe.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import {
  findFile,
  launchApp,
  LaunchedApp,
  onTestDisplay,
  PersistedPopoutGroup,
  readWorkspaceFile,
  registeredPopouts,
  tempProjectFolder,
  workspaceJsonPath,
} from './fixtures/app';

/**
 * The popout groups as they currently sit ON DISK.
 *
 * Deliberately NOT `persistedLayout()`: the callers poll this while the app is
 * still coming up, so "no file / no layout yet" has to answer "none", never
 * throw — a throw inside `expect.poll` fails the whole poll instead of retrying.
 */
function persistedPopoutGroups(home: string): PersistedPopoutGroup[] {
  if (!fs.existsSync(workspaceJsonPath(home))) return [];
  const ws = readWorkspaceFile(home);
  return (ws.layout ?? ws.state?.layout)?.popoutGroups ?? [];
}

/** popout positions as they currently sit ON DISK */
function persistedPopouts(home: string): Array<{ left: number; top: number }> {
  return persistedPopoutGroups(home)
    .map((p) => p.position)
    .filter((pos) => pos != null);
}

/**
 * A popout is only durable once dockview has REGISTERED it in the layout — the
 * OS window appearing is not enough (see `registeredPopouts`). Every test here
 * quits on purpose without settling, so each one has to wait for the thing that
 * actually survives the quit, or it is racing the app on a busy machine (#165).
 */
async function waitForRegisteredPopouts(a: LaunchedApp, n: number): Promise<void> {
  await expect
    .poll(() => registeredPopouts(a), { timeout: 20_000 })
    .toBe(n);
}

test.describe('popout geometry (#86)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => {
    // The app's log lives inside the temp home and cleanup() deletes it. Both
    // launches append to the SAME file, so one artifact carries the whole story
    // (#165): what the quit flushed, whether the save failed, how many popouts
    // the relaunch was asked to restore, and whether each one opened. Useless if
    // the only copy is gone before anyone reads it, so a failing test keeps it
    // (CI uploads test-results/).
    const info = test.info();
    if (a && info.status !== info.expectedStatus) {
      const f = findFile(a.home, 'switchboard.log');
      if (f) await info.attach('switchboard.log', { path: f });
    }
    await a?.cleanup();
  });

  test.skip(
    process.platform === 'linux',
    'popout opens a 2nd OS window — unreliable under headless xvfb; covered on Windows + macOS'
  );

  test('a move is persisted even when the app quits immediately after', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const first = a;
    const w = first.window;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });

    await w.getByTitle('Pop out into its own window').click();
    await expect.poll(() => first.app.windows().length, { timeout: 15_000 }).toBe(2);
    await waitForRegisteredPopouts(first, 1);

    // move it the way a user drags it somewhere else, then quit at once — NO
    // settling time, which is what made this fail before.
    //
    // `onTestDisplay` only shifts these coordinates onto whichever monitor the
    // run was pointed at (#479) — `{0,0}` and therefore a no-op unless
    // SWITCHBOARD_E2E_MONITOR is set. Every assertion below is against `target`
    // itself or against a before/after pair, so what this test measures is
    // unchanged either way; what it stops is the popout being yanked back onto
    // the developer's own screen halfway through.
    const target = onTestDisplay(first, { x: 160, y: 240, width: 620, height: 500 });
    const moved = await first.app.evaluate(({ BrowserWindow }, box) => {
      const popout = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes('popout.html')
      );
      if (!popout) return null;
      popout.setBounds(box);
      return popout.getBounds();
    }, target);
    expect(moved, 'no popout window found').not.toBeNull();

    // the move must reach DISK while the app is still running — that's the
    // main-process move/resize nudge doing its job, independent of the
    // belt-and-braces flush at close
    await expect
      .poll(() => persistedPopouts(first.home)[0]?.left ?? null, { timeout: 10_000 })
      .toBe(target.x);

    await first.close();
    a = await launchApp({ home: first.home });
    await expect(a.window.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });
    await expect.poll(() => a.app.windows().length, { timeout: 20_000 }).toBe(2);

    const restored = await a.app.evaluate(({ BrowserWindow }) => {
      const popout = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes('popout.html')
      );
      return popout ? popout.getBounds() : null;
    });
    expect(restored, 'popout did not reopen').not.toBeNull();

    // within a frame's worth of slack — the point is it's WHERE WE PUT IT, not
    // back at the open-time spot (which sat ~700px away)
    expect(Math.abs(restored!.x - target.x)).toBeLessThanOrEqual(20);
    expect(Math.abs(restored!.y - target.y)).toBeLessThanOrEqual(20);
  });

  test('two popouts keep their own positions — they never swap', async () => {
    const folderA = tempProjectFolder();
    const folderB = tempProjectFolder();
    a = await launchApp({ seedFolder: folderA });
    const first = a;
    const w = first.window;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });
    await first.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, folderB);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(2, { timeout: 25_000 });

    // pop out both cards
    const popOut = w.getByTitle('Pop out into its own window');
    await popOut.first().click();
    await expect.poll(() => first.app.windows().length, { timeout: 15_000 }).toBe(2);
    await popOut.first().click();
    await expect.poll(() => first.app.windows().length, { timeout: 15_000 }).toBe(3);
    // both windows exist; wait until both are in the layout that gets saved
    await waitForRegisteredPopouts(first, 2);

    // park them far apart, tagged by the session each one hosts. The spots are
    // computed OUT HERE now (they used to be literals inside the evaluate) so
    // they can be shifted onto the run's display — see the first test.
    const spots = [
      onTestDisplay(first, { x: 60, y: 80, width: 520, height: 420 }),
      onTestDisplay(first, { x: 700, y: 420, width: 560, height: 460 }),
    ];
    const placed = await first.app.evaluate(async ({ BrowserWindow }, boxes) => {
      const popouts = BrowserWindow.getAllWindows().filter((win) =>
        win.webContents.getURL().includes('popout.html')
      );
      popouts.forEach((p, i) => p.setBounds(boxes[i]));
      // identify each window by the session title it shows, so the assertion
      // survives any reordering of the window list itself
      return Promise.all(
        popouts.map(async (p) => ({
          bounds: p.getBounds(),
          // Electron types `executeJavaScript` as `Promise<any>` (it cannot know
          // what the snippet returns). `String()` NARROWS it at runtime, which a
          // cast would only pretend to do — and the expression really is one.
          title: String(
            await p.webContents.executeJavaScript('document.body.innerText.slice(0, 400)')
          ),
        }))
      );
    }, spots);
    expect(placed).toHaveLength(2);

    await first.close();
    a = await launchApp({ home: first.home });
    await expect.poll(() => a.app.windows().length, { timeout: 25_000 }).toBe(3);
    const restored = await a.app.evaluate(({ BrowserWindow }) =>
      Promise.all(
        BrowserWindow.getAllWindows()
          .filter((win) => win.webContents.getURL().includes('popout.html'))
          .map(async (p) => ({
            bounds: p.getBounds(),
            // see the same call above: `executeJavaScript` is `Promise<any>`
            title: String(
              await p.webContents.executeJavaScript('document.body.innerText.slice(0, 400)')
            ),
          }))
      )
    );

    // each window must be back at ITS OWN spot — the swap failure mode puts
    // each of them at the other's coordinates, which this catches
    for (const before of placed) {
      const folderName = before.title.match(/sb-e2e-proj-\w+/)?.[0];
      const after = restored.find((r) => folderName && r.title.includes(folderName));
      expect(after, `no restored popout for ${folderName}`).toBeTruthy();
      expect(Math.abs(after!.bounds.x - before.bounds.x)).toBeLessThanOrEqual(20);
      expect(Math.abs(after!.bounds.y - before.bounds.y)).toBeLessThanOrEqual(20);
    }
  });

  test('a popout keeps its size across relaunches instead of shrinking', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const first = a;
    const w = first.window;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });
    await w.getByTitle('Pop out into its own window').click();
    await expect.poll(() => first.app.windows().length, { timeout: 15_000 }).toBe(2);
    await waitForRegisteredPopouts(first, 1);

    // Staged so every way this can go wrong fails DIFFERENTLY (#165), because
    // "windows().length never reached 2" named none of them: the window never
    // opened, or it opened but was never registered (both above); the resize
    // didn't take (here); the quit didn't persist it, or the restore didn't
    // reopen it (both below); or it came back mis-measured (last).
    const size = onTestDisplay(first, { x: 200, y: 200, width: 700, height: 560 });
    const applied = await first.app.evaluate(({ BrowserWindow }, box) => {
      const popout = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes('popout.html')
      );
      if (!popout) return null;
      popout.setBounds(box);
      return popout.getBounds();
    }, size);
    expect(applied, 'no popout window found to resize').not.toBeNull();
    // If the window manager refused the size, the restore assertion below would
    // blame the round-trip for something that never happened.
    expect(Math.abs(applied!.width - size.width), 'the resize itself did not take')
      .toBeLessThanOrEqual(20);

    await first.close();
    // What survived the quit, before anything tries to restore it. A layout with
    // no popout in it can only come back as one window, and that is a different
    // bug from a restore that drops one.
    expect(persistedPopoutGroups(first.home), 'the quit did not persist the popout')
      .toHaveLength(1);

    a = await launchApp({ home: first.home });
    await expect.poll(() => a.app.windows().length, { timeout: 20_000 }).toBe(2);
    const restored = await a.app.evaluate(({ BrowserWindow }) => {
      const popout = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes('popout.html')
      );
      return popout ? popout.getBounds() : null;
    });
    expect(restored, 'a second window opened but it is not the popout').not.toBeNull();
    // dockview stores the INNER size; restoring it as the OUTER size shaved a
    // frame off every launch. useContentSize makes the round-trip lossless.
    expect(Math.abs(restored!.width - size.width)).toBeLessThanOrEqual(20);
    expect(Math.abs(restored!.height - size.height)).toBeLessThanOrEqual(20);
  });
});
