import { test, expect, Locator, Page } from '@playwright/test';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  registeredPopouts,
  showTerminal,
  skipPopoutOnLinux,
  tempProjectFolder,
} from './fixtures/app';

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

/**
 * The live session id bound to the ONLY card in the grid, or undefined.
 *
 * A free function for the same reason `sessionsRefusals` is one: the specs
 * destructure the Playwright page as `window`, which shadows the renderer's own
 * `window` inside an `evaluate` body.
 *
 * Keyed on "the only card" rather than on a title: its caller seeds exactly one
 * session, and a card's title is not the folder name by contract — that is the
 * TAB's business, and a spec asserting a lifecycle fact should not fail the day
 * the two diverge. A caller with several cards wants a different helper, not a
 * title lookup bolted onto this one.
 */
async function soleCardLiveId(page: Page): Promise<string | undefined> {
  const cards = (await page.evaluate(() => window.switchboard.sessions.cards())) as Array<{
    liveId?: string;
  }>;
  return cards[0]?.liveId;
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
    // the card is still recoverable rather than a dead end.
    //
    // SCOPED TO THE OVERLAY since #687, and the reason is the feature: the card
    // now has a rail row, and that row's `✕` is titled "Close session" — which
    // an unscoped `{ name: 'Close' }` matches by substring, so this line hit a
    // strict-mode violation on two buttons the moment the row appeared. The
    // `getByText` four lines up was scoped for the same class of reason. It is
    // the OVERLAY's Close this assertion has always meant: the question is
    // whether the dead-end card offers a way out of itself.
    await expect(overlay.getByRole('button', { name: 'Close' })).toBeVisible();

    // ...AND THE ROW ITSELF (#687), which is the other half of "not a dead
    // end" and the only place a running app proves it. A card whose
    // `sessions:create` was refused has no record in main, so it was in no
    // session list at all — invisible to the rail, to Ctrl+1..9, to pinning,
    // and to the maximize sweep, which is built from rail order. The unit
    // suites pin the store join and the layout plan; this is the one assertion
    // made against a real window.
    await expect(window.locator('[data-rail-open]')).toHaveCount(1);

    // #358: and the panel is not silent. The same words are in the card's live
    // region, which is what a screen-reader user who is not sitting on this
    // card actually hears — the region was empty until the refusal landed in
    // it. It names the session first, so several cards do not all announce an
    // anonymous "Session didn't start".
    const announcer = window.getByTestId('card-announcer');
    await expect(announcer).toContainText("Session didn't start");
    await expect(announcer).toContainText(/renamed, deleted, or be on a drive/);
    await expect(announcer).toContainText(path.basename(gone));

    // #606: AND IT HAS A HEADER. This arm used to draw the panel above and
    // nothing else - the one card state in the app with no header at all, so
    // the double-click gesture §5.8 gives every session header had nowhere to
    // land on it, and the card read as a different kind of object from every
    // other card on screen. The parity header is the suspended one's subset
    // (#216): identity, one word, and no control that would act on a session
    // that is not running.
    const header = window.getByTestId('card-header');
    await expect(header).toBeVisible();
    await expect(header.getByTestId('card-header-name')).toHaveText(path.basename(gone));
    await expect(header.locator('.status-pill')).toHaveText('not started');
    // Try again and Close are the PANEL's, two centimetres below; a header copy
    // of them would be a second way to do the same thing on the smallest
    // surface the card has
    await expect(header.locator('button')).toHaveCount(0);

    // ...and the gesture the header exists for does not wake anything up. What
    // it CANNOT do here is rearrange the workspace, and that is deliberate and
    // older than this header: `lib/layout-mode`'s `heldMaximize` honours a
    // maximize only for a card the session list still holds, and a card whose
    // `sessions:create` was refused was never registered as one - it has no row
    // in the list either. Reported rather than patched (see #606's PR); the
    // promise being tested here is that the double-click has a target and is
    // harmless, not that a session-less card can take over the grid.
    await header.dblclick({ position: { x: 4, y: 4 } });
    await expect(overlay.getByText("Session didn't start")).toBeVisible();
    await expect(header).toBeVisible();
  });

  test('says a session ENDED, with the code the process really exited with (#366)', async () => {
    // The other half of #355's pair, and the half nothing covered end to end: a
    // session that genuinely RAN and then DIED. Every e2e assertion about the
    // "Session ended" panel arrived through the never-started path above, so
    // the real died flow — pty exit -> `sessions:exited` -> the overlay ->
    // #358's announcement — had no test at all, and the ONE number that tells
    // the two panels apart (a code off a real process, not the invented `-1`
    // #355 removed) was never read from anything that exited.
    //
    // THE KILL MECHANISM, and why it needs no test hook: under the fake
    // provider the session IS the OS shell in a real PTY (`main/providers/
    // fake.ts` — `cmd.exe` on Windows, `sh` elsewhere) and the Terminal tab is
    // that PTY's real surface. So this spec does exactly what the hand-test
    // step does — type `exit` at the prompt — and every step after the
    // keystroke is the product's: node-pty reports the status, `SessionManager`
    // calls it crashed because nobody asked for the kill, the renderer paints
    // what it was told. Nothing test-only is reachable here, in this launch or
    // any other.
    //
    // `exit 3` rather than a bare `exit` so the assertion names a number THIS
    // SPEC chose: a renderer that invents a code cannot invent 3 by accident,
    // and a clean 0 exit would take the other copy branch. `exit <n>` is the
    // same syntax in both shells.
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const { window } = a;

    await expect(window.getByText(name).first()).toBeVisible({ timeout: 25_000 });
    // the BEFORE state, and #358's precondition: a healthy card says nothing,
    // so the words asserted at the end arrive in a region that was already
    // there and empty — which is the only way a screen reader hears them
    const announcer = window.getByTestId('card-announcer');
    await expect(announcer).toBeEmpty();

    await showTerminal(window);
    await expect(window.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
    await window.locator('.xterm-screen').first().click();
    // Not a proof that the session ran — the surface ECHOES what is typed, so
    // this matches either way. It is a readiness gate: the keystrokes below
    // have to reach a PTY through a focused xterm, and this is the cheapest
    // evidence that they will. What proves the session ran is the exit STATUS
    // asserted below: only a live shell can be told `exit 3` and answer 3.
    await window.keyboard.type('echo E2E_ALIVE_366');
    await window.keyboard.press('Enter');
    await expect(window.getByText(/E2E_ALIVE_366/).first()).toBeVisible({ timeout: 15_000 });

    // Read the live id only now. The tab is drawn from the card before the
    // spawn has answered, so this is racy at the top of the test and settled
    // here — a shell rendering its own output is a session main knows about.
    const firstLiveId = await soleCardLiveId(window);
    expect(firstLiveId).toBeTruthy();

    // ...and now it DIES, from the keyboard, the way a user kills one
    await window.keyboard.type('exit 3');
    await window.keyboard.press('Enter');

    // scoped to the PANEL, like the never-started test above: the announcer
    // carries the same words and an sr-only element is 1×1 and clipped, which
    // Playwright still counts as visible
    const overlay = window.getByTestId('card-overlay');
    await expect(overlay.getByText('Session ended')).toBeVisible({ timeout: 25_000 });
    // THE assertion. 3 is what the shell was told to exit with, so this is red
    // for a renderer that makes a code up (`-1`), red for one that reports the
    // clean-exit copy for a nonzero status, and red if `crashed` stops being
    // derived from the code.
    await expect(overlay.getByText('Exited unexpectedly (code 3)')).toBeVisible();
    await expect(overlay.getByRole('button', { name: 'Restart' })).toBeVisible();
    await expect(overlay.getByRole('button', { name: 'Close' })).toBeVisible();
    // ...and never the other panel's words, nor the code that used to be
    // invented. Deliberately UNSCOPED (#358's rule): the announcement must not
    // say the wrong thing either.
    await expect(window.getByText("Session didn't start")).toHaveCount(0);
    await expect(window.getByText(/code -1/)).toHaveCount(0);

    // #358's live region, on the path it was written for and could not reach.
    // It names the session first, so with several cards up the user hears whose
    // session died. Same region asserted EMPTY at the top of this test — the
    // pair is the property, not either half.
    await expect(announcer).toContainText(name);
    await expect(announcer).toContainText('Session ended');
    await expect(announcer).toContainText('Exited unexpectedly (code 3)');

    // Restart is the panel's whole point and this is the only spec that can
    // press it on a session that actually died. Main does NOT reap a
    // self-exited session — the record and its binding survive precisely so
    // this button has something to replace — so the externally visible proof
    // that a NEW session spawned is the card's live id changing.
    await overlay.getByRole('button', { name: 'Restart' }).click();
    await expect(overlay).toHaveCount(0, { timeout: 25_000 });
    await expect
      .poll(
        async () => {
          const id = await soleCardLiveId(window);
          return Boolean(id) && id !== firstLiveId;
        },
        { timeout: 25_000 }
      )
      .toBe(true);
    // and the card is quiet again — the region empties when the panel goes,
    // rather than leaving a screen reader with a session that is alive and a
    // last-heard message saying it ended
    await expect(announcer).toBeEmpty();
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

  // #292. The test above is that same event arriving properly; this is it going
  // missing. `destroy()` is Electron's force-close — no close event, no
  // beforeunload — which is exactly what a window killed from the task bar or
  // lost with a crash looks like to dockview: nothing at all. Before this issue
  // the card was left in a popout group whose window was a corpse, so it was in
  // no window anywhere, and the only thing left to do with the session was close
  // it. It now takes the ordinary route home: the registry's liveness sweep
  // (#279) notices within a few seconds, and the card lands back in the grid
  // suspended — the same place the clean close above leaves it.
  test('a popout the OS kills brings its card home suspended, not into limbo (#292)', async () => {
    skipPopoutOnLinux();
    // the clean-close test's whole cost, plus the sweep's own interval before
    // anything can start happening. Declared rather than discovered as a red
    // build on a loaded CI runner.
    test.slow();
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const { app, window } = a;
    await expect(window.getByText(name).first()).toBeVisible({ timeout: 25_000 });
    await window.getByTitle('Pop out into its own window').click();
    await expect
      .poll(() => app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 15_000,
      })
      .toBe(1);
    // the card's DOM is ADOPTED into the popout, so it leaves the main window
    // entirely — this is the "before" half of the rescue assertion below
    await expect(window.getByTestId('card-header')).toHaveCount(0, { timeout: 15_000 });

    // kill it the way the OS does: no unload reaches the renderer, so dockview
    // is never told and only the sweep can find out
    const killed = await app.evaluate(({ BrowserWindow }) => {
      const popout = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes('popout.html')
      );
      if (!popout) return false;
      popout.destroy();
      return true;
    });
    expect(killed, 'no popout window found to kill').toBe(true);
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);

    // THE CARD IS BACK IN THE MAIN WINDOW, and suspended exactly as a clean
    // close leaves it. Generous timeout: the sweep runs on a several-second
    // interval by design (it is a janitor, not a watchdog), so noticing is
    // allowed to take a moment.
    await expect(window.getByTestId('card-overlay').getByText('Session suspended')).toBeVisible({
      timeout: 30_000,
    });
    // said out loud, not merely drawn — #358's live region, the same assertion
    // the clean close makes, because to the user this IS the clean close
    await expect(window.getByTestId('card-announcer')).toContainText('Session suspended');
    // the dead window is out of the SAVED layout as well as off the screen —
    // otherwise the next launch would faithfully reopen an empty popout
    await expect.poll(() => registeredPopouts(a), { timeout: 15_000 }).toBe(0);
    expect(app.windows().length, 'a window came back from the dead').toBe(1);
    // and it is a working card again, not a headstone
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
    // NB this assertion matches the RAIL ROW, and a rail row is drawn from the
    // session record — it says nothing about where the CARD went. That blind
    // spot is what #462 (below) exists for; both tests are kept because they
    // fail for different reasons.
    await closePopouts(a);
  });

  // ── #462: where a new card LANDS, measured ────────────────────────────────
  //
  // The two tests below are the E8-04 rule's second and third holes, both found
  // while fixing the viewer's mirror of it (#434/#461, #411/#460). They assert
  // GEOMETRY, and that is the whole lesson: popping a card out leaves its group
  // behind in the grid as a hidden dock-back shell, and a panel added to that
  // shell is on screen at a width nobody could use — measured here at 22.67px
  // for a card, 1.33px for a viewer — while `toBeVisible()` passes on both.
  // Width is what actually goes wrong, so width is what is asserted.

  /** the card whose header says `title`, in this window */
  const cardFor = (w: Page, title: string): Locator =>
    w.getByTestId('card-header').filter({ hasText: title });

  /**
   * On screen at a size a human could use it — MEASURED, not `toBeVisible`.
   *
   * The twin of `expectReadable` in `document-peek.spec.ts`, which caught the
   * same defect from the viewer's side. Polled, because reviving a hidden group
   * is a dockview re-layout: the box is allowed to arrive a frame after the
   * element does.
   */
  async function expectWideEnough(target: Locator, what: string): Promise<void> {
    await expect(target).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => (await target.boundingBox())?.width ?? 0, {
        timeout: 10_000,
        message: `${what} landed in a collapsed group`,
      })
      .toBeGreaterThan(100);
  }

  /**
   * Open `file` in a document viewer through §5.30's `Open file…` command.
   *
   * The palette rather than a Changes tab's ↗, because this file's fixtures are
   * plain folders: `Open file…` needs no git repo, and stubbing the native
   * dialog is the same trick the `+ session` tests already use for the folder
   * picker (main widens the read scope with whatever the dialog returns, so the
   * stub grants the file too).
   */
  async function openFileInViewer(launched: LaunchedApp, file: string): Promise<void> {
    await launched.app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] });
    }, file);
    const w = launched.window;
    await w.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+P`);
    await w.getByPlaceholder('Type a command or a session name…').fill('Open file');
    await w.keyboard.press('Enter');
    await expect(w.getByTestId('document-viewer')).toBeVisible({ timeout: 20_000 });
  }

  /** Hand every pop-out window back before teardown (popout e2e convention). */
  async function closePopouts(launched: LaunchedApp): Promise<void> {
    for (const p of launched.app.windows().filter((w) => w.url().includes('popout.html'))) {
      await p.evaluate(() => window.close()).catch(() => undefined);
    }
  }

  test('a new session lands in a group you can SEE, not the pop-out husk (#462)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    const folder2 = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { app, window } = a;
    await expect(window.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // Pop the ONLY card out. dockview keeps the group it came from in the grid,
    // empty and hidden, so the card has a slot to dock back into — and that
    // shell still reports `location.type === 'grid'`, which is exactly what the
    // old "first grid group" lookup would hand the next session.
    await window.getByTitle('Pop out into its own window').click();
    await expect
      .poll(() => app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 15_000,
      })
      .toBe(1);

    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] });
    }, folder2);
    await window.getByRole('button', { name: '+ session' }).click();

    // THE ASSERTION: the card is in the main window AND it has a width. With the
    // husk-blind lookup it is in the main window at 22.67px (measured), and
    // every rail-level assertion in this file passes anyway.
    await expectWideEnough(cardFor(window, path.basename(folder2)), 'the new session card');
    await closePopouts(a);
  });

  test('a new session never lands in the document area (#462, the mirror rule)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    const folder2 = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { app, window } = a;
    await expect(window.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // A viewer, opened the palette way (`Open file…`), so the document area is
    // real and on screen. §5.30 says a viewer never displaces a session; this is
    // the obverse — a session must not displace what you are reading.
    const viewer = window.getByTestId('document-viewer');
    await openFileInViewer(a, path.join(folder, 'README.md'));

    // ...and now pop the session out, which leaves the document area as the only
    // VISIBLE grid group in the window. #461's picker prefers a visible group,
    // so without the mirror rule the new card opens as a tab ON TOP of the
    // document — the one place a session must not go.
    await window.getByTitle('Pop out into its own window').click();
    await expect
      .poll(() => app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 15_000,
      })
      .toBe(1);

    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] });
    }, folder2);
    await window.getByRole('button', { name: '+ session' }).click();

    await expectWideEnough(cardFor(window, path.basename(folder2)), 'the new session card');
    // The document is STILL THERE. Two panels in one dockview group cannot both
    // be on screen, so a viewer that survives the new card at a readable width
    // is a viewer the card did not land on top of.
    await expectWideEnough(viewer, 'the document');
    // ...said the other way too, so a future layout that renders both at once
    // cannot make the line above vacuous: they are in different tab strips.
    const docStrip = window
      .locator('.dv-tabs-container')
      .filter({ has: window.locator('.dv-tab', { hasText: 'README.md' }) });
    await expect(docStrip).toHaveCount(1);
    await expect(docStrip.locator('.dv-tab', { hasText: path.basename(folder2) })).toHaveCount(0);
    await closePopouts(a);
  });

  test('a new session never takes over a popped-out VIEWER\'s way home (#462)', async () => {
    skipPopoutOnLinux();
    // The rule above, read through the husk — and the reason the document-area
    // test is not enough. A dock-back shell is EMPTY, so nothing about it says
    // whether the panel that left was a card or a viewer; revive a viewer's and
    // the session takes the document area by the back door, with dockview
    // handing the viewer back into that group — beside the card — the moment its
    // window closes. No session is seeded at all, which is what leaves the
    // viewer's shell as the only grid group there is.
    const folder = tempProjectFolder();
    const folder2 = tempProjectFolder();
    a = await launchApp({});
    const { app, window } = a;
    // With nothing seeded there is no card to wait for, and the palette's
    // Ctrl+Shift+P goes nowhere until the shell has rendered — wait on the one
    // control that is there whether or not a session is.
    await expect(window.getByRole('button', { name: '+ session' })).toBeVisible({
      timeout: 25_000,
    });
    await openFileInViewer(a, path.join(folder, 'README.md'));

    await window.getByTitle('Open this document in its own window').click();
    await expect
      .poll(() => app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 15_000,
      })
      .toBe(1);
    const popout = app.windows().find((p) => p.url().includes('popout.html'))!;
    await popout.waitForLoadState('domcontentloaded');
    await expect(window.getByTestId('document-viewer')).toHaveCount(0);

    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] });
    }, folder2);
    await window.getByRole('button', { name: '+ session' }).click();
    await expectWideEnough(cardFor(window, path.basename(folder2)), 'the new session card');

    // Now send the document home. It must come back to a place of its own — if
    // the card took its shell, dockview docks it back as a tab BESIDE the card,
    // which is the §5.30 invariant the whole document area exists to keep.
    await popout.evaluate(() => window.close());
    await expect(window.getByTestId('document-viewer')).toBeVisible({ timeout: 15_000 });
    const docStrip = window
      .locator('.dv-tabs-container')
      .filter({ has: window.locator('.dv-tab', { hasText: 'README.md' }) });
    await expect(docStrip).toHaveCount(1);
    await expect(docStrip.locator('.dv-tab', { hasText: path.basename(folder2) })).toHaveCount(0);
    // The card is still its own surface, in its own group, on screen.
    //
    // No width assertion HERE, deliberately: a group returning from a pop-out
    // reclaims the share of the grid it had when it left — which was all of it,
    // since it was the only group — so the card is squeezed to ~98px (measured)
    // until the divider is dragged. That is dockview's sizing policy for a
    // dock-back, the same it applies to two cards, and not what this rule is
    // about. The width that matters was asserted above, when the card opened.
    await expect(cardFor(window, path.basename(folder2))).toBeVisible();
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
