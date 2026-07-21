import { test, expect } from '@playwright/test';
import { launchApp, LaunchedApp } from './fixtures/app';

test.describe('app boots', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('window opens with the shell chrome', async () => {
    a = await launchApp();
    const { window } = a;
    // title bar identity
    await expect(window.getByText('switchboard', { exact: true })).toBeVisible();
    // core controls
    await expect(window.getByRole('button', { name: '+ session' })).toBeVisible();
    // empty-state messages (distinctive, unambiguous)
    await expect(window.getByText('No sessions yet')).toBeVisible();
    await expect(window.getByText('Attention events appear here')).toBeVisible();
    // status bar shows the zero-session count
    await expect(window.getByText('no sessions', { exact: true })).toBeVisible();
  });

  test('is served over loopback http (so dockview popout can work)', async () => {
    a = await launchApp();
    const url = a.window.url();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  });
});
