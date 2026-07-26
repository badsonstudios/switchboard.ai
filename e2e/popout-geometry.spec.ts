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
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

/** popout positions as they currently sit ON DISK */
function persistedPopouts(home: string): Array<{ left: number; top: number }> {
  const file = path.join(home, 'AppData', 'Roaming', 'switchboard', 'workspace.json');
  if (!fs.existsSync(file)) return [];
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const layout = json.layout ?? json.state?.layout;
  return (layout?.popoutGroups ?? [])
    .map((p: { position?: { left: number; top: number } }) => p.position)
    .filter(Boolean);
}

test.describe('popout geometry (#86)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

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

    // move it the way a user drags it somewhere else, then quit at once — NO
    // settling time, which is what made this fail before
    const target = { x: 160, y: 240, width: 620, height: 500 };
    const moved = await first.app.evaluate(async ({ BrowserWindow }, box) => {
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
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, folderB);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(2, { timeout: 25_000 });

    // pop out both cards
    const popOut = w.getByTitle('Pop out into its own window');
    await popOut.first().click();
    await expect.poll(() => first.app.windows().length, { timeout: 15_000 }).toBe(2);
    await popOut.first().click();
    await expect.poll(() => first.app.windows().length, { timeout: 15_000 }).toBe(3);

    // park them far apart, tagged by the session each one hosts
    const placed = await first.app.evaluate(async ({ BrowserWindow }) => {
      const popouts = BrowserWindow.getAllWindows().filter((win) =>
        win.webContents.getURL().includes('popout.html')
      );
      const spots = [
        { x: 60, y: 80, width: 520, height: 420 },
        { x: 700, y: 420, width: 560, height: 460 },
      ];
      popouts.forEach((p, i) => p.setBounds(spots[i]));
      // identify each window by the session title it shows, so the assertion
      // survives any reordering of the window list itself
      return Promise.all(
        popouts.map(async (p) => ({
          bounds: p.getBounds(),
          title: await p.webContents.executeJavaScript('document.body.innerText.slice(0, 400)'),
        }))
      );
    });
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
            title: await p.webContents.executeJavaScript('document.body.innerText.slice(0, 400)'),
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

    const size = { x: 200, y: 200, width: 700, height: 560 };
    await first.app.evaluate(async ({ BrowserWindow }, box) => {
      BrowserWindow.getAllWindows()
        .find((win) => win.webContents.getURL().includes('popout.html'))
        ?.setBounds(box);
    }, size);

    await first.close();
    a = await launchApp({ home: first.home });
    await expect.poll(() => a.app.windows().length, { timeout: 20_000 }).toBe(2);
    const restored = await a.app.evaluate(({ BrowserWindow }) => {
      const popout = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes('popout.html')
      );
      return popout ? popout.getBounds() : null;
    });
    expect(restored).not.toBeNull();
    // dockview stores the INNER size; restoring it as the OUTER size shaved a
    // frame off every launch. useContentSize makes the round-trip lossless.
    expect(Math.abs(restored!.width - size.width)).toBeLessThanOrEqual(20);
    expect(Math.abs(restored!.height - size.height)).toBeLessThanOrEqual(20);
  });
});
