import { test, expect } from '@playwright/test';
import fs from 'fs';
import { findFile, launchApp, LaunchedApp, poll } from './fixtures/app';

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

  test('the MAIN process got its translator (#471)', async () => {
    a = await launchApp();
    // The one thing a unit test cannot reach. `src/main/i18n.test.ts` runs
    // under vitest, where everything is ESM and Vite resolves it; PRODUCTION
    // main is a rolled-up bundle inside an Electron process. i18next-icu's
    // formatter arrives through a PEER dependency this app never declares
    // (`intl-messageformat`), so "does main have an interpolator at all" is a
    // BUILD fact — and `src/build/bundled-deps.ts` is the answer only while the
    // vite config still says so. If that ever regresses, every notification
    // silently goes back to raw English with the ICU braces showing, and this
    // line is what says so instead.
    const log = await poll(() => {
      const f = findFile(a.home, 'switchboard.log');
      const text = f ? fs.readFileSync(f, 'utf8') : '';
      return text.includes('main i18n ready') ? text : null;
    });
    const line = [...log.matchAll(/\{[^\n]*"msg":"main i18n ready"[^\n]*\}/g)].pop();
    expect(line, 'main never logged that i18n came up').toBeTruthy();
    const parsed = JSON.parse(line![0]) as { ready?: boolean; language?: string };
    expect(parsed.ready).toBe(true);
    // A fresh home has no stored preference, so English is the honest default —
    // and a `language` that came back undefined would mean main is not reading
    // the workspace blob at all, which is the whole locale mechanism.
    expect(parsed.language).toBe('en');
  });

  test('a window whose page failed to load gets it again, and the log says why (#1592)', async () => {
    // The CI sighting behind this: a window that came up showing Chromium's
    // error page — no rail, no renderer log line, for 30 s. Nothing can make
    // OUR loopback load fail on demand, so the failure is made the honest way:
    // main itself sends the window to a port Chromium refuses outright
    // (ERR_UNSAFE_PORT, -312). That is a real failed main-frame load, through
    // the real `did-fail-load`, and the page must come back on its own.
    a = await launchApp();
    const w = a.window;
    await expect(w.getByRole('button', { name: '+ session' })).toBeVisible();
    await a.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.loadURL('http://127.0.0.1:1/index.html').catch(() => undefined);
    });
    // Main says the retry landed — waited for FIRST, because the old page's
    // button is still on screen until the failed load replaces it
    const log = await poll(() => {
      const f = findFile(a.home, 'switchboard.log');
      const text = f ? fs.readFileSync(f, 'utf8') : '';
      return text.includes('the window loaded its page on a retry') ? text : null;
    });
    // ...and the window is back on our own page, with the shell drawn
    expect(w.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    await expect(w.getByRole('button', { name: '+ session' })).toBeVisible();
    const failed = log.split('\n').find((l) => l.includes('the window failed to load its page'));
    expect(failed, 'the failure was never logged').toBeTruthy();
    expect(JSON.parse(failed!)).toMatchObject({ errorCode: -312, url: 'http://127.0.0.1:1/index.html' });
  });
});
