// A past question reads as a question and its answer, not as JSON (#1201).
//
// The owner: "when you go back into the session and scroll up to where the
// questions were asked, it's displayed in what looks like JSON … I need nice
// output formatting so we can easily read it in English."
//
// Two claims that need the real app:
//   1. LIVE: the block the stream produces is the readable one.
//   2. REPLAY: quit, relaunch, and the resumed conversation shows the same.
//      That is where the owner saw JSON, and it is a different code path: the
//      blocks are rebuilt from the transcript on disk.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder, readWorkspaceFile } from './fixtures/app';
import { FAKE_SESSION_ID } from '../src/main/providers/fake-stream-ids';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const composer = (w: Page) => w.getByPlaceholder(/Prompt this session/);
const box = (w: Page) => w.locator('[data-feed-box="question"]');

/** the block says what was asked, what was chosen and what was skipped */
async function expectReadable(w: Page): Promise<void> {
  await expect(box(w)).toHaveCount(1, { timeout: 60_000 });
  const questions = box(w).locator('[data-question]');
  await expect(questions).toHaveCount(2);

  // the first: the sentence, its label, what was offered, and the one chosen
  const colour = questions.nth(0);
  await expect(colour.locator('[data-question-text]')).toHaveText('Which colour do you prefer?');
  await expect(colour).toContainText('Colour');
  await expect(colour).toContainText('Prefer green');
  await expect(colour.locator('[data-question-option="chosen"]')).toHaveCount(1);
  await expect(colour.locator('[data-question-option="chosen"]')).toContainText('Red');

  // the second was skipped, and says so; nothing is ticked
  const langs = questions.nth(1);
  await expect(langs.locator('[data-question-text]')).toHaveText(
    'Which of these languages do you use?'
  );
  await expect(langs.locator('[data-question-skipped]')).toHaveText('Skipped');
  await expect(langs.locator('[data-question-option="chosen"]')).toHaveCount(0);

  await expect(box(w).locator('[data-question-state]')).toHaveText('answered');
  // NO JSON on screen, and it is not the generic tool row any more
  await expect(box(w)).not.toContainText('"questions"');
  await expect(box(w).locator('pre')).toHaveCount(0);
}

test.describe('a past question, read back (#1201)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  test('live, and again after a restart: questions and answers in English', async () => {
    test.setTimeout(240_000);
    const folder = tempProjectFolder();
    const first = await launchApp({ seedFolder: folder, env: DIRECT });
    a = first;
    const w1 = first.window;
    await expect(w1.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    await composer(w1).click();
    await composer(w1).fill('!asked');
    await composer(w1).press('Enter');
    await expect(w1.getByText('ASKED_PROSE').first()).toBeAttached({ timeout: 60_000 });

    // 1. LIVE
    await expectReadable(w1);

    // the raw call is one click away, behind the standard expander
    await box(w1).locator('[aria-expanded]').first().click();
    await expect(box(w1).locator('pre')).toContainText('"questions"');
    await expect(box(w1).locator('pre')).toContainText('"multiSelect"');
    await box(w1).locator('[aria-expanded]').first().click();
    await expect(box(w1).locator('pre')).toHaveCount(0);

    // 2. REPLAY: quit and come back to the same conversation
    await expect(() => {
      const card = readWorkspaceFile(first.home).sessions?.[0];
      expect(card?.nativeSessionId).toBe(FAKE_SESSION_ID);
    }).toPass({ timeout: 20_000 });
    await first.close();

    a = await launchApp({ home: first.home, env: DIRECT });
    const w2 = a.window;
    await expect(w2.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await expect(w2.getByText('ASKED_PROSE').first()).toBeAttached({ timeout: 60_000 });
    await expectReadable(w2);
  });
});
