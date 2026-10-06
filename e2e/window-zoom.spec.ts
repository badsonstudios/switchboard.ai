// #1114 — Ctrl+= zooms, from wherever the keyboard is, and the size survives a
// restart.
//
// The owner: *"Pressing Ctrl+ does not work. It doesn't increase the size of all
// the text."* The View menu's stock `zoomIn` role answers Ctrl+Plus, which is a
// SHIFTED key; the unshifted Ctrl+= that every browser also answers landed on
// nothing.
//
// REAL INPUT EVENTS, via `webContents.sendInputEvent`: the claim lives in
// `before-input-event`, and Playwright's own keyboard goes in over CDP, which
// never reaches it (probed for #90 — see `terminal-accelerators.spec.ts`). A
// spec that used `keyboard.press` here would pass or fail for reasons that have
// nothing to do with the app.
import { test, expect, ElectronApplication } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

async function chord(app: ElectronApplication, keyCode: string, modifiers: string[]): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, arg) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('no window to send to');
      // `as never`: modifiers crosses the evaluate boundary as a string[] where
      // Electron's type wants a union array; the call itself rejects a bad one
      const send = (type: 'keyDown' | 'keyUp'): void =>
        win.webContents.sendInputEvent({ type, keyCode: arg.keyCode, modifiers: arg.modifiers } as never);
      send('keyDown');
      send('keyUp');
    },
    { keyCode, modifiers }
  );
}

const zoom = (app: ElectronApplication): Promise<number> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel());

test.describe('Ctrl+= zooms the window (#1114)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('the unshifted chord works, with the keyboard in the prompt box', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    expect(await zoom(a.app)).toBe(0);

    // THE FOCUS SINK the issue asked about: a text box that would happily take
    // the keystroke itself if it were ever offered it.
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await expect(box).toBeFocused();

    // the owner's keystroke: Ctrl and the = key, no Shift
    await chord(a.app, '=', ['control']);
    await expect.poll(() => zoom(a.app)).toBe(0.5);
    // …and the form that always worked still does
    await chord(a.app, 'Plus', ['control', 'shift']);
    await expect.poll(() => zoom(a.app)).toBe(1);
    await chord(a.app, '-', ['control']);
    await expect.poll(() => zoom(a.app)).toBe(0.5);
    await chord(a.app, '0', ['control']);
    await expect.poll(() => zoom(a.app)).toBe(0);

    // none of it was typed into the box the keyboard was in
    await expect(box).toHaveValue('');
    // and the bare key is not a chord (that it still TYPES is the unit test's
    // claim — a synthetic keyDown carries no character to type)
    await chord(a.app, '=', []);
    expect(await zoom(a.app)).toBe(0);
  });

  test('the size you chose is still there after a restart', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    await expect(a.window.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await chord(a.app, '=', ['control']);
    await chord(a.app, '=', ['control']);
    await expect.poll(() => zoom(a.app)).toBe(1);

    const home = a.home;
    await a.close(); // keeps the home, so the profile survives
    a = await launchApp({ home });
    await expect(a.window.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    // Chromium keeps the level per host in the profile; nothing of ours restores it
    await expect.poll(() => zoom(a.app), { timeout: 10_000 }).toBe(1);
  });
});
