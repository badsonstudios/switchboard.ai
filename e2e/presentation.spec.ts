// P2-E15-08 — presentation state outlives the panel.
//
// The point of the item is that a card's view tab and its dock slot no longer
// die with the React component, so §5.8's ladder can take a card out of the
// workspace and put it back exactly where it was. The only honest way to test
// "outlives the panel" is to actually destroy the panel, so these tests hide a
// card and reveal it — and check the two things a user would notice if the
// state had been lost: the wrong tab, and the wrong place.
//
// TRANSPORT SCOPE (P2-E18-18, #404): "the wrong tab" is proved by parking the
// card on the Terminal and asserting a live `.xterm` when it comes back — which
// only a PTY session has, so the two tab-restore tests are tagged `[pty]`. The
// presentation store itself is transport-independent, and the two slot/close
// tests below are untagged because they never look at a terminal. See
// `launchApp` in `fixtures/app.ts` for the tag.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const rail = (w: Page) => w.locator('nav');
const row = (w: Page, title: string) =>
  rail(w).locator('[draggable="true"]', { hasText: title }).first();
const tabs = (w: Page) => w.locator('.dv-tabs-container .dv-tab');

/** how many live sessions the main process is running */
async function liveCount(w: Page): Promise<number> {
  return w.evaluate(async () => (await window.switchboard.sessions.list()).length);
}

async function hideActive(w: Page): Promise<void> {
  await w.keyboard.press(`${MOD}+Shift+P`);
  await w.getByPlaceholder('Type a command or a session name…').fill('hide session');
  await w.keyboard.press('Enter');
}

/** open one more session, in its own folder */
async function addSession(a: LaunchedApp): Promise<string> {
  const dir = tempProjectFolder();
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
  await a.window.getByRole('button', { name: '+ session' }).click();
  await expect(row(a.window, path.basename(dir))).toBeVisible({ timeout: 25_000 });
  return path.basename(dir);
}

test.describe('presentation state (P2-E15-08)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('[pty] a hidden card keeps its session, and comes back on the tab it left', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(row(w, title)).toBeVisible({ timeout: 25_000 });
    await expect(tabs(w)).toHaveCount(1);

    // put it on a NON-default tab: the default would pass even if the state
    // were lost entirely
    await w.getByRole('tab', { name: 'Terminal', exact: true }).click();
    await expect(w.locator('.xterm')).toBeVisible();
    expect(await liveCount(w)).toBe(1);

    await hideActive(w);

    // out of the workspace, but NOT closed: still in the rail, still running.
    // That difference is the whole contract — hiding must never be a quiet
    // close, and the session keeps working while you aren't watching it.
    await expect(tabs(w)).toHaveCount(0);
    await expect(row(w, title)).toBeVisible();
    expect(await liveCount(w)).toBe(1);

    // §5.8: "reveal triggers ... user click anywhere (sidebar, event, lamp)"
    await row(w, title).click();
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });

    // the tab it was on, not the default
    await expect(w.locator('.xterm')).toBeVisible({ timeout: 25_000 });
    await expect(w.getByRole('tab', { name: 'Terminal', exact: true })).toHaveCSS(
      'font-weight',
      '650'
    );
    // and ONE session for the card, not two: revealing remounts the card over a
    // session that is still running, and create() must adopt it rather than
    // spawn a second claude that nothing can reach
    expect(await liveCount(w)).toBe(1);
  });

  test('a hidden card comes back to its slot among its neighbours', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    const second = await addSession(a);
    const third = await addSession(a);
    await expect(tabs(w)).toHaveCount(3);

    // hide the MIDDLE one: coming back at the end would look like success in a
    // two-card test and is exactly the failure the slot record prevents
    await row(w, second).click();
    await expect(w.locator('.dv-active-tab')).toContainText(second);
    await hideActive(w);
    await expect(tabs(w)).toHaveCount(2);

    await row(w, second).click();
    await expect(tabs(w)).toHaveCount(3, { timeout: 25_000 });
    expect(await tabs(w).allInnerTexts()).toEqual([
      expect.stringContaining(path.basename(folder)),
      expect.stringContaining(second),
      expect.stringContaining(third),
    ]);
  });

  test('a hidden card can still be closed from the rail', async () => {
    // §5.8: hiding chrome never removes capability. The ✕ sits on the row of a
    // session that is deliberately NOT in the workspace, so the close path has
    // to work without a panel to remove — it silently did nothing at first.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(row(w, title)).toBeVisible({ timeout: 25_000 });
    await hideActive(w);
    await expect(tabs(w)).toHaveCount(0);

    // it still confirms — closing ends the session and forgets the record
    w.once('dialog', (d) => void d.dismiss());
    await row(w, title).getByTitle('Close session').click();
    await expect(row(w, title)).toBeVisible();
    expect(await liveCount(w)).toBe(1);

    w.once('dialog', (d) => void d.accept());
    await row(w, title).getByTitle('Close session').click();
    await expect(rail(w).getByText(title)).toHaveCount(0, { timeout: 15_000 });
    expect(await liveCount(w)).toBe(0);
  });

  test('[pty] hidden survives a relaunch — and so does the tab it was on', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const title = path.basename(folder);
    await expect(row(a.window, title)).toBeVisible({ timeout: 25_000 });
    const second = await addSession(a);
    await expect(tabs(a.window)).toHaveCount(2);

    // two cards are mounted, so scope to the one on screen: `.first()` picks by
    // DOM order and would silently drive the OTHER card's tab strip
    await a.window
      .getByRole('tab', { name: 'Terminal', exact: true })
      .filter({ visible: true })
      .click();
    await hideActive(a.window);
    await expect(tabs(a.window)).toHaveCount(1);

    const home = a.home;
    await a.close();
    a = await launchApp({ home });
    const w = a.window;

    // the workspace comes back as the user left it (§5.25): one card visible,
    // the hidden one still hidden but still listed in the rail
    await expect(row(w, second)).toBeVisible({ timeout: 25_000 });
    await expect(tabs(w)).toHaveCount(1);
    await expect(rail(w).locator('[draggable="true"]')).toHaveCount(2);

    await row(w, second).click();
    await expect(tabs(w)).toHaveCount(2, { timeout: 25_000 });
    await expect(w.locator('.xterm')).toBeVisible({ timeout: 25_000 });
  });
});
