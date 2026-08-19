// #557 + #495/#496 — Ctrl+F is the BAR, and it keeps working on a resumed
// session.
//
// THE REPORT (owner, v0.6.0 dogfood): "It should just work like I do Control+F,
// and it tells me how many I've found, like 2 of 13. I can go up and down to
// it, or 0 of 13, or nothing found, whatever." What he got instead was the
// results list arriving unasked over the conversation — "this weird window that
// showed the different points in the session".
//
// WHY THE LIST WAS OPENING, AND WHY THAT IS TWO BUGS. It opened because nothing
// could be jumped to, which was the honest fallback: `revealStep` had no other
// way to put a user in front of a match it could not scroll to. So the fix is
// both halves — make the hits jumpable (#495/#496), and stop the list opening
// by itself when some still are not (#557).
//
// MEASURED HERE BEFORE ANY OF IT WAS BUILT, on this file's own harness:
//
//   fresh session          1 of 1, mark painted, list shut          — fine
//   resumed + IDLE         1 of 1, mark painted, list shut          — fine
//   resumed + a NEW TURN   1 of 2, BOTH rows read-only, list OPEN,
//                          no mark, and the bar carrying a notice
//                          about the whole session
//
// That last row is the bug, and note what it is NOT: the ticket said a resumed
// session was list-only while idle. It is not — it breaks once a turn lands on
// top of the hydrated backlog, because the view then holds more conversation at
// the front than the new transcript does and the ONE session-wide offset is
// refused for all of it. #496 resolves each hit by its own block id instead, so
// the post-resume hits jump and only the genuinely unidentifiable ones refuse.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder, readWorkspaceFile } from './fixtures/app';
import { FAKE_SESSION_ID } from '../src/main/providers/fake-stream-ids';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const WINDOW = { x: 0, y: 0, width: 1400, height: 900 };

const composer = (w: Page) => w.getByPlaceholder(/Prompt this session/);
const bar = (w: Page) => w.locator('[data-testid="find-bar"]');
const count = (w: Page) => w.locator('[data-testid="find-count"]');
const results = (w: Page) => w.locator('[data-testid="find-results"]');
const stuck = (w: Page) => w.locator('[data-testid="find-stuck"]');

async function sized(a: LaunchedApp): Promise<void> {
  await a.app.evaluate(({ BrowserWindow }, box) => {
    BrowserWindow.getAllWindows()[0]?.setBounds(box);
  }, WINDOW);
  await a.window.waitForTimeout(300);
}

/** one `!tools` turn — the fake writes it to a JSONL, as the real CLI does */
async function toolTurn(w: Page, nth: number): Promise<void> {
  const box = composer(w);
  await box.click();
  await box.fill('!tools');
  await box.press('Enter');
  await expect(w.locator('[data-feed-box="bash"]').nth(nth)).toBeVisible({ timeout: 60_000 });
  await w.waitForTimeout(1_000);
}

test.describe('Ctrl+F is the bar (#557), and it survives a resume (#495/#496)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  test('find, step, close — and the results list never appears', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await sized(a);
    await toolTurn(w, 0);
    await toolTurn(w, 1);

    await w.keyboard.press(`${MOD}+f`);
    await expect(bar(w)).toHaveCount(1);
    await w.locator('[data-testid="find-input"]').fill('STREAM_PROSE');
    await expect(count(w)).toHaveText('1 of 2', { timeout: 20_000 });

    // THE WHOLE POINT: the bar answered, and nothing opened over the pane.
    await expect(results(w)).toHaveCount(0);
    // NOT asserting feed marks here. Whether the term gets painted where it
    // landed is #520's claim and `find.spec.ts` owns it; this file is about
    // what the BAR does, and mixing the two would make a marking change look
    // like a regression in the list rule.
    await expect(stuck(w)).toHaveCount(0);

    // ...and stepping is the bar too, in both directions.
    await w.keyboard.press('Enter');
    await expect(count(w)).toHaveText('2 of 2');
    await expect(results(w)).toHaveCount(0);
    await w.keyboard.press('Shift+Enter');
    await expect(count(w)).toHaveText('1 of 2');
    await expect(results(w)).toHaveCount(0);

    // the list is still THERE for whoever wants it — it just has to be asked
    await w.locator('[data-testid="find-results-toggle"]').click();
    await expect(results(w)).toHaveCount(1);

    await w.keyboard.press('Escape');
    await expect(bar(w)).toHaveCount(0);
  });

  test('a resumed session with a new turn on top still jumps to what it can', async () => {
    test.setTimeout(240_000);
    const folder = tempProjectFolder();
    const first = await launchApp({ seedFolder: folder, env: DIRECT });
    a = first;
    await expect(first.window.getByText(path.basename(folder)).first()).toBeVisible({
      timeout: 25_000,
    });
    await sized(first);
    await toolTurn(first.window, 0);
    // The FIRST fake conversation under this home is this card's — since #603
    // the fake mints one id per spawn rather than handing every session the
    // same constant, and this test has exactly one card.
    await expect(() => {
      const card = readWorkspaceFile(first.home).sessions?.[0];
      expect(card?.nativeSessionId).toBe(FAKE_SESSION_ID);
    }).toPass({ timeout: 20_000 });
    await first.close();

    a = await launchApp({ home: first.home, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await sized(a);
    // the replayed conversation is on screen (#395) — the hydrated backlog that
    // sits in front of everything the new transcript has
    await expect(w.getByText('STREAM_PROSE').first()).toBeAttached({ timeout: 60_000 });
    // ...and now a turn lands on top of it, which is the state that broke
    await toolTurn(w, 1);

    await w.keyboard.press(`${MOD}+f`);
    await w.locator('[data-testid="find-input"]').fill('STREAM_PROSE');
    await expect(count(w)).toHaveText('1 of 2', { timeout: 20_000 });

    // Unasked, the list stays shut even though one of the two cannot be
    // reached — that is #557 holding in the exact case that used to break it.
    await expect(results(w)).toHaveCount(0);

    // The hydrated hit is honestly unreachable and the bar says so quietly...
    await expect(stuck(w)).toHaveCount(1);
    // ...and the post-resume one IS reachable, by its own block id (#496).
    // Before this, both were read-only and the session carried a notice saying
    // it could not be scrolled to at all.
    await w.keyboard.press('Enter');
    // The step LANDED: the note is gone, which only happens when the surface
    // reported that it really moved to the hit.
    await expect(count(w)).toHaveText('2 of 2');
    await expect(stuck(w)).toHaveCount(0);

    await w.keyboard.press('Escape');
    await expect(bar(w)).toHaveCount(0);
  });
});
