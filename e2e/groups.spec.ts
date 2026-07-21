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

  test('delete removes the group', async () => {
    a = await launchApp();
    const w = a.window;
    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();
    await w.getByTitle('Delete group (its sessions become ungrouped)').click();
    await expect(w.getByText('New group')).toHaveCount(0);
  });
});
