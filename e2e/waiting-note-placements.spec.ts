// #1600: the automatic waiting note goes away when you send a prompt, in EVERY
// placement and by BOTH gestures. Dan saw it stay up under the header
// (placement B) while it cleared above the prompt (A). `session-note.spec.ts`
// proves the clear once, through IPC and in placement A only; this sends from
// the real composer, with Enter and with the send arrow, in A, B, C and D.
import { test, expect, Page } from '@playwright/test';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const composer = (w: Page) => w.getByPlaceholder(/^Message .+…$/);

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

async function settings(w: Page, act: (dialog: ReturnType<Page['getByRole']>) => Promise<void>): Promise<void> {
  await w.keyboard.press('Control+,');
  const dialog = w.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await act(dialog);
  await w.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

// what each placement shows of a waiting note: D shows a chip, the rest the paper
const PLACEMENTS = [
  { id: 'prompt', shown: '[data-waiting-note]' },
  { id: 'header', shown: '[data-waiting-note]' },
  { id: 'corner', shown: '[data-waiting-note]' },
  { id: 'chip', shown: '[data-waiting-chip]' },
] as const;

test.describe('the waiting note clears on send, in every placement (#1600)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  for (const p of PLACEMENTS) {
    test(`placement ${p.id}: Enter and the send arrow both clear it`, async () => {
      a = await launchApp({
        seedFolder: tempProjectFolder(),
        env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_E2E_NOTE_BUS: '1' },
      });
      const w = a.window;
      const id = await liveId(a);
      await settings(w, async (dialog) => {
        const box = dialog.locator('[data-settings-field="waitingNotes"]');
        await expect(box).toBeEnabled();
        await box.check();
        await expect(box).toBeChecked();
        await dialog.locator(`[data-note-placement-option="${p.id}"]`).check();
      });
      const shown = w.locator(p.shown);

      // Enter
      expect((await waitingSets(a, id, 'Need your call')).ok).toBe(true);
      await expect(shown).toBeVisible();
      await composer(w).fill('go with v1');
      await composer(w).press('Enter');
      await expect(shown).toHaveCount(0, { timeout: 25_000 });

      // the send arrow (wait for the first turn to finish so the arrow is live)
      await expect(w.getByTitle('Send to the session')).toBeVisible({ timeout: 25_000 });
      expect((await waitingSets(a, id, 'Need a review')).ok).toBe(true);
      await expect(shown).toBeVisible();
      await composer(w).fill('looks good');
      await w.getByTitle('Send to the session').click();
      await expect(shown).toHaveCount(0, { timeout: 25_000 });
    });
  }
});
