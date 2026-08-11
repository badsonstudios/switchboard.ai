// P2-E18-14 — attention and urgency for a DIRECT session.
//
// THE GAP THIS FILLS, from the #404 audit: ~25 tests across `urgency`,
// `attention`, `rail`, `ladder`, `focus-policy`, `presentation-policy`,
// `layout-modes` and `a11y-keyboard` drive a session into `needs-permission` by
// POSTing the CLI's permission `Notification` at the hook listener. That
// signal is deliberately DROPPED for a stream session (#313,
// `hook-listener.ts:771`) — on this transport a permission is a `can_use_tool`
// on the control channel, and a debounced hook nudge with nothing held is a
// false alarm. So not one test anywhere asserted that a Direct hold raises the
// lamp, the count, the Events row, the attention queue, or obeys the
// focus-stealing policy.
//
// The stimulus here is therefore a PROMPT, not a POST: `!perm` makes the fake
// CLI ask for real, and everything after it — the control request, the status
// machine, the lamp, the queue, the policy — is the shipped article.
//
// NO `SWITCHBOARD_TRANSPORT` ANYWHERE, deliberately: Direct is the default
// since #381, and a spec about the default must not name it.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, streamPrompter, tempProjectFolder } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
/** the dual-capable fake, asked for nothing — i.e. the app's own default */
const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

const strip = (w: Page) => w.getByTestId('urgency-strip');
const lamp = (w: Page, title: string) => strip(w).locator(`[data-urgency-lamp][title^="${title}"]`);
const eventRows = (w: Page) => w.locator('aside [data-event-kind]');
const activeTab = (w: Page) => w.locator('.dv-active-tab');
const tabs = (w: Page) => w.locator('.dv-tabs-container .dv-tab');
const rail = (w: Page) => w.locator('nav');
const row = (w: Page, title: string) =>
  rail(w).locator('[draggable="true"]', { hasText: title }).first();
/** the session the workspace is FOCUSED on, as the app itself reports it */
const focused = (w: Page) => rail(w).locator('[data-rail-open][aria-current="true"]');

/** run a palette command by its visible title */
async function palette(w: Page, title: string): Promise<void> {
  await w.keyboard.press(`${MOD}+Shift+P`);
  await w.getByPlaceholder('Type a command or a session name…').fill(title);
  await w.keyboard.press('Enter');
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

/** answer everything main is holding, the way a card's bar would */
async function denyAllHeld(w: Page): Promise<void> {
  const ids = await w.evaluate(() =>
    window.switchboard.sessions.pendingPermissions().then((l) => l.map((p) => p.requestId))
  );
  for (const id of ids) {
    await w.evaluate((requestId) => window.switchboard.sessions.decidePermission(requestId, 'deny'), id);
  }
}

test.describe('a Direct hold raises attention (P2-E18-14)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('the lamp, the count, the Events row and the queue head all move', async () => {
    // a launch plus four waits with generous individual budgets: over the 60s
    // default on a cold runner, and a retry costs ten minutes
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    const title = path.basename(folder);
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(lamp(w, title)).toBeVisible({ timeout: 25_000 });

    // a calm Direct session is calm — the baseline, without which every
    // assertion below could be satisfied by the app simply doing nothing
    await expect(lamp(w, title)).toHaveAttribute('data-needs-you', 'false');
    await expect(w.getByTestId('urgency-count')).toHaveAttribute('data-needing', '0');
    await expect(eventRows(w)).toHaveCount(0);

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!perm attention.sh');
    await box.press('Enter');

    // 1. the lamp, by STATUS and by the "needs you" flag the strip counts
    await expect(lamp(w, title)).toHaveAttribute('data-status', 'needs-permission', {
      timeout: 30_000,
    });
    await expect(lamp(w, title)).toHaveAttribute('data-needs-you', 'true');
    await expect(w.getByTestId('urgency-count')).toHaveAttribute('data-needing', '1');

    // 2. the Events panel, and the attention QUEUE's head marker — the thing
    //    Ctrl+Space walks. A row with no `data-next` is a log entry, not a queue.
    await expect(eventRows(w)).toHaveCount(1, { timeout: 15_000 });
    await expect(w.locator('aside [data-next="true"]')).toHaveAttribute(
      'data-event-kind',
      'needs-permission'
    );

    // 3. answering it takes the whole apparatus back down, live. The bar
    //    carries the CLI's own prose, which is how we know this question came
    //    off `can_use_tool` and not off a hook payload.
    await expect(w.getByText(/sensitive file/)).toBeVisible();
    await w.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(w.locator('aside [data-event-kind="needs-permission"]')).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(lamp(w, title)).not.toHaveAttribute('data-status', 'needs-permission');
  });

  test('Ctrl+Space jumps to the Direct session that is waiting', async () => {
    test.setTimeout(120_000); // two real spawns
    const folder = tempProjectFolder();
    const first = path.basename(folder);
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    const second = await addSession(a);
    await expect(tabs(w)).toHaveCount(2);

    // stand in the first card, so the jump has somewhere to move FROM
    await w.keyboard.press(`${MOD}+1`);
    await expect(activeTab(w)).toContainText(first);

    // the hidden card blocks on a gated call
    await streamPrompter(a)(second, '!perm jump.sh');
    await expect(lamp(w, second)).toHaveAttribute('data-needs-you', 'true', { timeout: 30_000 });
    // …and under the default policy a card behind a tab does NOT steal focus,
    // which is what leaves the hotkey something to do
    await expect(activeTab(w)).toContainText(first);

    await w.keyboard.press(`${MOD}+Space`);
    await expect(activeTab(w)).toContainText(second);
  });
});

// §5.8's focus-stealing policy (E9-10) on this transport. The rules are pure
// and unit-tested; what has never been proved is that a DIRECT permission is a
// stimulus they see at all — every existing e2e for them drives the hook
// Notification a stream session drops.
test.describe('focus policy sees a Direct hold (P2-E18-14)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('urgent lights the lamp and moves nothing; focus brings the card all the way back', async () => {
    test.setTimeout(150_000); // two real spawns, two policy changes
    const folder = tempProjectFolder();
    const first = path.basename(folder);
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    const second = await addSession(a);
    await expect(tabs(w)).toHaveCount(2);

    await palette(w, 'When any session needs you: never jump, just light its lamp');

    // take the second session out of the workspace entirely, then stand in the
    // first: anything that moved would be unmistakable
    await row(w, second).click();
    await palette(w, 'Hide session (keeps it running)');
    await expect(tabs(w)).toHaveCount(1);
    await row(w, first).click();
    await expect(focused(w)).toHaveText(new RegExp(first));

    // it blocks on a gated call. Under `urgent` the lamp is the WHOLE response.
    await streamPrompter(a)(second, '!perm urgent.sh');
    await expect(lamp(w, second)).toHaveAttribute('data-status', 'needs-permission', {
      timeout: 30_000,
    });
    await expect(lamp(w, second)).toHaveAttribute('data-needs-you', 'true');
    await expect(tabs(w)).toHaveCount(1);
    await expect(focused(w)).toHaveText(new RegExp(first));

    // The other end of the ladder. Switching the policy alone must move
    // nothing — a policy is about what happens NEXT, not a retroactive jump.
    await palette(w, 'When any session needs you: always jump to it');
    await expect(tabs(w)).toHaveCount(1);

    // Now answer the parked question. The turn ends, which is a Direct status
    // change into an attention state — and under `focus` that brings a session
    // that is not even in the workspace all the way back, with the cursor.
    await denyAllHeld(w);
    await expect(tabs(w)).toHaveCount(2, { timeout: 30_000 });
    await expect(focused(w)).toHaveText(new RegExp(second));
  });
});
