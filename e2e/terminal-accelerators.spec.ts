// #90: the palette and the attention jump, reachable from INSIDE a session
// terminal — where every renderer accelerator is deaf by design, because the
// xterm surface is the real CLI and owns every key it can see.
//
// The claim lives above the renderer (Electron's before-input-event), so the
// mechanism these tests drive is a browser-process one; what they assert is the
// user-visible half of it, plus the half that matters more: that NOTHING else
// is taken from the CLI.
//
// TRANSPORT SCOPE (P2-E18-18, #404): `[pty]`, and legitimately so — the whole
// item is about focus being INSIDE an xterm surface, which a Direct session
// does not have (its Terminal tab renders the P2-E18-08b notice instead,
// `extensibility/panels.tsx`). There is no Direct counterpart to write: with no
// surface to steal a key back FROM, the two accelerators here are just ordinary
// renderer accelerators on the default transport, and they are covered as such
// — Ctrl+Shift+P by `palette.spec.ts`, Ctrl+Space by `attention.spec.ts` and
// `stream-attention.spec.ts` ("Ctrl+Space jumps to the Direct session that is
// waiting"). See `launchApp` in `fixtures/app.ts` for the tag.
import { test, expect, ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import {
  hookPoster,
  launchApp,
  LaunchedApp,
  showTerminal,
  tempProjectFolder,
} from './fixtures/app';

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

/** put focus INSIDE the xterm surface — the state the whole item is about */
async function focusTerminal(w: Page): Promise<void> {
  await showTerminal(w);
  await expect(w.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
  await w.locator('.xterm-screen').first().click();
  await expect
    .poll(() => w.evaluate(() => !!document.activeElement?.closest('.xterm')), { timeout: 10_000 })
    .toBe(true);
}

test.describe('[pty] terminal accelerators (#90)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('Ctrl+Shift+P opens the palette from inside a terminal — and the PTY survives', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await focusTerminal(w);

    await chord(a.app, 'P', ['control', 'shift']);
    await expect(palette(w)).toBeVisible({ timeout: 10_000 });
    // ...with the caret IN it. Opening a palette you then have to click would
    // be no better than the title-bar chip this replaces — and the terminal is
    // the one surface that would otherwise keep the keystrokes.
    await expect(w.getByPlaceholder('Type a command or a session name…')).toBeFocused();

    // and the terminal underneath is untouched: still a live CLI
    await w.keyboard.press('Escape');
    await expect(palette(w)).toHaveCount(0);
    await w.locator('.xterm-screen').first().click();
    await w.keyboard.type('echo SB90_ALIVE');
    await w.keyboard.press('Enter');
    await expect(w.getByText(/SB90_ALIVE/).first()).toBeVisible({ timeout: 15_000 });
  });

  test('Ctrl+Space jumps to the session that needs you, from inside a terminal', async () => {
    const folders = [tempProjectFolder(), tempProjectFolder(), tempProjectFolder()];
    a = await launchApp({ seedFolder: folders[0] });
    const w = a.window;
    const [first, second, third] = folders.map((f) => path.basename(f));
    await expect(w.getByText(first).first()).toBeVisible({ timeout: 25_000 });
    for (const folder of folders.slice(1)) {
      await a.app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
      }, folder);
      await w.getByRole('button', { name: '+ session' }).click();
      await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    }

    // TWO sessions wait, deliberately: one press must advance exactly one step.
    // With a single waiting session a double dispatch would be invisible — the
    // second advance finds an empty queue and does nothing — and "the page
    // never also sees the keystroke" is the load-bearing assumption of the
    // whole design, so it needs something that would actually break.
    const post = await hookPoster(a, 3);
    await post(second, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    await post(third, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    await expect(w.locator('aside [data-event-kind]')).toHaveCount(2, { timeout: 15_000 });

    // focus the session that is NOT waiting, and dig into its terminal —
    // exactly where the hotkey used to be dead
    await w.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+1`);
    await expect(activeTab(w)).toContainText(first);
    await focusTerminal(w);

    await chord(a.app, ' ', ['control']);
    await expect(activeTab(w)).toContainText(second, { timeout: 10_000 });
    // and it is still on the FIRST of the two waiting sessions a moment later,
    // i.e. the press advanced once, not twice
    await w.waitForTimeout(500);
    await expect(activeTab(w)).toContainText(second);
    await expect(activeTab(w)).not.toContainText(third);
  });

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
    await expect(w.locator('aside [data-event-kind]')).toHaveCount(1, { timeout: 15_000 });

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

  test('NOTHING else is intercepted — every other key still reaches the CLI', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await focusTerminal(w);

    // watch the channel the claim delivers on: if a key is ever taken from the
    // CLI, it shows up here and nowhere else
    await w.evaluate(() => {
      const g = window as unknown as { __accelerators: string[] };
      g.__accelerators = [];
      window.switchboard.onAccelerator?.((p) => g.__accelerators.push(p.commandId));
    });
    const seen = (): Promise<string[]> =>
      w.evaluate(() => (window as unknown as { __accelerators: string[] }).__accelerators);

    // keys Claude Code itself binds, plus our own renderer-only accelerators
    await chord(a.app, 'r', ['control']); // history search
    await chord(a.app, 't', ['control']); // todos
    await chord(a.app, 'o', ['control']); // transcript
    await chord(a.app, 'B', ['control', 'shift']); // brief
    await chord(a.app, 'Escape', []);
    await chord(a.app, 'Up', []);
    await chord(a.app, '1', ['control']); // ours, but renderer-only
    await chord(a.app, ' ', []); // a bare space is a keystroke, not a chord
    expect(await seen()).toEqual([]);

    // ...and the two that ARE claimed still are, so the check above is real
    await chord(a.app, ' ', ['control']);
    await chord(a.app, 'P', ['control', 'shift']);
    await expect.poll(seen, { timeout: 10_000 }).toEqual(['attention.next', 'palette.open']);
  });

  test('a popped-out session terminal reaches the palette too', async () => {
    // dockview popouts open a real 2nd OS window — unreliable under headless
    // xvfb, covered on Windows + macOS (same rationale as palette.spec.ts)
    test.skip(
      process.platform === 'linux',
      'popout opens a 2nd OS window — unreliable under headless xvfb'
    );
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    await w.getByTitle('Pop out into its own window').click();
    await expect.poll(() => a.app.windows().length, { timeout: 15_000 }).toBe(2);
    const popout = a.app.windows().find((p) => p !== w)!;
    await popout.waitForLoadState('domcontentloaded');
    // the card's terminal moved with it — tearing a session off must not cost
    // it a capability (§5.8)
    await focusTerminal(popout);

    await chord(a.app, 'P', ['control', 'shift'], 'popout');
    await expect(palette(w)).toBeVisible({ timeout: 10_000 });
  });
});
