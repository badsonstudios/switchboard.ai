// P2-E18-14 — permissions in DIRECT mode, the transport the app defaults to.
//
// THE GAP THIS FILLS, from the #404 audit: 37 of 39 e2e spec files silently run
// their sessions on the PTY, because the default fake refuses the stream and
// `session-manager.ts` falls back. So `approval.spec.ts` and
// `batch-approval.spec.ts` — eleven tests, the whole permission story — exercise
// the HOOK hold path, which a Direct session bypasses entirely
// (`hook-listener.ts:620`). Direct's coverage was one Allow and one allow-all,
// both happy paths. No Deny, no queue, no cross-session group, and nothing at
// all for the failure mode that hangs a CLI for five minutes: a renderer that
// died while a question was parked.
//
// NO `SWITCHBOARD_TRANSPORT` ANYWHERE IN THIS FILE, deliberately. Direct is the
// default since #381, so a spec about the default must not name it — naming it
// would keep passing on the day the default moved back.
//
// How a session is proved to really be Direct, without a Terminal-tab detour in
// every test: the review bar carries `decision_reason`, the CLI's OWN prose for
// why it is asking (`sensitive file`). A hook `PreToolUse` payload has no such
// field, so text on that bar can only have come off the control channel.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  findFile,
  launchApp,
  LaunchedApp,
  pollAsync,
  streamPrompter,
  tempProjectFolder,
} from './fixtures/app';
import { FAKE_SESSION_ID } from '../src/main/providers/fake-stream-ids';

/** the dual-capable fake, asked for nothing — i.e. the app's own default */
const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

const railRow = (w: Page, status: string) =>
  w.locator(`nav .rail-row[data-session-status="${status}"]`);

/** the requests MAIN is still holding — the witness a dead card cannot give */
function heldIds(w: Page): Promise<string[]> {
  return w.evaluate(() =>
    window.switchboard.sessions.pendingPermissions().then((l) => l.map((p) => p.requestId))
  );
}

/**
 * The JSONL the fake CLI writes, FOUND rather than reconstructed.
 *
 * The child derives the directory from its own `process.cwd()` through
 * `slugForCwd`, and the app compares that slug case-insensitively precisely
 * because real Windows paths disagree about the drive letter's case
 * (`transcripts/paths.ts`). A fourth hand-copy of the slug rule here would
 * turn any such disagreement into a 30-second poll that fails with a message
 * blaming `StreamPermissions` for a fixture bug. The file name is unique within
 * the isolated home, so searching it is exact and cannot drift.
 *
 * `FAKE_SESSION_ID` is the FIRST fake conversation started under that home, not
 * a constant every fake session shares — since #603 the fake mints one id per
 * spawn. Its one consumer below is a single-card test, so the first id names
 * that card's transcript. The TWO-session test above must not reach for this:
 * its second card is the second id, and there is no constant for "whichever of
 * the two you meant".
 */
const FAKE_TRANSCRIPT = `${FAKE_SESSION_ID}.jsonl`;

test.describe('Direct-mode permissions (P2-E18-14)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  // The half of the loop Direct mode has never had an e2e for. Allow was
  // covered from the day the channel existed; Deny — the answer that has to
  // reach the CLI as a REFUSAL and stop the tool — was not.
  test('Deny reaches the CLI and the tool never runs', async () => {
    // a launch, a gated call and the CLI's reply to the refusal: over the 60s
    // default on a cold runner, and a retry costs ten minutes
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!perm refused.sh');
    await box.press('Enter');

    await expect(w.getByText('Allow Write?')).toBeVisible({ timeout: 30_000 });
    // the CLI's own prose — proof this question came off `can_use_tool` and not
    // off a hook payload, which has no such field
    await expect(w.getByText(/sensitive file/)).toBeVisible();
    await expect(railRow(w, 'needs-permission')).toHaveCount(1, { timeout: 15_000 });

    await w.getByRole('button', { name: 'Deny', exact: true }).click();

    // The CLI ACTED on the refusal and said so on the stream. This is the claim
    // a hook `deny` cannot make for a `.claude/` write at all (measured
    // 2026-08-01, the observation the whole epic exists for): the verdict was
    // honoured rather than layered under a second prompt.
    await expect(w.getByText(/denied write to/)).toBeVisible({ timeout: 30_000 });
    expect(fs.existsSync(path.join(folder, 'refused.sh'))).toBe(false);

    // …and nothing is left claiming a question. Both surfaces, because they
    // fail apart: the bar is renderer state, the badge is the status machine.
    await expect(w.getByText('Allow Write?')).toHaveCount(0);
    await expect(railRow(w, 'needs-permission')).toHaveCount(0, { timeout: 15_000 });
    expect(await heldIds(w)).toEqual([]);
  });

  // #588. The manual said, for two months, that plan mode "never asks in-app";
  // then that it asks, but stays read-only "whatever you click". Measured
  // against the real CLI, neither was right: a plan-mode session asks for ONE
  // thing — `ExitPlanMode`, "approve this plan" — and Allow is what takes it out
  // of plan mode. So the bar MUST appear (with no terminal there is nowhere else
  // for a plan to be approved), and both answers have to arrive.
  //
  // The fake reproduces the measured exchange (`!permplan`); the router's own
  // rules are in `stream-permissions.test.ts`. What only a window can show is
  // that the request is put in front of the user with the PLAN in it — a bar
  // that named the tool and hid the plan would be asking someone to approve a
  // thing they cannot read.
  test('a plan is put in front of you to approve, and both answers reach the CLI', async () => {
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    const box = w.getByPlaceholder(/Prompt this session/);

    await box.click();
    await box.fill('!permplan PLAN-MARKER-ONE');
    await box.press('Enter');
    await expect(w.getByText('Allow ExitPlanMode?')).toBeVisible({ timeout: 30_000 });
    // the plan itself is on the bar, not just the tool's name
    await expect(w.getByText(/PLAN-MARKER-ONE/).first()).toBeVisible();
    await expect(railRow(w, 'needs-permission')).toHaveCount(1, { timeout: 15_000 });
    // a plan is not a "sensitive file", and the real request does not say so
    await expect(w.getByText(/sensitive file/)).toHaveCount(0);

    // DENY: the session stays in plan mode and says so.
    await w.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(w.getByText(/PLAN DENIED/)).toBeVisible({ timeout: 30_000 });
    await expect(w.getByText('Allow ExitPlanMode?')).toHaveCount(0);
    await expect(railRow(w, 'needs-permission')).toHaveCount(0, { timeout: 15_000 });

    // ALLOW: approving the plan is what lets the work start.
    await box.click();
    await box.fill('!permplan PLAN-MARKER-TWO');
    await box.press('Enter');
    await expect(w.getByText('Allow ExitPlanMode?')).toBeVisible({ timeout: 30_000 });
    await w.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(w.getByText(/PLAN APPROVED/)).toBeVisible({ timeout: 30_000 });
    await expect(railRow(w, 'needs-permission')).toHaveCount(0, { timeout: 15_000 });
    expect(await heldIds(w)).toEqual([]);
  });

  // P2-E22-02 (#973). Deny ABOVE proves the verdict reaches the CLI; this proves
  // the user's WORDS do, and that they arrive wrapped in the framing rather than
  // instead of it.
  //
  // It is an e2e and not a unit test because every hop between the textarea and
  // the wire used to drop the argument — `ApprovalBar` -> `SessionGrid.decide` ->
  // `decidePermission` -> the channel -> `StreamPermissions.decide`. Each of
  // those now accepts a `reason`, and the feature was missing for two epics with
  // main's end already finished, so a test that stops at any one hop is a test
  // that would have passed the whole time. The fake narrates the denial
  // `message` it received (see `fake-stream-protocol`), so what is asserted here
  // is the payload, from the far side.
  test('Deny with feedback carries the words AND the framing to the CLI', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!perm refused.sh');
    await box.press('Enter');
    await expect(w.getByText('Allow Write?')).toBeVisible({ timeout: 30_000 });

    // the field is not there until it is asked for
    await expect(w.locator('[data-deny-feedback-input]')).toHaveCount(0);
    await w.locator('[data-approval-deny-feedback]').click();
    const field = w.locator('[data-deny-feedback-input]');
    await expect(field).toBeFocused();
    await field.fill('that path is generated — edit the template instead');
    // the field holds what was typed, asserted separately so a failure below
    // cannot be blamed on the typing
    await expect(field).toHaveValue(/edit the template instead/);
    // Enter sends: the request is HELD and a CLI is blocked on it, so the fast
    // path has to be the one that answers (`DenyFeedbackField`).
    await field.press('Enter');

    await expect(w.getByText(/DENIAL MESSAGE:/)).toBeVisible({ timeout: 30_000 });

    // ⚠️ READ FROM THE TRANSCRIPT, NOT FROM THE FEED, and the first draft of this
    // test read the feed and was wrong for an instructive reason: the message is
    // a PARAGRAPH — framing, blank line, the user's words — and the feed renders
    // paragraphs as separate nodes, so `textContent()` on the element matching
    // `/DENIAL MESSAGE:/` returned the framing and stopped exactly where the
    // attribution began. It looked precisely like the reason being dropped.
    // The JSONL holds the assistant text whole, which is the string the model
    // would actually have been handed.
    const said = await pollAsync(
      () => {
        const transcript = findFile(a.home, FAKE_TRANSCRIPT);
        if (transcript === null) return Promise.resolve(null);
        const text = fs.readFileSync(transcript, 'utf8');
        return Promise.resolve(text.includes('DENIAL MESSAGE:') ? text : null);
      },
      'the fake never narrated the denial message it was sent',
      30_000
    );
    // BOUNDED TO ONE JSONL RECORD (review). `slice(indexOf(...))` alone runs to
    // EOF, so every `toContain` below could be satisfied by some later line in
    // the file that has nothing to do with this denial.
    const from = said.indexOf('DENIAL MESSAGE:');
    const lineEnd = said.indexOf('\n', from);
    const message = said.slice(from, lineEnd === -1 ? undefined : lineEnd);
    // the user's words reached the model...
    expect(message).toContain('edit the template instead');
    // ...and so did the sentence that stops it treating a refusal as an
    // obstacle to route around (#94). Carried, not replaced — the bug being
    // ruled out is the one where better feedback makes for a weaker denial.
    expect(message).toContain('DENIED it');
    expect(message).toContain('Do NOT retry this call');
    expect(message).not.toContain('Denied in switchboard');

    expect(fs.existsSync(path.join(folder, 'refused.sh'))).toBe(false);
    await expect(w.getByText('Allow Write?')).toHaveCount(0);
    expect(await heldIds(w)).toEqual([]);
  });


  // P2-E22-03 (#974). The ladder's middle rung, end to end, plus the door back
  // out of it — because a standing grant you cannot take back is the defect
  // this item was sized around, and a unit test cannot prove that a second
  // gated call really never reaches a window.
  test('Approve all in this file grants one file, and the ⋯ menu takes it back', async () => {
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    const prompt = streamPrompter(a);
    const title = path.basename(folder);
    const bar = w.locator('[data-approval-bar]');

    // 1. ASK, AND GRANT THE FILE.
    await prompt(title, '!perm granted.sh');
    await expect(w.getByText('Allow Write?')).toBeVisible({ timeout: 30_000 });
    await w.locator('[data-approval-allow-file]').click();
    await expect(bar).toHaveCount(0, { timeout: 15_000 });
    await expect
      .poll(() => fs.existsSync(path.join(folder, 'granted.sh')), { timeout: 20_000 })
      .toBe(true);

    // 2. THE SAME FILE AGAIN — and this is the assertion the whole rung is for.
    //    Not "the bar went away": no bar may ever APPEAR, main answers at the
    //    server, and nothing is pushed to this window at all.
    fs.rmSync(path.join(folder, 'granted.sh'));
    await prompt(title, '!perm granted.sh');
    await expect
      .poll(() => fs.existsSync(path.join(folder, 'granted.sh')), { timeout: 20_000 })
      .toBe(true);
    expect(await heldIds(w)).toEqual([]);
    await expect(bar).toHaveCount(0);

    // 3. A DIFFERENT FILE STILL HOLDS. The grant is one file, not a mood.
    await prompt(title, '!perm other.sh');
    await expect(w.getByText('Allow Write?')).toBeVisible({ timeout: 30_000 });
    await expect(w.getByText(/other\.sh/).first()).toBeVisible();

    // 4. THE CARD SAYS SOMETHING IS STANDING, before anything is opened. A
    //    session that has stopped asking has no other way to tell you why.
    await expect(w.getByTestId('card-menu-grant-dot')).toBeVisible();

    // 5. REVOKE IT, from the menu, without answering the held request.
    await w.getByTestId('card-menu-button').click();
    const row = w.getByTestId('card-menu').getByTestId('card-grant-file');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('granted.sh');
    await row.getByRole('button').click();
    // the list is main's, pushed back — so an empty section is proof the ROUTER
    // let go, not proof the renderer hid a row
    await expect(w.getByTestId('card-standing-grants-empty')).toBeVisible({ timeout: 15_000 });
    await expect(w.getByTestId('card-menu-grant-dot')).toHaveCount(0);
    // ⚠️ CLOSING THIS MENU TOOK TWO TRIES AND BOTH FAILURES ARE WORTH KNOWING.
    // `Escape` alone does nothing: the handler is on the wrapper around the ⋯
    // button, so it only fires while focus is inside — and the revoke just
    // removed the button that had it, dropping focus to `body`. Clicking ⋯ again
    // does not work either: the menu's click-away backdrop sits OVER the button
    // it belongs to, so Playwright reported `<div></div> intercepts pointer
    // events` for thirty seconds. Focus the button (focus does not hit-test),
    // then Escape.
    await w.getByTestId('card-menu-button').focus();
    await w.keyboard.press('Escape');
    await expect(w.getByTestId('card-menu')).toHaveCount(0);

    // 6. …AND THE GRANTED FILE ASKS AGAIN. Answer the request from step 3
    //    first, so the session is free to raise the next one.
    await w.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(bar).toHaveCount(0, { timeout: 15_000 });
    fs.rmSync(path.join(folder, 'granted.sh'));
    await prompt(title, '!perm granted.sh');
    await expect(w.getByText('Allow Write?')).toBeVisible({ timeout: 30_000 });
    expect(fs.existsSync(path.join(folder, 'granted.sh'))).toBe(false);
  });


  // ⚠️ THE OTHER RUNG, AND IT IS THE ONE THAT WAS ACTUALLY BROKEN. #974's review
  // found that revoking "Allow all (this session)" cleared main's grant and left
  // an identical copy in the WINDOW (`sessionStore.allowAllByLive`), which then
  // auto-allowed every request main started pushing again. The user would have
  // revoked, watched the list empty, and still never been asked.
  //
  // The e2e above tests the per-file rung, whose revoke worked from the first
  // draft. This one tests the rung with the history — and it is the only shape
  // that could have caught that bug, because BOTH processes have to be involved:
  // a main-side unit test passes against the broken build, and so does a
  // renderer-side one.
  test('revoking "Allow all" really does make the session ask again', async () => {
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    const prompt = streamPrompter(a);
    await prompt(title, '!perm one.sh');
    await expect(w.getByText('Allow Write?')).toBeVisible({ timeout: 30_000 });
    await w.getByRole('button', { name: 'Allow all (this session)' }).click();
    await expect(w.locator('[data-approval-bar]')).toHaveCount(0, { timeout: 15_000 });

    // it really is standing: a second call lands with nothing on screen
    await prompt(title, '!perm two.sh');
    await expect
      .poll(() => fs.existsSync(path.join(folder, 'two.sh')), { timeout: 20_000 })
      .toBe(true);
    await expect(w.locator('[data-approval-bar]')).toHaveCount(0);

    // take it back
    await w.getByTestId('card-menu-button').click();
    const row = w.getByTestId('card-menu').getByTestId('card-grant-all');
    await expect(row).toHaveCount(1);
    await row.getByRole('button').click();
    await expect(w.getByTestId('card-standing-grants-empty')).toBeVisible({ timeout: 15_000 });
    await w.getByTestId('card-menu-button').focus();
    await w.keyboard.press('Escape');
    await expect(w.getByTestId('card-menu')).toHaveCount(0);

    // …and the session asks again. THIS is the assertion the bug would fail:
    // against the broken build the request reached the window and the window
    // answered it itself, so the file appeared and no bar ever did.
    await prompt(title, '!perm three.sh');
    await expect(w.getByText('Allow Write?')).toBeVisible({ timeout: 30_000 });
    expect(fs.existsSync(path.join(folder, 'three.sh'))).toBe(false);
  });

  // Two gated calls in ONE turn, which is the only way to reach the card's
  // queue on this transport from the outside: a second prompt cannot be typed
  // while the composer's session sits behind the first request's bar. The fake
  // raises both from one turn, exactly as an assistant message carrying two
  // gated `tool_use` blocks would (`!perm a b`, P2-E18-14).
  //
  // It also drives E10-04 review P0#5 on this transport: a question needs eyes,
  // so the Session tab SURFACES on its own. The card starts on the Terminal
  // tab, which in Direct mode is the "no terminal for this session" notice —
  // the reveal has to work from a tab that is not a terminal at all.
  test('concurrent holds queue on the card, and the Session tab surfaces itself', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    const title = path.basename(folder);
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // Park somewhere other than Session, so "the Session tab surfaced itself"
    // means something. This used to park on the Terminal tab and confirm Direct
    // at the same time; both went with the tab (#873). Changes is the surviving
    // non-default tab, and the transport is already SELECTED by `DIRECT` above
    // rather than merely observed here.
    await w.getByRole('tab', { name: 'Changes' }).first().click();

    // Prompted through the session's own IPC rather than the composer: the
    // composer belongs to the Session tab, and the whole point is that the user
    // is NOT looking at it when the question arrives.
    const prompt = streamPrompter(a);
    await prompt(title, '!perm first.sh second.sh');

    // the Session tab came forward by itself, with the bar and the queue badge
    await expect(w.getByText('Allow Write?')).toBeVisible({ timeout: 30_000 });
    await expect(w.getByText('+1 more waiting')).toBeVisible();
    await expect(w.getByText(/first\.sh/).first()).toBeVisible();
    await expect.poll(() => heldIds(w)).toHaveLength(2);

    await w.getByRole('button', { name: 'Allow', exact: true }).click();

    // The second advances into the bar, and the badge goes with it.
    //
    // ⚠️ SCOPED TO THE BAR, AND ORDERED BEHIND `heldIds` (#972). This read
    // `w.getByText(/second\.sh/)` across the whole window, and the permission's file
    // path is ALSO rendered by the Events panel (`events-v2.ts` → `argumentDetail`) —
    // so the locator could resolve against an Events row while the bar still showed
    // `first.sh` and the queue badge was still 1. That is precisely the state CI
    // caught: `second.sh` visible, `+1 more waiting` still there, 24 polls in a row.
    // It went green locally every time, because the bar happened to advance first.
    //
    // Waiting on `heldIds` makes the sequence deterministic rather than hopeful: once
    // main holds ONE request, the badge cannot still be counting a second.
    await expect.poll(() => heldIds(w), { timeout: 15_000 }).toHaveLength(1);
    // `.first()`: the bar names the path TWICE — once in its summary line and once
    // inside the CLI's own `decision_reason` — and both are the bar, which is the
    // point. What matters is that neither is an Events row.
    await expect(w.locator('[data-approval-bar]').getByText(/second\.sh/).first()).toBeVisible();
    await expect(w.getByText('+1 more waiting')).toHaveCount(0);
    await w.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(w.getByText('Allow Write?')).toHaveCount(0);

    // BOTH verdicts landed, and they landed on the right requests — read off
    // the disk, which is the CLI's answer rather than ours
    await expect(() => {
      expect(fs.existsSync(path.join(folder, 'first.sh'))).toBe(true);
    }).toPass({ timeout: 20_000 });
    expect(fs.existsSync(path.join(folder, 'second.sh'))).toBe(false);
    expect(await heldIds(w)).toEqual([]);
  });

  // P2-E9-11's grouped prompt (#80's band), on the transport it has never been
  // tested on. `batch-approval.spec.ts` drives it through the hook listener, so
  // every one of its four tests is a PTY test; the grouping rule itself is
  // transport-blind (`lib/permission-batches.ts` keys on tool + input + reason),
  // and this is what proves the WIRING is too — main merges both routers'
  // pending lists into the one ledger the card reads (`sessions/ipc.ts`).
  //
  // The target is an ABSOLUTE path, and that is what makes the two questions
  // identical: `!perm` resolves a relative target against each session's own
  // cwd, and two sessions in two folders would then be asking two different
  // questions and would correctly NOT group. It is also never written — the
  // test answers deny-all — so nothing outside the temp folders is touched.
  test('two Direct sessions asking the same thing present as ONE card', async () => {
    test.setTimeout(180_000); // two real spawns
    const one = tempProjectFolder();
    const two = tempProjectFolder();
    a = await launchApp({ seedFolder: one, env: DIRECT });
    const w = a.window;
    const titles = [path.basename(one), path.basename(two)];
    await expect(w.getByText(titles[0]).first()).toBeVisible({ timeout: 25_000 });

    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, two);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(titles[1]).first()).toBeVisible({ timeout: 25_000 });

    const prompt = streamPrompter(a);
    // the same question, byte for byte, from two different CLIs
    for (const title of titles) await prompt(title, '!perm /sb-e2e-batch-target.sh');

    const card = w.getByTestId('batch-approval');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('2 sessions want to run Write');
    await expect(card).toContainText('/sb-e2e-batch-target.sh');
    // both sessions are named on it, including the one dockview has not mounted
    for (const title of titles) {
      await expect(w.locator(`[data-batch-member][title="${title}"]`)).toBeVisible();
    }
    // ONE question, ONE place to answer it: the mounted card's own bar does not
    // draw the same request a second time
    await expect(w.getByText('Allow Write?')).toHaveCount(0);
    await expect.poll(() => heldIds(w)).toHaveLength(2);

    // one click, two real `control_response` frames, down two separate stdins
    await w.getByTestId('batch-deny-all').click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => heldIds(w)).toEqual([]);
    // and both CLIs really acted on it
    await expect(w.getByText(/denied write to/).first()).toBeVisible({ timeout: 30_000 });
  });

  // P2-E15-09's failure mode, on the channel where it is WORSE.
  //
  // `approval.spec.ts` covers it for hooks, where a released hold means
  // answering nothing and letting the CLI's own TUI prompt take the question.
  // A `control_request` has no such fallback: the CLI is blocked on us and on
  // nothing else, so a hold that outlives its renderer parks that session for
  // the full 300s deadline with nobody able to decide it. `StreamPermissions`
  // answers DENY instead (#319) — and until this test, nothing outside a unit
  // test had ever seen it do so through a real crash.
  //
  // The observable cannot be the DOM: the renderer is what we just killed. It
  // is the fake CLI's own transcript, written from inside the child process —
  // so what this reads is the CLI acting on a verdict, which is the claim.
  test('a CRASHED renderer releases a Direct hold instead of parking the CLI', async () => {
    // Same reason as approval.spec.ts's twin: crashing the renderer under xvfb
    // takes the WINDOW with it, `window-all-closed` quits the app, and the
    // session dies before anything can answer it. On Windows the window
    // provably survives with dead contents, which is the state under test.
    test.skip(
      process.platform === 'linux',
      'a renderer crash kills the whole app under xvfb; covered on Windows'
    );
    // 25s launch + 30s for the bar + a 30s poll comfortably exceeds the 60s
    // default on a cold runner — and this test only ever runs on the SLOWER of
    // the two, since Linux skips it. A retry costs ten minutes.
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!perm orphaned.sh');
    await box.press('Enter');
    // parked: the CLI is blocked on this and on nothing else
    await expect(w.getByText('Allow Write?')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => heldIds(w)).toHaveLength(1);

    await a.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
    });

    // The CLI was answered and moved on. Read from the transcript the fake
    // writes, because there is no renderer left to ask — and a deny is the only
    // thing that produces this line, so it cannot be satisfied by the session
    // merely still being alive.
    await pollAsync(
      () => {
        const transcript = findFile(a.home, FAKE_TRANSCRIPT);
        const said =
          transcript !== null && fs.readFileSync(transcript, 'utf8').includes('denied write to');
        return Promise.resolve(said ? true : null);
      },
      'the hold outlived the renderer: nothing answered it',
      30_000
    );
    // …and it really was a refusal, not a silent allow
    expect(fs.existsSync(path.join(folder, 'orphaned.sh'))).toBe(false);
  });
});
