// The effort chip beside the model chip (#1115), in the real app.
//
// The contract itself was measured against the real CLI (spike/probes/1115);
// this drives the app against the stand-in CLI, which answers the two verbs the
// way the real one was measured to — including saying "success" to a level it
// does not know. What only the real app can show: the chip is in the composer
// row next to the model chip, a choice goes all the way to the session and
// back, it survives the card's session starting again, and the row still fits.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

const chip = (w: Page) => w.getByTestId('composer-effort');
const model = (w: Page) => w.getByTestId('composer-model');

/** what the session itself says it is on: the app's own read, not the chip */
async function sessionEffort(w: Page): Promise<unknown> {
  return w.evaluate(async () => {
    const live = (await window.switchboard.sessions.list()) as Array<{ id: string }>;
    const v = (await window.switchboard.sessions.effort(live[0].id)) as {
      ok: boolean;
      response?: { effort?: unknown };
    };
    return v.ok ? v.response?.effort : `not ok`;
  });
}

test.describe('the effort chip (#1115)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.close();
  });

  test('is beside the model chip, shows the session’s level, and a choice reaches the session', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // there with no turn taken: a fresh card is when you choose
    await expect(chip(w)).toBeVisible({ timeout: 20_000 });
    await expect(chip(w)).toHaveValue('medium');
    expect(await chip(w).locator('option').allTextContents()).toEqual([
      'effort: low',
      'effort: medium',
      'effort: high',
      'effort: extra high',
      'effort: max',
    ]);

    // AND THE MODEL CHIP SAYS THE MODEL, with no turn taken (#1174): the read
    // that filled the effort chip is the one that told the card its model. It
    // used to read "model?" here until the first reply.
    await expect(model(w)).toHaveText('claude-fake-1', { timeout: 10_000 });

    // RIGHT OF the model chip, on the same row
    const m = (await model(w).boundingBox())!;
    const e = (await chip(w).boundingBox())!;
    expect(e.x).toBeGreaterThanOrEqual(m.x + m.width - 1);
    expect(Math.abs(e.y + e.height / 2 - (m.y + m.height / 2))).toBeLessThan(6);

    await chip(w).selectOption('high');
    await expect(chip(w)).toHaveValue('high');
    // BY EFFECT: ask the session, not the chip
    await expect.poll(() => sessionEffort(w)).toBe('high');
  });

  test('the choice is put back when the app, and the session, start again', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    let w = a.window;
    await expect(chip(w)).toBeVisible({ timeout: 25_000 });
    await chip(w).selectOption('max');
    await expect.poll(() => sessionEffort(w)).toBe('max');

    const home = a.home;
    await w.waitForTimeout(1200); // let the ui blob reach disk
    await a.close();

    a = await launchApp({ home, env: DIRECT });
    w = a.window;
    // a NEW process, which comes up on the model's default; the card remembers
    await expect(chip(w)).toBeVisible({ timeout: 25_000 });
    await expect(chip(w)).toHaveValue('max', { timeout: 15_000 });
    await expect.poll(() => sessionEffort(w)).toBe('max');
  });

  test('a model with no effort levels has no chip, and it comes back with a model that has them', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(chip(w)).toBeVisible({ timeout: 25_000 });

    await model(w).click();
    await w.getByTestId('model-quick-menu').locator('[data-model="haiku"]').click();
    await expect(model(w)).toContainText('haiku');
    await expect(chip(w)).toHaveCount(0);

    await model(w).click();
    await w.getByTestId('model-quick-menu').locator('[data-model="sonnet"]').click();
    await expect(model(w)).toContainText('sonnet');
    await expect(chip(w)).toBeVisible();
    // this model lists three levels, not five
    expect(await chip(w).locator('option').count()).toBe(3);
  });

  test('the composer’s row still fits in a narrow card', async () => {
    // the row keeps gaining tenants; this is the sixth. Two cards side by side
    // at the narrowest window the CI runner has is the tight case.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(chip(w)).toBeVisible({ timeout: 25_000 });
    const second = tempProjectFolder();
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, second);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(path.basename(second)).first()).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const b = win.getBounds();
      win.setBounds({ x: b.x, y: b.y, width: 1024, height: 686 });
    });
    await w.locator('[data-layout-preset="columns2"]').click();
    await expect(chip(w)).toHaveCount(2);

    const fit = await w.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid="composer-effort"]')).map(
        (el) => {
          const row = el.parentElement!;
          const card = el.closest<HTMLElement>('.dv-groupview')!.getBoundingClientRect();
          const kids = Array.from(row.children).map((k) => k.getBoundingClientRect());
          return {
            // nothing in the row sticks out of its card
            out: Math.round(Math.max(...kids.map((k) => k.right)) - card.right),
            // and the row did not wrap to a second line
            lines: new Set(kids.filter((k) => k.width > 0).map((k) => Math.round(k.top / 12))).size,
            cardWidth: Math.round(card.width),
          };
        }
      )
    );
    for (const f of fit) {
      expect(f.out, JSON.stringify(fit)).toBeLessThanOrEqual(0);
    }
    console.log('[effort-chip] composer row in a two-up at 1024:', JSON.stringify(fit));
  });
});
