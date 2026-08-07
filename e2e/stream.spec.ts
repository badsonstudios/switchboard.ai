// P2-E18-08a — a real stream session runs, driven through the real app.
//
// THE criterion inherited from P2-E18-04, and this is the first point it is
// meetable: before now nothing constructed StreamService, and the composer
// submitted only over the PTY.
//
// Uses the stream-json fake (`SWITCHBOARD_FAKE_PROVIDER=stream`), so it needs
// no `claude` login and no network — the same property the PTY fake gives the
// other 98 specs.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hookPoster, launchApp, LaunchedApp } from './fixtures/app';

/** Project folders this file made, waiting to be deleted. See `teardown`. */
const tempFolders: string[] = [];

function tempProjectFolder(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stream-e2e-'));
  tempFolders.push(d);
  fs.writeFileSync(path.join(d, 'README.md'), '# stream\n');
  return d;
}

/**
 * Close the app, THEN delete the folders it was pointed at (#180).
 *
 * Order is the whole point. The session's child process has one of these
 * folders as its cwd, and on Windows a running process holds a lock on its cwd
 * — so an rm issued before the app is reaped is guaranteed to fail with EBUSY.
 * `cleanup()` closes the app and kills the tree first; the kill only *asks*,
 * though, so the rm can still land while the last child is dying.
 *
 * `maxRetries` is NOT the answer to that one, and it is worth writing down
 * because it looks like it should be: node's recursive rm only enters its retry
 * loop after the not-empty recursion, so an `EBUSY` off the very first `rmdir`
 * — exactly what a still-held cwd produces — is rethrown untouched (measured on
 * this machine, 0/4 retried). What actually makes this robust is the REQUEUE: a
 * folder that will not go stays on the list and is tried again by the next
 * test's teardown and by the file's `afterAll`, by which time its process is
 * long gone. The retries are still worth asking for — they cover the
 * ENOTEMPTY/EPERM path a scanner or indexer holding one file produces.
 *
 * And it never throws. A throw here would fail a test that has already passed;
 * fail-open applies to test infra too, so a directory that will not go is a
 * leak, not a broken run.
 *
 * The hooks hand the app over and clear their own `a` FIRST (the diff.spec.ts
 * shape). A test that throws before assigning it otherwise leaves the PREVIOUS
 * test's already-closed app in the variable, and closing it twice means
 * `killTree` issuing `taskkill /T /F` against a dead pid — which Windows may
 * have recycled onto something else entirely.
 *
 * Until this existed the file leaked one folder per test, for ever (502 counted
 * in %TEMP% when #180 was filed, ~1,000 by the time it was fixed).
 */
async function teardown(app?: LaunchedApp): Promise<void> {
  try {
    await app?.cleanup();
  } finally {
    const pending = tempFolders.splice(0, tempFolders.length);
    for (const d of pending) {
      try {
        // async: the ENOTEMPTY retry ladder sleeps ~5s, and a sync one would
        // spend it blocking the worker inside Playwright's own hook budget
        await fs.promises.rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        tempFolders.push(d); // retried next time — see above
      }
    }
  }
}

// The net for the last test's stragglers: by now every app in this file is
// gone, so a folder that was merely late to unlock goes on this pass.
test.afterAll(async () => teardown());

test.describe('a stream-json session (P2-E18-08a)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  // Scoped to what E18-08a actually claims: the turn RUNS and COMPLETES.
  //
  // It deliberately does not assert on the Session view's rendered reply,
  // because the E18-04 fake writes no JSONL transcript and the Feed reads
  // transcripts until E18-10. That is a real gap in the fake — the REAL CLI
  // does write one (S-10) — and it belongs to E18-08b (#149), whose done-when
  // includes "the Feed renders a stream session's turn". Filed, not absorbed.
  test('runs a whole turn: prompt in, turn completes', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      // TWO variables now, and the split matters: the first picks the
      // dual-capable fake, the second ASKS it for stream. The fake used to
      // return a stream recipe unconditionally, which meant nothing could
      // exercise switching — and that is why #153 shipped (#153: the setting
      // could never take effect and no test could have caught it).
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;

    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('hello stream');
    await box.press('Enter');

    // "Done." in the Events panel is the state machine reporting a `result`
    // message off the stream — which proves the whole chain: composer ->
    // submitPrompt -> stdin frame -> the fake -> stdout NDJSON -> decoder ->
    // streamStatusEvent -> the state machine -> the UI.
    await expect(w.getByText('Done.')).toBeVisible({ timeout: 30_000 });
  });

  test('the .claude permission is asked ONCE and honoured', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      // TWO variables now, and the split matters: the first picks the
      // dual-capable fake, the second ASKS it for stream. The fake used to
      // return a stream recipe unconditionally, which meant nothing could
      // exercise switching — and that is why #153 shipped (#153: the setting
      // could never take effect and no test could have caught it).
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;

    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!perm .claude/scripts/coverage.sh');
    await box.press('Enter');

    // our bar, carrying the CLI's OWN prose — a hook payload has no equivalent
    await expect(w.getByText(/sensitive file/)).toBeVisible({ timeout: 30_000 });

    await w.getByRole('button', { name: /allow/i }).first().click();

    // and the file is actually written: the answer was HONOURED, which is the
    // thing the hook path cannot do for `.claude/` (measured 2026-08-01)
    const target = path.join(folder, '.claude', 'scripts', 'coverage.sh');
    await expect(() => {
      expect(fs.existsSync(target)).toBe(true);
    }).toPass({ timeout: 20_000 });

    // and nothing asks a second time
    await expect(w.getByText(/sensitive file/)).toHaveCount(0);
  });
});

// P2-E18-08b (#149) — the criterion the fake's missing transcript blocked.
//
// The Feed reads TRANSCRIPTS until E18-10 swaps it to typed messages, and the
// real CLI writes one in stream mode (S-10). The fake now does too, so this is
// testable — and it proves the claim that made the migration incremental: the
// transcript stack survives the transport change untouched.
test.describe('the Feed renders a stream session (P2-E18-08b)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('a turn appears in the Session view via the existing transcript path', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      // TWO variables now, and the split matters: the first picks the
      // dual-capable fake, the second ASKS it for stream. The fake used to
      // return a stream recipe unconditionally, which meant nothing could
      // exercise switching — and that is why #153 shipped (#153: the setting
      // could never take effect and no test could have caught it).
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;

    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('render me');
    await box.press('Enter');

    // the assistant's reply, rendered as a Session-view block — no code in the
    // feed pipeline changed for this
    await expect(w.getByText(/FAKE-REPLY: render me/)).toBeVisible({ timeout: 30_000 });
  });
});

// P2-E18-09 — the composer's command list comes from the CLI itself.
//
// `CLAUDE_BUILTIN_COMMANDS` is 40 hand-curated builtins that the file itself
// calls "version-volatile by nature… a maintenance chore". In Direct mode the
// CLI advertises its real set (S-10: 59 entries, including this machine's own
// `/startup` — commands no curated list could have contained).
//
// The assertion that matters is the NEGATIVE one. `curated-only` exists in the
// fake adapter's static list and NOT in its `init`, purely so this test can
// tell "the CLI's list replaced ours" from "the two were merged" — which the
// old fake could not, its fallback being a strict subset of what it advertised.
test.describe('slash commands come from the CLI in Direct mode (P2-E18-09)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('the curated list is a fallback, and the first turn replaces it', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // BEFORE any turn: the curated list, and this is the normal state rather
    // than a race. The CLI emits nothing at spawn (S-11 measured `init`
    // arriving 10-20ms AFTER a send we made ourselves), so a Direct session
    // genuinely has no list until its first prompt.
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.pressSequentially('/');
    await expect(w.getByText('/curated-only', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(w.getByText('/fake-only', { exact: true })).toHaveCount(0);

    // send a turn, which is what makes the CLI announce itself
    await box.fill('hello stream');
    await box.press('Enter');
    await expect(w.getByText('Done.')).toBeVisible({ timeout: 30_000 });

    // AFTER: the CLI's own list. `fake-only` is a command no scan could have
    // found, and `curated-only` is gone — replaced, not merged.
    await box.click();
    await box.pressSequentially('/');
    await expect(w.getByText('/fake-only', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(w.getByText('/curated-only', { exact: true })).toHaveCount(0);
    // and what we DO know about a survivor survives with it: `init` carries
    // bare names, so this description can only have come from our own scan
    await expect(w.getByText('Clear conversation history')).toBeVisible();
  });

  // The second payload that carries commands, and the one we have never seen in
  // production: object-shaped, with descriptions, arriving mid-session when the
  // CLI's command set changes (a plugin installed, a command file added).
  //
  // `/fake-only` disappearing is what makes this test worth having. The fake
  // emits `init` at the START of every turn, so the list this replaces arrived
  // milliseconds earlier in the very same turn — nothing but `commands_changed`
  // being consumed can produce that outcome.
  test('commands_changed replaces the list mid-session', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!commands');
    await box.press('Enter');
    await expect(w.getByText('commands changed')).toBeVisible({ timeout: 30_000 });

    await box.click();
    await box.pressSequentially('/');
    await expect(w.getByText('/just-installed', { exact: true })).toBeVisible({ timeout: 15_000 });
    // the same turn's `init` list is gone, so this really is the later message
    await expect(w.getByText('/fake-only', { exact: true })).toHaveCount(0);
    // and this payload carries its OWN descriptions, unlike init's bare names
    await expect(w.getByText('Arrived mid-session')).toBeVisible();
  });

  test('a PTY session keeps the curated list', async () => {
    const folder = tempProjectFolder();
    // the dual-capable fake, asked for nothing — so it runs on the PTY
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.pressSequentially('/');
    await expect(w.getByText('/curated-only', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(w.getByText('/fake-only', { exact: true })).toHaveCount(0);
  });
});

// #154 — the stop button did nothing in Direct mode.
//
// It wrote Esc to the PTY unconditionally, and a stream session has no PTY, so
// the write was a silent no-op. Dan reproduced it every time: submit a prompt,
// click stop repeatedly, watch the turn run to completion anyway.
test.describe('the stop button actually stops (#154)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('stopping a Direct-mode turn interrupts it', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // `!hang` starts a turn and never finishes it, which is the only way to
    // hold a session in `working` — the one state the stop button renders in.
    // `!perm` cannot serve: it moves the session to `needs-permission`, which
    // is precisely why the first version of this test could not find the
    // button at all.
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!hang');
    await box.press('Enter');
    await expect(w.getByText(/working on it/)).toBeVisible({ timeout: 30_000 });

    // by TITLE, not role-name: the button's content is the icon glyph, so its
    // accessible name is the glyph, not the word "stop"
    await w.getByTitle(/Stop Claude/i).first().click();

    // the fake reports an interrupted turn rather than running on for ever
    await expect(w.getByText('INTERRUPTED')).toBeVisible({ timeout: 30_000 });
  });
});

// P2-E18-08b (#149) — the Terminal tab in a stream session.
test.describe('the Terminal tab degrades honestly (P2-E18-08b)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('says there is no terminal instead of showing an empty black pane', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      // TWO variables now, and the split matters: the first picks the
      // dual-capable fake, the second ASKS it for stream. The fake used to
      // return a stream recipe unconditionally, which meant nothing could
      // exercise switching — and that is why #153 shipped (#153: the setting
      // could never take effect and no test could have caught it).
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await w.getByRole('tab', { name: 'Terminal' }).first().click();

    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 15_000 });
    // and it says what you GAIN, not only what is missing
    await expect(w.getByText(/permission requests appear in this window/i)).toBeVisible();
  });

  test('a PTY session still gets a real terminal', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder }); // the PTY fake, the default
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await w.getByRole('tab', { name: 'Terminal' }).first().click();

    await expect(w.getByText('No terminal for this session')).toHaveCount(0);
  });
});

// P2 #153 — THE PATH A PERSON TAKES.
//
// This is the test whose absence is the actual root cause of #153. Everything
// was covered: setTransport was unit-tested for persistence and the pending
// flag, and the stream e2e drove a full session end to end. But the e2e
// launched with stream ALREADY selected by env, so nothing ever walked
// set-it → restart → use-it — and the shipped feature could not take effect at
// all, because the only route to a restart was the card's ✕, which deletes the
// card record and the stored choice with it.
//
// The parts were each verified. The product did not work.
test.describe('switching transport the way a user does (#153)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('set it in the menu, restart from the menu, and the session comes up in the new mode', async () => {
    const folder = tempProjectFolder();
    // the dual-capable fake, asked for NOTHING — so it starts on the PTY, which
    // is what a real user's session does
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // it starts on the terminal
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toHaveCount(0);

    // switch it — the label names the CURRENT mode and the action separately
    await w.getByRole('button', { name: '⋯' }).first().click();
    await w.getByRole('button', { name: /switch to Direct/i }).click();

    // it is saved but NOT yet in effect, and it says so
    await expect(w.getByText(/still running on the old one/i)).toBeVisible();

    // the affordance that #153 was missing entirely
    await w.getByRole('button', { name: /Restart session now/i }).click();

    // and now it really is in the new mode
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });
  });

  // Dan hit this within minutes of the switch working: a freshly restarted
  // Direct session showed "Claude is showing a start-up dialog … appear only in
  // the terminal" over an [Open Terminal] button — next to a Terminal tab that
  // correctly said there was no terminal. Two surfaces in one window
  // contradicting each other.
  //
  // TWO bugs behind it. The bar had no notion of transport, and every branch of
  // it routes to a terminal a stream session does not have. And the session was
  // genuinely stuck reporting `starting`, because transport-ready was deferred
  // by a tick while the renderer learns the session id from a much slower IPC
  // response — so the only status push it would ever get was filtered out for
  // an id nobody knew yet.
  test('a restarted Direct session does not offer a terminal it does not have', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await w.getByRole('button', { name: '⋯' }).first().click();
    await w.getByRole('button', { name: /switch to Direct/i }).click();
    await w.getByRole('button', { name: /Restart session now/i }).click();

    // the Terminal tab is honest about there being no terminal...
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });

    // ...and nothing else in the window contradicts it. The bar's grace period
    // is 8s, so this has to outlast it to mean anything.
    await w.waitForTimeout(10_000);
    await expect(w.getByText(/start-up dialog/i)).toHaveCount(0);
    await expect(w.getByRole('button', { name: /Open Terminal/i })).toHaveCount(0);
  });

  // #261 — the SAME contradiction, on the branch Dan actually reported, and the
  // reason the test above was not enough.
  //
  // That one drives only `startingLong`, and that branch stopped firing once
  // transport-ready was fixed: the session no longer sits on `starting`, so
  // there is nothing to suppress and the assertion passes for the wrong reason.
  // It would have stayed green through the entire life of this bug — and did.
  //
  // So this one drives the branch by hand. A `Notification` from the CLI's own
  // debounced nudge is exactly what put the bar on screen in the live incident:
  // no PreToolUse, therefore no hold, therefore no approval bar to outrank it.
  // On a PTY session that is the #125 case and the bar is CORRECT (asserted in
  // approval.spec.ts). Here there is no terminal to send anyone to.
  //
  // RETARGETED FROM `needs-permission` TO `needs-input` BY #313, and the reason
  // is that #313 removed the state this test used to drive. A permission-
  // classified Notification no longer reaches the state machine on a stream
  // session at all — see `stream-notification-guard.test.ts` and the e2e at the
  // end of this file — so `needs-permission` is now reachable on this transport
  // ONLY via a held `can_use_tool`, and a held request sets `hasApproval`, which
  // short-circuits `terminalHandoff` BEFORE the transport check. Driving it that
  // way would leave this test green for a reason that has nothing to do with the
  // transport: precisely the failure mode its own comment above is about.
  //
  // `needs-input` is the same shape and is still reachable: an unheld, unbarred
  // status whose handoff branch routes to a terminal a Direct session does not
  // have. Same rule, same line of `terminalHandoff`, same two absences.
  test('a Direct session waiting on input offers no bar and no dead button (#261)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      // Start in Direct rather than switching + restarting: the transport is
      // the subject of the test, not the path taken to it, and a restart moves
      // the live session id out from under `hookPoster`.
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    const title = folder.split(/[\\/]/).pop()!;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // it really is Direct — otherwise everything below is a PTY test that
    // happens to pass
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });
    await w.getByRole('tab', { name: 'Session', exact: true }).first().click();

    const post = await hookPoster(a);
    await post(title, {
      hook_event_name: 'Notification',
      notification_type: 'generic',
      // NOT "waiting for your input", which is the CLI's 60s idle nag and
      // classifies to `idle` — a calm state with no bar at all. This is the
      // other arm: a bare "waiting", which is the CLI stopped on something.
      message: 'Claude is waiting on you',
    });

    // The session REALLY reached the state — without this the two absence
    // assertions below prove only that nothing happened, which is the exact
    // failure mode of the test above.
    await expect(w.locator('nav .rail-row[data-session-status="needs-input"]')).toHaveCount(1, {
      timeout: 15_000,
    });

    // ...and the Session tab stays silent rather than pointing at a terminal
    // that does not exist. `data-handoff` is the bar itself; the button is what
    // the user would have clicked to nowhere.
    await expect(w.locator('[data-handoff]')).toHaveCount(0);
    await expect(w.getByRole('button', { name: /Open Terminal/i })).toHaveCount(0);
    await expect(w.getByText(/waiting for your answer/i)).toHaveCount(0);
  });

  // The path Dan took, and the one that was still broken after the restart
  // button worked: he switched to Direct, used it successfully, closed the APP,
  // reopened — and was back on Terminal.
  //
  // Cause: the create-time card write rebuilt the persisted record field by
  // field, so `transport` was dropped on EVERY session start, including the one
  // at launch. Same defect shape as `reason` vanishing from the approval queue
  // earlier the same day. Must run against the BUILT app, like the theme
  // relaunch test, because that is where the real persistence path lives.
  test('the choice survives a relaunch of the whole app', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const first = a;
    await expect(first.window.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await first.window.getByRole('button', { name: '⋯' }).first().click();
    await first.window.getByRole('button', { name: /switch to Direct/i }).click();
    await first.window.getByRole('button', { name: /Restart session now/i }).click();
    // it really is in Direct before we quit
    await first.window.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(first.window.getByText('No terminal for this session')).toBeVisible({
      timeout: 30_000,
    });
    await first.close();

    // Same profile, fresh process — and deliberately NO seedFolder. Seeding
    // again creates a SECOND card, which is what my first attempt did: two
    // sessions, and the assertion landed on the wrong one.
    a = await launchApp({ home: first.home, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    await expect(a.window.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await a.window.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(a.window.getByText('No terminal for this session')).toBeVisible({
      timeout: 30_000,
    });
  });

  test('the choice survives the restart it triggered', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await w.getByRole('button', { name: '⋯' }).first().click();
    await w.getByRole('button', { name: /switch to Direct/i }).click();
    await w.getByRole('button', { name: /Restart session now/i }).click();
    await expect(w.getByText(/still running on the old one/i)).toHaveCount(0);

    // reopen the menu: it should now report Direct as the CURRENT mode
    await w.getByRole('button', { name: '⋯' }).first().click();
    await expect(w.getByRole('button', { name: /switch to Terminal/i })).toBeVisible({
      timeout: 15_000,
    });
  });
});

// P2-E18-10 (#140) — the Feed reads the stream, not the transcript.
//
// Both of these are chosen so that the transcript CANNOT be the source: the
// fake writes no JSONL line for either turn, exactly as the real CLI does not.
// A test whose text could have come from either place would prove nothing.
test.describe('the Feed is built from typed messages (P2-E18-10)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('assistant text appears token by token, before the message is complete', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // `!partial` emits three text deltas and then stops: no `assistant`
    // message, no `result`, no transcript line. The only way this text can be
    // on screen is partial-message rendering.
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!partial');
    await box.press('Enter');

    await expect(w.getByText(/HALF-WRITTEN-SENTENCE/)).toBeVisible({ timeout: 30_000 });
    // and the turn is genuinely still running while we can read it
    await expect(w.getByText('Done.')).toHaveCount(0);
  });

  // #156, measured in `spike/findings/s-11-local-slash-commands.md`. `/usage`
  // displayed NOTHING in the Session view: the CLI emits it on the stream as an
  // ordinary assistant turn, but records it in the JSONL as
  // `system`/`local_command` with no assistant entry at all — and the Feed read
  // the JSONL. The fake reproduces both halves of that divergence.
  test('a local slash command\'s output renders (#156)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // TYPED THE WAY A USER TYPES IT, and ONE Enter. This test used to press
    // Escape first, to get the autocomplete popup out of the way — and that
    // workaround is what let the real bug ship. Dan hand-tested PR #163 and
    // found EVERY slash command dead in Direct mode: the popup claimed Enter to
    // confirm a completion, so `/usage` + Enter became `/usage ` and ran
    // nothing. A test that teaches itself the unnatural keystroke cannot catch
    // the natural one failing.
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.pressSequentially('/usage');
    // The popup really is OPEN and offering this exact command — asserted via
    // its DESCRIPTION, because `/usage` matches the textarea's own value too
    // and an ambiguous locator here would let the test pass with no popup at
    // all, i.e. without ever reaching the code #163 broke.
    await expect(w.getByText('Show subscription usage')).toBeVisible({ timeout: 15_000 });

    await box.press('Enter');

    // ONE Enter sent it: the composer is empty, not sitting on `/usage `
    await expect(box).toHaveValue('', { timeout: 15_000 });

    // THE OUTPUT IS ON SCREEN, WITH NO CLICK — and scoped to `.feed-md`, the
    // assistant-prose renderer, so it can only pass by rendering as its own
    // visible block. A loose page-text match would also be satisfied by the
    // text sitting inside a collapsed container, which is the failure this
    // assertion exists to rule out.
    await expect(
      w.locator('.feed-md', { hasText: 'LOCAL-OUTPUT for /usage' })
    ).toBeVisible({ timeout: 30_000 });
    // …and the turn still completed, as it always did — the done-sound played
    // even when the text did not appear, which is what made the bug confusing
    await expect(w.getByText('Done.')).toBeVisible({ timeout: 30_000 });
  });

  test('the user\'s own prompt still renders, off the replayed user message', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('remember this prompt');
    await box.press('Enter');

    // `exact`, because the reply quotes the prompt back and a substring match
    // would find both — which is the same trap the duplicate check below is for
    const pill = w.getByText('remember this prompt', { exact: true });
    await expect(pill).toBeVisible({ timeout: 30_000 });
    // ONE copy: the stream is the only source now, and a session whose watcher
    // still derived blocks from the transcript would show every block twice
    await expect(pill).toHaveCount(1);
    await expect(w.getByText(/FAKE-REPLY: remember this prompt/)).toHaveCount(1);
  });
});

// #310 — an allow-all Direct session runs gated tools with NO handoff banner.
//
// Dan, dogfooding 2026-08-06: a Direct session with "Allow all (this session)"
// on grew "Claude is asking permission in the terminal", over an [Open Terminal]
// button, above the composer, on EVERY gated call — for about five seconds each
// time, in a transport that has no terminal. Two causes, both fixed here:
// `StreamPermissions.decide` never applied `permission-resolved` (so the status
// only left `needs-permission` when the CLI next spoke, i.e. after the tool had
// run), and the renderer's auto-allow branch answered without opening the
// `recentlyDecided` window the manual Allow/Deny path opens.
//
// AN INDEPENDENT GUARD, deliberately. The transport prop that would let
// `terminalHandoff` short-circuit on `transport === 'stream'` is #261's fix and
// is NOT on this branch — `panels.tsx` still does not forward `ctx.transport`
// to `<FeedView>`. So everything asserted below is carried by the status and
// suppression fixes alone. It keeps its value after #261 lands: that fix hides
// the bar, this one proves the state underneath it is not wrong.
//
// IT USES `!permhang`, AND THAT IS THE WHOLE TEST. Measured while writing it:
// with both fixes reverted and a plain `!perm`, this spec still PASSED — the
// fake answers and replies in the same tick, so the buggy `needs-permission`
// window never survived a task boundary and there was nothing to catch. The bug
// lives in the seconds a REAL tool spends running while the CLI says nothing,
// and `!permhang` is that silence, modelled: the fake performs the write and
// then emits nothing at all. Under the old code the card stays in
// `needs-permission` for ever there; under this one it is `working` the instant
// the answer is sent. Re-verified by reverting both fixes: this then fails with
// one counted frame, and the bar is still on screen when the test ends.
//
// It is the STATUS fix this pins, measured the same way: restoring
// `StreamPermissions.decide`'s `permission-resolved` alone makes it pass again,
// because against the fake the IPC round trip is too short for a frame to land
// in between. The renderer's `suppressHandoff` covers that round trip — a
// loaded machine, a busy renderer — and is pinned where it can be asserted
// without a race, in `lib/held-permissions.test.ts`.
//
// A MutationObserver rather than a poll so the count is of DOM CHANGES, not of
// samples — a bar that came and went between two 100ms probes would be invisible
// to a poll and is not to this. It is not infinitely fine either, and it should
// not be read as if it were: observer callbacks are batched at the microtask
// checkpoint, so a node added AND removed inside one batch leaves nothing for
// `innerText` to find. That is the limit, and it is comfortably below the thing
// under test — the hold and its resolution arrive on separate IPC messages, and
// reverting the fixes does make this fail.
test.describe('allow-all in Direct mode never hands off to a terminal (#310)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  /** the handoff bar's headline, verbatim from `i18n/locales/en.json` */
  const HANDOFF = /Claude is asking permission in the terminal/i;

  test('a gated tool runs end to end with the handoff bar never rendered', async () => {
    // Two full turns plus a deliberate 3s sit in the silence, against a 60s
    // default. Comfortable on this machine (~25s) and not on a cold runner,
    // where a timeout would cost two runs under `retries: 1`.
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;

    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box = w.getByPlaceholder(/Prompt this session/);

    // 1. the first gated call is answered by hand — this is what turns allow-all
    //    on, and it is the only bar the user should ever see in this test.
    await box.click();
    await box.fill('!perm .claude/scripts/one.sh');
    await box.press('Enter');
    await expect(w.getByText(/sensitive file/)).toBeVisible({ timeout: 30_000 });
    await w.getByRole('button', { name: 'Allow all (this session)' }).click();
    await expect(() => {
      expect(fs.existsSync(path.join(folder, '.claude', 'scripts', 'one.sh'))).toBe(true);
    }).toPass({ timeout: 20_000 });

    // 2. start counting commits that contain the bar. Installed AFTER the manual
    //    answer so the count is about the AUTO-allow path and nothing else.
    await w.evaluate((pattern) => {
      const win = window as unknown as { __sbHandoffFrames?: number };
      win.__sbHandoffFrames = 0;
      const re = new RegExp(pattern, 'i');
      const look = (): void => {
        if (re.test(document.body.innerText ?? '')) win.__sbHandoffFrames!++;
      };
      new MutationObserver(look).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      look(); // the state it starts in counts too
    }, HANDOFF.source);

    // 3. a second gated call, answered by the allow-all path with no bar, no
    //    queue and no user click — and then a tool that RUNS while the CLI
    //    stays silent, which is where the five seconds used to go.
    await box.click();
    await box.fill('!permhang .claude/scripts/two.sh');
    await box.press('Enter');
    await expect(() => {
      expect(fs.existsSync(path.join(folder, '.claude', 'scripts', 'two.sh'))).toBe(true);
    }).toPass({ timeout: 30_000 });
    // The file proves the answer was delivered. Now sit in the silence: nothing
    // further will ever arrive on this turn, so this is the whole window the old
    // code spent advertising a question that had already been answered.
    await w.waitForTimeout(3_000);

    // 4. the whole point: not once, not for a frame.
    const frames = await w.evaluate(
      () => (window as unknown as { __sbHandoffFrames?: number }).__sbHandoffFrames ?? -1
    );
    expect(frames, 'the terminal-handoff bar rendered during an auto-allowed tool call').toBe(0);
    await expect(w.getByText(HANDOFF)).toHaveCount(0);
  });
});

// #313 — a Direct session's own hook Notification cannot flip it to
// needs-permission, and the SESSION fires it, not the test.
//
// A Direct session runs BOTH signal channels into one state machine.
// `stream-status.ts` maps `can_use_tool` -> `needs-permission` exactly; the hook
// `Notification` arm in `state-machine.ts` transitions on a regex over the CLI's
// DEBOUNCED nudge, with no evidence anything is held. On stream every real
// permission arrives on the control channel, so the hook route is a duplicate at
// best and a false alarm at worst — the nudge landing after a request was
// answered, dragging a working card back to "needs permission" with nothing held
// and no bar to answer. That is the beep, the taskbar flash and the Events row
// Dan reported, for a question that does not exist.
//
// THE FAKE FIRES IT ITSELF (`!notify`), and that is the point of the seam rather
// than a flourish. `hookPoster` posts from the test process, which proves what
// the listener does with a POST; it cannot prove a Direct session HAS a hook
// channel at all — and it was exactly that unanswerable question that left #261
// part B to be settled by reading code. `!notify` runs the forwarder command out
// of the `--settings` file the session was spawned with, so this is the real
// port, the real token and the real listener, reached from inside the session.
//
// The turn is left OPEN by `!notify` (the `!hang` shape), so nothing overwrites
// the status afterwards: a false `needs-permission` would be entered and STAYED
// IN, which is what gives the first phase its teeth. Measured with the guard
// reverted: the row reaches `needs-permission` and never leaves.
test.describe('a hook Notification cannot fake a permission on Direct (#313)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('the nudge is dropped, while the same channel still moves the badge', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // it really is Direct — otherwise all of this is a PTY test that passes
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });
    await w.getByRole('tab', { name: 'Session', exact: true }).first().click();

    const box = w.getByPlaceholder(/Prompt this session/);
    const row = (status: string): string => `nav .rail-row[data-session-status="${status}"]`;

    // 1. the nudge. Verbatim the payload the live incident produced: the CLI's
    //    debounced notification, with no PreToolUse and therefore no hold.
    await box.click();
    await box.fill('!notify permission_prompt Claude needs your permission to use Write');
    await box.press('Enter');

    // The prompt was sent, so the card is working — and it must STAY working:
    // the notification is fired inside that turn, synchronously, before the fake
    // goes quiet.
    await expect(w.locator(row('working'))).toHaveCount(1, { timeout: 20_000 });
    await w.waitForTimeout(3_000); // nothing else will ever arrive on this turn
    await expect(w.locator(row('needs-permission'))).toHaveCount(0);
    // and nothing rang the bell on the way past, either
    await expect(w.locator('aside [data-event-kind="needs-permission"]')).toHaveCount(0);

    // 2. THE CONTROL, and the reason the absence above means anything. The same
    //    command, the same forwarder, the same listener — one word of payload
    //    different — and the badge moves. So the hook channel is live in this
    //    session and phase 1 was a suppression, not a delivery failure.
    await box.click();
    await box.fill('!notify idle Claude is waiting for your input');
    await box.press('Enter');
    await expect(w.locator(row('idle'))).toHaveCount(1, { timeout: 20_000 });

    // 3. the tightest form of the claim: the same nudge again, now that the
    //    channel has been PROVEN live one message ago. (The new prompt walks the
    //    card back to `working` on its own — `prompt-sent` — so this asserts the
    //    turn is running and nothing else, exactly as phase 1 did.)
    await box.click();
    await box.fill('!notify permission_prompt Claude needs your permission to use Write');
    await box.press('Enter');
    await expect(w.locator(row('working'))).toHaveCount(1, { timeout: 20_000 });
    await w.waitForTimeout(3_000);
    await expect(w.locator(row('needs-permission'))).toHaveCount(0);
    await expect(w.locator('aside [data-event-kind="needs-permission"]')).toHaveCount(0);
  });
});
