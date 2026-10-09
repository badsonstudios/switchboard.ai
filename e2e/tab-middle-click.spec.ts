// Middle-click closes a tab (#619), in the real app.
//
// The unit tests pin the routine (one close path for the ✕ and the middle
// button, which buttons count, what is cancelled). What only the real app can
// show is that a real middle button over a real dockview tab produces the
// click the handler listens for, and that the session's "this ends the
// session" question really is asked first. (A document or diff tab closing with
// no question is covered by the unit tests only; this spec opens neither.)
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const tabs = (w: Page) => w.locator('.dv-tab .identity-tab');

test.describe('middle-click on a tab (#619)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.close();
  });

  test('a session tab asks first: no keeps it, yes closes it', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.locator('nav').getByText(name)).toBeVisible({ timeout: 25_000 });
    const tab = tabs(w).filter({ hasText: name });
    await expect(tab).toHaveCount(1);

    // the same question the ✕ asks, and "no" leaves the session alone
    let asked = '';
    w.once('dialog', (d) => {
      asked = d.message();
      void d.dismiss();
    });
    await tab.click({ button: 'middle' });
    await expect.poll(() => asked).toContain(name);
    expect(asked).toContain('ends the session');
    await expect(tab).toHaveCount(1);
    await expect(w.locator('nav').getByText(name)).toBeVisible();

    w.once('dialog', (d) => void d.accept());
    await tab.click({ button: 'middle' });
    await expect(tab).toHaveCount(0, { timeout: 15_000 });
    await expect(w.locator('nav').getByText(name)).toHaveCount(0);
  });

  test('the right button does not close a tab', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const tab = tabs(w).filter({ hasText: name });
    await expect(tab).toHaveCount(1, { timeout: 25_000 });

    let dialogs = 0;
    w.on('dialog', (d) => {
      dialogs += 1;
      void d.dismiss();
    });
    await tab.click({ button: 'right' });
    await w.waitForTimeout(400);
    expect(dialogs).toBe(0);
    await expect(tab).toHaveCount(1);
  });
});
