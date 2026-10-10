// Dropping a session's tab on another group's tab strip docks it there (#620).
//
// The ticket was filed when this did not work. Measured on 2026-10-09 against
// the docking library the app now ships (dockview 7.0.2), it does, with no code
// of ours: the library makes every tab and the empty part of every strip a drop
// target. Nothing in the app tested it, so nothing would have noticed it break
// again on the next upgrade. This is that test, driven with a real mouse:
//
//   * drop on the LEFT half of a tab  -> the dragged tab lands BEFORE it;
//   * drop on the RIGHT half of a tab -> it lands AFTER it;
//   * drop on the empty part of a strip -> it is appended at the end;
//   * while the pointer is over a tab, an indicator is drawn on the half that
//     will take the drop, and it is painted (not transparent).
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

async function addSession(a: LaunchedApp): Promise<string> {
  const dir = tempProjectFolder();
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
  const before = await a.window.locator('.dv-tab .identity-tab').count();
  await a.window.getByRole('button', { name: '+ session' }).click();
  await expect(a.window.locator('.dv-tab .identity-tab')).toHaveCount(before + 1, { timeout: 25_000 });
  return path.basename(dir);
}

/** every group, left to right: the session names on its tabs, in order */
async function groups(w: Page): Promise<string[][]> {
  return w.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.dv-groupview'))
      .map((g) => ({
        left: g.getBoundingClientRect().left,
        tabs: Array.from(g.querySelectorAll<HTMLElement>('.dv-tab .identity-tab')).map(
          (t) => t.getAttribute('data-last-prompt-for') ?? ''
        ),
      }))
      .sort((p, q) => p.left - q.left)
      .map((g) => g.tabs)
  );
}

/** the tab of a card, by the card id the tab carries */
const tabOf = (w: Page, cardId: string) => w.locator(`.dv-tab:has(.identity-tab[data-last-prompt-for="${cardId}"])`);

interface Indicator {
  left: number;
  width: number;
  painted: boolean;
}

/** pick a tab up, carry it to a point, report the drop indicator there, and let go */
async function dragTab(
  w: Page,
  cardId: string,
  to: { x: number; y: number }
): Promise<Indicator | null> {
  const from = (await tabOf(w, cardId).boundingBox())!;
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await w.mouse.move(start.x, start.y);
  await w.mouse.down();
  await w.mouse.move(start.x + 8, start.y + 5, { steps: 3 });
  await w.mouse.move((start.x + to.x) / 2, (start.y + to.y) / 2, { steps: 8 });
  await w.mouse.move(to.x, to.y, { steps: 10 });
  await w.mouse.move(to.x + 1, to.y, { steps: 2 });
  await w.waitForTimeout(200);
  const indicator = await w.evaluate(() => {
    const el = Array.from(document.querySelectorAll<HTMLElement>('.dv-drop-target-selection')).find(
      (z) => z.getBoundingClientRect().width > 0
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const bg = getComputedStyle(el).backgroundColor;
    const alpha = /rgba\(.*,\s*([\d.]+)\)/.exec(bg);
    return {
      left: Math.round(r.left),
      width: Math.round(r.width),
      painted: bg !== 'transparent' && (!alpha || Number(alpha[1]) > 0.05),
    };
  });
  if (process.env.SWITCHBOARD_KEEP_SHOT) await w.screenshot({ path: process.env.SWITCHBOARD_KEEP_SHOT });
  await w.mouse.up();
  await w.waitForTimeout(350);
  return indicator;
}

test.describe('drop a tab on another group’s tab strip (#620)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.close();
  });

  test('on a tab’s right half it lands after it, on its left half before it, on the empty strip at the end', async () => {
    a = await launchApp({ seedFolder: tempProjectFolder(), env: DIRECT });
    const w = a.window;
    await expect(w.getByPlaceholder(/Prompt this session/).first()).toBeVisible({ timeout: 25_000 });
    await addSession(a);
    await addSession(a);
    // three sessions, each in a column of its own
    await w.locator('[data-layout-preset="columns3"]').click();
    await expect.poll(async () => (await groups(w)).length, { timeout: 10_000 }).toBe(3);
    let g = await groups(w);
    // the first column's first tab is the target; the others are dragged onto its strip
    const target = g[0][0];
    const lone = g.filter((tabs, i) => i > 0 && tabs.length === 1).map((tabs) => tabs[0]);
    expect(lone.length, JSON.stringify(g)).toBeGreaterThanOrEqual(2);
    const [first, second] = lone;

    // RIGHT half of the target tab: AFTER it
    let box = (await tabOf(w, target).boundingBox())!;
    const after = await dragTab(w, first, { x: box.x + box.width * 0.8, y: box.y + box.height / 2 });
    g = await groups(w);
    const home = g.find((tabs) => tabs.includes(target))!;
    expect(home, JSON.stringify(g)).toContain(first);
    expect(home.indexOf(first), JSON.stringify(g)).toBe(home.indexOf(target) + 1);
    // the indicator was on the tab's right half, and it was painted
    expect(after, 'no drop indicator over the tab').not.toBeNull();
    expect(after!.painted).toBe(true);
    expect(after!.left).toBeGreaterThan(box.x + box.width * 0.3);

    // LEFT half of the target tab: BEFORE it
    box = (await tabOf(w, target).boundingBox())!;
    const before = await dragTab(w, second, { x: box.x + box.width * 0.2, y: box.y + box.height / 2 });
    g = await groups(w);
    const home2 = g.find((tabs) => tabs.includes(target))!;
    expect(home2, JSON.stringify(g)).toContain(second);
    expect(home2.indexOf(second), JSON.stringify(g)).toBe(home2.indexOf(target) - 1);
    expect(before, 'no drop indicator over the tab').not.toBeNull();
    expect(before!.left).toBeLessThan(box.x + box.width * 0.3);

    // no session was lost or duplicated on the way
    expect(g.flat().sort()).toEqual([...new Set(g.flat())].sort());
    expect(g.flat()).toHaveLength(3);
    // ...and all three now share one strip, in the order the drops asked for
    expect(g).toEqual([[second, target, first]]);
  });

  test('on the empty part of a strip it is appended, and the two groups become one', async () => {
    a = await launchApp({ seedFolder: tempProjectFolder(), env: DIRECT });
    const w = a.window;
    await expect(w.getByPlaceholder(/Prompt this session/).first()).toBeVisible({ timeout: 25_000 });
    await addSession(a);
    await w.locator('[data-layout-preset="columns2"]').click();
    await expect.poll(async () => (await groups(w)).length, { timeout: 10_000 }).toBe(2);
    const g = await groups(w);
    const [stay] = g[0];
    const [move] = g[1];

    const strip = (await w
      .locator('.dv-groupview')
      .filter({ has: w.locator(`.identity-tab[data-last-prompt-for="${stay}"]`) })
      .locator('.dv-tabs-and-actions-container')
      .boundingBox())!;
    await dragTab(w, move, { x: strip.x + strip.width - 50, y: strip.y + strip.height / 2 });
    await expect.poll(() => groups(w), { timeout: 5_000 }).toEqual([[stay, move]]);
  });
});
