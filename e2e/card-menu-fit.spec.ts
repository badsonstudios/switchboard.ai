// The card's "⋯" menu is fully reachable on a short, split window (#695).
//
// The menu used to be an `absolute` box hung under its button: on a window at
// the app's minimum height split into rows, the menu of a card in the bottom
// row ran off the bottom of the window and its last entries could not be
// reached. This drives the real app into that squeeze (the #641 pattern) and
// asks the only question that matters: is every entry of the menu on screen and
// really the thing under the pointer there.
import { test, expect, Page } from '@playwright/test';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

async function addSession(a: LaunchedApp): Promise<void> {
  const dir = tempProjectFolder();
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
  const before = await a.window.locator('.dv-tab .identity-tab').count();
  await a.window.getByRole('button', { name: '+ session' }).click();
  await expect(a.window.locator('.dv-tab .identity-tab')).toHaveCount(before + 1, { timeout: 25_000 });
}

/** four sessions, all started, in two short rows of a window at the app's minimum */
async function squeezed(a: LaunchedApp): Promise<Page> {
  const w = a.window;
  await expect(w.getByPlaceholder(/Prompt this session/).first()).toBeVisible({ timeout: 25_000 });
  await addSession(a);
  await addSession(a);
  await addSession(a);
  // the OS minimum is lifted so the height asked for is the height we get on
  // every runner (the #1164 lesson: do not lean on the app's own minimum)
  await a.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setMinimumSize(600, 300);
    const b = win.getBounds();
    win.setBounds({ x: b.x, y: b.y, width: 800, height: 560 });
  });
  await w.locator('[data-layout-preset="grid"]').click();
  await expect(w.locator('[data-testid="card-menu-button"]')).toHaveCount(4, { timeout: 10_000 });
  // the resize has really reached the page
  await expect
    .poll(() => w.evaluate(() => document.documentElement.clientHeight), { timeout: 10_000 })
    .toBeLessThan(600);
  // every session is past "starting": the menu's last entries are locked until then
  await expect(w.getByPlaceholder(/Prompt this session/)).toHaveCount(4, { timeout: 25_000 });
  return w;
}

/** the open menu, measured: where it is, and whether each entry can be hit */
async function measure(w: Page): Promise<{
  inside: boolean;
  coversButton: boolean;
  blocked: string[];
  entries: number;
  menu: { top: number; bottom: number; height: number };
  wouldOverflowBelow: boolean;
  viewport: { width: number; height: number };
}> {
  return w.evaluate(() => {
    const menu = document.querySelector<HTMLElement>('[data-testid="card-menu"]')!;
    const button = menu.parentElement!.querySelector<HTMLElement>('[data-testid="card-menu-button"]')!;
    const r = menu.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const entries = Array.from(menu.querySelectorAll<HTMLElement>('button, select'));
    const blocked: string[] = [];
    for (const el of entries) {
      const e = el.getBoundingClientRect();
      const hit = document.elementFromPoint(e.left + e.width / 2, e.top + e.height / 2);
      // the thing under the pointer at an entry's middle must be IN the menu
      if (!hit || !menu.contains(hit)) {
        blocked.push(
          `${(el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30)} @${Math.round(e.left)},${Math.round(e.top)} ${Math.round(e.width)}x${Math.round(e.height)} hit=${hit ? hit.tagName + '.' + (hit.getAttribute('data-testid') ?? hit.className) : 'none'}`
        );
      }
    }
    return {
      inside: r.left >= 0 && r.top >= 0 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5,
      coversButton: r.top < b.bottom - 0.5 && r.bottom > b.top + 0.5 && r.left < b.right && r.right > b.left,
      blocked,
      entries: entries.length,
      menu: { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) },
      // would the OLD placement (straight under the button) have run off the window?
      wouldOverflowBelow: b.bottom + 4 + menu.scrollHeight > vh,
      viewport: { width: vw, height: vh },
    };
  });
}

test.describe('the card menu on a short, split window (#695)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.close();
  });

  test('every entry is on screen and clickable, on each card of a split at a short height', async () => {
    a = await launchApp({ seedFolder: tempProjectFolder(), env: DIRECT });
    const w = await squeezed(a);
    const buttons = w.locator('[data-testid="card-menu-button"]');

    const seen: Array<Awaited<ReturnType<typeof measure>>> = [];
    for (let i = 0; i < 4; i++) {
      await buttons.nth(i).click();
      const menu = w.getByTestId('card-menu');
      await expect(menu).toBeVisible();
      // the menu's sound row arrives a moment after it opens; measure it settled
      await expect(menu.locator('[data-testid="card-sound"]')).toBeVisible({ timeout: 5_000 });
      // ...and re-placed for it: that row makes the menu taller, and the menu
      // follows on the next frame. A menu that never settles fails here.
      await expect
        .poll(async () => (await measure(w)).coversButton, { timeout: 3_000 })
        .toBe(false);
      const m = await measure(w);
      seen.push(m);
      const where = `card ${i}: ${JSON.stringify(m)}`;
      expect(m.entries, where).toBeGreaterThan(4);
      expect(m.inside, `the menu runs off the window — ${where}`).toBe(true);
      expect(m.coversButton, `the menu is over its own button — ${where}`).toBe(false);
      expect(m.blocked, `entries that cannot be clicked — ${where}`).toEqual([]);
      await w.keyboard.press('Escape');
      await expect(w.getByTestId('card-menu')).toHaveCount(0);
    }
    // THE SQUEEZE REALLY HAPPENED: on at least one card the old placement would
    // have run off the window. Without this the test passes on a window tall
    // enough for every menu to fit below, having tested nothing.
    expect(
      seen.some((m) => m.wouldOverflowBelow),
      `no card was short of room: ${JSON.stringify(seen)}`
    ).toBe(true);
  });

  test('the last entry of the menu really works from the bottom row', async () => {
    a = await launchApp({ seedFolder: tempProjectFolder(), env: DIRECT });
    const w = await squeezed(a);

    // the button LOWEST on the screen: the least room under it
    const lowest = await w.evaluate(() => {
      const all = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="card-menu-button"]'));
      const tops = all.map((el) => el.getBoundingClientRect().top);
      return tops.indexOf(Math.max(...tops));
    });
    await w.locator('[data-testid="card-menu-button"]').nth(lowest).click();
    const menu = w.getByTestId('card-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-testid="card-sound"]')).toBeVisible({ timeout: 5_000 });
    // Compact conversation: the last entry. A real click, with Playwright's own
    // check that nothing is in the way; choosing it shuts the menu.
    await menu.locator('button').last().click({ timeout: 5_000 });
    await expect(w.getByTestId('card-menu')).toHaveCount(0);
  });
});
