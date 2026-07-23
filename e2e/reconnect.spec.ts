// P2-E8-06: display reconnect offer. CI can't hotplug a monitor, so the test
// drives the real rescue path (popout position edited off-display -> relaunch
// rescues it into the grid + stashes it), then replays the display-added
// signal with a synthetic work-area list that "contains" the lost monitor.
// Accepting re-pops the card; the offer itself is never automatic.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

// popout windows are flaky under xvfb — covered on Windows (+macOS locally),
// same skip as session.spec's popout tests
const skipOnLinux = () =>
  test.skip(process.platform === 'linux', 'popout window-open is unreliable under xvfb');

function workspaceJsonPath(home: string): string {
  const base =
    process.platform === 'win32'
      ? path.join(home, 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : path.join(home, '.config');
  return path.join(base, 'switchboard', 'workspace.json');
}

test.describe('display reconnect offer (E8-06)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('rescued popout -> offer on display return -> accept re-pops; ignore changes nothing', async () => {
    skipOnLinux();
    const folder = tempProjectFolder();
    const title = folder.split(/[\\/]/).pop()!;
    const FAR = { x: 90_000, y: 0, width: 2000, height: 1200 };

    // 1. pop a card out, then quit keeping the profile
    a = await launchApp({ seedFolder: folder }); // shared handle first (#16)
    const first = a;
    await expect(first.window.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    await first.window.getByTitle('Pop out into its own window').click();
    await expect.poll(() => first.app.windows().length, { timeout: 15_000 }).toBe(2);
    await first.window.waitForTimeout(900); // debounced layout save
    await first.close();

    // 2. move the saved popout onto a "monitor" that no longer exists
    const wsPath = workspaceJsonPath(first.home);
    const ws = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
    const pg = ws.layout?.popoutGroups?.[0];
    expect(pg, 'a popout group was persisted').toBeTruthy();
    pg.position = { left: FAR.x + 100, top: FAR.y + 60, width: 800, height: 600 };
    fs.writeFileSync(wsPath, JSON.stringify(ws));

    // 3. relaunch: the popout's position is rescued — it reopens near the
    //    main window (E8-02 semantics), NOT out at the lost display's spot
    a = await launchApp({ home: first.home });
    const w = a.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    await expect.poll(() => a.app.windows().length, { timeout: 15_000 }).toBe(2);
    const popoutX = async (): Promise<number[]> =>
      a.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .filter((x) => !x.webContents.getURL().includes('index.html'))
          .map((x) => x.getBounds().x)
      );
    expect((await popoutX()).every((x) => x < 50_000)).toBe(true); // rescued near main
    // no offer yet — a rescue alone must not nag
    await expect(w.getByText('A saved monitor is back — restore its pop-out layout?')).toHaveCount(0);

    // the synthetic display-added payload goes to the MAIN window's renderer
    const signalDisplays = () =>
      a.app.evaluate(({ BrowserWindow, screen }, far) => {
        const main = BrowserWindow.getAllWindows().find((x) =>
          x.webContents.getURL().includes('index.html')
        );
        const areas = [...screen.getAllDisplays().map((d) => d.workArea), far];
        main?.webContents.send('app:displaysChanged', areas);
      }, FAR);

    // 4. the lost display "returns"
    await signalDisplays();
    await expect(w.getByText('A saved monitor is back — restore its pop-out layout?')).toBeVisible();

    // 5a. "Not now" changes nothing — the popout stays where it is
    await w.getByRole('button', { name: 'Not now' }).click();
    await expect(w.getByText('A saved monitor is back — restore its pop-out layout?')).toHaveCount(0);
    expect((await popoutX()).every((x) => x < 50_000)).toBe(true);

    // 5b. offer again and ACCEPT -> the popout window is moved toward its old
    // spot. The fake display can't exist at the OS level, so Windows clamps
    // the final position to the real virtual desktop — assert the move
    // happened (large x jump) and the stash was consumed; exact placement on
    // a REAL returned display is plain BrowserWindow.setBounds semantics.
    const beforeX = (await popoutX())[0];
    await signalDisplays();
    await w.getByRole('button', { name: 'Restore' }).click();
    await expect
      .poll(async () => (await popoutX())[0], { timeout: 15_000 })
      .toBeGreaterThan(beforeX + 1000);
    const ui = (await w.evaluate(() => window.switchboard.workspace.getUi())) as {
      rescuedPopouts?: unknown[];
    };
    expect(ui.rescuedPopouts).toEqual([]);
  });
});
