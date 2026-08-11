// P2-E7-06: a blank task label fills itself from the title the CLI writes into
// its own transcript (§5.11).
//
// The fake provider writes no transcript, so — as in `feed.spec.ts` and
// `binding.spec.ts` — the test plays Claude's part and writes JSONL into the
// isolated HOME. The `ai-title` lines it writes are REAL, captured from
// transcripts in `~/.claude/projects/`: the key order is not stable and the CLI
// revises its answer, and a hand-written fixture would prove neither.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, retype, tempProjectFolder } from './fixtures/app';
import { REVISED, titlesOf } from '../src/main/transcripts/fixtures/ai-title';

function slugForCwd(cwd: string): string {
  return cwd.replace(/[\\/:. ]/g, '-');
}

const [FIRST_TITLE, SETTLED_TITLE] = titlesOf(REVISED);

/** The CLI's part: a transcript this session can claim, and the title lines. */
function writeTranscript(home: string, folder: string, titleLines: string[]): void {
  const dir = path.join(home, '.claude', 'projects', slugForCwd(folder));
  fs.mkdirSync(dir, { recursive: true });
  const line = (o: Record<string, unknown>) =>
    JSON.stringify({ sessionId: 'native-e2e', cwd: folder, timestamp: new Date().toISOString(), ...o }) +
    '\n';
  fs.writeFileSync(
    path.join(dir, 'native-e2e.jsonl'),
    line({ type: 'user', message: { role: 'user', content: 'add a markdown preview' } }) +
      titleLines.map((l) => l + '\n').join('')
  );
}

test.describe('auto task labels (E7-06)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('a blank label fills itself from the CLI title, and tracks its revision', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible();

    // the placeholder is what a card with no label reads as today
    await expect(w.getByText('+ task label')).toBeVisible();

    // The CLI's FIRST answer and its second, in the order and the two key
    // orders a real transcript had them.
    writeTranscript(a.home, folder, [REVISED.lines[0][1]]);
    await expect(w.getByText(FIRST_TITLE)).toBeVisible();

    fs.appendFileSync(
      path.join(a.home, '.claude', 'projects', slugForCwd(folder), 'native-e2e.jsonl'),
      REVISED.lines[1][1] + '\n'
    );
    // it keeps tracking while the label is nobody's
    await expect(w.getByText(SETTLED_TITLE)).toBeVisible();
    await expect(w.getByText('+ task label')).toHaveCount(0);
  });

  test('typing a label pins it; clearing it hands it back to auto', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText('+ task label')).toBeVisible();

    // TYPE one. It is now the user's, for ever.
    await w.getByText('+ task label').click();
    await retype(w.locator('input').first(), 'mine, thanks');
    await w.keyboard.press('Enter');
    await expect(w.getByText('mine, thanks')).toBeVisible();

    // the CLI names the conversation — and must not touch it
    writeTranscript(a.home, folder, [REVISED.lines[1][1]]);
    await w.waitForTimeout(1_500);
    await expect(w.getByText('mine, thanks')).toBeVisible();
    await expect(w.getByText(SETTLED_TITLE)).toHaveCount(0);

    // CLEAR it, and auto takes over again — the CLI re-emits every turn
    await w.getByText('mine, thanks').click();
    await retype(w.locator('input').first(), '');
    await w.keyboard.press('Enter');
    fs.appendFileSync(
      path.join(a.home, '.claude', 'projects', slugForCwd(folder), 'native-e2e.jsonl'),
      REVISED.lines[2][1] + '\n'
    );
    await expect(w.getByText(SETTLED_TITLE)).toBeVisible();
  });

  test('the switch takes the phrase off screen, and puts it back', async () => {
    // The screen-share case (§5.11, litmus #4): the label is derived from what
    // was asked, so there has to be a way to stop showing it — and it must not
    // destroy a label the user typed.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    writeTranscript(a.home, folder, [REVISED.lines[1][1]]);
    await expect(w.getByText(SETTLED_TITLE)).toBeVisible();

    await w.getByTestId('auto-labels').click();
    await expect(w.getByText(SETTLED_TITLE)).toHaveCount(0);
    await expect(w.getByText('+ task label')).toBeVisible();

    await w.getByTestId('auto-labels').click();
    await expect(w.getByText(SETTLED_TITLE)).toBeVisible();
  });

  test('a transcript with no ai-title line looks exactly as it does today', async () => {
    // The fail-open case. The key is undocumented and any CLI release may
    // rename or drop it; this is what the app looks like when it does.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;

    writeTranscript(a.home, folder, [
      JSON.stringify({ type: 'ai-title', sessionId: 'native-e2e', cwd: folder, conversationTitle: 'renamed' }),
    ]);
    await expect(w.getByText('add a markdown preview')).toBeVisible(); // transcript IS bound
    await expect(w.getByText('+ task label')).toBeVisible(); // …and the label is untouched
  });
});
