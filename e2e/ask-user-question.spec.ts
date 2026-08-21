// #563 — the CLI's own question, answered in the session window.
//
// WHAT ONLY THIS FILE CAN PROVE. `QuestionPanel.test.tsx` shows the panel calls
// `onDecide` with the right payload; `ask-user-question.test.ts` shows the
// payload is the one the CLI accepted in the probe. Neither can show that the
// payload SURVIVES the trip — renderer → preload → `sessions:decidePermission`
// → `StreamPermissions.decide` → a `control_response` on the child's stdin —
// and arrives at the other end intact. That trip crosses three process
// boundaries and a validator whose whole job is to reject payloads, so it is
// exactly the kind of thing that passes every unit test and drops the answer.
//
// The fake echoes back the `answers` map it actually received (`!ask`, see
// `fake-stream-protocol.ts`), so every assertion below reads what reached "the
// CLI" rather than what the panel believed it sent.
//
// NO `SWITCHBOARD_TRANSPORT` in the Direct tests, deliberately — Direct is the
// default since #381 and a spec about the default must not name it, or it would
// keep passing on the day the default moved.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

/** the dual-capable fake, asked for nothing — i.e. the app's own default */
const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

const panel = (w: Page) => w.getByTestId('question-panel');
const option = (w: Page, questionIndex: number, label: string) =>
  w.locator(`[data-question-index="${questionIndex}"] [data-question-option="${label}"]`);
/** the tab for question `i` (#566) — only drawn when the call carries several */
const qtab = (w: Page, i: number) => w.locator(`[data-question-tab="${i}"]`);

/** the requests MAIN is still holding — renderer state cannot vouch for itself */
function heldIds(w: Page): Promise<string[]> {
  return w.evaluate(() =>
    window.switchboard.sessions.pendingPermissions().then((l) => l.map((p) => p.requestId))
  );
}

test.describe("the CLI's own questions (#563)", () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  // The headline. One pick-one and one multi-select in a single call — the
  // shape the real CLI produced in the probe — answered by clicking, with the
  // comma-joined multi-select string arriving intact at the far end.
  test('a question renders as clickable answers, and the answer reaches the CLI', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!ask');
    await box.press('Enter');

    await expect(panel(w)).toBeVisible({ timeout: 30_000 });
    // the CLI's own words, rendered verbatim — question, options, and the
    // per-option descriptions we did not write
    await expect(panel(w)).toContainText('Which colour do you prefer?');
    await expect(panel(w)).toContainText('Prefer red');
    // …and NOT the permission bar: a question and a permission must not both
    // occupy the dock, and the question is not "Allow AskUserQuestion?"
    await expect(w.getByText('Allow AskUserQuestion?')).toHaveCount(0);

    // TABS (#566). Two questions, so a real tab strip labelled by the CLI's own
    // `header` — and the second question is genuinely not on screen yet.
    await expect(qtab(w, 0)).toContainText('Colour');
    await expect(qtab(w, 1)).toContainText('Languages');
    await expect(qtab(w, 0)).toHaveAttribute('aria-selected', 'true');
    await expect(panel(w)).not.toContainText('Which of these languages do you use?');
    // which is exactly why the panel says, in words, what is still missing —
    // an off-screen question cannot explain a dead Submit by itself
    await expect(w.getByTestId('question-remaining')).toContainText('Colour');
    await expect(w.getByTestId('question-remaining')).toContainText('Languages');

    // arity is real, not decorative: radios for pick-one, checkboxes for multi
    await expect(option(w, 0, 'Red')).toHaveAttribute('role', 'radio');

    // a question is a session that needs you (§5.8) — same queue, same rail
    // state as any other ask, which is what makes this better than the terminal
    await expect(w.locator('nav .rail-row[data-session-status="needs-permission"]')).toHaveCount(1, {
      timeout: 15_000,
    });

    // Submit stays shut until every question has an answer — a partial answers
    // map is a shape the probe never measured, so we never send one
    await expect(w.getByTestId('question-submit')).toBeDisabled();
    await option(w, 0, 'Red').click();
    await expect(w.getByTestId('question-submit')).toBeDisabled();
    // the tab now says so — unmistakably, and in its accessible name rather
    // than only as a glyph (#566)
    await expect(qtab(w, 0)).toHaveAttribute('data-question-tab-answered', 'true');
    await expect(qtab(w, 0)).toHaveAttribute('aria-label', 'Colour — answered');
    await expect(qtab(w, 1)).toHaveAttribute('aria-label', 'Languages — not answered yet');
    // still naming the one that IS missing, and no longer the one that is not —
    // asserted in that order, so a line that vanished entirely cannot pass the
    // negative half by simply not being there
    await expect(w.getByTestId('question-remaining')).toContainText('Languages');
    await expect(w.getByTestId('question-remaining')).not.toContainText('Colour');

    // §5.32 — Left/Right walk the strip, and selection follows focus, so an
    // arrow can never leave the user looking at a tab they did not select
    await qtab(w, 0).focus();
    await w.keyboard.press('ArrowRight');
    await expect(qtab(w, 1)).toBeFocused();
    await expect(qtab(w, 1)).toHaveAttribute('aria-selected', 'true');
    await expect(panel(w)).toContainText('Which of these languages do you use?');
    await expect(option(w, 1, 'Rust')).toHaveAttribute('role', 'checkbox');

    await option(w, 1, 'TypeScript').click();
    await option(w, 1, 'Rust').click();
    await expect(w.getByTestId('question-submit')).toBeEnabled();
    await expect(w.getByTestId('question-remaining')).toHaveCount(0);

    // HALF AN ANSWER SURVIVES LEAVING THE PANEL. The Session panel is not kept
    // mounted, so going to look at the diff before deciding — the single most
    // likely thing a person does in the middle of "which of these three
    // approaches?" — unmounts the whole thing. The unit test pins the mechanism;
    // this is the real dockview tab switch it exists for.
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(panel(w)).toHaveCount(0, { timeout: 20_000 }); // genuinely gone
    await w.getByRole('tab', { name: 'Session', exact: true }).first().click();
    await expect(panel(w)).toBeVisible({ timeout: 20_000 });
    // both questions are answered, so it comes back on the first tab — and both
    // tabs come back saying so
    await expect(qtab(w, 0)).toHaveAttribute('aria-selected', 'true');
    await expect(qtab(w, 0)).toHaveAttribute('data-question-tab-answered', 'true');
    await expect(qtab(w, 1)).toHaveAttribute('data-question-tab-answered', 'true');
    await expect(option(w, 0, 'Red')).toHaveAttribute('aria-checked', 'true');
    await expect(w.getByTestId('question-submit')).toBeEnabled();

    await qtab(w, 1).click();
    await expect(option(w, 1, 'Rust')).toHaveAttribute('aria-checked', 'true');
    await expect(option(w, 1, 'TypeScript')).toHaveAttribute('aria-checked', 'true');

    await w.getByTestId('question-submit').click();

    // THE CLAIM: this is the fake reporting the `answers` map that came down its
    // own stdin. The multi-select arrived as ONE comma-space joined string,
    // which is the measured wire shape and not an array.
    await expect(
      w.getByText(
        'ANSWERS: Which colour do you prefer?=Red | Which of these languages do you use?=TypeScript, Rust'
      )
    ).toBeVisible({ timeout: 30_000 });

    // and nothing is left claiming a question, on either surface
    await expect(panel(w)).toHaveCount(0);
    await expect(w.locator('nav .rail-row[data-session-status="needs-permission"]')).toHaveCount(0, {
      timeout: 15_000,
    });
    expect(await heldIds(w)).toEqual([]);
  });

  // The owner's "Other" is not decoration — it is how a question that offers the
  // wrong four options stays answerable. Measured as first-class: the CLI
  // accepts an off-menu answer and even changes its own wording for one.
  test('Other takes free text, and the word "Other" never reaches the CLI', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!ask1');
    await box.press('Enter');

    await expect(panel(w)).toBeVisible({ timeout: 30_000 });
    // ONE question, so no tab furniture at all (#566) — the common call looks
    // exactly as it did before tabs existed
    await expect(w.locator('[data-testid="question-tabs"]')).toHaveCount(0);
    await expect(w.getByTestId('question-remaining')).toHaveCount(0);
    await option(w, 0, '__other__').click();
    // ticking Other puts the caret in the field it opens
    const field = w.locator('[data-question-other-input="0"]');
    await expect(field).toBeFocused();
    // still not answered: the word never crosses the wire, so an empty Other
    // would send "" — a different and worse thing than not answering
    await expect(w.getByTestId('question-submit')).toBeDisabled();

    await field.fill('chartreuse, obviously');
    await expect(w.getByTestId('question-submit')).toBeEnabled();
    await field.press('Enter'); // Enter in the field submits a complete panel

    await expect(w.getByText('ANSWERS: Which colour do you prefer?=chartreuse, obviously')).toBeVisible(
      { timeout: 30_000 }
    );
    await expect(w.getByText(/=Other/)).toHaveCount(0);
    expect(await heldIds(w)).toEqual([]);
  });

  // Refusing is a real answer and a safe one: measured, the CLI takes a deny as
  // an `is_error` tool result and asks again in prose rather than stalling. Not
  // answering at all is the dangerous case — 180s in the probe with no fallback
  // and no CLI-side timeout — which is why there is no "close this panel".
  test('declining answers the CLI rather than leaving it parked', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!ask1');
    await box.press('Enter');

    await expect(panel(w)).toBeVisible({ timeout: 30_000 });
    await w.getByTestId('question-dismiss').click();

    await expect(w.getByText('QUESTION DENIED')).toBeVisible({ timeout: 30_000 });
    await expect(panel(w)).toHaveCount(0);
    expect(await heldIds(w)).toEqual([]);
  });

  // §5.32 — answerable without a mouse, from the moment it arrives. Not a
  // separate nicety: the panel appears while the user's hands are on the
  // keyboard mid-prompt, which is the worst possible moment to require a mouse.
  test('is answerable from the keyboard alone', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!ask1');
    await box.press('Enter');

    await expect(panel(w)).toBeVisible({ timeout: 30_000 });
    // focus the first option, walk down with the arrow keys, tick with Space
    await option(w, 0, 'Red').focus();
    await w.keyboard.press('ArrowDown');
    await expect(option(w, 0, 'Green')).toBeFocused();
    await w.keyboard.press('ArrowDown');
    await expect(option(w, 0, 'Blue')).toBeFocused();
    await w.keyboard.press(' ');
    await expect(option(w, 0, 'Blue')).toHaveAttribute('aria-checked', 'true');

    await w.getByTestId('question-submit').click();
    await expect(w.getByText('ANSWERS: Which colour do you prefer?=Blue')).toBeVisible({
      timeout: 30_000,
    });
  });
});

// The honest degrade (P7 §6). A Terminal-mode session's questions stay in the
// TUI, where the CLI drew them — there is no `can_use_tool` on that transport
// and `shouldHoldPermission`'s GATED table never holds `AskUserQuestion`, so
// nothing reaches a card. What must NOT happen is a panel appearing that cannot
// answer anything: an inert list of radio buttons over a question the CLI is
// waiting on somewhere else is worse than no panel at all.
test.describe('Terminal mode keeps its questions in the terminal (#563)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('no question panel is drawn for a PTY session', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_TRANSPORT: 'pty' },
    });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // PROVE IT REALLY IS A PTY SESSION FIRST. Without this the test is worth
    // nothing: `session-manager` falls back to the PTY when the stream is
    // refused and vice versa, so "no panel appeared" from a session that turned
    // out to be Direct-with-a-broken-fake would read exactly the same. A
    // Terminal tab with a real terminal behind it — rather than the
    // "No terminal for this session" notice a Direct card shows — is the
    // witness, and it is the same one `stream-transport.spec.ts` uses pointed the other
    // way.
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toHaveCount(0);
    await w.getByRole('tab', { name: 'Session' }).first().click();

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!ask');
    await box.press('Enter');

    // Nothing appears, and nothing is held: the whole exchange belongs to the
    // terminal on this transport. Given time to be wrong — an assertion that a
    // thing does not appear is only worth the wait it gives it.
    await w.waitForTimeout(5_000);
    await expect(panel(w)).toHaveCount(0);
    expect(await heldIds(w)).toEqual([]);
  });
});
