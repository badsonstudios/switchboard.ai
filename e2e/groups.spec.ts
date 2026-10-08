// P2-E12-02: persistent groups in the rail — durable containers that survive
// a relaunch even when EMPTY (the "empty ≠ gone" contract).
import { test, expect } from '@playwright/test';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

test.describe('persistent groups (E12)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('create an empty group, rename it, and it survives a relaunch', async () => {
    // shared handle FIRST: a failure before close() must leave afterEach
    // something to kill (review P1-test #16 — leaked Electron/PTY trees
    // poison CI teardown)
    a = await launchApp();
    const first = a;
    const w = first.window;

    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();

    // rename via double-click
    await w.getByText('New group').dblclick();
    await w.locator('input:focus').fill('IT');
    await w.locator('input:focus').press('Enter');
    await expect(w.getByText('IT', { exact: true })).toBeVisible();
    await expect(w.getByText('empty', { exact: true })).toBeVisible();

    // #311, riding this launch rather than paying for another: erasing the name
    // commits NOTHING, and does so QUIETLY.
    //
    // The name standing is the weaker half — main's `groups:update` has always
    // refused a blank, so the group was never going to end up nameless (which
    // would have been bad in a way it is not for a session: a group's name IS
    // its rename entry point, so it would have taken the target you need in
    // order to fix it away with it). What the unguarded draft actually did was
    // hand main a name it THROWS on, over a bridge call App does not catch —
    // an ordinary UI gesture that raised an unhandled rejection in the
    // renderer. `pageerror` is the assertion that witnesses the rail's own
    // guard; revert it and this test goes red on that line alone.
    const rejections: string[] = [];
    w.on('pageerror', (e) => rejections.push(e.message));

    await w.getByText('IT', { exact: true }).dblclick();
    await w.locator('input:focus').fill('   ');
    await w.locator('input:focus').press('Enter');
    await expect(w.locator('nav input')).toHaveCount(0);
    await expect(w.getByText('IT', { exact: true })).toBeVisible();

    // A real rename right after, with padding — it proves trimming end to end,
    // and it is the BARRIER the assertion below needs: the name only changes
    // once `groups:update` has resolved and the rail has re-read the store, so
    // any rejection the erase could have raised has certainly landed by then.
    await w.getByText('IT', { exact: true }).dblclick();
    await w.locator('input:focus').fill('  IT crew  ');
    await w.locator('input:focus').press('Enter');
    await expect(w.getByText('IT crew', { exact: true })).toBeVisible();
    expect(rejections).toEqual([]);

    // #326: the OTHER half of the same problem, over the same launch. The rail
    // guard above stops the one gesture that could reach a throwing handler —
    // but every bridge call in App.tsx is uncaught, so the next caller of
    // `groups:*` would have had the same accident. That family no longer
    // throws: a refused mutation RESOLVES `null`. Driving the bridge directly
    // is the point of this probe — it stands in for the caller that has not
    // been written yet (a context-menu rename, a §5.23 contribution), which is
    // exactly who a call-site `.catch()` policy would not have protected.
    const refusals = await w.evaluate(async () => {
      const api = window.switchboard;
      const groups = await api.groups.list();
      const id = groups[0].id;
      return {
        blankName: await api.groups.update(id, { name: '   ' }),
        badColor: await api.groups.update(id, { color: 'not-a-color' }),
        blankCreate: await api.groups.create({ name: '' }),
        // and the store is untouched by all three
        nameAfter: (await api.groups.list())[0].name,
        count: (await api.groups.list()).length,
      };
    });
    expect(refusals.blankName).toBeNull();
    expect(refusals.badColor).toBeNull();
    expect(refusals.blankCreate).toBeNull();
    expect(refusals.nameAfter).toBe('IT crew');
    expect(refusals.count).toBe(1);
    // three refusals, zero rejections — the property the issue asked for
    expect(rejections).toEqual([]);

    // give the debounced store save a beat, then relaunch on the same home
    await w.waitForTimeout(800);
    await first.close();
    a = await launchApp({ home: first.home });
    await expect(a.window.getByText('IT crew', { exact: true })).toBeVisible();
    await expect(a.window.getByText('empty', { exact: true })).toBeVisible();
  });

  test('drag a session into a group and back out; membership survives relaunch (E12-04)', async () => {
    const folder = tempProjectFolder();
    const title = folder.split(/[\\/]/).pop()!;
    a = await launchApp({ seedFolder: folder }); // shared handle first (#16)
    const first = a;
    const w = first.window;
    await expect(w.getByText(title).first()).toBeVisible();

    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();

    // HTML5 DnD, synthesized: rail row -> group header
    const row = w.locator('nav [draggable="true"]', { hasText: title }).first();
    const header = w.getByText('New group', { exact: true });
    const dt = await w.evaluateHandle(() => new DataTransfer());
    await row.dispatchEvent('dragstart', { dataTransfer: dt });
    await header.dispatchEvent('drop', { dataTransfer: dt });
    // joined: the group's empty placeholder is gone, member count shows
    await expect(w.getByText('empty', { exact: true })).toHaveCount(0);

    // survives a relaunch
    await w.waitForTimeout(800);
    await first.close();
    a = await launchApp({ home: first.home });
    await expect(a.window.getByText('New group')).toBeVisible();
    await expect(a.window.getByText('empty', { exact: true })).toHaveCount(0);

    // drag back out to the rail background -> ungrouped again
    const row2 = a.window.locator('nav [draggable="true"]', { hasText: title }).first();
    const dt2 = await a.window.evaluateHandle(() => new DataTransfer());
    await row2.dispatchEvent('dragstart', { dataTransfer: dt2 });
    await a.window.locator('nav').dispatchEvent('drop', { dataTransfer: dt2 });
    await expect(a.window.getByText('empty', { exact: true })).toBeVisible();
  });

  test("a group's ⊕ opens the new session inside that group (E12-03)", async () => {
    const folder = tempProjectFolder();
    a = await launchApp();
    const w = a.window;

    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();

    // stub the native folder picker — headless CI has no dialog
    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, folder);

    await w.getByTitle('New session in this group').click();
    const title = folder.split(/[\\/]/).pop()!;
    // the session lands nested under the group (member count appears) and the
    // "empty" placeholder is gone
    await expect(w.getByText(title).first()).toBeVisible();
    await expect(w.getByText('empty', { exact: true })).toHaveCount(0);

    // membership persisted: relaunch, the session is still under the group
    await w.waitForTimeout(800);
    const home = a.home;
    await a.close();
    a = await launchApp({ home });
    await expect(a.window.getByText('New group')).toBeVisible();
    await expect(a.window.getByText('empty', { exact: true })).toHaveCount(0);
    await expect(a.window.getByText(title).first()).toBeVisible();
  });

  test('two sessions in one folder auto-group; explicit grouping dissolves it (E12-05)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = folder.split(/[\\/]/).pop()!;
    await expect(w.getByText(title).first()).toBeVisible();
    // one session: no auto-group section
    await expect(w.locator('[data-group-kind="auto"]')).toHaveCount(0);

    // second session in the SAME folder via the stubbed picker
    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, folder);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.locator('[data-group-kind="auto"]')).toBeVisible();

    // an explicit group claims one member -> the auto-group dissolves (S4)
    await w.getByTitle('Create a persistent group').click();
    const row = w.locator('nav [draggable="true"]', { hasText: title }).first();
    const header = w.getByText('New group', { exact: true });
    const dt = await w.evaluateHandle(() => new DataTransfer());
    await row.dispatchEvent('dragstart', { dataTransfer: dt });
    await header.dispatchEvent('drop', { dataTransfer: dt });
    await expect(w.locator('[data-group-kind="auto"]')).toHaveCount(0);
  });

  test('delete removes the group', async () => {
    a = await launchApp();
    const w = a.window;
    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();
    await w.getByTitle('Delete group (its sessions become ungrouped)').click();
    await expect(w.getByText('New group')).toHaveCount(0);
    });

  // #1144 — the owner's own example: "take the bottom group and make it second".
  // By the menu, then by a drag, with a relaunch in between because an order
  // that does not survive a restart is not an order.
  test('groups can be reordered by the menu and by a drag, and the order survives a relaunch (#1144)', async () => {
    a = await launchApp();
    const first = a;
    const w = first.window;
    const order = (page: typeof w): Promise<string[]> =>
      page.locator('nav [data-group-head] [data-rail-group-toggle]').allInnerTexts();

    for (const name of ['One', 'Two', 'Three']) {
      await w.getByTitle('Create a persistent group').click();
      await w.getByText('New group', { exact: true }).dblclick();
      await w.locator('input:focus').fill(name);
      await w.locator('input:focus').press('Enter');
      await expect(w.getByText(name, { exact: true })).toBeVisible();
    }
    expect(await order(w)).toEqual(['One', 'Two', 'Three']);

    // BY THE MENU: the bottom group, up once, is second
    const head = (page: typeof w, name: string) =>
      page.locator('nav [data-group-head]', { hasText: name }).first();
    await head(w, 'Three').click({ button: 'right' });
    const menu = w.getByTestId('rail-group-menu');
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Move group up' }).click();
    await expect.poll(() => order(w)).toEqual(['One', 'Three', 'Two']);

    // the top group cannot go up: the item is there, dimmed, and does nothing
    await head(w, 'One').click({ button: 'right' });
    await expect(menu.getByRole('menuitem', { name: 'Move group up' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await w.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // survives a relaunch
    await w.waitForTimeout(800); // let the debounced workspace save reach disk
    await first.close();
    a = await launchApp({ home: first.home });
    const w2 = a.window;
    await expect(w2.getByText('Three', { exact: true })).toBeVisible();
    expect(await order(w2)).toEqual(['One', 'Three', 'Two']);

    // BY A DRAG: pick "Two" up by its header and drop it on the top half of
    // "One"'s card. HTML5 DnD, synthesized, the way the membership test above
    // does it — with real coordinates, because which HALF of the card the
    // pointer is in is the whole question.
    const dt = await w2.evaluateHandle(() => new DataTransfer());
    await head(w2, 'Two').dispatchEvent('dragstart', { dataTransfer: dt });
    // the card is the header's parent, and the card is the drop target
    const target = head(w2, 'One').locator('xpath=..');
    const box = (await target.boundingBox())!;
    const at = { dataTransfer: dt, clientX: box.x + box.width / 2, clientY: box.y + 2 };
    await target.dispatchEvent('dragover', at);
    // the line says where it will land, before it lands
    await expect(w2.locator('[data-group-drop-line="before"]')).toHaveCount(1);
    await target.dispatchEvent('drop', at);
    await expect.poll(() => order(w2)).toEqual(['Two', 'One', 'Three']);
    await expect(w2.locator('[data-group-drop-line]')).toHaveCount(0);
  });
});
