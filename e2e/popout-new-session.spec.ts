// Issue #531 — a popped-out window can start a session of its own.
//
// Before this, every "new session" control lived in the MAIN window's chrome:
// pop a card out, work in it, and the only way to start a second session was to
// go find the window you had deliberately walked away from. A popout has none
// of our chrome — dockview adopts the group's DOM into an otherwise empty
// document — so the card header is the only surface there to put a ＋ on.
//
// What these tests pin, beyond "a card appeared":
//
//  1. WHICH WINDOW it appeared in. The card must be a tab beside the one it was
//     asked from, in that popout — not in the grid, which is where every other
//     new-session path lands (#434/#462, and still correct for those).
//  2. WHICH WINDOW the folder dialog was parented to. That is a main-process
//     decision and it is invisible from the DOM: the only place it can be
//     observed is inside the stub that stands in for the native dialog, which
//     is why `answerFolderDialog` records it rather than just answering.
//  3. That the card is ORDINARY otherwise — a rail row in the main window, and
//     it docks back into the grid like any other.
//
// Popouts are real second OS windows, so this whole file is Windows + macOS
// (`skipPopoutOnLinux`); `a.cleanup()` tree-kills, which is what takes the
// popout child down with the app.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { LaunchedApp, launchApp, skipPopoutOnLinux, tempProjectFolder } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** dockview's tab strip, the same locator the other layout specs count. */
const tabs = (w: Page): ReturnType<Page['locator']> => w.locator('.dv-tabs-container .dv-tab');

/** the main window's rail rows — one per session, popped out or not */
const railRows = (w: Page): ReturnType<Page['locator']> => w.locator('nav [draggable="true"]');

/** The popped-out window, once the OS actually has one. */
async function popoutWindow(a: LaunchedApp): Promise<Page> {
  await expect.poll(() => a.app.windows().length, { timeout: 15_000 }).toBe(2);
  const popout = a.app.windows().find((p) => p !== a.window)!;
  await popout.waitForLoadState('domcontentloaded');
  return popout;
}

/**
 * Answer the next folder dialog with `dir`, and REMEMBER which window it was
 * parented to.
 *
 * The parent is the main-process half of #531 and there is no other way to see
 * it: a modal that opens behind the window you clicked in — or drags the whole
 * app forward on top of it — is not a dialog, it is a jump scare, and from the
 * renderer both look identical. Stashed on `globalThis` in the main process so
 * it outlives this `evaluate` and can be read back after the click.
 */
async function answerFolderDialog(a: LaunchedApp, dir: string): Promise<void> {
  await a.app.evaluate(({ dialog }, folder) => {
    (globalThis as Record<string, unknown>).__pickedFrom = null;
    // `unknown` and not `BrowserWindow`: the real `showOpenDialog` is
    // OVERLOADED (with and without a parent window), and a narrower parameter
    // type is assignable to only one of the two.
    dialog.showOpenDialog = (parent: unknown) => {
      const url = (parent as { webContents?: { getURL(): string } } | undefined)?.webContents
        ?.getURL();
      (globalThis as Record<string, unknown>).__pickedFrom = url ?? 'no-parent-window';
      return Promise.resolve({ canceled: false, filePaths: [folder] });
    };
  }, dir);
}

/** the URL of the window the last folder dialog was parented to */
function dialogParent(a: LaunchedApp): Promise<string | null> {
  return a.app.evaluate(
    () => ((globalThis as Record<string, unknown>).__pickedFrom as string | null) ?? null
  );
}

/** a launched app with its one seeded card already torn off into a popout */
async function poppedOut(
  a: LaunchedApp,
  name: string
): Promise<{ w: Page; popout: Page }> {
  const w = a.window;
  await expect(w.getByText(name).first()).toBeVisible({ timeout: 25_000 });
  await w.getByTitle('Pop out into its own window').click();
  const popout = await popoutWindow(a);
  // the card's DOM is ADOPTED into the popout, so it LEAVES the main window —
  // which is exactly why there is nothing in the main window to click here
  await expect(tabs(popout)).toHaveCount(1, { timeout: 15_000 });
  return { w, popout };
}

test.describe('new session from a popped-out window (#531)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('the ＋ opens the new session as a tab in THAT window', async () => {
    skipPopoutOnLinux();
    const folderA = tempProjectFolder();
    const folderB = tempProjectFolder();
    const nameA = path.basename(folderA);
    const nameB = path.basename(folderB);
    a = await launchApp({ seedFolder: folderA });
    const { w, popout } = await poppedOut(a, nameA);

    // the ＋ exists ONLY out here: the main window has `+ session` in its own
    // chrome, and a second one per card header there would be clutter
    await expect(w.getByTestId('card-new-session')).toHaveCount(0);

    await answerFolderDialog(a, folderB);
    await popout.getByTestId('card-new-session').click();

    // ── the card landed HERE, beside the one it was asked from ──────────────
    await expect(tabs(popout)).toHaveCount(2, { timeout: 25_000 });
    await expect(tabs(popout).filter({ hasText: nameB })).toHaveCount(1);
    // ...and NOT in the grid, which is where every other new-session path goes
    await expect(tabs(w).filter({ hasText: nameB })).toHaveCount(0);
    // the new tab is the active one — you asked for it, you get to see it
    await expect(popout.locator('.dv-tab.dv-active-tab')).toContainText(nameB);

    // ── the dialog was parented to the popout, not the main window ──────────
    expect(await dialogParent(a)).toContain('popout.html');

    // ── and the card is ORDINARY: the main window's rail lists them both ────
    await expect(railRows(w)).toHaveCount(2, { timeout: 15_000 });
    await expect(railRows(w).filter({ hasText: nameB })).toHaveCount(1);
  });

  test('Mod+N in a popped-out window lands there too', async () => {
    skipPopoutOnLinux();
    const folderA = tempProjectFolder();
    const folderB = tempProjectFolder();
    const nameA = path.basename(folderA);
    const nameB = path.basename(folderB);
    a = await launchApp({ seedFolder: folderA });
    const { w, popout } = await poppedOut(a, nameA);

    // The keyboard route has no card in hand, so the target is inferred from
    // which window the OS says has focus — the popout, because that is where
    // the keystroke was typed. Focus it explicitly: a test runner's window
    // manager is under no obligation to have left it focused after the click.
    await popout.bringToFront();
    await answerFolderDialog(a, folderB);
    await popout.keyboard.press(`${MOD}+N`);

    await expect(tabs(popout)).toHaveCount(2, { timeout: 25_000 });
    await expect(tabs(popout).filter({ hasText: nameB })).toHaveCount(1);
    await expect(tabs(w).filter({ hasText: nameB })).toHaveCount(0);
    expect(await dialogParent(a)).toContain('popout.html');
  });

  test('a session created in a popout docks back into the grid like any other', async () => {
    skipPopoutOnLinux();
    const folderA = tempProjectFolder();
    const folderB = tempProjectFolder();
    const nameA = path.basename(folderA);
    const nameB = path.basename(folderB);
    a = await launchApp({ seedFolder: folderA });
    const { w, popout } = await poppedOut(a, nameA);

    await answerFolderDialog(a, folderB);
    await popout.getByTestId('card-new-session').click();
    await expect(tabs(popout)).toHaveCount(2, { timeout: 25_000 });
    await expect(popout.locator('.dv-tab.dv-active-tab')).toContainText(nameB);

    // Dock the NEW card back in. The toggle is per-card, so the one it was
    // created beside stays out here — which is the sharper assertion anyway:
    // the new card is not welded to the window it was born in.
    await popout.locator('[title="Pop back into the main window"]:visible').click();

    await expect(tabs(w).filter({ hasText: nameB })).toHaveCount(1, { timeout: 25_000 });
    await expect(tabs(popout)).toHaveCount(1, { timeout: 15_000 });
    await expect(tabs(popout).filter({ hasText: nameA })).toHaveCount(1);
    // the window it came from is still open, and the rail never changed count:
    // docking back MOVES a card, it does not create or destroy one
    expect(a.app.windows().length).toBe(2);
    await expect(railRows(w)).toHaveCount(2);
  });
});
