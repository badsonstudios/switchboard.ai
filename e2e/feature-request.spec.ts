// Help ▸ Feature request… (#1008) — the claims only a real window can make.
//
// TWO OF THEM, and the unit tests can make neither:
//
//   * the Help menu item is really built and its click really reaches the
//     renderer. The item lives in the BROWSER process and fires a command id
//     down the accelerator channel; `app-menu.test.ts` proves the template's
//     shape and cannot prove anything is listening at the far end. This is
//     `file-menu.spec.ts`'s argument for Open File…, and the same one.
//   * the Send button's fill RESOLVES. jsdom has no cascade: the unit test pins
//     which token the button asks for, not whether that token exists where the
//     dialog renders. That distinction is the whole of #896 — `--accent` is
//     defined only inside a session card, so at the root the fill fell away and
//     left a transparent button the owner read as disabled. This dialog shares
//     `ComposeDialog` with the report one, so the same trap is one prop away.
//
// Playwright cannot click a native menu — it injects keys over CDP, which
// bypasses accelerators entirely — so the item's `click` is invoked through the
// Electron API, which is the same function the OS would call.
//
// IT NEVER PRESSES SEND. Both channels end in someone else's application: a
// mail client this suite has no business opening, or a browser pointed at a
// real issue tracker. What Send composes is asserted in `shared/feedback.test.ts`
// against the string, which is the only honest place to assert it.
import { test, expect } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

/** Fire Help › Feature Request…, the way the OS would. */
const clickFeatureRequest = (a: LaunchedApp): Promise<boolean> =>
  a.app.evaluate(({ Menu }) => {
    const help = Menu.getApplicationMenu()?.items.find((i) => i.label === 'Help');
    const item = help?.submenu?.items.find((i) => i.label.startsWith('Feature Request'));
    if (!item) return false;
    // `MenuItem.click` is typed as a bare `Function` in electron.d.ts, so it is
    // called through a narrowed local rather than with an eslint suppression.
    const fire = item.click as unknown as () => void;
    fire();
    return true;
  });

test.describe('Feature request (#1008)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('the Help menu opens it, the text survives, and Send is a real button', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // THE MENU, not the palette — the palette route is covered by the command
    // registry's own tests, and this is the half that crosses processes.
    expect(await clickFeatureRequest(a)).toBe(true);
    const dialog = w.locator('[data-feature-dialog]');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Send is dead until there is something to send, and says why.
    const send = w.locator('[data-feature-submit]');
    await expect(send).toBeDisabled();

    // Typing survives — no focus loss, no field that clears itself.
    const details = w.locator('[data-feature-field="details"]');
    await details.fill('let me pin a session to the top of the rail');
    await expect(details).toHaveValue('let me pin a session to the top of the rail');
    await expect(send).toBeEnabled();

    // The fill must RESOLVE — an undefined custom property computes to
    // transparent, which is the #896 bug — and it must differ from Cancel's, or
    // the primary action does not look like one.
    const fills = await w.evaluate(() => {
      const bg = (el: Element | null): string => (el ? getComputedStyle(el).backgroundColor : '');
      return {
        submit: bg(document.querySelector('[data-feature-submit]')),
        cancel: bg(document.querySelector('[data-feature-cancel]')),
      };
    });
    expect(fills.submit).not.toBe('rgba(0, 0, 0, 0)');
    expect(fills.submit).not.toBe('transparent');
    expect(fills.submit).not.toBe(fills.cancel);

    // No sideways scroll: fields at 100% width without border-box were 18px
    // wider than the dialog.
    const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    // The sentence about the private tracker appears with the channel it is
    // true of, and only then.
    await expect(dialog).not.toContainText('issue tracker is private');
    await w.locator('[data-feature-channel="ticket"]').check();
    await expect(dialog).toContainText('issue tracker is private');

    await w.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});
