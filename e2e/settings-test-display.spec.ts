// Settings → Advanced → Testing: the screen this project's own tests run on (#1331).
//
// What only the real app can show: that MAIN, not the renderer, owns the file —
// it lands in the app's home (`os.homedir()`, which the fixture points at the
// launch's TEMP home), keeps every line it does not own, and that the list is
// the real `screen.getAllDisplays()`.
//
// SAFETY: every byte this spec reads or writes is inside `a.home`, a fresh temp
// dir. It asserts that before touching anything, so a fixture change that ever
// handed the app the developer's real home fails here instead of rewriting the
// developer's own `~/.switchboard-e2e.env`.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp, openSettingsTab } from './fixtures/app';

const FILE = '.switchboard-e2e.env';

test.describe('Settings → Advanced → Testing (#1331)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('lists the attached screens, says a saved screen is not attached, and picking the primary removes only that line', async () => {
    a = await launchApp();
    const w = a.window;

    // ⚠️ the temp home, never the developer's
    expect(path.resolve(a.home)).not.toBe(path.resolve(os.homedir()));
    expect(path.resolve(a.home).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    const file = path.join(a.home, FILE);
    // a saved screen no machine has, beside a key and a comment this setting does not own
    const seeded = '# mine\r\nSWITCHBOARD_E2E_NO_ACTIVATE=1\r\nSWITCHBOARD_E2E_MONITOR=id:987654321\r\n';
    fs.writeFileSync(file, seeded, 'utf8');

    const d = await openSettingsTab(w, 'advanced');
    const block = d.locator('[data-settings-block="test-display"]');
    await block.scrollIntoViewIfNeeded();
    await expect(block.locator('[data-test-display-option="primary"]')).toBeVisible();

    // one row per attached display: the primary (as the default) and the rest
    const count = await a.app.evaluate(({ screen }) => screen.getAllDisplays().length);
    await expect(block.locator('[data-test-display-option]')).toHaveCount(count + 1); // + the saved row
    await expect(block.locator('[data-test-display-option="primary"]')).toContainText('Primary screen (default)');

    // the saved screen is not attached, and says so
    const saved = block.locator('[data-test-display-option="saved"]');
    await expect(saved).toContainText('id:987654321');
    await expect(saved).toContainText('Not attached — tests run on the primary until it is back.');
    await expect(saved.locator('input')).toBeChecked();

    // pick the primary: the line goes, everything else stays byte-for-byte
    // a controlled radio: it ticks when MAIN answers, so click and then wait,
    // rather than `check()`, which wants the state to flip on the click itself
    await block.locator('[data-test-display-option="primary"] input').click();
    await expect(saved).toHaveCount(0);
    await expect(block.locator('[data-test-display-option="primary"] input')).toBeChecked();
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('# mine\r\nSWITCHBOARD_E2E_NO_ACTIVATE=1\r\n');

    // and nothing complained along the way
    await expect(d.locator('[data-test-display-problem]')).toHaveCount(0);
  });
});
