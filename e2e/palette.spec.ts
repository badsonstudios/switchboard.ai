// P2-E9-02: the command palette. The §5.8 invariant under test — hiding chrome
// never removes capability: everything the app can do is reachable here, with
// its shortcut beside it, and a whole session lifecycle can be driven from the
// keyboard alone.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, showTerminal, tempProjectFolder } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const palette = (w: Page) => w.getByRole('dialog', { name: 'Command palette' });
const filter = (w: Page) => w.getByPlaceholder('Type a command or a session name…');

test.describe('command palette (E9-02)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('opens on Ctrl+Shift+P, filters, shows bindings, closes on Esc', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    await w.keyboard.press(`${MOD}+Shift+P`);
    await expect(palette(w)).toBeVisible();
    // every command is listed, each with its accelerator alongside
    await expect(palette(w).getByText('New session…')).toBeVisible();
    await expect(palette(w).getByText('Ctrl+N')).toBeVisible();
    await expect(palette(w).getByText('Toggle the sessions rail')).toBeVisible();

    // typing filters down to what you meant
    await filter(w).fill('rail');
    await expect(palette(w).getByText('Toggle the sessions rail')).toBeVisible();
    await expect(palette(w).getByText('New session…')).toHaveCount(0);

    // a query matching nothing says so rather than showing a blank box
    await filter(w).fill('zzzzz');
    await expect(palette(w).getByText('No matching commands')).toBeVisible();

    await w.keyboard.press('Escape');
    await expect(palette(w)).toHaveCount(0);
  });

  test('hovering the rows never crashes the renderer (regression, Dan 2026-07-25)', async () => {
    // The mouse path was the one the keyboard tests never took. Hovering moved
    // the selection, which re-ran the scroll-into-view effect — and that effect
    // used an expression-bodied arrow, so Chromium's scrollIntoView PROMISE
    // became React's cleanup: "destroy_ is not a function" tore the whole tree
    // down to a blank window. eslint now bans the pattern; this proves the app.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const crashes: string[] = [];
    w.on('pageerror', (e) => crashes.push(String(e)));
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    await w.keyboard.press(`${MOD}+Shift+P`);
    await expect(palette(w)).toBeVisible();
    const rows = w.getByRole('option');
    const count = await rows.count();
    expect(count).toBeGreaterThan(3);
    for (let i = 0; i < count; i++) {
      const box = await rows.nth(i).boundingBox();
      if (!box) continue; // scrolled out of view — the ones on screen suffice
      await w.mouse.move(box.x + 30, box.y + box.height / 2);
      await w.mouse.move(box.x + 60, box.y + box.height / 2);
    }
    expect(crashes).toEqual([]);
    await expect(palette(w)).toBeVisible(); // ...and the app is still standing
    await expect(w.getByText('switchboard').first()).toBeVisible();
  });

  test('Enter runs the selected command', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await expect(w.locator('nav')).toBeVisible();

    await w.keyboard.press(`${MOD}+Shift+P`);
    await filter(w).fill('rail');
    await w.keyboard.press('Enter');
    // the palette closes and the command actually ran
    await expect(palette(w)).toHaveCount(0);
    await expect(w.locator('nav')).toHaveCount(0);
  });

  test('a whole session lifecycle from the keyboard alone (done-when)', async () => {
    const folderA = tempProjectFolder();
    const folderB = tempProjectFolder();
    a = await launchApp({ seedFolder: folderA });
    const w = a.window;
    await expect(w.getByText(path.basename(folderA)).first()).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, folderB);

    // create a session — palette only, no mouse
    await w.keyboard.press(`${MOD}+Shift+P`);
    await filter(w).fill('new session');
    await w.keyboard.press('Enter');
    await expect(w.getByText(path.basename(folderB)).first()).toBeVisible({ timeout: 25_000 });
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(2);

    // move to the first session BY NAME (dynamic "Go to …" row)
    await w.keyboard.press(`${MOD}+Shift+P`);
    await filter(w).fill(path.basename(folderA));
    await w.keyboard.press('Enter');
    await expect(w.locator('.dv-active-tab')).toContainText(path.basename(folderA));

    // ...and close it, confirm included
    w.once('dialog', (d) => void d.accept());
    await w.keyboard.press(`${MOD}+Shift+P`);
    await filter(w).fill('close session');
    await w.keyboard.press('Enter');
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 15_000 });
    await expect(w.locator('nav').getByText(path.basename(folderA))).toHaveCount(0);
  });

  test('a popped-out session hears shortcuts too (E9-01 gap closed)', async () => {
    // dockview popouts open a real 2nd OS window — unreliable under headless
    // xvfb, covered on Windows + macOS (same rationale as session.spec.ts)
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

    // pressing the palette key IN the popped-out window opens the palette in
    // the main window (that's where every surface it drives lives)
    await popout.locator('body').click();
    await popout.keyboard.press(`${MOD}+Shift+P`);
    await expect(palette(w)).toBeVisible({ timeout: 10_000 });
    await w.keyboard.press('Escape');
    await expect(palette(w)).toHaveCount(0);
  });

  test('unavailable commands show greyed with a reason, and Enter skips past them', async () => {
    a = await launchApp(); // no sessions at all
    const w = a.window;
    await expect(w.locator('nav').getByText('No sessions yet')).toBeVisible({ timeout: 25_000 });

    await w.keyboard.press(`${MOD}+Shift+P`);
    await filter(w).fill('close session');
    // listed (the palette is the map of what EXISTS) with the reason shown
    await expect(palette(w).getByText('Close session')).toBeVisible();
    await expect(palette(w).getByText('No session is focused')).toBeVisible();
    // Enter must not run it — the workspace is unchanged and no dialog appears
    await w.keyboard.press('Enter');
    await expect(w.locator('nav').getByText('No sessions yet')).toBeVisible();

    // with an enabled row also matching, Enter lands on THAT, not the disabled
    // one that happens to rank first
    await filter(w).fill('session');
    await w.keyboard.press('Enter');
    await expect(palette(w)).toHaveCount(0); // something ran; nothing was inert
  });

  test('after "Go to", typing lands in the session you jumped to', async () => {
    const folderA = tempProjectFolder();
    const folderB = tempProjectFolder();
    a = await launchApp({ seedFolder: folderA });
    const w = a.window;
    await expect(w.getByText(path.basename(folderA)).first()).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, folderB);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(path.basename(folderB)).first()).toBeVisible({ timeout: 25_000 });

    // start typing in B's composer, then jump to A from the palette
    const composer = w.getByPlaceholder(/Prompt this session/);
    await composer.click();
    await w.keyboard.press(`${MOD}+Shift+P`);
    await filter(w).fill(path.basename(folderA));
    await w.keyboard.press('Enter');
    await expect(w.locator('.dv-active-tab')).toContainText(path.basename(folderA));

    // the palette must NOT have handed focus back to B's composer — the next
    // keystrokes belong to the session the user just navigated to
    await w.keyboard.type('hello-a');
    const strayText = await w.evaluate(() =>
      [...document.querySelectorAll('textarea')].map((el) => (el as HTMLTextAreaElement).value)
    );
    expect(strayText.join('|')).not.toContain('hello-a');
  });

  test('opens while the composer has focus, never from inside the terminal', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // the composer is a text input — but the palette is the one binding allowed
    // to fire there, because it's the route to everything else
    const composer = w.getByPlaceholder(/Prompt this session/);
    await composer.click();
    await w.keyboard.press(`${MOD}+Shift+P`);
    await expect(palette(w)).toBeVisible();
    await w.keyboard.press('Escape');
    await expect(palette(w)).toHaveCount(0);
    // focus went back to the composer, not nowhere
    await expect(composer).toBeFocused();

    // the terminal is absolute: the CLI gets Ctrl+Shift+P, we do not
    await showTerminal(w);
    await w.locator('.xterm-screen').first().click();
    await w.keyboard.press(`${MOD}+Shift+P`);
    await expect(palette(w)).toHaveCount(0);
    // the title-bar chip is the way in from there
    await w.getByTitle(/Show every command/).click();
    await expect(palette(w)).toBeVisible();
  });
});
