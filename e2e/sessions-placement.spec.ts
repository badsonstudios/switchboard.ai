import { test, expect, Locator } from '@playwright/test';
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
// It covers the frame, the groups, the pills, the two rows the strip replaces,
// the right-click menus and dragging.
test.describe('sessions list placement', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('the left / top switch swaps the rail for the strip, and back', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { window } = a;
    const rail = window.locator('nav');
    const strip = window.getByTestId('sessions-strip');
    const left = window.locator('[data-placement="left"]');
    const top = window.locator('[data-placement="top"]');

    // the default: the list on the left
    await expect(rail).toBeVisible();
    await expect(strip).toHaveCount(0);
    await expect(left).toHaveAttribute('aria-pressed', 'true');
    await expect(top).toHaveAttribute('aria-pressed', 'false');
    // ONE "+ session", and it is in the list beside "+ group" (#1163): the bar
    // it used to have to itself above the workspace is gone
    const addSession = window.getByRole('button', { name: '+ session' });
    await expect(addSession).toHaveCount(1);
    await expect(rail.locator('[data-rail-add-session]')).toBeVisible();

    await top.click();
    await expect(strip).toBeVisible();
    await expect(rail).toHaveCount(0);
    // …and still exactly one, now on the strip
    await expect(addSession).toHaveCount(1);
    await expect(strip.locator('[data-strip-add-session]')).toBeVisible();
    // NOTHING ELSE is between the top bar and the workspace: the strip is the
    // only thing that lists sessions up here (#1164 removed the row of lamps
    // and the Collapsed strip from every placement). Measured, because their
    // test ids no longer exist anywhere and "count 0" of one could not fail.
    const stripBottom = (await strip.boundingBox())!;
    const workspaceTop = (await window.locator('main').boundingBox())!;
    expect(workspaceTop.y - (stripBottom.y + stripBottom.height)).toBeLessThan(4);
    await expect(top).toHaveAttribute('aria-pressed', 'true');
    await expect(left).toHaveAttribute('aria-pressed', 'false');
    // the one session, which is in no group, is a pill — and the row has
    // nothing to say about sessions it is not showing, because there are none
    await expect(strip.locator('[data-strip-pill]')).toHaveCount(1);
    await expect(strip.locator('[data-strip-pill-title]')).toHaveText(path.basename(folder));
    await expect(strip.locator('[data-strip-empty]')).toHaveCount(0);

    await left.click();
    await expect(rail).toBeVisible();
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
    await window.getByPlaceholder('Type a command or a session name…').fill('Collapse session');
    await window.keyboard.press('Enter');

    // the collapsed row is not where it went: in this placement its pill says so
    await expect(pillOf(second)).toHaveAttribute('data-folded', 'true');
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
    // …and it ENDS. Nothing on screen times this any more: the app does, and
    // a highlight lit for good is the failure.
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

  test('order is by dragging: a pill sideways, a pill onto a group, a group sideways', async () => {
    // Dispatched drag events on a real DataTransfer, as rail-reorder.spec.ts
    // does: Playwright's mouse cannot start an HTML5 drag in Electron, and what
    // is under test is what the handlers do with one, through to the STORE —
    // the order has to come back from main the way it was dropped.
    const folders = [tempProjectFolder(), tempProjectFolder(), tempProjectFolder()];
    const names = folders.map((f) => path.basename(f));
    a = await launchApp({ seedFolder: folders[0] });
    const { window } = a;
    await window.locator('[data-placement="top"]').click();
    const strip = window.getByTestId('sessions-strip');
    const menu = window.getByTestId('strip-menu');
    const pills = strip.locator('[data-strip-pill]');
    const groups = strip.locator('[data-strip-group]');
    for (const [i, folder] of folders.slice(1).entries()) {
      await a.app.evaluate(({ dialog }, d) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
      }, folder);
      await strip.locator('[data-strip-add-session]').click();
      await expect(pills).toHaveCount(i + 2, { timeout: 25_000 });
    }
    const titles = (): Promise<string[]> =>
      strip.locator('[data-strip-pill-title]').allTextContents();
    const pillOf = (name: string) =>
      pills.filter({ has: window.locator('[data-strip-pill-title]', { hasText: name }) });
    expect(await titles()).toEqual(names);

    /** drag `from` onto the left or right half of `to` */
    const dragOnto = async (from: Locator, to: Locator, half: 'left' | 'right'): Promise<void> => {
      const box = (await to.boundingBox())!;
      const clientX = box.x + box.width * (half === 'left' ? 0.25 : 0.75);
      const dt = await window.evaluateHandle(() => new DataTransfer());
      await from.dispatchEvent('dragstart', { dataTransfer: dt });
      await to.dispatchEvent('dragover', { dataTransfer: dt, clientX });
      await to.dispatchEvent('drop', { dataTransfer: dt, clientX });
    };

    // a pill sideways: the first to after the last
    await dragOnto(pillOf(names[0]), pillOf(names[2]), 'right');
    await expect.poll(titles).toEqual([names[1], names[2], names[0]]);

    // two groups, made from the strip
    for (const want of [1, 2]) {
      await strip.locator('[data-strip-line]').click({ button: 'right', position: { x: 400, y: 8 } });
      await menu.getByRole('menuitem', { name: '+ New group' }).click();
      await expect(groups).toHaveCount(want);
    }
    await groups.nth(1).click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Rename group…' }).click();
    await strip.locator('[data-strip-rename] input').fill('Second');
    await strip.locator('[data-strip-rename] input').press('Enter');
    const groupNames = (): Promise<string[]> => strip.locator('[data-strip-group-name]').allTextContents();
    await expect.poll(groupNames).toEqual(['New group', 'Second']);

    // a pill onto a group: it joins, and is a pill no longer
    await dragOnto(pillOf(names[1]), groups.nth(1), 'left');
    await expect(pills).toHaveCount(2);
    await expect(groups.nth(1).locator('[data-strip-group-count]')).toHaveText('1');

    // a group sideways: the second before the first
    await dragOnto(groups.nth(1), groups.nth(0), 'left');
    await expect.poll(groupNames).toEqual(['Second', 'New group']);

    // …and it is the same order in the list on the left, because it is one order
    await window.locator('[data-placement="left"]').click();
    await expect(window.locator('[data-rail-group-toggle]').first()).toContainText('Second');
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
    // and nothing takes its place: put away is put away (#1164). The
    // workspace starts straight under the top bar.
    const bar = (await window.locator('header').first().boundingBox())!;
    const work = (await window.locator('main').boundingBox())!;
    expect(work.y - (bar.y + bar.height)).toBeLessThan(4);
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
