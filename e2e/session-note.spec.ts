// A session's sticky note (#1544, part 1): the card's 📝 button, the strip
// above the prompt (placement A), Enter/Esc, quick picks, × deletes, and the
// note surviving a relaunch. Unit tests pin each decision; this proves the
// whole path through main and the workspace file, in the real window.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, streamPrompter, tempProjectFolder } from './fixtures/app';

const noteButton = (w: Page) => w.getByTestId('card-note');
const strip = (w: Page) => w.locator('[data-session-note]');
const noteBox = (w: Page) => w.locator('[data-note-input]');
const noteText = (w: Page) => w.locator('[data-note-text]');

test.describe('session sticky note (#1544)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('add, edit, cancel, delete, and it survives a relaunch', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const first = a;
    const w = first.window;

    // no note: no strip, and the button offers to add one
    await expect(noteButton(w)).toBeVisible({ timeout: 25_000 });
    await expect(noteButton(w)).toHaveAttribute('data-has-note', 'false');
    await expect(strip(w)).toHaveCount(0);

    // add one through a quick pick, finished by typing, saved with Enter
    await noteButton(w).click();
    await expect(noteBox(w)).toBeFocused();
    await w.locator('[data-note-pick="sessionNote.pick.waiting"]').click();
    await expect(noteBox(w)).toHaveValue('Waiting on ');
    await noteBox(w).press('End');
    await noteBox(w).pressSequentially('Tanner');
    await noteBox(w).press('Enter');
    await expect(noteText(w)).toHaveText('Waiting on Tanner');
    await expect(w.locator('[data-note-meta]')).toContainText('You');
    await expect(noteButton(w)).toHaveAttribute('data-has-note', 'true');

    // the strip sits above the composer (placement A)
    const noteBottom = await strip(w).evaluate((el) => el.getBoundingClientRect().bottom);
    const composerTop = await w
      .locator('textarea')
      .last()
      .evaluate((el) => el.getBoundingClientRect().top);
    expect(noteBottom).toBeLessThanOrEqual(composerTop);

    // Esc cancels an edit; the session keeps running
    await noteText(w).click();
    await noteBox(w).fill('something else');
    await noteBox(w).press('Escape');
    await expect(noteText(w)).toHaveText('Waiting on Tanner');

    // the header button edits the note that is there
    await noteButton(w).click();
    await expect(noteBox(w)).toHaveValue('Waiting on Tanner');
    await noteBox(w).fill('Need a PR review');
    await noteBox(w).press('Enter');
    await expect(noteText(w)).toHaveText('Need a PR review');

    // AND IT STICKS: a relaunch, so it reached main and the workspace file
    await first.close();
    a = await launchApp({ home: first.home });
    const w2 = a.window;
    await expect(noteText(w2)).toHaveText('Need a PR review', { timeout: 25_000 });

    // × deletes it for good
    await w2.locator('[data-note-delete]').click();
    await expect(strip(w2)).toHaveCount(0);
    await expect(noteButton(w2)).toHaveAttribute('data-has-note', 'false');
  });

  test('the button works from the Changes tab, and focus comes back to it', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(noteButton(w)).toBeVisible({ timeout: 25_000 });
    await w.getByRole('tab', { name: 'Changes' }).first().click();
    await noteButton(w).click();
    // the card switches to the Session tab, where the note lives
    await expect(noteBox(w)).toBeVisible();
    await expect(noteBox(w)).toBeFocused();
    await noteBox(w).fill('from the Changes tab');
    await noteBox(w).press('Enter');
    await expect(noteText(w)).toHaveText('from the Changes tab');
    await expect(noteButton(w)).toBeFocused();
  });

  test('the placement setting moves the note; the rail marks it (part 2)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const first = a;
    const w = first.window;
    await noteButton(w).click({ timeout: 25_000 });
    await noteBox(w).fill('Need a PR review');
    await noteBox(w).press('Enter');
    await expect(strip(w)).toHaveAttribute('data-note-placement', 'band');

    // the rail marks the session, with the note on hover
    const marker = w.locator('[data-rail-note]').first();
    await expect(marker).toBeVisible();
    await expect(marker).toHaveAttribute('title', 'Note: Need a PR review');

    const pick = async (p: string): Promise<void> => {
      await w.keyboard.press('Control+,');
      const dialog = w.getByRole('dialog', { name: 'Settings' });
      await expect(dialog).toBeVisible();
      await dialog.locator(`[data-note-placement-option="${p}"]`).check();
      await w.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    };

    // B: under the title bar, and still there on the Changes tab
    await pick('header');
    await expect(strip(w)).toHaveCount(1);
    await expect(strip(w)).toHaveAttribute('data-note-placement', 'line');
    await w.getByRole('tab', { name: 'Changes' }).first().click();
    await expect(strip(w)).toBeVisible();
    await w.getByRole('tab', { name: 'Session' }).first().click();

    // C: the corner sticky over the conversation
    await pick('corner');
    await expect(strip(w)).toHaveAttribute('data-note-placement', 'corner');
    await expect(strip(w)).toBeVisible();

    // D: a chip in the title bar that opens the note
    await pick('chip');
    await expect(strip(w)).toHaveCount(0);
    const chip = w.locator('[data-note-chip]');
    await expect(chip).toHaveText('Need a PR review');
    await chip.click();
    await expect(strip(w)).toHaveAttribute('data-note-placement', 'popover');
    await noteText(w).click();
    await noteBox(w).fill('Need more research');
    await noteBox(w).press('Enter');
    await expect(chip).toHaveText('Need more research');

    // the choice survives a relaunch
    await first.close();
    a = await launchApp({ home: first.home });
    await expect(a.window.locator('[data-note-chip]')).toHaveText('Need more research', { timeout: 25_000 });
  });

  test('saving empty text deletes the note', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await noteButton(w).click({ timeout: 25_000 });
    await noteBox(w).fill('temporary');
    await noteBox(w).press('Enter');
    await expect(noteText(w)).toHaveText('temporary');
    await noteText(w).click();
    await noteBox(w).fill('');
    await noteBox(w).press('Enter');
    await expect(strip(w)).toHaveCount(0);
  });
});

// Part 3 (#1544): the session's AI writes the note through its switchboard
// tool, and "Let Claude write it" asks it to. The fake AI has no bus, so the
// spec plays the tool call through the production handler (a non-packaged
// seam), and the seam's flag tells the button the session has the tools.
test.describe('the AI writes the note (#1544 part 3)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  async function liveIdOf(app: LaunchedApp): Promise<string> {
    for (let i = 0; i < 100; i++) {
      const cards = (await app.window.evaluate(() => window.switchboard.sessions.cards())) as Array<{
        liveId?: string;
      }>;
      if (cards[0]?.liveId) return cards[0].liveId;
      await app.window.waitForTimeout(200);
    }
    throw new Error('no live session');
  }

  const aiSets = (app: LaunchedApp, liveId: string, text: string): Promise<unknown> =>
    app.app.evaluate(
      (_e, [id, t]) =>
        (globalThis as unknown as { __switchboardSetSessionNote: (i: string, t: string) => unknown }).__switchboardSetSessionNote(
          id,
          t
        ),
      [liveId, text] as const
    );

  test("an AI's note shows as the AI's, in blue, on the card and the rail; editing makes it yours", async () => {
    a = await launchApp({
      seedFolder: tempProjectFolder(),
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_E2E_NOTE_BUS: '1' },
    });
    const w = a.window;
    const liveId = await liveIdOf(a);
    await aiSets(a, liveId, 'Blocked: need your call on the retry limit');
    await expect(noteText(w)).toHaveText('Blocked: need your call on the retry limit');
    await expect(strip(w)).toHaveAttribute('data-note-by', 'ai');
    await expect(w.locator('[data-note-meta]')).toContainText('✦');
    await expect(w.locator('[data-rail-note]').first()).toHaveAttribute('data-note-by', 'ai');
    await expect(w.locator('[data-rail-note]').first()).toHaveAttribute(
      'title',
      'Note from the AI: Blocked: need your call on the retry limit'
    );
    // edit it, and it becomes the user's
    await noteText(w).click();
    await noteBox(w).fill('Decided: keep it at three');
    await noteBox(w).press('Enter');
    await expect(strip(w)).toHaveAttribute('data-note-by', 'user');
    // and the AI can clear it
    await aiSets(a, liveId, '');
    await expect(strip(w)).toHaveCount(0);
  });

  test('"Let Claude write it" sends the session one prompt that asks for the note', async () => {
    a = await launchApp({
      seedFolder: tempProjectFolder(),
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_E2E_NOTE_BUS: '1' },
    });
    const w = a.window;
    await liveIdOf(a);
    await noteButton(w).click({ timeout: 25_000 });
    const ask = w.locator('[data-note-ask-ai]');
    await expect(ask).toBeVisible();
    await ask.click();
    // the editor closes, and the request is a visible turn in the conversation
    await expect(noteBox(w)).toHaveCount(0);
    await expect(w.locator('[data-feed-block="user"]', { hasText: 'set_session_note' })).toBeVisible({
      timeout: 25_000,
    });
  });
});

// Part 4 (#1544): the automatic waiting note. The fake AI has no hooks and no
// bus, so the spec plays the agent's `set_waiting_note` through the production
// handler (the non-packaged seam) and sends a real prompt through the composer
// path to prove the clear.
test.describe('the automatic waiting note (#1544 part 4)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  const waitingSets = (app: LaunchedApp, liveId: string, text: string): Promise<{ ok: boolean }> =>
    app.app.evaluate(
      (_e, [id, t]) =>
        (
          globalThis as unknown as { __switchboardSetWaitingNote: (i: string, t: string) => { ok: boolean } }
        ).__switchboardSetWaitingNote(id, t),
      [liveId, text] as const
    );

  async function liveId(app: LaunchedApp): Promise<string> {
    for (let i = 0; i < 100; i++) {
      const cards = (await app.window.evaluate(() => window.switchboard.sessions.cards())) as Array<{ liveId?: string }>;
      if (cards[0]?.liveId) return cards[0].liveId;
      await app.window.waitForTimeout(200);
    }
    throw new Error('no live session');
  }

  async function setWaitingNotes(app: LaunchedApp, on: boolean): Promise<void> {
    const w = app.window;
    await w.keyboard.press('Control+,');
    const dialog = w.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    const box = dialog.locator('[data-settings-field="waitingNotes"]');
    // wait for main's answer: the box is disabled until it has one
    await expect(box).toBeEnabled();
    if (on) await box.check();
    else await box.uncheck();
    if (on) await expect(box).toBeChecked();
    else await expect(box).not.toBeChecked();
    await w.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }

  test('off by default; on, it shows yellow beside the sticky note, and the next prompt clears it', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_E2E_NOTE_BUS: '1' },
    });
    const w = a.window;
    const id = await liveId(a);
    const waiting = w.locator('[data-waiting-note]');

    // OFF by default: the agent's call is refused and nothing shows
    expect((await waitingSets(a, id, 'Need your call')).ok).toBe(false);
    await expect(waiting).toHaveCount(0);

    await setWaitingNotes(a, true);
    // a sticky note of the user's own, to prove the two are separate
    await noteButton(w).click();
    await noteBox(w).fill('my own note');
    await noteBox(w).press('Enter');

    expect((await waitingSets(a, id, 'Need your call: keep the v1 API or break it?')).ok).toBe(true);
    await expect(waiting).toBeVisible();
    await expect(w.locator('[data-waiting-text]')).toHaveText('Need your call: keep the v1 API or break it?');
    await expect(noteText(w)).toHaveText('my own note');
    await expect(w.locator('[data-rail-waiting-note]').first()).toHaveAttribute(
      'title',
      'Waiting on you: Need your call: keep the v1 API or break it?'
    );

    // the next prompt clears the waiting note, and only it
    await streamPrompter(a)(path.basename(folder), 'keep v1');
    await expect(waiting).toHaveCount(0, { timeout: 25_000 });
    await expect(w.locator('[data-rail-waiting-note]')).toHaveCount(0);
    await expect(noteText(w)).toHaveText('my own note');

    // × dismisses one by hand
    await waitingSets(a, id, 'Need a review');
    await expect(waiting).toBeVisible();
    await w.locator('[data-waiting-dismiss]').click();
    await expect(waiting).toHaveCount(0);

    // and switched off again, the agent is refused
    await setWaitingNotes(a, false);
    expect((await waitingSets(a, id, 'x')).ok).toBe(false);
  });
});
