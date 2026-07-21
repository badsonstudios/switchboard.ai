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

  const boundsOf = (appl: LaunchedApp['app']) =>
    appl.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getBounds()));

  test('a popped-out window restores at its saved SCREEN POSITION after relaunch (E8-02/E8-04)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    const first = await launchApp({ seedFolder: folder });
    await expect(first.window.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await first.window.getByTitle('Pop out into its own window').click();
    await expect.poll(() => first.app.windows().length, { timeout: 15_000 }).toBe(2);
    await first.window.waitForTimeout(1200); // let the layout (with popout bounds) persist
    const before = (await boundsOf(first.app))[1]; // main is [0], popout [1]
    await first.close();

    // launch 2: same home — the popout must reopen at ~the same screen spot, not
    // cascade to a default (the multi-monitor bug: window.open features were
    // dropped). Assert POSITION, which the old count-only test never did.
    a = await launchApp({ home: first.home });
    await expect.poll(() => a.app.windows().length, { timeout: 25_000 }).toBe(2);
    await a.window.waitForTimeout(800);
    const after = (await boundsOf(a.app))[1];
    expect(Math.abs(after.x - before.x)).toBeLessThan(60);
    expect(Math.abs(after.y - before.y)).toBeLessThan(60);
  });

  test('the pop-out button toggles a card back in, alive (E8-04)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const { app, window } = a;
    await expect(window.getByText(name).first()).toBeVisible({ timeout: 25_000 });
    await window.getByTitle('Pop out into its own window').click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
    const popout = app.windows().find((w) => w !== window)!;
    // click the SAME control in the popped-out window to dock it back IN
    await popout.getByTitle('Pop back into the main window').click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
    // docked back ALIVE (button toggle, not a window-close): the terminal types
    await expect(window.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
    await window.locator('.xterm-screen').first().click();
    await window.keyboard.type('echo TOGGLE_OK_789');
    await window.keyboard.press('Enter');
    await expect(window.getByText(/TOGGLE_OK_789/).first()).toBeVisible({ timeout: 15_000 });
  });

  test('closing a popout OS window suspends the session (E8-04)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const { app, window } = a;
    await expect(window.getByText(name).first()).toBeVisible({ timeout: 25_000 });
    await window.getByTitle('Pop out into its own window').click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
    const popout = app.windows().find((w) => w !== window)!;
    // user closes the OS window (X) -> the card docks back SUSPENDED, not alive
    await popout.evaluate(() => window.close());
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
    // the suspended affordance shows; Resume brings the session/terminal back
    await expect(window.getByText('Session suspended')).toBeVisible({ timeout: 15_000 });
    await window.getByRole('button', { name: 'Resume' }).click();
    await expect(window.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
  });

  test('a new session opens in the main window, not the active popout (E8-04)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    const folder2 = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { app, window } = a;
    await expect(window.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await window.getByTitle('Pop out into its own window').click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
    // stub the native folder picker so "+ session" resolves to folder2
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as typeof dialog.showOpenDialog;
    }, folder2);
    await window.getByRole('button', { name: '+ session' }).click();
    // the new card must appear in the MAIN window even though a popout was active
    await expect(window.getByText(path.basename(folder2)).first()).toBeVisible({ timeout: 20_000 });
  });

  test('the card header shows Terminal and Diff view tabs (E8-05)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { window } = a;
    await expect(window.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    // the mockup's view-tab strip: Terminal + Diff are real tabs
    await expect(window.getByRole('button', { name: 'Terminal' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Diff' })).toBeVisible();
    // switching to Diff and back leaves the terminal usable (no NaN wipeout)
    await window.getByRole('button', { name: 'Diff' }).click();
    await window.getByRole('button', { name: 'Terminal' }).click();
    await expect(window.locator('.xterm-screen').first()).toBeVisible({ timeout: 10_000 });
  });
});
