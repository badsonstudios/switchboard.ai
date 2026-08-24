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
//                    dockview's dock-back placeholder. We pop out a PANEL, but
//                    `_doAddPopoutGroup` re-dispatches a panel that is alone in
//                    its group as a whole-GROUP popout, and that branch is the
//                    one that calls `referenceGroup.api.setVisible(false)`
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

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
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

  test('a card still knows its slot after a quit and relaunch', async () => {
    // THE ONE THING THE OTHER THREE CANNOT SEE. A card's home is a record, and
    // the app can be quit with the card still out in its window — so the record
    // has to survive in the ui blob and come back meaning the same thing. It is
    // also the case a layout RESTORE could quietly break: dockview reopens a
    // saved popout on a timer, and until that timer fires the restored group
    // reports itself as a grid group holding the card (#494 measured exactly
    // that window), which is a plausible-looking grid slot that is not one.
    //
    // Driven through the COMPANY branch on purpose — a lone card is handed home
    // by dockview's own reference and would pass this whatever the record said.
    skipPopoutOnLinux();
    test.setTimeout(240_000);
    const g = await twoGroups();
    a = g.a;

    await a.window.locator('.dv-tab', { hasText: g.nameA }).first().click();
    await popButton(a.window, g.nameA, 'Pop out into its own window').click();
    const popout = await popoutWindow(a);
    await expect(tabs(popout)).toHaveCount(1, { timeout: 15_000 });
    const folderC = tempProjectFolder();
    const nameC = path.basename(folderC);
    await answerFolderDialog(a, folderC);
    await popout.getByTestId('card-new-session').click();
    await expect(tabs(popout)).toHaveCount(2, { timeout: 25_000 });
    await a.window.waitForTimeout(1_500); // let the layout + the record persist

    const home = a.home;
    await a.close();
    a = undefined;

    // relaunch: the popout comes back with BOTH cards in it
    a = await launchApp({ home });
    const w = a.window;
    await expect.poll(() => a!.app.windows().length, { timeout: 25_000 }).toBe(2);
    const popout2 = a.app.windows().find((pg) => pg !== w)!;
    await popout2.waitForLoadState('domcontentloaded');
    await expect(tabs(popout2)).toHaveCount(2, { timeout: 25_000 });
    await w.waitForTimeout(1_500);

    // ...and A still goes back to ITS half, not into B's tabs
    await popout2.locator('.dv-tab', { hasText: g.nameA }).first().click();
    await popout2.getByTitle('Pop back into the main window').click();
    await expect(tabs(popout2)).toHaveCount(1, { timeout: 25_000 });
    await w.waitForTimeout(2_000);

    const after = await groups(w);
    const homeAgain = after.find((grp) => grp.cards.some((c) => c.includes(g.nameA)));
    expect(homeAgain, `${g.nameA} did not come home`).toBeDefined();
    expect(
      homeAgain!.cards.some((c) => c.includes(g.nameB)),
      `${g.nameA} forgot its slot across the relaunch and joined ${g.nameB}`,
    ).toBe(false);
    expect(homeAgain!.cards.some((c) => c.includes(nameC))).toBe(false);
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

// ── THE WINDOW-EMPTYING PATHS DOCKVIEW DRIVES (#656, #657) ──────────────────
//
// Everything above is the ⤡ WITH COMPANY, which moves the panel itself. These
// are the returns dockview performs from inside its own teardown — the lone ⤡
// and the OS close — where all we get to do is correct the placement
// afterwards. Same wrong answer in both, because they are the same dockview
// code path: `disposePopoutWindow` hands every survivor to the ONE reference
// the window was opened with.
//
// THE SETUP IS THE PART THAT MATTERS. #558's tests dock the opener back first,
// which leaves it standing in that slot, so the survivor lands beside it and
// the bug is invisible. Here the opener's card is CLOSED instead: the reference
// still points at its old half of the screen, that half is now empty, and the
// card with no claim to it is the only one left holding the window.
test.describe('a popout window emptied the other ways (#657)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  /**
   * A window holding ONLY a popout-born card, whose reference names an empty
   * slot. Returns the survivor's name and the popout page.
   */
  async function orphanedSurvivor(): Promise<{
    g: Awaited<ReturnType<typeof twoGroups>>;
    popout: Page;
    nameC: string;
  }> {
    const g = await twoGroups();
    a = g.a;
    const w = a.window;
    await w.locator('.dv-tab', { hasText: g.nameA }).first().click();
    await popButton(w, g.nameA, 'Pop out into its own window').click();
    const popout = await popoutWindow(a);
    await expect(tabs(popout)).toHaveCount(1, { timeout: 15_000 });

    // ...and a card BORN in that window (#531): no grid slot, ever
    const folderC = tempProjectFolder();
    const nameC = path.basename(folderC);
    await answerFolderDialog(a, folderC);
    await popout.getByTestId('card-new-session').click();
    await expect(tabs(popout)).toHaveCount(2, { timeout: 25_000 });

    // close the OPENER's card from the rail, which is one of the ways #657
    // lists for a window to end up with somebody else's reference on it
    w.once('dialog', (d) => void d.accept());
    await w
      .locator('nav')
      .locator('[draggable="true"]', { hasText: g.nameA })
      .first()
      .getByTitle('Close session')
      .click();
    await expect(tabs(popout)).toHaveCount(1, { timeout: 25_000 });
    await w.waitForTimeout(1_500);
    return { g, popout, nameC };
  }

  /** the assertions both paths share: the survivor did not take the slot */
  async function assertNotInTheOpenersSlot(w: Page, nameC: string, nameB: string): Promise<void> {
    const after = await groups(w);
    const mine = after.find((grp) => grp.cards.some((c) => c.includes(nameC)));
    expect(mine, `${nameC} is not in the grid at all`).toBeDefined();
    // beside the card that owns a slot, not instead of the card that lost one
    expect(
      mine!.cards.length,
      'the popout-born card took the whole slot its opener left behind',
    ).toBeGreaterThan(1);
    expect(mine!.cards.some((c) => c.includes(nameB))).toBe(true);
    // ...and the abandoned half went with it, rather than staying as a sliver
    for (const grp of after) {
      expect(grp.width, 'a dead sliver of a group is still in the layout').toBeGreaterThan(40);
    }
  }

  test('the LONE ⤡ places the survivor, and keeps it alive', async () => {
    skipPopoutOnLinux();
    test.setTimeout(240_000);
    const { g, popout, nameC } = await orphanedSurvivor();
    const w = g.a.window;

    await popout.getByTitle('Pop back into the main window').click();
    await expect.poll(() => g.a.app.windows().length, { timeout: 25_000 }).toBe(1);
    await w.waitForTimeout(2_000);

    await assertNotInTheOpenersSlot(w, nameC, g.nameB);
    // ⤡ MEANS "BRING THIS CARD HOME", so the session is still running. The
    // correction is a grid→grid move made after the panel is safely back; the
    // tempting version, moving the last panel out of the popout group, tears
    // the card's own document down under it (#564).
    await expect(w.getByRole('button', { name: 'Resume' })).toHaveCount(0);
  });

  test('the OS close places the survivor, and still suspends it', async () => {
    skipPopoutOnLinux();
    test.setTimeout(240_000);
    const { g, popout, nameC } = await orphanedSurvivor();
    const w = g.a.window;

    // the window's own close, not our button — `window.close()` in the popout's
    // realm is what a taskbar close does from dockview's point of view
    await popout.evaluate(() => window.close());
    await expect.poll(() => g.a.app.windows().length, { timeout: 25_000 }).toBe(1);
    await w.waitForTimeout(2_000);

    await assertNotInTheOpenersSlot(w, nameC, g.nameB);
    // E8-04's other half, which the placement fix must not have cost: closing
    // the WINDOW suspends the session. The card and its record stay; the
    // session comes back when it is next asked for.
    await w.locator('.dv-tab', { hasText: nameC }).first().click();
    await expect(w.getByRole('button', { name: 'Resume' })).toBeVisible({ timeout: 25_000 });
  });
});

// ── DOCKING BACK ALONE MUST NOT COST THE SESSION ITS GROUP (#656) ───────────
//
// One user gesture, ⤡, meant two different things for a session's PERSISTENT
// group depending on whether its window had company: with company (#558) the
// move is ours and is flagged, while alone dockview returned the card into its
// own empty husk with nothing flagged at all. E12-04 would read that as the
// user dropping the card among strangers, find no group-mate in an empty group,
// and write `setSessionGroup(cardId, null)` — the group erased outright, with
// nothing on screen to say so.
//
// #656 SAID THAT HAPPENS; IT DOES NOT, AND THIS TEST IS WHY IT IS STILL HERE.
// Measured against unfixed `main` (2026-08-21): the adoption handler never runs
// on this path at all, because dockview's `openPanel` calls
// `updateParentGroup` — which fires `onDidGroupChange` — BEFORE `doAddPanel`
// registers the panel in its new group (`dockviewGroupPanelModel.js`, "ensure
// the group is updated before we fire any events"). So the handler's own
// `containerApi.getPanel(id)` answers `undefined` and it returns. The group
// survived by accident, one layer down, in code that has nothing to do with
// popouts.
//
// So this is a GUARD, not a repro: it green on main and it must stay green. The
// fix makes the same outcome deliberate — the lone ⤡ arms the same `setMoving`
// the company branch does — and that matters the day the adoption handler is
// repaired (see the hand-off's out-of-scope findings), because on that day this
// path is exactly the one that would start erasing groups.
test.describe('docking back alone keeps the persistent group (#656)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  test('a grouped session survives a lone pop-out round trip', async () => {
    skipPopoutOnLinux();
    test.setTimeout(240_000);
    const folder = tempProjectFolder();
    const app = await launchApp({ seedFolder: folder });
    a = app;
    const w = app.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // a real persistent group with one session in it (the E12-03 door)
    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();
    const dir = tempProjectFolder();
    const member = path.basename(dir);
    await answerFolderDialog(app, dir);
    await w.getByTitle('New session in this group').click();
    await expect(w.locator('nav').getByText(member).first()).toBeVisible({ timeout: 25_000 });

    const groupOf = async (title: string): Promise<string | null> => {
      const cards = (await w.evaluate(() => window.switchboard.sessions.cards())) as Array<{
        title: string;
        groupId?: string | null;
      }>;
      return cards.find((c) => c.title === title)?.groupId ?? null;
    };
    const before = await groupOf(member);
    expect(before, 'the fixture must actually be in a group').toBeTruthy();

    // THE MEMBER HAS TO BE ALONE IN ITS DOCK GROUP, which is what makes the
    // slot it leaves a HUSK and the group it comes home to EMPTY — the exact
    // shape E12-04 mis-read as "the user dropped this card among strangers".
    // Hiding the neighbour is the cheapest way there; it keeps running.
    await w.locator('.dv-tab', { hasText: path.basename(folder) }).first().click();
    await w.keyboard.press(`${MOD}+Shift+P`);
    await w.getByPlaceholder('Type a command or a session name…').fill('Hide session');
    await w.keyboard.press('Enter');
    await expect(tabs(w)).toHaveCount(1, { timeout: 15_000 });

    // out into a window of its own, and straight back — the LONE branch, which
    // is dockview's window-close return and not a move of ours
    await w.locator('.dv-tab', { hasText: member }).first().click();
    await popButton(w, member, 'Pop out into its own window').click();
    const popout = await popoutWindow(app);
    await expect(tabs(popout)).toHaveCount(1, { timeout: 15_000 });
    await popout.getByTitle('Pop back into the main window').click();
    await expect.poll(() => app.app.windows().length, { timeout: 25_000 }).toBe(1);
    await w.waitForTimeout(2_000);

    expect(await groupOf(member), 'the lone dock-back erased the session’s group').toBe(before);
    // ...and it is a card again, alive, in its own slot rather than a sliver
    await expect(w.locator('.dv-tab', { hasText: member })).toHaveCount(1);
    await expect(w.getByRole('button', { name: 'Resume' })).toHaveCount(0);
    for (const grp of await groups(w)) {
      expect(grp.width, 'a dead sliver of a group is still in the layout').toBeGreaterThan(40);
    }
  });
});
