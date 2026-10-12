// PROBE (#702). When a session's tab is dragged into another dockview group in
// the grid, does it take on that group's persistent group?
//
// E12-04 says it does ("membership follows the panel when the user drags it
// between dockview groups"). #702 says the handler that does it "looks dead":
// dockview fires `onDidGroupChange` before the panel is registered in its new
// group, so the handler's own `getPanel(id)` finds nothing and returns.
//
// That was read off dockview's source while fixing something else, and never
// run. This runs it, with a real mouse, on each way a card can change dockview
// group:
//
//   DRAG IN    an ungrouped session's tab dropped on a grouped session's tab;
//   DRAG OUT   a grouped session's tab dropped back beside an ungrouped one;
//   MOVE API   the "stack with the tabbed sessions" command, which moves a
//              card with dockview's own `moveTo` (and which E9-05 says must
//              NOT adopt).
//
// What is read is the app's own record (`sessions.cards()`), not the picture.
//
// ⚠️ Parked under `spike/probes/702/`; copy into `e2e/` to run it:
//   npx playwright test e2e/grid-drag-adoption.spec.ts
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

const tabOf = (w: Page, cardId: string) => w.locator(`.dv-tab:has(.identity-tab[data-last-prompt-for="${cardId}"])`);

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
  await w.waitForTimeout(800);
}

interface Card {
  cardId: string;
  title: string;
  groupId?: string | null;
}
const cards = (w: Page): Promise<Card[]> => w.evaluate(() => window.switchboard.sessions.cards()) as Promise<Card[]>;

/**
 * What the adoption handler did since the last call, read off counters that
 * `PROBE_INSTRUMENTED=1` expects in the build (`.claude/work_files/
 * 702-instrument.py` adds them to `SessionGrid.tsx`; they are never
 * committed). Without them this reports zeros, and the probe still says
 * whether the group changed.
 */
async function handler(w: Page, label: string): Promise<void> {
  const seen = await w.evaluate(() => {
    const store = window as unknown as { __p702?: Array<Record<string, unknown>> };
    const all = store.__p702 ?? [];
    store.__p702 = [];
    return all;
  });
  const events = seen.filter((e) => e.at === 'event');
  const ran = seen.filter((e) => e.at === 'handler');
  console.log(
    `PROBE HANDLER ${label}: ${JSON.stringify({
      eventsFired: events.length,
      panelRegisteredWhenItFired: events.filter((e) => e.panelRegistered).length,
      skippedByAGuard: events.filter((e) => e.tearing || e.restoring || e.moving).length,
      handlerRan: ran.length,
      handlerFoundThePanel: ran.filter((e) => e.panelFound).length,
      reachedADecision: seen.filter((e) => e.at === 'decided').length,
    })}`
  );
}

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
async function palette(w: Page, title: string): Promise<void> {
  await w.keyboard.press(`${MOD}+Shift+P`);
  await w.getByPlaceholder('Type a command or a session name…').fill(title);
  await w.keyboard.press('Enter');
  await w.waitForTimeout(900);
}

test.describe('PROBE #702: does a grid drag adopt the destination’s group?', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('measure', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    const loose = path.basename(folder);
    await expect(w.getByPlaceholder(/Prompt this session/).first()).toBeVisible({ timeout: 25_000 });

    // a persistent group with one session opened inside it
    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();
    const dir = tempProjectFolder();
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, dir);
    await w.getByTitle('New session in this group').click();
    const member = path.basename(dir);
    await expect(w.locator('.dv-tab .identity-tab')).toHaveCount(2, { timeout: 25_000 });

    // each in a column of its own
    await w.locator('[data-layout-preset="columns2"]').click();
    await expect.poll(async () => (await dockGroups(w)).length, { timeout: 10_000 }).toBe(2);

    await handler(w, 'SETUP (two sessions opened, then the two-column preset)');
    let all = await cards(w);
    const looseCard = all.find((c) => c.title === loose)!;
    const memberCard = all.find((c) => c.title === member)!;
    const group = memberCard.groupId;
    console.log(`PROBE start: ${JSON.stringify({ loose: looseCard.groupId ?? null, member: group ?? null, dock: await dockGroups(w) })}`);
    expect(group, 'the fixture must actually be in a group').toBeTruthy();
    expect(looseCard.groupId ?? null).toBeNull();

    // ── DRAG IN: the ungrouped tab onto the grouped session's tab ───────────
    let box = (await tabOf(w, memberCard.cardId).boundingBox())!;
    await dragTab(w, looseCard.cardId, { x: box.x + box.width * 0.8, y: box.y + box.height / 2 });
    all = await cards(w);
    const afterIn = all.find((c) => c.cardId === looseCard.cardId)!.groupId ?? null;
    console.log(
      `PROBE DRAG-IN: ${JSON.stringify({ dock: await dockGroups(w), looseGroupIdNow: afterIn, adopted: afterIn === group })}`
    );

    await handler(w, 'DRAG-IN');

    // ── DRAG OUT: back to a column of its own (the right edge of the grid) ──
    const grid = (await w.locator('.dv-dockview').first().boundingBox())!;
    await dragTab(w, looseCard.cardId, { x: grid.x + grid.width - 12, y: grid.y + grid.height / 2 });
    all = await cards(w);
    const afterOut = all.find((c) => c.cardId === looseCard.cardId)!.groupId ?? null;
    console.log(`PROBE DRAG-OUT: ${JSON.stringify({ dock: await dockGroups(w), looseGroupIdNow: afterOut })}`);

    await handler(w, 'DRAG-OUT (to the right edge)');

    // ── SPLIT: dropped on the right side of the group's own content ─────────
    const content = (await w.locator('.dv-groupview .dv-content-container').first().boundingBox())!;
    await dragTab(w, looseCard.cardId, { x: content.x + content.width * 0.93, y: content.y + content.height / 2 });
    all = await cards(w);
    console.log(
      `PROBE SPLIT: ${JSON.stringify({
        dock: await dockGroups(w),
        loose: all.find((c) => c.cardId === looseCard.cardId)!.groupId ?? null,
        member: all.find((c) => c.cardId === memberCard.cardId)!.groupId ?? null,
      })}`
    );
    await handler(w, 'SPLIT');

    // ── the GROUPED one dragged onto the loose one: would adoption ERASE it? ─
    if ((await dockGroups(w)).length === 2) {
      const box2 = (await tabOf(w, looseCard.cardId).boundingBox())!;
      await dragTab(w, memberCard.cardId, { x: box2.x + box2.width * 0.8, y: box2.y + box2.height / 2 });
      all = await cards(w);
      console.log(
        `PROBE MEMBER-ONTO-LOOSE: ${JSON.stringify({
          dock: await dockGroups(w),
          member: all.find((c) => c.cardId === memberCard.cardId)!.groupId ?? null,
          loose: all.find((c) => c.cardId === looseCard.cardId)!.groupId ?? null,
        })}`
      );
      await handler(w, 'MEMBER-ONTO-LOOSE');
    }

    // ── MOVE API: the ladder's own moves (which must NOT adopt, E9-05) ──────
    await w.locator('.dv-tab').first().click();
    await palette(w, 'Stack session with the tabbed sessions');
    await handler(w, 'MOVE API: stack with the tabbed sessions');
    await palette(w, 'Expand session to its full card');
    await handler(w, 'MOVE API: expand to its full card');

    // ── POPOUT and back (Windows and macOS: no second window under xvfb) ────
    if (process.platform !== 'linux') {
      await palette(w, 'Pop out / dock in session');
      await w.waitForTimeout(1500);
      await handler(w, 'POP OUT');
      await palette(w, 'Pop out / dock in session');
      await w.waitForTimeout(1500);
      await handler(w, 'DOCK BACK IN');
    }
    all = await cards(w);
    console.log(
      `PROBE END: ${JSON.stringify({
        member: all.find((c) => c.cardId === memberCard.cardId)!.groupId ?? null,
        loose: all.find((c) => c.cardId === looseCard.cardId)!.groupId ?? null,
      })}`
    );
  });
});
