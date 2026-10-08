import { test, expect } from '@playwright/test';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  openSettings,
  closeSettings,
  tempProjectFolder,
  permissionHolder,
} from './fixtures/app';

// Where the sessions are listed (#1143): the rail down the left, or one strip
// across the top. This spec is the claim the unit tests cannot make — that in
// the real window the three doors (the title bar's switch, Ctrl+B and Settings)
// move ONE thing, and that the choice is still there after a restart.
//
// It covers the frame, the groups, the pills, the two rows the strip replaces
// and the right-click menus. Dragging arrives with its own tests.
test.describe('sessions list placement', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('the left / top switch swaps the rail for the strip, and back', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { window } = a;
    const rail = window.locator('nav');
    const strip = window.getByTestId('sessions-strip');
    const lamps = window.getByTestId('urgency-strip');
    const left = window.locator('[data-placement="left"]');
    const top = window.locator('[data-placement="top"]');

    // the default: the rail, and the two rows the strip will replace
    await expect(rail).toBeVisible();
    await expect(lamps).toBeVisible();
    await expect(strip).toHaveCount(0);
    await expect(left).toHaveAttribute('aria-pressed', 'true');
    await expect(top).toHaveAttribute('aria-pressed', 'false');

    await top.click();
    await expect(strip).toBeVisible();
    await expect(rail).toHaveCount(0);
    // GONE, with the collapsed row: the strip lists every session itself now,
    // carries the total, and lights what a jump landed on.
    await expect(lamps).toHaveCount(0);
    await expect(window.getByTestId('collapsed-strip')).toHaveCount(0);
    await expect(top).toHaveAttribute('aria-pressed', 'true');
    await expect(left).toHaveAttribute('aria-pressed', 'false');
    // the one session, which is in no group, is a pill — and the row has
    // nothing to say about sessions it is not showing, because there are none
    await expect(strip.locator('[data-strip-pill]')).toHaveCount(1);
    await expect(strip.locator('[data-strip-pill-title]')).toHaveText(path.basename(folder));
    await expect(strip.locator('[data-strip-empty]')).toHaveCount(0);

    await left.click();
    await expect(rail).toBeVisible();
    await expect(lamps).toBeVisible();
    await expect(strip).toHaveCount(0);
  });

  test('a group is an entry on the strip, and opens a list of its sessions', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { window } = a;
    const name = path.basename(folder);

    // Arranged in the rail, which is where this could already be done: make a
    // group and put the one session in it.
    await window.getByTitle('Create a persistent group').click();
    await expect(window.getByText('New group')).toBeVisible();
    await window.locator('.rail-row').first().click({ button: 'right' });
    await window.getByRole('menuitemradio', { name: 'New group' }).click();
    await expect(window.locator('[data-group-card] .rail-row')).toHaveCount(1);

    await window.locator('[data-placement="top"]').click();
    const strip = window.getByTestId('sessions-strip');
    const entry = strip.locator('[data-strip-group]');
    await expect(entry).toHaveCount(1);
    await expect(entry.locator('[data-strip-group-name]')).toHaveText('New group');
    await expect(entry.locator('[data-strip-group-count]')).toHaveText('1');
    // the first session in the first group is Ctrl+1, here as in the rail
    await expect(entry.locator('[data-strip-group-range]')).toHaveText('1');
    // nothing is loose any more, so there is nothing the strip is not showing
    await expect(strip.locator('[data-strip-empty]')).toHaveCount(0);

    const list = window.locator('[data-strip-list]');
    await expect(list).toHaveCount(0);
    await entry.locator('[data-strip-group-open]').click();
    await expect(list).toBeVisible();
    await expect(list.locator('.rail-row')).toHaveCount(1);
    await expect(list.locator('[data-rail-title]')).toHaveText(name);
    // not clipped by the strip's sideways scroll: it hangs BELOW the strip
    const stripBox = (await strip.boundingBox())!;
    const listBox = (await list.boundingBox())!;
    expect(listBox.y + listBox.height).toBeGreaterThan(stripBox.y + stripBox.height);

    // going to the session is what the list is for, and it gets out of the way
    await list.locator('[data-rail-open]').click();
    await expect(list).toHaveCount(0);
  });

  test('a folded-away session is a dashed pill, and a click brings it back', async () => {
    const first = tempProjectFolder();
    a = await launchApp({ seedFolder: first });
    const { window } = a;
    await window.locator('[data-placement="top"]').click();
    const strip = window.getByTestId('sessions-strip');

    // a second session, in its own folder so nothing groups by itself
    const second = tempProjectFolder();
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, second);
    await strip.locator('[data-strip-add-session]').click();
    const pills = strip.locator('[data-strip-pill]');
    await expect(pills).toHaveCount(2, { timeout: 25_000 });
    const pillOf = (folder: string) =>
      pills.filter({ has: window.locator('[data-strip-pill-title]', { hasText: path.basename(folder) }) });
    await expect(pillOf(second)).toHaveAttribute('data-folded', 'false');

    // fold the one that is focused (the new one) out of the workspace
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await window.keyboard.press(`${mod}+Shift+P`);
    await window.getByPlaceholder('Type a command or a session name…').fill('Collapse session to a strip');
    await window.keyboard.press('Enter');

    // the collapsed row is not where it went: in this placement its pill says so
    await expect(pillOf(second)).toHaveAttribute('data-folded', 'true');
    await expect(window.getByTestId('collapsed-strip')).toHaveCount(0);
    await expect(pillOf(first)).toHaveAttribute('data-folded', 'false');

    await pillOf(second).click();
    await expect(pillOf(second)).toHaveAttribute('data-folded', 'false');
  });

  test('a jump lights the pill it landed on, and the light goes out', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { window } = a;
    await window.locator('[data-placement="top"]').click();
    const strip = window.getByTestId('sessions-strip');
    const pill = strip.locator('[data-strip-pill]');
    await expect(pill).toHaveCount(1);

    // Only ONE jump lights anything: "go to the next session that needs you".
    // So the session has to need you first — held on a permission question.
    await permissionHolder(a)(path.basename(folder));
    await expect(pill).toHaveAttribute('data-needs-you', 'true', { timeout: 15_000 });
    // …which is also the one total, read from the same set as the pill
    await expect(strip.locator('[data-strip-need]')).toHaveText('1 needs you');

    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    // The highlight is a ~1.5s transient measured against `Date.now()`, so
    // polling for it against the wall clock is a race a loaded machine loses
    // (urgency.spec.ts has the history). Stop the page's clock for the half of
    // the claim that is "it is lit", and let it run again for "it goes out".
    await window.evaluate(() => {
      const w = window as unknown as { __realNow?: () => number };
      const real = Date.now;
      w.__realNow = real;
      const frozen = real();
      Date.now = () => frozen;
    });
    try {
      await window.keyboard.press(`${mod}+Space`);
      await expect(pill).toHaveAttribute('data-flash', 'true');
    } finally {
      await window.evaluate(() => {
        const w = window as unknown as { __realNow?: () => number };
        if (w.__realNow) Date.now = w.__realNow;
        delete w.__realNow;
      });
    }
    // …and it ENDS. With the lamps row gone, the strip is the only thing that
    // starts this beat and puts it out; a highlight lit for good is the failure.
    await expect(pill).not.toHaveAttribute('data-flash', 'true', { timeout: 10_000 });
  });

  test('everything a group needs can be done from the strip, by right-click', async () => {
    // The whole point of the menus: with the sessions across the top there is
    // no list on the left to go back to. So this never touches the rail until
    // the last step, which is the menu sending you there.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { window } = a;
    const name = path.basename(folder);
    await window.locator('[data-placement="top"]').click();
    const strip = window.getByTestId('sessions-strip');
    const menu = window.getByTestId('strip-menu');
    const pill = strip.locator('[data-strip-pill]');
    const group = strip.locator('[data-strip-group]');
    await expect(pill).toHaveCount(1);

    // an empty part of the strip: make a group
    await strip.locator('[data-strip-line]').click({ button: 'right', position: { x: 400, y: 8 } });
    await menu.getByRole('menuitem', { name: '+ New group' }).click();
    await expect(group).toHaveCount(1);
    await expect(group.locator('[data-strip-group-summary]')).toHaveText('empty');

    // the session: move it into that group
    await pill.click({ button: 'right' });
    await expect(menu.getByRole('menuitemradio', { name: 'No group' })).toHaveAttribute('aria-checked', 'true');
    await menu.getByRole('menuitemradio', { name: 'New group' }).click();
    await expect(pill).toHaveCount(0);
    await expect(group.locator('[data-strip-group-count]')).toHaveText('1');

    // the group: rename it
    await group.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Rename group…' }).click();
    const groupBox = strip.locator('[data-strip-rename] input');
    await expect(groupBox).toHaveValue('New group');
    await groupBox.fill('Infra');
    await groupBox.press('Enter');
    await expect(group.locator('[data-strip-group-name]')).toHaveText('Infra');
    // …and that Enter did nothing else. It used to: the keyboard went back to
    // the group's button mid-keypress, and the same Enter "clicked" it open.
    await expect(window.locator('[data-strip-list]')).toHaveCount(0);

    // a row in its list: rename the session, with the list staying open
    await group.locator('[data-strip-group-open]').click();
    const list = window.locator('[data-strip-list]');
    await list.locator('.rail-row').click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Rename…' }).click();
    const rowBox = list.locator('.rail-row input');
    await expect(rowBox).toHaveValue(name);
    await rowBox.fill('renamed-here');
    await rowBox.press('Enter');
    await expect(list.locator('[data-rail-title]')).toHaveText('renamed-here');
    await expect(list).toBeVisible();
    await window.keyboard.press('Escape');

    // the group: delete it, and its session is a pill again under its new name
    await group.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: /^Delete group/ }).click();
    await expect(group).toHaveCount(0);
    await expect(pill.locator('[data-strip-pill-title]')).toHaveText('renamed-here');

    // and the way back to the list on the left is in the same menu
    await strip.locator('[data-strip-line]').click({ button: 'right', position: { x: 400, y: 8 } });
    await menu.getByRole('menuitemradio', { name: 'Sessions on the left' }).click();
    await expect(window.locator('nav')).toBeVisible();
    await expect(strip).toHaveCount(0);
  });

  test('the lit half hides the strip, and Ctrl+B brings it back where it was', async () => {
    a = await launchApp();
    const { window } = a;
    const strip = window.getByTestId('sessions-strip');
    const top = window.locator('[data-placement="top"]');
    const left = window.locator('[data-placement="left"]');

    await top.click();
    await expect(strip).toBeVisible();

    await top.click(); // the lit half: put it away
    await expect(strip).toHaveCount(0);
    // with nothing listing the sessions, the lamps row is back: put away
    // looks the same whichever placement was put away
    await expect(window.getByTestId('urgency-strip')).toBeVisible();
    await expect(window.locator('nav')).toHaveCount(0);
    // hidden is not a third half: neither is lit
    await expect(top).toHaveAttribute('aria-pressed', 'false');
    await expect(left).toHaveAttribute('aria-pressed', 'false');

    // `Mod+B` is scope 'app': it is ignored while focus is in a prompt box
    await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await window.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+b`);
    await expect(strip).toBeVisible();
    await expect(top).toHaveAttribute('aria-pressed', 'true');
  });

  test('Settings shows the same choice, and it survives a restart', async () => {
    a = await launchApp();
    const home = a.home;
    let { window } = a;

    const dialog = await openSettings(window);
    await expect(dialog.locator('[data-sessions-placement="left"]')).toBeChecked();
    await dialog.locator('[data-sessions-placement="top"]').check();
    // visible behind the modal the instant it is picked — no Save button
    await expect(window.getByTestId('sessions-strip')).toBeVisible();
    await expect(window.locator('[data-placement="top"]')).toHaveAttribute('aria-pressed', 'true');
    await closeSettings(window);

    await a.close();
    a = await launchApp({ home });
    ({ window } = a);
    await expect(window.getByTestId('sessions-strip')).toBeVisible();
    await expect(window.locator('nav')).toHaveCount(0);
  });
});
