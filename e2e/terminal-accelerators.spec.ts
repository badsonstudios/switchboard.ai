// #90: the palette and the attention jump, claimed in the BROWSER process
// (Electron's `before-input-event`) rather than in the renderer.
//
// WHAT THIS FILE USED TO PROVE, AND WHY MOST OF IT IS GONE (#873).
//
// The mechanism exists so that two chords still reach switchboard from INSIDE
// an xterm surface, where every renderer accelerator is deaf by design because
// the terminal is the real CLI and owns every key it can see. Four tests here
// staged exactly that: focus the xterm, send a chord through
// `webContents.sendInputEvent`, and assert both that the two claimed chords
// work and — far more importantly — that NOTHING else is taken from the CLI.
//
// **There is no longer an xterm surface anywhere in the app.** `TerminalPane`
// was mounted only by the `panel-terminal` contribution, and that went with the
// Terminal tab. PTY sessions still spawn under `SWITCHBOARD_TRANSPORT=pty` and
// the transport still works — E18-16 requires it — but nothing renders one, so
// focus can never be inside a terminal and the scenario cannot be staged.
//
// Deleted with that surface:
//
//  - "Ctrl+Shift+P opens the palette from inside a terminal — and the PTY
//    survives"
//  - "Ctrl+Space jumps to the session that needs you, from inside a terminal"
//  - "a popped-out session terminal reaches the palette too"
//  - **"NOTHING else is intercepted — every other key still reaches the CLI"**,
//    which was the load-bearing one: it watched the accelerator channel while
//    eight chords Claude Code itself binds (Ctrl+R, Ctrl+T, Ctrl+O, …) were
//    pressed, and failed if any of them was ever stolen. Nothing replaces it.
//    The browser-process claim is still live code, so if a terminal surface
//    ever returns, restore this test with it — the guarantee it protected is a
//    P7 one, and it is currently unguarded.
//
// The two chords themselves are still covered as ordinary renderer accelerators
// on the default transport: Ctrl+Shift+P by `palette.spec.ts`, Ctrl+Space by
// `attention.spec.ts` and `stream-attention.spec.ts`.
//
// What remains below is the SCOPE rule, which never needed a terminal: the
// browser-process claim is window-wide, so something has to stop it yanking you
// away mid-sentence while you are typing.
import { test, expect, ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import { hookPoster, launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const palette = (w: Page) => w.getByRole('dialog', { name: 'Command palette' });
const activeTab = (w: Page) => w.locator('.dv-active-tab');

/**
 * Press a chord the way a REAL key press reaches the browser process.
 *
 * Playwright's own `keyboard.press` injects over CDP, and CDP-injected keys do
 * not go through `before-input-event` at all — probed on Windows 2026-08-02:
 * `webContents.on('input-event')` sees them, `before-input-event` never fires.
 * It is the same blind spot that makes CDP keys bypass native menu accelerators
 * (see the notes in commands.spec.ts). `webContents.sendInputEvent` is
 * Electron's own injection and DOES reach it, so it is the only way to exercise
 * this mechanism end to end.
 */
async function chord(
  app: ElectronApplication,
  keyCode: string,
  modifiers: string[],
  target: 'main' | 'popout' = 'main'
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, arg) => {
      const isPopout = (w: Electron.BrowserWindow): boolean =>
        w.webContents.getURL().includes('popout.html');
      const win = BrowserWindow.getAllWindows().find((w) =>
        arg.target === 'popout' ? isPopout(w) : !isPopout(w)
      );
      if (!win) throw new Error(`no ${arg.target} window to send to`);
      // `as never`: modifiers is a string[] here (it crosses the evaluate
      // boundary as JSON) where Electron's type wants a union array — the
      // values are checked by the call itself, which throws on a bad one
      const send = (type: 'keyDown' | 'keyUp'): void =>
        win.webContents.sendInputEvent({
          type,
          keyCode: arg.keyCode,
          modifiers: arg.modifiers,
        } as never);
      send('keyDown');
      send('keyUp');
    },
    { keyCode, modifiers, target }
  );
}

test.describe('browser-process accelerators keep their scope (#90)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('Ctrl+Space still stands down while you are typing in the composer', async () => {
    // The claim is window-wide (before-input-event is per webContents), so the
    // browser process takes this chord even from the composer — the SCOPE rule
    // then has to be what stops it jumping you away mid-sentence. The manual
    // promises exactly that.
    const folderA = tempProjectFolder();
    const folderB = tempProjectFolder();
    a = await launchApp({ seedFolder: folderA });
    const w = a.window;
    const first = path.basename(folderA);
    const second = path.basename(folderB);
    await expect(w.getByText(first).first()).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, folderB);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(second).first()).toBeVisible({ timeout: 25_000 });

    const post = await hookPoster(a, 2);
    await post(second, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    // read the count off the events TAB rather than the drawer's rows: the
    // drawer is collapsed by default (P2-E14-01), and opening an overlay across
    // the workspace would be staging the wrong scene
    await expect(w.getByTestId('events-tab')).toHaveAttribute('data-count', '1', {
      timeout: 15_000,
    });

    await w.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+1`);
    await expect(activeTab(w)).toContainText(first);
    await w.getByPlaceholder(/Prompt this session/).click();
    await chord(a.app, ' ', ['control']);
    await w.waitForTimeout(500);
    await expect(activeTab(w)).toContainText(first); // never jumped
    expect(await w.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');

    // ...and the palette, which IS allowed while typing, still opens
    await chord(a.app, 'P', ['control', 'shift']);
    await expect(palette(w)).toBeVisible({ timeout: 10_000 });
  });
});
