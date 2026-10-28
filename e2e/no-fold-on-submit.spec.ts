// #1485 — sending a prompt never moves a card.
//
// "Collapse on submit" (§5.8's presentation policy, P2-E9-06) folded a card
// away when you sent it a prompt. The owner had it on for one group for weeks
// without having chosen it, and lost a session to it four times (#813, #1210,
// #1276, #1472, #1485). His verdict: remove it, so nothing but the user ever
// puts a session away. This file is what keeps it removed:
//
//   • no title-bar chip, no card-menu row, no palette entry for it;
//   • a workspace saved by an older build WITH the setting on still leaves the
//     card where it is when you press Enter;
//   • and that saved setting is wiped from the file, so no later build can
//     read it back.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  persistedUi,
  readWorkspaceFile,
  rungOf,
  tempProjectFolder,
  writeWorkspaceFile,
} from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const tabs = (w: Page) => w.locator('.dv-tabs-container .dv-tab');
const composer = (w: Page) => w.getByPlaceholder(/^Message .+…$/);

test.describe('sending a prompt never moves a card (#1485)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('an old saved "Collapse on submit" does nothing, and is wiped from the file', async () => {
    test.setTimeout(150_000);
    const folder = tempProjectFolder();
    const first = await launchApp({ seedFolder: folder });
    const only = path.basename(folder);
    await expect(tabs(first.window)).toHaveCount(1, { timeout: 25_000 });
    const cards = (await first.window.evaluate(() => window.switchboard.sessions.cards())) as Array<{
      cardId: string;
    }>;
    expect(cards).toHaveLength(1);
    const cardId = cards[0].cardId;
    // the owner's case was a GROUP override, so the session goes in a group
    const groupId = await first.window.evaluate(async (id) => {
      const g = await window.switchboard.groups.create({ name: 'SOLO' });
      if (!g) throw new Error('group create refused');
      await window.switchboard.groups.setSessionGroup(id, g.id);
      return g.id;
    }, cardId);
    // the ui blob has to be on disk before it can be doctored
    await expect
      .poll(
        () => {
          try {
            return persistedUi(readWorkspaceFile(first.home)) !== undefined;
          } catch {
            return false; // not written yet, or caught mid-write
          }
        },
        { timeout: 20_000 }
      )
      .toBe(true);
    await first.close();

    // what the owner's workspace looked like: the setting on, at every level
    const ws = readWorkspaceFile(first.home);
    const ui = persistedUi(ws) as Record<string, unknown>;
    ui.presentationPolicy = {
      global: 'auto-collapse',
      cards: { [cardId]: 'auto-collapse' },
      groups: { [groupId]: 'auto-collapse' },
    };
    writeWorkspaceFile(first.home, ws);

    a = await launchApp({ home: first.home });
    const w = a.window;
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });

    // no control for it anywhere
    await expect(w.getByTestId('presentation-policy')).toHaveCount(0);
    await w.keyboard.press(`${MOD}+Shift+P`);
    await w.getByPlaceholder('Type a command or a session name…').fill('on submit');
    await expect(w.locator('[data-palette-rows] [role="option"]')).toHaveCount(0);
    await w.keyboard.press('Escape');
    // ...and the card's own menu has only "When it needs you"
    await w.locator('.dv-active-group').getByTestId('card-menu-button').click();
    await expect(w.getByTestId('card-focus-policy')).toBeVisible();
    await expect(w.getByTestId('card-policy')).toHaveCount(0);
    await w.getByTestId('card-focus-policy').focus();
    await w.keyboard.press('Escape');
    await expect(w.getByTestId('card-menu')).toHaveCount(0);

    // send a prompt that starts a turn and keeps it running
    await composer(w).click();
    await composer(w).fill('!hang');
    await w.keyboard.press('Enter');
    // POSITIVE CONTROL: the submit really ran. A dead composer would let the
    // "nothing moved" below pass while proving nothing.
    await expect(composer(w)).toHaveValue('');

    // nothing moves. Given time, because a fold that DID happen lands a tick later.
    await w.waitForTimeout(1500);
    await expect(tabs(w)).toHaveCount(1);
    await expect(w.locator('.dv-active-tab')).toContainText(only);
    expect(await rungOf(w, only)).toBe('expanded');

    // and the old setting is gone from the file
    const home = a.home;
    await w.waitForTimeout(1200); // let the ui blob reach disk
    await a.close();
    expect(persistedUi(readWorkspaceFile(home)).presentationPolicy).toBeUndefined();
  });
});
