// Right-click edit menus (#526) — the two facts no unit test can reach.
//
// `src/main/context-menu.test.ts` pins the DECISION: given a surface, what the
// menu offers. It cannot pin the two things this feature actually rests on:
//
//   1. that Chromium reports the composer as an EDITABLE surface with a usable
//      `editFlags` — the input the decision is a function of. Everything in the
//      unit test is hand-written params; this is the real ones, off a real
//      right-click, fed through the real builder.
//   2. that the handler is installed on POPOUT windows too. `context-menu` is
//      per-webContents (the #90 lesson, second door), so a popped-out composer
//      would silently be the one text box in the app you cannot paste into with
//      the mouse — and nothing else in the suite would notice.
//
// WHAT IT DELIBERATELY DOES NOT DO: open a native menu and click Paste.
// Playwright drives the renderer over CDP and cannot see, let alone click, an
// OS menu — and `role: 'paste'` reads the REAL system clipboard, which
// `composer-paste.spec.ts` states the rule about: this machine's clipboard
// belongs to whoever is using it. The paste ITEM is pinned as a role in the unit
// test (a role, not a click handler, is what makes it the same trusted paste
// Ctrl+V performs, through the same `onPaste` the chips hang off), and the chip
// end of that pipeline is `composer-paste.spec.ts`'s whole subject. The hand
// test in the PR closes the loop.
import { test, expect } from '@playwright/test';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  skipPopoutOnLinux,
  tempProjectFolder,
} from './fixtures/app';
import { buildContextMenuTemplate, ContextMenuSurface } from '../src/main/context-menu';
import { DEFAULT_CONTEXT_MENU_LABELS } from '../src/shared/context-menu';

test.describe.configure({ mode: 'serial' });

/** roles in order, separators as '-' */
function shape(params: ContextMenuSurface): string[] {
  return buildContextMenuTemplate(params, DEFAULT_CONTEXT_MENU_LABELS).map((i) =>
    i.type === 'separator' ? '-' : String(i.role)
  );
}

test.describe('right-click edit menus (#526)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    for (const p of a?.app.windows().filter((w) => w.url().includes('popout.html')) ?? []) {
      await p.evaluate(() => window.close()).catch(() => undefined);
    }
    await a?.cleanup();
  });

  test('every window gets its own handler — popouts included', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    await expect(a.window.getByText(path.basename(folder)).first()).toBeVisible({
      timeout: 25_000,
    });

    const listeners = () =>
      a.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => ({
          popout: w.webContents.getURL().includes('popout.html'),
          handlers: w.webContents.listenerCount('context-menu'),
        }))
      );

    expect(await listeners()).toEqual([{ popout: false, handlers: 1 }]);

    await a.window.getByTitle('Pop out into its own window').click();
    await expect.poll(() => a.app.windows().length, { timeout: 15_000 }).toBe(2);

    // The popout is created by Chromium from `window.open`, not by us, and it
    // carries no preload — so it is wired at `did-create-window` or not at all.
    await expect
      .poll(async () => (await listeners()).find((w) => w.popout)?.handlers, { timeout: 15_000 })
      .toBe(1);
  });

  test('the composer is an editable surface, and a feed selection is not', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // OUR handler is taken off first, and a recorder put in its place. Two
    // reasons, and the second is the load-bearing one: a real right-click would
    // otherwise pop a NATIVE menu that Playwright cannot dismiss, leaving it
    // open over the window for the rest of the test. This is the last thing
    // this spec does with the window, and the app is torn down after it.
    await a.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.removeAllListeners('context-menu');
      (globalThis as unknown as { __sbCtx: unknown }).__sbCtx = null;
      win.webContents.on('context-menu', (_e, params) => {
        (globalThis as unknown as { __sbCtx: unknown }).__sbCtx = {
          isEditable: params.isEditable,
          selectionText: params.selectionText,
          x: params.x,
          y: params.y,
          editFlags: {
            canCut: params.editFlags.canCut,
            canCopy: params.editFlags.canCopy,
            canPaste: params.editFlags.canPaste,
            canSelectAll: params.editFlags.canSelectAll,
          },
        };
      });
    });

    const lastParams = (): Promise<ContextMenuSurface | null> =>
      a.app.evaluate(
        () => (globalThis as unknown as { __sbCtx: ContextMenuSurface | null }).__sbCtx
      );

    // --- the composer -----------------------------------------------------
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('some words to cut');
    await box.click({ button: 'right' });

    await expect.poll(lastParams, { timeout: 15_000 }).not.toBeNull();
    const editable = (await lastParams())!;
    expect(editable.isEditable).toBe(true);
    // The whole edit menu, built by the SAME function main calls, from params
    // Chromium produced.
    expect(shape(editable)).toEqual(['cut', 'copy', 'paste', '-', 'selectAll']);
    // Chromium's own view of what is possible in a non-empty box: Select All is
    // live, and the enablement is Chromium's throughout, never ours.
    expect(editable.editFlags.canSelectAll).toBe(true);
    // ...and the click carries real coordinates, which is what lets the menu be
    // anchored where the user clicked rather than at the mouse.
    expect(editable.x).toBeGreaterThan(0);
    expect(editable.y).toBeGreaterThan(0);

    // --- a selection in the feed, which is NOT editable --------------------
    await box.press('Enter');
    const block = w.locator('[data-feed-block]').first();
    await expect(block).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(() => {
      (globalThis as unknown as { __sbCtx: unknown }).__sbCtx = null;
    });
    // `ownerDocument`, not `document`: the same rule the grid's key handling
    // learned — in a popout these are different windows.
    await block.evaluate((el) => {
      const sel = el.ownerDocument.defaultView!.getSelection()!;
      sel.removeAllRanges();
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      sel.addRange(range);
    });
    await block.click({ button: 'right' });

    await expect.poll(lastParams, { timeout: 15_000 }).not.toBeNull();
    const selected = (await lastParams())!;
    expect(selected.isEditable).toBe(false);
    expect(selected.selectionText.trim().length).toBeGreaterThan(0);
    // Copy alone: cut and paste are meaningless on text you cannot edit.
    expect(shape(selected)).toEqual(['copy']);

    // --- the rail's RENAME box, the one text box that had to be let through --
    // Its row calls `preventDefault()` on `contextmenu` to raise the session
    // menu, and Chromium stops emitting the browser-process event the moment a
    // page does that. Without the row's early return for editable targets, the
    // field whose entire purpose is editing text would be the only one in the
    // app with no edit menu — and nothing else would notice.
    await a.app.evaluate(() => {
      (globalThis as unknown as { __sbCtx: unknown }).__sbCtx = null;
    });
    const row = w.locator('nav [draggable="true"]', { hasText: path.basename(folder) }).first();
    await row.dblclick();
    const rename = w.locator('nav input').first();
    await expect(rename).toBeVisible({ timeout: 10_000 });
    await rename.click({ button: 'right' });

    await expect.poll(lastParams, { timeout: 15_000 }).not.toBeNull();
    expect((await lastParams())!.isEditable).toBe(true);
  });
});
