// Dragging a session's tab around the grid moves the CARD and leaves its
// GROUP alone (#702).
//
// E12-04 was meant to make a grid drag change the session's persistent group
// ("membership follows the panel"). The listener that was to do it never ran:
// dockview fires the event it listened to before it registers the panel, so
// the listener's own lookup found nothing. Measured in the real app with a
// real mouse on every way a card changes dockview group, the panel was there
// 0 times out of 5 (`spike/findings/702-grid-drag-adoption.md`). A session's
// group has only ever been changed from the Sessions list.
//
// The listener was REMOVED, not repaired: repaired, dropping a grouped
// session's tab beside ungrouped ones would have erased its group, on a
// gesture people make all day to arrange their screen. So this pins the
// behaviour that was always there, and would fail the day somebody "repairs"
// it without meaning to change what a drag does:
//
//   * an UNGROUPED session dragged in beside a grouped one stays ungrouped;
//   * a GROUPED session dragged in beside an ungrouped one keeps its group;
//   * splitting a card off into a column of its own changes nobody's group.
//
// The drags are real mouse drags, the same helper `tab-strip-drop.spec.ts`
// uses, and what is read is the app's own record of each session.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

const tabOf = (w: Page, cardId: string) => w.locator(`.dv-tab:has(.identity-tab[data-last-prompt-for="${cardId}"])`);

/** every dockview group, left to right: the card ids on its tabs, in order */
async function dockGroups(w: Page): Promise<string[][]> {
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

async function dragTab(w: Page, cardId: string, to: { x: number; y: number }): Promise<void> {
  const from = (await tabOf(w, cardId).boundingBox())!;
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await w.mouse.move(start.x, start.y);
  await w.mouse.down();
  await w.mouse.move(start.x + 8, start.y + 5, { steps: 3 });
  await w.mouse.move((start.x + to.x) / 2, (start.y + to.y) / 2, { steps: 8 });
  await w.mouse.move(to.x, to.y, { steps: 10 });
  await w.mouse.move(to.x + 1, to.y, { steps: 2 });
  await w.waitForTimeout(200);
  await w.mouse.up();
  // long enough for a write that should NOT happen to have happened
  await w.waitForTimeout(800);
}

interface Card {
  cardId: string;
  title: string;
  groupId?: string | null;
}
const groupOf = async (w: Page, cardId: string): Promise<string | null> => {
  const all = (await w.evaluate(() => window.switchboard.sessions.cards())) as Card[];
  return all.find((c) => c.cardId === cardId)?.groupId ?? null;
};

test.describe('a drag in the grid does not change a session’s group (#702)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('ungrouped stays ungrouped, grouped stays grouped, and a split changes nobody', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    const looseTitle = path.basename(folder);
    await expect(w.getByPlaceholder(/^Message .+…$/).first()).toBeVisible({ timeout: 25_000 });

    // a persistent group, with one session opened inside it
    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();
    const dir = tempProjectFolder();
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, dir);
    await w.getByTitle('New session in this group').click();
    await expect(w.locator('.dv-tab .identity-tab')).toHaveCount(2, { timeout: 25_000 });

    // each in a column of its own
    await w.locator('[data-layout-preset="columns2"]').click();
    await expect.poll(async () => (await dockGroups(w)).length, { timeout: 10_000 }).toBe(2);

    const all = (await w.evaluate(() => window.switchboard.sessions.cards())) as Card[];
    const loose = all.find((c) => c.title === looseTitle)!.cardId;
    const member = all.find((c) => c.title === path.basename(dir))!.cardId;
    const group = await groupOf(w, member);
    expect(group, 'the fixture must actually be in a group').toBeTruthy();
    expect(await groupOf(w, loose)).toBeNull();

    // ── THE UNGROUPED ONE, DROPPED IN BESIDE THE GROUPED ONE ────────────────
    let box = (await tabOf(w, member).boundingBox())!;
    await dragTab(w, loose, { x: box.x + box.width * 0.8, y: box.y + box.height / 2 });
    // it really did move: one dockview group now holds both tabs
    let dock = await dockGroups(w);
    expect(dock.find((tabs) => tabs.includes(member)), JSON.stringify(dock)).toContain(loose);
    // ...and it is still in no group, and its neighbour still in its own
    expect(await groupOf(w, loose)).toBeNull();
    expect(await groupOf(w, member)).toBe(group);

    // ── SPLIT IT OFF AGAIN, into a column of its own ────────────────────────
    const content = (await w.locator('.dv-groupview .dv-content-container').first().boundingBox())!;
    await dragTab(w, loose, { x: content.x + content.width * 0.93, y: content.y + content.height / 2 });
    await expect.poll(async () => (await dockGroups(w)).length, { timeout: 10_000 }).toBe(2);
    expect(await groupOf(w, loose)).toBeNull();
    expect(await groupOf(w, member)).toBe(group);

    // ── THE GROUPED ONE, DROPPED IN BESIDE THE UNGROUPED ONE ────────────────
    // (the case a repaired listener would have got destructively wrong: its
    // neighbour has no group, so it would have adopted "none")
    box = (await tabOf(w, loose).boundingBox())!;
    await dragTab(w, member, { x: box.x + box.width * 0.8, y: box.y + box.height / 2 });
    dock = await dockGroups(w);
    expect(dock.find((tabs) => tabs.includes(loose)), JSON.stringify(dock)).toContain(member);
    expect(await groupOf(w, member)).toBe(group);
    expect(await groupOf(w, loose)).toBeNull();

    // ...and the Sessions list still shows the group with its one member
    await expect(w.getByText('New group')).toBeVisible();
    await expect(w.getByText('empty', { exact: true })).toHaveCount(0);
  });
});
