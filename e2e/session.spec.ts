import { test, expect } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

// Pop-out tests open a real SECOND OS window (window.open -> BrowserWindow).
// That is reliable on Windows + macOS but flaky under the headless xvfb display
// used on Linux CI (second-window creation intermittently never completes), so
// we skip the window-count assertions there. Coverage is preserved on the two
// platforms where multi-window works — including Windows, Dan's primary target.
const POPOUT_FLAKY_HERE = process.platform === 'linux';
const skipPopoutOnLinux = (): void =>
  test.skip(POPOUT_FLAKY_HERE, 'dockview popout opens a 2nd OS window — unreliable under headless xvfb; covered on Windows + macOS');

test.describe('a session card', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('spawns with a live terminal and the usage strip (E3-02 / E7-01)', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const { window } = a;

    // the card appears (tab shows the folder name)
    await expect(window.getByText(name).first()).toBeVisible({ timeout: 25_000 });
    // usage strip is present from the start (zeros until real activity)
    await expect(window.getByText('↑ 0').first()).toBeVisible({ timeout: 15_000 });

    // the terminal is a REAL pty (fake provider spawns the OS shell): typing a
    // command produces output — proves input -> pty -> render end to end
    await window.locator('.xterm-screen').first().click();
    await window.keyboard.type('echo E2E_MARKER_123');
    await window.keyboard.press('Enter');
    await expect(window.getByText(/E2E_MARKER_123/).first()).toBeVisible({ timeout: 15_000 });
  });

  test('pops out into a second OS window (E8-01)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { app, window } = a;

    await expect(window.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    expect(app.windows().length).toBe(1);

    await window.getByTitle('Pop out into its own window').click();
    // dockview opens a real second OS window (the file:// blocker fix)
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
  });

  test('appears in the rail with a status dot', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const { window } = a;
    // rail lists the session (card-keyed view, E7-05)
    const rail = window.locator('nav');
    await expect(rail.getByText(name).first()).toBeVisible({ timeout: 25_000 });
  });

  test('a popped-out window is restored after relaunch (E8-02)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    // launch 1: pop out, then close (keep the home so state persists)
    const first = await launchApp({ seedFolder: folder });
    await expect(first.window.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await first.window.getByTitle('Pop out into its own window').click();
    await expect.poll(() => first.app.windows().length, { timeout: 15_000 }).toBe(2);
    // let the layout (with the popout) persist, then close keeping the home
    await first.window.waitForTimeout(1000);
    await first.close();

    // launch 2: same home, no seed — the popout should reopen from the layout
    a = await launchApp({ home: first.home });
    await expect.poll(() => a.app.windows().length, { timeout: 25_000 }).toBe(2);
  });

  test('closing a popout window rejoins the card without killing the session (E8-03)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const { app, window } = a;
    await expect(window.getByText(name).first()).toBeVisible({ timeout: 25_000 });

    await window.getByTitle('Pop out into its own window').click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
    const popout = app.windows().find((w) => w !== window)!;
    // the live terminal rode along into the popped-out window
    await expect(popout.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
    // the rail in the main window still lists the (popped-out) card — navigable
    await expect(window.locator('nav').getByText(name).first()).toBeVisible();

    // close the popout the way a user does — the window's own close, which
    // fires the unload dockview listens for (Playwright's page.close() would
    // hard-kill the window and skip that teardown). DESIGN.md: closing a
    // popped-out window docks the session back — it never kills the session.
    await popout.evaluate(() => window.close());
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);

    // the card docked back into the main window and the session is STILL ALIVE:
    // the pty kept running in main, so the rejoined terminal re-attaches and
    // typing still produces output (proves session survived the round-trip)
    await expect(window.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
    await window.locator('.xterm-screen').first().click();
    await window.keyboard.type('echo REJOIN_OK_456');
    await window.keyboard.press('Enter');
    await expect(window.getByText(/REJOIN_OK_456/).first()).toBeVisible({ timeout: 15_000 });
  });
});
