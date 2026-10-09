// §5.8 — who needs you, and where a jump landed, as the Sessions list says it.
//
// This file used to be about the row of lamps (P2-E9-04). The owner had that row
// removed from the app outright (#1164), along with the Collapsed strip, and the
// list of sessions took over what it said. So the claims here are the ones that
// survived the row, re-pointed at the list:
//
//   - the list reflects LIVE status for every session, suspended included, and
//     counts who needs you;
//   - the row you were sent to by "go to the next session that needs you" is
//     outlined for a beat, and the outline goes out by itself — including when
//     nothing that lists sessions is on screen at all, because the timing is the
//     app's and no longer belongs to any one row.
//
// What went with the lamps and is NOT replaced: a lamp per session above the
// workspace, the "you are here" lamp, the strip staying up while the list is
// hidden, and the lamp's own contrast audit.
//
// Driven through the REAL hook listener and a REAL held permission, exactly as
// attention.spec.ts does, so what the list shows is the real status machine.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  skipPopoutOnLinux,
  tempProjectFolder,
  hookPoster,
  permissionHolder,
  answerHeldPermissions,
} from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** a session's row in the Sessions list */
const row = (w: Page, title: string) => w.locator('nav .rail-row', { hasText: title }).first();
const rows = (w: Page) => w.locator('nav .rail-row');
/** the list's "N need you": present only while somebody does */
const needCount = (w: Page) => w.locator('nav [data-rail-need]');
const activeTab = (w: Page) => w.locator('.dv-active-tab');

/** where the freeze below parks the real clock while it is stopped */
interface ClockStash {
  __realDateNow?: () => number;
}

/**
 * Run `body` with the RENDERER's wall clock STOPPED (#284).
 *
 * The post-jump outline is a ~1.5s transient computed from `Date.now()` at
 * RENDER time. Since #320 the beat is anchored to the PAINT — the jump marks the
 * session with no deadline at all and the app stamps `paint + 1500` from the
 * frame after it draws — so the outline can no longer be skipped ENTIRELY the
 * way it could when the deadline ran from the keypress. What #320 did not do,
 * and could not, is give this assertion a deadline of its own: it still has to
 * land inside a ~1.5s wall-clock window, which is not the budget every other
 * `expect` in this file gets. Measured margin on an idle box is ~10x; under
 * three parallel e2e workers it is a flake, and one that would present exactly
 * like the renderer race #251 spent a forensics pass distinguishing. This makes
 * the beat last as long as the block does.
 *
 * With the clock stopped, the paint stamps `frozen + 1500` and every render
 * reads the same `frozen`, so the row is unconditionally outlined — and the
 * expiry timer, which runs on the REAL monotonic clock, prunes nothing when it
 * fires (`frozen + 1500 > frozen`) and re-arms instead of ending the chain. So
 * the attribute is stable for as long as we need rather than merely likely.
 *
 * Nothing about the jump is faked: the keypress, the queue, the store write,
 * the component and the paint are all the shipped article — only the reading of
 * the clock they consult is pinned, and only for the length of this block. It
 * is the renderer's OWN `Date.now` (`page.evaluate` runs in the page's main
 * world), and the only other renderer code that reads it is FeedView's
 * scroll-gesture heuristic, which this spec never touches.
 */
async function withStoppedClock(w: Page, body: () => Promise<void>): Promise<void> {
  await w.evaluate(() => {
    const stash = window as unknown as ClockStash;
    const real = Date.now;
    stash.__realDateNow = real;
    const frozen = real();
    Date.now = () => frozen;
  });
  try {
    await body();
  } finally {
    // Always, so a failed assertion inside the block cannot leave the page's
    // clock stopped for whatever the test does afterwards — and NEVER throwing,
    // for the same reason killTree doesn't: this runs on the failure path, and
    // an evaluate against a page that has closed or crashed would replace the
    // assertion error that actually explains the failure with "Target page
    // closed". Restoring is best-effort; the app is torn down per-test anyway.
    try {
      await w.evaluate(() => {
        const stash = window as unknown as ClockStash;
        if (stash.__realDateNow) Date.now = stash.__realDateNow;
        delete stash.__realDateNow;
      });
    } catch {
      /* the page is gone; its clock went with it */
    }
  }
}

/** open one more session, in its own folder (so nothing auto-groups) */
async function addSession(a: LaunchedApp): Promise<string> {
  const dir = tempProjectFolder();
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
  await a.window.getByRole('button', { name: '+ session' }).click();
  const name = path.basename(dir);
  await expect(row(a.window, name)).toBeVisible({ timeout: 25_000 });
  return name;
}

test.describe('who needs you, in the Sessions list', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('one row per session, lit by LIVE status, and counted', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(row(w, first)).toBeVisible({ timeout: 25_000 });

    const second = await addSession(a);
    await expect(rows(w)).toHaveCount(2);

    // a calm session is calm: no attention treatment until something asks, and
    // no count at the foot of the list while nobody is waiting
    await expect(row(w, first)).toHaveAttribute('data-needs-you', 'false');
    await expect(needCount(w)).toHaveCount(0);

    // A REAL held request (#952): `PreToolUse` is no longer registered and a
    // permission `Notification` is dropped before it can move a badge (#313), so
    // `!perm` is what a permission IS on this transport.
    await permissionHolder(a)(first);
    await expect(row(w, first)).toHaveAttribute('data-session-status', 'needs-permission', {
      timeout: 15_000,
    });
    await expect(row(w, first)).toHaveAttribute('data-needs-you', 'true');
    // and ONLY that one — the list is a readout, not an alarm for everybody
    await expect(row(w, second)).toHaveAttribute('data-needs-you', 'false');
    await expect(needCount(w)).toHaveAttribute('data-rail-need', '1');

    // answering it takes the row back down, live — and now it really is an
    // ANSWER rather than the next status overwriting a transient nudge. The turn
    // then completes, which leaves the card `done` (finished, unreviewed — still
    // a needs-you state), so the prompt that follows is what returns it to calm.
    // `hookPoster` is untouched here: the listener is still the status channel.
    //
    // Answered off-screen deliberately: the bar is on `first`'s card and the
    // SECOND session has focus, so there is no Allow button on screen to click.
    // `answerHeldPermissions` takes the bar's own `sessions:decidePermission`
    // path — the same door, without needing the pixels.
    expect(await answerHeldPermissions(a)).toBe(1);
    const post = await hookPoster(a, 2);
    await post(first, { hook_event_name: 'UserPromptSubmit' });
    await expect(row(w, first)).toHaveAttribute('data-needs-you', 'false', { timeout: 15_000 });
    await expect(needCount(w)).toHaveCount(0);
  });

  test('the row you were sent to is outlined after a jump, then lets go on its own', async () => {
    const folders = [tempProjectFolder(), tempProjectFolder()];
    a = await launchApp({ seedFolder: folders[0] });
    const w = a.window;
    const names = folders.map((f) => path.basename(f));
    await expect(row(w, names[0])).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, folders[1]);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(rows(w)).toHaveCount(2, { timeout: 25_000 });

    await permissionHolder(a)(names[1]);
    await expect(row(w, names[1])).toHaveAttribute('data-session-status', 'needs-permission', {
      timeout: 15_000,
    });

    // stand somewhere else, then let the queue send us
    await w.keyboard.press(`${MOD}+1`);
    await expect(activeTab(w)).toContainText(names[0]);
    await expect(row(w, names[1])).not.toHaveAttribute('data-flash', 'true');

    // The jump and everything it lights up, with the page's clock stopped, so
    // the beat cannot expire out from under the assertions (#284 — see
    // withStoppedClock).
    await withStoppedClock(w, async () => {
      await w.keyboard.press(`${MOD}+Space`);
      await expect(row(w, names[1])).toHaveAttribute('data-flash', 'true');
      // ...and only the one you were sent to
      await expect(row(w, names[0])).not.toHaveAttribute('data-flash', 'true');
      // the jump did land where the outline says it did
      await expect(activeTab(w)).toContainText(names[1]);
    });

    // Clock running again: it puts itself out — no click, no second key, just
    // the beat passing. A transition that was WATCHED rather than merely found:
    // the assertion above proved the row was outlined, so a row that never lit
    // can no longer satisfy this one on arrival.
    //
    // It is also the end-to-end guard that the PAINT ANCHOR is wired at all
    // (#320). A mark whose beat is never started has no deadline and arms no
    // timer, so an App that stopped running the beat would leave this row
    // outlined forever and fail here, in the real window, on the real rAF.
    await expect(row(w, names[1])).not.toHaveAttribute('data-flash', 'true', { timeout: 6_000 });
    // the status itself is untouched by the beat: it is still blocked
    await expect(row(w, names[1])).toHaveAttribute('data-session-status', 'needs-permission');
  });

  test('the outline ends even when no list of sessions is on screen', async () => {
    // The beat used to be run by whichever row was showing: the lamps, then the
    // strip. Both could be absent, and a jump made then left its mark with no
    // deadline and nobody to give it one — lit for good, and waiting to be seen
    // the moment the list came back. The app runs the beat itself now (#1164),
    // and this is the state that proves it: the list is put away for the whole
    // of the jump and the beat.
    const folders = [tempProjectFolder(), tempProjectFolder()];
    a = await launchApp({ seedFolder: folders[0] });
    const w = a.window;
    const names = folders.map((f) => path.basename(f));
    await expect(row(w, names[0])).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, folders[1]);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(rows(w)).toHaveCount(2, { timeout: 25_000 });
    await permissionHolder(a)(names[1]);
    await expect(row(w, names[1])).toHaveAttribute('data-needs-you', 'true', { timeout: 15_000 });
    await w.keyboard.press(`${MOD}+1`);
    await expect(activeTab(w)).toContainText(names[0]);

    await w.keyboard.press(`${MOD}+B`);
    await expect(w.locator('nav')).toHaveCount(0);
    await w.keyboard.press(`${MOD}+Space`);
    await expect(activeTab(w)).toContainText(names[1]);
    // long enough for the beat (1.5s) to have started at the paint and ended
    await w.waitForTimeout(3_000);

    await w.keyboard.press(`${MOD}+B`);
    await expect(row(w, names[1])).toBeVisible();
    // READ ONCE, not polled. A retrying assertion would also be satisfied by
    // a beat that only STARTED when the list came back: that one ends a
    // second and a half later, inside the retry window. The claim is that it
    // was already over.
    expect(await row(w, names[1]).getAttribute('data-flash')).toBeNull();
  });

  test('a SUSPENDED session keeps its row, and the row says so', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { app, window: w } = a;
    const title = path.basename(folder);
    await expect(row(w, title)).toBeVisible({ timeout: 25_000 });

    // pop out, then close the OS window: the card docks back SUSPENDED (E8-04)
    await w.getByTitle('Pop out into its own window').click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
    const popout = app.windows().find((x) => x !== w)!;
    await popout.evaluate(() => window.close());
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
    // scoped to the card's PANEL: the card also carries a `role="status"` live
    // region holding the same words for a screen reader (#358), and an sr-only
    // element is 1×1 and clipped rather than hidden, so Playwright counts it as
    // visible too. `card-overlay` is the one that is actually on screen.
    await expect(w.getByTestId('card-overlay').getByText('Session suspended')).toBeVisible({
      timeout: 15_000,
    });

    // still one row, flagged suspended IN WORDS rather than silently reading
    // "idle": the two share a colour on the ramp, which is exactly why the word
    // has to be there
    await expect(rows(w)).toHaveCount(1);
    await expect(row(w, title)).toContainText('suspended', { timeout: 15_000 });
    await expect(row(w, title)).toHaveAttribute('data-session-status', 'idle');
    await expect(row(w, title)).toHaveAttribute('data-needs-you', 'false');
  });

  // #170 — the post-Resume half of the test above, which E9-04 deliberately
  // left out because it did not pass: resuming produced no status CHANGE, so
  // nothing refreshed the one `sessions:cards` list the Sessions list reads, and
  // the card went on calling itself suspended indefinitely. The fake provider is
  // the honest case — it posts no hooks, so nothing else comes along to refresh
  // the list by accident, exactly like a real PTY session nobody has prompted.
  test('resuming a suspended session refreshes the Sessions list (#170)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { app, window: w } = a;
    const title = path.basename(folder);
    await expect(row(w, title)).toBeVisible({ timeout: 25_000 });

    // suspend it the way a user does: pop out, close the OS window (E8-04)
    await w.getByTitle('Pop out into its own window').click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
    const popout = app.windows().find((x) => x !== w)!;
    await popout.evaluate(() => window.close());
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
    await expect(row(w, title)).toContainText('suspended', { timeout: 15_000 });

    // ONE click, on the card's own Resume — and then nothing else. No refresh,
    // no navigation, no second interaction: whatever moves next moved by
    // itself, which is the entire done-when.
    await w.getByRole('button', { name: 'Resume' }).click();
    await expect(row(w, title)).not.toContainText('suspended', { timeout: 20_000 });
  });
});
