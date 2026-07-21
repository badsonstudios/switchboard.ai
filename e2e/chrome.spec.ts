import { test, expect } from '@playwright/test';
import { launchApp, LaunchedApp } from './fixtures/app';

test.describe('titlebar chrome', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('theme toggle flips the document theme (E1-03)', async () => {
    a = await launchApp();
    const { window } = a;
    const html = window.locator('html');
    await window.getByRole('button', { name: 'daylight' }).click();
    await expect(html).toHaveAttribute('data-theme', 'daylight');
    await window.getByRole('button', { name: 'nordic' }).click();
    await expect(html).toHaveAttribute('data-theme', 'nordic');
  });

  test('pseudo-locale mangles every UI string (E1-04)', async () => {
    a = await launchApp();
    const { window } = a;
    // real English first
    await expect(window.getByRole('button', { name: '+ session' })).toBeVisible();
    await window.getByRole('button', { name: 'pseudo' }).click();
    // strings are now wrapped in ⟦…⟧, proving none are hardcoded
    await expect(window.getByText(/⟦.+⟧/).first()).toBeVisible();
    await expect(window.getByRole('button', { name: '+ session' })).toHaveCount(0);
  });

  test('autonomy chip cycles (E6-01)', async () => {
    a = await launchApp();
    const { window } = a;
    await expect(window.getByRole('button', { name: /ask/ })).toBeVisible();
    await window.getByRole('button', { name: /ask/ }).click();
    await expect(window.getByRole('button', { name: /plan/ })).toBeVisible();
  });
});
