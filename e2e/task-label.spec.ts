// P2-E7-06: a blank task label fills itself from the title the CLI writes into
// its own transcript (§5.11).
//
// TWO HALVES, AND ONLY ONE OF THEM IS STILL WRITTEN BY HAND (#952).
//
// The CONVERSATION comes from the session now. This file used to write the whole
// transcript itself, including a `user` line whose text doubled as the proof that
// binding had succeeded — which only worked because the shell-in-a-PTY fake made
// every test session a PTY and switched `deriveFeed` on. The fake CLI mirrors its
// turn into its own JSONL exactly as the real one does in stream mode, so
// `converse()` produces a transcript the watcher claims AND a block the Feed
// renders, and "transcript bound" is provable again.
//
// The `ai-title` LINES are still appended by hand, and must be: nothing emits
// them but Claude Code, on an undocumented key. They are REAL, captured from
// transcripts in `~/.claude/projects/` — the key order is not stable and the CLI
// revises its answer, and a hand-written fixture would prove neither. They carry
// their own `sessionId` from the session they were captured in, which is not this
// one and never was; the reader takes the title off the line it is on rather than
// cross-checking it, and that is the behaviour under test.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, retype, streamPrompter, tempProjectFolder } from './fixtures/app';
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

/**
 * The transcript the session is actually bound to.
 *
 * Found rather than named (#952). It used to be `native-e2e.jsonl`, because the
 * test wrote it; the fake CLI names its own after the `session_id` it announces,
 * which is generated. One file per isolated HOME per folder, so "the only
 * `.jsonl` under this folder's slug" identifies it — and the throw matters,
 * because two files here would mean the watcher had a choice to make and an
 * append could land in the transcript nobody is reading.
 */
function boundTranscript(home: string, folder: string): string {
  const dir = path.join(home, '.claude', 'projects', slugForCwd(folder));
  const found = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one transcript under ${dir}, found ${found.length}: ${found.join(', ')}`
    );
  }
  return path.join(dir, found[0]);
}

/**
 * Run a real turn, so there is a transcript to claim and a block to see.
 *
 * `REPLY` is what the Feed shows for it, and every "transcript bound" assertion
 * below reads that instead of a `user` line this file wrote — the Feed is built
 * from typed messages, not from the file.
 */
const PROMPT = 'add a markdown preview';
const REPLY = `FAKE-REPLY: ${PROMPT}`;

async function converse(app: LaunchedApp, folder: string): Promise<void> {
  await streamPrompter(app)(path.basename(folder), PROMPT);
  await expect(app.window.getByText(REPLY)).toBeVisible({ timeout: 25_000 });
}

/** The CLI's other part: `ai-title` lines, into the transcript it is writing. */
function appendTitles(home: string, folder: string, titleLines: string[]): void {
  fs.appendFileSync(boundTranscript(home, folder), titleLines.map((l) => l + '\n').join(''));
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

    // A real turn first — the CLI has to be writing a transcript before it can
    // put a title in one. Sending a prompt is itself an auto source (#883, the
    // provisional label: the owner's own prompt, cleaned, filling a blank so the
    // card is not empty through the whole first turn), so the state between the
    // turn and the title is the PROMPT rather than the placeholder. That is the
    // ladder this test walks — provisional, then the CLI's first answer, then its
    // revision — and every rung after the first must supersede the one before it.
    await converse(a, folder);
    await expect(cardLabel(w)).toHaveText(PROMPT);

    // The CLI's FIRST answer, then its second, in the order and the two key
    // orders a real transcript had them.
    appendTitles(a.home, folder, [REVISED.lines[0][1]]);
    await expect(cardLabel(w)).toHaveText(FIRST_TITLE);

    appendTitles(a.home, folder, [REVISED.lines[1][1]]);
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
    await converse(a, folder); // transcript bound
    appendTitles(a.home, folder, [REVISED.lines[1][1]]);
    await w.waitForTimeout(1_000);
    await expect(cardLabel(w)).toHaveText('mine, thanks');

    // CLEAR it, and auto takes over again — the CLI re-emits every turn
    await cardLabel(w).click();
    // `fill('')` and not `retype`: select-all followed by typing nothing leaves
    // the text SELECTED, so the blur would commit the very label being cleared.
    await labelBox(w).fill('');
    await w.keyboard.press('Enter');
    appendTitles(a.home, folder, [REVISED.lines[2][1]]);
    await expect(cardLabel(w)).toHaveText(SETTLED_TITLE);
  });

  test('the switch takes the phrase off screen, and puts it back', async () => {
    // The screen-share case (§5.11, litmus #4): the label is derived from what
    // was asked, so there has to be a way to stop showing it.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await converse(a, folder);
    appendTitles(a.home, folder, [REVISED.lines[1][1]]);
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
    await converse(first, folder);
    appendTitles(first.home, folder, [REVISED.lines[1][1]]);
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

    await converse(a, folder); // transcript IS bound
    appendTitles(a.home, folder, [
      JSON.stringify({ type: 'ai-title', sessionId: 'native-e2e', cwd: folder, conversationTitle: 'renamed' }),
    ]);
    // …and the label is UNTOUCHED: still the provisional one the prompt set
    // (#883), never `renamed`. "Exactly as it does today" is the provisional
    // rather than the placeholder now, which is a stronger check than the
    // placeholder was — it pins that the unreadable line changed nothing, where
    // an empty card could also have meant nothing had happened at all.
    await expect(cardLabel(w)).toHaveText(PROMPT);
    await expect(w.getByText('renamed')).toHaveCount(0);
  });
});
