// P2-E9-04 — the urgency strip and its delayed urgency reset (§5.8).
//
// Driven through the REAL hook listener, exactly as attention.spec.ts does: the
// test plays the CLI's part (Notification / Stop POSTs with each session's own
// token), so what the lamps show is the real status machine and not a mock.
//
// The four things the item promises, one test each: the strip reflects live
// status for every session (suspended included), a click focuses, the lamp you
// jumped to lingers and then goes out, and the strip survives every layout
// state the app has.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, showTerminal, tempProjectFolder, hookPoster } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const strip = (w: Page) => w.getByTestId('urgency-strip');
const lamps = (w: Page) => strip(w).locator('[data-urgency-lamp]');
const lamp = (w: Page, title: string) => strip(w).locator(`[data-urgency-lamp][title^="${title}"]`);
const activeTab = (w: Page) => w.locator('.dv-active-tab');
const tabs = (w: Page) => w.locator('.dv-tabs-container .dv-tab');

/** Popouts need a real window manager; CI's Linux runner is headless-xvfb and
 *  the popped-out BrowserWindow never materialises there (see #112 / E8 specs). */
function skipPopoutOnLinux(): void {
  test.skip(process.platform === 'linux', 'popout windows are unreliable under xvfb');
}

/** open one more session, in its own folder (so nothing auto-groups) */
async function addSession(a: LaunchedApp): Promise<string> {
  const dir = tempProjectFolder();
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
  await a.window.getByRole('button', { name: '+ session' }).click();
  const name = path.basename(dir);
  await expect(lamp(a.window, name)).toBeVisible({ timeout: 25_000 });
  return name;
}

test.describe('urgency strip (E9-04)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('one lamp per session, colored by LIVE status', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(lamp(w, first)).toBeVisible({ timeout: 25_000 });

    const second = await addSession(a);
    await expect(lamps(w)).toHaveCount(2);

    // a calm session is calm: no attention treatment until something asks
    await expect(lamp(w, first)).toHaveAttribute('data-needs-you', 'false');

    const post = await hookPoster(a, 2);
    await post(first, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    await expect(lamp(w, first)).toHaveAttribute('data-status', 'needs-permission', {
      timeout: 15_000,
    });
    await expect(lamp(w, first)).toHaveAttribute('data-needs-you', 'true');
    // and ONLY that one — the strip is a readout, not an alarm for everybody
    await expect(lamp(w, second)).toHaveAttribute('data-needs-you', 'false');
    await expect(w.getByTestId('urgency-count')).toHaveAttribute('data-needing', '1');

    // answering it takes the lamp back down, live
    await post(first, { hook_event_name: 'UserPromptSubmit' });
    await expect(lamp(w, first)).toHaveAttribute('data-needs-you', 'false', { timeout: 15_000 });
    await expect(w.getByTestId('urgency-count')).toHaveAttribute('data-needing', '0');
  });

  test('clicking a lamp focuses that session', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(lamp(w, first)).toBeVisible({ timeout: 25_000 });
    const second = await addSession(a);
    await expect(activeTab(w)).toContainText(second); // the new card took focus

    await lamp(w, first).click();
    await expect(activeTab(w)).toContainText(first);
    // the strip marks where you are, so it doubles as a "you are here"
    await expect(lamp(w, first)).toHaveAttribute('data-active', 'true');
    await expect(lamp(w, second)).toHaveAttribute('data-active', 'false');

    await lamp(w, second).click();
    await expect(activeTab(w)).toContainText(second);
  });

  test('the arrived-at lamp stays lit after a jump, then goes out on its own', async () => {
    const folders = [tempProjectFolder(), tempProjectFolder()];
    a = await launchApp({ seedFolder: folders[0] });
    const w = a.window;
    const names = folders.map((f) => path.basename(f));
    await expect(lamp(w, names[0])).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, folders[1]);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(lamps(w)).toHaveCount(2, { timeout: 25_000 });

    const post = await hookPoster(a, 2);
    await post(names[1], {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    await expect(lamp(w, names[1])).toHaveAttribute('data-status', 'needs-permission', {
      timeout: 15_000,
    });

    // stand somewhere else, then let the queue send us
    await w.keyboard.press(`${MOD}+1`);
    await expect(activeTab(w)).toContainText(names[0]);
    await expect(lamp(w, names[1])).toHaveAttribute('data-lit', 'false');

    await w.keyboard.press(`${MOD}+Space`);
    // the lit assertion goes FIRST and deliberately: it is the one with a
    // deadline (the beat is ~1.5s), so anything checked ahead of it is time
    // spent inside the window this test is trying to observe
    await expect(lamp(w, names[1])).toHaveAttribute('data-lit', 'true');
    // ...and only the one you were sent to
    await expect(lamp(w, names[0])).toHaveAttribute('data-lit', 'false');
    // the jump did land where the lamp says it did
    await expect(activeTab(w)).toContainText(names[1]);

    // then it puts itself out — no click, no second key, just the beat passing
    await expect(lamp(w, names[1])).toHaveAttribute('data-lit', 'false', { timeout: 6_000 });
    // the status itself is untouched by the beat: it is still blocked
    await expect(lamp(w, names[1])).toHaveAttribute('data-status', 'needs-permission');
  });

  test('the strip stays visible in every layout state the app has', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(lamp(w, title)).toBeVisible({ timeout: 25_000 });

    // rail hidden (Mod+B) — the rail is the OTHER place every session is listed
    await w.keyboard.press(`${MOD}+B`);
    await expect(w.locator('nav')).toHaveCount(0);
    await expect(strip(w)).toBeVisible();
    await expect(lamp(w, title)).toBeVisible();
    await w.keyboard.press(`${MOD}+B`);
    await expect(w.locator('nav')).toHaveCount(1);

    // the card showing its Terminal instead of the Session view
    await showTerminal(w);
    await expect(w.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
    await expect(strip(w)).toBeVisible();

    // the card taken OUT of the workspace entirely (§5.8's ladder): "the
    // session lives on in the rail, its lamp, and the events list" — so this is
    // the state that would break a strip drawn by the grid
    await w.keyboard.press(`${MOD}+Shift+P`);
    await w.getByPlaceholder('Type a command or a session name…').fill('hide session');
    await w.keyboard.press('Enter');
    await expect(tabs(w)).toHaveCount(0);
    await expect(strip(w)).toBeVisible();
    await expect(lamp(w, title)).toBeVisible();

    // and the lamp is a reveal trigger like any other click
    await lamp(w, title).click();
    await expect(tabs(w)).toHaveCount(1);
  });

  test('a SUSPENDED session keeps its lamp', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { app, window: w } = a;
    const title = path.basename(folder);
    await expect(lamp(w, title)).toBeVisible({ timeout: 25_000 });

    // pop out, then close the OS window: the card docks back SUSPENDED (E8-04)
    await w.getByTitle('Pop out into its own window').click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
    const popout = app.windows().find((x) => x !== w)!;
    await popout.evaluate(() => window.close());
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
    await expect(w.getByText('Session suspended')).toBeVisible({ timeout: 15_000 });

    // still one lamp, flagged suspended rather than silently reading "idle"
    await expect(lamps(w)).toHaveCount(1);
    await expect(lamp(w, title)).toHaveAttribute('data-suspended', 'true', { timeout: 15_000 });
    await expect(lamp(w, title)).toHaveAttribute('data-needs-you', 'false');
    await expect(lamp(w, title)).toHaveAttribute('title', `${title} — suspended`);
    // the rail says the same thing about the same session: both read one
    // `sessions:cards` list through one presentStatus, and this is the
    // assertion that would catch them drifting apart
    await expect(
      w.locator('nav [draggable="true"]', { hasText: title }).first()
    ).toHaveAttribute('data-session-status', 'idle');
  });

  // #170 — the post-Resume half of the test above, which E9-04 deliberately
  // left out because it did not pass: resuming produced no status CHANGE, so
  // nothing refreshed the one `sessions:cards` list both of these read, and the
  // card went on calling itself suspended indefinitely. The fake provider is
  // the honest case — it posts no hooks, so nothing else comes along to refresh
  // the list by accident, exactly like a real PTY session nobody has prompted.
  test('resuming a suspended session refreshes the rail AND the strip (#170)', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { app, window: w } = a;
    const title = path.basename(folder);
    const row = w.locator('nav [draggable="true"]', { hasText: title }).first();
    await expect(lamp(w, title)).toBeVisible({ timeout: 25_000 });

    // suspend it the way a user does: pop out, close the OS window (E8-04)
    await w.getByTitle('Pop out into its own window').click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
    const popout = app.windows().find((x) => x !== w)!;
    await popout.evaluate(() => window.close());
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
    await expect(lamp(w, title)).toHaveAttribute('data-suspended', 'true', { timeout: 15_000 });
    await expect(row).toContainText('suspended', { timeout: 15_000 });

    // ONE click, on the card's own Resume — and then nothing else. No refresh,
    // no navigation, no second interaction: whatever moves next moved by
    // itself, which is the entire done-when.
    await w.getByRole('button', { name: 'Resume' }).click();

    // both surfaces, because the bug was in neither of them: they read one
    // list, and the list was what went stale
    await expect(lamp(w, title)).toHaveAttribute('data-suspended', 'false', { timeout: 20_000 });
    await expect(row).not.toContainText('suspended');
  });
});
