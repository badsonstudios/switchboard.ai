import { test, expect } from '@playwright/test';
import { launchApp, LaunchedApp } from './fixtures/app';

test.describe('app boots', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('window opens with the shell chrome', async () => {
    a = await launchApp();
    const { window } = a;
    // title bar identity
    await expect(window.getByText('switchboard.ai', { exact: true })).toBeVisible();
    // core controls
    await expect(window.getByRole('button', { name: '+ session' })).toBeVisible();
    // empty-state messages (distinctive, unambiguous)
    await expect(window.getByText('No sessions yet')).toBeVisible();
    // The events drawer is collapsed at boot (P2-E14-01), so its empty-state
    // sentence is not what the shell shows any more — its TAB is, saying the
    // same thing in the same breath as the count it exists to carry. Opening
    // it here would test the drawer rather than the boot, and
    // events-drawer.spec.ts does that properly.
    await expect(window.getByTestId('events-tab')).toBeVisible();
    await expect(window.getByTestId('events-tab')).toHaveAttribute('data-count', '0');
    await expect(window.getByTestId('events-tab')).toHaveAttribute(
      'aria-label',
      /nothing waiting/
    );
    // status bar shows the zero-session count — scoped, because the rail has
    // its own footer count now and both read "no sessions" when empty
    await expect(
      window.getByRole('contentinfo').getByText('no sessions', { exact: true })
    ).toBeVisible();
    await expect(
      window.getByRole('navigation').getByText('no sessions', { exact: true })
    ).toBeVisible();
  });

  test('is served over loopback http (so dockview popout can work)', async () => {
    a = await launchApp();
    const url = a.window.url();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  });
});
