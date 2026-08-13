// P2-E7-06: a blank task label fills itself from the title the CLI writes into
// its own transcript (§5.11).
//
// The fake provider writes no transcript, so — as in `feed.spec.ts` and
// `binding.spec.ts` — the test plays Claude's part and writes JSONL into the
// isolated HOME. The `ai-title` lines it writes are REAL, captured from
// transcripts in `~/.claude/projects/`: the key order is not stable and the CLI
// revises its answer, and a hand-written fixture would prove neither.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, retype, tempProjectFolder } from './fixtures/app';
import { REVISED, titlesOf } from '../src/main/transcripts/fixtures/ai-title';

function slugForCwd(cwd: string): string {
  return cwd.replace(/[\\/:. ]/g, '-');
}

const [FIRST_TITLE, SETTLED_TITLE] = titlesOf(REVISED);

/**
 * The card header's label.
 *
 * A test id and not its words, because §5.11 says a session's identity renders
 * on every surface it appears on and this one duly appears TWICE — in the card
 * header and folded into the rail row's accessible name. Locating it by text
 * is a strict-mode violation, which is the feature working rather than a flake.
 */
const cardLabel = (w: Page) => w.getByTestId('card-task-label');

/** The header's edit box, open only while the label is being typed into. */
const labelBox = (w: Page) => w.getByTestId('card-header').locator('input');

/** The rail row's accessible name, where the label rides as detail. */
const railRow = (w: Page, label: string) =>
  w.getByRole('button', { name: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });

function transcriptPath(home: string, folder: string): string {
  return path.join(home, '.claude', 'projects', slugForCwd(folder), 'native-e2e.jsonl');
}

/** The CLI's part: a transcript this session can claim, plus title lines. */
function writeTranscript(home: string, folder: string, titleLines: string[]): void {
  const file = transcriptPath(home, folder);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = (o: Record<string, unknown>) =>
    JSON.stringify({ sessionId: 'native-e2e', cwd: folder, timestamp: new Date().toISOString(), ...o }) +
    '\n';
  fs.writeFileSync(
    file,
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
    await expect(cardLabel(w)).toHaveText('+ task label');

    // The CLI's FIRST answer, then its second, in the order and the two key
    // orders a real transcript had them.
    writeTranscript(a.home, folder, [REVISED.lines[0][1]]);
    await expect(cardLabel(w)).toHaveText(FIRST_TITLE);

    fs.appendFileSync(transcriptPath(a.home, folder), REVISED.lines[1][1] + '\n');
    // it keeps tracking while the label is nobody's...
    await expect(cardLabel(w)).toHaveText(SETTLED_TITLE);
    // ...and it renders on the rail too, in the row's accessible name (§5.11)
    await expect(railRow(w, SETTLED_TITLE)).toHaveCount(1);
  });

  test('typing a label pins it; clearing it hands it back to auto', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(cardLabel(w)).toHaveText('+ task label');

    // TYPE one. It is now the user's, for ever.
    await cardLabel(w).click();
    await retype(labelBox(w), 'mine, thanks');
    await w.keyboard.press('Enter');
    await expect(cardLabel(w)).toHaveText('mine, thanks');

    // the CLI names the conversation — and must not touch it
    writeTranscript(a.home, folder, [REVISED.lines[1][1]]);
    await expect(w.getByText('add a markdown preview')).toBeVisible(); // transcript bound
    await w.waitForTimeout(1_000);
    await expect(cardLabel(w)).toHaveText('mine, thanks');

    // CLEAR it, and auto takes over again — the CLI re-emits every turn
    await cardLabel(w).click();
    // `fill('')` and not `retype`: select-all followed by typing nothing leaves
    // the text SELECTED, so the blur would commit the very label being cleared.
    await labelBox(w).fill('');
    await w.keyboard.press('Enter');
    fs.appendFileSync(transcriptPath(a.home, folder), REVISED.lines[2][1] + '\n');
    await expect(cardLabel(w)).toHaveText(SETTLED_TITLE);
  });

  test('the switch takes the phrase off screen, and puts it back', async () => {
    // The screen-share case (§5.11, litmus #4): the label is derived from what
    // was asked, so there has to be a way to stop showing it.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    writeTranscript(a.home, folder, [REVISED.lines[1][1]]);
    await expect(cardLabel(w)).toHaveText(SETTLED_TITLE);

    await w.getByTestId('auto-labels').click();
    await expect(cardLabel(w)).toHaveText('+ task label');
    await expect(railRow(w, SETTLED_TITLE)).toHaveCount(0); // and off the rail

    await w.getByTestId('auto-labels').click();
    await expect(cardLabel(w)).toHaveText(SETTLED_TITLE);
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
    await expect(cardLabel(w)).toHaveText('+ task label'); // …and the label is untouched
  });
});
