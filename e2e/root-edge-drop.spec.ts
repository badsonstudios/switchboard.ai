// Dragging a stacked session to the side of the workspace gives it a full-height
// column of its own (#731), in the real app, with a real mouse.
//
// Measured before the fix (dockview 7.0.2): the full-height drop existed, but
// only within about 8px of the workspace's edge; from 12px in, the nearest
// card's own "split me" target won, and the session landed back inside the
// stack. This pins the widened zone:
//
//   * 30px in from the left or right edge, the marker is the FULL HEIGHT of the
//     workspace, and dropping there makes a full-height column;
//   * further in (past the zone), the card's own split is still what you get;
//   * along the TOP edge the zone is still narrow, so a tab dropped on another
//     card's row of tabs still docks there (e2e/tab-strip-drop.spec.ts is the
//     pin for that; this file checks the marker).
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

interface Group {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** every card's box, by the session on its tab */
async function groups(w: Page): Promise<Group[]> {
  return w.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.dv-groupview')).map((g) => {
      const r = g.getBoundingClientRect();
      return {
        id: g.querySelector<HTMLElement>('.identity-tab')?.getAttribute('data-last-prompt-for') ?? '',
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    })
  );
}

const dockBox = async (w: Page) => (await w.locator('.dv-dockview').first().boundingBox())!;
const tabOf = (w: Page, id: string) => w.locator(`.dv-tab:has(.identity-tab[data-last-prompt-for="${id}"])`);

/** the drop marker on screen right now: its box, or null */
async function marker(w: Page): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return w.evaluate(() => {
    const el = Array.from(document.querySelectorAll<HTMLElement>('.dv-drop-target-selection')).find(
      (z) => z.getBoundingClientRect().width > 0
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  });
}

async function pickUp(w: Page, id: string): Promise<void> {
  const b = (await tabOf(w, id).boundingBox())!;
  await w.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await w.mouse.down();
  await w.mouse.move(b.x + b.width / 2 + 8, b.y + b.height / 2 + 6, { steps: 3 });
}

async function carryTo(w: Page, x: number, y: number): Promise<void> {
  await w.mouse.move(x, y, { steps: 12 });
  await w.mouse.move(x + 1, y, { steps: 2 });
  await w.waitForTimeout(200);
}

/** three sessions: two stacked on one side, one full-height on the other */
async function stackedPlusOne(a: LaunchedApp): Promise<{ w: Page; top: Group; bottom: Group; lone: Group }> {
  const w = a.window;
  await expect(w.getByPlaceholder(/Prompt this session/).first()).toBeVisible({ timeout: 25_000 });
  await addSession(a);
  await addSession(a);
  await w.locator('[data-layout-preset="columns2"]').click();
  await expect.poll(async () => (await groups(w)).length, { timeout: 10_000 }).toBe(2);
  // the column holding two tabs: split it by dropping its second tab on its own lower half
  const twoTabs = await w.evaluate(() => {
    const g = Array.from(document.querySelectorAll<HTMLElement>('.dv-groupview')).find(
      (x) => x.querySelectorAll('.identity-tab').length === 2
    )!;
    const r = g.getBoundingClientRect();
    return {
      second: g.querySelectorAll<HTMLElement>('.identity-tab')[1].getAttribute('data-last-prompt-for')!,
      x: r.left + r.width / 2,
      y: r.bottom - 80,
    };
  });
  await pickUp(w, twoTabs.second);
  await carryTo(w, twoTabs.x, twoTabs.y);
  await w.mouse.up();
  await expect.poll(async () => (await groups(w)).length, { timeout: 10_000 }).toBe(3);
  const g = await groups(w);
  const dock = await dockBox(w);
  const lone = g.find((x) => x.h > dock.height * 0.8)!;
  const stack = g.filter((x) => x !== lone).sort((p, q) => p.y - q.y);
  expect(stack, JSON.stringify(g)).toHaveLength(2);
  return { w, top: stack[0], bottom: stack[1], lone };
}

test.describe('drag a stacked session to the side for a full-height column (#731)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.close();
  });

  test('30px in from the left edge: a full-height marker, and a full-height column on the drop', async () => {
    a = await launchApp({ seedFolder: tempProjectFolder(), env: DIRECT });
    const { w, top, bottom, lone } = await stackedPlusOne(a);
    const dock = await dockBox(w);
    const midY = dock.y + dock.height / 2;

    await pickUp(w, bottom.id);
    // THE CASE THAT FAILED: 30px in. Before the fix this was already the
    // nearest card's own split, never the workspace's edge.
    await carryTo(w, dock.x + 30, midY);
    const m = await marker(w);
    expect(m, 'no drop marker 30px in from the left edge').not.toBeNull();
    // the whole height of the workspace, hard against its left edge
    expect(m!.h, JSON.stringify({ m, dock })).toBeGreaterThan(dock.height * 0.95);
    expect(Math.abs(m!.x - dock.x), JSON.stringify({ m, dock })).toBeLessThanOrEqual(2);
    // and wide enough to read as a column, not a sliver
    expect(m!.w, JSON.stringify({ m, dock })).toBeGreaterThan(dock.width * 0.2);
    await w.mouse.up();

    // the dragged session now has the far-left column, top to bottom
    await expect
      .poll(async () => {
        const g = (await groups(w)).find((x) => x.id === bottom.id);
        return g ? g.h > dock.height * 0.95 && Math.abs(g.x - dock.x) <= 2 : false;
      }, { timeout: 5_000 })
      .toBe(true);
    // nothing was lost or doubled: the same three sessions, one card each
    expect((await groups(w)).map((x) => x.id).sort()).toEqual([top.id, bottom.id, lone.id].sort());
  });

  test('the right edge does the same', async () => {
    a = await launchApp({ seedFolder: tempProjectFolder(), env: DIRECT });
    const { w, top } = await stackedPlusOne(a);
    const dock = await dockBox(w);
    const midY = dock.y + dock.height / 2;

    await pickUp(w, top.id);
    await carryTo(w, dock.x + dock.width - 30, midY);
    const m = await marker(w);
    expect(m, 'no drop marker 30px in from the right edge').not.toBeNull();
    expect(m!.h, JSON.stringify({ m, dock })).toBeGreaterThan(dock.height * 0.95);
    expect(Math.abs(m!.x + m!.w - (dock.x + dock.width)), JSON.stringify({ m, dock })).toBeLessThanOrEqual(2);
    await w.mouse.up();
    await expect
      .poll(async () => {
        const g = (await groups(w)).find((x) => x.id === top.id);
        return g ? g.h > dock.height * 0.95 && Math.abs(g.x + g.w - (dock.x + dock.width)) <= 2 : false;
      }, { timeout: 5_000 })
      .toBe(true);
  });

  test('further in, a card’s own split is still offered; and the top edge zone is still narrow', async () => {
    a = await launchApp({ seedFolder: tempProjectFolder(), env: DIRECT });
    const { w, bottom, lone } = await stackedPlusOne(a);
    const dock = await dockBox(w);

    await pickUp(w, bottom.id);
    // well inside the full-height card, toward its outer side: THAT card's
    // split, which is that card's height and starts below its row of tabs
    const outerX = lone.x < dock.x + dock.width / 2 ? lone.x + 110 : lone.x + lone.w - 110;
    await carryTo(w, outerX, dock.y + dock.height / 2);
    const inner = await marker(w);
    expect(inner, 'no marker inside the card').not.toBeNull();
    expect(inner!.y, JSON.stringify({ inner, dock })).toBeGreaterThan(dock.y + 20);

    // 17px below the top edge, over a row of tabs: the row's own marker, NOT
    // the workspace's top edge (which would be the full width of the workspace)
    await carryTo(w, dock.x + dock.width / 2 + 60, dock.y + 17);
    const top = await marker(w);
    expect(top, 'no marker over a row of tabs').not.toBeNull();
    expect(top!.w, JSON.stringify({ top, dock })).toBeLessThan(dock.width * 0.9);

    // THE SAME CORNER RULE FOR THE SIDES (found in review): 25px in from the
    // left edge but OVER the left-hand card's row of tabs is that row's own
    // drop ("before the first tab"), not a full-height column
    await carryTo(w, dock.x + 25, dock.y + 17);
    const corner = await marker(w);
    expect(corner, 'no marker over the first tab').not.toBeNull();
    expect(corner!.h, JSON.stringify({ corner, dock })).toBeLessThan(dock.height * 0.5);
    // 4px below the top edge: the workspace's top edge still exists
    await carryTo(w, dock.x + dock.width / 2 + 60, dock.y + 4);
    const edge = await marker(w);
    expect(edge, 'no marker at the very top edge').not.toBeNull();
    expect(edge!.w, JSON.stringify({ edge, dock })).toBeGreaterThan(dock.width * 0.9);
    // let go somewhere harmless: on its own tab, which changes nothing
    const home = (await tabOf(w, bottom.id).boundingBox())!;
    await carryTo(w, home.x + home.width / 2, home.y + home.height / 2);
    await w.mouse.up();
    // and nothing moved: still three cards
    expect(await groups(w)).toHaveLength(3);
  });
});
