import { test, expect, Locator, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, showTerminal, tempProjectFolder } from './fixtures/app';

// Pop-out tests open a real SECOND OS window (window.open -> BrowserWindow).
// That is reliable on Windows + macOS but flaky under the headless xvfb display
// used on Linux CI (second-window creation intermittently never completes), so
// we skip the window-count assertions there. Coverage is preserved on the two
// platforms where multi-window works — including Windows, Dan's primary target.
const POPOUT_FLAKY_HERE = process.platform === 'linux';
const skipPopoutOnLinux = (): void =>
  test.skip(POPOUT_FLAKY_HERE, 'dockview popout opens a 2nd OS window — unreliable under headless xvfb; covered on Windows + macOS');

/**
 * Every sessions call main refuses, driven straight at the bridge (#347).
 *
 * A FREE FUNCTION on purpose: the specs below destructure the Playwright page as
 * `window`, which shadows the renderer's own `window` inside an `evaluate` body —
 * the code still runs against the real one, but it typechecks against `Page` and
 * reads like a mistake. Out here nothing is shadowed.
 */
async function sessionsRefusals(
  page: Page,
  missingFolder: string
): Promise<{
  // The bridge's OWN types, so the `| null` this issue added has to still be
  // there for this to compile — `unknown` would let it be removed silently.
  noArgs: Awaited<ReturnType<typeof window.switchboard.sessions.create>>;
  missingFolder: Awaited<ReturnType<typeof window.switchboard.sessions.create>>;
  renameGhost: Awaited<ReturnType<typeof window.switchboard.sessions.rename>>;
  renameBadTitle: Awaited<ReturnType<typeof window.switchboard.sessions.rename>>;
  before: number;
  after: number;
}> {
  return page.evaluate(async (gone) => {
    const api = window.switchboard;
    const before = (await api.sessions.cards()).length;
    return {
      // no cardId and no folder at all — the first of the two old throws
      noArgs: await api.sessions.create(
        {} as unknown as { cardId: string; folder: string; title: string }
      ),
      // a folder that is not there — the reachable one
      missingFolder: await api.sessions.create({ cardId: 'probe-347', folder: gone, title: 'probe' }),
      // and the channel with no caller at all: an unknown live id used to reach
      // `mustGet`, a non-string title used to reach `title.trim()`
      renameGhost: await api.sessions.rename('no-such-session-347', 'x'),
      renameBadTitle: await api.sessions.rename('no-such-session-347', 42 as unknown as string),
      before,
      after: (await api.sessions.cards()).length,
    };
  }, missingFolder);
}

test.describe('a session card', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('spawns with a live terminal and the usage strip (E3-02 / E7-01)', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const { window } = a;

    // the card appears (tab shows the folder name)
    await expect(window.getByText(name).first()).toBeVisible({ timeout: 25_000 });
    // usage strip is present from the start (zeros until real activity)
    await expect(window.getByText('↑ 0').first()).toBeVisible({ timeout: 15_000 });

    // #358, riding this launch: the card's live region is in the DOM from the
    // start and EMPTY. This is the load-bearing half of that fix and the half
    // the two overlay assertions below cannot see — a live region INSERTED
    // already holding its text is announced by almost nothing, so the only way
    // "Session ended" / "Session didn't start" / "Session suspended" reach a
    // screen reader is by landing inside a region that was already there.
    // PROVEN: give the region the `{said && …}` guard that any reviewer would
    // call a harmless tidy-up — so it mounts WITH its words, like the overlay
    // used to — and this assertion is the only one in the file that goes red.
    await expect(window.getByTestId('card-announcer')).toBeEmpty();

    // Session is the default view; the Terminal is hidden until shown (E10-01)
    await showTerminal(window);
    // the terminal is a REAL pty (fake provider spawns the OS shell): typing a
    // command produces output — proves input -> pty -> render end to end
    await window.locator('.xterm-screen').first().click();
    await window.keyboard.type('echo E2E_MARKER_123');
    await window.keyboard.press('Enter');
    await expect(window.getByText(/E2E_MARKER_123/).first()).toBeVisible({ timeout: 15_000 });

    // #347, riding this launch rather than paying for another: a sessions call
    // main REFUSES comes back as an answer, not as a rejection nobody is
    // listening for.
    //
    // Driving the bridge directly is the point of this probe. The one refusal an
    // everyday gesture reaches — a card whose folder has been deleted, renamed
    // or unplugged — arrives at the same handler with the same input, and the
    // card's spawn effect has always caught, so the SCREEN is not what changed.
    // What changed is the contract, and the caller who needs it is the one not
    // written yet: a palette command that starts a session, a §5.23
    // contribution, or the first caller of `sessions:rename`, which has none at
    // all. `pageerror` is what witnesses it — an unhandled promise rejection in
    // the renderer surfaces there — so put the throws back in
    // `main/sessions/ipc.ts` and this block goes red on `evaluate` itself.
    //
    // NOTE for whoever extends this: do NOT add a global `unhandledrejection`
    // handler to the renderer to quiet something down. It would swallow exactly
    // what this and `e2e/groups.spec.ts` watch for and leave both vacuous
    // (flagged in #326's hand-off).
    const rejections: string[] = [];
    window.on('pageerror', (e) => rejections.push(e.message));
    const refused = await sessionsRefusals(window, path.join(folder, 'a-folder-that-was-deleted'));

    expect(refused.noArgs).toBeNull();
    expect(refused.missingFolder).toBeNull();
    expect(refused.renameGhost).toBeNull();
    expect(refused.renameBadTitle).toBeNull();
    // four refusals and no new card: nothing was half-started
    expect(refused.after).toBe(refused.before);
    // ...and zero rejections, which is the property the issue asked for
    expect(rejections).toEqual([]);
  });

  test('says a session did NOT start, rather than that it ended (#355)', async () => {
    // The one refusal an everyday gesture reaches, driven the way a user reaches
    // it: a card whose folder is not there. `sessions:create` answers `null`
    // (#347), the spawn effect paints the overlay — and that overlay used to
    // read "Session ended — Exited unexpectedly (code -1)", which is three false
    // claims and an invented exit code about a session that never ran.
    //
    // A seeded card is the honest reproduction: the folder is gone BEFORE the
    // card mounts, exactly as it is for a restored card whose folder was renamed
    // between two launches. Deleting a folder out from under a LIVE session
    // would not work here anyway — on Windows the session's own cwd holds it.
    const gone = path.join(tempProjectFolder(), 'a-folder-that-was-deleted');
    a = await launchApp({ seedFolder: gone });
    const { window } = a;

    // scoped to the PANEL (#358). The card's live region now carries the same
    // words for the screen reader, so a bare `getByText` here matches two
    // elements — the sr-only one is 1×1 and clipped, which Playwright still
    // counts as visible, so `visible: true` does not separate them either.
    const overlay = window.getByTestId('card-overlay');
    await expect(overlay.getByText("Session didn't start")).toBeVisible({ timeout: 25_000 });
    await expect(window.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(overlay.getByText(/renamed, deleted, or be on a drive/)).toBeVisible();
    // ...and NOT the copy that belongs to a session which ran and died. Point
    // `endedCopy` back at the old keys and these two go red. Deliberately NOT
    // scoped: the announcement must not say it either.
    await expect(window.getByText('Session ended')).toHaveCount(0);
    await expect(window.getByText(/Exited unexpectedly/)).toHaveCount(0);
    // the card is still recoverable rather than a dead end
    await expect(window.getByRole('button', { name: 'Close' })).toBeVisible();

    // #358: and the panel is not silent. The same words are in the card's live
    // region, which is what a screen-reader user who is not sitting on this
    // card actually hears — the region was empty until the refusal landed in
    // it. It names the session first, so several cards do not all announce an
    // anonymous "Session didn't start".
    const announcer = window.getByTestId('card-announcer');
    await expect(announcer).toContainText("Session didn't start");
    await expect(announcer).toContainText(/renamed, deleted, or be on a drive/);
    await expect(announcer).toContainText(path.basename(gone));
  });

  test('pops out into a second OS window (E8-01)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { app, window } = a;

    await expect(window.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    expect(app.windows().length).toBe(1);

    await window.getByTitle('Pop out into its own window').click();
    // dockview opens a real second OS window (the file:// blocker fix)
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
  });

  test('the tab ✕ closes the card and ends the session (eyeball fix)', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const { window } = a;
    await expect(window.getByText(name).first()).toBeVisible({ timeout: 25_000 });
    // ✕ CONFIRMS before ending a session (Dan 2026-07-22): declining keeps it
    window.once('dialog', (d) => void d.dismiss());
    await window.getByTitle('Close (ends the session)').click();
    await expect(window.getByTitle('Close (ends the session)')).toBeVisible();
    // accepting closes: card gone from the grid AND the record forgotten
    window.once('dialog', (d) => void d.accept());
    await window.getByTitle('Close (ends the session)').click();
    await expect(window.getByTitle('Close (ends the session)')).toHaveCount(0, { timeout: 15_000 });
    await expect(window.locator('nav').getByText(name)).toHaveCount(0);
    await expect(window.locator('nav').getByText('No sessions yet')).toBeVisible();
  });

  test('appears in the rail with a status dot', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const { window } = a;
    // rail lists the session (card-keyed view, E7-05)
    const rail = window.locator('nav');
    await expect(rail.getByText(name).first()).toBeVisible({ timeout: 25_000 });
  });

  const boundsOf = (appl: LaunchedApp['app']) =>
    appl.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getBounds()));

  test('a popped-out window restores at its saved SCREEN POSITION after relaunch (E8-02/E8-04)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder }); // shared handle first (#16)
    const first = a;
    await expect(first.window.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await first.window.getByTitle('Pop out into its own window').click();
    await expect.poll(() => first.app.windows().length, { timeout: 15_000 }).toBe(2);
    await first.window.waitForTimeout(1200); // let the layout (with popout bounds) persist
    const before = (await boundsOf(first.app))[1]; // main is [0], popout [1]
    await first.close();

    // launch 2: same home — the popout must reopen at ~the same screen spot, not
    // cascade to a default (the multi-monitor bug: window.open features were
    // dropped). Assert POSITION, which the old count-only test never did.
    a = await launchApp({ home: first.home });
    await expect.poll(() => a.app.windows().length, { timeout: 25_000 }).toBe(2);
    await a.window.waitForTimeout(800);
    const after = (await boundsOf(a.app))[1];
    expect(Math.abs(after.x - before.x)).toBeLessThan(60);
    expect(Math.abs(after.y - before.y)).toBeLessThan(60);
  });

  test('the pop-out button toggles a card back in, alive (E8-04)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const { app, window } = a;
    await expect(window.getByText(name).first()).toBeVisible({ timeout: 25_000 });
    await window.getByTitle('Pop out into its own window').click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
    const popout = app.windows().find((w) => w !== window)!;
    // click the SAME control in the popped-out window to dock it back IN
    await popout.getByTitle('Pop back into the main window').click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
    // docked back ALIVE (button toggle, not a window-close): the terminal types
    await showTerminal(window); // Terminal hidden by default (E10-01)
    await expect(window.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
    await window.locator('.xterm-screen').first().click();
    await window.keyboard.type('echo TOGGLE_OK_789');
    await window.keyboard.press('Enter');
    await expect(window.getByText(/TOGGLE_OK_789/).first()).toBeVisible({ timeout: 15_000 });
  });

  test('closing a popout OS window suspends the session (E8-04)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const { app, window } = a;
    await expect(window.getByText(name).first()).toBeVisible({ timeout: 25_000 });
    await window.getByTitle('Pop out into its own window').click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
    const popout = app.windows().find((w) => w !== window)!;
    // user closes the OS window (X) -> the card docks back SUSPENDED, not alive
    await popout.evaluate(() => window.close());
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
    // the suspended affordance shows; Resume brings the session/terminal back
    // (scoped to the panel — see the note in the never-started test above)
    await expect(
      window.getByTestId('card-overlay').getByText('Session suspended')
    ).toBeVisible({ timeout: 15_000 });
    // #358 audited this overlay too: it was as silent as the ended one. The
    // card's live region is in the main window's DOM before the words are, so
    // the suspension is reported rather than merely drawn.
    await expect(window.getByTestId('card-announcer')).toContainText('Session suspended');
    await window.getByRole('button', { name: 'Resume' }).click();
    await showTerminal(window); // Terminal hidden by default (E10-01)
    await expect(window.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
  });

  test('a new session opens in the main window, not the active popout (E8-04)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    const folder2 = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { app, window } = a;
    await expect(window.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await window.getByTitle('Pop out into its own window').click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
    // stub the native folder picker so "+ session" resolves to folder2
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] });
    }, folder2);
    await window.getByRole('button', { name: '+ session' }).click();
    // the new card must appear in the MAIN window even though a popout was active
    await expect(window.getByText(path.basename(folder2)).first()).toBeVisible({ timeout: 20_000 });
  });

  test('strip is Session·Changes·History·Terminal, Terminal LAST and always present (2026-07-22)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { window } = a;
    await expect(window.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await expect(window.getByRole('tab', { name: 'Session', exact: true })).toBeVisible();
    await expect(window.getByRole('tab', { name: 'Changes' })).toBeVisible();
    await expect(window.getByText('History', { exact: true })).toBeVisible(); // "soon" tab
    await expect(window.getByRole('tab', { name: 'Terminal' })).toBeVisible();
    // switching Terminal -> Changes -> Terminal leaves it usable
    await window.getByRole('tab', { name: 'Terminal' }).click();
    await expect(window.locator('.xterm-screen').first()).toBeVisible({ timeout: 10_000 });
    await window.getByRole('tab', { name: 'Changes' }).click();
    await window.getByRole('tab', { name: 'Terminal' }).click();
    await expect(window.locator('.xterm-screen').first()).toBeVisible({ timeout: 10_000 });
  });

  // #250. The header read dockview's `props.api.title`, and dockview is told a
  // panel's title once, at `addPanel` — nothing in the tree ever calls
  // `setTitle`. So the rail renamed, the record renamed, and the card went on
  // announcing the name it was born with. The header now reads the session
  // store, which is where the rename actually lands.
  const cardHeaderIn = (p: Page): Locator => p.getByTestId('card-header').filter({ visible: true });

  /** rename the one session from the rail, the way a user does */
  async function renameFromRail(w: Page, to: string): Promise<void> {
    await w.locator('nav .rail-row').first().dblclick();
    const field = w.locator('nav .rail-row input');
    await expect(field).toBeVisible();
    await field.fill(to);
    await field.press('Enter');
  }

  test('the card header follows a rename from the rail (#250)', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const header = cardHeaderIn(w);
    await expect(header.getByText(name, { exact: true })).toBeVisible({ timeout: 25_000 });

    await renameFromRail(w, 'renamed-card');

    await expect(header.getByText('renamed-card', { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(header.getByText(name, { exact: true })).toHaveCount(0);
  });

  // A popout has no rail and no tab strip, so its header is the ONLY thing in
  // the window that says which session it is — and the rename it has to follow
  // arrives from a different OS window. dockview ADOPTS the group's DOM rather
  // than re-rendering it, so this is really asserting nothing about the header
  // depended on living in the main window.
  test('a popped-out card header follows a rename too (#250)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const { app } = a;
    const w = a.window;
    await expect(w.getByText(name).first()).toBeVisible({ timeout: 25_000 });

    await w.getByTitle('Pop out into its own window').click();
    // by URL, not by "the other one": devtools or a rescued window would both
    // satisfy `!== window` and neither hosts a session
    await expect
      .poll(() => app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 15_000,
      })
      .toBe(1);
    const popout = app.windows().find((p) => p.url().includes('popout.html'))!;
    await popout.waitForLoadState('domcontentloaded');
    const header = cardHeaderIn(popout);
    await expect(header.getByText(name, { exact: true })).toBeVisible({ timeout: 15_000 });

    await renameFromRail(w, 'popped-and-renamed');
    await expect(header.getByText('popped-and-renamed', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    // the adopted DOM must not end up carrying BOTH names
    await expect(header.getByText(name, { exact: true })).toHaveCount(0);

    // hand the second OS window back before teardown rather than leaving it to
    // the tree-kill: a live popout has outlived cleanup on CI before
    await popout.evaluate(() => window.close());
  });

  // #294, both halves in one launch — they are the same sentence read from
  // either end. The rail used to commit an empty draft (main only length-caps,
  // so `''` was a legal title), and the header's name span used to be `nowrap`
  // with no floor, so the OTHER thing a title can be — 120 characters — grew
  // the header past its card and carried the status pill and the window buttons
  // off the end with it.
  test('a name cannot be erased, and a pathological one clips instead of the controls (#294)', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const header = cardHeaderIn(w);
    const row = w.locator('nav .rail-row').first();
    await expect(header.getByText(name, { exact: true })).toBeVisible({ timeout: 25_000 });
    await expect(row).toContainText(name, { timeout: 15_000 });

    // erasing it commits nothing: the edit ends and the name stands, in the
    // rail row as well as the header — the row is the one place you would go
    // to put a name back, and it renders the raw title
    await renameFromRail(w, '');
    await expect(w.locator('nav .rail-row input')).toHaveCount(0);
    await expect(row).toContainText(name);
    await expect(header.getByText(name, { exact: true })).toBeVisible();

    // 120 chars with no space in it: main's cap, and the worst case for a row
    // that wants to break at one
    const long = 'W'.repeat(120);
    await renameFromRail(w, long);
    const nameSpan = header.getByTestId('card-header-name');
    await expect(nameSpan).toHaveText(long, { timeout: 10_000 });

    // the name is what gave way...
    expect(await nameSpan.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // ...and the row still fits inside its own card
    expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

    // the controls that were being pushed off are still inside the header box
    const box = (await header.boundingBox())!;
    for (const control of [
      header.getByTestId('card-collapse'),
      header.getByTitle('Pop out into its own window'),
    ]) {
      await expect(control).toBeVisible();
      const c = (await control.boundingBox())!;
      expect(c.x).toBeGreaterThanOrEqual(box.x);
      expect(c.x + c.width).toBeLessThanOrEqual(box.x + box.width + 1);
    }
  });
});
