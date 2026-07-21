// P2-E12-02: persistent groups in the rail — durable containers that survive
// a relaunch even when EMPTY (the "empty ≠ gone" contract).
import { test, expect } from '@playwright/test';
import { launchApp, LaunchedApp } from './fixtures/app';

test.describe('persistent groups (E12)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('create an empty group, rename it, and it survives a relaunch', async () => {
    const first = await launchApp();
    const w = first.window;

    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();

    // rename via double-click
    await w.getByText('New group').dblclick();
    await w.locator('input:focus').fill('IT');
    await w.locator('input:focus').press('Enter');
    await expect(w.getByText('IT', { exact: true })).toBeVisible();
    await expect(w.getByText('empty', { exact: true })).toBeVisible();

    // give the debounced store save a beat, then relaunch on the same home
    await w.waitForTimeout(800);
    await first.close();
    a = await launchApp({ home: first.home });
    await expect(a.window.getByText('IT', { exact: true })).toBeVisible();
    await expect(a.window.getByText('empty', { exact: true })).toBeVisible();
  });

  test("a group's ⊕ opens the new session inside that group (E12-03)", async () => {
    const { tempProjectFolder } = await import('./fixtures/app');
    const folder = tempProjectFolder();
    a = await launchApp();
    const w = a.window;

    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();

    // stub the native folder picker — headless CI has no dialog
    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
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

  test('delete removes the group', async () => {
    a = await launchApp();
    const w = a.window;
    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();
    await w.getByTitle('Delete group (its sessions become ungrouped)').click();
    await expect(w.getByText('New group')).toHaveCount(0);
  });
});
