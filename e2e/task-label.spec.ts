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

    // THREE STATES ON ONE CHIP as of #758, and since #883 the cycle STARTS at
    // ✨ AI labels: AI → auto → off → AI. Reaching the screen-share state is
    // two clicks from the default, not one — the cost of the bar having no room
    // for a second chip (#879). The assertions are unchanged: what is being
    // tested is that the phrase leaves the screen and comes back, not how many
    // clicks it takes.
    await w.getByTestId('auto-labels').click(); // AI → auto (still showing)
    await expect(cardLabel(w)).toHaveText(SETTLED_TITLE);
    await w.getByTestId('auto-labels').click(); // auto → off
    await expect(cardLabel(w)).toHaveText('+ task label');
    await expect(railRow(w, SETTLED_TITLE)).toHaveCount(0); // and off the rail

    await w.getByTestId('auto-labels').click(); // off → AI
    await expect(cardLabel(w)).toHaveText(SETTLED_TITLE);
  });

  test('the size setting clamps the label, on open cards, and survives a relaunch', async () => {
    // #877. TWO claims no unit test can make, and they are the two that matter:
    //
    //  • the change reaches a card that is ALREADY OPEN. A dockview panel's
    //    params are fixed when it is created, so the only route to a live card
    //    is the store — a version that passed the size as a param would look
    //    perfect in every screenshot and change nothing until you reopened the
    //    card;
    //  • it survives a relaunch, which means it reached main and the workspace
    //    file rather than living in React state.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const first = a;
    const w = first.window;
    writeTranscript(first.home, folder, [REVISED.lines[1][1]]);
    await expect(cardLabel(w)).toHaveText(SETTLED_TITLE);

    // The COMPUTED clamp, because that is the only thing the setting does.
    const clamp = (page: Page): Promise<string> =>
      page
        .locator('[data-rail-label]')
        .first()
        .evaluate((el) => getComputedStyle(el).webkitLineClamp);
    // ⚠️ THE CARD HEADER IS THE ONE THAT PROVES THE STORE ROUTE. The rail takes
    // the size as an ordinary React prop; the header cannot, because dockview
    // fixes a panel's params when the panel is created. So a wiring that
    // updated React state and skipped the store would keep this assertion green
    // on the rail and change nothing on the card in front of the user.
    const headerClamp = (page: Page): Promise<string> =>
      cardLabel(page).evaluate((el) => getComputedStyle(el).webkitLineClamp);
    expect(await clamp(w)).toBe('3'); // Full, the default
    expect(await headerClamp(w)).toBe('3');

    // …through the palette, which is the door the manual sends people to
    await w.keyboard.press('Control+Shift+P');
    await w.getByPlaceholder('Type a command or a session name…').fill('task label size');
    await w.keyboard.press('Enter');
    // #885: `view.taskLabelSize` is an alias now — it opens Settings at its
    // Appearance section, where the radio group lives.
    const dialog = w.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();

    await dialog.locator('[data-task-label-size="compact"]').click();
    await expect.poll(() => clamp(w)).toBe('1');
    await expect.poll(() => headerClamp(w)).toBe('1'); // the open card, live
    await w.keyboard.press('Escape');

    // AND IT STICKS. A relaunch, not a re-render: this is the half that proves
    // the pick reached the workspace file.
    await first.close();
    a = await launchApp({ home: first.home });
    const w2 = a.window;
    await expect(w2.locator('[data-rail-label]').first()).toBeVisible({ timeout: 25_000 });
    expect(await clamp(w2)).toBe('1');
    expect(await headerClamp(w2)).toBe('1');
    // …and the dialog opens showing what is actually stored, not the default
    await w2.keyboard.press('Control+Shift+P');
    await w2.getByPlaceholder('Type a command or a session name…').fill('task label size');
    await w2.keyboard.press('Enter');
    await expect(w2.locator('[data-task-label-size="compact"]')).toBeChecked();
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
