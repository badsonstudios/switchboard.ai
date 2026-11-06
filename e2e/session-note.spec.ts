// A session's sticky note (#1544, part 1): the card's 📝 button, the strip
// above the prompt (placement A), Enter/Esc, quick picks, × deletes, and the
// note surviving a relaunch. Unit tests pin each decision; this proves the
// whole path through main and the workspace file, in the real window.
import { test, expect, Page } from '@playwright/test';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

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
