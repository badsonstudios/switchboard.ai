// P2-E14-02 — Events v2: a held permission answered from the Events drawer,
// with the card never focused.
//
// On the stream fake, because Direct is the default transport and the one the
// done-when names ("e2e drives the inline decision via the stream fake"). NO
// `SWITCHBOARD_TRANSPORT` here, for stream-approval.spec.ts's reason: a spec
// about the default must not name it.
//
// The witnesses are the ones that cannot be satisfied by the renderer agreeing
// with itself: main's held list (`pendingPermissions`) and the DISK — `!perm`
// makes the fake CLI write the file only when the verdict is allow.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, pollAsync, streamPrompter, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

function heldIds(w: Page): Promise<string[]> {
  return w.evaluate(() =>
    window.switchboard.sessions.pendingPermissions().then((l) => l.map((p) => p.requestId))
  );
}

/** a card's LIVE id — what an Events row is keyed on */
function liveIdOf(a: LaunchedApp, title: string): Promise<string> {
  return pollAsync(async () => {
    const cards = (await a.window.evaluate(() => window.switchboard.sessions.cards())) as Array<{
      title: string;
      liveId?: string;
    }>;
    return cards.find((c) => c.title === title)?.liveId ?? null;
  }, `no live session for "${title}"`);
}

/** which of these sessions the ACTIVE rail row is — the "never focused"
 *  witness. By name, not by the row's whole text: the row also prints the
 *  session's status, which answering a permission is SUPPOSED to change. */
async function activeRow(w: Page, titles: readonly string[]): Promise<string | null> {
  const text = await w.evaluate(
    () => document.querySelector('nav [aria-current="true"]')?.textContent ?? ''
  );
  return titles.find((t) => text.includes(t)) ?? null;
}

async function openDrawer(w: Page): Promise<void> {
  const drawer = w.getByTestId('events-drawer');
  if (await drawer.isVisible()) return;
  await w.getByTestId('events-tab').click();
  await expect(drawer).toBeVisible();
}

/** open one more session in its own folder */
async function addSession(a: LaunchedApp): Promise<{ folder: string; title: string }> {
  const folder = tempProjectFolder();
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, folder);
  await a.window.getByRole('button', { name: '+ session' }).click();
  const title = path.basename(folder);
  await expect(a.window.getByText(title).first()).toBeVisible({ timeout: 25_000 });
  return { folder, title };
}

test.describe('Events v2: answering from the drawer (P2-E14-02)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    // a request left held would park its fake CLI through the teardown
    if (a) for (const id of await heldIds(a.window).catch(() => [])) {
      await a.window
        .evaluate((r) => window.switchboard.sessions.decidePermission(r, 'deny'), id)
        .catch(() => {});
    }
    await a?.cleanup();
    a = undefined;
  });

  test('Deny one session from its row, the other stays held, then Allow it from ITS row', async () => {
    test.setTimeout(180_000); // two real spawns
    const one = tempProjectFolder();
    a = await launchApp({ seedFolder: one, env: DIRECT });
    const w = a.window;
    const titleOne = path.basename(one);
    await expect(w.getByText(titleOne).first()).toBeVisible({ timeout: 25_000 });
    const two = await addSession(a);

    // RELATIVE targets, so the two questions differ and nothing groups — this
    // is about the rows, not the grouped card
    const prompt = streamPrompter(a);
    await prompt(titleOne, '!perm from-one.sh');
    await prompt(two.title, '!perm from-two.sh');
    const [liveOne, liveTwo] = [await liveIdOf(a, titleOne), await liveIdOf(a, two.title)];
    await expect.poll(() => heldIds(w), { timeout: 30_000 }).toHaveLength(2);

    await openDrawer(w);
    const rowOne = w.locator(`[data-event-held="${liveOne}"]`);
    const rowTwo = w.locator(`[data-event-held="${liveTwo}"]`);
    await expect(rowOne).toBeVisible({ timeout: 15_000 });
    await expect(rowTwo).toBeVisible();
    await expect(rowOne).toContainText('from-one.sh');
    await expect(rowTwo).toContainText('from-two.sh');

    const both = [titleOne, two.title];
    const before = await activeRow(w, both);
    expect(before, 'no active session to compare against').not.toBeNull();

    // DENY session one, from its row
    await rowOne.locator('[data-event-deny]').click();
    await expect.poll(() => heldIds(w), { timeout: 15_000 }).toHaveLength(1);
    // …the CLI acted on the refusal: no file, and the row has no buttons left
    await expect(rowOne).toHaveCount(0, { timeout: 15_000 });
    expect(fs.existsSync(path.join(one, 'from-one.sh'))).toBe(false);
    // …and session two's question is untouched: still held, still on its row
    await expect(rowTwo.locator('[data-event-allow]')).toBeVisible();
    expect(fs.existsSync(path.join(two.folder, 'from-two.sh'))).toBe(false);

    // ALLOW session two, from its row — the tool really runs
    await rowTwo.locator('[data-event-allow]').click();
    await expect(() => {
      expect(fs.existsSync(path.join(two.folder, 'from-two.sh'))).toBe(true);
    }).toPass({ timeout: 20_000 });
    await expect.poll(() => heldIds(w), { timeout: 15_000 }).toEqual([]);

    // the card was never focused: the active session is the one it was, and the
    // drawer is still open over the grid
    expect(await activeRow(w, both)).toBe(before);
    await expect(w.getByTestId('events-drawer')).toBeVisible();
  });

  test('Allow all answers everything held AND the follow-up, from the row', async () => {
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    const prompt = streamPrompter(a);

    // two gated calls in one turn — the only way to hold two at once here
    await prompt(title, '!perm first.sh second.sh');
    await expect.poll(() => heldIds(w), { timeout: 30_000 }).toHaveLength(2);
    const live = await liveIdOf(a, title);

    await openDrawer(w);
    const row = w.locator(`[data-event-held="${live}"]`);
    await expect(row).toContainText('+1 more', { timeout: 15_000 });
    await row.locator('[data-event-allow-all]').click();

    // BOTH held calls ran — not just the one the row was showing
    await expect(() => {
      expect(fs.existsSync(path.join(folder, 'first.sh'))).toBe(true);
      expect(fs.existsSync(path.join(folder, 'second.sh'))).toBe(true);
    }).toPass({ timeout: 20_000 });
    await expect.poll(() => heldIds(w), { timeout: 15_000 }).toEqual([]);

    // …and the FOLLOW-UP is covered: answered at the server, never held
    await prompt(title, '!perm third.sh');
    await expect(() => {
      expect(fs.existsSync(path.join(folder, 'third.sh'))).toBe(true);
    }).toPass({ timeout: 20_000 });
    expect(await heldIds(w)).toEqual([]);
  });

  test('a clarification question is an expandable list, and the filters keep it', async () => {
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    await streamPrompter(a)(title, '!ask1');
    await expect.poll(() => heldIds(w), { timeout: 30_000 }).toHaveLength(1);
    const live = await liveIdOf(a, title);

    await openDrawer(w);
    const row = w.locator(`[data-event-held="${live}"]`);
    // a question is never offered a blind answer
    await expect(row.locator('[data-event-questions]')).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('[data-event-allow]')).toHaveCount(0);

    await row.locator('[data-event-questions]').click();
    const list = row.getByTestId('event-question-list');
    // the fake's FAKE_QUESTION_ONE, copied from a real CLI capture
    await expect(list).toContainText('Which colour do you prefer?');
    await expect(list).toContainText('Red · Green · Blue');

    // Needed keeps a session that is waiting on you; By session keeps it too
    for (const f of ['needed', 'by-session', 'all']) {
      await w.locator(`[data-events-filter="${f}"]`).click();
      await expect(w.locator(`[data-events-filter="${f}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expect(row).toBeVisible();
    }
    // the question is still held: listing it answered nothing
    expect(await heldIds(w)).toHaveLength(1);
  });
});
