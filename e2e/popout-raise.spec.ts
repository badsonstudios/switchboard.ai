// #571 — a popped-out session comes to the FRONT when you ask for it, and only
// when you ask for it.
//
// TWO RULES, and the owner wants both:
//
//   1. clicking a popped-out session's row in the rail RAISES its window. It
//      did not, and the reason is worth keeping: `focusSession` has asked for
//      exactly this since E9-01 — `location.getWindow()?.focus()` — but
//      `window.focus()` does not raise an OS window on Windows. The intent was
//      right and the mechanism could not carry it, so main raises it now.
//   2. focusing the MAIN window does NOT drag popouts forward. That is today's
//      behaviour, the owner asked for it by name, and nothing in (1) touches it
//      — raising only ever happens on an explicit request for one session.
//
// Window z-order is not readable from the DOM, so both are asserted through
// Electron: `BrowserWindow.isFocused()` is the OS's own answer.
import { test, expect } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, skipPopoutOnLinux, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

/** Which window the OS says has focus — 'main', 'popout', or 'none'. */
const focusedWindow = (a: LaunchedApp): Promise<string> =>
  a.app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isFocused()) continue;
      return w.webContents.getURL().includes('popout.html') ? 'popout' : 'main';
    }
    return 'none';
  });

test.describe('raising a popped-out session (#571)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  test('clicking its rail row brings the window forward — and the main window does not', async () => {
    test.setTimeout(180_000);
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const { app, window: w } = a;
    await expect(w.getByText(name).first()).toBeVisible({ timeout: 25_000 });

    await w.getByTitle('Pop out into its own window').click();
    await expect
      .poll(() => app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 20_000,
      })
      .toBe(1);

    // put the MAIN window in front, which is the state the report starts from:
    // the popout exists and is behind something
    await a.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(
        (win) => !win.webContents.getURL().includes('popout.html')
      );
      main?.focus();
    });
    await expect.poll(() => focusedWindow(a!), { timeout: 15_000 }).toBe('main');

    // RULE 2, checked here rather than in a test of its own: bringing the main
    // window forward left the popout where it was. If raising were wired to
    // window focus instead of to an explicit request, this is where it would
    // show.
    expect(await focusedWindow(a)).toBe('main');

    // RULE 1: ask for that session by clicking its row
    await w.locator('nav [draggable="true"]').filter({ hasText: name }).first().click();

    await expect
      .poll(() => focusedWindow(a!), { timeout: 15_000 })
      .toBe('popout');
  });
});
