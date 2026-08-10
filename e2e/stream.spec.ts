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
import {
  hookPoster,
  launchApp,
  LaunchedApp,
  readWorkspaceFile,
  registerTempDir,
  sweepTempDirs,
} from './fixtures/app';

function tempProjectFolder(): string {
  // Registered with the fixture's registry (#213) rather than a list of this
  // file's own, so `sweepTempDirs()` takes it — see `teardown`.
  const d = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stream-e2e-')));
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
 * though, so the rm can still land while the last child is dying. That last
 * race is why the delete has to requeue rather than retry, and why it is
 * `sweepTempDirs()` doing it — the fixture's registry (`fixtures/app.ts`) is
 * where the requeue, the async rm and the never-throw rule live, and this file
 * kept a second copy of all three until #360. It also adds a guard this copy
 * did not have: a sweep while an app is still open is deferred, not attempted.
 *
 * `cleanup()` sweeps on its own, so the call below is for the case that has no
 * app: a test that threw before `launchApp` returned still made its folder.
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
    await sweepTempDirs();
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
    // the dual-capable fake, asked for the PTY. Asking is now REQUIRED: until
    // #381 a session that asked for nothing got the PTY, and this test relied on
    // that silence. Direct is the default now, so a test about the PTY has to
    // say PTY — the env is the app-wide way to say it.
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'pty' },
    });
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
    // the PTY-only fake (`SWITCHBOARD_FAKE_PROVIDER=1`), which every other spec
    // in the suite uses. Since #381 the host ASKS it for Direct and it answers
    // with a PTY recipe — an adapter that cannot speak stream-json is honoured,
    // which is the same fall-back a real terminal-only provider gets. So this
    // still tests a PTY session; it just gets there by refusal now.
    a = await launchApp({ seedFolder: folder });
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
    // the dual-capable fake, asked for the PTY — because the thing under test
    // is the SWITCH, and a switch needs somewhere to start from. Since #381 a
    // session that asks for nothing starts in Direct, so the terminal side of
    // this journey has to be requested explicitly.
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'pty' },
    });
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
  //
  // RETARGETED BY #339, because it had been passing for the wrong reason ever
  // since the second of those two bugs was fixed. What it CLAIMED was that a
  // restarted Direct session never renders the handoff bar. What it actually
  // exercised was nothing at all:
  //
  //  - the session now leaves `starting` in well under a second, so
  //    `startingLong` is never true and `terminalHandoff` returns null off its
  //    FINAL fall-through — the `transport === 'stream'` guard the test is
  //    named for is never reached. Deleting that guard outright left this test
  //    green (measured 2026-08-07);
  //  - and both absence assertions were made with the TERMINAL tab selected,
  //    so the Session panel that renders the bar was not even mounted. It
  //    asserted the absence of a bar from a tab that has never had one.
  //
  // It now drives a status the bar DOES have a branch for, through the hook
  // channel the fake grew in #338: `!notify` runs the forwarder command out of
  // the `--settings` file THIS session was spawned with, so the signal comes
  // from inside the restarted child rather than from the test process. That is
  // the one thing the #261 test below cannot do — a restart moves the live
  // session id out from under `hookPoster`, which is why that test starts in
  // Direct instead of switching — and it makes this the only test anywhere
  // that proves a session restarted INTO Direct has a working hook channel.
  //
  // The `startingLong` branch itself is no longer reachable from the outside
  // (nothing can hold the fake in `starting` for 8s). It keeps its teeth at the
  // render site in `FeedView.handoff.test.tsx` and in `terminal-handoff.test.ts`'s
  // branch table, both of which fail if the stream guard is removed.
  test('a restarted Direct session offers no bar and no dead button when the CLI waits', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    // starts on the PTY on purpose — it is a session RESTARTED into Direct that
    // is under test, not one born there (#381 made born-in-Direct the default,
    // and the test below at "#261" is the one that covers that path)
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'pty' },
    });
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

    // ...and the Session tab — the one that renders the bar — has to be the
    // tab actually on screen for its absence to mean anything.
    await w.getByRole('tab', { name: 'Session', exact: true }).first().click();

    // The CLI says it is waiting on the user, from inside the restarted child.
    // NOT "waiting for your input", which is the 60s idle nag and classifies to
    // `idle` — a calm state with no bar at all. And not a permission nudge,
    // which #313 drops on this transport before the state machine sees it.
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!notify generic Claude is waiting on you');
    await box.press('Enter');

    // The session REALLY reached a status the bar has a branch for. Without
    // this the three absences below prove only that nothing happened — which
    // is exactly how this test used to pass.
    await expect(w.locator('nav .rail-row[data-session-status="needs-input"]')).toHaveCount(1, {
      timeout: 20_000,
    });

    // `!notify` leaves the turn open, so the status stays put and nothing can
    // walk the card out of it while we look.
    await expect(w.locator('[data-handoff]')).toHaveCount(0);
    await expect(w.getByRole('button', { name: /Open Terminal/i })).toHaveCount(0);
    await expect(w.getByText(/waiting for your answer/i)).toHaveCount(0);
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
  //
  // BOTH launches now pass `SWITCHBOARD_TRANSPORT=pty`, and that is what keeps
  // this test meaningful after #381. Direct is the default, so a second launch
  // that asked for nothing would come up in Direct whether or not the card
  // remembered anything — the test would pass for the wrong reason and the very
  // bug it exists for could come back unnoticed. Asking for the PTY and getting
  // Direct anyway can only mean the stored choice survived and outranked the
  // env, which is exactly the claim.
  test('the choice survives a relaunch of the whole app', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'pty' },
    });
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
    a = await launchApp({
      home: first.home,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'pty' },
    });
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
    // pinned to the PTY for the same reason as the relaunch test above: the
    // switch has to move the session somewhere it was not already (#381)
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'pty' },
    });
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

// #381 — Direct is where a session starts, without anybody asking for it.
//
// Dan, 2026-08-09: "all sessions default to direct mode. not terminal". Every
// other test in this file states a transport in its env; these two are the only
// ones that deliberately state NOTHING, because the absence is the subject.
test.describe('a new session starts in Direct (#381)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('a brand-new session comes up in Direct with nothing asked for', async () => {
    const folder = tempProjectFolder();
    // the dual-capable fake and NO transport variable: whatever this session
    // comes up on is the default, which is the whole assertion
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // it really is Direct: no terminal behind the Terminal tab...
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });

    // ...and the menu names Direct as the CURRENT mode, so the one control that
    // states the mode agrees with the session (the two disagreed in #153)
    await w.getByRole('button', { name: '⋯' }).first().click();
    await expect(w.getByRole('button', { name: /switch to Terminal/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  // The other half of the promise, and the reason this is a DEFAULT and not a
  // migration: choosing Terminal is still a choice, and a default that could
  // overwrite it would make the setting decorative. No env anywhere in this
  // test — the only two things deciding are the default and the stored answer.
  test('a session switched to Terminal is still on Terminal after a relaunch', async () => {
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const first = a;
    await expect(first.window.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // born in Direct, moved to Terminal by hand
    await first.window.getByRole('button', { name: '⋯' }).first().click();
    await first.window.getByRole('button', { name: /switch to Terminal/i }).click();
    await first.window.getByRole('button', { name: /Restart session now/i }).click();
    // POSITIVELY, not by the absence of the notice: during the restart the card
    // body is unmounted entirely, so "no notice on screen" is also true of the
    // gap in between — `toHaveCount(0)` would be satisfied by the wrong state.
    // The menu naming Terminal as the CURRENT mode can only be true of a live
    // session on the PTY.
    await first.window.getByRole('button', { name: '⋯' }).first().click();
    await expect(first.window.getByRole('button', { name: /switch to Direct/i })).toBeVisible({
      timeout: 30_000,
    });
    await first.window.keyboard.press('Escape');
    await first.window.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(first.window.getByText('No terminal for this session')).toHaveCount(0);
    await first.close();

    // same profile, fresh process, still no env — and deliberately NO
    // seedFolder, which would create a second card and move the assertion onto
    // the wrong one (the lesson from the relaunch test above)
    a = await launchApp({ home: first.home, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    await expect(a.window.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await a.window.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(a.window.getByText('No terminal for this session')).toHaveCount(0, {
      timeout: 30_000,
    });
    // and the menu still reads Terminal as the current mode
    await a.window.getByRole('button', { name: '⋯' }).first().click();
    await expect(a.window.getByRole('button', { name: /switch to Direct/i })).toBeVisible({
      timeout: 15_000,
    });
  });
});

// #404 — a Direct conversation survives an app relaunch.
//
// The resume identity comes off the stream itself: `system:init.session_id` →
// the manager's pump → persisted onto the card → the next boot's
// `sessions:create` finds it, `canResume` finds the transcript the fake wrote,
// and the spawn carries `--resume`. The fake's RESUMED-FROM marker is the only
// on-screen trace that the flag was really passed (`fake-stream-protocol.ts`),
// so the final assertion reads the whole path at once.
//
// NO `SWITCHBOARD_TRANSPORT` anywhere in this describe: this is the DEFAULT
// path, the one every real user has been on since #381 — and until #404 the
// only writer of the persisted id was the hook listener the fake never fires
// SessionStart on, so this exact journey silently started a fresh conversation.
test.describe('a Direct conversation survives an app relaunch (#404)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('the id learned from system:init is persisted, and the relaunch resumes with it', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const first = a;
    const w = first.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // one full turn, so the pump has seen a system:init
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('hello from before the relaunch');
    await box.press('Enter');
    await expect(w.getByText('FAKE-REPLY: hello from before the relaunch')).toBeVisible({
      timeout: 30_000,
    });

    // the id is already durable — on disk, where the next boot reads it. The
    // save is debounced, so poll rather than race it.
    await expect(() => {
      const card = readWorkspaceFile(first.home).sessions?.[0];
      expect(card?.nativeSessionId).toBe('00000000-fake-4000-8000-000000000000');
    }).toPass({ timeout: 15_000 });
    await first.close();

    // Fresh process, same profile — and deliberately NO seedFolder: seeding
    // again creates a SECOND card, and the assertion lands on the wrong one
    // (the #381 relaunch test paid for that lesson first).
    a = await launchApp({ home: first.home, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w2 = a.window;
    await expect(w2.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box2 = w2.getByPlaceholder(/Prompt this session/);
    await box2.click();
    await box2.fill('same conversation?');
    await box2.press('Enter');

    await expect(w2.getByText(/RESUMED-FROM:00000000-fake-4000-8000-000000000000/)).toBeVisible({
      timeout: 30_000,
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

// #319 — an allow-all Direct session answers its own gated calls, in MAIN.
//
// #310 killed the handoff banner and left the rest of the promise unkept. Dan
// still got a BEEP and a taskbar flash on every gated call of an allow-all
// Direct session, plus an Events row, because the verdict lived only in the
// renderer: `sessions:allowAllSession` told `HookListener` (which passes stream
// sessions straight through) and nothing else, so every call still travelled
// main -> renderer -> main, and `streamStatusEvent` mapped it to
// `permission-held` on the way — `apply` -> `onStatusChange` -> `feed.ingest` ->
// ATTENTION -> `Notifier.shell.beep()` -> taskbar flash -> an Events row.
//
// The beep is not observable from here. THE STATUS IT HANGS OFF IS, and it is
// the same signal: nothing reaches the Notifier that did not first become a
// status change, and nothing becomes an Events row either. So a turn that never
// enters `needs-permission` is a turn that cannot have beeped.
//
// `!permhang` again, for #310's reason and one more. It models the silence a
// real tool call spends most of its life in — the fake performs the write and
// then emits NOTHING — and that silence is what gives this test teeth: with the
// suppression reverted the card enters `needs-permission` and STAYS there,
// because the CLI has nothing more to say and (allow-all having answered at the
// server) there is no decision coming to resolve it either. Measured both ways;
// see the assertions.
test.describe('allow-all in Direct mode answers at the server (#319)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  const permissionRow = 'nav .rail-row[data-session-status="needs-permission"]';

  test('a gated call raises no attention at all: no status, no Events row', async () => {
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

    // 1. the first call is answered by hand — this is what turns allow-all on,
    //    and it is the only attention this session is allowed to raise.
    await box.click();
    await box.fill('!perm .claude/scripts/one.sh');
    await box.press('Enter');
    await expect(w.getByText(/sensitive file/)).toBeVisible({ timeout: 30_000 });
    // it really did reach needs-permission — otherwise the absences below prove
    // only that nothing ever happens in this app
    await expect(w.locator(permissionRow)).toHaveCount(1, { timeout: 15_000 });
    await w.getByRole('button', { name: 'Allow all (this session)' }).click();
    await expect(() => {
      expect(fs.existsSync(path.join(folder, '.claude', 'scripts', 'one.sh'))).toBe(true);
    }).toPass({ timeout: 20_000 });
    // and the baseline is clean again before anything is counted
    await expect(w.locator(permissionRow)).toHaveCount(0, { timeout: 20_000 });
    await expect(w.locator('aside [data-event-kind="needs-permission"]')).toHaveCount(0);

    // 2. count every commit in which the rail claims this session needs
    //    permission. `attributes` matters and `characterData` does not: the
    //    status is an ATTRIBUTE on a row that is never added or removed, so an
    //    observer without it would watch the wrong thing and pass for ever.
    await w.evaluate((selector) => {
      const win = window as unknown as { __sbPermFrames?: number };
      win.__sbPermFrames = 0;
      const look = (): void => {
        if (document.querySelector(selector)) win.__sbPermFrames!++;
      };
      new MutationObserver(look).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      look(); // the state it starts in counts too
    }, permissionRow);

    // 3. a gated call answered entirely in main, followed by the silence.
    await box.click();
    await box.fill('!permhang .claude/scripts/two.sh');
    await box.press('Enter');
    await expect(() => {
      expect(fs.existsSync(path.join(folder, '.claude', 'scripts', 'two.sh'))).toBe(true);
    }).toPass({ timeout: 30_000 });
    // The file proves the CLI got its answer without a renderer round trip.
    // Now sit in the silence — nothing further will ever arrive on this turn.
    await w.waitForTimeout(3_000);

    // 4. the claim. No frame of `needs-permission`, so no beep and no flash…
    const frames = await w.evaluate(
      () => (window as unknown as { __sbPermFrames?: number }).__sbPermFrames ?? -1
    );
    expect(frames, 'the rail reported needs-permission during an auto-allowed call').toBe(0);
    // …and the same fact read off the other surface it would have reached.
    await expect(w.locator('aside [data-event-kind="needs-permission"]')).toHaveCount(0);
    // no review bar was raised either: the request never left main
    await expect(w.getByText(/sensitive file/)).toHaveCount(0);
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
