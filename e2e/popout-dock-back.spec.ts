// #558 — where a card coming home from a popout lands.
//
// THE OWNER'S REPRO, verbatim: pop session A out; from inside that window
// create session C (#531's affordance); dock A back; then dock C back — and C
// "lands in A's original grid slot, not anywhere it belongs".
//
// WHY A SINGLE-GROUP TEST CANNOT SEE THIS, which is worth stating because the
// first probe written for this issue passed and proved nothing: with one grid
// group every card is a tab in it, so "the wrong slot" has nowhere to be wrong.
// The layout has to have two docked groups before the question exists at all,
// which is why this file uses `split.spec.ts`'s persisted-layout recipe.
//
// WHAT WAS MEASURED, before the fix (two groups, A left / B right):
//
//   pop A out     -> A's group survives as an invisible 1px HUSK, which is
//                    dockview's dock-back placeholder (`_doAddPopoutGroup`
//                    calls `itemToPopout.api.setVisible(false)`)
//   dock A back   -> A joins B's group, ABANDONING its own half of the screen
//   dock C back   -> C is handed the husk by dockview's window-close path and
//                    takes that half — a card born in the popout, which never
//                    had a slot in the grid at all
//
// The cause is that the husk was treated as anonymous. Nothing asked whose slot
// it was, so the one card with no claim to it got it. Every card now remembers
// its own grid slot (`presentation.home`), and `dockBackTarget` asks: A goes to
// the slot it left, and C — with no slot to name — goes wherever a brand new
// session would (`sessionCardHome`, #462/#501). C then arrives as a tab beside
// the card that owns that half rather than instead of it.
//
// THE WINDOW-CLOSE PATH IS DELIBERATELY UNTOUCHED, and this file is where the
// reason is worth repeating because it is what a future attempt will trip on
// (it already cost one, #564): the last card out cannot `moveTo` its home,
// because dockview's `_doMoveGroupOrPanel` destroys the emptied popout group —
// and with it the OS window, and with THAT every event listener on the card's
// adopted DOM — before it re-opens the panel at the destination. The card comes
// home rendering perfectly and answering nothing. So the aliveness assertions
// below are not decoration: they are the guard rail on the tempting version of
// this fix.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import {
  LaunchedApp,
  launchApp,
  skipPopoutOnLinux,
  tempProjectFolder,
  readWorkspaceFile,
  writeWorkspaceFile,
  persistedLayout,
  gridLeafViews,
} from './fixtures/app';

const tabs = (w: Page) => w.locator('.dv-tabs-container .dv-tab');

async function popoutWindow(a: LaunchedApp): Promise<Page> {
  await expect.poll(() => a.app.windows().length, { timeout: 15_000 }).toBe(2);
  const popout = a.app.windows().find((p) => p !== a.window)!;
  await popout.waitForLoadState('domcontentloaded');
  return popout;
}

async function answerFolderDialog(a: LaunchedApp, dir: string): Promise<void> {
  await a.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [folder] });
  }, dir);
}

/** every grid group's width and the cards in it — the shape the bug shows in */
const groups = (w: Page) =>
  w.evaluate(() =>
    [...document.querySelectorAll('.dv-groupview')].map((g) => ({
      width: Math.round(g.getBoundingClientRect().width),
      cards: [...g.querySelectorAll('.dv-tab')].map((t) =>
        (t.textContent ?? '').trim().replace(/[·✕]/g, '')
      ),
    }))
  );

/** the ⤢ / ⤡ of ONE card — several are on screen once the grid is split */
const popButton = (w: Page, name: string, title: string) =>
  w
    .locator('.dv-groupview')
    .filter({ has: w.locator('.dv-tab', { hasText: name }) })
    .getByTitle(title);

/** two docked groups, one card in each — the owner's shape, from the blob */
async function twoGroups(): Promise<{ a: LaunchedApp; nameA: string; nameB: string }> {
  const folderA = tempProjectFolder();
  const folderB = tempProjectFolder();
  const nameA = path.basename(folderA);
  const nameB = path.basename(folderB);
  const first = await launchApp({ seedFolder: folderA });
  await expect(first.window.getByText(nameA).first()).toBeVisible({ timeout: 25_000 });
  await answerFolderDialog(first, folderB);
  await first.window.getByRole('button', { name: '+ session' }).click();
  await expect(first.window.locator('nav').getByText(nameB).first()).toBeVisible({ timeout: 25_000 });
  await first.window.waitForTimeout(1_500);
  await first.close();

  const ws = readWorkspaceFile(first.home);
  const lay = persistedLayout(ws);
  const views = gridLeafViews(lay.grid.root.data[0]);
  expect(views.length, 'need two panels to split').toBeGreaterThan(1);
  const half = Math.floor(lay.grid.width / 2);
  lay.grid.root.data = [
    { type: 'leaf', data: { views: views.slice(0, 1), activeView: views[0], id: '1' }, size: half },
    { type: 'leaf', data: { views: views.slice(1), activeView: views[1], id: '2' }, size: half },
  ];
  writeWorkspaceFile(first.home, ws);

  const a = await launchApp({ home: first.home });
  await expect(a.window.locator('.dv-groupview')).toHaveCount(2, { timeout: 25_000 });
  await a.window.waitForTimeout(1_200);
  return { a, nameA, nameB };
}

test.describe('docking back from a popout (#558)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  // THE OWNER'S REPRO, in his order. Red against main on the A assertion (A
  // joins B's group) and on the C one (C then takes the half A abandoned).
  test('a popout-born card does not inherit the opener’s grid slot', async () => {
    skipPopoutOnLinux();
    test.setTimeout(240_000);
    const g = await twoGroups();
    a = g.a;
    const w = a.window;
    expect(await groups(w), 'the fixture must give two real slots').toHaveLength(2);

    await w.locator('.dv-tab', { hasText: g.nameA }).first().click();
    await popButton(w, g.nameA, 'Pop out into its own window').click();
    const popout = await popoutWindow(a);
    await expect(tabs(popout)).toHaveCount(1, { timeout: 15_000 });

    // ...and a card BORN in that window (#531) — the one with no grid slot
    const folderC = tempProjectFolder();
    const nameC = path.basename(folderC);
    await answerFolderDialog(a, folderC);
    await popout.getByTestId('card-new-session').click();
    await expect(tabs(popout)).toHaveCount(2, { timeout: 25_000 });

    // dock the ORIGINAL back first, exactly as the report does
    await popout.locator('.dv-tab', { hasText: g.nameA }).first().click();
    await popout.getByTitle('Pop back into the main window').click();
    await expect(tabs(popout)).toHaveCount(1, { timeout: 25_000 });
    await w.waitForTimeout(1_500);

    // A IS BACK IN ITS OWN SLOT. The owner called this step "fine" and it was
    // not: A abandoned its own group for whichever one happened to be visible,
    // and that is what left the slot lying around for C to inherit.
    const mid = await groups(w);
    const homeAgain = mid.find((grp) => grp.cards.some((c) => c.includes(g.nameA)));
    expect(homeAgain, `${g.nameA} did not come home`).toBeDefined();
    expect(
      homeAgain!.cards.some((c) => c.includes(g.nameB)),
      `${g.nameA} came home into ${g.nameB}'s group instead of its own slot`,
    ).toBe(false);

    // ...and now the survivor, which is where it went wrong
    await popout.getByTitle('Pop back into the main window').click();
    await expect.poll(() => a!.app.windows().length, { timeout: 25_000 }).toBe(1);
    await w.waitForTimeout(2_000);

    const after = await groups(w);
    // C is HERE, in the main window, and it is a tab beside other cards rather
    // than sitting alone in the slot its opener left behind.
    const mine = after.find((grp) => grp.cards.some((c) => c.includes(nameC)));
    expect(mine, `${nameC} is not in the grid at all`).toBeDefined();
    expect(
      mine!.cards.length,
      'the popout-born card took a whole group of its own — the opener’s slot',
    ).toBeGreaterThan(1);
    // A kept its slot through all of it: in the grid exactly once, still not
    // sharing with B
    expect(after.flatMap((grp) => grp.cards).filter((c) => c.includes(g.nameA))).toHaveLength(1);
    // ...and no 1px husk was left on screen for the user to squint at
    for (const grp of after) {
      expect(grp.width, 'a dead sliver of a group is still in the layout').toBeGreaterThan(40);
    }
    // NOTHING CAME HOME DEAD. See the header: the tempting version of this fix
    // moves the last card out of the window itself, which tears the document
    // down under the card's own DOM. A suspended card says so in as many words.
    await expect(w.getByRole('button', { name: 'Resume' })).toHaveCount(0);
  });

  test('...and the same holds when the survivor docks back first', async () => {
    skipPopoutOnLinux();
    test.setTimeout(240_000);
    const g = await twoGroups();
    a = g.a;
    const w = a.window;

    await w.locator('.dv-tab', { hasText: g.nameA }).first().click();
    await popButton(w, g.nameA, 'Pop out into its own window').click();
    const popout = await popoutWindow(a);
    await expect(tabs(popout)).toHaveCount(1, { timeout: 15_000 });

    const folderC = tempProjectFolder();
    const nameC = path.basename(folderC);
    await answerFolderDialog(a, folderC);
    await popout.getByTestId('card-new-session').click();
    await expect(tabs(popout)).toHaveCount(2, { timeout: 25_000 });

    // THE REVERSE ORDER: the popout-born card comes home while its opener is
    // still out there, so the opener's slot is still occupied-but-empty. This
    // is the case that pins "a card that never lived in the grid docks back via
    // the standard placement rules" on its own — C is CHOOSING, not inheriting,
    // and the hidden husk one click away is the wrong answer it must not give.
    await popout.locator('.dv-tab', { hasText: nameC }).first().click();
    await popout.getByTitle('Pop back into the main window').click();
    await expect(tabs(popout)).toHaveCount(1, { timeout: 25_000 });
    await w.waitForTimeout(1_500);
    const mid = await groups(w);
    const cGroup = mid.find((grp) => grp.cards.some((c) => c.includes(nameC)));
    expect(cGroup, `${nameC} did not come home`).toBeDefined();
    expect(cGroup!.cards.length, 'the popout-born card claimed a slot of its own').toBeGreaterThan(1);

    // ...then the opener, which is now alone in its window
    await popout.getByTitle('Pop back into the main window').click();
    await expect.poll(() => a!.app.windows().length, { timeout: 25_000 }).toBe(1);
    await w.waitForTimeout(2_000);
    const after = await groups(w);
    expect(after.flatMap((grp) => grp.cards).filter((c) => c.includes(g.nameA))).toHaveLength(1);
    // A's own slot, again — this time handed back by dockview's window-close
    // path, which for the card that MADE the window is the same answer
    const homeAgain = after.find((grp) => grp.cards.some((c) => c.includes(g.nameA)));
    expect(
      homeAgain!.cards.some((c) => c.includes(nameC)),
      `${nameC} was still sitting in ${g.nameA}'s slot when it came home`,
    ).toBe(false);
    for (const grp of after) {
      expect(grp.width, 'a dead sliver of a group is still in the layout').toBeGreaterThan(40);
    }
    await expect(w.getByRole('button', { name: 'Resume' })).toHaveCount(0);
  });

  test('a lone card popped out and docked straight back returns where it was', async () => {
    // The owner's step 1, which already worked — kept so that the fix above
    // cannot quietly cost the ordinary case.
    skipPopoutOnLinux();
    test.setTimeout(240_000);
    const g = await twoGroups();
    a = g.a;
    const w = a.window;
    const before = await groups(w);
    expect(before).toHaveLength(2);

    await w.locator('.dv-tab', { hasText: g.nameA }).first().click();
    await popButton(w, g.nameA, 'Pop out into its own window').click();
    const popout = await popoutWindow(a);
    await expect(tabs(popout)).toHaveCount(1, { timeout: 15_000 });

    await popout.getByTitle('Pop back into the main window').click();
    await expect.poll(() => a!.app.windows().length, { timeout: 25_000 }).toBe(1);
    await w.waitForTimeout(2_000);

    // it is back in the grid, once, in its own slot, and nothing is left as a
    // sliver
    const after = await groups(w);
    expect(after.flatMap((grp) => grp.cards).filter((c) => c.includes(g.nameA))).toHaveLength(1);
    const homeAgain = after.find((grp) => grp.cards.some((c) => c.includes(g.nameA)));
    expect(homeAgain!.cards.some((c) => c.includes(g.nameB))).toBe(false);
    for (const grp of after) {
      expect(grp.width).toBeGreaterThan(40);
    }
    // ALIVE, not suspended. The ordinary round trip is the thing this fix must
    // not cost; `session.spec.ts` proves it the expensive way, by typing into
    // the terminal, and this is the cheap sentinel inside the file that would
    // break it.
    await expect(w.getByRole('button', { name: 'Resume' })).toHaveCount(0);
  });
});
