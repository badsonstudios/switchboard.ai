// P2-E8-06: display reconnect offer. CI can't hotplug a monitor, so the test
// drives the real rescue path (popout position edited off-display -> relaunch
// rescues it into the grid + stashes it), then replays the display-added
// signal with a synthetic work-area list that "contains" the lost monitor.
// Accepting re-pops the card; the offer itself is never automatic.
//
// DISPLAY SCOPE (#479): runs on whatever monitor `SWITCHBOARD_E2E_MONITOR`
// picked, unmodified. The one assertion here that could plausibly have cared is
// 5b's — accepting the offer asks for x=90,100, the OS refuses it, and the test
// asserts the window travelled >1000px from where it was. If the OS clamped
// that to the edge of the VIRTUAL DESKTOP, then starting further right would
// eat the margin. MEASURED on this 3-monitor machine instead of assumed:
//
//   monitor  main window at    beforeX   afterX   margin over the +1000 bar
//   unset    0,0 (primary)         640   21,845   20,205
//   2        2560,0              3,840   21,845   17,005
//   3        -2560,0            -2,560   21,845   23,405
//
// The landing spot does not move: Windows clamps a window position to a fixed
// coordinate ceiling (~21,845, the 16-bit-ish limit), NOT to the desktop's
// right edge. So the margin is five figures in every arrangement and the only
// display-dependent term is where the window started. Nothing to exempt.
import { test, expect } from '@playwright/test';
import {
  launchApp,
  LaunchedApp,
  openEventsDrawer,
  readWorkspaceFile,
  tempProjectFolder,
  writeWorkspaceFile,
} from './fixtures/app';

// popout windows are flaky under xvfb — covered on Windows (+macOS locally),
// same skip as session.spec's popout tests
const skipOnLinux = () =>
  test.skip(process.platform === 'linux', 'popout window-open is unreliable under xvfb');

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
    const ws = readWorkspaceFile(first.home);
    // NOT `persistedLayout(ws)`: "no popout was persisted" is the failure this
    // test guards, and the labelled assertion below is its designated reporter.
    // A throwing reader would pre-empt it with a fixture-level error instead.
    const pg = ws.layout?.popoutGroups?.[0];
    expect(pg, 'a popout group was persisted').toBeTruthy();
    pg!.position = { left: FAR.x + 100, top: FAR.y + 60, width: 800, height: 600 };
    writeWorkspaceFile(first.home, ws);

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
    // No offer yet — a rescue alone must not nag. Read off the events TAB
    // rather than the offer's words: the drawer that holds it is collapsed by
    // default now (P2-E14-01), so "the text is not on screen" would be true
    // whether or not the app had decided to nag. The tab's notice marker is
    // the app's own answer, and it is on screen either way.
    await expect(w.getByTestId('events-tab')).not.toHaveAttribute('data-notice', 'true');

    // the synthetic display-added payload goes to the MAIN window's renderer
    const signalDisplays = () =>
      a.app.evaluate(({ BrowserWindow, screen }, far) => {
        const main = BrowserWindow.getAllWindows().find((x) =>
          x.webContents.getURL().includes('index.html')
        );
        const areas = [...screen.getAllDisplays().map((d) => d.workArea), far];
        main?.webContents.send('app:displaysChanged', areas);
      }, FAR);

    // 4. the lost display "returns". The offer reaches a SHUT drawer, so the
    // marker on the tab is what tells you to go and look — this is the third
    // of the notice slot's tenants proving that route (update.spec.ts and
    // service-health.spec.ts prove the other two), which is the #425
    // coordination note's requirement that they rehomed TOGETHER.
    await signalDisplays();
    await expect(w.getByTestId('events-tab')).toHaveAttribute('data-notice', 'true', {
      timeout: 15_000,
    });
    await openEventsDrawer(w);
    await expect(w.getByText('A saved monitor is back — restore its pop-out layout?')).toBeVisible();

    // 5a. "Not now" changes nothing — the popout stays where it is
    await w.getByRole('button', { name: 'Not now' }).click();
    await expect(w.getByText('A saved monitor is back — restore its pop-out layout?')).toHaveCount(0);
    expect((await popoutX()).every((x) => x < 50_000)).toBe(true);

    // 5b. offer again and ACCEPT -> the popout window is moved toward its old
    // spot. The fake display can't exist at the OS level, so Windows clamps
    // the final position to a fixed coordinate ceiling (~21,845 — measured for
    // #479; this used to say "the real virtual desktop", which the numbers in
    // the header disprove) — assert the move happened (large x jump) and the
    // stash was consumed; exact placement on a REAL returned display is plain
    // BrowserWindow.setBounds semantics.
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
